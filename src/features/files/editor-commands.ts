// Editing commands for the file editor, a plain textarea, on VS Code's keys: Ctrl+/ comments or uncomments the
// selected lines, Shift+Alt+A puts a block comment around the selection, Tab and Shift+Tab (or Ctrl+] and Ctrl+[)
// indent and outdent lines, Alt+Up/Down move them, Shift+Alt+Up/Down copy them, Ctrl+Shift+K deletes them, Ctrl+L
// selects the line, Ctrl+Enter opens a line below and Enter keeps the indentation. Each command maps the text and
// selection to new ones; the editor replaces only the span that changed, as one edit that Ctrl+Z undoes whole.
export type EditorState = { text: string; start: number; end: number };
export type Syntax = { line?: string; block?: [string, string]; indentAfter?: RegExp; indent?: string };

const SLASH: Syntax = { line: '//', block: ['/*', '*/'] };
const HASH: Syntax = { line: '#' };
const SYNTAXES: [string, Syntax][] = [
  ['js jsx mjs cjs ts tsx mts cts c h cc cpp cxx hpp cs java kt kts go rs swift scala dart php json jsonc json5 scss less groovy gradle proto zig', SLASH],
  ['sh bash zsh fish rb pl r toml conf cfg env properties dockerfile makefile mk cmake tf hcl nix ex exs jl coffee graphql gql', HASH],
  ['py pyw', { line: '#', indentAfter: /:$/, indent: '    ' }],
  ['yaml yml', { line: '#', indentAfter: /:$/ }],
  ['ps1 psm1 psd1', { line: '#', block: ['<#', '#>'] }],
  ['css', { block: ['/*', '*/'] }],
  ['html htm xml svg xaml vue md markdown mdown mkd csproj props targets plist', { block: ['<!--', '-->'] }],
  ['sql', { line: '--', block: ['/*', '*/'] }],
  ['lua', { line: '--', block: ['--[[', ']]'] }],
  ['hs elm', { line: '--', block: ['{-', '-}'] }],
  ['ini clj cljs lisp el scm asm', { line: ';' }],
  ['bat cmd', { line: 'REM' }],
  ['vb vbs', { line: "'" }],
  ['tex sty cls erl', { line: '%' }],
  ['vim', { line: '"' }],
];
const BY_EXTENSION = new Map(SYNTAXES.flatMap(([names, syntax]) => names.split(' ').map(name => [name, syntax] as const)));

// By the file's extension, or its whole name when it has none (Dockerfile, Makefile); "#" for anything else, the
// comment of most configuration files (.env.local, .bashrc, .gitignore).
export function editorSyntax(path: string): Syntax {
  const name = (path.split(/[\\/]/).at(-1) || '').toLowerCase();
  return BY_EXTENSION.get(name.slice(name.lastIndexOf('.') + 1)) ?? HASH;
}

// The file's own indentation: tabs where most indented lines start with one, otherwise the most common step between
// space-indented lines; the language's usual one (two spaces unless it says otherwise) in a file with neither.
export function indentUnit(text: string, syntax: Syntax): string {
  let tabs = 0, previous = 0;
  const steps = new Map<number, number>();
  for (const line of text.slice(0, 200_000).split('\n')) {
    const indent = /^[ \t]*/.exec(line)![0];
    if (indent.length === line.length) continue;
    if (indent[0] === '\t') { tabs++; continue; }
    const step = Math.abs(indent.length - previous); previous = indent.length;
    if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1);
  }
  const common = [...steps].sort((a, b) => b[1] - a[1])[0];
  if (tabs > [...steps.values()].reduce((sum, count) => sum + count, 0)) return '\t';
  return common ? ' '.repeat(common[0]) : syntax.indent ?? '  ';
}

const lineStart = (text: string, position: number) => text.lastIndexOf('\n', position - 1) + 1;
const lineEnd = (text: string, position: number) => { const end = text.indexOf('\n', position); return end === -1 ? text.length : end; };
const leading = (line: string) => /^[ \t]*/.exec(line)![0];
// The whole lines a selection covers; one that ends at the start of a line leaves that line out, as in VS Code.
function coveredLines({ text, start, end }: EditorState) {
  return { from: lineStart(text, start), to: lineEnd(text, end > start && lineStart(text, end) === end ? end - 1 : end) };
}
function lines(text: string, from: number, to: number) {
  const result: { start: number; text: string }[] = [];
  for (let start = from; ; start = lineEnd(text, start) + 1) {
    const end = lineEnd(text, start);
    result.push({ start, text: text.slice(start, end) });
    if (end >= to) return result;
  }
}

