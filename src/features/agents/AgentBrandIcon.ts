import { createElement, useSyncExternalStore } from 'react';
import { currentTheme, subscribeTheme } from '../../shared/themes.ts';
import marks from '../../../assets/brands/official-marks.json' with { type: 'json' };
import { adapterOf } from '../../../electron/features/cli-adapters/registry.mjs';

// Official SVG paths, copied without redrawing. OpenAI and Claude source attribution lives with the assets.
// Keep this JSX-free so the source-only reading UI tests can import it through Node's TypeScript support.
type BrandIconProps = { size?: number };

export function CodexLogo({ size = 16 }: BrandIconProps = {}) {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, currentTheme);
  return createElement('svg', {
    className: 'agent-brand-icon agent-brand-codex', width: size, height: size,
    viewBox: marks.openai.viewBox, preserveAspectRatio: 'xMidYMid meet',
    // The reading node inherits secondary ink; retain the original white mark in mono.
    color: theme === 'light' ? '#24272d' : '#ffffff', fill: 'none', 'aria-hidden': true, focusable: false,
  }, createElement('path', { d: marks.openai.path, fill: 'currentColor' }));
}

export function ClaudeLogo({ size = 16 }: BrandIconProps = {}) {
  return createElement('svg', {
    className: 'agent-brand-icon agent-brand-claude', width: size, height: size,
    viewBox: marks.claude.viewBox, preserveAspectRatio: 'xMidYMid meet',
    fill: 'none', 'aria-hidden': true, focusable: false,
  }, createElement('path', { d: marks.claude.path, fill: marks.claude.fill }));
}

// Google Antigravity Press Assets: the One Color and White icons share this path.
// Google Antigravity and its logo are trademarks of Google.
const antigravityPath = 'M144.248 149.062C151.748 154.688 162.998 150.938 152.685 140.625C121.748 110.625 128.31 28.125 89.8727 28.125'
  + 'C51.4352 28.125 57.9977 110.625 27.0602 140.625C15.8102 151.875 27.9977 154.688 35.4977 149.062'
  + 'C64.5602 129.375 62.6852 94.6875 89.8727 94.6875C117.06 94.6875 115.185 129.375 144.248 149.062Z';

export function AntigravityLogo({ size = 16 }: BrandIconProps = {}) {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, currentTheme);
  return createElement('svg', {
    className: 'agent-brand-icon agent-brand-agy', width: size, height: size,
    viewBox: '0 0 180 180', preserveAspectRatio: 'xMidYMid meet',
    fill: theme === 'light' ? '#202124' : '#ffffff', 'aria-hidden': true, focusable: false,
  }, createElement('path', { d: antigravityPath }));
}

export const roleBrandIcons: Partial<Record<string, typeof AntigravityLogo>> = { agy: AntigravityLogo };
const marksByBrand = { anthropic: ClaudeLogo, openai: CodexLogo, antigravity: AntigravityLogo };
export const brandIconOf = (agent: string) => marksByBrand[adapterOf(agent)?.manifest.brand ?? 'openai'];
