import type { CSSProperties } from 'react';
import { t } from '../../shared/i18n';
import { THEMES, type ThemeId } from '../../shared/themes';

// One radio per theme; the preview is a mini window painted in the theme's own greys.
export function ThemeSetting({ theme, update }: { theme: ThemeId; update: (theme: ThemeId) => void }) {
  return <fieldset className="theme-setting">
    <legend>{t('主题')}</legend>
    {THEMES.map(({ id, name, description, swatch }) => <label key={id} className="theme-option">
      <input type="radio" name="theme" value={id} checked={theme === id} onChange={() => update(id)} />
      <span className="theme-preview" aria-hidden="true" style={{ '--swatch-page': swatch.page, '--swatch-pane': swatch.pane, '--swatch-line': swatch.line, '--swatch-ink': swatch.ink } as CSSProperties}><i /><i /></span>
      <span className="theme-option-text"><b>{t(name)}</b><small>{t(description)}</small></span>
    </label>)}
  </fieldset>;
}
