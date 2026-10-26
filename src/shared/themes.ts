// The app's themes. `mono` is the default and its tokens live on :root in styles/themes.css; a later theme
// overrides them under :root[data-theme="<id>"]. The swatch is the theme's own greys for its Settings preview,
// so it stays right whichever theme is active. electron/state.cjs lists the same ids when it sanitizes settings.
export const THEMES = [
  { id: 'mono', name: '黑底白字', description: '黑色底，白色文字，只用灰阶', swatch: { page: '#191919', pane: '#242424', line: '#404040', ink: '#f0f0f0' } },
] as const;

export type ThemeId = typeof THEMES[number]['id'];

export const DEFAULT_THEME: ThemeId = THEMES[0].id;

export function applyTheme(theme: ThemeId | undefined) { document.documentElement.dataset.theme = theme ?? DEFAULT_THEME; }
