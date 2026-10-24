import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { terminalDecorationColors } from './terminal-theme';

// A light touch of the reading view inside the real terminal. Claude Code and Codex print Markdown already
// rendered: no "##", no backticks are left, only attributes. So the visible rows are read for those:
// a short line that is bold from start to end, after a blank line, is how both print a heading, and is coloured as headings
// are in the reading view; a plain "•" or "●" that the agent left uncoloured gets the bullet colour. Anything the agent
// coloured itself (Claude's green or red "⏺" for a tool that worked or failed) keeps its colour.
// The rows are read again a moment after output settles or the view scrolls, and the marks are redrawn
// from what the rows say then, so a redrawn screen never keeps a stale mark. A working agent redraws its
// screen ten times a second while the marks stay the same; then nothing is redrawn.
const BULLETS = new Set(['•', '●']);

export function styleTerminal(terminal: Terminal): IDisposable {
  let marks: { marker: IMarker; decoration?: IDecoration }[] = [];
  let timer = 0, disposed = false, drawn = '';
  const clear = () => { for (const mark of marks) { mark.decoration?.dispose(); mark.marker.dispose(); } marks = []; drawn = ''; };
  const mark = (row: number, options: { x: number; width: number; foregroundColor: string }) => {
    const buffer = terminal.buffer.active;
    const marker = terminal.registerMarker(row - (buffer.baseY + buffer.cursorY));
    if (!marker) return;
    const decoration = terminal.registerDecoration({ marker, x: options.x, width: options.width, foregroundColor: options.foregroundColor });
    marks.push({ marker, decoration });
  };
  const scan = () => {
    timer = 0;
    if (disposed) return;
    try { draw(); } catch { /* Decorations are an experimental xterm API; without them the terminal is simply unstyled. */ }
  };
  const draw = () => {
    const colors = terminalDecorationColors();
    const buffer = terminal.buffer.active;
    if (buffer.type !== 'normal') { clear(); return; }
    const cellBuffer = buffer.getNullCell();
    const wanted: { row: number; x: number; width: number; foregroundColor: string }[] = [];
    let previousBlank = false;
    for (let row = buffer.viewportY; row < buffer.viewportY + terminal.rows; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const afterBlank = previousBlank;
      previousBlank = !line.translateToString(true).trim();
      let first = -1, last = -1, allBold = true;
      for (let x = 0; x < terminal.cols; x++) {
        const cell = line.getCell(x, cellBuffer);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars();
        if (!chars || chars === ' ') continue;
        if (first < 0) first = x;
        last = x;
        if (!cell.isBold()) allBold = false;
      }
      if (first < 0) continue;
      const lead = line.getCell(first, cellBuffer)!;
      if (BULLETS.has(lead.getChars()) && lead.isFgDefault()) wanted.push({ row, x: first, width: 1, foregroundColor: colors.bullet });
      else if (allBold && afterBlank && !line.isWrapped && last - first >= 1 && last - first < 60 && !BULLETS.has(lead.getChars())) wanted.push({ row, x: first, width: Math.min(terminal.cols - first, last - first + 2), foregroundColor: colors.heading });
    }
    // Rows are counted from the top of the buffer, so the same marks on the same lines compare equal.
    const signature = wanted.map(item => `${item.row}:${item.x}:${item.width}:${item.foregroundColor}`).join('|');
    if (signature === drawn && marks.every(item => !item.marker.isDisposed)) return;
    clear();
    for (const item of wanted) mark(item.row, item);
    drawn = signature;
  };
  const later = () => { if (!timer && !disposed) timer = window.setTimeout(scan, 160); };
  const subscriptions = [terminal.onWriteParsed(later), terminal.onScroll(later), terminal.onResize(later)];
  later();
  return { dispose() { disposed = true; clearTimeout(timer); subscriptions.forEach(item => item.dispose()); clear(); } };
}
