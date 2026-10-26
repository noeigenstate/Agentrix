const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalTheme, terminalOptions, terminalDecorationColors } = require('../src/features/terminal/terminal-theme.ts');
const { applyTheme } = require('../src/shared/themes.ts');
const { styleTerminal } = require('../src/features/terminal/terminal-styling.ts');

function themeDocument(t) {
  const saved = ['document', 'window', 'MutationObserver'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const observers = [];
  globalThis.document = { documentElement: { dataset: {} } };
  globalThis.window = { setTimeout };
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(root, options) { assert.equal(root, document.documentElement); assert.deepEqual(options, { attributes: true, attributeFilter: ['data-theme'] }); }
    disconnect() { this.disconnected = true; }
  };
  return theme => {
    applyTheme(theme);
    for (const observer of observers) if (!observer.disconnected) observer.callback();
  };
}

test('The grey design keeps a clear terminal ground, grey default ink and the ANSI palette', () => {
  assert.deepEqual(terminalTheme(), {
    background: '#00000000', foreground: '#f2f2f2', cursor: '#f2f2f2',
    selectionBackground: '#383838', black: '#252a34', red: '#ff969e',
    green: '#a2ddb8', yellow: '#f2d596', blue: '#a1caff', magenta: '#d0b6f7',
    cyan: '#a0e0e8', white: '#e7eff9', brightBlack: '#b2c2d5', brightRed: '#ffacb2',
    brightGreen: '#a1d8b7', brightYellow: '#f0d297', brightBlue: '#a0caff',
    brightMagenta: '#d0baf2', brightCyan: '#a2e1e7', brightWhite: '#f2f5fa',
    scrollbarSliderBackground: '#40404088', scrollbarSliderHoverBackground: '#59595988', scrollbarSliderActiveBackground: '#595959cc',
  });
  assert.deepEqual(terminalDecorationColors(), { bullet: '#b5b5b5', heading: '#f2f2f2' });
  assert.deepEqual(terminalOptions, { fontWeight: '400', fontWeightBold: '700', minimumContrastRatio: 4.5 });
  // xterm may normalize options; callers must not share a mutable palette.
  const first = terminalTheme(); first.foreground = '#000000';
  assert.equal(terminalTheme().foreground, '#f2f2f2');
});

const ansi = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
function luminance(hex) {
  return hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

test('light terminals use transparent white for contrast correction and readable ANSI colours', t => {
  const switchTheme = themeDocument(t); switchTheme('light');
  const theme = terminalTheme();
  assert.equal(theme.background, '#ffffff00');
  assert.equal(theme.foreground, '#181818'); assert.equal(theme.cursor, '#181818');
  assert.equal(theme.selectionBackground, '#dedede');
  assert.deepEqual([theme.scrollbarSliderBackground, theme.scrollbarSliderHoverBackground, theme.scrollbarSliderActiveBackground], ['#d0d0d088', '#b0b0b088', '#b0b0b0cc']);
  assert.equal(theme.white, '#6e6e6e'); assert.equal(theme.brightWhite, '#5e5e5e');
  assert.deepEqual(terminalDecorationColors(), { bullet: '#5e5e5e', heading: '#181818' });
  for (const name of ansi) {
    const ratio = (luminance('#f5f5f5') + 0.05) / (luminance(theme[name]) + 0.05);
    assert.ok(ratio >= 4.5, `${name} ${theme[name]}: ${ratio.toFixed(2)}:1`);
  }
  theme.red = '#ffffff'; assert.notEqual(terminalTheme().red, theme.red);
  switchTheme('mono'); assert.equal(terminalTheme().background, '#00000000');
});

test('open terminals and existing decorations switch themes without output or recreation, then unsubscribe', async t => {
  const switchTheme = themeDocument(t), decorations = [], markers = [], events = [];
  const lines = ['', 'Heading', '• item'].map((text, row) => ({
    isWrapped: false, translateToString: () => text,
    getCell: col => ({ getWidth: () => 1, getChars: () => text[col] || '', isBold: () => row === 1, isFgDefault: () => true }),
  }));
  const buffer = { type: 'normal', viewportY: 0, baseY: 0, cursorY: 0, getNullCell: () => ({}), getLine: row => lines[row] };
  const subscribe = () => { const event = { dispose() { this.disposed = true; } }; events.push(event); return event; };
  const terminal = {
    options: { theme: terminalTheme(), fontSize: 12 }, rows: 3, cols: 12, buffer: { active: buffer },
    onWriteParsed: subscribe, onScroll: subscribe, onResize: subscribe,
    registerMarker() { const marker = { isDisposed: false, dispose() { this.isDisposed = true; } }; markers.push(marker); return marker; },
    registerDecoration(options) { const decoration = { ...options, dispose() { this.disposed = true; } }; decorations.push(decoration); return decoration; },
  };
  const styling = styleTerminal(terminal); t.after(() => styling.dispose());
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.deepEqual(decorations.map(item => item.foregroundColor), ['#f2f2f2', '#b5b5b5']);
  switchTheme('light');
  assert.equal(terminal.options.theme.foreground, '#181818');
  assert.deepEqual(decorations.slice(-2).map(item => item.foregroundColor), ['#181818', '#5e5e5e']);
  assert.ok(decorations.slice(0, 2).every(item => item.disposed));
  switchTheme('mono');
  assert.equal(terminal.options.theme.foreground, '#f2f2f2');
  assert.deepEqual(decorations.slice(-2).map(item => item.foregroundColor), ['#f2f2f2', '#b5b5b5']);
  assert.equal(terminal.buffer.active, buffer); assert.equal(terminal.options.fontSize, 12);
  styling.dispose();
  const lastTheme = terminal.options.theme, count = decorations.length;
  switchTheme('light');
  assert.equal(terminal.options.theme, lastTheme); assert.equal(decorations.length, count);
  assert.ok(markers.every(marker => marker.isDisposed)); assert.ok(events.every(event => event.disposed));
});
