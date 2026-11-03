// 运行方式: how Claude and Codex run — Claude on the Anthropic API key in the app's own view, falling back to the terminal when the API's
// quota is used up; Codex in its app-server view or the terminal — and the monthly API budget. The key is write-only here: it is sent to the
// main process, the field is emptied, and only "saved or not" ever comes back.
import { useEffect, useState } from 'react';
import { CheckCircle, CircleNotch, CurrencyDollar, Key, PlugsConnected, Robot, Terminal as TerminalIcon, Info, WarningCircle, XCircle } from '@phosphor-icons/react';
import { t } from '../../shared/i18n';
import { Select } from '../../shared/Select';
import { type ClaudePath, type CodexView, type ConnectionTest, type NativeSettings, nativeBridge } from '../native-session/native-bridge.ts';
import { clockWords, connectionLines } from '../native-session/native-words';
import './agent-runtime-settings.css';

const CLAUDE_PATHS = (): { value: ClaudePath; label: string }[] => [
  { value: 'api-then-terminal', label: t('API，额度用完转终端（默认）') }, { value: 'api-only', label: t('只用 API') }, { value: 'terminal-only', label: t('只用终端（订阅）') },
];
const CODEX_VIEWS = (): { value: CodexView; label: string }[] => [{ value: 'native', label: t('原生界面（默认）') }, { value: 'terminal', label: t('终端') }];
// A mark per tone, so a line reads without its colour.
const TONE_MARKS = { ok: <CheckCircle size={16} weight="fill" />, warn: <WarningCircle size={16} weight="fill" />, bad: <XCircle size={16} weight="fill" /> };
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
  const [test, setTest] = useState<ConnectionTest | null>(null), [testing, setTesting] = useState(false), [testError, setTestError] = useState<string | null>(null);
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
    // Any accepted change (the key, the path) makes an earlier test result stale.
    if (result.ok) { setTest(null); done(); } else setError(result.error);
  };
  // Only the owner's click runs it, and the key never comes back in the answer.
  const runTest = async () => {
    setTesting(true); setTest(null); setTestError(null);
    const result = await Promise.resolve().then(() => bridge.testConnection()).catch(failure);
    setTesting(false);
    if (result.ok) setTest(result.value); else setTestError(result.error);
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
    <p className="settings-note"><Info size={15} /><span>{t('派发的工作者看不到你的 API 密钥。')}</span></p>
    <p className="settings-note"><Info size={15} /><span>{t('你自己的 API 会话里运行的命令能读到密钥；这些命令产生的花费不计入这里的预算估算。')}</span></p>
    <div className="setting-row runtime-key-row"><span><Key size={19} /><span><b>{t('Anthropic API key')}</b><small role="status">{saved === null ? t('正在读取…') : saved ? t('已保存') : t('未保存')}</small></span></span>
      <span className="runtime-key">
        <input type="password" autoComplete="off" spellCheck={false} aria-label={t('Anthropic API key')} placeholder={saved ? t('输入新的 key 以替换') : 'sk-ant-…'} value={key} disabled={busy || testing}
          onChange={event => setKey(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') saveKey(); }} />
        <button type="button" className="button secondary small" disabled={busy || testing || !key.trim()} onClick={saveKey}>{t('保存')}</button>
        {saved && <button type="button" className="text-button" disabled={busy || testing} onClick={() => void run(() => bridge.keyClear(), () => void refreshKey())}>{t('清除')}</button>}
      </span></div>
    <div className="setting-row runtime-test-row"><span><PlugsConnected size={19} /><span><b>{t('检查连接')}</b><small>{t('只在你点击时运行，不会自动检查')}</small></span></span>
      <button type="button" className="button secondary small" disabled={!saved || busy || testing} title={saved ? undefined : t('先保存 API key')} onClick={() => void runTest()}>{t('测试连接')}</button></div>
    {testing && <p className="runtime-testing" role="status"><CircleNotch size={14} className="loading-spinner" aria-hidden="true" />{t('正在测试连接…')}</p>}
    {testError && <p className="form-error runtime-error" role="alert">{t('测试没有完成：{message}', { message: testError })}</p>}
    {test && <div className="runtime-test">
      <ul aria-label={t('连接测试结果')}>{connectionLines(test).map(line => <li key={line.id} className={`is-${line.tone}`} title={line.title ?? undefined}>
        <span className="runtime-test-mark" aria-hidden="true">{TONE_MARKS[line.tone]}</span><b>{line.label}</b><span>{line.text}{line.hint && <small>{line.hint}</small>}</span>
      </li>)}</ul>
      <small className="runtime-test-time">{t('检测于 {time}', { time: clockWords(test.checkedAt) })}</small>
    </div>}
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