type Edit = { at: number; remove: number; insert: string };
// Applies edits (in order, apart from one another) and carries the selection through them: a caret, and the end of a
// selection, move past text inserted where they stand; the start of a selection stays before it.
function edit(state: EditorState, edits: Edit[]): EditorState | null {
  if (!edits.length) return null;
  let text = '', last = 0;
  for (const change of edits) { text += state.text.slice(last, change.at) + change.insert; last = change.at + change.remove; }
  text += state.text.slice(last);
  const map = (position: number, after: boolean) => {
    let shift = 0;
    for (const change of edits) {
      if (position < change.at || (position === change.at && !after && !change.remove)) break;
      if (position < change.at + change.remove) return change.at + shift + (after ? change.insert.length : 0);
      shift += change.insert.length - change.remove;
    }
    return position + shift;
  };
  return { text, start: map(state.start, state.start === state.end), end: map(state.end, true) };
}
const replace = (state: EditorState, from: number, to: number, insert: string, caret = from + insert.length): EditorState =>
  ({ text: state.text.slice(0, from) + insert + state.text.slice(to), start: caret, end: caret });

// Ctrl+/: when every non-blank line is commented, uncomment them; otherwise comment them all at their smallest
// indentation. A language with block comments only (HTML, CSS) wraps the lines in one.
export function toggleLineComment(state: EditorState, syntax: Syntax): EditorState | null {
  const { from, to } = coveredLines(state);
  if (!syntax.line) return toggleBlockComment(state, syntax, { from, to });
  const token = syntax.line, all = lines(state.text, from, to), filled = all.filter(line => line.text.trim());
  if (filled.length && filled.every(line => line.text.slice(leading(line.text).length).startsWith(token))) return edit(state, filled.map(line => {
    const at = line.start + leading(line.text).length;
    return { at, remove: token.length + (state.text[at + token.length] === ' ' ? 1 : 0), insert: '' };
  }));
  const targets = filled.length ? filled : all, column = Math.min(...targets.map(line => leading(line.text).length));
  return edit(state, targets.map(line => ({ at: line.start + column, remove: 0, insert: token + ' ' })));
}

// Shift+Alt+A: the selection (or the caret's line) loses the block comment around it, or gains one.
export function toggleBlockComment(state: EditorState, syntax: Syntax, range = state.start === state.end
  ? { from: lineStart(state.text, state.start), to: lineEnd(state.text, state.start) } : { from: state.start, to: state.end }): EditorState | null {
  if (!syntax.block) return syntax.line ? toggleLineComment(state, syntax) : null;
  const [open, close] = syntax.block, { text } = state;
  let from = range.from, to = range.to;
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  if (to - from >= open.length + close.length && text.startsWith(open, from) && text.slice(to - close.length, to) === close) {
    const before = text[from + open.length] === ' ' ? 1 : 0;
    const after = text[to - close.length - 1] === ' ' && to - close.length - 1 >= from + open.length + before ? 1 : 0;
    return edit(state, [{ at: from, remove: open.length + before, insert: '' }, { at: to - close.length - after, remove: close.length + after, insert: '' }]);
  }
  if (from === to) return replace(state, from, from, `${open}  ${close}`, from + open.length + 1);
  return edit(state, [{ at: from, remove: 0, insert: open + ' ' }, { at: to, remove: 0, insert: ' ' + close }]);
}

// Tab: a selection over several lines indents them; otherwise the selection becomes indentation up to the next stop.
export function tab(state: EditorState, syntax: Syntax): EditorState | null {
  if (state.text.slice(state.start, state.end).includes('\n')) return indentLines(state, syntax);
  const unit = indentUnit(state.text, syntax);
  const insert = unit === '\t' ? unit : ' '.repeat(unit.length - (state.start - lineStart(state.text, state.start)) % unit.length);
  return replace(state, state.start, state.end, insert);
}
export function indentLines(state: EditorState, syntax: Syntax): EditorState | null {
  const unit = indentUnit(state.text, syntax), { from, to } = coveredLines(state), all = lines(state.text, from, to);
  const targets = all.filter(line => line.text);
  return edit(state, (targets.length ? targets : all).map(line => ({ at: line.start, remove: 0, insert: unit })));
}
export function outdentLines(state: EditorState, syntax: Syntax): EditorState | null {
  const unit = indentUnit(state.text, syntax), width = unit === '\t' ? 4 : unit.length, { from, to } = coveredLines(state);
  return edit(state, lines(state.text, from, to)
    .map(line => ({ at: line.start, remove: line.text[0] === '\t' ? 1 : Math.min(width, /^ */.exec(line.text)![0].length), insert: '' }))
    .filter(change => change.remove));
}

// Alt+Up/Down: the lines swap places with the one above or below; the selection goes with them.
export function moveLines(state: EditorState, direction: 'up' | 'down'): EditorState | null {
  const { text } = state, { from, to } = coveredLines(state), block = text.slice(from, to);
  if (direction === 'up') {
    if (!from) return null;
    const above = lineStart(text, from - 1), shift = from - above;
    return { text: text.slice(0, above) + block + '\n' + text.slice(above, from - 1) + text.slice(to), start: state.start - shift, end: state.end - shift };
  }
  if (to === text.length) return null;
  const below = lineEnd(text, to + 1), shift = below - to;
  return { text: text.slice(0, from) + text.slice(to + 1, below) + '\n' + block + text.slice(below), start: state.start + shift, end: state.end + shift };
}

