import { parseSignIn } from './sign-in.ts';
import { imageRemoval } from './image-input.ts';
import { closingKeyHint } from './rows.ts';
import type { AgentSettings } from '../../shared/types';
import { modelName } from '../../shared/model-name.ts';
import { sameModel } from '../../shared/lead-model.ts';
import { claudeQuestion } from './questions.ts';
import type { AgentScreen, CliScreen, LeadStep, LiveControl, PickerStep, ScreenBanner, ScreenChoice, ScreenOption, ScreenStatus } from './types.ts';
import { cleanBannerRow, commandInputText, conversationRow, emptyStatus, hintRow, mcpUrlTitle, optionRow, parseChoice, parseWaiting, permissionTitle, prompt, rule } from './rows.ts';

const cursorRow = (row: string) => /^\s*❯(?:\s|$)/.test(row);
const inputRow = (row: string) => cursorRow(row) && !optionRow(row);
const readPrompt = (row: string) => prompt(/^\s*❯(?:\s+(.*))?$/, row);
const inputRule = (row: string) => /^(?:[─╌] *){2,}$/.test(row.trim());
const claudeComposer = (rows: string[], index: number) => cursorRow(rows[index]) && (rule(rows[index - 1] ?? '') || rule(rows[index + 1] ?? ''));

function footerStart(rows: string[]) {
  for (let index = rows.length - 1; index >= 1; index--) {
    if (/^─{2,}$/.test(rows[index].trim())) {
      return cursorRow(rows[index - 1]) ? index + 1 : rows.length;
    }
  }
  return rows.length;
}

