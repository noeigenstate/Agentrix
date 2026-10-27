import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight } from '@phosphor-icons/react';
import type { ConversationEntry } from '../../shared/types';
import { sessionTask, type InboxItem } from './inbox-items';
import { lastRound } from '../reading/result-round';
import { relativeTime } from '../../shared/time';
import { t } from '../../shared/i18n';

// Where the picked project's session stands, as one quiet line under the box: what its last round said (or the task it is on),
// and the way into it. Its state is the picked row's own line in the list.
export function SessionLine({ item, now, onOpenProject }: { item: InboxItem; now: number; onOpenProject: (projectId: string) => void }) {
  const { project, terminal } = item, [entries, setEntries] = useState<ConversationEntry[]>([]);
  useEffect(() => {
    let live = true;
    void window.agentrix.terminalConversation(terminal.id).then(result => { if (live) setEntries(result.ok ? result.value : []); });
    return () => { live = false; };
  }, [terminal.id, terminal.lastCompletedAt]);
  const reply = useMemo(() => lastRound(entries).reply, [entries]);
  // One line: the first line of the last round's summary as plain text (the row ellipsizes it), else the task it is on, else nothing to say.
  const summary = (reply || sessionTask(terminal) || '').split('\n').map(line => line.replace(/^[\s#>*-]+/, '').replace(/[*`]/g, '').trim()).find(Boolean) ?? '';
  const done = terminal.lastCompletedAt && t('上次完成 {time}', { time: relativeTime(terminal.lastCompletedAt, now) });
  return <p className="session-line" title={[project.name, done].filter(Boolean).join(' · ')}>
    <span className="session-summary">{summary || t('这个项目还没有任务记录')}</span>
    <button type="button" className="text-button session-open" onClick={() => onOpenProject(project.id)}>{t('打开会话')}<ArrowUpRight size={12} /></button>
  </p>;
}
