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
const darkCli = [white, 0x999999, 0x4eba65, 0xb1b9f9];

function oklch(rgb) {
  const [r, g, b] = [rgb >>> 16 & 255, rgb >>> 8 & 255, rgb & 255].map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, c: Math.hypot(a, bb), h: Math.atan2(bb, a) * 180 / Math.PI };
}

test('dark-CLI truecolour on white preserves primary, secondary and chromatic hierarchy', () => {
  const primary = terminalContrastColor(white, white, false).rgba >>> 8;
  const secondary = terminalContrastColor(0x999999, white, false).rgba >>> 8;
  assert.ok(contrast(primary, white) >= 12, 'white CLI body text becomes strong body ink');
  assert.ok(Math.abs(oklch(primary).l - oklch(body).l) < 0.01, 'body lightness follows the light theme');
  assert.ok(contrast(secondary, white) >= 4.5 && contrast(secondary, white) < contrast(primary, white));
  assert.ok(luminance(secondary) > luminance(primary), 'secondary text stays lighter than body text');
  let previous = -1;
  for (const fg of [white, 0xeeeeee, 0xdddddd, 0xbbbbbb, 0x999999]) {
    const result = terminalContrastColor(fg, white, false).rgba >>> 8;
    assert.ok(luminance(result) > previous, 'a greyscale ramp must retain its ordering');
    previous = luminance(result);
  }
  for (const fg of [0x4eba65, 0xb1b9f9, 0x00ff00, 0xffff00, 0x00ffff, 0xff00ff]) {
    const result = terminalContrastColor(fg, white, false).rgba >>> 8;
    const original = oklch(fg), mapped = oklch(result);
    const difference = Math.abs(original.h - mapped.h);
    assert.ok(Math.min(difference, 360 - difference) < 3, `${fg.toString(16)} retains its OKLCH hue`);
    assert.ok(mapped.c > 0.02, 'gamut reduction must not erase the semantic colour');
    assert.ok(contrast(result, white) >= 4.5);
  }
});

