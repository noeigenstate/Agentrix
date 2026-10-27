import { useSyncExternalStore } from 'react';
import type { IDisposable, Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { keepDomSelectionCleared } from './terminal-selection';
import { keepTerminalContrast } from './terminal-contrast';

// Which renderer draws the terminals. The GPU renderer (WebGL) draws text from a glyph atlas: a working agent
// redraws its screen ten times a second, and with the DOM renderer every redraw is rows of HTML to lay out
// again, which on a slow processor took most of the window's time. "dom" is the compatible renderer, for a
// graphics driver that draws the GPU one wrongly.
type TerminalRenderer = 'gpu' | 'dom';
let current: TerminalRenderer = 'gpu';
const listeners = new Set<() => void>();
export function setTerminalRenderer(value: TerminalRenderer) { if (value === current) return; current = value; listeners.forEach(listener => listener()); }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useTerminalRenderer() { return useSyncExternalStore(subscribe, () => current); }
export const terminalRenderer = () => current;

// Chromium keeps at most 16 WebGL contexts in a window and drops the oldest beyond that. Twelve terminals draw
// on the GPU; any more draw with the DOM renderer, so no visible terminal loses its context to another.
const GPU_LIMIT = 12;
let active = 0;
// The weight chosen for terminal text (Settings, 400 by default). The GPU renderer draws it 50 lighter; see below.
const chosenWeight = new WeakMap<Terminal, number>(), drawnOnGpu = new WeakSet<Terminal>();
const weightFor = (terminal: Terminal) => (chosenWeight.get(terminal) ?? 400) - (drawnOnGpu.has(terminal) ? 50 : 0);
export function setTerminalWeight(terminal: Terminal, weight: number) {
  chosenWeight.set(terminal, weight);
  terminal.options.fontWeight = weightFor(terminal);
}

// The GPU renderer draws a background rectangle for each run of cells whose background field is not zero. Dim,
// italic and underline-style text keep flags in that field too, so such text with the default background got a
// rectangle in the theme's background colour at full opacity; over the window's transparent background that is
// black, and Codex's dim lines showed on black bars. A rectangle for the default background (and not inverse)
// is given no width, so the glass shows through as it does with the DOM renderer. The addon version is pinned;
// if its internals change, this does nothing.
const INVERSE = 0x4000000, COLOR_MODE = 0x3000000;
type Rectangles = { _updateRectangle: (vertices: { attributes: Float32Array }, offset: number, fg: number, bg: number, ...rest: number[]) => void };
let clearDefaultBackground = false;
function keepDefaultBackgroundClear(addon: WebglAddon) {
  if (clearDefaultBackground) return;
  const rectangles = (addon as unknown as { _renderer?: { _rectangleRenderer?: { value?: Rectangles } } })._renderer?._rectangleRenderer?.value;
  const prototype = rectangles && Object.getPrototypeOf(rectangles) as Rectangles;
  const update = prototype?._updateRectangle;
  if (!prototype || typeof update !== 'function') return;
  clearDefaultBackground = true;
  prototype._updateRectangle = function (this: Rectangles, vertices, offset, fg, bg, ...rest) {
    update.call(this, vertices, offset, fg, bg, ...rest);
    if (!(fg & INVERSE) && !(bg & COLOR_MODE)) vertices.attributes[offset + 2] = 0;
  };
}

// Draws a terminal on the GPU until disposed. A lost context (a driver reset, the machine waking from sleep)
// returns the terminal to the DOM renderer and calls lost, which may try again. Returns null when the GPU
// renderer is not available (no WebGL, or the limit reached); the terminal then keeps the DOM renderer.
function attachGpuRenderer(terminal: Terminal, lost: () => void): IDisposable | null {
  if (active >= GPU_LIMIT) return null;
  let addon: WebglAddon;
  try { addon = new WebglAddon(); terminal.loadAddon(addon); keepDefaultBackgroundClear(addon); keepTerminalContrast(terminal); } catch { return null; }
  active++;
  // WebGL rasterizes glyphs over the transparent background, where their antialiased edges add up to visibly heavier
  // strokes than the DOM renderer draws at the same weight. A slightly lighter weight of the variable terminal font
  // makes the two look alike; the DOM renderer gets its own weight back when the GPU one is released.
  drawnOnGpu.add(terminal); terminal.options.fontWeight = weightFor(terminal);
  let released = false;
  const release = () => { if (released) return; released = true; active--; drawnOnGpu.delete(terminal); try { addon.dispose(); } catch { /* Already gone with its terminal. */ } try { terminal.options.fontWeight = weightFor(terminal); } catch { /* Disposed. */ } };
  addon.onContextLoss(() => { release(); lost(); });
  return { dispose: release };
}

// The GPU renderer of one terminal, switched on or off as the setting changes. A lost context is tried again a
// few times, a moment later. Switch it on right after the terminal opens, before any output is parsed: starting
// it takes the window a moment, and answers the terminal owes the shell must not wait behind that.
export function gpuRenderer(terminal: Terminal) {
  keepDomSelectionCleared(terminal);
  keepTerminalContrast(terminal);
  let gpu: IDisposable | null = null, wanted = false, retries = 0, timer = 0;
  const attach = () => {
    timer = 0;
    if (!wanted || gpu) return;
    gpu = attachGpuRenderer(terminal, () => {
      gpu = null;
      if (wanted && retries++ < 3) timer = window.setTimeout(attach, 2000);
    });
  };
  return {
    set(enabled: boolean) { wanted = enabled; clearTimeout(timer); timer = 0; if (enabled) attach(); else { gpu?.dispose(); gpu = null; } },
    dispose() { wanted = false; clearTimeout(timer); gpu?.dispose(); gpu = null; },
  };
}
