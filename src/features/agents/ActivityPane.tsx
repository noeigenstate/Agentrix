import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowCounterClockwise, CheckCircle, Circle, CircleNotch, Record as RecordDot } from '@phosphor-icons/react';
import type { AgentCall, AgentTokens, AgentUsage, ProjectTerminal, TokenRate } from '../../shared/types';
import { t } from '../../shared/i18n';
import { modelName } from '../reading/model-name';
import { useNow } from '../reading/useNow';
import { readScreen, subscribeScreen } from '../terminal/terminal-screen';
import { sendToAgent } from '../home/send-to-agent';
import { ClaudeLogo, CodexLogo } from './AgentBrandIcon';
import { actionText } from './action-text';
import { ResetCountdown } from './ResetCountdown';
import { codexResetCount, codexResetsSaid } from './reset-count';
import './activity-pane.css';

// 1234 → "1.2k", 828400 → "828k", 23898406 → "23.9M": token counts the way a person reads them at a glance.
export function tokenCount(value: number) {
  if (value < 1000) return String(Math.round(value));
  if (value < 1e6) return `${(value / 1e3).toFixed(value < 1e4 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(value / 1e6).toFixed(value < 1e7 ? 2 : 1).replace(/\.?0+$/, '')}M`;
}
const exactCount = (value: number) => value.toLocaleString('en-US');
const percentOf = (part: number, whole: number) => whole > 0 ? Math.min(100, Math.round(part / whole * 100)) : 0;

// Beside an expanded project's terminal: the main model with what it is working on, the sub-agents it called, context and usage.
export function ActivityPane({ terminal }: { terminal: ProjectTerminal }) {
  const calls = terminal.agentUsage?.calls;
  return <aside className="activity-pane" aria-label={t('活动')}>
    {terminal.codexActive ? <MainCard terminal={terminal} /> : <section className="activity-card">
      <p className="activity-empty">{t('在终端里启动 Codex 或 Claude Code 后，这里显示它的主模型、任务、上下文长度和用量。')}</p>
    </section>}
    {terminal.codexActive && !!calls?.length && <CallsCard calls={calls} />}
    {terminal.codexActive && <div className="activity-gauges">
      <ContextCard usage={terminal.agentUsage} />
      <UsageCard usage={terminal.agentUsage} terminal={terminal} />
    </div>}
  </aside>;
}

// How fast a model writes, at the right end of its head: the average over its recent replies (output tokens per second of the time it spent writing). The column is a fixed width, so
// a figure arriving or changing moves nothing. Not yet a finished reply: waiting. Records that cannot be read: a dash, and the tooltip says so.
function Rate({ rate }: { rate: TokenRate | null | undefined }) {
  const partial = rate?.partial ? '\n' + t('（部分记录）') : '';
  if (rate && rate.samples > 0 && rate.activeMs > 0) {
    const title = t('平均输出速率：最近 {samples} 条回复，共 {tokens} token，用时 {seconds} 秒', { samples: rate.samples, tokens: exactCount(rate.outputTokens), seconds: (rate.activeMs / 1000).toFixed(1) }) + partial;
    return <span className="activity-row-end activity-rate is-live" title={title}>{Math.round(1000 * rate.outputTokens / rate.activeMs)} token/s</span>;
  }
  if (rate) return <span className="activity-row-end activity-rate" title={t('还没有完成一条回复，暂时没有速率。') + partial}>{t('等待中')}</span>;
  return <span className="activity-row-end activity-rate" title={t('这个模型的记录在这里读不到，所以没有速率。')}>— token/s</span>;
}

// A head row: the model's mark, its name and service (the service gives way first when the pane is narrow), an optional tag, and its rate.
function ModelHead({ Mark, name, provider, tag, title, rate }: { Mark: typeof ClaudeLogo; name: string; provider: string | null | undefined; tag?: string; title: string; rate: TokenRate | null | undefined }) {
  return <li className="activity-call-head" title={title}>
    <span className="activity-row-icon"><Mark size={16} /></span>
    <p><b>{name}</b>{provider && <span className="activity-call-provider">{provider}</span>}{tag && <span className="activity-call-tag">{tag}</span>}</p>
    <Rate rate={rate} />
  </li>;
}

