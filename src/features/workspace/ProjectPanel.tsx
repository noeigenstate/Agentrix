import { useEffect, useRef, useState } from 'react';
import { ArrowsOutSimple, Play, Plus, DotsThree, GitBranch, X, FolderOpen, ArrowCounterClockwise, Info, Globe, ImageSquare, Microphone } from '@phosphor-icons/react';
import type { Project, Result } from '../../shared/types';
import { ProjectTerminals } from '../terminal/ProjectTerminals';
import { terminalInUse, visibleTerminals } from '../terminal/terminal-visibility.ts';
import { setActiveTerminal, useActiveTerminal } from '../terminal/active-terminal';
import { ActivityPane } from '../agents/ActivityPane';
import { toggleDictation, useVoice } from '../voice/voice-input';
import { t } from '../../shared/i18n';
import { shortcut } from '../shortcuts/shortcuts';
import { ProjectImageDialog } from './ProjectImageDialog';

const api = window.agentrix;

import { IconButton } from '../../shared/IconButton';
import { relativeTime } from '../../shared/time';


function statusText(project: Project) {
  if (project.codexActive && project.codexActivity === 'working') return t('正在处理');
  if (project.unread) return t('等待你查看');
  if (project.error) return t('需要检查');
  if (project.status === 'codex') return project.codexActivity === 'complete' ? t('本轮已完成') : project.codexActivity === 'interrupted' ? t('已中断') : t('{agent} 会话中', { agent: agentName(project.agent) });
  if (project.status === 'shell') return t('终端就绪');
  if (project.status === 'starting') return project.kind === 'ssh' ? t('正在连接 SSH') : t('正在启动');
  if (project.status === 'exited') return project.kind === 'ssh' ? t('SSH 终端已退出') : t('终端已退出');
  return t('尚未启动');
}

function agentName(agent: Project['agent']) { return agent === 'claude' ? 'Claude' : 'Codex'; }

function isRoundComplete(project: Project) {
  return project.codexActive && project.codexActivity === 'complete' && !project.unread && !project.error;
}

