// 运行方式: how Claude and Codex run — Claude on the Anthropic API key in the app's own view, falling back to the terminal when the API's
// quota is used up; Codex in its app-server view or the terminal — and the monthly API budget. The key is write-only here: it is sent to the
// main process, the field is emptied, and only "saved or not" ever comes back.
import { useEffect, useState } from 'react';
import { CurrencyDollar, Key, Robot, Terminal as TerminalIcon, Info } from '@phosphor-icons/react';
import { t } from '../../shared/i18n';
import { Select } from '../../shared/Select';
import { type ClaudePath, type CodexView, type NativeSettings, nativeBridge } from '../native-session/native-bridge.ts';
import './agent-runtime-settings.css';

const CLAUDE_PATHS = (): { value: ClaudePath; label: string }[] => [
  { value: 'api-then-terminal', label: t('API，额度用完转终端（默认）') }, { value: 'api-only', label: t('只用 API') }, { value: 'terminal-only', label: t('只用终端（订阅）') },
];
const CODEX_VIEWS = (): { value: CodexView; label: string }[] => [{ value: 'native', label: t('原生界面（默认）') }, { value: 'terminal', label: t('终端') }];
const failure = (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) });

// A budget is dollars above zero, or empty for none. null is "none"; undefined is "not a budget".
export function parseBudget(text: string): number | null | undefined {
  const value = text.trim();
  if (!value) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : undefined;
}

export function AgentRuntimeSettings() {
  const bridge = nativeBridge();
  const [settings, setSettings] = useState<NativeSettings | null>(null), [saved, setSaved] = useState<boolean | null>(null);
  const [key, setKey] = useState(''), [budget, setBudget] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void Promise.all([bridge.getSettings(), bridge.keyStatus()]).then(([found, status]) => {
      if (!active) return;
      if (found.ok) { setSettings(found.value); setBudget(found.value.monthlyBudgetUsd === null ? '' : String(found.value.monthlyBudgetUsd)); } else setError(found.error);
      if (status.ok) setSaved(status.value.saved);
    });
    return () => { active = false; };
  }, []);
  if (!bridge) return <p className="settings-note"><Info size={15} /><span>{t('这个版本没有原生会话。')}</span></p>;

  // One change at a time; a refused one leaves the page as it was and says why.
  const run = async (action: () => Promise<{ ok: true } | { ok: false; error: string }>, done: () => void) => {
    setBusy(true); setError(null);
    const result = await action().catch(failure);
    setBusy(false);
    if (result.ok) done(); else setError(result.error);
  };
  const change = (patch: Partial<NativeSettings>) => run(() => bridge.setSettings(patch), () => setSettings(current => current && { ...current, ...patch }));
  const refreshKey = async () => { const status = await bridge.keyStatus().catch(failure); if (status.ok) setSaved(status.value.saved); else setError(status.error); };
  const saveKey = () => {
    const secret = key;
    if (!secret.trim()) return;
    setKey('');
    void run(() => bridge.keySave(secret), () => void refreshKey());
  };
  const saveBudget = () => {
    const amount = parseBudget(budget);
    if (amount === undefined) { setError(t('月预算要大于 0；留空表示不限。')); return; }
    if (amount !== settings?.monthlyBudgetUsd) void change({ monthlyBudgetUsd: amount });
  };

  return <>
    <p className="agents-intro">{t('Claude 默认通过 Anthropic API 在应用自己的界面里运行；API 额度用完时，按下面的选择改用订阅登录的终端，对话接着上一次继续。')}</p>
    <div className="setting-row runtime-key-row"><span><Key size={19} /><span><b>{t('Anthropic API key')}</b><small role="status">{saved === null ? t('正在读取…') : saved ? t('已保存') : t('未保存')}</small></span></span>
      <span className="runtime-key">
        <input type="password" autoComplete="off" spellCheck={false} aria-label={t('Anthropic API key')} placeholder={saved ? t('输入新的 key 以替换') : 'sk-ant-…'} value={key} disabled={busy}
          onChange={event => setKey(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') saveKey(); }} />
        <button type="button" className="button secondary small" disabled={busy || !key.trim()} onClick={saveKey}>{t('保存')}</button>
        {saved && <button type="button" className="text-button" disabled={busy} onClick={() => void run(() => bridge.keyClear(), () => void refreshKey())}>{t('清除')}</button>}
      </span></div>
    <label className="setting-row"><span><Robot size={19} /><span><b>{t('Claude 的运行方式')}</b><small>{t('API：应用里的原生界面，按量计费；订阅：Claude Code 终端')}</small></span></span>
      <Select label={t('Claude 的运行方式')} className="runtime-select" value={settings?.claudePath ?? 'api-then-terminal'} disabled={!settings || busy} options={CLAUDE_PATHS()} onChange={value => void change({ claudePath: value as ClaudePath })} /></label>
    <label className="setting-row"><span><TerminalIcon size={19} /><span><b>{t('Codex 的界面')}</b><small>{t('原生：Codex 的 app-server，在应用自己的界面里；终端：Codex 命令行')}</small></span></span>
      <Select label={t('Codex 的界面')} value={settings?.codexView ?? 'native'} disabled={!settings || busy} options={CODEX_VIEWS()} onChange={value => void change({ codexView: value as CodexView })} /></label>
    <div className="setting-row"><span><CurrencyDollar size={19} /><span><b>{t('API 月预算（美元）')}</b><small>{t('按 UTC 自然月累计的估算；用完后 Claude 按上面的选择处理。留空表示不限')}</small></span></span>
      <span className="runtime-budget">
        <input type="text" inputMode="decimal" autoComplete="off" aria-label={t('API 月预算（美元）')} placeholder={t('不限')} value={budget} disabled={!settings || busy}
          onChange={event => setBudget(event.target.value)} onBlur={saveBudget} onKeyDown={event => { if (event.key === 'Enter') saveBudget(); }} />
      </span></div>
    {error && <p className="form-error runtime-error" role="alert">{error}</p>}
  </>;
}