// The prompt each terminal's agent last worked on (kept across the pane closing and opening), for the finished row.
const workedPrompts = new Map<string, { session: string | null; summary: string; text: string }>();
// The main agent: its model as its latest reply records it (the configured one only until there is a reply, or in the tooltip when they differ), how it runs, its rate, and what it is doing.
// What it is doing is its prompts, in order (the one being worked on with its spinner and clock, then those waiting), and under the working one the step it is on. A prompt is only ever a
// real one the user sent (the queue leaves out sub-agent messages and background notifications); with none tracked the row says the agent's state in words and invents no task. When a round
// ends, the prompt it worked on stays as the finished row, until another round starts. A step shows only while it is under way and the agent is working, never after.
function MainCard({ terminal }: { terminal: ProjectTerminal }) {
  const usage = terminal.agentUsage, settings = terminal.agentSettings, agent = terminal.agent === 'claude' ? 'Claude Code' : 'Codex';
  const actual = usage?.model || null, configured = settings?.model || null, model = actual ?? configured, name = model ? modelName(model) : agent;
  const how = [settings?.effort && t('思考 {effort}', { effort: settings.effort === 'default' ? t('默认') : settings.effort }),
    settings?.fast != null && (settings.fast ? t('快速模式') : t('普通模式'))].filter(Boolean).join(' · ');
  const title = [[agent, usage?.provider, model && name].filter(Boolean).join(' / '),
    actual && configured && actual !== configured && t('设置为 {configured}，实际回复来自 {actual}', { configured: modelName(configured), actual: name })].filter(Boolean).join('\n');
  const now = useNow(Date.now), activity = terminal.codexActivity, prompts = terminal.prompts || [], working = prompts.find(prompt => prompt.state === 'working');
  // A round with a prompt of its own is remembered for its finished row; one without (a background notification) forgets it, so a stale task is never shown for it.
  if (activity === 'working') { if (working) workedPrompts.set(terminal.id, { session: terminal.sessionId, summary: working.summary, text: working.text }); else workedPrompts.delete(terminal.id); }
  const last = workedPrompts.get(terminal.id), ended = !prompts.length && (activity === 'complete' || activity === 'interrupted') && last?.session === terminal.sessionId ? last : null;
  const action = terminal.action, running = !!action && !action.done && activity === 'working';
  const state = activity === 'working' ? t('正在处理') : activity === 'complete' ? t('本轮已完成') : activity === 'interrupted' ? t('已中断') : t('等待下一步');
  const step = running && <li className="is-step" title={action.detail || action.target}>
    <span className="activity-row-icon">{CALL_STATES.running.icon}</span><p><span className="activity-call-role">{t('正在')}</span>{actionText(action)}</p><span />
  </li>;
  const task = (icon: ReactNode, className: string, word: string, summary: string, text: string, time: string) => <li className={className} title={`${text}\n${word}${time ? ` · ${time}` : ''}`}>
    <span className="activity-row-icon">{icon}</span><p><span className="activity-call-role">{word}</span>{summary}</p><time>{time}</time>
  </li>;
  return <section className="activity-card activity-main" aria-label={t('主模型')}>
    <h4 className="activity-card-title">{t('主模型')}</h4>
    <ul className="activity-call-rows">
      <ModelHead Mark={terminal.agent === 'claude' ? ClaudeLogo : CodexLogo} name={name} provider={usage?.provider} title={title} rate={usage?.rate} />
      <li className="activity-call-note"><span /><p>{model ? how || t('按默认设置运行') : t('第一次回复后显示模型。')}</p><span /></li>
    </ul>
    <ul className="activity-call-rows activity-main-tasks" aria-label={t('提示')}>
      {prompts.map(prompt => <Fragment key={prompt.id}>
        {task(prompt.state === 'working' ? CALL_STATES.running.icon : <Circle size={14} aria-hidden="true" />, prompt.state === 'working' ? 'is-working' : 'is-queued', t(prompt.state === 'working' ? '处理中' : '排队中'),
          prompt.summary, prompt.text, prompt.at ? elapsedClock(now - prompt.at) : '')}
        {prompt === working && step}
      </Fragment>)}
      {!prompts.length && (ended
        ? task(activity === 'complete' ? <CheckCircle size={14} weight="fill" aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />, activity === 'complete' ? 'is-done' : 'is-idle', state, ended.summary, ended.text,
          activity === 'complete' && terminal.lastCompletedAt ? resetTime(terminal.lastCompletedAt) : '')
        : <><li className="is-idle"><span className="activity-row-icon"><Circle size={14} aria-hidden="true" /></span><p>{state}</p><span /></li>{step}</>)}
    </ul>
  </section>;
}

// A call's state: the icon in the row's 16px box and the word at its right. Running is the one colour (the spinner).
const CALL_STATES = {
  preparing: { word: '准备中', icon: <Circle size={14} aria-hidden="true" /> },
  running: { word: '运行中', icon: <CircleNotch size={14} weight="bold" className="loading-spinner" aria-hidden="true" /> },
  reviewing: { word: '审核中', icon: <RecordDot size={14} aria-hidden="true" /> },
} as const;
const MAX_CALL_ITEMS = 4;

