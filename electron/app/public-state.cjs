const { projectSvgForTheme } = require('../project-svg.cjs');

function briefAction(action) {
  return action ? { kind: action.kind, tool: action.tool, target: action.target, detail: action.detail, done: action.done, phrase: action.phrase, object: action.object } : null;
}

function terminalUsage(s, dispatchedOnly) {
  const usage = s?.nativeStructured ? s.nativeUsage?.snapshot(s.calls?.snapshot()) || dispatchedOnly(s)
    : s?.cliActive && s.usage ? s.usage.snapshot(s.usageHistory) : dispatchedOnly(s);
  return s?.calls?.usage(usage) || usage;
}

function createPublicState(host) {
  function findProject(id) {
    if (typeof id !== 'string') throw new Error('无效的项目。');
    const project = host.store.findTerminal(id)?.project;
    if (!project) throw new Error('项目不存在。');
    return project;
  }
  // The folder a terminal's conversations belong to: where its restored session ran, else its project's folder.
  function folderOf(id) { return host.store.findTerminal(id)?.record.restore?.cwd || findProject(id).path; }
  function publicState() {
    const { store, app, process = globalThis.process, windowZoom, macTitlebar, desktopGlassBackend, desktopGlassActive, desktopGlassWindow,
      getBranch, t, sessions, localShell, startupErrors, restorePlans, readingHistory, dispatchedOnly } = host;
    return {
      projects: store.projects.map(p => {
        const opened = terminalIds(p);
        const terminals = shownTerminalIds(p).map(id => {
          const current = sessions.get(id), s = current?.switchPreviousHost || current;
          const reading = !s?.nativeStructured && !s?.error && !startupErrors.has(id)
          && (s?.cliActive || !s?.inputDirty && (restorePlans.has(id) || s?.agentStarting)) ? readingHistory.summary(id) : null;
          return { id, title: t('终端 {n}', { n: opened.indexOf(id) + 1 }),
          shell: s?.shellKind || (p.kind === 'ssh' ? 'bash' : localShell().kind), sessionId: s?.nativeStructured ? null : s?.sessionId || null,
          status: s?.status || 'stopped', cliActive: s?.cliActive || false, agent: s?.cliActive ? s.agent || 'codex' : null,
            ...(reading ? { readingHistory: reading } : {}),
            agentStarting: !!s?.agentStarting && !s.cliActive && s.status !== 'exited' && !s.error,
            agentStartedAt: s?.cliActive ? s.activitySince : null,
            nativeMode: s?.nativeMode || null, nativeRuntimeSessionId: s?.nativeRuntimeSessionId || null, nativePathReason: s?.nativePathReason || null, switchState: s?.switchState || null,
            // The model, effort and fast mode its records show, above the reading view's message box.
            agentSettings: s?.cliActive ? s.agentSettings || null : null,
            // The service its model is reached through, the context it fills and the tokens it took, for the activity pane.
            agentUsage: terminalUsage(s, dispatchedOnly),
            // A run of the CLI that is no conversation (update, --version, login), for the reading view to say so.
            agentCommand: s?.cliActive ? s.agentCommand || null : null,
            codexActivity: s?.completionWork?.reading ? 'working' : s?.codexActivity || 'unknown',
            needsInput: s?.needsInput?.message || null, shellReady: !!s?.ready && !s?.inputDirty, codexAvailable: s?.codexAvailable ?? null,
            mainTurn: s?.cliActive ? s.completionWork?.mainTurn(s.activitySnapshot) || null : null,
            cliState: s?.cliActive ? s.cliState || null : null,
            lastCompletedAt: s?.lastCompletedAt || null, error: s?.error || startupErrors.get(id) || null,
            // The step a working agent is on, for the card's one-line status; the full list is sent separately.
            action: s?.cliActive && s.codexActivity === 'working' ? briefAction(s.actions.current()) : null,
            // What the round was asked to do, in a few words, for the activity overview.
            task: s?.cliActive ? s.promptQueue.task?.summary || s.lastTaskSummary || s.lastTask || '' : '',
            taskTitle: s?.cliActive ? s.promptQueue.task?.title || s.lastTaskTitle || '' : '',
            // The prompts sent and not finished yet: the ones being worked on, then the ones waiting.
            prompts: s?.cliActive ? s.promptQueue.list() : [] };
        });
        const first = terminals[0];
        const activeCodex = terminals.filter(item => item.cliActive);
        const activity = activeCodex.some(item => item.codexActivity === 'working') ? 'working'
        : activeCodex.some(item => item.codexActivity === 'interrupted') ? 'interrupted'
        : activeCodex.length && activeCodex.every(item => item.codexActivity === 'complete') ? 'complete' : 'unknown';
        const status = activeCodex.length ? 'codex' : terminals.some(item => item.status === 'shell') ? 'shell' : terminals.some(item => item.status === 'starting') ? 'starting' : first.status;
        return {
          id: p.id, name: p.name, path: p.path, unread: p.unread, lastCompletedAt: p.lastCompletedAt,
          kind: p.kind || 'local', ssh: p.ssh || null,
          ...(p.image ? { image: projectSvgForTheme(p.image, store.settings.theme) } : {}),
          ...(p.imageMode ? { imageMode: p.imageMode } : {}),
          branch: getBranch(p.id) || '',
          terminals, sessionId: first.sessionId, status,
          cliActive: activeCodex.length > 0, codexActivity: activity, agent: activeCodex[0]?.agent || null,
          shellReady: first.shellReady, codexAvailable: first.codexAvailable,
          error: terminals.find(item => item.error)?.error || null,
          action: terminals.find(item => item.action)?.action || null,
        };
      }),
      settings: store.settings,
      uiZoom: windowZoom?.percent ?? 100,
      desktopGlass: { supported: !!desktopGlassBackend, compatibility: desktopGlassBackend === 'windows-compat', active: desktopGlassActive,
        restart: store.settings.surface === 'glass' && store.settings.glassBackground === 'desktop' && !!desktopGlassBackend && !desktopGlassWindow,
        failed: desktopGlassWindow && !desktopGlassActive },
      warning: store.warning,
      platform: process.platform,
      nativeTitlebar: macTitlebar?.attached === true,
      // macOS and Linux: the shell new local terminals use and whether zsh is installed, for Settings.
      localShell: ['darwin', 'linux'].includes(process.platform) ? (({ kind, zsh }) => ({ kind, zsh }))(localShell()) : null,
      // In full screen the title bar slides away and returns when the pointer touches the top edge. The
      // desktop checks drive the title bar in full screen, so isolated test profiles keep it unless asked.
      autoHideTitlebar: !process.env.AGENTRIX_DATA_DIR || process.env.AGENTRIX_TEST_TITLEBAR === '1',
      version: app.getVersion(),
      // The usage guide opens on first use and after each update. Isolated test profiles skip it unless asked.
      guide: store.settings.guideVersion !== app.getVersion() && (!process.env.AGENTRIX_DATA_DIR || process.env.AGENTRIX_TEST_GUIDE === '1'),
    };
  }

  function terminalIds(project) {
    const extra = (project.terminals || []).map(item => item.id);
    return !host.sessions.has(project.id) && project.primaryTerminalClosed === true && extra.length ? extra : [project.id, ...extra];
  }

  // The order a project's terminals are shown in, as they were dragged; titles keep the numbers they were opened with.
  function shownTerminalIds(project) {
    const ids = terminalIds(project), order = project.terminalOrder || [];
    const at = id => { const index = order.indexOf(id); return index < 0 ? Infinity : index; };
    return [...ids].sort((a, b) => at(a) - at(b) || ids.indexOf(a) - ids.indexOf(b));
  }
  function reorderTerminals(projectId, ids) {
    const project = findProject(projectId), current = terminalIds(project);
    if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length || ids.some(id => !current.includes(id))) throw new Error('终端已变化，请重新拖动。');
    host.store.setTerminalOrder(project.id, ids);
  }

  function disposeProjectTerminals(project) {
    const { readingHistory, restorePlans, disposeTerminal, startupErrors } = host;
    for (const id of [project.id, ...(project.terminals || []).map(item => item.id)]) { readingHistory.close(id); restorePlans.delete(id); disposeTerminal(id); startupErrors.delete(id); }
  }

  return { findProject, folderOf, publicState, terminalIds, shownTerminalIds, reorderTerminals, disposeProjectTerminals };
}

module.exports = { createPublicState, terminalUsage };
