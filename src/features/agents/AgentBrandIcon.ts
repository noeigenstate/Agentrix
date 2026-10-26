import { createElement, useSyncExternalStore } from 'react';
import { currentTheme, subscribeTheme } from '../../shared/themes.ts';
import marks from '../../../assets/brands/official-marks.json' with { type: 'json' };

// Official SVG paths, copied without redrawing. Sources and trademark attribution live with the assets.
// Keep this JSX-free so the source-only reading UI tests can import it through Node's TypeScript support.
type BrandIconProps = { size?: number };

export function CodexLogo({ size = 16 }: BrandIconProps = {}) {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, currentTheme);
  return createElement('svg', {
    className: 'agent-brand-icon agent-brand-codex', width: size, height: size,
    viewBox: marks.openai.viewBox, preserveAspectRatio: 'xMidYMid meet',
    // The reading node inherits secondary ink; retain the original white mark in mono.
    color: theme === 'light' ? '#181818' : '#ffffff', fill: 'none', 'aria-hidden': true, focusable: false,
  }, createElement('path', { d: marks.openai.path, fill: 'currentColor' }));
}

export function ClaudeLogo({ size = 16 }: BrandIconProps = {}) {
  return createElement('svg', {
    className: 'agent-brand-icon agent-brand-claude', width: size, height: size,
    viewBox: marks.claude.viewBox, preserveAspectRatio: 'xMidYMid meet',
    fill: 'none', 'aria-hidden': true, focusable: false,
  }, createElement('path', { d: marks.claude.path, fill: marks.claude.fill }));
}
