// The activity pane's second block, 运行方式与额度: per agent how it runs (通道) and what it has left. Everything that measures sits in the agent it belongs to:
//   - the agent of the current session ends with this round's (and this conversation's) tokens; the other agent has none;
//   - a subscription shows its 5-hour and weekly bars and where they come from (Codex also its limit resets), never API spend;
//   - an API connection shows the API spend (today and this month, one row, information only: nothing reads it to decide anything), never the subscription windows;
//   - Claude on the API also has a link to the console's billing page (the spend is an estimate; the console has the bill); a balance rejection brings the same button next to its notice, never two;
//   - the provider's own notice that a limit was reached is said under the agent it belongs to, with when it recovers only if the provider said;
//   - not connected, or not known, says "额度 未知";
//   - an allowance split by model (the manifest's `usage.quotaGroup`) shows the groups of the models the project runs on that agent, each named when there are several;
//   - an account that is signed in while the agent has no main session (the connection's `active` is false) shows its bars or spend as for any plan or API,
//     and since no session is running it has no round or conversation tokens (only the session in view has them).
// Windows come from the main process; the current session's agent falls back to what its own screen and records gave when the main process has none.
// Read-only: it only asks the main process (for the current project's scope). A value nobody gave is 未知, never 0. What the main process does not give (a read
// that has not come back, one that failed, a project it cannot answer for) leaves the allowance 未知; the current session's own bars and tokens stay.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { AgentUsage, AgentsState, ProjectTerminal, SeatsInfo } from '../../shared/types';
import { t } from '../../shared/i18n';
import { adapterOf, adapters, agentOfModel } from '../../../electron/features/cli-adapters/registry.mjs';
import { support } from '../../../electron/features/cli-adapters/capabilities.mjs';
import { type LimitsPayload, type NativeAgent, type NativeUsage, nativeBridge } from '../native-session/native-bridge.ts';
import { useUsageRevision } from '../native-session/native-store.ts';
import { BillingLink } from '../native-session/native-billing-link.ts';
import { clockWords, consoleCheck, money, noticeWords, windowWords } from '../native-session/native-words';
import { Metric, TokenMetric, resetTime } from './Metric';
import { brandIconOf } from './AgentBrandIcon.ts';
import { ResetQuota } from './ResetQuota';
import { displayedSeat } from './routing-seats.ts';
import './activity-pane.css';

// Read again a minute after the last read (the month turns over, a limit recovers), and a second after an event says the numbers moved.
const REFRESH_MS = 60_000, REVISION_DELAY_MS = 1000;
const AGENTS = adapters().filter(({ manifest }) => support(manifest, 'accountLimits').ok);
type Installations = Partial<Pick<AgentsState, NativeAgent>>;
type UsageDisplay = NonNullable<NonNullable<ReturnType<typeof adapterOf>>['manifest']['usage']>;
type ModelsInUse = Partial<Record<NativeAgent, string[]>>;
// The last usage read per project, shown at once when its pane opens again. Nothing tells this file that a project was removed, so it keeps the most recently read ones.
const HELD_PROJECTS = 32;
const observations = new Map<string, { bridge: ReturnType<typeof nativeBridge>; usage: NativeUsage }>();
function observe(key: string, bridge: NonNullable<ReturnType<typeof nativeBridge>>, usage: NativeUsage) {
  observations.delete(key); observations.set(key, { bridge, usage });
  if (observations.size > HELD_PROJECTS) observations.delete(observations.keys().next().value!);
}

