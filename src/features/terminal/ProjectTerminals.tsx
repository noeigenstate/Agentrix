import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowCounterClockwise, Play, Terminal as TerminalIcon, X } from '@phosphor-icons/react';
import { AgentLauncher } from './AgentLauncher';
import { TerminalPane } from './TerminalPane';
import { ReadingView } from '../reading/ReadingView';
import { readingShown, setReading, syncReading, useTerminalChoice } from '../reading/reading-mode';
import { VoiceButton } from '../voice/VoiceButton';
import { TERMINAL_SPLITS, useReorder } from '../workspace/useProjectReorder';
import type { Project, ProjectTerminal, Result } from '../../shared/types';
import { t } from '../../shared/i18n';

function label(terminal: ProjectTerminal) {
  if (terminal.error) return t('需要检查');
  if (terminal.codexActive) {
    switch (terminal.codexActivity) {
      case 'working': return t('正在处理');
      case 'complete': return t('本轮已完成');
      case 'interrupted': return t('已中断');
      default: return t('{agent} 会话中', { agent: terminal.agent === 'claude' ? 'Claude' : 'Codex' });
    }
  }
  switch (terminal.status) {
    case 'starting': return t('正在启动');
    case 'shell': return t('终端就绪');
    case 'exited': return t('已退出');
    default: return t('尚未启动');
  }
}

export function ProjectTerminals({ project, focused, fontSize, activeId, setActiveId, onAction, onError, onOpenLink }: {
  project: Project; focused: boolean; fontSize: number; activeId: string | null; setActiveId: (id: string) => void;
  onAction: <T,>(promise: Promise<Result<T>>) => Promise<T | undefined>;
  onError: (message: string) => void; onOpenLink: (projectId: string, target: string) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const terminals = project.terminals;
  const multiple = terminals.length > 1;
  const columns = Math.min(Math.ceil(Math.sqrt(terminals.length)), width < 600 ? 1 : width < 1150 ? 2 : 3);
  const rows = Math.ceil(terminals.length / columns);
  const selected = terminals.some(item => item.id === activeId) ? activeId : terminals[0]?.id;
  const raw = useTerminalChoice();
  useEffect(() => { terminals.forEach(syncReading); }, [terminals, raw]);
  useEffect(() => {
    const node = area.current; if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  // The splits are dragged by their title bar to another place, the way project cards are on the grid; each keeps its
  // terminal, and the order is saved for the project.
  const reorder = useReorder(multiple, project.id, terminals.map(terminal => terminal.id), ids => onAction(window.agentrix.reorderTerminals(project.id, ids)), TERMINAL_SPLITS);
  const records = new Map(terminals.map(terminal => [terminal.id, terminal]));
  const shown = reorder.order ? reorder.order.flatMap(id => records.get(id) ?? []) : terminals;
  return <div ref={area} className={`panel-terminal-area terminal-grid ${multiple ? 'has-splits' : ''} ${reorder.drag ? 'is-reordering' : ''}`} style={{ '--terminal-columns': columns, '--terminal-rows': rows } as CSSProperties}
    onPointerDown={reorder.onPointerDown} onClickCapture={reorder.onClickCapture}>
    {shown.map(terminal => {
      const stopped = terminal.status === 'stopped' || terminal.status === 'exited';
      const reading = readingShown(terminal, raw);
      const name = `${project.name} ${terminal.title}`;
      return <div key={terminal.id} className={`terminal-slot ${reorder.drag?.id === terminal.id ? 'drag-placeholder' : ''}`} data-terminal-slot={terminal.id}>
      <section className={`terminal-split ${selected === terminal.id ? 'is-active-terminal' : ''} ${reorder.drag?.id === terminal.id ? 'drag-source' : ''} ${reorder.drag?.targetId === terminal.id ? 'drop-target' : ''}`} data-terminal-id={terminal.id} data-session-id={terminal.sessionId || ''} data-codex-active={terminal.codexActive} aria-label={name} onPointerDownCapture={() => setActiveId(terminal.id)} onFocusCapture={() => setActiveId(terminal.id)}>
        {multiple && <header className="terminal-split-header"><span>{terminal.title}</span><span className={`split-status ${terminal.codexActivity === 'working' ? 'working' : terminal.codexActivity === 'complete' ? 'complete' : ''}`}>{label(terminal)}</span>
          <button className="icon-button" title={t('重启此终端')} aria-label={t('重启 {name}', { name })} onClick={() => void onAction(window.agentrix.restartTerminal(terminal.id))}><ArrowCounterClockwise size={13} /></button>
          <button className="icon-button" title={t('关闭此终端')} aria-label={t('关闭 {name}', { name })} onClick={() => void onAction(window.agentrix.closeTerminal(terminal.id))}><X size={13} /></button>
        </header>}
        <div className="terminal-split-body" data-reading={reading || !!terminal.agentStarting}>
          {reading && <ReadingView projectId={project.id} terminal={terminal} remote={project.kind === 'ssh'} autoFocus={focused && selected === terminal.id} active={selected === terminal.id} onShowTerminal={() => setReading(terminal.id, false)} onError={onError} onOpenLink={target => onOpenLink(project.id, target)} />}
          {terminal.sessionId ? <TerminalPane id={terminal.id} sessionId={terminal.sessionId} fontSize={fontSize} focused={focused && selected === terminal.id && !reading && !terminal.agentStarting} onError={onError} onOpenLink={(_id, target) => onOpenLink(project.id, target)} remote={project.kind === 'ssh'} />
            // A local project starts with the agent chosen here; an SSH project connects first, in its terminal.
            : project.kind !== 'ssh' ? <AgentLauncher terminalId={terminal.id} onAction={onAction} />
            : <div className="terminal-empty"><TerminalIcon size={28} weight="light" /><p>{t('项目已就位')}</p><span>{t('启动终端，在这里开始开发')}</span><button className="button secondary small" onClick={() => void onAction(window.agentrix.startTerminal(terminal.id))}><Play size={13} weight="fill" />{t('启动终端')}</button></div>}
        </div>
        {multiple && <footer className="terminal-split-footer"><span>{terminal.error ? t(terminal.error) : project.kind === 'ssh' ? 'SSH' : terminal.shell === 'cmd' ? t('命令提示符') : terminal.shell === 'zsh' ? 'zsh' : terminal.shell === 'bash' ? 'Bash' : 'PowerShell'}</span><div>
          <VoiceButton terminalId={terminal.id} sessionId={terminal.sessionId} name={name} size={13} onError={onError} />
          {stopped && terminal.sessionId && <button className="text-button" onClick={() => void onAction(window.agentrix.startTerminal(terminal.id))}>{t('重新启动')}</button>}
          {terminal.codexActive && <span className="session-label">{terminal.agent === 'claude' ? 'CLAUDE' : 'CODEX'}</span>}
        </div></footer>}
      </section></div>;
    })}
  </div>;
}
