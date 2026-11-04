// The activity pane's second block, 运行方式与额度: per agent how it is connected and what it has left. Everything that measures sits in the agent it belongs to:
//   - the agent of the current session leads with its context length and ends with this round's (and this conversation's) tokens; the other agent has neither;
//   - a subscription shows its 5-hour and weekly bars and where they come from (Codex also its limit resets), never API spend or a budget;
//   - an API connection shows the API spend and the monthly budget (a bar when one is set), never the subscription windows;
//   - not connected, or not known, says "额度 未知".
// Windows come from the main process; the current session's agent falls back to what its own screen and records gave when the main process has none.
// Read-only: it only asks the main process (for the current project's scope). A value nobody gave is 未知, never 0.
import { type ReactNode, useEffect, useState } from 'react';
import type { AgentUsage, ProjectTerminal } from '../../shared/types';
import { t } from '../../shared/i18n';
import { type LimitsPayload, type NativeAgent, type NativeUsage, nativeBridge } from '../native-session/native-bridge.ts';
import { useUsageRevision } from '../native-session/native-store.ts';
import { clockWords, connectionWord, money, windowWords } from '../native-session/native-words';
import { Metric, TokenMetric, exactCount, percentOf, resetTime, tokenCount } from './Metric';
import { ResetQuota } from './ResetQuota';
import './activity-pane.css';

// Read again a minute after the last read (the month turns over, a limit recovers), and a second after an event says the numbers moved.
const REFRESH_MS = 60_000, REVISION_DELAY_MS = 1000;
const AGENTS = ['claude', 'codex'] as const;
const NAMES: Record<NativeAgent, string> = { claude: 'Claude', codex: 'Codex' };

const windowsOf = (limits: LimitsPayload) => Object.values(limits.limitsById ?? {}).flatMap(entry => [entry?.primary, entry?.secondary]);
// That the provider says the limit is reached, with when it recovers; null when it does not say so.
function reachedLine(limits: LimitsPayload) {
  if (limits.state !== 'rate_limited' && limits.ordinaryUsageAllowed !== false) return null;
  const resets = windowsOf(limits).flatMap(item => typeof item?.resetsAtMs === 'number' ? [item.resetsAtMs] : []);
  return resets.length ? t('已限流，约 {time} 恢复', { time: clockWords(Math.min(...resets)) }) : t('已限流，恢复时间未知');
}

// A limit's lines: each window (how much is used, when it starts over) or, when the provider says so, that it is reached; what is not known says so.
export function limitLines(limits: LimitsPayload | null | undefined): string[] {
  if (!limits) return [t('未知')];
  const lines = windowsOf(limits).flatMap(item => windowWords(item) ?? []).map(item => [item.span, t('已用 {percent}', { percent: item.used }), t('{time} 重置', { time: item.resets })].filter(Boolean).join(' · '));
  const reached = reachedLine(limits);
  if (reached) lines.unshift(reached);
  else if (!lines.length) lines.push(limits.state === 'unavailable' || limits.state === 'error' ? t('暂时读不到') : t('未知'));
  if (limits.state === 'stale') lines.push(t('数据可能已过期'));
  return lines;
}

// One quota window as a bar needs it: its length, how much is used (null when not given), when it starts over.
type QuotaWindow = { minutes: number | null; percent: number | null; resetsAt: number | null };
// The windows the main process reports, one per length (the fullest when several limits share a length), shortest first.
export function limitWindows(limits: LimitsPayload | null | undefined): QuotaWindow[] {
  const found = new Map<string, QuotaWindow>();
  for (const item of limits ? windowsOf(limits) : []) {
    if (!item) continue;
    const next: QuotaWindow = { minutes: item.windowDurationMins ?? null, percent: typeof item.usedPercent === 'number' ? item.usedPercent : null, resetsAt: typeof item.resetsAtMs === 'number' ? item.resetsAtMs : null };
    const key = String(next.minutes), held = found.get(key);
    if (!held || (next.percent ?? -1) > (held.percent ?? -1)) found.set(key, next);
  }
  return [...found.values()].sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
}
const windowsFromScreen = (usage: AgentUsage | null | undefined): QuotaWindow[] => (usage?.limits ?? []).map(limit => ({ minutes: limit.minutes, percent: limit.percent, resetsAt: limit.resetsAt }));