function windowsOf(limits: LimitsPayload | null | undefined, groupId?: string) {
  const groups = limits?.limitsById ?? {};
  return (groupId === undefined ? Object.values(groups) : [groups[groupId]]).flatMap(entry => [entry?.primary, entry?.secondary]);
}
// That the provider says the limit is reached, with when it recovers; null when it does not say so. A notice of the provider's own (below) says it in
// the provider's words, so this line is for a provider that gave only the status.
function reachedLine(limits: LimitsPayload) {
  if (limits.notice) return null;
  if (limits.state !== 'rate_limited' && limits.ordinaryUsageAllowed !== false && limits.providerStatus !== 'rejected') return null;
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
// The windows the main process reports, one per length in the selected group or across all limits, shortest first.
export function limitWindows(limits: LimitsPayload | null | undefined, groupId?: string): QuotaWindow[] {
  const found = new Map<string, QuotaWindow>();
  for (const item of windowsOf(limits, groupId)) {
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

// The windows a subscription shows: main's; else, for the session's own agent, the ones its screen and records gave (onScreen).
function quotaWindows(limits: LimitsPayload | null | undefined, current: boolean, usage: AgentUsage | null | undefined) {
  const fromMain = limitWindows(limits), fromScreen = current ? windowsFromScreen(usage) : [];
  const newer = fromScreen.length > 0 && typeof usage?.limitsAt === 'number'
    && (typeof limits?.observedAtMs !== 'number' || usage.limitsAt > limits.observedAtMs);
  return fromMain.length && !newer ? { windows: fromMain, onScreen: false } : { windows: fromScreen, onScreen: fromScreen.length > 0 };
}

// Under the bars only when the session's own windows have no observation time to stand on; null otherwise.
function quotaUnavailable(showUnavailable: boolean, limits: LimitsPayload | null | undefined, current: boolean, usage: AgentUsage | null | undefined) {
  const { windows, onScreen } = quotaWindows(limits, current, usage);
  const unobserved = usage?.limitsAt == null && (windows.length ? onScreen : current && showUnavailable);
  return unobserved ? t('账号额度暂不可用。') : null;
}

// The subscription's windows as bars, what is not known said as such, and the provider's rate-limit lines. With `groups` only those groups' windows, under their names where given.
function QuotaMetrics({ limits, current, usage, groups }: { limits: LimitsPayload | null | undefined; current: boolean;
  usage: AgentUsage | null | undefined; groups?: readonly QuotaGroup[] }) {
  const { windows, onScreen } = quotaWindows(limits, current, usage);
  // App's five-second clock rerenders this pane even when the snapshot is unchanged.
  const now = Date.now(), observed = onScreen ? usage?.limitsAt : limits?.observedAtMs;
  const updated = typeof observed === 'number' ? t('{time} 更新', { time: resetTime(observed) }) : null;
  const notes = limits && windows.length ? [reachedLine(limits), limits.state === 'stale' ? t('数据可能已过期') : null].filter((line): line is string => !!line) : [];
  const bar = (window: QuotaWindow) => {
    const name = limitName(window.minutes), expired = window.resetsAt != null && window.resetsAt <= now;
    const percent = expired ? null : window.percent;
    const label = percent == null ? undefined : t('{name}已用 {percent}%', { name, percent: Math.round(percent) });
    return <Metric key={window.minutes ?? 'unknown'} className="activity-limit" label={name} percent={percent ?? undefined} meterLabel={label}
      value={percent == null ? t('未知') : `${Math.round(percent)}%`}
      valueTitle={percent == null ? undefined : [`${percent.toFixed(1)}%`, updated].filter(Boolean).join(' · ')}
      note={expired ? t('已到重置时间，等待更新') : window.resetsAt != null ? t('{time} 重置', { time: resetTime(window.resetsAt) }) : undefined} />;
  };
  const grouped = groups?.map(({ id, label }) => label ? <div className="api-quota-group" role="group" aria-label={label} key={id}>
    <h5 className="api-quota-group-title">{label}</h5>
    {limitWindows(limits, id).map(bar)}
  </div> : limitWindows(limits, id).map(bar));
  return <>
    {windows.length ? grouped || windows.map(bar) : <Metric className="activity-tokens" label={t('额度')} note={limitLines(limits).join(' · ')} />}
    {notes.map(line => <Metric key={line} className="activity-tokens" label={t('额度')} note={line} />)}
  </>;
}

// The API spend, today and this month, as one row of information. Agentrix sets no limit of its own to measure it against, so it has no bar.
const ApiSpend = ({ usage }: { usage: NativeUsage }) =>
  <Metric className="activity-tokens" label={t('API 花费')} note={`${t('今天')} ${money(usage.todayUsdMicros)} · ${t('本月 {amount}', { amount: money(usage.monthUsdMicros) })}`} />;

// The models the project runs, per agent: its main sessions' (by the agent that runs them) and, with the team on, the enabled roles' seats.
export function modelsInUse(terminals: readonly ProjectTerminal[], seats: SeatsInfo | null) {
  const used: ModelsInUse = {};
  const add = (agent: NativeAgent | null | undefined, model: string | null | undefined) => { if (agent && model) (used[agent] ??= []).push(model); };
  for (const { cliActive, agent, agentUsage, agentSettings } of terminals) if (cliActive) add(agent, agentUsage?.model || agentSettings?.model);
  if (seats?.conductor) for (const role of seats.roles) if (role.enabled !== false) {
    const model = displayedSeat(seats, role.id)?.model;
    add(model ? agentOfModel(model) : null, model);
  }
  return used;
}

// A group of an allowance split by model, and its name when the block shows it.
type QuotaGroup = { id: string; label: string | null };
// The groups main reported that the agent's models draw on, unnamed when there is one. When no model in use matches one, every reported group shows, each named.
function shownGroups(display: UsageDisplay, limits: LimitsPayload | null | undefined, models: readonly string[] = []): QuotaGroup[] {
  const buckets = limits?.limitsById ?? {}, used = new Set(models.map(model => display.quotaGroup!(model)));
  const reported = [...new Set([...Object.keys(display.quotaGroups ?? {}), ...Object.keys(buckets)])].filter(id => limitWindows(limits, id).length);
  const matched = reported.filter(id => used.has(id)), ids = matched.length ? matched : reported;
  const named = ids.length > 1 || !matched.length;
  return ids.map(id => ({ id, label: named ? t(display.quotaGroups?.[id] ?? buckets[id]?.limitName ?? '额度') : null }));
}

// How the agent runs: the session in view's own way, else how its next session starts; null when that is not known.
function channelOf(agent: NativeAgent, state: NativeUsage['agents'][NativeAgent] | undefined, terminal: ProjectTerminal, current: boolean) {
  const manifest = adapterOf(agent)?.manifest, path = state?.next?.path;
  // Every Codex session runs on app-server; a legacy PTY snapshot needs restoration, not a second supported run mode.
  if (manifest && !support(manifest, 'terminal').ok && support(manifest, 'native').ok) {
    return current || path ? current && terminal.sessionId ? t('需用原生模式恢复') : t('原生模式') : null;
  }
  if (current) return terminal.nativeMode ? t('原生模式') : t('终端模式');
  return path === 'api' ? t('原生模式') : path === 'terminal' ? t('终端模式') : null;
}

function AgentSection({ agent, usage, terminal, projectId, models }: {
  agent: NativeAgent; usage: NativeUsage | null; terminal: ProjectTerminal; projectId?: string; models?: readonly string[];
}) {
  const state = usage?.agents[agent], kind = state?.connection?.kind, notice = noticeWords(state?.limits?.notice);
  // The session in view belongs to one agent; only it has a round.
  const current = terminal.cliActive && terminal.agent === agent, tokens = terminal.agentUsage;
  const manifest = adapterOf(agent)?.manifest, display = manifest?.usage, label = display?.label ?? manifest?.label ?? agent;
  const grouped = !!display?.quotaGroup, useScreen = current && !grouped;
  const unavailable = state?.limits?.state === 'unavailable' ? state.limits.reason || display?.quotaUnavailable : undefined;
  const channel = channelOf(agent, state, terminal, current);
  const rows = current ? ([[t('本轮'), tokens?.round], [t('本次对话'), tokens?.total]] as const).filter(([, counted]) => counted) : [];
  // A session that reported plan windows of its own is on a plan even when main could not tell the connection (a terminal session): its bars show, and it is not 额度 未知.
  const plan = !unavailable && (kind === 'subscription' || (kind !== 'api' && (grouped
    ? windowsOf(state?.limits).some(Boolean) : useScreen && windowsFromScreen(tokens).length > 0)));
  const unknown = !unavailable && !plan && kind !== 'api';
  // The console button is the owner's way to check a rejection for balance, shown only next to the notice that says it.
  const checkNotice = !!notice && !!projectId && consoleCheck(state?.limits?.notice);
  // Only Claude on the API, and only once main has a spend record, has a spend row; Codex on the API has nothing of its own, so no empty block.
  const spend = display?.apiSpend && kind === 'api' && !!usage?.apiRecords;
  const quotaNote = plan ? quotaUnavailable(!!display?.showUnavailable, state?.limits, useScreen, tokens) : null;
  const groups = grouped && plan ? shownGroups(display!, state?.limits, models) : undefined;
  const Brand = brandIconOf(agent);
  return <section className="api-agent" aria-label={label}>
    <h4 className="api-agent-title"><Brand size={14} />{label}</h4>
    {(channel || unavailable || unknown) && <dl className="api-usage">
      {channel && <Row label={t('通道')}><span>{channel}</span></Row>}
      {unavailable ? <Row label={t('额度')}><span>{t(unavailable)}</span></Row> : unknown && <Row label={t('额度')}><span>{t('未知')}</span></Row>}
    </dl>}
    {(plan || spend || rows.length > 0) && <div className="activity-metrics">
      {plan && <QuotaMetrics limits={state?.limits} current={useScreen} usage={tokens} groups={groups} />}
      {spend && <ApiSpend usage={usage} />}
      {rows.map(([label, counted]) => <TokenMetric key={label} label={label} tokens={counted!} />)}
    </div>}
    {notice && <p className="activity-note" role="status">{[notice.text, notice.resets].filter(Boolean).join(' · ')}</p>}
    {notice && checkNotice && <BillingLink projectId={projectId} />}
    {quotaNote && <p className="activity-note" data-usage-detail>{quotaNote}</p>}
    {current && tokens?.context && !tokens.round && <p className="activity-note" data-usage-detail>{t('本轮从更早的记录开始，暂无法统计。')}</p>}
    {current && display?.resetCredits && plan && <ResetQuota key={`${terminal.id}:${terminal.sessionId}:${terminal.agentStartedAt}`} terminal={terminal} />}
  </section>;
}

export function AgentSections({ usage, terminal, projectId, installations, models = {} }: {
  usage: NativeUsage | null; terminal: ProjectTerminal; projectId?: string; installations?: Installations | null; models?: ModelsInUse;
}) {
  return <div className="api-agents">{AGENTS.map(({ manifest }) => {
    const agent = manifest.id, current = terminal.cliActive && terminal.agent === agent, state = usage?.agents[agent];
    const hasUsage = installations?.[agent]?.installed !== false && (state?.connection?.active || state?.limits);
    if (manifest.usage?.hideWithoutUsage && !current && !hasUsage) return null;
    return <AgentSection key={agent} agent={agent} usage={usage} terminal={terminal} projectId={projectId} models={models[agent]} />;
  })}</div>;
}

// The routing the project runs, for the models its roles use; read again when routing changes.
function useSeats(projectId: string | undefined, terminalId: string, sessionId: string | null) {
  const [info, setInfo] = useState<SeatsInfo | null>(null);
  useEffect(() => {
    const api = typeof window === 'undefined' ? undefined : window.agentrix;
    if (!api?.routingSeats) return;
    let active = true, request = 0;
    const load = () => {
      const mine = ++request;
      void api.routingSeats(projectId ?? null, terminalId).then(
        next => { if (active && request === mine) setInfo(next); },
        () => { if (active && request === mine) setInfo(null); },
      );
    };
    setInfo(null); load();
    const off = api.onRouting?.(load);
    return () => { active = false; off?.(); };
  }, [projectId, terminalId, sessionId]);
  return info;
}

// A pane belongs to one project for its whole life (the app keys each project's panel by its id), so the state below never changes project.
export function ApiUsage({ terminal, terminals = [terminal], projectId, installations }: {
  terminal: ProjectTerminal; terminals?: readonly ProjectTerminal[]; projectId?: string; installations?: Installations | null;
}) {
  const bridge = nativeBridge(), revision = useUsageRevision(projectId);
  const key = projectId || '';
  const [usage, setUsage] = useState<NativeUsage | null>(() => observations.get(key)?.bridge === bridge ? observations.get(key)!.usage : null), [error, setError] = useState<string | null>(null);
  // The reader the timer effect below installs; the revision effect calls it at most once per REVISION_DELAY_MS.
  const reader = useRef<{ read: () => void; last: number; timer: ReturnType<typeof setTimeout> | null }>({ read: () => {}, last: 0, timer: null });
  const seen = useRef(revision);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const state = reader.current;
    const read = async () => {
      state.last = Date.now();
      const result = await bridge.usage(projectId).catch((failure: unknown) => ({ ok: false as const, error: failure instanceof Error ? failure.message : String(failure) }));
      if (!active) return;
      if (result.ok) { observe(key, bridge, result.value); setUsage(result.value); setError(null); } else setError(result.error);
    };
    state.read = () => void read();
    const first = setTimeout(state.read, 0), again = setInterval(state.read, REFRESH_MS);
    return () => { active = false; clearTimeout(first); clearInterval(again); if (state.timer) clearTimeout(state.timer); state.timer = null; state.read = () => {}; };
  }, [projectId]);
  // A change main reports reads at once, unless a read ran within the last second: then one read closes that window. The 60 s timer is not touched.
  useEffect(() => {
    if (revision === seen.current) return;
    seen.current = revision;
    const state = reader.current, wait = state.last + REVISION_DELAY_MS - Date.now();
    if (wait <= 0) state.read();
    else if (!state.timer) state.timer = setTimeout(() => { state.timer = null; state.read(); }, wait);
  }, [revision]);
  const seats = useSeats(projectId, terminal.id, terminal.sessionId);
  // Without the bridge there is no one to ask; the card still tells a running session's bars and tokens.
  if (!bridge && !terminal.cliActive) return null;
  const label = t('运行方式与额度');
  return <section className="activity-card activity-api" aria-label={label}>
    <h3 className="activity-card-title">{label}</h3>
    {error && !usage && <p className="activity-note" role="alert">{t('无法读取额度：{message}', { message: error })}</p>}
    <AgentSections usage={usage} terminal={terminal} projectId={projectId} installations={installations} models={modelsInUse(terminals, seats)} />
  </section>;
}
