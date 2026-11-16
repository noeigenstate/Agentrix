import { CaretRight, CheckCircle, Circle, CircleNotch, DotsThreeCircle, Record as RecordDot, Terminal, WarningCircle } from '@phosphor-icons/react';
import type { AgentCall, ProjectTerminal, TokenRate } from '../../shared/types';
import { t } from '../../shared/i18n';
import { elapsedClock } from '../../shared/elapsed-clock.ts';
import { callModelName } from '../../shared/call-model-name';
import { modelName } from '../../shared/model-name';
import { ClaudeLogo, CodexLogo } from './AgentBrandIcon';
import { exactCount } from './Metric';
import { type BackgroundRow, type CallRow, type CallSource, type RowState, backgroundCallId, backgroundEnd, callSources, isSplitOpen, noticeShown, projectCalls, toggleFinished, toggleSplit, useClock, useFinishedOpen, useSplits, waitMore } from './subagent-splits.ts';
import './activity-pane.css';

// How fast a model writes, at the right end of its head: the average over its recent replies (output tokens per second of the time it spent writing). The column is a fixed width, so
// a figure arriving or changing moves nothing. Not yet a finished reply: waiting. Records that cannot be read: a dash, and the tooltip says so.
// Output tokens per second of the time the replies took; null until a reply has finished.
export const rateValue = (rate: TokenRate | null | undefined) => rate && rate.samples > 0 && rate.activeMs > 0 ? Math.round(1000 * rate.outputTokens / rate.activeMs) : null;

function Rate({ rate }: { rate: TokenRate | null | undefined }) {
  const partial = rate?.partial ? '\n' + t('（部分记录）') : '';
  const value = rateValue(rate);
  if (rate && value !== null) {
    const title = t('平均输出速率：最近 {samples} 条回复，共 {tokens} token，用时 {seconds} 秒', { samples: rate.samples, tokens: exactCount(rate.outputTokens), seconds: (rate.activeMs / 1000).toFixed(1) }) + partial;
    return <span className="activity-row-end activity-rate is-live" title={title}>{value} token/s</span>;
  }
  if (rate) return <span className="activity-row-end activity-rate" title={t('还没有完成一条回复，暂时没有速率。') + partial}>{t('等待中')}</span>;
  return <span className="activity-row-end activity-rate" title={t('这个模型的记录在这里读不到，所以没有速率。')}>— token/s</span>;
}

// A head row: the name, recorded effort and speed, any non-default service (which gives way first), and a fixed rate column.
export function ModelHead({ agent, name, effort, fast, provider, title, rate }: { agent: AgentCall['agent']; name: string; effort?: string | null; fast?: boolean | null; provider: string | null | undefined; title: string; rate: TokenRate | null | undefined }) {
  const Mark = agent === 'Codex' ? CodexLogo : ClaudeLogo;
  const visibleProvider = provider === (agent === 'Codex' ? 'OpenAI' : 'Anthropic') ? null : provider;
  const how = [effort === 'default' ? t('默认') : effort, fast != null && (fast ? t('快速') : t('普通'))].filter(Boolean).join(' · ');
  return <li className="activity-call-head" title={[title, how].filter(Boolean).join('\n')}>
    <span className="activity-row-icon"><Mark size={16} /></span>
    <p><b>{name}</b>{how && <span className="activity-call-settings">{how}</span>}{visibleProvider && <span className="activity-call-provider">{visibleProvider}</span>}</p>
    <Rate rate={rate} />
  </li>;
}

// A call's state: the icon in the row's 16px box and the word at its right. Running is the one colour (the spinner).
export const CALL_STATES = {
  preparing: { word: '准备中', icon: <Circle size={14} aria-hidden="true" /> },
  running: { word: '运行中', icon: <CircleNotch size={14} weight="bold" className="loading-spinner" aria-hidden="true" /> },
  reviewing: { word: '审核中', icon: <RecordDot size={14} aria-hidden="true" /> },
  done: { word: '已完成', icon: <CheckCircle size={14} weight="fill" aria-hidden="true" /> },
  // A dispatched worker the dispatcher admitted but that has not confirmed it started; after 15 s its row carries a notice.
  starting: { word: '启动中 · 未确认', icon: <Circle size={14} aria-hidden="true" /> },
} as const;
const AWAITING_WORD = '等待你确认';
const MAX_CALL_ITEMS = 4;

