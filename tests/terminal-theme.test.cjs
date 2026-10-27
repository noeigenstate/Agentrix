const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalTheme, terminalOptions, terminalColorReply, terminalDecorationColors } = require('../src/features/terminal/terminal-theme.ts');
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
  assert.equal(theme.foreground, '#24272d'); assert.equal(theme.cursor, '#24272d');
  assert.equal(theme.selectionBackground, '#e9ebef');
  assert.deepEqual([theme.scrollbarSliderBackground, theme.scrollbarSliderHoverBackground, theme.scrollbarSliderActiveBackground], ['#e4e7eb88', '#a8b7c988', '#a8b7c9cc']);
  assert.equal(theme.white, '#6e6e6e'); assert.equal(theme.brightWhite, '#636b77');
  assert.deepEqual(terminalDecorationColors(), { bullet: '#636b77', heading: '#24272d' });
  for (const name of ansi) {
    const ratio = (luminance('#f7f8fa') + 0.05) / (luminance(theme[name]) + 0.05);
    assert.ok(ratio >= 4.5, `${name} ${theme[name]}: ${ratio.toFixed(2)}:1`);
  }
  theme.red = '#ffffff'; assert.notEqual(terminalTheme().red, theme.red);
  switchTheme('mono'); assert.equal(terminalTheme().background, '#00000000');
});

test('default-colour replies report the palette RGB with opaque 16-bit channels in either theme', t => {
  const switchTheme = themeDocument(t);
  assert.equal(terminalColorReply(10), '\x1b]10;rgb:f2f2/f2f2/f2f2\x1b\\');
  assert.equal(terminalColorReply(11), '\x1b]11;rgb:0000/0000/0000\x1b\\');
  switchTheme('light');
  assert.equal(terminalColorReply(10), '\x1b]10;rgb:2424/2727/2d2d\x1b\\');
  assert.equal(terminalColorReply(11), '\x1b]11;rgb:ffff/ffff/ffff\x1b\\');
  assert.equal(terminalTheme().background, '#ffffff00', 'reporting white never makes the canvas opaque');
});

test('open terminals and existing decorations switch themes without output or recreation, then unsubscribe', async t => {
  const switchTheme = themeDocument(t), decorations = [], markers = [], events = [];
  const handlers = new Map(), replies = [];
  const lines = ['', 'Heading', '• item'].map((text, row) => ({
    isWrapped: false, translateToString: () => text,
    getCell: col => ({ getWidth: () => 1, getChars: () => text[col] || '', isBold: () => row === 1, isFgDefault: () => true }),
  }));
  const buffer = { type: 'normal', viewportY: 0, baseY: 0, cursorY: 0, getNullCell: () => ({}), getLine: row => lines[row] };
  const subscribe = () => { const event = { dispose() { this.disposed = true; } }; events.push(event); return event; };
  const terminal = {
    options: { theme: terminalTheme(), fontSize: 12 }, rows: 3, cols: 12, buffer: { active: buffer },
    onWriteParsed: subscribe, onScroll: subscribe, onResize: subscribe,
    parser: { registerOscHandler(slot, handler) { handlers.set(slot, handler); return { dispose() { handlers.delete(slot); } }; } },
    input(data, userInput) { replies.push({ data, userInput }); },
    registerMarker() { const marker = { isDisposed: false, dispose() { this.isDisposed = true; } }; markers.push(marker); return marker; },
    registerDecoration(options) { const decoration = { ...options, dispose() { this.disposed = true; } }; decorations.push(decoration); return decoration; },
  };
  const styling = styleTerminal(terminal); t.after(() => styling.dispose());
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.deepEqual(decorations.map(item => item.foregroundColor), ['#f2f2f2', '#b5b5b5']);
  assert.equal(handlers.get(11)('?'), false, 'dark queries retain xterm behaviour');
  switchTheme('light');
  assert.equal(terminal.options.theme.foreground, '#24272d');
  assert.deepEqual(decorations.slice(-2).map(item => item.foregroundColor), ['#24272d', '#636b77']);
  assert.ok(decorations.slice(0, 2).every(item => item.disposed));
  assert.equal(handlers.get(10)('?'), true); assert.equal(handlers.get(11)('?'), true);
  assert.deepEqual(replies, [{ data: terminalColorReply(10), userInput: false }, { data: terminalColorReply(11), userInput: false }]);
  for (const payload of ['#123456', 'rgb:ffff/ffff/ffff', '', '?;?']) assert.equal(handlers.get(10)(payload), false, 'other OSC commands keep xterm handling');
  switchTheme('mono');
  assert.equal(terminal.options.theme.foreground, '#f2f2f2');
  assert.deepEqual(decorations.slice(-2).map(item => item.foregroundColor), ['#f2f2f2', '#b5b5b5']);
  assert.equal(terminal.buffer.active, buffer); assert.equal(terminal.options.fontSize, 12);
  assert.equal(handlers.get(10)('?'), false); assert.equal(handlers.get(11)('?'), false);
  assert.equal(replies.length, 2, 'switching themes never sends unsolicited input');
  styling.dispose();
  const lastTheme = terminal.options.theme, count = decorations.length;
  switchTheme('light');
  assert.equal(terminal.options.theme, lastTheme); assert.equal(decorations.length, count);
  assert.ok(markers.every(marker => marker.isDisposed)); assert.ok(events.every(event => event.disposed));
  assert.equal(handlers.size, 0, 'colour handlers are disposed with the terminal');
});
