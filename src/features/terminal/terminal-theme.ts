import type { ITheme } from '@xterm/xterm';

export const darkTerminalTheme: ITheme = {
  background: '#00000000', foreground: '#f2f2f2', cursor: '#f2f2f2',
  selectionBackground: '#383838', black: '#252a34', red: '#ff969e',
  green: '#a2ddb8', yellow: '#f2d596', blue: '#a1caff', magenta: '#d0b6f7',
  cyan: '#a0e0e8', white: '#e7eff9', brightBlack: '#b2c2d5', brightRed: '#ffacb2',
  brightGreen: '#a1d8b7', brightYellow: '#f0d297', brightBlue: '#a0caff',
  brightMagenta: '#d0baf2', brightCyan: '#a2e1e7', brightWhite: '#f2f5fa',
  scrollbarSliderBackground: '#40404088', scrollbarSliderHoverBackground: '#59595988', scrollbarSliderActiveBackground: '#595959cc',
};

// The colours are the tokens' values (xterm takes literals, not CSS variables): text-1, selected, and the border and hover border for the scrollbar. The background stays clear: the card's own
// body shows through (the app colour in focus mode). Regular and bold text share one contrast floor, which xterm applies against that ground.
export const terminalOptions = { fontWeight: '400', fontWeightBold: '700', minimumContrastRatio: 4.5 } as const;

export function terminalTheme(): ITheme {
  return { ...darkTerminalTheme };
}

export function terminalDecorationColors() {
  return { bullet: '#b5b5b5', heading: '#f2f2f2' };
}