// A rate-limit window by its length: 5 hours, a week.
function limitName(minutes: number | null) {
  if (minutes === 10080) return t('每周额度');
  if (minutes === 1440) return t('每日额度');
  if (minutes && minutes % 60 === 0) return t('{n} 小时额度', { n: minutes / 60 });
  return minutes ? t('{n} 分钟额度', { n: minutes }) : t('额度');
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="api-row"><dt>{label}</dt><dd>{children}</dd></div>;

// The context the conversation fills now, out of the model's window. A window that is not known shows "—", not 0%.
function ContextMetric({ usage }: { usage: AgentUsage | null | undefined }) {
  const context = usage?.context;
  if (!context) return <Metric className="activity-tokens" label={t('上下文长度')} note={t('第一次回复后显示。')} />;
  const windowKnown = context.window > 0, percent = percentOf(context.used, context.window);
  return <Metric className="activity-figure" label={t('上下文长度')} percent={windowKnown ? percent : undefined} value={windowKnown ? `${percent}%` : '—'}
    meterLabel={t('上下文已用 {percent}%', { percent })} title={`${exactCount(context.used)} / ${exactCount(context.window)} tokens`}
    note={windowKnown ? t('共 {window} tokens · 还可容纳 {count}', { window: tokenCount(context.window), count: tokenCount(Math.max(0, context.window - context.used)) })
      : t('已用 {count} tokens，窗口大小未知', { count: tokenCount(context.used) })} />;
}

// The windows a subscription shows: main's; else, for the session's own agent, the ones its screen and records gave (onScreen).
function quotaWindows(limits: LimitsPayload | null | undefined, current: boolean, usage: AgentUsage | null | undefined) {
  const fromMain = limitWindows(limits), fromScreen = current ? windowsFromScreen(usage) : [];
  return fromMain.length ? { windows: fromMain, onScreen: false } : { windows: fromScreen, onScreen: fromScreen.length > 0 };
}

// Where the numbers come from, under the bars: the account read (main's answer, with when it was observed) or the session's own source; null when nothing is said.
function quotaSource(agent: NativeAgent, limits: LimitsPayload | null | undefined, current: boolean, usage: AgentUsage | null | undefined) {
  const { windows, onScreen } = quotaWindows(limits, current, usage);
  if (!windows.length) return current && agent === 'claude' && usage?.limitsAt == null ? t('账号额度暂不可用。') : null;
  if (onScreen) return usage?.limitsAt == null ? t('账号额度暂不可用。') : usage.limitsFrom === 'CodePulse' ? t('额度来自 CodePulse 状态记录，{time} 写入', { time: resetTime(usage.limitsAt) })
    : t('额度来自 {source}，{time} 更新', { source: usage.limitsFrom || 'Claude Code', time: resetTime(usage.limitsAt) });
  return typeof limits?.observedAtMs === 'number' ? t('额度来自 {source}，{time} 更新', { source: NAMES[agent], time: resetTime(limits.observedAtMs) }) : null;
}

// The subscription's windows as bars, what is not known said as such, and the provider's rate-limit lines.
function QuotaMetrics({ limits, current, usage }: { limits: LimitsPayload | null | undefined; current: boolean; usage: AgentUsage | null | undefined }) {
  const { windows, onScreen } = quotaWindows(limits, current, usage);
  // App's five-second clock rerenders this pane even when the snapshot is unchanged.
  const now = Date.now(), observed = onScreen ? usage?.limitsAt : limits?.observedAtMs;
  const updated = typeof observed === 'number' ? t('{time} 更新', { time: resetTime(observed) }) : null;
  const notes = limits && windows.length ? [reachedLine(limits), limits.state === 'stale' ? t('数据可能已过期') : null].filter((line): line is string => !!line) : [];
  return <>
    {windows.length ? windows.map(window => {
      const name = limitName(window.minutes), expired = window.resetsAt != null && window.resetsAt <= now, known = window.percent !== null;
      const label = expired ? t('已重置，等待更新') : t('{name}已用 {percent}%', { name, percent: Math.round(window.percent ?? 0) });
      return <Metric key={window.minutes ?? 'unknown'} className="activity-limit" label={name} percent={expired ? null : known ? window.percent : undefined} meterLabel={label}
        value={expired ? undefined : known ? `${Math.round(window.percent!)}%` : t('未知')} valueTitle={known ? [`${window.percent!.toFixed(1)}%`, updated].filter(Boolean).join(' · ') : undefined}
        note={expired ? label : window.resetsAt != null ? t('{time} 重置', { time: resetTime(window.resetsAt) }) : undefined} />;
    }) : <Metric className="activity-tokens" label={t('额度')} note={limitLines(limits).join(' · ')} />}
    {notes.map(line => <Metric key={line} className="activity-tokens" label={t('额度')} note={line} />)}
  </>;
}

// API spend (an estimate from tokens at public prices) and the monthly budget: a bar when one is set, else "未设置". Codex has no spend record.
function ApiMetrics({ agent, usage }: { agent: NativeAgent; usage: NativeUsage }) {
  const { budgetUsd, monthUsdMicros } = usage;
  const share = budgetUsd && typeof monthUsdMicros === 'number' ? Math.round(monthUsdMicros / (budgetUsd * 1e6) * 100) : null;
  if (agent === 'codex') return <Metric className="activity-tokens" label={t('API 花费')} note={t('还没有 API 用量记录')} />;
  return <>
    {budgetUsd === null
      ? <Metric className="activity-tokens" label={t('月预算')} note={t('未设置')} />
      : <Metric className="activity-figure" label={t('月预算')} percent={share ?? undefined} value={share === null ? t('未知') : `${share}%`} meterLabel={t('月预算已用 {percent}', { percent: `${share}%` })}
        note={`${t('本月 {amount}', { amount: money(monthUsdMicros) })} / $${budgetUsd.toFixed(2)}`} />}
    {usage.apiRecords === false
      ? <Metric className="activity-tokens" label={t('API 花费')} note={t('还没有 API 用量记录')} />
      : <Metric className="activity-tokens" label={t('API 花费')} title={t('估算，按公开价格计算')} note={`${t('今日 {amount}', { amount: money(usage.todayUsdMicros) })} · ${t('本月 {amount}', { amount: money(monthUsdMicros) })} · ${t('估算')}`} />}
  </>;
}

function AgentSection({ agent, usage, terminal }: { agent: NativeAgent; usage: NativeUsage; terminal: ProjectTerminal }) {
  const state = usage.agents[agent], connection = connectionWord(agent, state?.connection), kind = state?.connection?.kind;
  // The session in view belongs to one agent; only it has a context length and a round.
  const current = terminal.codexActive && terminal.agent === agent, tokens = terminal.agentUsage;
  const rows = [[t('本轮'), tokens?.round], [t('本次对话'), tokens?.total]] as const;
  // A session that reported plan windows of its own is on a plan even when main could not tell the connection (a terminal session): its bars show, and it is not 额度 未知.
  const plan = kind === 'subscription' || (kind !== 'api' && current && windowsFromScreen(tokens).length > 0), shown = plan || kind === 'api';
  const source = plan ? quotaSource(agent, state?.limits, current, tokens) : null;
  return <section className="api-agent" aria-label={NAMES[agent]}>
    <h4 className="api-agent-title">{NAMES[agent]}</h4>
    <dl className="api-usage">
      <Row label={t('连接')}><span title={connection.source ?? undefined}>{connection.text}</span></Row>
      {!shown && <Row label={t('额度')}><span>{t('未知')}</span></Row>}
    </dl>
    {(current || shown) && <div className="activity-metrics">
      {current && <ContextMetric usage={tokens} />}
      {plan && <QuotaMetrics limits={state?.limits} current={current} usage={tokens} />}
      {kind === 'api' && <ApiMetrics agent={agent} usage={usage} />}
      {current && rows.map(([label, counted]) => counted && <TokenMetric key={label} label={label} tokens={counted} />)}
    </div>}
    {source && <p className="activity-note">{source}</p>}
    {current && tokens?.context && !tokens.round && <p className="activity-note">{t('本轮从更早的记录开始，暂无法统计。')}</p>}
    {current && tokens?.context && !tokens.total && <p className="activity-note">{t('本次对话的总量在更早的记录里。')}</p>}
    {current && agent === 'codex' && plan && <ResetQuota key={`${terminal.id}:${terminal.sessionId}:${terminal.agentStartedAt}`} terminal={terminal} />}
  </section>;
}

// Both agents' sections, one under the other; the block's content, which scrolls under its fixed title.
export const AgentSections = ({ usage, terminal }: { usage: NativeUsage; terminal: ProjectTerminal }) => <div className="api-agents">
  {AGENTS.map(agent => <AgentSection key={agent} agent={agent} usage={usage} terminal={terminal} />)}
</div>;

export function ApiUsage({ terminal, projectId }: { terminal: ProjectTerminal; projectId?: string }) {
  const bridge = nativeBridge(), revision = useUsageRevision();
  const [usage, setUsage] = useState<NativeUsage | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const read = async () => {
      const result = await bridge.usage(projectId).catch((failure: unknown) => ({ ok: false as const, error: failure instanceof Error ? failure.message : String(failure) }));
      if (!active) return;
      if (result.ok) { setUsage(result.value); setError(null); } else setError(result.error);
    };
    const first = setTimeout(() => void read(), revision === 0 ? 0 : REVISION_DELAY_MS), again = setInterval(() => void read(), REFRESH_MS);
    return () => { active = false; clearTimeout(first); clearInterval(again); };
  }, [revision, projectId]);
  if (!bridge || (!usage && !error)) return null;
  const label = t('运行方式与额度');
  if (!usage) return <section className="activity-card activity-api" aria-label={label}><p className="activity-note" role="alert">{t('无法读取额度：{message}', { message: error ?? '' })}</p></section>;
  return <section className="activity-card activity-api" aria-label={label}>
    <h3 className="activity-card-title">{label}</h3>
    <AgentSections usage={usage} terminal={terminal} />
  </section>;
}
