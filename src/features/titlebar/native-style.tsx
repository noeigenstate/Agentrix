import { useEffect, useState, type ComponentType } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { CirclesFour, Stamp } from '@phosphor-icons/react';
import type { TitlebarStyle, TitlebarView } from '../../shared/types';
import { subscribeTheme } from '../../shared/themes';

// The look of the native 决策 / 工作台 buttons (macOS), read from what the page itself draws: the real .home-nav rules and the theme tokens, so the
// native drawing cannot drift from the CSS. The icons are the page's Phosphor icons as template masks: only their alpha is used, the native side tints them.
const MASK_COLOR = 'white';
// The nav's icon size in CSS px, for the page's own icons and the native ones alike.
export const NAV_ICON_SIZE = 16;
const ICONS: Record<TitlebarView, ComponentType<{ size: number }>> = { decisions: Stamp, workspace: CirclesFour };
const TOKENS = { text: '--text-2', textSelected: '--text-1', hover: '--bg-hover', selected: '--bg-selected', badge: '--button-primary', badgeText: '--button-primary-text', focus: '--focus-ring' };

// A computed colour as '#rrggbb', or '#rrggbbaa' when it is not opaque. Chromium gives rgb()/rgba(), or color(srgb …) for mixed colours.
export function colorHex(color: string) {
  const [r, g, b, a = 1] = (color.match(/\d*\.?\d+/g) ?? []).map(Number);
  if (b === undefined) throw new Error(`Unreadable colour: ${color}`);
  const unit = color.startsWith('color(') ? 255 : 1;
  const byte = (value: number) => Math.round(Math.min(Math.max(value * unit, 0), 255)).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? Math.round(a * 255).toString(16).padStart(2, '0') : ''}`;
}

// The page is zoomed with the web contents' zoom factor, which Chromium's devicePixelRatio already includes: the glyph's device pixels need no scale of their own.
export const iconPixels = (pixelRatio: number) => Math.round(NAV_ICON_SIZE * pixelRatio);

type Computed = Pick<CSSStyleDeclaration, 'height' | 'paddingLeft' | 'columnGap' | 'borderTopLeftRadius' | 'fontFamily' | 'fontSize' | 'fontWeight' | 'minWidth' | 'lineHeight'>;
type Measured = { scale: number; bar: Computed; nav: Computed; button: Computed; badge: Computed; colors: TitlebarStyle['colors']; focus: { width: number; offset: number }; icons: TitlebarStyle['icons'] };

export function styleFrom({ scale, bar, nav, button, badge, colors, focus, icons }: Measured): TitlebarStyle {
  return {
    scale, font: { size: parseFloat(button.fontSize), weight: Number(button.fontWeight), family: button.fontFamily },
    metrics: {
      height: parseFloat(button.height), paddingX: parseFloat(button.paddingLeft), gap: parseFloat(button.columnGap), itemGap: parseFloat(nav.columnGap),
      radius: parseFloat(button.borderTopLeftRadius), iconSize: NAV_ICON_SIZE, focusWidth: focus.width, focusOffset: focus.offset, barHeight: parseFloat(bar.height),
      badge: { minWidth: parseFloat(badge.minWidth), paddingX: parseFloat(badge.paddingLeft), height: parseFloat(badge.lineHeight), fontSize: parseFloat(badge.fontSize), fontWeight: Number(badge.fontWeight) },
    },
    colors, icons,
  };
}

// The focus ring's width and offset, from the real :focus-visible rule (a probe cannot be made keyboard-focused). The width sits in an `outline` shorthand with a var(), which CSSOM does not split.
function focusRing() {
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; } // a cross-origin sheet cannot be read, and must not hide the page's own
    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule) || !rule.selectorText.includes('.home-nav') || !rule.selectorText.includes(':focus-visible')) continue;
      const width = /(\d*\.?\d+)px/.exec(rule.style.getPropertyValue('outline'))?.[1], offset = parseFloat(rule.style.getPropertyValue('outline-offset'));
      if (width && !Number.isNaN(offset)) return { width: Number(width), offset };
    }
  }
  throw new Error('The .home-nav focus ring rule was not found');
}

// A glyph as a transparent PNG with a solid mask, drawn at the pixels it will cover on screen.
async function iconPng(Icon: ComponentType<{ size: number }>, pixels: number) {
  const host = document.createElement('div'), root = createRoot(host);
  flushSync(() => root.render(<Icon size={NAV_ICON_SIZE} />));
  const svg = host.firstElementChild;
  root.unmount();
  if (!svg) throw new Error('The icon did not render');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`;
  await image.decode();
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d')!;
  canvas.width = canvas.height = pixels;
  context.drawImage(image, 0, 0, pixels, pixels);
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = MASK_COLOR;
  context.fillRect(0, 0, pixels, pixels);
  return canvas.toDataURL('image/png');
}

async function measure(scale: number): Promise<TitlebarStyle> {
  // Off-screen copies of the nav and the title bar: the rules apply to them as to the real ones; the native buttons replace the nav and centre in the bar.
  const host = document.createElement('div');
  host.style.cssText = 'position: fixed; left: -9999px; top: 0; visibility: hidden; pointer-events: none';
  host.innerHTML = '<nav class="home-nav"><button type="button">x<span class="home-nav-count">1</span></button></nav><div class="titlebar"></div>';
  document.body.append(host);
  try {
    const bar = getComputedStyle(host.querySelector('.titlebar')!), nav = getComputedStyle(host.firstElementChild!), button = getComputedStyle(host.querySelector('button')!), badge = getComputedStyle(host.querySelector('.home-nav-count')!);
    const colors = Object.fromEntries(Object.entries(TOKENS).map(([name, token]) => {
      host.style.color = `var(${token})`;
      return [name, colorHex(getComputedStyle(host).color)];
    })) as TitlebarStyle['colors'];
    const pixels = iconPixels(devicePixelRatio);
    // Called from an effect, React cannot flush the icons' own render until its commit is over.
    await new Promise(resolve => setTimeout(resolve));
    const icons = Object.fromEntries(await Promise.all(Object.entries(ICONS).map(async ([view, Icon]) => [view, await iconPng(Icon, pixels)]))) as TitlebarStyle['icons'];
    return styleFrom({ scale, bar, nav, button, badge, colors, focus: focusRing(), icons });
  } finally {
    host.remove();
  }
}

// Re-fires when the screen's pixel ratio changes (a window moved to another display); the query is bound to one ratio, so it is armed again each time.
function watchPixelRatio(onChange: () => void) {
  let query: MediaQueryList;
  const changed = () => { onChange(); arm(); };
  const arm = () => { query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`); query.addEventListener('change', changed, { once: true }); };
  arm();
  return () => query.removeEventListener('change', changed);
}

// The style for the native buttons, rebuilt when the theme, the interface zoom or the screen's pixel ratio changes; the same object while nothing differs.
// null until the first measure succeeds; a failed one (the page's own rules cannot be read, an icon does not render) leaves the last good style in place and sends nothing new,
// so the native buttons keep that look, or their system look if there never was one.
export function useNativeTitlebarStyle(enabled: boolean, uiZoom: number | undefined) {
  const [style, setStyle] = useState<TitlebarStyle | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => setRevision(value => value + 1);
    const stopTheme = subscribeTheme(refresh), stopRatio = watchPixelRatio(refresh);
    return () => { stopTheme(); stopRatio(); };
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !uiZoom) return;
    let current = true;
    measure(uiZoom / 100).then(next => {
      if (current) setStyle(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    }, () => {});
    return () => { current = false; };
  }, [enabled, uiZoom, revision]);
  return style;
}