// The sub-agents the agent called (everything in the calls is a worker it spawned, so every group is tagged as one): per model one head (its mark, name, service and rate), how it runs under it, then a row for each of its calls
// (the state's icon, the role and what it does, the state in words). The heading counts every call; a model's calls past the fourth fold into "+N".
function CallsCard({ calls }: { calls: AgentCall[] }) {
  return <section className="activity-card activity-calls" aria-label={t('调用的模型')}>
    <h4 className="activity-card-title">{t('调用的模型')}<span className="activity-count">{calls.reduce((sum, call) => sum + call.items.length, 0)}</span></h4>
    <ul className="activity-call-groups">
      {calls.map(call => {
        const Mark = call.agent === 'Codex' ? CodexLogo : ClaudeLogo, name = modelName(call.model);
        const how = [call.effort, call.fast != null && (call.fast ? t('快速') : t('普通模式'))].filter(Boolean).join(' · ');
        return <li key={JSON.stringify([call.agent, call.provider, call.model, call.effort, call.fast])}>
          <ul className="activity-call-rows">
            <ModelHead Mark={Mark} name={name} provider={call.provider} tag={t('子代理')} title={[[call.agent, call.provider, name].filter(Boolean).join(' / '), t('子代理')].join('\n')} rate={call.rate} />
            {how && <li className="activity-call-note"><span /><p>{how}</p><span /></li>}
            {call.items.slice(0, MAX_CALL_ITEMS).map((item, index) => <li key={index} className={`is-${item.state}`} title={item.title}>
              <span className="activity-row-icon">{CALL_STATES[item.state].icon}</span>
              <p><span className="activity-call-role">{t(item.role)}</span>{item.title}</p>
              <span className="activity-row-end">{t(CALL_STATES[item.state].word)}</span>
            </li>)}
            {call.items.length > MAX_CALL_ITEMS && <li className="activity-call-more"><span /><p>{t('+{count} 个', { count: call.items.length - MAX_CALL_ITEMS })}</p></li>}
          </ul>
        </li>;
      })}
    </ul>
  </section>;
}

// One metric on an 88 | meter | 48 grid: a label, an optional meter, the figure in the pane's one right-hand number column, and a caption under the meter.
// The meter's fill is neutral; from 90% it, and the figure, take the warning colour.
function Metric({ label, value, valueTitle, percent, meterLabel, note, title, className }: {
  label: ReactNode; value?: string; valueTitle?: string; percent?: number | null; meterLabel?: string; note?: string; title?: string; className?: string;
}) {
  return <div className={`activity-metric${percent != null && percent >= 90 ? ' is-warn' : ''}${className ? ` ${className}` : ''}`} title={title}>
    <span className="activity-metric-label">{label}</span>
    {percent !== undefined && <Meter percent={percent} label={meterLabel ?? ''} />}
    {value && <b title={valueTitle}>{value}</b>}
    {note && <small>{note}</small>}
  </div>;
}

// The context the conversation fills now, out of the model's window, as a metric block like the plan's limits (the title is its label). A window that is not known shows "—", not 0%.
function ContextCard({ usage }: { usage: AgentUsage | null | undefined }) {
  const context = usage?.context, windowKnown = !!context && context.window > 0;
  const percent = context ? percentOf(context.used, context.window) : 0;
  return <section className="activity-card activity-context" aria-label={t('上下文长度')}>
    {context ? <Metric className="activity-figure" label={t('上下文长度')} percent={windowKnown ? percent : undefined} value={windowKnown ? `${percent}%` : '—'}
      meterLabel={t('上下文已用 {percent}%', { percent })} title={`${exactCount(context.used)} / ${exactCount(context.window)} tokens`}
      note={windowKnown ? t('共 {window} tokens · 还可容纳 {count}', { window: tokenCount(context.window), count: tokenCount(Math.max(0, context.window - context.used)) })
        : t('已用 {count} tokens，窗口大小未知', { count: tokenCount(context.used) })} />
      : <Metric label={t('上下文长度')} note={t('第一次回复后显示。')} />}
  </section>;
}

