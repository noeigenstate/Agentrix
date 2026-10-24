import { useEffect, useRef, type KeyboardEvent } from 'react';
import { TerminalWindow } from '@phosphor-icons/react';
import type { Decision } from './decisions';
import { kindLabel, trustedFolder, trustsFolder, waited } from './DecisionCard';
import { isWorking, sessionTask, type Group, type InboxItem } from './inbox-items';
import type { Project, ProjectTerminal } from '../../shared/types';
import { reviewHistory } from './review-history';
import { actionText } from '../agents/action-text';
import { ClaudeLogo, CodexLogo } from '../agents/AgentBrandIcon';
import { t } from '../../shared/i18n';

const GROUPS: [Group, string][] = [['decide', '等你决定'], ['working', '工作中'], ['other', '其他会话']];

// What a session is doing, in the words a person uses for work: never a percentage it cannot know.
export function sessionStateLabel(project: Project, terminal: ProjectTerminal) {
  if (!terminal.sessionId || terminal.status === 'exited') return t('未启动');
  if (!terminal.codexActive) return t('终端');
  if (terminal.codexActivity === 'working') return t('工作中');
  if (terminal.codexActivity !== 'complete') return t('等待指令');
  return project.unread > 0 ? t('等你查看') : t('本轮完成');
}

// One line under a decision's name saying what it is about, so the list can be read without opening anything.
function brief(decision: Decision) {
  if (decision.kind === 'approval') return decision.context.map(line => line.trim()).filter(Boolean).at(-1) ?? t('它要先得到你的批准才能继续');
  if (decision.kind === 'question') return t('{count} 个选项，等你回答', { count: decision.choice?.options.length ?? 0 });
  if (trustsFolder(decision)) return trustedFolder(decision) ?? (decision.choice?.options ?? []).map(option => option.label).join(' / ');
  if (decision.kind === 'choice') return (decision.choice?.options ?? []).map(option => option.label).join(' / ');
  if (decision.kind === 'signin') return t('登录之后它才能开始工作');
  if (decision.kind === 'attention') return t('打开它的终端看看它在问什么');
  const { submission, notes } = reviewHistory(decision.projectId);
  return submission > 1 ? t('第 {count} 次提交 · 上次批语：{note}', { count: submission, note: notes.at(-1)?.text ?? '' }) : t('做完了，等你批改');
}

function sessionLine({ terminal }: InboxItem) {
  if (isWorking(terminal) && terminal.action) return t('正在{step}', { step: actionText(terminal.action) });
  return sessionTask(terminal) || (terminal.codexActive ? t('还没有交代任务') : t('没有运行中的助手'));
}

function AgentMark({ agent }: { agent: 'claude' | 'codex' | 'terminal' }) {
  return <span className="inbox-mark" aria-hidden="true">{agent === 'claude' ? <ClaudeLogo size={16} /> : agent === 'codex' ? <CodexLogo size={16} /> : <TerminalWindow size={16} />}</span>;
}

// Every decision and session in one list, most urgent first: ↑↓ moves the selection while the list has focus, a click
// selects. The right pane shows what is selected.
export function DecisionInbox({ items, selectedId, now, onSelect }: { items: readonly InboxItem[]; selectedId: string | null; now: number; onSelect: (id: string) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selectedId) list.current?.querySelector(`[data-item-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' }); }, [selectedId]);
  const keys = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const at = items.findIndex(item => item.id === selectedId), next = items[Math.min(items.length - 1, Math.max(0, at < 0 ? (step > 0 ? 0 : items.length - 1) : at + step))];
    if (next) onSelect(next.id);
  };
  return <div ref={list} className="inbox-list" role="listbox" aria-label={t('待决定的事')} tabIndex={0} aria-activedescendant={selectedId ? `inbox-${selectedId}` : undefined} onKeyDown={keys}>
    {GROUPS.map(([group, label]) => {
      const rows = items.filter(item => item.group === group);
      return rows.length > 0 && <div key={group} role="group" aria-label={t(label)}>
        <h4 className="inbox-group">{t(label)} · {rows.length}</h4>
        {rows.map(item => {
          const { decision, project, terminal } = item, agent = terminal.codexActive ? terminal.agent === 'claude' ? 'claude' : 'codex' : 'terminal';
          const tag = decision ? kindLabel(decision.kind) : sessionStateLabel(project, terminal);
          return <div key={item.id} id={`inbox-${item.id}`} data-item-id={item.id} role="option" aria-selected={item.id === selectedId} className="inbox-row" onClick={() => { onSelect(item.id); list.current?.focus({ preventScroll: true }); }}>
            <AgentMark agent={decision?.agent ?? agent} />
            <span className="inbox-text">
              <b>{project.name}{project.terminals.length > 1 ? ` · ${terminal.title}` : ''}</b>
              <small>{decision ? `${waited(decision.since, now)} · ${brief(decision)}` : sessionLine(item)}</small>
            </span>
            <span className={`inbox-tag${decision ? ' is-need' : group === 'working' ? ' is-work' : ''}`}>{tag}</span>
          </div>;
        })}
      </div>;
    })}
  </div>;
}
