import { setUserAvatar } from './shared/UserAvatar';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { SquaresFour, FolderSimplePlus, MagnifyingGlass, X, Minus, Square, GearSix, CheckCircle, Info, Circle, Tray, CirclesFour } from '@phosphor-icons/react';
import type { AgentsState, AppUpdateState, Project, ProjectLocation, Result, Settings, SSHAuthPrompt, Workspace } from './shared/types';
import { ProjectSwitchHud } from './features/workspace/ProjectSwitchHud';
import { ProjectExplorer } from './features/files/ProjectExplorer';
import { AddProjectDialog } from './features/workspace/AddProjectDialog';
import { SSHAuthDialog } from './features/ssh/SSHAuthDialog';
import { useProjectReorder } from './features/workspace/useProjectReorder';
import { pruneReadingCli } from './features/reading/reading-terminal';
import { setReading } from './features/reading/reading-mode';
import { useProjectFocusMotion } from './features/workspace/useProjectFocusMotion';
import { applyMotion } from './shared/motion';
import { applyTheme } from './shared/themes';
import { setTerminalRenderer } from './features/terminal/terminal-renderer';
import { terminalFontFamily } from './features/terminal/terminal-font';
import { VoiceOverlay } from './features/voice/VoiceButton';
import { applyLanguage, t } from './shared/i18n';
import { actionFor, applyShortcuts, editingKeyInField, shortcut } from './features/shortcuts/shortcuts';
import { gridColumns, gridNeighbor } from './features/workspace/grid-navigation';
import { quickDictation } from './features/voice/voice-input';
import { UsageGuide } from './features/guide/UsageGuide';
import { GuideTour } from './features/guide/GuideTour';
import { IconButton } from './shared/IconButton';
import { showPopup, usePopup } from './features/files/file-popup';
import { ProjectPanel, isRoundComplete } from './features/workspace/ProjectPanel';
import { SettingsDialog } from './features/settings/SettingsDialog';
import { DecisionHome } from './features/home/DecisionHome';
import { useDecisions, type Decision } from './features/home/decisions';
import { decisionTitle, kindLabel } from './features/home/DecisionCard';
const FilePreview = lazy(() => import('./features/files/FilePreview').then(module => ({ default: module.FilePreview })));
const FilePopup = lazy(() => import('./features/files/FilePopup').then(module => ({ default: module.FilePopup })));
const GitDiffView = lazy(() => import('./features/git/GitDiffView').then(module => ({ default: module.GitDiffView })));

const api = window.agentrix;

// A terminal added by shortcut appears after the next state update; focus it once its input exists.
function focusTerminalWhenReady(id: string, tries = 60) {
  const input = document.querySelector<HTMLElement>(`[data-terminal-id="${CSS.escape(id)}"] .xterm-helper-textarea`);
  if (input) input.focus(); else if (tries > 0) requestAnimationFrame(() => focusTerminalWhenReady(id, tries - 1));
}

// A reading view hides xterm's input. Check each focus attempt before falling back.
function focusOverviewProject(id: string) {
  const panel = document.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(id)}"]`);
  if (!panel) return;
  for (const target of [...panel.querySelectorAll<HTMLElement>('.reading-composer textarea'), ...panel.querySelectorAll<HTMLElement>('.xterm-helper-textarea'), panel]) {
    target.focus({ preventScroll: true });
    if (document.activeElement === target) break;
  }
  panel.scrollIntoView({ block: 'nearest' });
}

