import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowCounterClockwise, DotsSixVertical, Play, Terminal as TerminalIcon, X } from '@phosphor-icons/react';
import { SubagentPane } from '../agents/SubagentPane';
import { closeSplit, splitsOf, useSplits } from '../agents/subagent-splits.ts';
import { AgentLauncher } from './AgentLauncher';
import { TerminalPane } from './TerminalPane';
import { terminalInUse, visibleTerminals } from './terminal-visibility.ts';
import { ReadingView } from '../reading/ReadingView';
import { readingShown, setReading, syncReading, useTerminalChoice } from '../reading/reading-mode';
import { NativePathNote } from '../native-session/NativePathNote';
import { NativeSessionView } from '../native-session/NativeSessionView';
import { useHandoff, type Handoff } from '../native-session/draft-handoff.ts';
import { ensureNativeSession, nativeShown, useNativeEntries } from '../native-session/native-store.ts';
import { TERMINAL_SPLITS, useReorder } from '../workspace/useProjectReorder';
import type { Project, ProjectTerminal, Result } from '../../shared/types';
import { t } from '../../shared/i18n';

// The draft handoff of a run-mode switch, bound to its terminal by the card whatever the card shows (the reading view, the native view or the raw terminal),
// so a switch never waits for a view that is not there: a card without a message box hands over an empty draft. The views never reach the bridge.
function WithHandoff({ terminal, children }: { terminal: ProjectTerminal; children: (handoff: Handoff) => ReactNode }) {
  const surface = terminal.sessionId ? 'terminal' : terminal.nativeMode === 'claude-sdk' ? 'api' : terminal.nativeMode === 'codex-app-server' ? 'native' : null;
  return <>{children(useHandoff(terminal.id, terminal.nativeRuntimeSessionId ?? null, terminal.switchState, surface))}</>;
}