function parseStatus(rows: string[], start: number): ScreenStatus {
  const status = emptyStatus();
  // Claude Code 2.1.296 draws its effort over the input box ("◉ xhigh · /effort"), earlier ones in the footer.
  const effortRow = /[●◉]\s+(\S+)\s+·\s+\/effort\b/;
  for (let index = rows.length - 1; index >= start; index--) {
    const text = rows[index].trim();
    const model = /^[⏺●]\s+(.+?)\s+·/.exec(text);
    const effort = effortRow.exec(text);
    const mode = /^[⏸⏵⏺]+\s+(.+?)(?:\s+·|\s+\(|$)/.exec(text);
    if (model && status.model === null) {
      status.model = model[1].trim();
      status.context = text.split('●')[0].split('·').map(part => part.trim())
        .find(part => /^ctx\s+/.test(part)) ?? null;
    }
    if (effort && status.effort === null) status.effort = effort[1];
    if (!model && mode && status.mode === null) status.mode = mode[1].trim();
  }
  if (status.effort === null && start < rows.length) {
    // Right over the input box: its top rule is the first one above the input.
    let top = start - 2;
    while (top >= 0 && !/^─{2,}$/.test(rows[top].trim())) top--;
    const above = rows.slice(Math.max(0, top - 2), Math.max(0, top)).map(row => effortRow.exec(row)?.[1]).filter(Boolean).at(-1);
    if (above) status.effort = above;
  }
  return status;
}

function parseOverlay(rows: string[], start: number): AgentScreen['overlay'] {
  const popup = rows.slice(start);
  const input = rows[start - 2]?.trim() ?? '';
  if (popup.some(row => /^! for shell mode\b/.test(row.trim())) &&
      popup.some(row => /^\/ for commands\b/.test(row.trim()))) return 'shortcuts';
  if (/^❯\s*@/.test(input) && popup.some(row => /^\*\s+/.test(row.trim()))) return 'mention';
  if (/^❯\s*\//.test(input) && popup.some(row => /^\s*(?:❯\s*)?\/\S+\s{2,}\S/.test(row))) return 'slash';
  return 'none';
}

function banner(rows: string[]): ScreenBanner | null {
  for (let index = rows.length - 1; index >= 0; index--) {
    const match = /Claude Code v([^\s]+)/.exec(rows[index]);
    if (!match) continue;
    const model = /^(.+?) with (\S+) effort(?:\s+·\s+(.+))?$/.exec(cleanBannerRow(rows[index + 1] ?? '') ?? '');
    return { product: 'Claude Code', version: match[1], model: model?.[1] ?? null, effort: model?.[2] ?? null,
      plan: model?.[3] ?? null, directory: cleanBannerRow(rows[index + 2] ?? '') };
  }
  return null;
}

// Claude's own prompts before its input exists list their options without numbers: the folder to trust ("❯ No, exit"
// over "Yes, I trust this folder"), the first run's text style ("❯ ✔ Dark mode" among its siblings, a preview under
// them). The cursor row with the rows whose labels line up with it are the options, numbered in their order on screen;
// a mark of the current setting (✔) is not part of a label. Claude's input box (❯ between rules) is never one, nor is a
// conversation: a dialog open over it (/help) leaves sent prompts ("❯ /model") with their output ("⎿ Kept model…")
// lined up the same way.
const bareCursor = /^(\s*❯\s+(?:✔\s+)?)\S/, bareLabel = /^(\s*(?:✔\s+)?)[^\s⎿]/;
function bareChoice(rows: string[]): ScreenChoice | null {
  if (rows.some((_, index) => claudeComposer(rows, index))) return null;
  const cursor = rows.findIndex(row => bareCursor.test(row));
  if (cursor < 0 || rows.some((row, index) => conversationRow(row) || index !== cursor && /^\s*❯/.test(row))) return null;
  const column = bareCursor.exec(rows[cursor])![1].length, lines = (index: number) => bareLabel.exec(rows[index] ?? '')?.[1].length === column;
  let first = cursor, last = cursor;
  while (first > 0 && lines(first - 1)) first--;
  while (last < rows.length - 1 && lines(last + 1)) last++;
  if (last === first || last - first > 8) return null;
  const options: ScreenOption[] = rows.slice(first, last + 1).map((row, index) => ({ number: index + 1,
    label: row.trim().replace(/^❯\s+/, '').replace(/^✔\s+/, ''), detail: '', selected: first + index === cursor, hotkey: null }));
  let hint: string | null = null;
  for (let index = last + 1; index < rows.length && hint === null; index++) if (hintRow(rows[index])) hint = rows[index].trim();
  // The words just above the options, up to a logo drawn in blocks, a rule or a wider gap (what the shell showed before
  // the CLI started): their first row heads the prompt, the rest explains it.
  const above: string[] = [];
  for (let index = first - 1, blanks = 0; index >= 0; index--) {
    const row = rows[index].trim();
    if (!row) { if (++blanks > 1 && above.length) break; continue; }
    if (rule(row) || !/\p{L}/u.test(row)) { if (above.length) break; continue; }
    blanks = 0; above.unshift(row);
  }
  if (!above.length) return null;
  return { title: above[0], kind: 'menu', options, hint, context: above.slice(1) };
}

// A numbered menu of Claude's that the forms here do not know (a new prompt, a row they do not expect around it): its
// cursor on one of the options, the options numbered in order and Claude's key hint under them are enough to lay it out,
// rather than leave nothing to answer in the reading view. The row just above the options heads it; what lies between
// the dialog's rule (or the step it asks about) and that row explains it.
const menuHint = (row: string) => hintRow(row) || /\b(?:esc|enter)\b[^·]*\bto (?:cancel|close|exit|go back|dismiss|select|confirm|continue)\b/i.test(row);
function looseMenu(rows: string[]): ScreenChoice | null {
  if (rows.some((_, index) => claudeComposer(rows, index))) return null;
  let cursor = rows.length - 1;
  while (cursor >= 0 && !/^\s*❯\s*\d+\.\s/.test(rows[cursor])) cursor--;
  const hintAt = cursor < 0 ? -1 : rows.findIndex((row, index) => index > cursor && menuHint(row));
  // It is still open only when nothing came after it but Claude's footer: an answered prompt has conversation under it.
  if (hintAt < 0 || rows.slice(hintAt + 1).some(row => row.trim() && !rule(row) && !/^\s*(?:⏵⏵|⏸|◉)/.test(row))) return null;
  const marked = optionRow(rows[cursor])!, column = marked[1].length + marked[2].length;
  const under = (row: string) => !!row.trim() && !optionRow(row) && !rule(row) && row.search(/\S/) > column;
  let first = cursor;
  for (let index = cursor - 1; index >= 0; index--) {
    if (optionRow(rows[index])) first = index;
    else if (rows[index].trim() && !under(rows[index])) break;
  }
  const options: ScreenOption[] = [];
  for (let index = first; index < hintAt; index++) {
    const match = optionRow(rows[index]);
    if (match) options.push({ number: Number(match[3]), label: match[4].trim(), detail: '', selected: index === cursor, hotkey: null });
    else if (under(rows[index]) && options.length) {
      const option = options[options.length - 1];
      option.detail = `${option.detail} ${rows[index].trim()}`.trim();
    }
  }
  if (options.length < 2 || options.some((option, index) => option.number !== options[0].number + index)) return null;
  let top = first - 1;
  while (top >= 0 && !rows[top].trim()) top--;
  if (top < 0 || rule(rows[top]) || conversationRow(rows[top])) return null;
  let start = top - 1;
  while (start >= 0 && !rule(rows[start]) && !/^\s*▔{8,}/.test(rows[start]) && !conversationRow(rows[start])) start--;
  const title = rows[top].trim();
  return { title, kind: permissionTitle(title) ? 'permission' : 'menu', options, hint: rows[hintAt].trim(),
    context: rows.slice(start + 1, top).filter(row => row.trim() && !rule(row)).map(row => row.trim()) };
}

// Claude's URL elicitation uses a horizontal Accept / Decline row. This is an informative permission card;
// its positions describe the screen and never authorize a PTY response.
function claudeUrlChoice(rows: string[]): ScreenChoice | null {
  let head = rows.length - 1;
  while (head >= 0 && !mcpUrlTitle.test(rows[head].trim())) head--;
  if (head < 0) return null;
  let end = rows.length - 1;
  while (end > head && !rows[end].trim()) end--;
  if (!/^Esc to cancel · ←\/→ to switch$/i.test(rows[end].trim())) return null;
  const at = rows.findIndex((row, index) => index > head && /^\s*(?:❯\s+)?Accept\s{2,}(?:❯\s+)?Decline\s*$/.test(row));
  if (at < 0 || rows.slice(at + 1, end).some(row => row.trim())) return null;
  const selected = /^\s*❯/.test(rows[at]) ? 0 : /\s❯\s+Decline/.test(rows[at]) ? 1 : -1;
  if (selected < 0) return null;
  return { kind: 'permission', title: rows[head].trim(), context: rows.slice(head + 1, at).map(row => row.trim()).filter(Boolean),
    options: ['Accept', 'Decline'].map((label, index) => ({ number: index + 1, label, detail: '', hotkey: null, selected: index === selected })),
    hint: rows[end].trim() };
}


function cliInputArea(rows: string[], wrapped?: (row: number) => boolean) {
  for (let index = rows.length - 1; index >= 0; index--) {
    const text = readPrompt(rows[index]);
    if (text === null) continue;
    if (!inputRule(rows[index - 1] ?? '')) continue;
    let end = index + 1;
    while (end < rows.length && (wrapped?.(end) || !inputRule(rows[end]) && (/^[ \u00a0]{2}\S/.test(rows[end]) || !rows[end].trim()))) end++;
    if (!inputRule(rows[end] ?? '')) continue;
    // Claude Code 2.1.296 draws its effort right over the input box ("◉ xhigh · /effort"): part of it, never output.
    const start = /^\s*[●◉]\s+\S+\s+·\s+\/effort\b/.test(rows[index - 2] ?? '') ? index - 2 : index - 1;
    const draft = [text, ...rows.slice(index + 1, end).map(row => row.trim())].join(' ').trim();
    return { row: index, start, footer: end + 1, text: draft };
  }
  return null;
}

// Limit styled hint detection to Claude's boxed message input, which uses ❯ rather than the shell's ! marker.
function claudePromptRange(rows: string[], wrapped: (row: number) => boolean) {
  const input = cliInputArea(rows, wrapped);
  if (!input) return null;
  const marker = /^[ \u00a0]*❯(?:[ \u00a0]+|$)/.exec(rows[input.row]);
  return marker ? { first: input.row, end: input.footer - 1, prefix: marker[0].length } : null;
}

// Claude's live status line while it works: a cycling glyph and a verb ending in "…" ("✶ Osmosing… (running
// UserPromptSubmit hooks…)"). Claude 2.1 empties its input on Enter and shows this while hooks run, before a command
// draws anything, so an empty input beside it is not idle. A finished turn's "✻ Worked for 25s" has no ellipsis.
const claudeWorking = (rows: string[]) => rows.some(row => /^\s*[·✢✳✶✻✽*]\s+\S[^…]*…/.test(row));
const queueShown = (rows: string[]) => rows.some((row, index) => {
  const first = row.trim();
  return first.startsWith('ctrl+x') && [first, first + ' ' + (rows[index + 1] ?? '').trim()].includes('ctrl+x ctrl+s to send now');
});
// The registry reads Claude's cell attributes first. For plain rows, match the entire placeholder independently of
// queue state: a redraw can show the hint without its shortcut, and the CLI's queue can precede main's report.
const claudeQueueHint = /^(?:press up|↑) to edit queued messages[.。]?$|^(?:按(?:向上键|上方向键|上箭头|↑)|↑) *(?:编辑|可编辑)(?:已排队(?:的)?消息|队列中的消息)[.。]?$/i;
const claudeTryHint = /^(?:Try|试试) *["“][^"”]*["”]$/i;
const withoutClaudeCursor = (text: string) => text.replace(/[█▉▊▋▌▍▎▏▮]\s*$/, '').trimEnd();
const claudeHintText = (text: string) => claudeQueueHint.test(text) || claudeTryHint.test(text);
const claudePieces = (rows: string[], area: NonNullable<ReturnType<typeof cliInputArea>>) =>
  [readPrompt(rows[area.row]) ?? '', ...rows.slice(area.row + 1, area.footer - 1)].map(row => row.trim());

function claudeInputHint(rows: string[], area = cliInputArea(rows)): boolean {
  if (!area || !/^\s*❯/.test(rows[area.row])) return false;
  const text = withoutClaudeCursor(area.text).replace(/\s+/g, ' ');
  if (claudeHintText(text)) return true;
  // Hard wraps can bisect a word. Preserve spaces within each row and only make row boundaries optional.
  if (area.footer - area.row <= 2) return false;
  const pieces = claudePieces(rows, area).filter(Boolean).map(piece => piece.replace(/\s+/g, ' ').toLowerCase());
  if (pieces.length) pieces[pieces.length - 1] = withoutClaudeCursor(pieces[pieces.length - 1]);
  const suffix = /[.。]$/.exec(text)?.[0] ?? '';
  const joined = pieces.join('');
  return claudeHintText(joined) || ['press up', '↑'].some(key => matchesPieces(pieces, `${key} to edit queued messages${suffix}`));
}

// A visual line break can split a word. Compare the visible pieces without inventing spaces at their boundaries.
function claudeInputMatches(rows: string[], expected: string) {
  const area = cliInputArea(rows);
  return !!area && !!expected.trim() && !claudeInputHint(rows, area) && matchesPieces(claudePieces(rows, area), expected.trim());
}

function matchesPieces(pieces: string[], remaining: string) {
  for (const text of pieces) {
    if (!remaining.startsWith(text)) return false;
    remaining = remaining.slice(text.length).trimStart();
  }
  return !remaining;
}

function claudeShellRunning(rows: string[], end: number) {
  for (let index = end - 1; index >= 0; index--) {
    if (/^\s*!\s+\S/.test(rows[index])) return /^\s*⎿[ \u00a0]+Running…\s*$/.test(rows[index + 1] ?? '');
  }
  return false;
}

const SESSION_ONLY = /\bs to use this session only\b/i;
const EFFORT_SESSION_ENTER = /\bEnter to use this session only\s*·\s*Esc to cancel\b/i;
const MODEL_HEADER = /^\s*Select model\s*$/i;
const EFFORT_HEADER = /^\s*Effort\s*$/i;
const UP = '\x1b[A', DOWN = '\x1b[B', LEFT = '\x1b[D', RIGHT = '\x1b[C';

function menuRows(rows: string[], title: RegExp) {
  for (let i = rows.length - 1; i >= 0; i--) if (title.test(rows[i])) return rows.slice(i);
  return null;
}

const pickerRows = (step: PickerStep, rows: string[]) => menuRows(rows, step.kind === 'model' ? MODEL_HEADER : EFFORT_HEADER);

function modelChoice(target: string, label: string, description: string) {
  if (/^default\b/i.test(label)) return false;
  const context = /(?:\[1m\]|\(1m(?: context)?\))$/i;
  if (context.test(target) !== context.test(label)) return false;
  const name = label.replace(context, '').trim();
  const chosen = target.replace(context, '');
  // Claude Code 2.1.331 labels a line by its release ("Sonnet 5.5"); earlier pickers show the bare alias.
  if (/^(opus|sonnet|haiku|fable)$/i.test(chosen)) return new RegExp(`^${chosen}(?: \\d+(?:\\.\\d+)?)?$`, 'i').test(name);
  const release = /^(?:opus|sonnet|haiku|fable) \d+(?:\.\d+)?\b/i.exec(description)?.[0];
  const shown = /^(opus|sonnet|haiku|fable)$/i.test(name) ? release : name;
  return !!shown && modelName(chosen).toLowerCase() === shown.toLowerCase();
}

function modelCursor(rows: string[], target: string, scanningDown: boolean) {
  const options = rows.flatMap(row => {
    const match = /^\s*([>❯])?\s*(\d+)\.\s+(.+)$/.exec(row);
    if (!match) return [];
    const [label, description = ''] = match[3].split(/\s{2,}/, 2);
    return [{ active: !!match[1], number: Number(match[2]), matches: modelChoice(target, label.replace(/\s*√$/, ''), description) }];
  });
  const focus = options.find(option => option.active);
  if (!focus) return null;
  const choice = options.find(option => option.matches);
  const down = scanningDown || focus.number === 1;
  const accept = choice === focus;
  const key = choice ? accept ? 's' : choice.number < focus.number ? UP : DOWN : down ? DOWN : UP;
  return { position: focus.number, down, ultracode: null, key, accept };
}

function effortCursor(rows: string[], step: Extract<LeadStep, { kind: 'effort' }>, confirm: string, text: string) {
  const marker = rows.findIndex(row => /^[\s─]*▲[─\s]/.test(row));
  if (marker < 0) return null;
  const caret = rows[marker].indexOf('▲');
  const levels = [...(rows[marker + 1] ?? '').matchAll(/\b(?:auto|low|medium|high|xhigh|max)\b/gi)];
  const position = levels.findIndex(level => Math.abs(level.index + (level[0].length - 1) / 2 - caret) <= 2);
  if (position < 0) return null;
  const choice = step.target ? levels.findIndex(level => level[0].toLowerCase() === step.target) : position;
  if (choice < 0) return null;
  const toggle = /\bTab to toggle\b/i.test(text) ? /\bUltracode\s+(on|off)\b/i.exec(text)?.[1] : undefined;
  const ultracode = toggle ? toggle.toLowerCase() === 'on' : null;
  const key = choice < position ? LEFT : choice > position ? RIGHT : ultracode !== null && ultracode !== (step.ultracode === true) ? '\t' : confirm;
  return { position, down: false, key, ultracode, accept: key === confirm, changed: key === '\t' ? 'ultracode' as const : key === confirm ? undefined : 'effort' as const };
}

function pickerAction(step: PickerStep, rows: string[], scanningDown = false) {
  const menu = pickerRows(step, rows);
  if (!menu) return null;
  const text = menu.map(row => row.trim()).join(' ');
  const sessionOnly = SESSION_ONLY.test(text);
  if (step.kind === 'model') return sessionOnly ? modelCursor(menu, step.target, scanningDown) : null;
  const confirm = sessionOnly ? 's' : EFFORT_SESSION_ENTER.test(text) ? '\r' : null;
  return confirm ? effortCursor(menu, step, confirm, text) : null;
}

const MODEL_ECHO = /\bSet model to `?(.+?)`? for this session only/i;
const EFFORT_ECHO = /\bSet effort level to (\w+) \(this session only\)/i;
const ULTRACODE_ECHO = /\bUltracode (?:on|off) \(this session only\)|\bUltracode off\. Effort stays \w+\./i;
const FAST_ON = /\bFast mode (ON|OFF)\b/i;
const FAST_UNAVAILABLE = /\bFast mode unavailable:\s*(.+)/i;

function echoes(rows: string[]) {
  return rows.flatMap((row, index) => {
    if (!/^\s*(?:[⎿↯]\s*)*(?:Set (?:model|effort level) to|Ultracode (?:on|off)|Fast mode)\b/i.test(row)) return [];
    const lines = [row.trim()];
    for (const line of rows.slice(index + 1)) {
      if (!/^\s+\S/.test(line) || /^\s*[⎿↯❯>─│╭╰]/.test(line)) break;
      lines.push(line.trim());
    }
    return [lines.join(' ')];
  });
}

function appliedSettings(step: PickerStep, echo: string): Partial<AgentSettings> | null {
  if (step.kind === 'model') {
    const model = MODEL_ECHO.exec(echo)?.[1];
    return model && sameModel(step.target, model) ? { model: modelName(model) } : null;
  }
  const effort = EFFORT_ECHO.exec(echo)?.[1].toLowerCase();
  const ultra = (effort || ULTRACODE_ECHO.test(echo)) ? /\bUltracode (on|off)\b/i.exec(echo)?.[1] : undefined;
  if (!effort && !ultra) return null;
  return { ...(effort ? { effort } : {}), ...(ultra ? { ultracode: ultra.toLowerCase() === 'on' } : {}) };
}

function confirmationMenu(step: PickerStep, rows: string[]) {
  return menuRows(rows, step.kind === 'model' ? /^\s*Switch model\?\s*$/ : /^\s*Change effort level\?\s*$/);
}

function pickerResult(step: PickerStep, rows: string[]) {
  const menu = confirmationMenu(step, rows);
  if (menu) {
    const choice = menu.map(row => /^\s*[>❯]\s*1\.\s*Yes, switch to (.+?)\s*$/i.exec(row)?.[1]).find(Boolean);
    const matches = choice && (step.kind === 'model' ? sameModel(step.target, choice) : step.target === choice.toLowerCase());
    if (matches && menu.some(row => /Your next response will be slower and use more tokens/i.test(row))) return 'confirm';
    return null;
  }
  return echoes(rows).some(echo => appliedSettings(step, echo)) ? 'applied' : null;
}

type FastEcho = { reason: string } | { fast: boolean; model: string | null };

function fastEcho(echo: string): FastEcho | null {
  const reason = FAST_UNAVAILABLE.exec(echo)?.[1];
  if (reason) return { reason };
  const fast = FAST_ON.exec(echo)?.[1];
  if (!fast) return null;
  const model = /\bmodel set to\s+`?([^`·]+?)`?(?:\s*·|$)/i.exec(echo)?.[1] ?? null;
  return { fast: fast.toLowerCase() === 'on', model };
}

function status(rows: string[]) {
  const start = footerStart(rows);
  return { banner: banner(rows), status: parseStatus(rows, start), overlay: parseOverlay(rows, start) };
}

function dialog(rows: string[], screen = status(rows)) {
  if (screen.overlay !== 'none') return {};
  const choice = claudeQuestion(rows) ?? claudeUrlChoice(rows) ??
    parseChoice(rows, { inputRow, selected: '❯', historical: conversationRow, beforePermission: true, unnumbered: bareChoice }) ??
    looseMenu(rows);
  const panelHead = rows.findIndex((row, index) => /^Settings\s{2,}Status\s{2,}Config\s{2,}Usage\s{2,}Stats$/.test(row.trim())
    && /^▔{8,}/.test(rows[index - 1]?.trim() ?? ''));
  const first = rows.find(row => row.trim())?.trim();
  const clippedModelHeading = choice?.kind === 'menu' && choice.title === first && /\bspecify with --model\.$/.test(choice.title);
  return { choice, waiting: choice ? null : parseWaiting(rows, false, index => claudeComposer(rows, index), inputRow, panelHead),
    ...(clippedModelHeading ? { waitingHeadingClipped: true as const } : {}) };
}

function input(rows: string[], styledHint = false) {
  const area = cliInputArea(rows);
  if (!area) return null;
  const hint = styledHint || claudeInputHint(rows, area);
  return { text: hint ? '' : commandInputText(area.text), hint };
}

function working(rows: string[]) {
  const area = cliInputArea(rows);
  return claudeWorking(rows) || !!area && claudeShellRunning(rows, area.start);
}

// Claude labels the upper input border while Ultracode is on.
function normalize(rows: string[]) {
  return rows.map((row, index) => /^\s*─{2,}\s+ultracode\s+─+\s*$/i.test(row) && /^\s*❯/.test(rows[index + 1] ?? '')
    ? row.replace(/ ultracode /i, '───────────') : row);
}

function readEcho(step: LeadStep, line: string) {
  if (step.kind === 'fast') {
    const result = fastEcho(line);
    if (!result || 'reason' in result) return result;
    const { fast, model } = result;
    return { settings: { fast, ...(model ? { model } : {}) } };
  }
  const settings = appliedSettings(step, line);
  return settings && { settings };
}

const commandControls: Readonly<Partial<Record<string, LiveControl>>> = {
  '/model': 'liveModel', '/effort': 'liveEffort', '/fast': 'fast', '/ultracode': 'ultracode',
};

export const claude: CliScreen = {
  normalize, version: rows => {
    for (let index = rows.length - 1; index >= 0; index--) {
      const match = /^\s*[\u2580-\u259f]+\s+Claude Code v(\S+)\s*$/.exec(rows[index]);
      if (match) return match[1];
    }
  },
  signIn: (rows, width) => parseSignIn(rows, width, {
    marker: /^(?:Paste code here if prompted|Browser didn't open\?|(?:[·✢✳✶✻✽*] )?Opening browser to sign in|Login successful\. Press Enter to continue|Security notes:)/i,
    footer: /^\s*(?:(?:⏵⏵|⏸|⏵)\s.*(?:mode on|shift\+tab|for agents?|\d+ agents?)|\?\s+for shortcuts\b|.*·\s*←\s*(?:for agents|\d+ agents?))/,
    field: /Paste code here if prompted/i, input: 'code',
  }),
  otherDialog: rows => closingKeyHint(rows) || (!input(rows) && rows.some(row => row.trim() === 'Sign in to Claude Code')
    && rows.some(row => /^Paste the authorization code below:/.test(row.trim()))),
  workerPlan: choice => choice.kind === 'permission' && choice.title === 'Exit plan mode?',
  removeImage: (text, index, rows) => imageRemoval(false, text, index, rows),
  pasteSummary: text => /^\[Pasted text #\d+[^\]]*\]$/.test(text),
  input, working, atPrompt: rows => !!cliInputArea(rows),
  dialog, status, receiptOnScreen: true, clears: text => /^\/clear(?:\s|$)/.test(text.trim()),
  inputMatches: claudeInputMatches,
  styledInput: { range: claudePromptRange, hint: claudeInputHint, withoutCursor: withoutClaudeCursor },
  facts: { busy: claudeWorking, queue: queueShown },
  switchControl: text => {
    const name = text.trim().split(/\s/, 1)[0].toLowerCase();
    return Object.hasOwn(commandControls, name) ? commandControls[name] : undefined;
  },
  picker: { action: pickerAction, result: pickerResult, open: (step, rows) => !!(pickerRows(step, rows) || confirmationMenu(step, rows)),
    command: step => step.kind === 'fast' ? step.target ? '/fast on' : '/fast off' : step.kind === 'model' ? '/model' : '/effort',
    matchModel: sameModel, readEcho, restoreFastDefaults: true },
  echo: echoes,
};