// Shift+Alt+Up/Down: a copy of the lines goes above or below them, and the selection moves to that copy.
export function copyLines(state: EditorState, direction: 'up' | 'down'): EditorState {
  const { text } = state, { from, to } = coveredLines(state), block = text.slice(from, to);
  const shift = direction === 'down' ? block.length + 1 : 0;
  return { text: text.slice(0, to) + '\n' + block + text.slice(to), start: state.start + shift, end: state.end + shift };
}

// Ctrl+Shift+K: the lines go; the caret keeps its column on the line that takes their place.
export function deleteLines(state: EditorState): EditorState {
  const { text } = state, { from, to } = coveredLines(state), column = state.start - lineStart(text, state.start);
  const next = to < text.length ? text.slice(0, from) + text.slice(to + 1) : text.slice(0, Math.max(0, from - 1));
  const start = to < text.length ? from : lineStart(next, Math.max(0, from - 1));
  const caret = Math.min(start + column, lineEnd(next, start));
  return { text: next, start: caret, end: caret };
}

// Ctrl+L: the whole line is selected; pressed again, the next one joins it.
export function selectLine(state: EditorState): EditorState {
  return { text: state.text, start: lineStart(state.text, state.start), end: Math.min(state.text.length, lineEnd(state.text, state.end) + 1) };
}

// Ctrl+Enter: a new line below this one, at its indentation.
export function insertLineBelow(state: EditorState): EditorState {
  const end = lineEnd(state.text, state.end);
  return replace(state, end, end, '\n' + leading(state.text.slice(lineStart(state.text, state.end), end)));
}

// Enter: the new line keeps the indentation; one more step after an opening bracket (or a colon in Python and
// YAML), and a closing bracket right after the caret moves to its own line below.
export function newline(state: EditorState, syntax: Syntax): EditorState {
  const { text, start, end } = state, from = lineStart(text, start), before = text.slice(from, start), indent = leading(before);
  const last = before.trimEnd().at(-1) ?? '', closer = ({ '{': '}', '[': ']', '(': ')' } as Record<string, string>)[last];
  const after = text.slice(end, lineEnd(text, end)), gap = after.length - after.trimStart().length;
  if (closer && after.trimStart().startsWith(closer)) {
    const unit = indentUnit(text, syntax), inner = '\n' + indent + unit;
    return replace(state, start, end + gap, inner + '\n' + indent, start + inner.length);
  }
  const deeper = closer || syntax.indentAfter?.test(before.trimEnd()) ? indentUnit(text, syntax) : '';
  return replace(state, start, end, '\n' + indent + deeper);
}

type Key = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;
type Command = (state: EditorState, syntax: Syntax) => EditorState | null;
// The command a key runs in the editor, or null for a key the textarea keeps.
export function commandFor(event: Key): Command | null {
  const mod = event.ctrlKey || event.metaKey, { altKey: alt, shiftKey: shift, key, code } = event;
  if (mod && !alt && !shift && (key === '/' || code === 'Slash')) return toggleLineComment;
  if (alt && shift && !mod && code === 'KeyA') return toggleBlockComment;
  if (key === 'Tab' && !mod && !alt) return shift ? outdentLines : tab;
  if (mod && !alt && !shift && code === 'BracketRight') return indentLines;
  if (mod && !alt && !shift && code === 'BracketLeft') return outdentLines;
  if (alt && !mod && (key === 'ArrowUp' || key === 'ArrowDown')) {
    const direction = key === 'ArrowUp' ? 'up' : 'down';
    return state => shift ? copyLines(state, direction) : moveLines(state, direction);
  }
  if (mod && shift && !alt && code === 'KeyK') return deleteLines;
  if (mod && !alt && !shift && code === 'KeyL') return selectLine;
  if (mod && !alt && !shift && key === 'Enter') return insertLineBelow;
  if (key === 'Enter' && !mod && !alt && !shift) return newline;
  return null;
}

// Runs the command for a key pressed in the editor, and says whether there was one. The changed span is selected and
// typed over (execCommand keeps it on the textarea's undo stack, and React's onChange sees it), then the command's
// selection is set.
export function runEditorKey(event: KeyboardEvent, node: HTMLTextAreaElement, path: string): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;
  const command = commandFor(event);
  if (!command) return false;
  event.preventDefault();
  const old = node.value, next = command({ text: old, start: node.selectionStart, end: node.selectionEnd }, editorSyntax(path));
  if (!next) return true;
  if (old !== next.text) {
    let head = 0, tail = 0;
    const shortest = Math.min(old.length, next.text.length);
    while (head < shortest && old[head] === next.text[head]) head++;
    while (tail < shortest - head && old[old.length - 1 - tail] === next.text[next.text.length - 1 - tail]) tail++;
    const insert = next.text.slice(head, next.text.length - tail);
    node.setSelectionRange(head, old.length - tail);
    if (!document.execCommand(insert ? 'insertText' : 'delete', false, insert)) {
      node.setRangeText(insert, head, old.length - tail);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  node.setSelectionRange(next.start, next.end);
  return true;
}
