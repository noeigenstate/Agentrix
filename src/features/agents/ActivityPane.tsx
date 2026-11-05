import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle, Circle, WarningCircle } from '@phosphor-icons/react';
import type { CliState, ProjectTerminal } from '../../shared/types';
import { t } from '../../shared/i18n';
import { modelName } from '../../shared/model-name';
import { useNow } from '../../shared/useNow';
import { readScreen, subscribeScreen, cliStateFor, nextCliState } from '../terminal/terminal-screen.ts';
import { useNativeEntries } from '../native-session/native-store.ts';
import { actionText } from './action-text';
import { ApiUsage } from './ApiUsage';
import { CALL_STATES, ModelHead } from './AgentCalls';
import { resetTime } from './Metric';
import './activity-pane.css';

// Beside an expanded project's terminal, two blocks and nothing else: the main model with what it is working on, and each agent's run mode and allowance (ApiUsage).
// The models the agent called are in the left bar's Agent tab. The pane does not scroll as a whole; each block keeps its title and scrolls its own content.
export function ActivityPane({ terminal, projectId }: { terminal: ProjectTerminal; projectId?: string }) {
  return <aside className="activity-pane" aria-label={t('活动')}>
    {terminal.codexActive ? <MainCard terminal={terminal} /> : <section className="activity-card">
      <p className="activity-empty">{t('在终端里启动 Codex 或 Claude Code 后，这里显示它的主模型、任务、上下文长度和用量。')}</p>
    </section>}
    <ApiUsage terminal={terminal} projectId={projectId} />
  </aside>;
}


