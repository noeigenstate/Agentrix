import type { Terminal } from '@xterm/xterm';
import { currentTheme } from '../../shared/themes.ts';
import { terminalContrastColor } from './terminal-theme.ts';

type Color = { css: string; rgba: number };
type Cell = { isDim(): number; getCode(): number };
type DomRows = {
  _applyMinimumContrast(element: HTMLElement, bg: Color, fg: Color, cell: Cell, bgOverride?: Color, fgOverride?: Color): boolean;
};
type GlyphColors = [bg: number, bgMode: number, bgColor: number, fg: number, fgMode: number, fgColor: number, inverse: boolean, dim: boolean, bold: boolean, excluded: boolean];
type Atlas = {
  _getForegroundColor(...args: GlyphColors): Color;
  _resolveBackgroundRgba(mode: number, color: number, inverse: boolean): number;
  _resolveForegroundRgba(mode: number, color: number, inverse: boolean, bold: boolean): number;
};
type Renderer = { _rowFactory?: DomRows; _charAtlas?: Atlas; _refreshCharAtlas?(): void };
const patched = new WeakSet<object>();

// Adapt DIM and dark-CLI ink over the resolved light cell background in both pinned renderers.
// The buffer, ANSI attributes, selection and dark-theme drawing stay native.
// Like the selection and transparent-background adapters, leave unknown renderer versions alone.
export function keepTerminalContrast(terminal: Terminal) {
  const renderer = (terminal as unknown as { _core?: { _renderService?: { _renderer?: { value?: Renderer } } } })._core?._renderService?._renderer?.value;
  const rows = renderer?._rowFactory;
  const rowPrototype = rows && Object.getPrototypeOf(rows) as DomRows;
  const apply = rowPrototype?._applyMinimumContrast;
  if (rowPrototype && typeof apply === 'function' && !patched.has(rowPrototype)) {
    patched.add(rowPrototype);
    rowPrototype._applyMinimumContrast = function (element, bg, fg, cell, bgOverride, fgOverride) {
      const code = cell.getCode();
      // Keep xterm's contrast exclusions for box/block and Powerline glyphs, as the GPU renderer does.
      if (currentTheme() !== 'light' || (code >= 0x2500 && code <= 0x259f) || (code >= 0xe0a4 && code <= 0xe0d6)) return apply.call(this, element, bg, fg, cell, bgOverride, fgOverride);
      const foreground = (fgOverride ?? fg).rgba >>> 8, background = (bgOverride ?? bg).rgba >>> 8;
      const dim = !!cell.isDim(), ink = terminalContrastColor(foreground, background, dim);
      if (!dim && !ink.reflected) return apply.call(this, element, bg, fg, cell, bgOverride, fgOverride);
      element.style.color = ink.css;
      return true;
    };
  }
  const prototype = renderer && Object.getPrototypeOf(renderer) as Renderer;
  const refresh = prototype?._refreshCharAtlas;
  if (prototype && typeof refresh === 'function' && !patched.has(prototype)) {
    patched.add(prototype);
    prototype._refreshCharAtlas = function () { refresh.call(this); keepAtlasContrast(this._charAtlas); };
  }
  keepAtlasContrast(renderer?._charAtlas);
}

function keepAtlasContrast(atlas: Atlas | undefined) {
  const prototype = atlas && Object.getPrototypeOf(atlas) as Atlas;
  const draw = prototype?._getForegroundColor;
  if (!prototype || typeof draw !== 'function' || typeof prototype._resolveBackgroundRgba !== 'function' || typeof prototype._resolveForegroundRgba !== 'function' || patched.has(prototype)) return;
  patched.add(prototype);
  prototype._getForegroundColor = function (...args) {
    const [, bgMode, bgColor, , fgMode, fgColor, inverse, dim, bold, excluded] = args;
    if (currentTheme() !== 'light' || excluded) return draw.apply(this, args);
    const ink = terminalContrastColor(this._resolveForegroundRgba(fgMode, fgColor, inverse, bold) >>> 8, this._resolveBackgroundRgba(bgMode, bgColor, inverse) >>> 8, dim);
    return dim || ink.reflected ? ink : draw.apply(this, args);
  };
}
