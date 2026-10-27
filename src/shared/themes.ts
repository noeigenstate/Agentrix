// The app's themes. `mono` is the default and its tokens live on :root in styles/themes.css; a later theme
// overrides them under :root[data-theme="<id>"]. The swatch is the theme's own app, card, border and text colours for its Settings preview,
// so it stays right whichever theme is active. electron/state.cjs lists the same ids when it sanitizes settings.
export const THEMES = [
  { id: 'mono', name: '黑底白字', description: '黑色底，白色文字，灰阶为主，颜色只表示状态', swatch: { page: '#181818', pane: '#262626', line: '#404040', ink: '#f2f2f2' } },
  { id: 'light', name: '白底黑字', description: '白色底，黑色文字，灰阶为主，颜色只表示状态', swatch: { page: '#f8f9fb', pane: '#f7f7f8', line: '#e2e6eb', ink: '#20242a' } },
] as const;

export type ThemeId = typeof THEMES[number]['id'];

export const DEFAULT_THEME: ThemeId = THEMES[0].id;

export function applyTheme(theme: ThemeId | undefined) { document.documentElement.dataset.theme = theme ?? DEFAULT_THEME; }

export function currentTheme(): ThemeId {
  return typeof document !== 'undefined' && document.documentElement?.dataset?.theme === 'light' ? 'light' : DEFAULT_THEME;
}

export function subscribeTheme(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