// A dispatched worker that did not finish cleanly, in words in the state column (skills/agent-dispatch).
export function failureWord(failure: NonNullable<AgentCall['items'][number]['failure']>) {
  if (failure.reason === 'unconfirmed') return t('未能启动');
  if (failure.reason === 'capacity') return t('模型满载');
  if (failure.reason === 'killed') return t('已停止');
  if (failure.reason === 'scope') return t('越界');
  return failure.exitCode == null ? t('出错退出') : t('出错退出（代码 {code}）', { code: failure.exitCode });
}

// A model's row for one call (a plain function, so the card's element tree stays one level): its state in words (a starting or waiting one says so), the tags 继续 and 自启动, and, in the project's list, the terminal it belongs to.
// A call whose record can be read is one button on the row: it opens (or closes) a read-only view of that sub-agent beside the conversation.
function callItem({ row, open, now, label }: { row: CallRow; open: ReturnType<typeof useSplits>; now: number; label: boolean }) {
  const { item, terminalId, number } = row;
  const state = item.state as RowState, awaiting = item.awaiting === 'owner' && state !== 'done';
  const failure = item.failure ? failureWord(item.failure) : null, word = failure ?? t(awaiting ? AWAITING_WORD : CALL_STATES[state].word), opened = isSplitOpen(open, terminalId, item.id);
  // A dispatched worker that runs other settings than the lead declared says so in its tooltip.
  const declared = item.declared && t('分派时声明 {model} · {effort} · {mode}', { model: modelName(item.declared.model), effort: item.declared.effort ?? t('未报告'), mode: item.declared.fast == null ? t('未报告') : t(item.declared.fast ? '快速' : '普通') });
  const outside = item.failure?.files?.length ? t('改了允许范围之外的文件：{files}', { files: item.failure.files.join('、') }) : null;
  const cells = <>
    <span className="activity-row-icon">{failure ? <WarningCircle size={14} weight="fill" aria-hidden="true" /> : awaiting ? <DotsThreeCircle size={14} aria-hidden="true" /> : CALL_STATES[state].icon}</span>
    <span className="activity-call-text"><p>{item.title}</p><small className="activity-call-sub">{t(item.role)} · {word}
      {item.resumed && <span className="activity-call-pill" title={t('这一行由规划员续派唤醒。')}>{t('继续')}</span>}
      {item.source === 'intercepted' && <span className="activity-call-pill" title={t('由脚本自行启动，不是分派器启动。')}>{t('自启动')}</span>}</small></span>
    {label && <span className="activity-call-terminal">{t('终端 {number}', { number })}</span>}
  </>;
  const hint = item.viewable ? t(opened ? '点击关闭旁边的分屏' : '点击在旁边查看它在做什么') : null;
  const late = noticeShown(terminalId, item, now);
  return <li key={label ? `${terminalId}/${item.id}` : item.id} className={`activity-call-item is-${state}${failure ? ' is-failed' : ''}${awaiting ? ' is-awaiting' : ''}`} title={[item.title, failure, outside, declared, hint].filter(Boolean).join('\n')}>
    {item.viewable
      ? <button type="button" className={`activity-call-open activity-call-body${label ? ' has-terminal' : ''}`} aria-pressed={opened} aria-label={t('{role} {title}，{state}', { role: t(item.role), title: item.title, state: word })} onClick={() => toggleSplit(terminalId, item.id)}>{cells}</button>
      : <div className={`activity-call-body${label ? ' has-terminal' : ''}`}>{cells}</div>}
    {late && <div className="activity-call-notice" role="status">
      <WarningCircle size={14} aria-hidden="true" /><span>{t('已等 15 秒仍未确认，可能没有启动。')}</span>
      <button type="button" onClick={() => void window.agentrix.stopAgent(terminalId, item.id)}>{t('停止')}</button>
      <button type="button" onClick={() => waitMore(terminalId, item.id, now)}>{t('再等等')}</button>
    </div>}
  </li>;
}

// How long ago a background task last wrote: seconds, then minutes.
const outputAge = (ms: number) => ms < 120000 ? t('最后输出 {count} 秒前', { count: Math.max(0, Math.floor(ms / 1000)) }) : t('最后输出 {count} 分钟前', { count: Math.floor(ms / 60000) });