// The plan's allowance used, then the tokens of this round and this conversation.
function UsageCard({ usage, terminal }: { usage: AgentUsage | null | undefined; terminal: ProjectTerminal }) {
  const claude = terminal.agent === 'claude';
  const limits = usage?.limits || [], rows = [[t('本轮'), usage?.round], [t('本次对话'), usage?.total]] as const;
  const known = rows.filter(([, tokens]) => tokens);
  // App's five-second clock rerenders this pane even when the usage snapshot is unchanged.
  const now = Date.now(), updated = usage?.limitsAt != null ? t('{time} 更新', { time: resetTime(usage.limitsAt) }) : null;
  const limitNote = usage?.limitsAt == null ? t('账号额度暂不可用。') : usage.limitsFrom === 'CodePulse'
    ? t('额度来自 CodePulse 状态记录，{time} 写入', { time: resetTime(usage.limitsAt) })
    : t('额度来自 {source}，{time} 更新', { source: usage.limitsFrom || 'Claude Code', time: resetTime(usage.limitsAt) });
  return <section className="activity-card activity-usage" aria-label={t('用量')}>
    {(limits.length > 0 || known.length > 0) && <div className="activity-metrics">
      {limits.map(limit => {
        const name = limitName(limit.minutes), expired = limit.resetsAt != null && limit.resetsAt <= now;
        const label = expired ? t('已重置，等待更新') : t('{name}已用 {percent}%', { name, percent: Math.round(limit.percent) });
        return <Metric key={limit.minutes ?? 0} className="activity-limit" label={name} percent={expired ? null : limit.percent} meterLabel={label}
          value={expired ? undefined : `${Math.round(limit.percent)}%`} valueTitle={[`${limit.percent.toFixed(1)}%`, updated].filter(Boolean).join(' · ')}
          note={expired ? label : limit.resetsAt != null ? t('{time} 重置', { time: resetTime(limit.resetsAt) }) : undefined} />;
      })}
      {known.map(([label, tokens]) => <TokenMetric key={label} label={label} tokens={tokens!} />)}
    </div>}
    {!known.length && !usage?.context && <p className="activity-note">{t('第一次回复后显示。')}</p>}
    {usage?.context && !usage.round && <p className="activity-note">{t('本轮从更早的记录开始，暂无法统计。')}</p>}
    {usage?.context && !usage.total && <p className="activity-note">{t('本次对话的总量在更早的记录里。')}</p>}
    {!claude && <ResetQuota key={`${terminal.id}:${terminal.sessionId}:${terminal.agentStartedAt}`} terminal={terminal} />}
    {claude && <p className="activity-note">{limitNote}</p>}
  </section>;
}

// What Codex last said on its screen of the resets left, per terminal.
const resetsSaid = new Map<string, number>();
function useResetsSaid(terminal: ProjectTerminal) {
  const key = `${terminal.agent}:${terminal.id}:${terminal.sessionId}:${terminal.agentStartedAt}`;
  const [said, setSaid] = useState(() => resetsSaid.get(key) ?? null);
  useEffect(() => {
    setSaid(resetsSaid.get(key) ?? null);
    const read = (rows: readonly string[]) => {
      const now = codexResetsSaid(rows);
      if (now !== null && now !== resetsSaid.get(key)) { resetsSaid.set(key, now); setSaid(now); }
    };
    const current = readScreen(terminal.id); if (current) read(current.rows);
    const unsubscribe = subscribeScreen(terminal.id, screen => read(screen.rows));
    return () => { unsubscribe(); resetsSaid.delete(key); };
  }, [key]);
  return said;
}