// The prompt each terminal's agent last worked on (kept across the pane closing and opening), for the finished row.
const workedPrompts = new Map<string, { session: string | null; summary: string; text: string }>();
// The main agent: its model as its latest reply records it (the configured one only until there is a reply, or in the tooltip when they differ), how it runs, its rate, and what it is doing.
// Prompts belong to the user; a delivered background result names the main agent's review separately.
// The main round can end while the project still waits for workers. Steps and spinners follow that round.
function MainCard({ terminal }: { terminal: ProjectTerminal }) {
  const usage = terminal.agentUsage, settings = terminal.agentSettings, agent = terminal.agent === 'claude' ? 'Claude Code' : 'Codex';
  const actual = usage?.model || null, configured = settings?.model || null, model = actual ?? configured, name = model ? modelName(model) : agent;
  const title = [[agent, usage?.provider, model && name].filter(Boolean).join(' / '),
    actual && configured && actual !== configured && t('设置为 {configured}，实际回复来自 {actual}', { configured: modelName(configured), actual: name })].filter(Boolean).join('\n');
  const [frame, setFrame] = useState(() => readScreen(terminal.id));
  useEffect(() => {
    setFrame(readScreen(terminal.id));
    return subscribeScreen(terminal.id, setFrame);
  }, [terminal.id, terminal.sessionId]);
  const latestSignal = useRef<CliState | null>(null);
  const signal = latestSignal.current = nextCliState(latestSignal.current, terminal);
  const cli = cliStateFor(terminal.agent === 'claude' ? 'claude' : 'codex', frame, terminal, signal);
  const hasState = !!signal || !!frame && (cli.input || cli.waiting || cli.working);
  const now = useNow(Date.now), activity = cli.waiting ? 'waiting' : cli.working ? 'working' : hasState
    ? terminal.mainTurn?.state === 'interrupted' || terminal.mainTurn?.state === 'unknown' ? terminal.mainTurn.state : 'complete' : terminal.mainTurn?.state ?? terminal.codexActivity;
  // A round that ended without saying how (the provider's status was unknown) is neither complete nor interrupted: a quiet line, no check.
  const unknownEnd = activity === 'unknown' && terminal.mainTurn?.state === 'unknown';
  // Main folds every turn that did not complete into 'interrupted'; the conversation's own turn status says which of them failed (a /compact that compacted nothing, say), as its card does.
  // Only for the session the card runs now: an agent typed by hand into the same terminal afterwards is another session, and its Esc is an interruption.
  const native = useNativeEntries().get(terminal.id)?.model;
  const failedEnd = activity === 'interrupted' && !!terminal.nativeRuntimeSessionId && native?.identity?.runtimeSessionId === terminal.nativeRuntimeSessionId && native.turn.status === 'failed';
  const prompts = (terminal.prompts || []).filter(prompt => !hasState || prompt.state !== 'working' || cli.working || cli.waiting), working = prompts.find(prompt => prompt.state === 'working');
  const source = terminal.mainTurn?.background, background = activity === 'working' ? source : null;
  const summary = source ? t('处理后台结果：{summary}', { summary: source.summary }) + (source.count > 1 ? t(' 等 {count} 项', { count: source.count }) : '') : '';
  const current = source ? { session: terminal.sessionId, summary, text: source.text } : working ? { session: terminal.sessionId, summary: working.summary, text: working.text } : null;
  if (activity === 'working') { if (current) workedPrompts.set(terminal.id, current); else workedPrompts.delete(terminal.id); }
  const last = source ? current : workedPrompts.get(terminal.id), ended = !prompts.length && (activity === 'complete' || activity === 'interrupted') && last?.session === terminal.sessionId ? last : null;
  const action = terminal.action, running = !!action && !action.done && activity === 'working';
  const endedAt = terminal.mainTurn?.updatedAt ?? terminal.lastCompletedAt;
  const state = activity === 'working' ? t('正在处理') : activity === 'complete' ? t('本轮已完成') : unknownEnd ? t('本轮已结束，完成状态未知。') : failedEnd ? t('失败') : t('已中断');
  const step = running && <li className="is-step" title={action.detail || action.target}>
    <span className="activity-row-icon">{CALL_STATES.running.icon}</span><p><span className="activity-call-role">{t('正在')}</span>{actionText(action)}</p><span />
  </li>;
  const task = (icon: ReactNode, className: string, word: string, summary: string, text: string, time: string) => <li className={className} title={`${text}\n${word}${time ? ` · ${time}` : ''}`}>
    <span className="activity-row-icon">{icon}</span><p>{word && <span className="activity-call-role">{word}</span>}{summary}</p><time>{time}</time>
  </li>;
  return <section className="activity-card activity-main" aria-label={t('主模型')}>
    <h4 className="activity-card-title">{t('主模型')}</h4>
    <ul className="activity-call-rows">
      <ModelHead agent={agent} name={name} effort={settings?.effort} fast={settings?.fast} provider={usage?.provider} title={title} rate={usage?.rate} />
      {!model && <li className="activity-call-note"><span /><p>{t('第一次回复后显示模型。')}</p><span /></li>}
    </ul>
    <ul className="activity-call-rows activity-main-tasks" aria-label={t('提示')}>
      {cli.waiting && <li className="is-idle" role="status"><span className="activity-row-icon"><WarningCircle size={14} /></span><p>{cli.message || t('等待你确认')}</p><span /></li>}
      {background && <>{task(CALL_STATES.running.icon, 'is-working', '', summary, background.text, elapsedClock(now - background.at))}{step}</>}
      {activity === 'working' && !working && !background && task(CALL_STATES.running.icon, 'is-working', running ? t('正在') : '', running ? actionText(action) : state, running ? action.detail || action.target : state, '')}
      {prompts.map(prompt => <Fragment key={prompt.id}>
        {task(prompt.state === 'working' && activity === 'working' ? CALL_STATES.running.icon : <Circle size={14} aria-hidden="true" />, prompt.state === 'working' && activity === 'working' ? 'is-working' : 'is-queued', t(prompt.state === 'working' && activity === 'working' ? '处理中' : activity === 'waiting' ? '等待你确认' : '排队中'),
          prompt.summary, prompt.text, prompt.at ? elapsedClock(now - prompt.at) : '')}
        {prompt === working && !background && step}
      </Fragment>)}
      {!prompts.length && !background && unknownEnd && <li className="is-idle"><span className="activity-row-icon"><Circle size={14} aria-hidden="true" /></span><p>{state}</p><span /></li>}
      {!prompts.length && !background && (activity === 'complete' || activity === 'interrupted') && (ended
        ? task(activity === 'complete' ? <CheckCircle size={14} weight="fill" aria-hidden="true" /> : failedEnd ? <WarningCircle size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />, activity === 'complete' ? 'is-done' : 'is-idle', state, ended.summary, ended.text,
          activity === 'complete' && endedAt ? resetTime(endedAt) : '')
        : <li className="is-idle"><span className="activity-row-icon">{failedEnd ? <WarningCircle size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}</span><p>{state}</p><span /></li>)}
    </ul>
  </section>;
}


// How long a prompt has been going, as a clock: 2:14, or 1:05:09 past the hour.
export function elapsedClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000)), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}
