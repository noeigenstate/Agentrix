import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CaretDown, CheckCircle, Circle, WarningCircle } from '@phosphor-icons/react';
import type { CliState, ProjectTerminal, SeatsInfo } from '../../shared/types';
import { currentLanguage, t } from '../../shared/i18n';
import { modelName } from '../../shared/model-name';
import { useNow } from '../../shared/useNow';
import { readScreen, subscribeScreen, cliStateFor, nextCliState } from '../terminal/terminal-screen.ts';
import { useNativeEntries } from '../native-session/native-store.ts';
import { actionText } from './action-text';
import { CALL_STATES, ModelHead } from './AgentCalls';
import { resetTime } from './Metric';
import { elapsedClock } from '../../shared/elapsed-clock.ts';
// A terminal's last worked prompt supplies its finished row when the Agent tab reopens.
const workedPrompts = new Map<string, { session: string | null; summary: string; text: string }>();
export function useMainTurn(terminal: ProjectTerminal | undefined) {
  const id = terminal?.codexActive ? terminal.id : undefined;
  const sessionId = terminal?.sessionId;
  const [screen, setScreen] = useState(() => ({ id, frame: id ? readScreen(id) : null }));
  useEffect(() => {
    if (!id) return;
    setScreen({ id, frame: readScreen(id) });
    return subscribeScreen(id, frame => setScreen({ id, frame }));
  }, [id, sessionId]);
  const latestSignal = useRef<CliState | null>(null);
  if (!terminal?.codexActive) return null;
  const frame = screen.id === id ? screen.frame : readScreen(terminal.id);
  const signal = latestSignal.current = nextCliState(latestSignal.current, terminal);
  const cli = cliStateFor(terminal.agent === 'claude' ? 'claude' : 'codex', frame, terminal, signal);
  const hasState = !!signal || !!frame && (cli.input || cli.waiting || cli.working);
  const activity = cli.waiting ? 'waiting' : cli.working ? 'working' : hasState
    ? terminal.mainTurn?.state === 'interrupted' || terminal.mainTurn?.state === 'unknown' ? terminal.mainTurn.state : 'complete' : terminal.mainTurn?.state ?? terminal.codexActivity;
  const prompts = (terminal.prompts || []).filter(prompt => !hasState || prompt.state !== 'working' || cli.working || cli.waiting), working = prompts.find(prompt => prompt.state === 'working');
  const source = terminal.mainTurn?.background, background = activity === 'working' ? source : null;
  const summary = source ? t('处理后台结果：{summary}', { summary: source.summary }) + (source.count > 1 ? t(' 等 {count} 项', { count: source.count }) : '') : '';
  const current = source ? { session: terminal.sessionId, summary, text: source.text }
    : working ? { session: terminal.sessionId, summary: working.summary, text: working.text } : null;
  if (activity === 'working') { if (current) workedPrompts.set(terminal.id, current); else workedPrompts.delete(terminal.id); }
  const last = source ? current : workedPrompts.get(terminal.id);
  const ended = !prompts.length && (activity === 'complete' || activity === 'interrupted') && last?.session === terminal.sessionId ? last : null;
  return { terminal, cli, activity, prompts, working, background, summary, ended };
}

// The routing the conversation was started under and the one saved now, for the heading and the lead's chosen model.
function useSeats(terminalId: string | undefined, sessionId: string | null | undefined) {
  const [info, setInfo] = useState<SeatsInfo | null>(null);
  useEffect(() => {
    const api = typeof window === 'undefined' ? undefined : window.agentrix;
    if (!terminalId || !api?.skillSeats) return;
    let active = true, request = 0;
    const load = () => {
      const mine = ++request;
      void api.skillSeats(null, terminalId).then(
        next => { if (active && request === mine) setInfo(next); },
        () => { if (active && request === mine) setInfo(null); },
      );
    };
    setInfo(null); load();
    const off = api.onSkills?.(load);
    return () => { active = false; off?.(); };
  }, [terminalId, sessionId]);
  return info;
}

// "opus" names whichever Opus runs; a full id names one model.
function sameModel(chosen: string, actual: string) {
  const a = chosen.toLowerCase(), b = actual.toLowerCase();
  return a === b || modelName(chosen).toLowerCase() === modelName(actual).toLowerCase() || /^[a-z]+$/.test(a) && b.split(/[-\s]/).includes(a);
}

export function MainModelGroup({ terminal }: { terminal: ProjectTerminal | undefined }) {
  const turn = useMainTurn(terminal);
  const seats = useSeats(terminal?.codexActive ? terminal.id : undefined, terminal?.sessionId);
  return turn && <MainModel turn={turn} seats={seats} />;
}