const NO_PROJECTS: Project[] = [];

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  useLayoutEffect(() => { setUserAvatar(workspace?.settings.userAvatar ?? ''); }, [workspace?.settings.userAvatar]);
  useEffect(() => { applyMotion(workspace?.settings.focusAnimation || 'smooth'); }, [workspace?.settings.focusAnimation]);
  useEffect(() => { applyTheme(workspace?.settings.theme); }, [workspace?.settings.theme]);
  // The surface (glass or solid) is a mode of the whole stylesheet, like the theme.
  useEffect(() => { const surface = workspace?.settings.surface || 'glass'; document.documentElement.dataset.surface = surface === 'glass' && workspace?.settings.glassBackground === 'desktop' && workspace?.desktopGlass?.active ? 'desktop-glass' : surface; }, [workspace?.settings.surface, workspace?.settings.glassBackground, workspace?.desktopGlass?.active]);
  useEffect(() => { document.documentElement.dataset.desktopGlassCompatibility = String(!!workspace?.desktopGlass?.compatibility && (!!workspace?.desktopGlass?.active || !!workspace?.desktopGlass?.failed)); }, [workspace?.desktopGlass?.compatibility, workspace?.desktopGlass?.active, workspace?.desktopGlass?.failed]);
  useEffect(() => {
    const value = workspace?.settings.glassTransparency;
    document.documentElement.dataset.glassTransparency = value == null ? 'theme' : 'custom';
    if (workspace?.settings.surface !== 'solid' && value != null) document.documentElement.style.setProperty('--glass-alpha', String(1 - value / 100));
    else document.documentElement.style.removeProperty('--glass-alpha');
  }, [workspace?.settings.glassTransparency, workspace?.settings.surface]);
  useEffect(() => { setTerminalRenderer(workspace?.settings.terminalRenderer || 'gpu'); }, [workspace?.settings.terminalRenderer]);
  useEffect(() => { document.documentElement.dataset.terminalWeight = String(workspace?.settings.terminalFontWeight || 400); }, [workspace?.settings.terminalFontWeight]);
  useEffect(() => { document.documentElement.dataset.terminalFontFamily = terminalFontFamily(workspace?.settings.terminalFontFamily, workspace?.settings.terminalCjkFontFamily); }, [workspace?.settings.terminalFontFamily, workspace?.settings.terminalCjkFontFamily]);
  const [agents, setAgents] = useState<AgentsState | null>(null);
  // Native full screen (F11, or an expanded project): the title bar gets out of the way.
  const [fullScreen, setFullScreen] = useState(false);
  const [agentsDismissed, setAgentsDismissed] = useState(false);
  const [settingsSection, setSettingsSection] = useState('appearance');
  const [updates, setUpdates] = useState<AppUpdateState | null>(null);
  const [query, setQuery] = useState('');
  // With only a few projects the search box is a single icon; Ctrl+K or a click opens it.
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => { if (searchOpen) queryInput.current?.focus(); }, [searchOpen]);
  const { root: focusMotionRoot, focusedId, focus: setFocusedId } = useProjectFocusMotion(workspace?.settings.focusAnimation || 'smooth');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The top-level page: the decisions to make (home, with every session beside them) or the workbench grid. Null until
  // chosen: the window opens on the page the settings name.
  const [view, setView] = useState<'decisions' | 'workspace' | null>(null);
  // The usage guide: welcome page on first use, "what's new" after an update, or opened from settings.
  // tour: the tutorial in the window itself, a bubble at each place to act.
  const [guide, setGuide] = useState<'tour' | 'keys' | 'news' | null>(null);
  const tourWithAdd = useRef(false);
  const startTour = () => { tourWithAdd.current = !workspace?.projects.length; setGuide('tour'); };
  const guideShown = useRef(false);
  useEffect(() => {
    if (!workspace?.guide || guideShown.current) return;
    guideShown.current = true; if (workspace.settings.guideVersion) setGuide('news'); else startTour();
  }, [workspace?.guide, workspace?.settings.guideVersion]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [addOpen, setAddOpen] = useState(false);
  const [sshAuth, setSSHAuth] = useState<SSHAuthPrompt[]>([]);
  const [expandedByProject, setExpandedByProject] = useState<Record<string, string[]>>({});
  // diff: the file is shown as its Git changes (from the Git sidebar) instead of its contents.
  const [previewFile, setPreviewFile] = useState<{ projectId: string; path: string; diff?: 'worktree' | 'staged' | 'untracked' } | null>(null);
  const [changeRevision, setChangeRevision] = useState(0);
  const editorGuard = useRef<(() => Promise<boolean>) | null>(null);
  const navigationGuard = useRef<Promise<boolean> | null>(null);
  const registerEditorGuard = useCallback((guard: (() => Promise<boolean>) | null) => { editorGuard.current = guard; }, []);
  const allowNavigation = useCallback(() => {
    if (navigationGuard.current) return navigationGuard.current;
    const promise = Promise.resolve(editorGuard.current?.() ?? true).finally(() => { navigationGuard.current = null; });
    navigationGuard.current = promise; return promise;
  }, []);
  const queryInput = useRef<HTMLInputElement>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportError = useCallback((message: string) => {
    setError(message);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 10000);
  }, []);
  const perform = useCallback(async <T,>(promise: Promise<Result<T>>) => {
    try { const result = await promise; if (!result.ok) { reportError(result.error); return; } return result.value; }
    catch (err) { reportError(String(err)); }
  }, [reportError]);
  const reorder = useProjectReorder(!focusedId && !addOpen && !settingsOpen && !sshAuth.length && (workspace?.projects.length || 0) > 1, query,
    workspace?.projects.map(project => project.id) || [], ids => perform(api.reorderProjects(ids)));
  const focusProject = useCallback(async (id: string) => {
    if (!await allowNavigation()) return false;
    // A project opens in the workbench, from wherever it was chosen.
    setView('workspace');
    setPreviewFile(null);
    setFocusedId(id);
    api.focusMode(true);
    perform(api.acknowledge(id));
    return true;
  }, [perform, setFocusedId, allowNavigation]);
  const returnToGrid = useCallback(async () => { if (!await allowNavigation()) return; setView('workspace'); setFocusedId(null); setPreviewFile(null); api.focusMode(false); }, [setFocusedId, allowNavigation]);
  const showProjectLocation = useCallback(async (id: string, result: ProjectLocation | undefined) => {
    if (!result || result.kind === 'external' || !await focusProject(id)) return;
    if (result.kind === 'file') {
      setPreviewFile({ projectId: id, path: result.path });
    } else {
      const parts = result.path.split('/').filter(Boolean);
      const directories = ['', ...parts.map((_, index) => parts.slice(0, index + 1).join('/'))];
      setExpandedByProject(value => ({ ...value, [id]: [...new Set([...(value[id] || []), ...directories])] }));
      await perform(api.settings({ explorerCollapsed: false }));
    }
  }, [perform, focusProject]);
  const openTerminalLink = useCallback(async (id: string, target: string) => {
    await showProjectLocation(id, await perform(api.openLink(id, target)));
  }, [perform, showProjectLocation]);
  // A file or folder named in a terminal or a conversation opens in a popup over what is on screen: only a project's
  // header or a shortcut opens its page. With that page already open, a folder is shown in its file list instead.
  const openLinkInPopup = useCallback(async (id: string, target: string) => {
    const result = await perform(api.openLink(id, target));
    if (result?.kind === 'directory' && focusedId === id) await showProjectLocation(id, result);
    else if (result && result.kind !== 'external') showPopup({ kind: result.kind === 'file' ? 'file' : 'folder', projectId: id, path: result.path });
  }, [perform, showProjectLocation, focusedId]);
  const popup = usePopup();
  const revealProject = useCallback(async (id: string) => {
    await showProjectLocation(id, await perform(api.revealProject(id)));
  }, [perform, showProjectLocation]);

  useEffect(() => {
    if (!workspace) return;
    const live = workspace.projects.flatMap(project => project.terminals)
      .filter(terminal => terminal.sessionId && terminal.status !== 'exited');
    pruneReadingCli(new Set(live.map(terminal => JSON.stringify([terminal.id, terminal.sessionId]))));
  }, [workspace]);

  const settingsRef = useRef<Settings | null>(null); settingsRef.current = workspace?.settings || null;
  // Project order for next/previous (set each render), and the current card even if focus fails.
  const navigation = useRef<string[]>([]);
  const lastProject = useRef<string | null>(null);
  const [projectSwitch, setProjectSwitch] = useState<{ id: string; sequence: number } | null>(null);
  const switchSequence = useRef(0);
  const switchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showProjectSwitch = useCallback((id: string) => {
    lastProject.current = id;
    setProjectSwitch({ id, sequence: ++switchSequence.current });
    if (switchTimer.current) clearTimeout(switchTimer.current);
    switchTimer.current = setTimeout(() => { setProjectSwitch(null); switchTimer.current = null; }, 1200);
  }, []);
  useEffect(() => () => { if (switchTimer.current) clearTimeout(switchTimer.current); }, []);
  useEffect(() => {
    const remember = (event: FocusEvent) => { const id = (event.target as Element | null)?.closest?.<HTMLElement>('[data-project-id]')?.dataset.projectId; if (id) lastProject.current = id; };
    document.addEventListener('focusin', remember);
    return () => document.removeEventListener('focusin', remember);
  }, []);
  useEffect(() => {
    if (!api) return;
    const offState = api.onState(setWorkspace);
    const offFocus = api.onFocusProject(focusProject);
    const offError = api.onError(reportError);
    const offUpdates = api.onUpdateState(setUpdates);
    const offAgents = api.onAgents(setAgents);
    const offFullScreen = api.onFullScreen(setFullScreen);
    perform(api.isFullScreen()).then(value => { if (typeof value === 'boolean') setFullScreen(value); });
    const offAuth = api.onSSHAuth(setSSHAuth);
    const offEditor = api.onEditorClose(id => { void allowNavigation().then(accepted => api.editorCloseResult(id, accepted), () => api.editorCloseResult(id, false)); });
    perform(api.getSSHAuth()).then(requests => { if (requests) setSSHAuth(requests); });
    perform(api.getAgents()).then(state => { if (state) setAgents(state); });
    perform(api.getUpdateState()).then(state => { if (state) setUpdates(state); });
    perform(api.getState()).then(state => { if (state) setWorkspace(state); });
    const clock = setInterval(() => setNow(Date.now()), 5000);
    return () => { offState(); offFocus(); offError(); offUpdates(); offAgents(); offFullScreen(); offAuth(); offEditor(); clearInterval(clock); if (errorTimer.current) clearTimeout(errorTimer.current); };
  }, [focusProject, perform, reportError, allowNavigation]);
  useEffect(() => {
    if (focusedId && workspace && !workspace.projects.some(p => p.id === focusedId)) returnToGrid();
  }, [workspace, focusedId, returnToGrid]);
  useEffect(() => {
    // App shortcuts (configurable in settings). In text boxes and the editor, standard editing keys such as
    // Ctrl+A keep their meaning; in terminals and elsewhere the shortcut wins, before xterm sees the key.
    // While a dialog is open (including recording a new shortcut) nothing is intercepted.
    const handler = (event: KeyboardEvent) => {
      const action = actionFor(event);
      if (!action || editingKeyInField(event) || document.querySelector('dialog[open], .tour-layer')) return;
      event.preventDefault(); event.stopPropagation();
      if (event.repeat) return;
      if (action === 'search' && !focusedId) { setSearchOpen(true); requestAnimationFrame(() => queryInput.current?.focus()); }
      else if (action === 'addProject') setAddOpen(true);
      else if (action === 'voice') void quickDictation(reportError);
      else if (action === 'overview') void returnToGrid();
      else if (action === 'decisions') setView('decisions');
      else if (action === 'explorer' && focusedId) perform(api.settings({ explorerCollapsed: !workspace?.settings.explorerCollapsed }));
      else if (action === 'settings') setSettingsOpen(true);
      else if (action === 'newTerminal') {
        // A new split in the current project, ready to type in.
        const id = currentProject();
        if (!id) { reportError(t('先点一下要分屏的项目，再按 {key}。', { key: shortcut('newTerminal') })); return; }
        void perform(api.addTerminal(id)).then(terminal => { if (terminal) focusTerminalWhenReady(terminal); });
      }
      else if (action === 'removeProject') {
        const id = currentProject();
        if (!id) { reportError(t('先点一下要移除的项目，再按 {key}。', { key: shortcut('removeProject') })); return; }
        void perform(api.removeProject(id, true));
      }
      else if (action === 'maximize') { if (focusedId) void returnToGrid(); else { const id = currentProject(); if (id) void focusProject(id); } }
      else if (action === 'fullscreen') api.toggleFullScreen();
      else if (action === 'nextProject' || action === 'previousProject' || action === 'projectAbove' || action === 'projectBelow') {
        // The project beside this one where the cards sit in the grid (Ctrl+Shift with an arrow by default).
        const direction = ({ nextProject: 'right', previousProject: 'left', projectAbove: 'up', projectBelow: 'down' } as const)[action];
        const next = gridNeighbor(navigation.current, currentProject(), direction);
        if (!next) return;
        // Expanded: preserve the editor guard. Overview: focus the card without expanding it.
        if (focusedId) void focusProject(next).then(accepted => {
          if (!accepted) return;
          showProjectSwitch(next);
          requestAnimationFrame(() => {
            if (lastProject.current === next) document.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
          });
        });
        else { focusOverviewProject(next); showProjectSwitch(next); }
      }
    };
    const currentProject = () => focusedId || lastProject.current || document.activeElement?.closest<HTMLElement>('[data-project-id]')?.dataset.projectId;
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [focusedId, returnToGrid, focusProject, perform, reportError, showProjectSwitch, workspace?.settings.explorerCollapsed]);

  // Decisions across every project, for the home page, the count beside its tab and a notice when one arrives.
  const { decisions, snoozed } = useDecisions(workspace?.projects ?? NO_PROJECTS);
  const shownView = view ?? workspace?.settings.startView ?? 'workspace';
  const seenDecisions = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(decisions.map(decision => decision.id));
    // What was waiting when the window opened is on the home page already; only new arrivals are announced.
    if (seenDecisions.current) for (const decision of decisions) {
      // Work handed in is announced by the round's own completion notice; announcing it again would ring twice.
      if (decision.kind === 'review' || seenDecisions.current.has(decision.id) || (shownView === 'decisions' && document.hasFocus())) continue;
      void api?.notifyDecision(decision.projectId, decisionTitle(decision), kindLabel(decision.kind));
    }
    if (workspace) seenDecisions.current = ids;
  }, [decisions, shownView, workspace]);
  useEffect(() => api?.onDecisionShow(() => setView('decisions')), []);
  // Under a home page the workbench keeps running but takes no keys: a terminal behind it must not get what is typed.
  useEffect(() => { if (shownView !== 'workspace') (document.activeElement as HTMLElement | null)?.closest('.main-workspace, .focus-sidebar') && (document.activeElement as HTMLElement).blur(); }, [shownView]);
  const openDecision = useCallback((decision: Decision) => {
    void focusProject(decision.projectId).then(accepted => {
      if (!accepted || (decision.kind !== 'approval' && decision.choice?.kind !== 'permission')) return;
      setReading(decision.terminalId, false);
      requestAnimationFrame(() => focusTerminalWhenReady(decision.terminalId));
    });
  }, [focusProject]);

  if (!api) return <div className="startup-message"><SquaresFour size={38} /><h1>{t('Agentrix 是桌面应用')}</h1><p>{t('请在项目目录运行 npm start，或双击打包后的应用。')}</p></div>;
  if (!workspace) return <div className="startup-message"><SquaresFour size={34} /><p>{error || t('正在打开工作区…')}</p></div>;
  const { projects, settings } = workspace;
  // Set before the children render, so every t() in this render uses the chosen language.
  applyLanguage(settings.language);
  applyShortcuts(settings.shortcuts);
  const projectRecords = new Map(projects.map(project => [project.id, project]));
  const orderedProjects = reorder.order ? reorder.order.flatMap(id => projectRecords.get(id) || []) : projects;
  const unread = projects.filter(p => p.unread > 0).length;
  const completed = projects.filter(isRoundComplete).length;
  const normalizedQuery = query.toLowerCase();
  const visible = projects.filter(p => !normalizedQuery || `${p.name} ${p.path} ${p.ssh?.host || ''}`.toLowerCase().includes(normalizedQuery));
  const visibleIds = new Set(visible.map(p => p.id));
  const columns = gridColumns(visible.length);
  const rows = Math.max(1, Math.ceil(visible.length / columns));
  const focus = projects.find(p => p.id === focusedId);
  navigation.current = (focusedId ? orderedProjects : orderedProjects.filter(project => visibleIds.has(project.id))).map(project => project.id);
  const switchProject = projectSwitch && projectRecords.get(projectSwitch.id);
  const switchPosition = projectSwitch ? navigation.current.indexOf(projectSwitch.id) + 1 : 0;
  const setPreference = (patch: Partial<Settings>) => { perform(api.settings(patch)); };

  return <div ref={focusMotionRoot} className={`app-shell ${focusedId ? 'focus-mode' : ''} ${fullScreen ? 'is-fullscreen' : ''} ${fullScreen && workspace.autoHideTitlebar ? 'titlebar-auto' : ''}`} style={{ '--terminal-font-size': `${settings.fontSize}px` } as CSSProperties}>
    {fullScreen && workspace.autoHideTitlebar && <div className="titlebar-reveal" aria-hidden="true" />}
    <div className="titlebar">
      <div className="titlebar-brand"><span className="brand-mark"><i /><i /><i /><i /></span><span>Agentrix</span></div>
      <nav className="home-nav" aria-label={t('页面')}>
        <button type="button" aria-current={shownView === 'decisions' ? 'page' : undefined} title={t('回到决策 · {key}', { key: shortcut('decisions') })} onClick={() => setView('decisions')}><Tray size={16} />{t('决策')}{decisions.length > 0 && <span className="home-nav-count" aria-label={t('{count} 件待决定', { count: decisions.length })}>{decisions.length}</span>}</button>
        <button type="button" aria-current={shownView === 'workspace' ? 'page' : undefined} onClick={() => setView('workspace')}><CirclesFour size={16} />{t('工作台')}</button>
      </nav>
      {!!(unread || completed) && <div className="workspace-summary" role="status" aria-label={t('工作区概况')}>
        {!!unread && <span className="summary-unread"><i className="legend-review" />{t('{count} 待查看', { count: unread })}</span>}
        {!!completed && <span className="summary-complete"><i className="legend-done" />{t('{count} 本轮完成', { count: completed })}</span>}
      </div>}
      <div className="titlebar-space" />
      <div className="titlebar-tools">
        {/* Search and add project open from their shortcuts (Ctrl+Shift+F and Ctrl+Shift+N by default, configurable);
            the search box shows while in use. */}
        {!focusedId && (searchOpen || query) && <div className="search-input"><MagnifyingGlass size={15} /><input ref={queryInput} placeholder={t('搜索项目或路径…')} aria-label={t('搜索项目')} value={query} onChange={e => setQuery(e.target.value)} onBlur={() => { if (!query) setSearchOpen(false); }} onKeyDown={event => { if (event.key === 'Escape') { setQuery(''); setSearchOpen(false); } }} />{query ? <IconButton label={t('清除搜索')} onClick={() => setQuery('')}><X size={13} /></IconButton> : <kbd>{shortcut('search')}</kbd>}</div>}
        <IconButton label={t('工作台设置')} className={updates?.status === 'ready' ? 'update-ready' : ''} onClick={() => setSettingsOpen(true)}><GearSix size={16} /></IconButton>
      </div>
      <div className="window-actions"><IconButton label={t('最小化')} onClick={() => api.minimize()}><Minus size={16} /></IconButton><IconButton label={t('最大化或还原')} onClick={() => api.maximize()}><Square size={12} /></IconButton><IconButton label={t('关闭窗口')} className="window-close" onClick={() => api.close()}><X size={17} /></IconButton></div>
    </div>
    <div className="workspace-layout">
      {focus && <ProjectExplorer key={focus.id} project={focus} collapsed={settings.explorerCollapsed}
        onFilesRemoved={paths => setPreviewFile(current => current?.projectId === focus.id && paths.some(path => current.path === path || current.path.startsWith(path + '/')) ? null : current)}
        onPathRenamed={(oldPath, newPath) => setPreviewFile(current => current?.projectId === focus.id && (current.path === oldPath || current.path.startsWith(oldPath + '/')) ? { projectId: focus.id, path: newPath + current.path.slice(oldPath.length) } : current)}
        expandedPaths={expandedByProject[focus.id] ?? ['']} selectedFile={previewFile?.projectId === focus.id ? previewFile.path : null} changeRevision={changeRevision}
        onOpenChange={async (path, mode) => { if (previewFile?.projectId === focus.id && previewFile.path === path && previewFile.diff === mode) return; if (await allowNavigation()) setPreviewFile({ projectId: focus.id, path, diff: mode === 'file' ? undefined : mode }); }}
        onCollapse={() => setPreference({ explorerCollapsed: !settings.explorerCollapsed })}
        onExpandedChange={paths => setExpandedByProject(value => ({ ...value, [focus.id]: paths }))}
        onSelectFile={async path => { if (previewFile?.projectId === focus.id && previewFile.path === path && !previewFile.diff) return; if (await allowNavigation()) setPreviewFile({ projectId: focus.id, path }); }} onReturn={returnToGrid} />}
      <main className="main-workspace" inert={shownView !== 'workspace'}>
        <ProjectSwitchHud target={projectSwitch && switchProject && switchPosition > 0 ? { name: switchProject.name, index: orderedProjects.indexOf(switchProject) + 1, position: switchPosition, total: navigation.current.length, sequence: projectSwitch.sequence } : null} />
        {agents && !agents.codex.installed && !agents.claude.installed && !agentsDismissed && <div className="workspace-warning agents-warning"><Info size={15} /><span>{t('未检测到 Codex 或 Claude Code。Agentrix 基于这两个命令行工具工作，安装其中一个后才能使用任务提醒和会话恢复。')}</span><button type="button" className="button secondary small" onClick={() => { setSettingsSection('agents'); setSettingsOpen(true); }}>{t('去安装')}</button><IconButton label={t('关闭提示')} onClick={() => setAgentsDismissed(true)}><X size={14} /></IconButton></div>}
        {workspace.warning && <div className="workspace-warning"><Info size={15} />{t(workspace.warning)}</div>}
        {focusedId && previewFile?.projectId === focusedId && previewFile.diff && <Suspense fallback={null}><GitDiffView key={`${focusedId}:${previewFile.path}:${previewFile.diff}`} projectId={focusedId} filePath={previewFile.path} mode={previewFile.diff} onClose={() => setPreviewFile(null)} onOpenFile={() => setPreviewFile({ projectId: focusedId, path: previewFile.path })} onError={reportError} onChanged={() => setChangeRevision(value => value + 1)} /></Suspense>}
        {focusedId && previewFile?.projectId === focusedId && !previewFile.diff && <Suspense fallback={null}><FilePreview key={`${focusedId}:${previewFile.path}`} projectId={focusedId} filePath={previewFile.path} onClose={async () => { if (await allowNavigation()) setPreviewFile(null); }} autoSave={settings.autoSave} onOpenLink={target => openTerminalLink(focusedId, target)} onError={reportError} registerGuard={registerEditorGuard} /></Suspense>}
        <div className={`grid-area ${!projects.length ? 'empty-area' : ''}`} style={{ visibility: focusedId && previewFile?.projectId === focusedId ? 'hidden' : undefined }}>
          {!projects.length ? <div className="empty-workspace">
            <span className="eyebrow">{t('你的多项目工作台')}</span><h2>{t('每个项目，一个方框。')}</h2><p>{t('添加项目目录，在独立终端里运行 Codex 或 Claude Code。')}<br />{t('方框亮起时，点击全屏查看，再继续下一轮。')}</p>
            <p className="agents-empty-note">{t('需要已安装 Codex CLI 或 Claude Code；可在设置的「编码助手」里一键安装。')}</p>
            <button className="button primary" onClick={() => setAddOpen(true)}><FolderSimplePlus size={18} />{t('添加第一个项目')}</button>
            <div className="empty-hints"><span><Circle weight="fill" size={7} />{t('白色边框 · 等待查看')}</span><span><CheckCircle weight="fill" size={12} />{t('灰色边框 · 本轮完成')}</span></div>
          </div> : <>
            {!focusedId && !visible.length && <div className="no-results"><MagnifyingGlass size={30} weight="light" /><h2>{t('没有找到匹配项目')}</h2><p>{t('试试其他项目名称或目录。')}</p><button className="button secondary small" onClick={() => setQuery('')}>{t('重置搜索')}</button></div>}
            <div className={`agentrix ${reorder.drag ? 'is-reordering' : ''}`} onPointerDown={reorder.onPointerDown} onClickCapture={reorder.onClickCapture} style={{ '--columns': columns, '--rows': rows, display: !focusedId && !visible.length ? 'none' : undefined } as CSSProperties}>
              {orderedProjects.map((project, index) => <div key={project.id} className={`project-slot ${reorder.drag?.id === project.id ? 'drag-placeholder' : ''}`} data-project-slot={project.id} style={{ display: focusedId ? focusedId !== project.id ? 'none' : undefined : !visibleIds.has(project.id) ? 'none' : undefined }}><ProjectPanel project={project} index={index}
                hidden={focusedId ? focusedId !== project.id : !visibleIds.has(project.id)} focused={focusedId === project.id && !previewFile}
                navTarget={projectSwitch?.id === project.id ? projectSwitch.sequence : undefined}
                navPosition={projectSwitch?.id === project.id && switchPosition > 0 ? t('{position} / {total}', { position: switchPosition, total: navigation.current.length }) : undefined}
                fontSize={settings.fontSize} now={now} activityOpen={settings.activityPane} onToggleActivity={() => setPreference({ activityPane: !settings.activityPane })} onFocus={focusProject} onAction={perform} onError={reportError} onOpenLink={openLinkInPopup} onRevealProject={revealProject}
                dragging={reorder.drag?.id === project.id} /> </div>)}
              {reorder.drag && <div className="reorder-hint" role="status">{t('拖动项目排序 · 松开完成')}<span>{t('Esc 取消')}</span></div>}
            </div>
          </>}
        </div>
      </main>
      {shownView !== 'workspace' && <div className="home-layer">
        <DecisionHome projects={projects} decisions={decisions} snoozed={snoozed} onOpenProject={id => void focusProject(id)} onOpenDecision={openDecision} onAction={perform} onError={reportError} />
      </div>}
    </div>
    {popup && <Suspense fallback={null}><FilePopup target={popup} onError={reportError} /></Suspense>}
    {error && <div className="error-toast" role="alert"><Info size={18} /><span>{error}</span><IconButton label={t('关闭提示')} onClick={() => setError(null)}><X size={16} /></IconButton></div>}
    {guide === 'tour' && <GuideTour projects={projects} focusedId={focusedId} withAdd={tourWithAdd.current} onClose={() => { setGuide(null); if (settings.guideVersion !== workspace.version) setPreference({ guideVersion: workspace.version }); }} />}
    {guide && guide !== 'tour' && <UsageGuide version={workspace.version} start={guide} onTour={startTour} onClose={() => { setGuide(null); if (settings.guideVersion !== workspace.version) setPreference({ guideVersion: workspace.version }); }} />}
    {settingsOpen && <SettingsDialog settings={settings} projects={workspace.projects} desktopGlass={workspace.desktopGlass} localShell={workspace.localShell ?? null} agents={agents} onAgents={setAgents} initialSection={settingsSection} updates={updates} onGuide={() => { setSettingsOpen(false); setSettingsSection('appearance'); startTour(); }} onCheckUpdate={() => { perform(api.checkForUpdates()); }} onInstallUpdate={() => { perform(api.installUpdate()); }} onDownloadPage={() => { perform(api.openDownloadPage()); }} close={() => { setSettingsOpen(false); setSettingsSection('appearance'); }} update={setPreference} quit={() => perform(api.quit())} />}
    {addOpen && <AddProjectDialog onClose={() => setAddOpen(false)} onAdded={() => setQuery('')} onError={reportError} />}
    {sshAuth[0] && <SSHAuthDialog key={sshAuth[0].id} request={sshAuth[0]} />}
    <VoiceOverlay />
  </div>;
}
