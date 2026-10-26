const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalTheme, terminalOptions, terminalDecorationColors } = require('../src/features/terminal/terminal-theme.ts');

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