export function MainModel({ turn, seats = null }: { turn: NonNullable<ReturnType<typeof useMainTurn>>; seats?: SeatsInfo | null }) {
  const { terminal, cli, activity, prompts, working, background, summary, ended } = turn;
  const usage = terminal.agentUsage, settings = terminal.agentSettings, agent = terminal.agent === 'claude' ? 'Claude Code' : 'Codex';
  const actual = usage?.model || null, configured = settings?.model || null, model = actual ?? configured, name = model ? modelName(model) : agent;
  const title = [[agent, usage?.provider, model && name].filter(Boolean).join(' / '),
    actual && configured && actual !== configured && t('设置为 {configured}，实际回复来自 {actual}', { configured: modelName(configured), actual: name })].filter(Boolean).join('\n');
  // A saved lead model reaches a conversation when it starts; a running one keeps the model it has.
  const chosen = seats?.leads?.[terminal.agent === 'claude' ? 'claude' : 'codex']?.model;
  const pending = chosen && actual && !sameModel(chosen, actual) ? /^[a-z]+$/.test(chosen) ? chosen[0].toUpperCase() + chosen.slice(1) : modelName(chosen) : null;
  const now = useNow(Date.now);
  const unknownEnd = activity === 'unknown' && terminal.mainTurn?.state === 'unknown';
  // Native turns distinguish a failure from an interruption only for their own runtime session.
  const native = useNativeEntries().get(terminal.id)?.model;
  const failedEnd = activity === 'interrupted' && !!terminal.nativeRuntimeSessionId
    && native?.identity?.runtimeSessionId === terminal.nativeRuntimeSessionId && native.turn.status === 'failed';
  const [fold, setFold] = useState<string | null>(null);
  const foldSession = terminal.sessionId ?? terminal.id;
  const expanded = fold === foldSession;
  const action = terminal.action, running = !!action && !action.done && activity === 'working';
  const endedAt = terminal.mainTurn?.updatedAt ?? terminal.lastCompletedAt;
  const state = activity === 'working' ? t('正在处理') : activity === 'complete' ? t('本轮已完成') : unknownEnd ? t('本轮已结束，完成状态未知。') : failedEnd ? t('失败') : t('已中断');
  const step = running && <li key="step" className="is-step" title={action.detail || action.target}>
    <span className="activity-row-icon">{CALL_STATES.running.icon}</span><p><span className="activity-call-role">{t('正在')}</span>{actionText(action)}</p><span />
  </li>;
  const task = (icon: ReactNode, className: string, word: string, summary: string, text: string, time: string, key = className) =>
    <li key={key} className={className} title={`${text}\n${word}${time ? ` · ${time}` : ''}`}>
      <span className="activity-row-icon">{icon}</span><p>{word && <span className="activity-call-role">{word}</span>}{summary}</p><time>{time}</time>
    </li>;
  const rows = [
    cli.waiting && <li key="waiting" className="is-idle" role="status">
      <span className="activity-row-icon"><WarningCircle size={14} /></span><p>{cli.message || t('等待你确认')}</p><span />
    </li>,
    background && task(CALL_STATES.running.icon, 'is-working', '', summary, background.text, elapsedClock(now - background.at)),
    activity === 'working' && !working && !background && task(CALL_STATES.running.icon, 'is-working',
      running ? t('正在') : '', running ? actionText(action) : state, running ? action.detail || action.target : state, ''),
    ...prompts.filter(prompt => prompt.state === 'working').flatMap(prompt =>
      prompt === working && !background && step ? [promptTask(prompt), step] : [promptTask(prompt)]),
    background && step,
    ...prompts.filter(prompt => prompt.state !== 'working').sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).map(promptTask),
  ].filter(Boolean);
  function promptTask(prompt: (typeof prompts)[number]) {
    const active = prompt.state === 'working' && activity === 'working', waiting = prompt === working && activity === 'waiting';
    return task(active ? CALL_STATES.running.icon : <Circle size={14} aria-hidden="true" />, active ? 'is-working' : waiting ? 'is-idle' : 'is-queued',
      t(active ? '处理中' : waiting ? '等待你确认' : '排队中'), prompt.summary, prompt.text, prompt.at ? elapsedClock(now - prompt.at) : '', prompt.id);
  }
  const hidden = Math.max(0, rows.length - 4);
  return <section className="activity-card activity-main agent-team-group" aria-label={t('主模型')}>
    <h4>{seats?.conductor === false ? t('主模型') : currentLanguage() === 'en' ? t('Agent 面板 · 总指挥') : '总指挥'}</h4>
    <ul className="activity-call-rows">
      <ModelHead agent={agent} name={name} effort={settings?.effort} fast={settings?.fast} provider={usage?.provider} title={title} rate={usage?.rate} />
      {!model && <li className="activity-call-note"><span /><p>{t('第一次回复后显示模型。')}</p><span /></li>}
      {pending && <li className="activity-call-note" role="status"><span /><p>{t('已选 {model}，新对话生效。', { model: pending })}</p><span /></li>}
    </ul>
    <ul className="activity-call-rows activity-main-tasks" data-expanded={expanded || undefined} aria-label={t('提示')}>
      {expanded ? rows : rows.slice(0, 4)}
      {hidden > 0 && <li className="activity-task-fold"><button type="button" aria-expanded={expanded} onClick={() => setFold(expanded ? null : foldSession)}>
        <CaretDown size={14} aria-hidden="true" />{expanded ? t('收起') : t('还有 {count} 条', { count: hidden })}
      </button></li>}
      {!prompts.length && !background && unknownEnd && <li className="is-idle"><span className="activity-row-icon"><Circle size={14} aria-hidden="true" /></span><p>{state}</p><span /></li>}
      {!prompts.length && !background && (activity === 'complete' || activity === 'interrupted') && (ended
        ? task(activity === 'complete' ? <CheckCircle size={14} weight="fill" aria-hidden="true" />
          : failedEnd ? <WarningCircle size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />,
          activity === 'complete' ? 'is-done' : 'is-idle', state, ended.summary, ended.text,
          activity === 'complete' && endedAt ? resetTime(endedAt) : '')
        : <li className="is-idle"><span className="activity-row-icon">{failedEnd ? <WarningCircle size={14} aria-hidden="true" />
          : <Circle size={14} aria-hidden="true" />}</span><p>{state}</p><span /></li>)}
    </ul>
  </section>;
}
