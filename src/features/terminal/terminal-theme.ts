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

const channels = (rgb: number) => [rgb >>> 16 & 255, rgb >>> 8 & 255, rgb & 255];
const linear = (channel: number) => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
const luminance = (rgb: number[]) => rgb.reduce((sum, channel, index) => sum + linear(channel) * [0.2126, 0.7152, 0.0722][index], 0);

function oklab(rgb: number[]) {
  const [r, g, b] = rgb.map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function oklabRgb(lightness: number, a: number, b: number) {
  const mix = (chroma: number) => {
    const l = (lightness + (0.3963377774 * a + 0.2158037573 * b) * chroma) ** 3;
    const m = (lightness - (0.1055613458 * a + 0.0638541728 * b) * chroma) ** 3;
    const s = (lightness - (0.0894841775 * a + 1.291485548 * b) * chroma) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  };
  const inGamut = (rgb: number[]) => rgb.every(channel => channel >= -1e-7 && channel <= 1 + 1e-7);
  let rgb = mix(1);
  if (!inGamut(rgb)) {
    // Reduce chroma along the same OKLCH hue instead of clipping individual RGB channels.
    let low = 0, high = 1;
    for (let step = 0; step < 12; step++) {
      const middle = (low + high) / 2;
      if (inGamut(mix(middle))) low = middle;
      else high = middle;
    }
    rgb = mix(low);
  }
  return rgb.map(channel => {
    const value = Math.max(0, Math.min(1, channel));
    return Math.round((value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055) * 255);
  });
}

const lightInkLightness = oklab(channels(parseInt(lightTerminalTheme.foreground!.slice(1), 16)))[0];
const contrastColors = new Map<string, { css: string; rgba: number; reflected: boolean }>();

// Called only by the light-theme adapters. Reflect dark-CLI ink before DIM compositing, preserving
// its hue and hierarchy. The reflected flag lets ordinary non-DIM cells keep xterm's native handling.
// Both renderers use the same opaque result so DIM never fades the corrected ink a second time.
export function terminalContrastColor(foreground: number, background: number, dim: boolean) {
  const key = `${foreground}:${background}:${dim ? 1 : 0}`;
  const cached = contrastColors.get(key);
  if (cached) return cached;
  const ground = channels(background), original = channels(foreground);
  const [lightness, a, b] = oklab(original), backgroundLightness = oklab(ground)[0];
  const midpoint = (backgroundLightness + lightInkLightness) / 2;
  const reflected = backgroundLightness > 0.5 && lightness > midpoint;
  // The specified interval reflection simplifies to L_bg + L_fg - L. Brighter-than-background
  // ink is clamped at body lightness, including white text on an off-white cell background.
  const mapped = reflected ? oklabRgb(Math.max(lightInkLightness, backgroundLightness + lightInkLightness - lightness), a, b) : original;
  const ink = mapped.map((channel, index) => dim ? Math.round((channel + ground[index]) / 2) : channel);
  const bg = luminance(ground);
  const contrast = (rgb: number[]) => { const fg = luminance(rgb); return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05); };
  let resolved = ink;
  if (contrast(ink) < terminalOptions.minimumContrastRatio) {
    const [l, aa, bb] = oklab(ink);
    const target = (bg + 0.05) / 0.05 >= 1.05 / (bg + 0.05) ? 0 : 1;
    const mix = (amount: number) => oklabRgb(l + (target - l) * amount, aa, bb);
    let low = 0, high = 1;
    resolved = mix(high);
    for (let step = 0; step < 12; step++) {
      const middle = (low + high) / 2, next = mix(middle);
      if (contrast(next) < terminalOptions.minimumContrastRatio) low = middle;
      else { high = middle; resolved = next; }
    }
  }
  const rgb = resolved[0] << 16 | resolved[1] << 8 | resolved[2];
  const result = { css: `#${rgb.toString(16).padStart(6, '0')}`, rgba: (rgb << 8 | 255) >>> 0, reflected };
  // Share a bounded cache across DOM and atlas, including DIM in the key.
  if (contrastColors.size >= 256) contrastColors.clear();
  contrastColors.set(key, result);
  return result;
}

export function terminalDecorationColors() {
  return currentTheme() === 'light' ? { bullet: '#636b77', heading: '#24272d' } : { bullet: '#b5b5b5', heading: '#f2f2f2' };
}