export function ProjectPanel({ project, index, hidden, focused, navTarget, navPosition, fontSize, now, activityOpen, onFocus, onAction, onError, onOpenLink, onRevealProject, dragging, dropTarget }: {
  project: Project; index: number; hidden: boolean; focused: boolean; fontSize: number; now: number;
  navTarget?: number; navPosition?: string;
  // The activity pane (what the agent is doing, step by step) shows beside the terminal of an expanded project; its toggle is in the title bar.
  activityOpen: boolean;
  onFocus: (id: string) => void;
  onAction: <T>(promise: Promise<Result<T>>) => Promise<T | undefined>; onError: (message: string) => void;
  onOpenLink: (id: string, target: string) => void;
  onRevealProject: (id: string) => void;
  dragging?: boolean; dropTarget?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const activeTerminalId = useActiveTerminal(project.id);
  const terminals = visibleTerminals(project.terminals, focused);
  const first = terminals[0];
  const currentTerminal = terminalInUse(terminals, activeTerminalId);
  const multiple = terminals.length > 1;
  // A narrow window hides the pane in CSS; only its title-bar toggle hides these actions.
  const showHeaderActions = !focused || activityOpen;
  const hasTerminal = !!first?.sessionId;
  const stopped = first?.status === 'stopped' || first?.status === 'exited';
  const addTerminal = async () => { const id = await onAction(api.addTerminal(project.id)); if (id) { setActiveTerminal(project.id, id); if (!focused) onFocus(project.id); } };
  const completionAge = project.lastCompletedAt === null ? Infinity : Date.now() - project.lastCompletedAt;
  const working = project.codexActive && project.codexActivity === 'working';
  const freshCompletion = !!project.unread && !working && completionAge >= 0 && completionAge < 9000;
  const roundComplete = isRoundComplete(project);
  // A new turn starts the edge and dot together; ordinary renders keep their clock.
  const signalKey = `${working ? 'working' : 'rest'}:${project.lastCompletedAt}`;
  const badgeClass = `status-badge ${working ? 'is-working' : roundComplete ? 'is-complete' : project.unread ? 'is-review' : project.error ? 'is-error' : ''}`;
  const meta = working ? '' : project.lastCompletedAt ? t('{time}完成', { time: relativeTime(project.lastCompletedAt, now) }) : '';
  const status = statusText(project);
  const badge = <><span key={signalKey} className="status-dot" aria-hidden="true" /><span>{status}</span></>;
  useEffect(() => {
    if (!menuOpen) return;
    if (!showHeaderActions) { setMenuOpen(false); return; }
    const dismiss = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menuOpen, showHeaderActions]);
  const action = (callback: () => void) => { setMenuOpen(false); callback(); };
  const showActivity = focused && activityOpen;
  const recording = useVoice().recording === currentTerminal?.id;
  return <article
    className={`project-panel ${showActivity ? 'has-activity' : ''} ${project.unread && !working ? 'has-unread' : ''} ${freshCompletion ? 'attention-active' : ''} ${working ? 'is-working' : ''} ${roundComplete ? 'round-complete' : ''} ${focused ? 'is-focused' : ''} ${navTarget ? 'is-nav-target' : ''} ${project.error ? 'has-error' : ''} ${dragging ? 'drag-source' : ''} ${dropTarget ? 'drop-target' : ''}`}
    data-project-id={project.id} data-status={working ? 'working' : project.unread ? 'unread' : project.status}
    tabIndex={-1}
    style={{ display: hidden ? 'none' : undefined }}
  >
    <span key={signalKey} className="panel-signal" aria-hidden="true" />
    {navTarget && <span key={`nav:${navTarget}`} className="panel-nav-ring" aria-hidden="true" />}
    {/* Where next/previous project landed, over the card itself (the screen-reader announcement is ProjectSwitchHud). */}
    {navTarget && <div key={`hud:${navTarget}`} className="panel-nav-hud" aria-hidden="true">{project.image && <img className="project-image project-switch-image" src={project.image} alt="" draggable={false} data-audit-ignore />}<span className="project-switch-index">{String(index + 1).padStart(2, '0')}</span><b>{project.name}</b>{navPosition && <small>{navPosition}</small>}</div>}
    <header className="panel-header" title={focused ? undefined : t('点击标题栏放大，按住标题栏拖动排序')} onClick={event => {
      if (!focused && event.button === 0 && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && !(event.target as Element).closest('button, [role="menu"]')) onFocus(project.id);
    }}>
      {project.image ? <><img className="project-image panel-project-image" src={project.image} alt="" draggable={false} data-audit-ignore /><span className="panel-index panel-project-image-fallback">{String(index + 1).padStart(2, '0')}</span></> : <span className="panel-index">{String(index + 1).padStart(2, '0')}</span>}
      <button className="panel-name" onClick={() => !focused && onFocus(project.id)} aria-label={focused ? undefined : t('全屏查看 {name}', { name: project.name })} title={project.kind === 'ssh' ? `${project.ssh?.host}:${project.path}` : project.path}>
        <span>{project.name}</span>
        {project.branch && <small><GitBranch size={11} />{project.branch}</small>}
        {project.kind === 'ssh' && <small className="ssh-project-label"><Globe size={11} />{project.ssh?.host}</small>}
      </button>
      {!!meta && <span className="panel-meta" title={project.path}>{meta}</span>}
      {showHeaderActions && (!!project.unread && !focused && !working
        ? <button type="button" className={`${badgeClass} status-button`} title={status} onClick={() => onFocus(project.id)} aria-label={t('查看 {name} 的完成结果', { name: project.name })}>{badge}</button>
        : <span className={badgeClass} title={status}>{badge}</span>)}
      {!multiple && stopped && hasTerminal && <button className="text-button panel-action" aria-label={t('重新启动')} onClick={() => onAction(api.startTerminal(first.id))}><Play size={12} weight="fill" /><span>{t('重启')}</span></button>}
      {showHeaderActions && <div className="panel-menu-anchor" ref={menu}>
        <IconButton label={t('{name} 的更多操作', { name: project.name })} onClick={() => setMenuOpen(!menuOpen)}><DotsThree size={20} weight="bold" /></IconButton>
        {menuOpen && <div className="dropdown panel-menu" role="menu">
          {!focused && <button role="menuitem" onClick={() => action(() => onFocus(project.id))}><ArrowsOutSimple size={16} />{t('全屏查看')}</button>}
          {/* While it records, the microphone over the card shows it; choosing this again inserts what was said. */}
          {currentTerminal && <button role="menuitem" onClick={() => action(() => void toggleDictation(currentTerminal.id, currentTerminal.sessionId, onError, project.name))}><Microphone size={16} />{recording ? t('结束录音并插入') : t('语音输入')}<span className="menu-shortcut" aria-hidden="true">{shortcut('voice')}</span></button>}
          <button role="menuitem" onClick={() => action(() => void addTerminal())}><Plus size={16} />{t('新建终端并分屏')}<span className="menu-shortcut" aria-hidden="true">{shortcut('newTerminal')}</span></button>
          <button role="menuitem" onClick={() => action(() => onRevealProject(project.id))}><FolderOpen size={16} />{t('打开项目目录')}</button>
          <button role="menuitem" onClick={() => action(() => setImageOpen(true))}><ImageSquare size={16} />{t('项目图片…')}</button>
          {currentTerminal && <button role="menuitem" onClick={() => action(() => { onAction(api.restartTerminal(currentTerminal.id)); })}><ArrowCounterClockwise size={16} />{project.kind === 'ssh' ? t('重新连接 SSH') : t('重启当前终端')}</button>}
          <div className="menu-divider" />
          <button role="menuitem" className="danger-text" onClick={() => action(() => { onAction(api.removeProject(project.id)); })}><X size={16} />{t('移除项目')}<span className="menu-shortcut" aria-hidden="true">{shortcut('removeProject')}</span></button>
        </div>}
      </div>}
    </header>
    {imageOpen && <ProjectImageDialog project={project} index={index} onClose={() => setImageOpen(false)} />}
    <ProjectTerminals project={project} focused={focused} fontSize={fontSize} activeId={activeTerminalId} setActiveId={id => setActiveTerminal(project.id, id)} onExpand={() => onFocus(project.id)} onAction={onAction} onError={onError} onOpenLink={onOpenLink} />
    {showActivity && <ActivityPane terminal={currentTerminal} />}
    {project.error && <div className="panel-error"><Info size={13} /><span>{t(project.error)}</span></div>}
  </article>;
}
