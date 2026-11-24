import { codexQuestion } from '../agents/agent-question.ts';
import type { AgentScreen, CliScreen, ScreenBanner, ScreenChoice, ScreenOption, ScreenStatus } from './types.ts';
import { cleanBannerRow, commandInputText, emptyStatus, fromColumn, hintRow, optionRow, parseChoice, parseWaiting, prompt, rightPart } from './rows.ts';

const cursorRow = (row: string) => /^\s*›(?:\s|$)/.test(row);
const inputRow = (row: string) => cursorRow(row) && !optionRow(row);
const readPrompt = (row: string) => prompt(/^\s*›(?:\s+(.*))?$/, row);

function footerStart(rows: string[]) {
  for (let index = rows.length - 1; index >= 0; index--) {
    // Codex 0.163 replaces › with ! in its shell editor. This footer anchor is separate from shortcut/menu rows.
    // A numbered draft is still the composer when the model footer follows it, rather than menu key hints.
    if (inputRow(rows[index]) || /^\s*!(?:\s|$)/.test(rows[index]) ||
        cursorRow(rows[index]) && parseStatus(rows, index + 1).model !== null) return index + 1;
  }
  return rows.length;
}

function parseStatus(rows: string[], start: number): ScreenStatus {
  const status = emptyStatus();
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
  return status;
}

function parseOverlay(rows: string[], start: number): AgentScreen['overlay'] {
  if (start === rows.length) return 'none';
  // Popups are above Codex's composer; their insertion/close hints identify the live block.
  let previousInput = start - 2;
  while (previousInput >= 0 && (!inputRow(rows[previousInput]) ||
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
  return 'none';
}

function banner(rows: string[], status: ScreenStatus): ScreenBanner | null {
  for (let index = rows.length - 1; index >= 0; index--) {
    const match = />_ OpenAI Codex \(v([^\s)]+)\)/.exec(rows[index]);
    if (match) return { product: 'OpenAI Codex', version: match[1], model: status.model, effort: status.effort,
      plan: null, directory: cleanBannerRow(rows[index + 1] ?? '') };
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

function cliInputArea(rows: string[]) {
  for (let index = rows.length - 1; index >= 0; index--) {
    const text = readPrompt(rows[index]);
    if (text === null) continue;
    const following = rows.slice(index + 1), footer = following.findIndex(codexFooterRow);
    if (footer !== -1) {
      const draft = [text, ...following.slice(0, footer).filter(row => /^ {2}\S/.test(row)).map(row => row.trim())].join(' ').trim();
      return { row: index, start: index, footer: index + 1 + footer, text: draft };
    }
  }
  return null;
}

const codexModelRow = (row: string) => /^\s*(?:GPT|gpt|o\d|codex)[^·]*\s+·\s+.+$/.test(row.replace(/\r$/, ''));
const codexFooterRow = (row: string) => codexModelRow(row) || /^\s*\? for shortcuts\b/.test(row)
  || /^\s*\d+% context left(?:\s|$)/.test(row);
function codexPickerBelow(rows: string[], footerRow: number) {
  return rows.slice(footerRow + 1).some(row => !codexFooterRow(row) && /\b(?:esc|enter)(?:\/tab)?\s+(?:to\s+)?(?:cancel|close|confirm|select|submit|back|continue|details|exit|insert)\b/i.test(row));
}

function status(rows: string[]) {
  const start = footerStart(rows), status = parseStatus(rows, start);
  return { banner: banner(rows, status), status, overlay: parseOverlay(rows, start) };
}

function dialog(rows: string[], screen = status(rows)) {
  const picker = parseResumePicker(rows);
  if (picker) return { choice: picker, overlay: 'none' as const };
  if (screen.overlay !== 'none') return {};
  const overlay = codexDialog(rows), content = overlay ?? rows;
  const options = { inputRow, selected: '›', hotkeys: true };
  const choice = overlay ? parseChoice(content, options) : codexQuestion(rows) ?? parseChoice(rows, options);
  const inputAt = screen.status.model !== null ? footerStart(rows) - 1 : -1;
  const panelHead = content.findIndex((row, index) => row.trim() === 'Update Model Permissions' ||
    row.trim() === 'Plugins' && content[index + 1]?.trim() === 'Browse plugins from available marketplaces.');
  return { choice, waiting: choice ? null : parseWaiting(content, !!overlay, index => index === inputAt, inputRow, panelHead) };
}

function input(rows: string[]) {
  const area = cliInputArea(rows);
  if (!area) return null;
  return { text: area.text === 'Ask Codex to do anything' ? '' : commandInputText(area.text) };
}

function otherDialog(rows: string[]) {
  const input = cliInputArea(rows);
  return !!codexDialog(rows) || !!input && codexPickerBelow(rows, input.footer);
}

export const codex: CliScreen = {
  input, working: rows => rows.some(row => /^\s*[•◦].*\besc to interrupt\b/i.test(row)),
  atPrompt: rows => !!cliInputArea(rows), dialog, status, otherDialog,
  receiptOnScreen: false, clears: text => /^\/(?:clear|new)(?:\s|$)/.test(text.trim()),
};
