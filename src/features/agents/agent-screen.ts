import type { AgentScreen, ScreenAgent, ScreenBanner, ScreenChoice, ScreenOption, ScreenStatus } from './agent-screen-types.ts';
import { parseQuestion } from './agent-question.ts';

const rule = (row: string) => /^[─╌]{2,}$/.test(row.trim());
const optionRow = (row: string) => /^(\s*)([❯›>↓↑]?\s*)(\d+)\.\s+(.+)$/.exec(row);
const inputRow = (agent: ScreenAgent, row: string) =>
  (agent === 'claude' ? /^\s*❯(?:\s|$)/ : /^\s*›(?:\s|$)/).test(row) && !optionRow(row);
const hintRow = (row: string) => /^(?:press\s+)?(?:enter|esc)\b.*(?:cancel|confirm|select|back|default|continue|skip|exit|close)/i.test(row.trim());
const menuExtra = (row: string) => /^(?:…\s*\+\d+ models|●\s+\S+ effort\b.*to adjust|Learn more:\s+\S+)$/.test(row.trim());

// A terminal gives CJK and other wide characters two cells: a row's columns are counted in cells, not characters.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u;
const cells = (text: string) => { let width = 0; for (const char of text) width += WIDE.test(char) ? 2 : 1; return width; };
// What a row shows from a column on.
function fromColumn(row: string, column: number) {
  const chars = [...row];
  let at = 0, width = 0;
  while (at < chars.length && width < column) width += WIDE.test(chars[at++]) ? 2 : 1;
  return chars.slice(at).join('');
}
// The part of a row set off to the right, beside or instead of the conversation's own text (which starts at its left
// edge): its column and text, or null.
function rightPart(row: string, from: number, matches: (text: string) => boolean = () => true) {
  for (const gap of row.matchAll(/\s{2,}(?=\S)/g)) {
    const end = gap.index + gap[0].length, column = cells(row.slice(0, end));
    if (column >= from && matches(row.slice(end))) return { column, text: row.slice(end) };
  }
  return null;
}

// Codex 0.162 draws some commands' dialogs over its conversation (/memories' "Enable memories?"): a box set in from the
// left beside or over the conversation's lines, closed by its key hints ("enter select · esc back"), while its input and
// footer stay below. Its rows are what the screen shows from the dialog's left edge on; null when none is open.
const DIALOG_LEFT = 12;
export function codexDialog(rows: string[]): string[] | null {
  let hint = rows.length - 1, left = Infinity;
  for (; hint >= 0; hint--) {
    const part = rightPart(rows[hint], DIALOG_LEFT, hintRow);
    if (part) { left = part.column; break; }
  }
  if (hint < 0) return null;
  // Up from the hints, the rows with a part in the dialog's columns; three rows in a row without one end it.
  let top = hint;
  for (let index = hint - 1, empty = 0; index >= 0 && empty < 3; index--) {
    const part = rightPart(rows[index], Math.max(DIALOG_LEFT, left - 8));
    if (part) { top = index; empty = 0; left = Math.min(left, part.column); }
    else empty++;
  }
  if (top === hint) return null;
  return rows.slice(top, hint + 1).map(row => fromColumn(row, left).trimEnd());
}
// Codex asks "Would you like to run the following command?", "…make the following edits?", "…grant these permissions?"
// and "<server> needs your approval."; Claude "Do you want to create hello.txt?".
const permissionTitle = (row: string) => /^(?:Do you want\b|Would you like to\b|Allow\b)|\bneeds your approval\.?$/i.test(row);
const choiceTitle = (row: string) => permissionTitle(row) || /^Select\b/i.test(row);

