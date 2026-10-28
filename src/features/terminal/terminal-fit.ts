import type { Terminal } from '@xterm/xterm';

// Sizes a terminal to its element's parent, as @xterm/addon-fit 0.11 does: the cell size comes from xterm's renderer
// (the same private field the addon reads), the room from the parent less the element's padding and the scrollbar.
// A terminal not yet laid out (no parent, no measured cell, a size of "auto") is left as it is.
type Core = { _renderService: { dimensions: { css: { cell: { width: number; height: number } } }; clear(): void } };
const SCROLLBAR_WIDTH = 14;

export function fitTerminal(terminal: Terminal) {
  const element = terminal.element, parent = element?.parentElement;
  if (!element || !parent || parent.clientWidth <= 20 || parent.clientHeight <= 20) return;
  const core = (terminal as unknown as { _core: Core })._core;
  const cell = core._renderService.dimensions.css.cell;
  if (!cell.width || !cell.height) return;
  const room = getComputedStyle(parent), own = getComputedStyle(element);
  const size = (style: CSSStyleDeclaration, name: string) => parseInt(style.getPropertyValue(name));
  const scrollbar = terminal.options.scrollback === 0 ? 0 : terminal.options.overviewRuler?.width || SCROLLBAR_WIDTH;
  const width = Math.max(0, size(room, 'width')) - size(own, 'padding-left') - size(own, 'padding-right') - scrollbar;
  const height = size(room, 'height') - size(own, 'padding-top') - size(own, 'padding-bottom');
  const cols = Math.max(2, Math.floor(width / cell.width)), rows = Math.max(1, Math.floor(height / cell.height));
  if (Number.isNaN(cols) || Number.isNaN(rows) || (cols === terminal.cols && rows === terminal.rows)) return;
  // A full redraw at the new size, as the addon does.
  core._renderService.clear();
  terminal.resize(cols, rows);
}
