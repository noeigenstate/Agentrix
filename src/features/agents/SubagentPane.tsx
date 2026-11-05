// A view of one sub-agent, opened from the activity pane beside the terminal's conversation: who it is, what state it is in, and the
// conversation it is having, followed live. The conversation is read-only; the owner's word for the agent goes through SubagentInput,
// and what the owner sent shows under the conversation with the worker's delivery receipt.
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { ArrowDown, X } from '@phosphor-icons/react';
import type { AgentIntervention, SubagentFeed } from '../../shared/types';
import { t } from '../../shared/i18n';
import { modelName } from '../../shared/model-name';
import { useNow } from '../../shared/useNow';
import { ConversationFeed } from '../reading/ConversationFeed';
import { ClaudeLogo, CodexLogo } from './AgentBrandIcon';
import { elapsedClock } from './ActivityPane';
import { CALL_STATES, failureWord, rateValue } from './AgentCalls';
import { SubagentInput } from './SubagentInput';
import { type Receipt, receiptLine } from '../native-session/native-words';
import { type FeedState, deliveredIds, unreadAfter, useSubagentFeed } from './subagent-splits.ts';
import './activity-pane.css';

// Within this many pixels of the end, the view is following the newest step.
const FOLLOW_SLACK = 24;
const atEnd = (node: HTMLElement) => node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK;

// The state in words: a feed the main process no longer keeps reads 不可用, whatever it last was; one that has ended reads 已完成
// (a finished Task sub-agent's feed state stays 'reviewing', so the end time decides).
function stateWord(feed: SubagentFeed, status: FeedState['status'], over: boolean) {
  if (status === 'gone') return t('不可用');
  if (feed.failure) return failureWord(feed.failure);
  return t(CALL_STATES[over ? 'done' : feed.state].word);
}

// Where a sent word stands: the worker's own receipt for it comes first, then the answer it got when sent; a word that shows up in the worker's
// resumed transcript is at least delivered, but a final answer (read, refused) is never taken back.
function receiptOf(item: AgentIntervention, known: Receipt | undefined, delivered: boolean): Receipt {
  const base = known ?? item;
  return delivered && (base.status === 'queued' || base.status === 'unknown') ? { status: 'delivered' } : base;
}

// The owner scrolled up: the view stops following and remembers the last entry it had shown, so it can count what came after.
type Paused = { after: string | null } | null;