// Using one of the plan's limit resets is costly and never happens at once: a click starts a ten-second countdown, shown
// large over the whole window, that the reader can cancel at any moment, and only then does Codex get /usage as a typed
// command, where it asks which reset to use and to confirm. Agentrix itself never calls a reset. Closing the pane or
// switching terminals (or the agent stopping) unmounts this and so cancels the countdown.
const COUNTDOWN = 10;
// Why the number of resets is not known: a short form for the row's right-hand slot (which must leave the label whole) and the whole sentence for its hover.
function queryStatus(query: AgentUsage['resetQuery']) {
  if (query?.state === 'loading') return { short: t('查询中…'), full: t('正在查询剩余次数…') };
  if (query?.reason === 'remote') return { short: t('暂不支持'), full: t('远程账号暂不支持后台查询') };
  if (query?.reason === 'provider') return { short: t('暂不支持'), full: t('当前接口不提供重置次数') };
  if (query?.reason === 'scope') return { short: t('无法确认'), full: t('无法确认账号环境，暂不能查询') };
  if (query?.state === 'error') return { short: t('查询失败'), full: t('查询失败，将自动重试') };
  return { short: t('次数未知'), full: t('当前账号或 Codex 版本未提供次数，将自动重试') };
}
function ResetQuota({ terminal }: { terminal: ProjectTerminal }) {
  const left = codexResetCount(terminal.agentUsage, useResetsSaid(terminal)), unknown = queryStatus(terminal.agentUsage?.resetQuery);
  const [count, setCount] = useState<number | null>(null), [note, setNote] = useState<string | null>(null);
  const row = useRef<HTMLButtonElement>(null), counted = useRef(false), fired = useRef(false);
  const command = '/usage';
  useEffect(() => {
    if (count === null) return;
    // Once per countdown, whatever renders again meanwhile.
    if (count === 0) { setCount(null); if (!fired.current) { fired.current = true; void run(); } return; }
    const timer = window.setTimeout(() => setCount(count - 1), 1000);
    return () => clearTimeout(timer);
  }, [count]);
  // Whatever ends the countdown, focus goes back to the row that started it.
  useEffect(() => { if (count === null && counted.current) row.current?.focus(); counted.current = count !== null; }, [count]);
  useEffect(() => { if (!note) return; const timer = window.setTimeout(() => setNote(null), 8000); return () => clearTimeout(timer); }, [note]);
  const run = async () => {
    // A reading view of this terminal takes it as its own composer would (its popup shows what the agent answers);
    // otherwise it goes into the agent's input as typed.
    const event = new CustomEvent('agentrix:command', { detail: { terminalId: terminal.id, text: command }, cancelable: true });
    const failed = window.dispatchEvent(event) && terminal.sessionId ? await sendToAgent(terminal.id, terminal.sessionId, 'codex', command) : null;
    setNote(failed ?? t('已打开 Codex 的 /usage，在那里选择要用的重置并确认。'));
  };
  // A 32px row on the task grid: the icon, the label and, in the right-hand slot, how many resets are left, or why that is not known, or that it is counting down. The countdown itself is the overlay.
  const counting = count !== null, status = counting ? t('倒计时中…') : left === 0 ? t('已用完') : left !== null ? t('剩余 {count} 次', { count: left }) : unknown.short;
  const start = () => { fired.current = false; setNote(null); setCount(COUNTDOWN); };
  return <div className="activity-reset">
    <button ref={row} type="button" className="activity-reset-row activity-estop" disabled={counting || left === 0 || !terminal.codexActive}
      title={[left === null && unknown.full, t('点击后有 10 秒可以取消，然后由 {agent} 自己完成重置', { agent: 'Codex' })].filter(Boolean).join('\n')} onClick={start}>
      <span className="activity-row-icon"><ArrowCounterClockwise size={14} aria-hidden="true" /></span>
      <span className="activity-reset-label">{t('重置额度')}</span>
      <small>{status}</small>
    </button>
    {note && <p className="activity-note" role="status">{note}</p>}
    {!!count && <ResetCountdown count={count} total={COUNTDOWN} onCancel={() => setCount(null)} />}
  </div>;
}

function TokenMetric({ label, tokens }: { label: string; tokens: AgentTokens }) {
  const parts = [t('输入 {count}', { count: tokenCount(tokens.input) }), tokens.input > 0 && tokens.cached > 0 && t('缓存命中 {percent}%', { percent: percentOf(tokens.cached, tokens.input) }), t('输出 {count}', { count: tokenCount(tokens.output) })].filter(Boolean);
  const title = [`${exactCount(tokens.input + tokens.output)} tokens`, t('输入 {count}', { count: exactCount(tokens.input) }), t('缓存命中 {count}', { count: exactCount(tokens.cached) }), t('输出 {count}', { count: exactCount(tokens.output) })].join(' · ');
  return <Metric className="activity-tokens" label={label} title={title} note={parts.join(' · ')} />;
}

function Meter({ percent, label }: { percent: number | null; label: string }) {
  if (percent === null) return <span className="activity-meter is-expired" aria-hidden="true" />;
  const value = Math.max(0, Math.min(100, percent));
  return <span className="activity-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)} aria-label={label}><i style={{ width: `${value}%` }} /></span>;
}

// A rate-limit window by its length: 5 hours, a week.
function limitName(minutes: number | null) {
  if (minutes === 10080) return t('每周额度');
  if (minutes === 1440) return t('每日额度');
  if (minutes && minutes % 60 === 0) return t('{n} 小时额度', { n: minutes / 60 });
  return minutes ? t('{n} 分钟额度', { n: minutes }) : t('额度');
}
// When a window starts over: the time today, else the date and time.
function resetTime(at: number) {
  const date = new Date(at), today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString([], today ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

// How long a prompt has been going, as a clock: 2:14, or 1:05:09 past the hour.
export function elapsedClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000)), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}
