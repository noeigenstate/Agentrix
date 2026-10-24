import { useEffect, useMemo, useState } from 'react';
import type { ConversationEntry } from '../../shared/types';
import { sessionStateLabel } from './DecisionInbox';
import { sessionTask, type InboxItem } from './inbox-items';
import { lastRound } from './ReviewCard';
import { Markdown } from '../reading/ReadingView';
import { relativeTime } from '../../shared/time';
import { t } from '../../shared/i18n';

// A session with nothing to decide: what it is on, how its last round ended, and the way into it.
export function SessionDetail({ item, now, onOpenProject }: { item: InboxItem; now: number; onOpenProject: (projectId: string) => void }) {
  const { project, terminal } = item, [entries, setEntries] = useState<ConversationEntry[]>([]);
  useEffect(() => {
    let live = true;
    void window.agentrix.terminalConversation(terminal.id).then(result => { if (live) setEntries(result.ok ? result.value : []); });
    return () => { live = false; };
  }, [terminal.id, terminal.lastCompletedAt]);
  const reply = useMemo(() => lastRound(entries).reply, [entries]);
  const task = sessionTask(terminal), queued = (terminal.prompts || []).filter(prompt => prompt.state === 'queued').length;
  const agent = terminal.codexActive ? terminal.agent === 'claude' ? 'Claude Code' : 'Codex' : '';
  return <article className="decision-card session-detail" aria-label={project.name}>
    <header className="decision-card-head">
      <span className={`decision-kind${item.group === 'working' ? ' is-work' : ' is-quiet'}`}>{sessionStateLabel(project, terminal)}</span>
      <span className="decision-source">{[project.name + (project.terminals.length > 1 ? ` · ${terminal.title}` : ''), agent, terminal.lastCompletedAt && t('上次完成 {time}', { time: relativeTime(terminal.lastCompletedAt, now) })].filter(Boolean).join(' · ')}</span>
    </header>
    <h2 className="decision-title">{task || (terminal.codexActive ? t('还没有交代任务') : t('没有运行中的助手'))}</h2>
    <div className="decision-body">
      {queued > 0 && <p className="decision-why">{t('{count} 条排队', { count: queued })}</p>}
      <section className="review-block"><h4>{t('上一轮的总结')}</h4>
        {reply ? <div className="review-reply"><Markdown text={reply} /></div> : <p className="decision-why">{t('这一轮没有留下说明。')}</p>}
      </section>
    </div>
    <footer className="decision-actions">
      <button type="button" className="button secondary" onClick={() => onOpenProject(project.id)}>{t('打开')}</button>
    </footer>
  </article>;
}