export function SubagentPane({ terminalId, callId, projectId, onClose, onError, onOpenLink }: {
  terminalId: string; callId: string; projectId: string; onClose(): void; onError(message: string): void; onOpenLink(target: string): void;
}) {
  const { feed, status, error } = useSubagentFeed(terminalId, callId), now = useNow(Date.now);
  const body = useRef<HTMLDivElement>(null), followingNow = useRef(true), [paused, setPaused] = useState<Paused>(null), [sent, setSent] = useState<AgentIntervention[]>([]);
  const entries = feed?.entries ?? [], lastId = entries.at(-1)?.id ?? null, following = paused === null;
  const unread = paused ? unreadAfter(entries, paused.after) : 0;
  followingNow.current = following;

  // New steps and late layout (markdown, tool groups opening) keep the end in view while following.
  const toEnd = () => { const node = body.current; if (node && followingNow.current) node.scrollTop = node.scrollHeight; };
  useEffect(toEnd, [feed?.revision, following, sent.length]);
  useEffect(() => {
    const content = body.current?.firstElementChild;
    if (!content) return;
    const observer = new ResizeObserver(toEnd);
    observer.observe(content);
    return () => observer.disconnect();
  }, [feed !== null]);

  const follow = () => { followingNow.current = true; setPaused(null); const node = body.current; if (node) node.scrollTop = node.scrollHeight; };
  // Escape closes the split, except inside the message box: there it only leaves the box (the typed word stays), and the next Escape closes.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    if ((event.target as HTMLElement).tagName === 'TEXTAREA') body.current?.focus(); else onClose();
  };
  const name = feed ? modelName(feed.model) : t('子 agent'), Mark = feed?.agent === 'Codex' ? CodexLogo : ClaudeLogo;
  // The task first, then the model: two splits of one model are told apart by their task, in the header and in every accessible name.
  const title = feed?.title ?? '', who = title ? `${title} · ${name}` : name;
  // A finished Task subagent is 'reviewing' but has an end time; either way nothing more can be said to it.
  // Only a dispatched worker has a direct channel (a word reaches it through the dispatch control); a sub-agent inside the session can only be told through the main session.
  const direct = callId.startsWith('dispatch:');
  const over = feed?.state === 'done' || feed?.endedAt != null || status === 'gone', delivered = deliveredIds(entries, sent);
  // Every receipt the worker's feed holds (a stop too), with the words sent here read by the rule above.
  const receipts = new Map<string, Receipt>((feed?.controlReceipts ?? []).map(known => [known.id, known]));
  for (const item of sent) receipts.set(item.id, receiptOf(item, receipts.get(item.id), delivered.has(item.id)));
  const how = feed ? [feed.effort === 'default' ? t('默认') : feed.effort, feed.fast != null && (feed.fast ? t('快速') : t('普通'))].filter(Boolean).join(' · ') : '';
  const rate = feed ? rateValue(feed.rate) : null;
  // A finished view counts to its recorded end; without one, or with an end not after the start, the time it took is unknown, not 0:00.
  const ended = over ? feed?.endedAt ?? null : now;
  const elapsed = feed?.startedAt != null && ended !== null && (!over || ended > feed.startedAt) ? elapsedClock(ended - feed.startedAt) : '—';
  // Who it is, quietly under the task: the task takes the header's width; the role, model, settings and a known speed go on a second line.
  const meta = feed ? [t(feed.role), name, how, rate !== null && `${rate} token/s`].filter(Boolean).join(' · ') : '';

  return <section className="subagent-split" aria-label={t('{name} 的输出，只读', { name: who })} onKeyDown={onKeyDown}>
    <header className="subagent-head">
      <div className="subagent-head-row">
        <Mark size={16} /><span className="subagent-title" title={title}>{title || name}</span>
        {feed && <span className={`subagent-tag subagent-state is-${over ? 'done' : feed.state}`}>{stateWord(feed, status, over)}</span>}
        <span className="subagent-elapsed" title={t(over ? '用时' : '已运行')}>{elapsed}</span>
        <button type="button" className="icon-button" title={t('关闭分屏（Esc）')} aria-label={t('关闭 {name} 的分屏', { name: who })} onClick={onClose}><X size={13} /></button>
      </div>
      {meta && <div className="subagent-meta" title={feed?.model ? `${meta} · ${feed.model}` : meta}>{meta}</div>}
    </header>
    <div className="subagent-main">
      <div ref={body} className="subagent-body" tabIndex={0} role="log" aria-live="off" aria-label={t('{name} 的消息和工具步骤，只读', { name: who })}
        onScroll={event => { const end = atEnd(event.currentTarget); setPaused(current => end ? null : current ?? { after: lastId }); }}>
        {feed ? <ConversationFeed entries={feed.entries} agent={feed.agent === 'Codex' ? 'codex' : 'claude'} projectId={projectId} live={feed.state === 'running' && status === 'ok'} onError={onError} onOpenLink={onOpenLink} />
          : <p className="subagent-empty">{status === 'error' ? t('读取失败：{message}', { message: error ?? '' }) : t('正在读取…')}</p>}
        {/* Once the conversation shows a word, it is not shown again; a refused one stays, with why. Having been read needs no saying. */}
        {sent.filter(item => !delivered.has(item.id) || receipts.get(item.id)!.status === 'rejected').map(item => <div key={item.id} className="subagent-sent">
          <p>{item.text}</p>{receipts.get(item.id)!.status !== 'consumed' && <small>{receiptLine(receipts.get(item.id)!)}</small>}
        </div>)}
      </div>
      {/* Scrolled up: the way back to the end, with how much came after. */}
      {(unread > 0 || !following && !over) && <button type="button" className="subagent-jump button" onClick={follow}><ArrowDown size={16} />{unread > 0 ? t('{count} 个新步骤', { count: unread }) : t('回到最新')}</button>}
    </div>
    {feed && status === 'error' && <p className="subagent-read-error" role="alert">{t('读取失败：{message}', { message: error ?? '' })}</p>}
    {direct ? <SubagentInput terminalId={terminalId} callId={callId} name={who} closed={over} receipts={receipts} onSent={item => setSent(items => [...items, item])} />
      : <div className="subagent-input"><p className="subagent-input-note">{t('会话内的子代理没有直达通道，只能通过主会话与它交流。')}</p></div>}
  </section>;
}