// Claude surrounds its composer with rules; Codex puts its footer below the last composer.
// Historical user messages and popup cursor rows must not become footer anchors.
function footerStart(agent: ScreenAgent, rows: string[]): number {
  if (agent === 'claude') {
    for (let index = rows.length - 1; index >= 1; index--) {
      if (/^─{2,}$/.test(rows[index].trim())) {
        return inputRow(agent, rows[index - 1]) ? index + 1 : rows.length;
      }
    }
  } else {
    for (let index = rows.length - 1; index >= 0; index--) {
      // Codex 0.163 replaces › with ! in its shell editor. This footer anchor is separate from shortcut/menu rows.
      if (inputRow(agent, rows[index]) || /^\s*!(?:\s|$)/.test(rows[index])) return index + 1;
    }
  }
  return rows.length;
}

function parseStatus(agent: ScreenAgent, rows: string[], start: number): ScreenStatus {
  const status: ScreenStatus = { model: null, effort: null, context: null, mode: null, notes: [] };
  if (agent === 'claude') {
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
  } else {
    const footer = rows.slice(start).map(row => row.trim()).filter(Boolean);
    // "model effort · folder · context left". A conversation with nothing in it yet has no context part
    // ("GPT-6-Sol default · ~\work", Codex 0.162.1): its first part is then told by the effort that ends it.
    // A view's key hints under its list ("←/→ tabs · enter details · esc close", /plugins) are no footer.
    const keys = /[←→↑↓]|(?:^|·)\s*(?:esc|enter|tab|space)\s+\w/i.test(footer[0] ?? '');
    const parts = keys ? null : /^(.+?)\s+·\s+([^·]+?)(?:\s+·\s+(.+))?$/.exec(footer[0] ?? '');
    const model = parts && (parts[3] !== undefined || /\s(?:none|minimal|low|medium|high|xhigh|max|ultra|default)(?:\s+fast)?$/.test(parts[1])) ? parts : null;
    if (model) {
      // "default": the model's own effort ("GPT-6.1-Sol default · ~\work"); "fast": fast mode on ("GPT-6.1-Sol high fast").
      const effort = /^(.*?)\s+(none|minimal|low|medium|high|xhigh|max|ultra|default)(\s+fast)?$/.exec(model[1]);
      status.model = effort ? effort[1] : model[1].replace(/\s+fast$/, '');
      status.effort = effort?.[2] ?? null;
      if (effort?.[3] || /\s+fast$/.test(model[1])) status.fast = true;
      status.context = model[3] ?? null;
      for (const row of footer.slice(1)) {
        const note = row.replace(/^\? for shortcuts\s*/, '').trim();
        if (note && note !== '? / esc close') status.notes.push(note);
      }
    }
  }
  return status;
}

function parseBanner(agent: ScreenAgent, rows: string[], status: ScreenStatus): ScreenBanner | null {
  for (let index = rows.length - 1; index >= 0; index--) {
    const match = (agent === 'claude' ? /Claude Code v([^\s]+)/ : />_ OpenAI Codex \(v([^\s)]+)\)/).exec(rows[index]);
    if (!match) continue;
    const clean = (row: string) => row.replace(/^[\s\u2580-\u259f]+/, '').trim() || null;
    const model = agent === 'claude'
      ? /^(.+?) with (\S+) effort(?:\s+·\s+(.+))?$/.exec(clean(rows[index + 1] ?? '') ?? '')
      : null;
    return {
      product: agent === 'claude' ? 'Claude Code' : 'OpenAI Codex', version: match[1],
      model: agent === 'claude' ? model?.[1] ?? null : status.model,
      effort: agent === 'claude' ? model?.[2] ?? null : status.effort,
      plan: model?.[3] ?? null,
      directory: clean(rows[index + (agent === 'claude' ? 2 : 1)] ?? ''),
    };
  }
  return null;
}