export function ProjectTerminals({ project, focused, fontSize, activeId, setActiveId, onExpand, onAction, onError, onOpenLink }: {
  project: Project; focused: boolean; fontSize: number; activeId: string | null; setActiveId: (id: string) => void; onExpand: () => void;
  onAction: <T,>(promise: Promise<Result<T>>) => Promise<T | undefined>;
  onError: (message: string) => void; onOpenLink: (projectId: string, target: string) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const terminals = project.terminals;
  // A session without a terminal (the Claude API or Codex's app-server) has no pty to be "active" by: the native view stands where a terminal's would.
  const nativeEntries = useNativeEntries(), isNative = (terminal: ProjectTerminal) => !terminal.sessionId && nativeShown(nativeEntries.get(terminal.id));
  const base = new Set(visibleTerminals(terminals, focused).map(terminal => terminal.id));
  const visible = terminals.filter(terminal => base.has(terminal.id) || !focused && (terminal.readingHistory || isNative(terminal)));
  const visibleIds = new Set(visible.map(terminal => terminal.id));
  const multiple = visible.length > 1;
  // The sub-agent view the owner opened beside a conversation (one per terminal) takes a cell of the same grid, only while the project is expanded;
  // a window too narrow for two columns puts it below the conversation.
  const openViews = useSplits(), views = focused ? terminals.flatMap(terminal => splitsOf(openViews, terminal.id)) : [];
  const cells = visible.length + views.length;
  const columns = Math.min(Math.max(1, Math.ceil(Math.sqrt(cells))), width < 600 ? 1 : width < 1150 ? 2 : 3);
  const rows = Math.max(1, Math.ceil(cells / columns));
  const selected = terminalInUse(visible, activeId)?.id ?? null;
  const launcherTerminal = terminals.find(terminal => !terminal.sessionId || terminal.status === 'exited') ?? terminals[0];
  const runningCount = terminals.filter(terminal => terminal.sessionId && terminal.status !== 'exited' && terminal.status !== 'stopped').length;
  const openTerminal = (id: string) => { setActiveId(id); if (!focused) onExpand(); };
  const raw = useTerminalChoice();
  useEffect(() => { terminals.forEach(syncReading); }, [terminals, raw]);
  // A window opened (or reloaded) onto a native session that runs asks once for it; terminals with a pty have none.
  useEffect(() => { for (const terminal of terminals) if (!terminal.sessionId) ensureNativeSession(terminal.id); }, [terminals]);
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
  return <div ref={area} className={`panel-terminal-area terminal-grid ${cells > 1 ? 'has-splits' : ''} ${multiple ? 'has-terminals' : ''} ${reorder.drag ? 'is-reordering' : ''}`} style={{ '--terminal-columns': columns, '--terminal-rows': rows } as CSSProperties}
    onPointerDown={reorder.onPointerDown} onClickCapture={reorder.onClickCapture}>
    {shown.map(terminal => {
      const native = isNative(terminal);
      if (!focused && !terminal.sessionId && !terminal.readingHistory && !native) return null;
      const stopped = terminal.status === 'stopped' || terminal.status === 'exited';
      const reading = !native && readingShown(terminal, raw);
      const name = `${project.name} ${terminal.title}`;
      return <div key={terminal.id} className={`terminal-slot ${reorder.drag?.id === terminal.id ? 'drag-placeholder' : ''}`} data-terminal-slot={terminal.id} style={{ display: visibleIds.has(terminal.id) ? undefined : 'none' }}>
      <section className={`terminal-split ${selected === terminal.id ? 'is-active-terminal' : ''} ${reorder.drag?.id === terminal.id ? 'drag-source' : ''} ${reorder.drag?.targetId === terminal.id ? 'drop-target' : ''}`} data-terminal-id={terminal.id} data-session-id={terminal.sessionId || ''} data-codex-active={terminal.codexActive} aria-label={name} onPointerDownCapture={() => setActiveId(terminal.id)} onFocusCapture={() => setActiveId(terminal.id)}>
        {/* Only with several splits, and only while the pointer or the keyboard is in one: its drag grip (splits are reordered by it), restart and close, in its corner. */}
        {multiple && <div className="terminal-split-tools">
          <span className="terminal-split-grip" title={t('拖动调整顺序')} aria-hidden="true"><DotsSixVertical size={14} /></span>
          <button className="icon-button" title={t('重启此终端')} aria-label={t('重启 {name}', { name })} onClick={() => void onAction(window.agentrix.restartTerminal(terminal.id))}><ArrowCounterClockwise size={13} /></button>
          <button className="icon-button" title={t('关闭此终端')} aria-label={t('关闭 {name}', { name })} onClick={() => void onAction(window.agentrix.closeTerminal(terminal.id))}><X size={13} /></button>
        </div>}
        <WithHandoff terminal={terminal}>{handoff => <div className="terminal-split-body" data-reading={reading || native || !!terminal.agentStarting}>
          {reading && <ReadingView projectId={project.id} terminal={terminal} remote={project.kind === 'ssh'} autoFocus={focused && selected === terminal.id} active={selected === terminal.id} handoff={handoff} onShowTerminal={() => setReading(terminal.id, false)} onError={onError} onOpenLink={target => onOpenLink(project.id, target)} />}
          {/* A change of run mode on its way to a terminal card, and the note of a path that did not go as chosen; the native view draws its own line and question. */}
          <NativePathNote terminalId={terminal.id} terminalActive={!!terminal.sessionId} switchState={terminal.switchState} sessionId={terminal.nativeRuntimeSessionId ?? null} />
          {terminal.sessionId ? <TerminalPane id={terminal.id} sessionId={terminal.sessionId} fontSize={fontSize} focused={focused && selected === terminal.id && !reading && !terminal.agentStarting} onError={onError} onOpenLink={(_id, target) => onOpenLink(project.id, target)} remote={project.kind === 'ssh'} />
            : native ? <NativeSessionView terminalId={terminal.id} projectId={project.id} autoFocus={focused && selected === terminal.id} switchState={terminal.switchState} handoff={handoff} onError={onError} onOpenLink={target => onOpenLink(project.id, target)} />
            // A local project starts with the agent chosen here; an SSH project connects first, in its terminal.
            : reading ? null : project.kind !== 'ssh' ? <AgentLauncher terminalId={terminal.id} projectId={project.id} onAction={onAction} onOpenTerminal={openTerminal} />
            : sshEmpty(terminal.id)}
        </div>}</WithHandoff>
        {multiple && stopped && terminal.sessionId && <button className="button secondary small terminal-split-restart" onClick={() => void onAction(window.agentrix.startTerminal(terminal.id))}>{t('重新启动')}</button>}
      </section></div>;
    })}
    {views.map(view => <div key={`${view.terminalId}/${view.callId}`} className="subagent-slot">
      <SubagentPane terminalId={view.terminalId} callId={view.callId} projectId={project.id} onClose={() => closeSplit(view.terminalId, view.callId)} onError={onError} onOpenLink={target => onOpenLink(project.id, target)} />
    </div>)}
    {!focused && !visible.length && (project.kind === 'ssh' ? sshEmpty(launcherTerminal.id, runningCount)
      : <AgentLauncher terminalId={launcherTerminal.id} projectId={project.id} onAction={onAction} onOpenTerminal={openTerminal} runningCount={runningCount} onExpand={onExpand} />)}
  </div>;
}
