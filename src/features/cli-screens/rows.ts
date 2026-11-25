import type { AgentScreen, ScreenChoice, ScreenOption, ScreenStatus } from './types.ts';

export const rule = (row: string) => /^[─╌]{2,}$/.test(row.trim());
export const optionRow = (row: string) => /^(\s*)([❯›>↓↑]?\s*)(\d+)\.\s+(.+)$/.exec(row);
export const hintRow = (row: string) => /^(?:press\s+)?(?:enter|esc|tab)\b.*(?:cancel|confirm|select|submit|back|default|continue|skip|exit|close)/i.test(row.trim());
// A terminal gives CJK and other wide characters two cells: a row's columns are counted in cells, not characters.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u;
const cells = (text: string) => { let width = 0; for (const char of text) width += WIDE.test(char) ? 2 : 1; return width; };
// What a row shows from a column on.
export function fromColumn(row: string, column: number) {
  const chars = [...row];
  let at = 0, width = 0;
  while (at < chars.length && width < column) width += WIDE.test(chars[at++]) ? 2 : 1;
  return chars.slice(at).join('');
}
// The part of a row set off to the right, beside or instead of the conversation's own text (which starts at its left
// edge): its column and text, or null.
export function rightPart(row: string, from: number, matches: (text: string) => boolean = () => true) {
  for (const gap of row.matchAll(/\s{2,}(?=\S)/g)) {
    const end = gap.index + gap[0].length, column = cells(row.slice(0, end));
    if (column >= from && matches(row.slice(end))) return { column, text: row.slice(end) };
  }
  return null;
}

// Codex asks "Would you like to run the following command?", "…make the following edits?", "…grant these permissions?"
// and "<server> needs your approval."; Claude "Do you want to create hello.txt?".
export const mcpUrlTitle = /^MCP server .+ wants to open a URL$/i;
export const permissionTitle = (row: string) =>
  mcpUrlTitle.test(row) || /^(?:Do you want\b|Would you like to\b|Allow\b)|\bneeds your approval\.?$|^(?:Exit plan mode\?|Implement this plan\?|Action required)$/i.test(row);
const choiceTitle = (row: string) => permissionTitle(row) || /^Select\b/i.test(row);

export const conversationRow = (row: string) => /^\s*[⎿⏺●]/.test(row);
const menuExtra = (row: string) => /^(?:…\s*\+\d+ models|●\s+\S+ effort\b.*to adjust|Learn more:\s+\S+)$/.test(row.trim());

type RowTest = (row: string) => boolean;
type ChoiceRows = { inputRow: RowTest; selected: string; historical?: RowTest; hotkeys?: boolean; beforePermission?: boolean;
  unnumbered?: (rows: string[]) => ScreenChoice | null };

