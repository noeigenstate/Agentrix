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
  // xterm keeps the white RGB for OSC replies and contrast correction; only the canvas is clear.
  background: '#ffffff00', foreground: '#24272d', cursor: '#24272d',
  selectionBackground: '#e9ebef', black: '#24272d', red: '#a12622',
  green: '#176b35', yellow: '#805900', blue: '#1b57a6', magenta: '#843a9c',
  cyan: '#006b78', white: '#6e6e6e', brightBlack: '#636b77', brightRed: '#b02b2b',
  brightGreen: '#21733c', brightYellow: '#8a6200', brightBlue: '#2563b5',
  brightMagenta: '#9340a8', brightCyan: '#087484', brightWhite: '#636b77',
  scrollbarSliderBackground: '#e4e7eb88', scrollbarSliderHoverBackground: '#a8b7c988', scrollbarSliderActiveBackground: '#a8b7c9cc',
};

// The colours are the tokens' values (xterm takes literals, not CSS variables): text-1, selected, and the border and hover border for the scrollbar. The background stays clear: the card's own
// body shows through (the app colour in focus mode). Regular and bold text share one contrast floor, which xterm applies against that ground.
export const terminalOptions = { fontWeight: '400', fontWeightBold: '700', minimumContrastRatio: 4.5 } as const;

export function terminalTheme(): ITheme {
  return { ...(currentTheme() === 'light' ? lightTerminalTheme : darkTerminalTheme) };
}

// Default-colour queries describe the card behind the clear canvas, with 16 bits per channel and no alpha.
export function terminalColorReply(slot: 10 | 11): string {
  const theme = terminalTheme();
  const hex = (slot === 10 ? theme.foreground : theme.background)!.slice(1, 7);
  return `\x1b]${slot};rgb:${hex.match(/../g)!.map(channel => channel.repeat(2)).join('/')}\x1b\\`;
}

// xterm halves the contrast demand for DIM and may halve glyph alpha too. Resolve that ink over its
// actual background first, then adjust only as far as the common contrast floor needs. Keep it opaque
// so DOM text and GPU glyphs keep the same hierarchy without painting the terminal's background.
export function terminalContrastColor(foreground: number, background: number, dim: boolean) {
  const channels = (rgb: number) => [rgb >>> 16 & 255, rgb >>> 8 & 255, rgb & 255];
  const ground = channels(background), ink = channels(foreground).map((channel, index) => dim ? Math.round((channel + ground[index]) / 2) : channel);
  const luminance = (rgb: number[]) => rgb.reduce((sum, channel, index) => {
    const value = channel / 255;
    return sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index];
  }, 0);
  const bg = luminance(ground);
  const contrast = (rgb: number[]) => { const fg = luminance(rgb); return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05); };
  let resolved = ink;
  if (contrast(ink) < terminalOptions.minimumContrastRatio) {
    const target = (bg + 0.05) / 0.05 >= 1.05 / (bg + 0.05) ? 0 : 255;
    const mix = (amount: number) => ink.map(channel => Math.round(channel + (target - channel) * amount / 255));
    let low = 0, high = 255;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (contrast(mix(middle)) < terminalOptions.minimumContrastRatio) low = middle + 1;
      else high = middle;
    }
    resolved = mix(high);
  }
  const rgb = resolved[0] << 16 | resolved[1] << 8 | resolved[2];
  return { css: `#${rgb.toString(16).padStart(6, '0')}`, rgba: (rgb << 8 | 255) >>> 0 };
}

export function terminalDecorationColors() {
  return currentTheme() === 'light' ? { bullet: '#636b77', heading: '#24272d' } : { bullet: '#b5b5b5', heading: '#f2f2f2' };
}