// A background task of a terminal (a command the agent left running): one row like a worker's, read-only in its split.
function backgroundItem({ row, open, now, label }: { row: BackgroundRow; open: ReturnType<typeof useSplits>; now: number; label: boolean }) {
  const { task, terminalId, number } = row, running = task.state === 'running', callId = backgroundCallId(task.id), opened = isSplitOpen(open, terminalId, callId);
  const took = elapsedClock((running ? now : backgroundEnd(task)) - task.startedAt);
  const word = running ? [t('运行中'), took, task.lastOutputAt == null ? t('还没有输出') : outputAge(now - task.lastOutputAt)].join(' · ')
    : task.exitCode ? t('已结束，退出码 {code} · 用时 {time}', { code: task.exitCode, time: took }) : t('已完成 · 用时 {time}', { time: took });
  return <li key={`${terminalId}/${task.id}`} className={`activity-call-item is-${running ? 'running' : 'done'}${task.exitCode ? ' is-failed' : ''}`} title={[task.command, t(opened ? '点击关闭旁边的分屏' : '点击在旁边查看它的输出')].join('\n')}>
    <button type="button" className={`activity-call-open activity-call-body${label ? ' has-terminal' : ''}`} aria-pressed={opened} aria-label={t('后台任务 {command}，{state}', { command: task.command, state: word })} onClick={() => toggleSplit(terminalId, callId)}>
      <span className="activity-row-icon">{task.exitCode ? <WarningCircle size={14} weight="fill" aria-hidden="true" /> : CALL_STATES[running ? 'running' : 'done'].icon}</span>
      <span className="activity-call-text"><p>{task.command}</p><small className="activity-call-sub">{word}</small></span>
      {label && <span className="activity-call-terminal">{t('终端 {number}', { number })}</span>}
    </button>
  </li>;
}

// The sub-agents the agent called, listed in the left bar's Agent tab and in the narrow window's header popover. With `terminals` the list is the whole project's: every terminal's
// calls, per model one head (its mark, name, settings, service and rate) and two lines for each call (what it does; its role and state in words, the terminal at the right when the project
// has several), then a 「后台任务」 group of commands left running, and a collapsed 「最近完成 N 个」 (the last 10, none older than 30 minutes). Without `terminals` it is the one terminal's calls.
// A model's calls past the fourth fold into "+N". With nothing to list there is one quiet line saying what will appear. Hidden calls are left out and not counted in "+N".
export function CallsCard({ calls, terminalId, terminals }: { calls: AgentCall[]; terminalId: string; terminals?: readonly ProjectTerminal[] }) {
  const open = useSplits(), now = useClock(), finishedOpen = useFinishedOpen();
  const project = !!terminals, sources: CallSource[] = terminals ? callSources(terminals) : [{ id: terminalId, number: 1, calls, background: [] }];
  const { groups, background, recent } = projectCalls(sources, open, now, project), label = sources.length > 1;
  const empty = !groups.length && !background.length;
  return <section className="activity-card activity-calls" aria-label={t('调用的模型')}>
    {empty && <p className="activity-empty">{t('还没有调用其他模型。规划员分派任务后，会显示在这里。')}</p>}
    {!empty && <ul className="activity-call-groups">
      {groups.map(({ call, rate, rows }) => {
        const name = callModelName(call);
        return <li key={JSON.stringify([call.agent, call.provider, call.model, call.modelUnconfirmed, call.effort, call.fast])}>
          <ul className="activity-call-rows">
            <ModelHead agent={call.agent} name={name} effort={call.effort} fast={call.fast} provider={call.provider} title={[call.agent, call.provider, name].filter(Boolean).join(' / ')} rate={rate} />
            {rows.slice(0, MAX_CALL_ITEMS).map(row => callItem({ row, open, now, label }))}
            {rows.length > MAX_CALL_ITEMS && <li className="activity-call-more"><span /><p>{t('+{count} 个', { count: rows.length - MAX_CALL_ITEMS })}</p></li>}
          </ul>
        </li>;
      })}
      {background.length > 0 && <li key="background"><ul className="activity-call-rows">
        <li className="activity-call-head"><span className="activity-row-icon"><Terminal size={16} aria-hidden="true" /></span><p><b>{t('后台任务')}</b><span className="activity-call-settings">{t('{count} 个运行中', { count: background.length })}</span></p><span /></li>
        {background.map(row => backgroundItem({ row, open, now, label }))}
      </ul></li>}
    </ul>}
    {recent.length > 0 && <div className="activity-finished">
      <button type="button" className="activity-finished-head" aria-expanded={finishedOpen} onClick={toggleFinished}><CaretRight size={14} aria-hidden="true" />{t('最近完成 {count} 个', { count: recent.length })}</button>
      {finishedOpen && <ul className="activity-call-rows">
        {recent.map(entry => entry.call ? callItem({ row: entry.call, open, now, label }) : backgroundItem({ row: entry.background!, open, now, label }))}
      </ul>}
    </div>}
  </section>;
}
