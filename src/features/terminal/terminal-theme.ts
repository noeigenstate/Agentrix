import type { ITheme } from '@xterm/xterm';
import { currentTheme } from '../../shared/themes.ts';

export const darkTerminalTheme: ITheme = {
  background: '#00000000', foreground: '#f2f2f2', cursor: '#f2f2f2',
  selectionBackground: '#383838', black: '#252a34', red: '#ff969e',
  green: '#a2ddb8', yellow: '#f2d596', blue: '#a1caff', magenta: '#d0b6f7',
  cyan: '#a0e0e8', white: '#e7eff9', brightBlack: '#b2c2d5', brightRed: '#ffacb2',
  brightGreen: '#a1d8b7', brightYellow: '#f0d297', brightBlue: '#a0caff',
  brightMagenta: '#d0baf2', brightCyan: '#a2e1e7', brightWhite: '#f2f5fa',
  scrollbarSliderBackground: '#40404088', scrollbarSliderHoverBackground: '#59595988', scrollbarSliderActiveBackground: '#595959cc',
};

export const lightTerminalTheme: ITheme = {
  // Transparent white keeps xterm's contrast correction anchored to the light card's RGB.
  background: '#ffffff00', foreground: '#20242a', cursor: '#20242a',
  selectionBackground: '#e9ebef', black: '#20242a', red: '#a12622',
  green: '#176b35', yellow: '#805900', blue: '#1b57a6', magenta: '#843a9c',
  cyan: '#006b78', white: '#6e6e6e', brightBlack: '#636b77', brightRed: '#b02b2b',
  brightGreen: '#21733c', brightYellow: '#8a6200', brightBlue: '#2563b5',
  brightMagenta: '#9340a8', brightCyan: '#087484', brightWhite: '#636b77',
  scrollbarSliderBackground: '#e2e6eb88', scrollbarSliderHoverBackground: '#a8b7c988', scrollbarSliderActiveBackground: '#a8b7c9cc',
};

// The colours are the tokens' values (xterm takes literals, not CSS variables): text-1, selected, and the border and hover border for the scrollbar. The background stays clear: the card's own
// body shows through (the app colour in focus mode). Regular and bold text share one contrast floor, which xterm applies against that ground.
export const terminalOptions = { fontWeight: '400', fontWeightBold: '700', minimumContrastRatio: 4.5 } as const;

export function terminalTheme(): ITheme {
  return { ...(currentTheme() === 'light' ? lightTerminalTheme : darkTerminalTheme) };
}

export function terminalDecorationColors() {
  return currentTheme() === 'light' ? { bullet: '#636b77', heading: '#20242a' } : { bullet: '#b5b5b5', heading: '#f2f2f2' };
}
