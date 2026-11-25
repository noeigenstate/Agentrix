import { useEffect, useState } from 'react';
import type { Settings } from '../../shared/types';
import { t } from '../../shared/i18n';

const fields = [
  { key: 'terminalFontFamily', label: '终端西文字体', hint: '选择已安装的等宽字体；留空沿用原方案', placeholder: 'Cascadia Code', names: ['Cascadia Code', 'Cascadia Mono', 'Consolas', 'JetBrains Mono', 'SF Mono', 'Menlo'] },
  { key: 'terminalCjkFontFamily', label: '终端中文字体', hint: '中文单独选择；未安装时使用后备字体，留空沿用原方案', placeholder: 'Microsoft YaHei UI / PingFang SC', names: ['Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans SC', 'PingFang SC'] },
] as const;

export function TerminalFontSettings({ settings, update }: { settings: Settings; update: (patch: Partial<Settings>) => void }) {
  const [draft, setDraft] = useState({ terminalFontFamily: settings.terminalFontFamily, terminalCjkFontFamily: settings.terminalCjkFontFamily });
  useEffect(() => { setDraft(previous => ({ ...previous, terminalFontFamily: settings.terminalFontFamily })); }, [settings.terminalFontFamily]);
  useEffect(() => { setDraft(previous => ({ ...previous, terminalCjkFontFamily: settings.terminalCjkFontFamily })); }, [settings.terminalCjkFontFamily]);
  return <>{fields.map(field => <label className="setting-row terminal-font-row" key={field.key}>
    <span><span><b>{t(field.label)}</b><small>{t(field.hint)}</small></span></span>
    <input aria-label={t(field.label)} list={field.key + '-suggestions'} value={draft[field.key]} placeholder={field.placeholder} maxLength={80}
      onChange={event => setDraft({ ...draft, [field.key]: event.target.value })} onBlur={event => update({ [field.key]: event.target.value.trim() })}
      onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing) update({ [field.key]: event.currentTarget.value.trim() }); }} />
    <datalist id={field.key + '-suggestions'}>{field.names.map(name => <option value={name} key={name} />)}</datalist>
  </label>)}</>;
}