function parseOverlay(agent: ScreenAgent, rows: string[], start: number): AgentScreen['overlay'] {
  if (agent === 'claude') {
    const popup = rows.slice(start);
    const input = rows[start - 2]?.trim() ?? '';
    if (popup.some(row => /^! for shell mode\b/.test(row.trim())) &&
        popup.some(row => /^\/ for commands\b/.test(row.trim()))) return 'shortcuts';
    if (/^❯\s*@/.test(input) && popup.some(row => /^\*\s+/.test(row.trim()))) return 'mention';
    if (/^❯\s*\//.test(input) && popup.some(row => /^\s*(?:❯\s*)?\/\S+\s{2,}\S/.test(row))) return 'slash';
  } else if (start < rows.length) {
    // Popups are above Codex's composer; their insertion/close hints identify the live block.
    let previousInput = start - 2;
    while (previousInput >= 0 && (!inputRow(agent, rows[previousInput]) ||
      /^\s*›\s+\S.*\s{2,}\S/.test(rows[previousInput]))) previousInput--;
    const popup = rows.slice(previousInput + 1, start - 1);
    const input = rows[start - 1].trim();
    if (popup.some(row => row.trim() === 'Keyboard shortcuts') &&
        rows.slice(start).some(row => row.trim() === '? / esc close')) return 'shortcuts';
    if (/^›\s*@/.test(input) && popup.some(row => row.trim() === 'Mentions') &&
        popup.some(row => /enter\/tab insert · esc close/.test(row))) return 'mention';
    // A selected slash suggestion is itself cursor-prefixed, so include the preceding input-like row.
    if (/^›\s*\//.test(input) && rows.slice(Math.max(previousInput, 0), start - 1)
      .some(row => /^\s*(?:›\s*)?\/\S+\s{2,}\S/.test(row))) return 'slash';
  }
  return 'none';
}

// Claude's own prompts before its input exists list their options without numbers: the folder to trust ("❯ No, exit"
// over "Yes, I trust this folder"), the first run's text style ("❯ ✔ Dark mode" among its siblings, a preview under
// them). The cursor row with the rows whose labels line up with it are the options, numbered in their order on screen;
// a mark of the current setting (✔) is not part of a label. Claude's input box (❯ between rules) is never one, nor is a
// conversation: a dialog open over it (/help) leaves sent prompts ("❯ /model") with their output ("⎿ Kept model…")
// lined up the same way.
const bareCursor = /^(\s*❯\s+(?:✔\s+)?)\S/, bareLabel = /^(\s*(?:✔\s+)?)[^\s⎿]/;
const conversationRow = (row: string) => /^\s*[⎿⏺●]/.test(row);
function bareChoice(rows: string[]): ScreenChoice | null {
  if (rows.some((row, index) => /^\s*❯/.test(row) && (rule(rows[index - 1] ?? '') || rule(rows[index + 1] ?? '')))) return null;
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
  if (rows.some((row, index) => inputRow('claude', row) && (rule(rows[index - 1] ?? '') || rule(rows[index + 1] ?? '')))) return null;
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

function parseChoice(agent: ScreenAgent, rows: string[]): ScreenChoice | null {
  let lastOption = rows.length - 1;
  while (lastOption >= 0 && !optionRow(rows[lastOption])) lastOption--;
  if (lastOption < 0) return agent === 'claude' ? bareChoice(rows) : null;

  let titleIndex = lastOption - 1;
  while (titleIndex >= 0 && !choiceTitle(rows[titleIndex].trim())) {
    if (inputRow(agent, rows[titleIndex])) return null;
    titleIndex--;
  }
  // A prompt the CLI shows before its input exists (Codex's update offer, a folder to trust, Claude's "resume from
  // summary") has no title of a known form: with no input on screen and the cursor on one of its options, the
  // paragraph just above the options heads it.
  if (titleIndex < 0) {
    if (rows.some(row => inputRow(agent, row) || agent === 'claude' && conversationRow(row))) return null;
    // The options' block runs up past their wrapped labels, descriptions and the blank rows between them.
    let first = lastOption;
    const indent = optionRow(rows[lastOption])![1].length;
    for (let index = lastOption - 1; index >= 0; index--) {
      if (optionRow(rows[index])) first = index;
      else if (rows[index].trim() && rows[index].search(/\S/) <= indent + 1) break;
    }
    if (!rows.slice(first, lastOption + 1).some(row => /^\s*[❯›>]\s*\d+\./.test(row))) return null;
    let top = first - 1;
    while (top >= 0 && (!rows[top].trim() || rule(rows[top]))) top--;
    if (top < 0) return null;
    while (top > 0 && rows[top - 1].trim() && !rule(rows[top - 1])) top--;
    // A question or heading of its own a blank row above that paragraph heads it instead ("Trust this folder?").
    const heading = top - 2;
    if (heading >= 0 && !rows[top - 1].trim() && /[?:？：]$/.test(rows[heading].trim()) && !rows[heading - 1]?.trim()) top = heading;
    titleIndex = top;
  }
  let firstOption = titleIndex + 1;
  while (firstOption <= lastOption && !optionRow(rows[firstOption])) firstOption++;

  const options: ScreenOption[] = [];
  // A row under an option is its label wrapping when the label's row ran to the screen's edge, else its description
  // (Codex's sign-in options: "Sign in with ChatGPT" over "Usage included with Plus, Pro…").
  let width = 0;
  const wraps = (length: number) => length >= (width ||= Math.max(...rows.map(row => row.length))) - 12;
  const nextFilled = (from: number) => { while (from < rows.length && !rows[from].trim()) from++; return rows[from]; };
  let numberColumn = 0, hasDetail = false, end = firstOption, previous = 0;
  for (; end < rows.length; end++) {
    const row = rows[end], text = row.trim(), match = optionRow(row);
    if (match) {
      const columns = match[4].trim().split(/\s{2,}/);
      numberColumn = match[1].length + match[2].length;
      hasDetail = columns.length > 1;
      options.push({ number: Number(match[3]), label: columns[0], detail: columns.slice(1).join(' '),
        selected: match[2].includes(agent === 'claude' ? '❯' : '›') || match[2].includes('>'), hotkey: null });
      previous = row.length;
    } else if (!text && options.length && optionRow(nextFilled(end + 1) ?? '')) {
      continue; // a blank row between options (Codex's sign-in choices)
    } else if (text && !rule(row) && !hintRow(row) && !menuExtra(row) && !inputRow(agent, row) &&
        row.search(/\S/) > numberColumn && options.length) {
      const option = options[options.length - 1];
      if (hasDetail || !wraps(previous)) { option.detail = `${option.detail} ${text}`.trim(); hasDetail = true; }
      else option.label += ' ' + text;
      previous = row.length;
    } else break;
  }
  if (end <= lastOption) return null;

  let hint: string | null = null;
  for (const row of rows.slice(end)) {
    if (hintRow(row)) hint = row.trim();
    else if (row.trim() && !rule(row) && !menuExtra(row)) return null;
  }
  if (agent === 'codex') {
    for (const option of options) {
      const field = option.detail ? 'detail' : 'label';
      const hotkey = /\s+\(([a-z]|esc)\)$/.exec(option[field]);
      if (hotkey) {
        option.hotkey = hotkey[1];
        option[field] = option[field].slice(0, hotkey.index).trimEnd();
      }
    }
  }

  const title = rows[titleIndex].trim();
  let contextStart = titleIndex + 1;
  if (agent === 'claude' && permissionTitle(title)) {
    // Claude displays the file/action before the question, bounded by the prompt's solid rule.
    contextStart = titleIndex - 1;
    while (contextStart >= 0 && !/^─{2,}$/.test(rows[contextStart].trim()) &&
        !inputRow(agent, rows[contextStart])) contextStart--;
    contextStart++;
  }
  return {
    title, kind: permissionTitle(title) ? 'permission' : 'menu', options, hint,
    context: rows.slice(contextStart, firstOption).filter((row, offset) =>
      contextStart + offset !== titleIndex && row.trim() && !rule(row)).map(row => row.trim()),
  };
}

// Codex's own list of earlier conversations over its whole screen, from "codex resume" (Esc starts a new one) or from
// /resume inside a conversation (Esc goes back to it). Codex 0.162 draws:
//    Resume a previous session
//    Filter:  Cwd  All    Status:  Active  Archived    Sort:  Updated  Created
//    Type to search
//      › 3h ago      合并远端主分支
//        10h ago     修复阅读视图的滚动
//    ────────────────────────────────────── 1 / 10 · 100% ─
//    enter resume   ctrl+a archive   esc start new   ctrl+c quit   tab focus sort/filter   ←/→ change option
// (older versions put a branch column between the age and the name). Each conversation is an option, picked with the
// arrows and Enter like any other menu's.
const AGE = String.raw`\d+\s*[a-z]+\s+ago|just now|now|yesterday|\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?`;
const sessionRow = new RegExp(String.raw`^\s*([›>])?\s*(${AGE})\s{2,}(\S.*)$`, 'i');
function parseResumePicker(rows: string[]): ScreenChoice | null {
  const titleIndex = rows.findIndex(row => /^\s*Resume a previous session\s*$/.test(row));
  if (titleIndex < 0) return null;
  const footer = rows.findIndex((row, index) => index > titleIndex && /^\s*enter\s+(?:resume|restore)\b/i.test(row));
  if (footer < 0) return null;
  const options: ScreenOption[] = [], context: string[] = [];
  let position: RegExpExecArray | null = null;
  for (const row of rows.slice(titleIndex + 1, footer)) {
    const match = sessionRow.exec(row);
    if (match) {
      const columns = match[3].trim().split(/\s{2,}/);
      options.push({ number: options.length + 1, label: columns[columns.length - 1], detail: [match[2], ...columns.slice(0, -1)].join(' · '), selected: !!match[1], hotkey: null });
    } else if (/^\s*No sessions\b/i.test(row)) context.push(row.trim());
    // Where the cursor is in the whole list, on the rule above the keys ("─── 1 / 10 · 100% ─").
    else position ??= /^\s*─+\s*(\d+)\s*\/\s*(\d+)\s*·\s*\d+%\s*─*$/.exec(row);
  }
  // Told only when the list goes on past what the screen shows.
  if (position && Number(position[2]) > options.length) context.push(`${position[1]} / ${position[2]}`);
  const keys = rows[footer].trim().split(/\s{2,}/);
  const escape = keys.find(key => /^esc\s/i.test(key)) ?? null;
  return { title: rows[titleIndex].trim(), kind: 'menu', options, context,
    hint: keys.filter(key => /^(?:enter|esc)\s/i.test(key)).join(' · ') || null,
    escape: escape && /start new/i.test(escape) ? 'new' : escape && /exit|back|close/i.test(escape) ? 'back' : null };
}

export function parseAgentScreen(agent: ScreenAgent, rows: string[]): AgentScreen {
  // Retain leading/column whitespace for option alignment; normalize CRLF and terminal padding.
  const normalized = rows.map(row => row.replace(/[\s\r]+$/, ''));
  const start = footerStart(agent, normalized);
  const status = parseStatus(agent, normalized, start);
  const overlay = parseOverlay(agent, normalized, start);
  const picker = agent === 'codex' ? parseResumePicker(normalized) : null;
  // A dialog Codex draws over its conversation asks on its own rows.
  const dialog = agent === 'codex' && !picker && overlay === 'none' ? codexDialog(normalized) : null;
  let choice = picker;
  if (!choice && overlay === 'none') {
    choice = dialog ? parseChoice(agent, dialog)
      : parseQuestion(agent, normalized) ?? parseChoice(agent, normalized) ?? (agent === 'claude' ? looseMenu(normalized) : null);
  }
  return { banner: parseBanner(agent, normalized, status), status,
    choice, overlay: picker ? 'none' : overlay };
}
