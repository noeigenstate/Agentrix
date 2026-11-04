// What each agent is connected through, where its next session starts and what the Claude API has cost:
// API's spend today and this month (an estimate from tokens at public prices — there is no balance to read), the monthly budget and its
// share, each agent's rate-limit state with when it recovers, and why the path last changed. Read-only: it only asks the main process.
// A value nobody gave is 未知, never 0.
import { type ReactNode, useEffect, useState } from 'react';
import { t } from '../../shared/i18n';
import { type LimitsPayload, type NativeAgent, type NativeUsage, nativeBridge } from '../native-session/native-bridge.ts';
import { useUsageRevision } from '../native-session/native-store.ts';
import { clockWords, connectionWord, money, nextPathWord, reasonWords, routeWord, windowWords } from '../native-session/native-words';
import './activity-pane.css';

// Read again a minute after the last read (the month turns over, a limit recovers), and a second after an event says the numbers moved.
const REFRESH_MS = 60_000, REVISION_DELAY_MS = 1000;
const AGENTS = ['claude', 'codex'] as const;
const NAMES: Record<NativeAgent, string> = { claude: 'Claude', codex: 'Codex' };

// A limit's lines: each window (how much is used, when it starts over) or, when the provider says so, that it is reached; what is not known says so.
export function limitLines(limits: LimitsPayload | null | undefined): string[] {
  if (!limits) return [t('未知')];
  const entries = Object.values(limits.limitsById ?? {}), windows = entries.flatMap(entry => [entry?.primary, entry?.secondary]);
  const lines = windows.flatMap(item => windowWords(item) ?? []).map(item => [item.span, t('已用 {percent}', { percent: item.used }), t('{time} 重置', { time: item.resets })].filter(Boolean).join(' · '));
  const resets = windows.flatMap(item => typeof item?.resetsAtMs === 'number' ? [item.resetsAtMs] : []);
  if (limits.state === 'rate_limited' || limits.ordinaryUsageAllowed === false) lines.unshift(resets.length ? t('已限流，约 {time} 恢复', { time: clockWords(Math.min(...resets)) }) : t('已限流，恢复时间未知'));
  else if (!lines.length) lines.push(limits.state === 'unavailable' || limits.state === 'error' ? t('暂时读不到') : t('未知'));
  if (limits.state === 'stale') lines.push(t('数据可能已过期'));
  return lines;
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="api-row"><dt>{label}</dt><dd>{children}</dd></div>;

export function ApiUsage() {
  const bridge = nativeBridge(), revision = useUsageRevision();
  const [usage, setUsage] = useState<NativeUsage | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const read = async () => {
      const result = await bridge.usage().catch((failure: unknown) => ({ ok: false as const, error: failure instanceof Error ? failure.message : String(failure) }));
      if (!active) return;
      if (result.ok) { setUsage(result.value); setError(null); } else setError(result.error);
    };
    const first = setTimeout(() => void read(), revision === 0 ? 0 : REVISION_DELAY_MS), again = setInterval(() => void read(), REFRESH_MS);
    return () => { active = false; clearTimeout(first); clearInterval(again); };
  }, [revision]);
  if (!bridge || (!usage && !error)) return null;
  const label = t('运行方式与 API 额度');
  if (!usage) return <section className="activity-card activity-api" aria-label={label}><p className="activity-note" role="alert">{t('无法读取额度：{message}', { message: error ?? '' })}</p></section>;

  const { agents, lastSwitch, budgetUsd, monthUsdMicros } = usage;
  const share = budgetUsd && typeof monthUsdMicros === 'number' ? Math.round(monthUsdMicros / (budgetUsd * 1e6) * 100) : null;
  return <section className="activity-card activity-api" aria-label={label}>
    <h3 className="activity-card-title">{label}</h3>
    <div className="api-agents">
      {AGENTS.map(agent => {
        const state = agents[agent], connection = connectionWord(agent, state?.connection);
        return <section key={agent} className="api-agent" aria-label={NAMES[agent]}>
          <h4 className="api-agent-title">{NAMES[agent]}</h4>
          <dl className="api-usage">
            <Row label={t('连接')}><span title={connection.source ?? undefined}>{connection.text}</span></Row>
            <Row label={t('新会话')}><span>{nextPathWord(state?.next)}</span></Row>
            <Row label={t('额度')}>{limitLines(state?.limits).map((line, index) => <span key={index}>{line}</span>)}</Row>
            {agent === 'claude' && <>
              <Row label={t('API 花费')}>{usage.apiRecords === false
                ? <span>{t('还没有 API 用量记录')}</span>
                : <><span>{t('今日 {amount}', { amount: money(usage.todayUsdMicros) })} · {t('本月 {amount}', { amount: money(monthUsdMicros) })}</span><small>{t('估算，按公开价格计算')}</small></>}</Row>
              <Row label={t('月预算')}>
                <span>{budgetUsd === null ? t('未设置') : `$${budgetUsd.toFixed(2)} · ${share === null ? t('已用 未知') : t('已用 {percent}', { percent: `${share}%` })}`}</span>
                {share !== null && <span className={`activity-meter${share >= 90 ? ' is-warn' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, share)} aria-label={t('月预算已用 {percent}', { percent: `${share}%` })}><i style={{ width: `${Math.min(100, share)}%` }} /></span>}
              </Row>
            </>}
            {lastSwitch?.agent === agent && <Row label={t('最近切换')}>
              <span>{[`${routeWord(lastSwitch.from)} → ${routeWord(lastSwitch.to)}`, clockWords(lastSwitch.at)].join(' · ')}</span>
              {lastSwitch.reason && <small>{reasonWords(lastSwitch.reason)}</small>}
            </Row>}
          </dl>
        </section>;
      })}
    </div>
  </section>;
}
