const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalContrastColor, lightTerminalTheme } = require('../src/features/terminal/terminal-theme.ts');
const { keepTerminalContrast } = require('../src/features/terminal/terminal-contrast.ts');

function luminance(rgb) {
  return [rgb >>> 16 & 255, rgb >>> 8 & 255, rgb & 255].map(channel => channel / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
function themeDocument(t) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'document', saved); else delete globalThis.document; });
  globalThis.document = { documentElement: { dataset: { theme: 'light' } } };
  return theme => { document.documentElement.dataset.theme = theme; };
}
const color = rgb => ({ css: `#${rgb.toString(16).padStart(6, '0')}`, rgba: (rgb << 8 | 255) >>> 0 });
const white = 0xffffff, body = parseInt(lightTerminalTheme.foreground.slice(1), 16);

test('DIM defaults, ANSI greys and dark-terminal truecolour retain a secondary hierarchy at 4.5:1', () => {
  const secondary = terminalContrastColor(body, white, true);
  assert.ok(luminance(secondary.rgba >>> 8) > luminance(body), 'secondary ink stays lighter than body ink');
  assert.notEqual(secondary.css, '#000000');
  for (const fg of [body, 0x636b77, 0xb2c2d5, 0x808080, 0xdddddd, white]) {
    for (const dim of [false, true]) {
      const result = terminalContrastColor(fg, white, dim);
      assert.ok(contrast(result.rgba >>> 8, white) >= 4.5, `${result.css} must be readable on white`);
      assert.equal(result.rgba & 255, 255, 'the glyph must not be faded a second time');
      assert.equal(parseInt(result.css.slice(1), 16), result.rgba >>> 8);
    }
  }
  assert.equal(terminalContrastColor(body, white, false).css, lightTerminalTheme.foreground, 'normal body ink stays unchanged');
});

test('contrast follows explicit cell backgrounds, including inverse and coloured surfaces', () => {
  for (const bg of [0, 0x262626, 0x777777, 0xf4f4f4, 0xe9ebef, 0x176b35]) {
    for (const fg of [body, white, 0x888888, 0xff969e]) {
      const result = terminalContrastColor(fg, bg, true);
      assert.ok(contrast(result.rgba >>> 8, bg) >= 4.5, `${result.css} on ${bg.toString(16)}`);
    }
  }
});

test('DOM DIM ink uses the resolved background and overrides, and dark and normal text remain native', t => {
  const switchTheme = themeDocument(t), native = { called: 0 };
  class Rows {
    _applyMinimumContrast() { native.called++; return false; }
  }
  const rows = new Rows(), terminal = { _core: { _renderService: { _renderer: { value: { _rowFactory: rows } } } } };
  keepTerminalContrast(terminal); keepTerminalContrast(terminal);
  const element = { style: {} }, bg = color(white), fg = color(body), cell = { isDim: () => 1, getCode: () => 65 };
  assert.equal(rows._applyMinimumContrast(element, bg, fg, cell), true);
  assert.equal(element.style.color, terminalContrastColor(body, white, true).css);
  const overrideBg = color(0x262626), overrideFg = color(0xf2f2f2);
  rows._applyMinimumContrast(element, bg, fg, cell, overrideBg, overrideFg);
  assert.equal(element.style.color, terminalContrastColor(0xf2f2f2, 0x262626, true).css);
  assert.equal(rows._applyMinimumContrast(element, bg, fg, { ...cell, isDim: () => 0 }), false);
  assert.equal(rows._applyMinimumContrast(element, bg, fg, { ...cell, getCode: () => 0x2514 }), false);
  assert.equal(rows._applyMinimumContrast(element, bg, fg, { ...cell, getCode: () => 0xe0b0 }), false);
  switchTheme('mono'); assert.equal(rows._applyMinimumContrast(element, bg, fg, cell), false);
  assert.equal(native.called, 4);
});

test('GPU DIM ink is opaque and readable through atlas replacement; dark and excluded glyphs stay native', t => {
  const switchTheme = themeDocument(t), native = color(0x123456), calls = [];
  class Atlas {
    _getForegroundColor(...args) { calls.push(args); return native; }
    _resolveBackgroundRgba(mode, value, inverse) { return color(inverse ? body : (value || white)).rgba; }
    _resolveForegroundRgba(mode, value, inverse, bold) { return color(inverse ? white : (value || (bold ? 0x636b77 : body))).rgba; }
  }
  class Renderer {
    _refreshCharAtlas() { this._charAtlas = new Atlas(); }
  }
  const renderer = new Renderer(), terminal = { _core: { _renderService: { _renderer: { value: renderer } } } };
  keepTerminalContrast(terminal); keepTerminalContrast(terminal);
  const args = [0, 0, 0, 0, 0, 0, false, true, false, false];
  renderer._refreshCharAtlas();
  const first = renderer._charAtlas;
  assert.deepEqual(first._getForegroundColor(...args), terminalContrastColor(body, white, true));
  const inverse = [...args]; inverse[6] = true;
  assert.deepEqual(first._getForegroundColor(...inverse), terminalContrastColor(white, body, true));
  const truecolor = [...args]; truecolor[5] = 0xb2c2d5;
  assert.ok(contrast(first._getForegroundColor(...truecolor).rgba >>> 8, white) >= 4.5);
  renderer._refreshCharAtlas(); assert.notEqual(renderer._charAtlas, first);
  assert.deepEqual(renderer._charAtlas._getForegroundColor(...args), terminalContrastColor(body, white, true));
  const ordinary = [...args]; ordinary[7] = false;
  assert.equal(first._getForegroundColor(...ordinary), native);
  const excluded = [...args]; excluded[9] = true;
  assert.equal(first._getForegroundColor(...excluded), native);
  switchTheme('mono'); assert.equal(first._getForegroundColor(...args), native);
  assert.deepEqual(calls, [ordinary, excluded, args], 'native rendering receives the original attributes');
  switchTheme('light'); assert.deepEqual(first._getForegroundColor(...args), terminalContrastColor(body, white, true));
});

test('contrast adapters ignore unopened terminals and unsupported renderer internals', () => {
  keepTerminalContrast({});
  for (const renderer of [{}, { _rowFactory: {} }, { _charAtlas: { _getForegroundColor() {} } }]) {
    const keys = Object.keys(renderer);
    keepTerminalContrast({ _core: { _renderService: { _renderer: { value: renderer } } } });
    assert.deepEqual(Object.keys(renderer), keys);
  }
});
