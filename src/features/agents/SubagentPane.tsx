// A view of one sub-agent, opened from the activity pane beside the terminal's conversation: who it is, what state it is in, and the
// conversation it is having, followed live. The conversation is read-only; the owner's word for the agent goes through SubagentInput,
// and what the owner sent shows under the conversation as queued until the agent's own record carries it (a word relayed through the
// parent leaves no trace there, so it stays queued).
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { ArrowDown, Lock, X } from '@phosphor-icons/react';
import type { AgentIntervention, SubagentFeed } from '../../shared/types';
import { t } from '../../shared/i18n';
import { modelName } from '../../shared/model-name';
import { useNow } from '../../shared/useNow';
import { ConversationFeed } from '../reading/ConversationFeed';
import { ClaudeLogo, CodexLogo } from './AgentBrandIcon';
import { CALL_STATES, elapsedClock, failureWord, rateValue } from './ActivityPane';
import { SubagentInput } from './SubagentInput';
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

// The footer says what the view is doing, in one line.
function footerText(status: FeedState['status'], error: string | null, following: boolean, unread: number, over: boolean) {
  if (status === 'gone') return t('只读 · 记录已不在，分屏保留最后的内容');
  if (status === 'error') return t('只读 · 读取失败：{message}，下次变化时重试', { message: error ?? '' });
  if (over) return t('只读 · 已完成，分屏保留到你关闭');
  if (following) return t('只读 · 自动跟随最新一步');
  return unread ? t('只读 · 已暂停跟随，有 {count} 个新步骤', { count: unread }) : t('只读 · 已暂停跟随');
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
  const over = feed?.state === 'done' || feed?.endedAt != null || status === 'gone', delivered = deliveredIds(entries, sent);
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
        {sent.map(item => <div key={item.id} className="subagent-sent">
          <p>{item.text}</p><small>{[t(delivered.has(item.id) ? '已送达' : '已排队'), item.route === 'parent' && t('已转告主会话')].filter(Boolean).join(' · ')}</small>
        </div>)}
      </div>
      {unread > 0 && <button type="button" className="subagent-jump button" onClick={follow}><ArrowDown size={16} />{t('{count} 个新步骤', { count: unread })}</button>}
    </div>
    <SubagentInput terminalId={terminalId} callId={callId} name={who} closed={over} onSent={item => setSent(items => [...items, item])} />
    <footer className="subagent-foot">
      <Lock size={14} aria-hidden="true" /><span>{footerText(status, error, following, unread, over)}</span><span className="subagent-space" />
      {!following && !over && <button type="button" className="button" onClick={follow}>{t('回到最新')}</button>}
    </footer>
  </section>;
}