test('reflection follows the actual background and leaves the light ANSI palette and dark surfaces alone', () => {
  for (const name of ['foreground', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']) {
    const fg = parseInt(lightTerminalTheme[name].slice(1), 16);
    for (const bg of [white, 0xf4f4f4]) assert.equal(terminalContrastColor(fg, bg, false).css, lightTerminalTheme[name], name);
  }
  for (const bg of [0, 0x24272d, 0x262626, 0x5f5f5f]) {
    assert.equal(terminalContrastColor(white, bg, false).rgba >>> 8, white, 'white on a dark cell is not reflected');
  }
  for (const bg of [0xf4f4f4, 0xe9ebef, 0xc5dce8]) {
    const primary = terminalContrastColor(white, bg, false).rgba >>> 8;
    assert.ok(Math.abs(oklch(primary).l - oklch(body).l) < 0.01, 'ink brighter than the ground clamps to body lightness');
    for (const fg of darkCli) assert.ok(contrast(terminalContrastColor(fg, bg, false).rgba >>> 8, bg) >= 4.5);
  }
});

test('DIM follows reflection and keeps corrected dark-CLI ink opaque and secondary', () => {
  const primary = terminalContrastColor(white, white, false).rgba >>> 8;
  for (const fg of darkCli) {
    const dim = terminalContrastColor(fg, white, true);
    assert.equal(dim.rgba & 255, 255);
    assert.ok(contrast(dim.rgba >>> 8, white) >= 4.5);
    assert.ok(luminance(dim.rgba >>> 8) > luminance(primary));
  }
});

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

test('DOM normal truecolour is reflected only when needed, using foreground and background overrides', t => {
  themeDocument(t);
  const calls = [];
  class Rows {
    _applyMinimumContrast(...args) { calls.push({ receiver: this, args }); return false; }
  }
  const rows = new Rows();
  keepTerminalContrast({ _core: { _renderService: { _renderer: { value: { _rowFactory: rows } } } } });
  const bg = color(white), fg = color(body), cell = { isDim: () => 0, getCode: () => 65 };
  for (const foreground of darkCli) {
    const element = { style: {} };
    assert.equal(rows._applyMinimumContrast(element, bg, color(foreground), cell), true);
    assert.equal(element.style.color, terminalContrastColor(foreground, white, false).css);
  }
  const element = { style: {} };
  assert.equal(rows._applyMinimumContrast(element, color(0x262626), fg, cell, bg, color(0x4eba65)), true);
  assert.equal(element.style.color, terminalContrastColor(0x4eba65, white, false).css);
  const untouched = [
    [{ style: {} }, bg, fg, cell],
    [{ style: {} }, bg, color(0x636b77), cell],
    [{ style: {} }, color(0x262626), color(white), cell],
    [{ style: {} }, bg, color(white), cell, color(0x262626), color(white)],
    [{ style: {} }, bg, color(white), cell, undefined, color(body)],
    ...[0x2500, 0x259f, 0xe0a4, 0xe0d6].map(code => [{ style: {} }, bg, color(white), { ...cell, getCode: () => code }]),
  ];
  for (const args of untouched) {
    assert.equal(rows._applyMinimumContrast(...args), false);
    assert.deepEqual(args[0].style, {}, 'native cells receive no adapter style');
    assert.equal(calls.at(-1).receiver, rows);
    assert.deepEqual(calls.at(-1).args, [...args, ...Array(6 - args.length).fill(undefined)]);
  }
  assert.equal(calls.length, untouched.length);
});

test('DOM and refreshed atlas agree for regular and DIM ink, actual surfaces, inverse and bold', t => {
  themeDocument(t);
  const rgbMode = 0x3000000;
  class Rows { _applyMinimumContrast() { return false; } }
  class Atlas {
    _getForegroundColor() { return color(0x123456); }
    _resolveBackgroundRgba(mode, value, inverse) { return color(mode === rgbMode ? value : inverse ? body : white).rgba; }
    _resolveForegroundRgba(mode, value, inverse, bold) { return color(mode === rgbMode ? value : inverse ? white : bold ? 0x636b77 : body).rgba; }
  }
  class Renderer { _refreshCharAtlas() { this._charAtlas = new Atlas(); } }
  const rows = new Rows(), renderer = new Renderer(); renderer._rowFactory = rows;
  keepTerminalContrast({ _core: { _renderService: { _renderer: { value: renderer } } } });
  renderer._refreshCharAtlas();
  const first = renderer._charAtlas;
  const cases = darkCli.flatMap(fg => [false, true].flatMap(dim => [white, 0xf4f4f4].map(bg =>
    [bg, rgbMode, bg, fg, rgbMode, fg, false, dim, false, false])));
  cases.push([0, 0, 0, 0, 0, 0, false, true, false, false],
    [0, 0, 0, 0, 0, 0, true, true, false, false], [0, 0, 0, 0, 0, 0, false, true, true, false]);
  for (const args of cases) {
    const [, bgMode, bgValue, , fgMode, fgValue, inverse, dim, bold] = args;
    const bg = color(first._resolveBackgroundRgba(bgMode, bgValue, inverse) >>> 8);
    const fg = color(first._resolveForegroundRgba(fgMode, fgValue, inverse, bold) >>> 8);
    const element = { style: {} }, cell = { isDim: () => Number(dim), getCode: () => 65 };
    assert.equal(rows._applyMinimumContrast(element, bg, fg, cell), true);
    assert.equal(first._getForegroundColor(...args).css, element.style.color);
    assert.equal(first._getForegroundColor(...args).rgba & 255, 255);
  }
  const preserved = [0x262626, rgbMode, 0x262626, white, rgbMode, white, false, false, false, false];
  assert.equal(first._getForegroundColor(...preserved).css, '#123456', 'dark cell backgrounds keep native white ink');
  const excluded = [...cases[0]]; excluded[9] = true;
  assert.equal(first._getForegroundColor(...excluded).css, '#123456');
  renderer._refreshCharAtlas();
  assert.notEqual(renderer._charAtlas, first);
  assert.deepEqual(renderer._charAtlas._getForegroundColor(...cases[0]), first._getForegroundColor(...cases[0]));
});

test('dark themes forward all colours and attributes unchanged without resolving adapter colours', t => {
  const switchTheme = themeDocument(t), domCalls = [], atlasCalls = [], native = color(0x123456);
  class Rows { _applyMinimumContrast(...args) { domCalls.push(args); return false; } }
  class Atlas {
    _getForegroundColor(...args) { atlasCalls.push(args); return native; }
    _resolveBackgroundRgba() { assert.fail('dark backgrounds must not enter the adapter'); }
    _resolveForegroundRgba() { assert.fail('dark foregrounds must not enter the adapter'); }
  }
  const rows = new Rows(), atlas = new Atlas();
  keepTerminalContrast({ _core: { _renderService: { _renderer: { value: { _rowFactory: rows, _charAtlas: atlas } } } } });
  switchTheme('mono');
  for (const fg of [...darkCli, body, 0x636b77, 0x176b35]) for (const dim of [false, true]) for (const bg of [0x262626, white]) {
    const element = { style: {} }, cell = { isDim: () => Number(dim), getCode: () => 65 };
    const args = [element, color(bg), color(fg), cell, color(bg), color(fg)];
    assert.equal(rows._applyMinimumContrast(...args), false);
    assert.deepEqual(element.style, {});
    assert.deepEqual(domCalls.at(-1), args);
    const glyph = [bg, 0x3000000, bg, fg, 0x3000000, fg, true, dim, true, false];
    assert.equal(atlas._getForegroundColor(...glyph), native);
    assert.deepEqual(atlasCalls.at(-1), glyph);
  }
});

test('the shared colour cache separates DIM and backgrounds and evicts after 256 distinct pairs', () => {
  const first = terminalContrastColor(white, white, false);
  assert.equal(terminalContrastColor(white, white, false), first, 'repeated colours share the cached result');
  assert.notEqual(terminalContrastColor(white, white, true).css, first.css, 'DIM has its own cache key');
  assert.notEqual(terminalContrastColor(white, 0x262626, false).css, first.css, 'the actual background has its own key');
  for (let fg = 1; fg <= 256; fg++) terminalContrastColor(fg, 0xddeeff, false);
  const renewed = terminalContrastColor(white, white, false);
  assert.notEqual(renewed, first, 'a truecolour stream cannot grow the cache indefinitely');
  assert.deepEqual(renewed, first, 'eviction never changes the resolved colour');
});

test('contrast adapters ignore unopened terminals and unsupported renderer internals', () => {
  keepTerminalContrast({});
  class UnknownAtlas { _getForegroundColor() {} _resolveForegroundRgba() {} }
  const atlas = new UnknownAtlas(), draw = atlas._getForegroundColor;
  for (const renderer of [{}, { _rowFactory: {} }, { _charAtlas: { _getForegroundColor() {} } }, { _charAtlas: atlas }]) {
    const keys = Object.keys(renderer);
    keepTerminalContrast({ _core: { _renderService: { _renderer: { value: renderer } } } });
    assert.deepEqual(Object.keys(renderer), keys);
  }
  assert.equal(atlas._getForegroundColor, draw, 'an atlas missing the known background resolver stays untouched');
});
