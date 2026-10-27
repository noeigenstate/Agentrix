import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowUpRight, FolderSimple, HardDrives, TerminalWindow } from '@phosphor-icons/react';
import type { ConversationEntry } from '../../shared/types';
import { sessionStateLabel } from './DecisionInbox';
import { sessionTask, type InboxItem } from './inbox-items';
import { lastRound } from '../reading/result-round';
import { relativeTime } from '../../shared/time';
import { t } from '../../shared/i18n';

// A session with nothing to decide, as one card that is the whole task flow: where it stands (name, state, what its last
// round said, the way in), a hairline, then what comes next (the composer, passed in as children).
export function SessionDetail({ item, now, onOpenProject, children }: { item: InboxItem; now: number; onOpenProject: (projectId: string) => void; children?: ReactNode }) {
  const { project, terminal } = item, [entries, setEntries] = useState<ConversationEntry[]>([]);
  useEffect(() => {
    let live = true;
    void window.agentrix.terminalConversation(terminal.id).then(result => { if (live) setEntries(result.ok ? result.value : []); });
    return () => { live = false; };
  }, [terminal.id, terminal.lastCompletedAt]);
  const reply = useMemo(() => lastRound(entries).reply, [entries]);
  const task = sessionTask(terminal), queued = (terminal.prompts || []).filter(prompt => prompt.state === 'queued').length;
  const name = project.name + (project.terminals.length > 1 ? ` · ${terminal.title}` : '');
  const agent = terminal.codexActive ? terminal.agent === 'claude' ? 'Claude Code' : 'Codex' : '';
  // One line: the first line of the last round's summary as plain text (the row ellipsizes it), else the task it is on, else nothing to say.
  const summary = (reply || task || '').split('\n').map(line => line.replace(/^[\s#>*-]+/, '').replace(/[*`]/g, '').trim()).find(Boolean) ?? '';
  const Icon = project.kind === 'ssh' ? HardDrives : terminal.sessionId && !terminal.codexActive ? TerminalWindow : FolderSimple;
  const details = [agent, terminal.lastCompletedAt && t('上次完成 {time}', { time: relativeTime(terminal.lastCompletedAt, now) }), queued > 0 && t('{count} 条排队', { count: queued })].filter(Boolean).join(' · ');
  return <article className="decision-card session-detail" aria-label={project.name} title={details || undefined}>
    <header className="session-head">
      <Icon size={18} className="session-icon" aria-hidden="true" />
      <h2 className="session-name">{name}</h2>
      <span className={`decision-kind${item.group === 'working' ? ' is-work' : terminal.codexActive && terminal.codexActivity === 'complete' ? ' is-done' : ''}`}>{sessionStateLabel(project, terminal)}</span>
      <button type="button" className="text-button session-open" onClick={() => onOpenProject(project.id)}>{t('打开会话')}<ArrowUpRight size={14} /></button>
    </header>
    <p className="session-summary">{summary || t('这个项目还没有任务记录')}</p>
    {children && <hr className="session-divider" />}
    {children}
  </article>;
}
