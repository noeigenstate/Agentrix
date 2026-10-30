import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowCounterClockwise, DotsSixVertical, Play, Terminal as TerminalIcon, X } from '@phosphor-icons/react';
import { AgentLauncher } from './AgentLauncher';
import { TerminalPane } from './TerminalPane';
import { terminalInUse, visibleTerminals } from './terminal-visibility.ts';
import { ReadingView } from '../reading/ReadingView';
import { readingShown, setReading, syncReading, useTerminalChoice } from '../reading/reading-mode';
import { TERMINAL_SPLITS, useReorder } from '../workspace/useProjectReorder';
import type { Project, Result } from '../../shared/types';
import { t } from '../../shared/i18n';


export function ProjectTerminals({ project, focused, fontSize, activeId, setActiveId, onExpand, onAction, onError, onOpenLink }: {
  project: Project; focused: boolean; fontSize: number; activeId: string | null; setActiveId: (id: string) => void; onExpand: () => void;
  onAction: <T,>(promise: Promise<Result<T>>) => Promise<T | undefined>;
  onError: (message: string) => void; onOpenLink: (projectId: string, target: string) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const terminals = project.terminals;
  const base = new Set(visibleTerminals(terminals, focused).map(terminal => terminal.id));
  const visible = terminals.filter(terminal => base.has(terminal.id) || !focused && terminal.readingHistory);
  const visibleIds = new Set(visible.map(terminal => terminal.id));
  const multiple = visible.length > 1;
  const columns = Math.min(Math.max(1, Math.ceil(Math.sqrt(visible.length))), width < 600 ? 1 : width < 1150 ? 2 : 3);
  const rows = Math.max(1, Math.ceil(visible.length / columns));
  const selected = terminalInUse(visible, activeId)?.id ?? null;
  const launcherTerminal = terminals.find(terminal => !terminal.sessionId || terminal.status === 'exited') ?? terminals[0];
  const runningCount = terminals.filter(terminal => terminal.sessionId && terminal.status !== 'exited' && terminal.status !== 'stopped').length;
  const openTerminal = (id: string) => { setActiveId(id); if (!focused) onExpand(); };
  const raw = useTerminalChoice();
  useEffect(() => { terminals.forEach(syncReading); }, [terminals, raw]);
  useEffect(() => {
    const node = area.current; if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  // The splits are dragged by their grip to another place, the way project cards are on the grid; each keeps its
  // terminal, and the order is saved for the project.
  const reorder = useReorder(multiple, project.id, terminals.map(terminal => terminal.id), ids => onAction(window.agentrix.reorderTerminals(project.id, ids)), TERMINAL_SPLITS);
  const records = new Map(terminals.map(terminal => [terminal.id, terminal]));
  const shown = reorder.order ? reorder.order.flatMap(id => records.get(id) ?? []) : terminals;
  const sshEmpty = (terminalId: string, count = 0) => <div className="terminal-empty">
    <TerminalIcon size={28} weight="light" /><p>{t('项目已就位')}</p><span>{t('启动终端，在这里开始开发')}</span>
    {count > 0
      ? <button className="text-button agent-launcher-running" onClick={onExpand}>{t('{count} 个终端运行中 · 点击展开', { count })}</button>
      : <button className="button secondary small" onClick={async () => { await onAction(window.agentrix.startTerminal(terminalId)); openTerminal(terminalId); }}><Play size={13} weight="fill" />{t('启动终端')}</button>}
  </div>;
  return <div ref={area} className={`panel-terminal-area terminal-grid ${multiple ? 'has-splits' : ''} ${reorder.drag ? 'is-reordering' : ''}`} style={{ '--terminal-columns': columns, '--terminal-rows': rows } as CSSProperties}
    onPointerDown={reorder.onPointerDown} onClickCapture={reorder.onClickCapture}>
    {shown.map(terminal => {
      if (!focused && !terminal.sessionId && !terminal.readingHistory) return null;
      const stopped = terminal.status === 'stopped' || terminal.status === 'exited';
      const reading = readingShown(terminal, raw);
      const name = `${project.name} ${terminal.title}`;
      return <div key={terminal.id} className={`terminal-slot ${reorder.drag?.id === terminal.id ? 'drag-placeholder' : ''}`} data-terminal-slot={terminal.id} style={{ display: visibleIds.has(terminal.id) ? undefined : 'none' }}>
      <section className={`terminal-split ${selected === terminal.id ? 'is-active-terminal' : ''} ${reorder.drag?.id === terminal.id ? 'drag-source' : ''} ${reorder.drag?.targetId === terminal.id ? 'drop-target' : ''}`} data-terminal-id={terminal.id} data-session-id={terminal.sessionId || ''} data-codex-active={terminal.codexActive} aria-label={name} onPointerDownCapture={() => setActiveId(terminal.id)} onFocusCapture={() => setActiveId(terminal.id)}>
        {/* Only with several splits, and only while the pointer or the keyboard is in one: its drag grip (splits are reordered by it), restart and close, in its corner. */}
        {multiple && <div className="terminal-split-tools">
          <span className="terminal-split-grip" title={t('拖动调整顺序')} aria-hidden="true"><DotsSixVertical size={14} /></span>
          <button className="icon-button" title={t('重启此终端')} aria-label={t('重启 {name}', { name })} onClick={() => void onAction(window.agentrix.restartTerminal(terminal.id))}><ArrowCounterClockwise size={13} /></button>
          <button className="icon-button" title={t('关闭此终端')} aria-label={t('关闭 {name}', { name })} onClick={() => void onAction(window.agentrix.closeTerminal(terminal.id))}><X size={13} /></button>
        </div>}
        <div className="terminal-split-body" data-reading={reading || !!terminal.agentStarting}>
          {reading && <ReadingView projectId={project.id} terminal={terminal} remote={project.kind === 'ssh'} autoFocus={focused && selected === terminal.id} active={selected === terminal.id} onShowTerminal={() => setReading(terminal.id, false)} onError={onError} onOpenLink={target => onOpenLink(project.id, target)} />}
          {terminal.sessionId ? <TerminalPane id={terminal.id} sessionId={terminal.sessionId} fontSize={fontSize} focused={focused && selected === terminal.id && !reading && !terminal.agentStarting} onError={onError} onOpenLink={(_id, target) => onOpenLink(project.id, target)} remote={project.kind === 'ssh'} />
            // A local project starts with the agent chosen here; an SSH project connects first, in its terminal.
            : reading ? null : project.kind !== 'ssh' ? <AgentLauncher terminalId={terminal.id} projectId={project.id} onAction={onAction} onOpenTerminal={openTerminal} />
            : sshEmpty(terminal.id)}
        </div>
        {multiple && stopped && terminal.sessionId && <button className="button secondary small terminal-split-restart" onClick={() => void onAction(window.agentrix.startTerminal(terminal.id))}>{t('重新启动')}</button>}
      </section></div>;
    })}
    {!focused && !visible.length && (project.kind === 'ssh' ? sshEmpty(launcherTerminal.id, runningCount)
      : <AgentLauncher terminalId={launcherTerminal.id} projectId={project.id} onAction={onAction} onOpenTerminal={openTerminal} runningCount={runningCount} onExpand={onExpand} />)}
  </div>;
}
