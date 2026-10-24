const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalTheme, terminalOptions, terminalDecorationColors } = require('../src/features/terminal/terminal-theme.ts');

test('Catalina retains its transparent dark terminal palette and decorations', () => {
  assert.deepEqual(terminalTheme(), {
    background: '#00000000', foreground: '#ffffff', cursor: '#ffffff',
    selectionBackground: '#405770', black: '#252a34', red: '#ff969e',
    green: '#a2ddb8', yellow: '#f2d596', blue: '#a1caff', magenta: '#d0b6f7',
    cyan: '#a0e0e8', white: '#e7eff9', brightBlack: '#b2c2d5', brightRed: '#ffacb2',
    brightGreen: '#a1d8b7', brightYellow: '#f0d297', brightBlue: '#a0caff',
    brightMagenta: '#d0baf2', brightCyan: '#a2e1e7', brightWhite: '#f2f5fa',
    scrollbarSliderBackground: '#46536455', scrollbarSliderHoverBackground: '#64768c88', scrollbarSliderActiveBackground: '#7b8ea599',
  });
  assert.deepEqual(terminalDecorationColors(), { bullet: '#ff6b9a', heading: '#ff9fd5' });
  assert.deepEqual(terminalOptions, { fontWeight: '400', fontWeightBold: '700', minimumContrastRatio: 4.5 });
  // xterm may normalize options; callers must not share a mutable palette.
  const first = terminalTheme(); first.foreground = '#000000';
  assert.equal(terminalTheme().foreground, '#ffffff');
});