export function parseChoice(rows: string[], { inputRow, selected, historical, hotkeys, beforePermission, unnumbered }: ChoiceRows): ScreenChoice | null {
  let lastOption = rows.length - 1;
  while (lastOption >= 0 && !optionRow(rows[lastOption])) lastOption--;
  if (lastOption < 0) return unnumbered?.(rows) ?? null;

  const titleIndex = choiceHeading(rows, lastOption, inputRow, historical);
  if (titleIndex < 0) return null;
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
        selected: match[2].includes(selected) || match[2].includes('>'), hotkey: null });
      previous = row.length;
    } else if (!text && options.length && optionRow(nextFilled(end + 1) ?? '')) {
      continue; // a blank row between options (Codex's sign-in choices)
    } else if (text && !rule(row) && !hintRow(row) && !menuExtra(row) && !inputRow(row) &&
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
  if (hotkeys) {
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
  if (beforePermission && permissionTitle(title)) {
    // Claude displays the file/action before the question, bounded by the prompt's solid rule.
    contextStart = titleIndex - 1;
    while (contextStart >= 0 && !/^─{2,}$/.test(rows[contextStart].trim()) &&
        !inputRow(rows[contextStart])) contextStart--;
    contextStart++;
  }
  return {
    title, kind: permissionTitle(title) ? 'permission' : 'menu', options, hint,
    context: rows.slice(contextStart, firstOption).filter((row, offset) =>
      contextStart + offset !== titleIndex && row.trim() && !rule(row)).map(row => row.trim()),
  };
}

function choiceHeading(rows: string[], lastOption: number, inputRow: RowTest, historical?: RowTest) {
  let titleIndex = lastOption - 1;
  while (titleIndex >= 0 && !choiceTitle(rows[titleIndex].trim())) {
    if (inputRow(rows[titleIndex])) return -1;
    titleIndex--;
  }
  // A prompt the CLI shows before its input exists (Codex's update offer, a folder to trust, Claude's "resume from
  // summary") has no title of a known form: with no input on screen and the cursor on one of its options, the
  // paragraph just above the options heads it.
  if (titleIndex < 0) {
    if (rows.some(row => inputRow(row) || historical?.(row))) return -1;
    // The options' block runs up past their wrapped labels, descriptions and the blank rows between them.
    let first = lastOption;
    const indent = optionRow(rows[lastOption])![1].length;
    for (let index = lastOption - 1; index >= 0; index--) {
      if (optionRow(rows[index])) first = index;
      else if (rows[index].trim() && rows[index].search(/\S/) <= indent + 1) break;
    }
    if (!rows.slice(first, lastOption + 1).some(row => /^\s*[❯›>]\s*\d+\./.test(row))) return -1;
    let top = first - 1;
    while (top >= 0 && (!rows[top].trim() || rule(rows[top]))) top--;
    if (top < 0) return -1;
    while (top > 0 && rows[top - 1].trim() && !rule(rows[top - 1])) top--;
    // A question or heading of its own a blank row above that paragraph heads it instead ("Trust this folder?").
    const heading = top - 2;
    if (heading >= 0 && !rows[top - 1].trim() && /[?:？：]$/.test(rows[heading].trim()) && !rows[heading - 1]?.trim()) top = heading;
    titleIndex = top;
  }
  return titleIndex;
}

// Only the live dialog's own closing controls establish waiting. Quoted hints above a returned input, an old
// question followed by an answer, the working footer ("esc to interrupt") and silence cannot establish it.
export function parseWaiting(content: string[], dialog: boolean, composer: (index: number) => boolean, inputRow: RowTest, panelHead: number): AgentScreen['waiting'] {
  let end = content.length - 1;
  while (end >= 0 && !content[end].trim()) end--;
  if (end < 0) return null;
  const hint = content[end].trim();
  const controls = /^(?:(?:press\s+)?(?:enter|esc|tab|space)\b|[←→↑↓]|Type to filter\b)/i.test(hint) &&
    /\b(?:select|submit|cancel|confirm|navigate|switch|close|back)\b/i.test(hint);
  const cursor = /^\s*[❯›>]\s*(?:\d+\.|[*◯◉]|Accept\b)/;
  let head = -1;
  for (let index = end; index >= 0; index--) {
    const text = content[index].trim();
    if (!dialog && composer(index)) break;
    if (index === panelHead) return null;
    if (permissionTitle(text) || /^Review your answers$|^Ready to submit your answers\?$|^MCP server .+ requests your input$|^(?:Question|Field) \d+\/\d+\b/.test(text)) { head = index; break; }
    if (panelHead < 0 && inputRow(content[index]) && !cursor.test(content[index])) break;
    if (conversationRow(content[index])) break;
  }
  if (head >= 0 && (controls || content.slice(head + 1, end + 1).some(row => cursor.test(row)))) {
    let title = content[head].trim();
    if (/^(?:Question|Field) \d+\/\d+\b/.test(title)) title = content.slice(head + 1, end).find(row => row.trim())?.trim() ?? title;
    return { title };
  }
  if (!controls) return null;
  // One isolated Escape hint can occur in prose. A frame, a selector, or several key hints identify a dialog.
  const framed = content.some(row => rule(row) || /^\s*▔{8,}/.test(row));
  const selector = content.some(row => cursor.test(row));
  if (!dialog && !framed && !selector && !/[·|]|↑|↓/.test(hint)) return null;
  return { title: (dialog ? content.find(row => row.trim())?.trim() : null) ?? null };
}

export const commandInputText = (text: string) => {
  const trimmed = text.trim();
  return trimmed.startsWith('!') ? '!' + trimmed.slice(1).trimStart() : trimmed;
};
export const prompt = (marker: RegExp, row: string) => {
  const shell = /^\s*!(?:\s+(.*))?$/.exec(row.replace(/\r$/, ''));
  if (shell) return '!' + (shell[1] ?? '').trim();
  const match = marker.exec(row.replace(/\r$/, ''));
  if (!match) return null;
  return (match[1] ?? '').trim();
};

export function closingKeyHint(rows: string[]) {
  const tail = rows.filter(row => row.trim()).at(-1)?.trim() ?? '';
  return /^(?:press )?esc to (?:cancel|close|go back|dismiss)$/i.test(tail)
    || /^(?:Type to filter|[←→/]+ tabs|enter select)\b.*\besc\b/i.test(tail);
}

export const cleanBannerRow = (row: string) => row.replace(/^[\s\u2580-\u259f]+/, '').trim() || null;
export const emptyStatus = (): ScreenStatus => ({ model: null, effort: null, context: null, mode: null, notes: [] });
export const normalizeRows = (rows: string[]) => rows.map(row => row.replace(/[\s\r]+$/, ''));
