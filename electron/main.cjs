const { registerWindowIpc } = require('./app/window-ipc.cjs');
const { registerAppSchemes, registerAppProtocols } = require('./app/protocols.cjs');
const { configureApplication, prepareWindowIcon, prepareShellIntegration } = require('./app/platform-startup.cjs');
const { registerWindowContents, registerWindowLifecycle } = require('./app/window-events.cjs');
const { registerWindowZoom } = require('./app/window-zoom.cjs');
const { buildMacMenuTemplate } = require('./app/mac-menu.cjs');
const { registerMacTitlebar } = require('./app/mac-titlebar.cjs');
const { minWidth, minHeight } = require('./window-zoom.json');
const { createImageTools, registerImageIpc } = require('./app/images.cjs');
const { createProjectHandoff } = require('./app/project-handoff.cjs');
const { createCloseGuards, restoreTerminals } = require('./app/terminal-lifecycle.cjs');
const { registerClipboardIpc } = require('./shared/clipboard-ipc.cjs');
const { registerTerminalIpc } = require('./features/terminal/ipc.cjs');
const { ApprovalGuard, approvalStamp } = require('./features/terminal/approval-guard.cjs');
const { registerNativeIpc } = require('./features/terminal/native-ipc.cjs');
const { createNativeSessions, createNativeUsage } = require('./features/native-session/index.cjs');
const { subscriptionLimits } = require('./features/native-session/usage.cjs');
const { createProjectAccounts } = require('./features/native-session/project-accounts.cjs');
const { inspectClaudeExecutable } = require('./features/claude-sdk/executable.cjs');
const { recoveryWarnings, readJson: readNativeJson, writeJson: writeNativeJson } = require('./features/native-session/storage.cjs');
const { createClaudeRuntime } = require('./features/claude-sdk/index.cjs');
const { createSdkLoader } = require('./features/claude-sdk/runtime.cjs');
const { registerClaudeWorker } = require('./features/native-session/worker.cjs');
const { registerWorkspaceIpc } = require('./features/workspace/ipc.cjs');
const { listProjectImageCandidates, LIMITS: PROJECT_IMAGE_LIMITS } = require('./features/workspace/project-images.cjs');
const { createProjectImageAuto } = require('./features/workspace/project-image-auto.cjs');
const { projectSvgForTheme } = require('./project-svg.cjs');
const { createSshRuntime } = require('./features/ssh/runtime.cjs');
const { registerSshIpc } = require('./features/ssh/ipc.cjs');
const { registerFilesIpc } = require('./features/files/ipc.cjs');
const { createEditorGuard } = require('./features/files/editor-guard.cjs');
const { createGitRuntime } = require('./features/git/runtime.cjs');
const { registerGitIpc } = require('./features/git/ipc.cjs');
const { registerUpdatesIpc } = require('./features/updates/ipc.cjs');
const { registerAgentsIpc } = require('./features/agents/ipc.cjs');
const { createInterventions } = require('./features/agents/interventions.cjs');
const { registerSkillsIpc } = require('./features/skills/ipc.cjs');
const { SkillsStore } = require('./features/skills/store.cjs');
const { writeFileAtomic } = require('./atomic-write.cjs');
const { folderHistory, launchCommand } = require('./features/agents/launch.cjs');
const { READING_NOTE } = require('./features/agents/reading-note.cjs');
const { writeHandoff, startupNote } = require('./features/agents/handoff.cjs');
const { remember, roundsOf } = require('./features/agents/project-memory.cjs');
const { agentSettings } = require('./features/agents/agent-settings.cjs');
const { UsageMeter, claudeProvider, codexProvider, claudeAccount, claudeAccountFiles, readClaudeAccountCache } = require('./features/agents/agent-usage.cjs');
const { AgentCalls } = require('./features/agents/agent-calls.cjs');
const { DashboardRecords, quotaScope } = require('./features/dashboard/records.cjs');
const { createDashboard } = require('./features/dashboard/index.cjs');
const { createLab } = require('./features/lab/index.cjs');
const { routingNote } = require('./features/dashboard/decisions.cjs');
const { CodexAccountUsage, codexExecutable, resetCreditMessage } = require('./features/agents/codex-account-usage.cjs');
const { createRpc: createResetRpc } = require('./features/codex-app-server/rpc.cjs');
const codexAccounts = new CodexAccountUsage({ resetClient: { rpcFactory: createResetRpc }, resetStorage: {
  read: () => readNativeJson(path.join(app.getPath('userData'), 'codex-reset-attempts.json'), null),
  write: value => writeNativeJson(path.join(app.getPath('userData'), 'codex-reset-attempts.json'), value),
}, audit: event => {
  const file = path.join(app.getPath('userData'), 'codex-reset-events.json');
  const previous = readNativeJson(file, []);
  writeNativeJson(file, [...(Array.isArray(previous) ? previous : []), event].slice(-500));
} });
const projectAccounts = createProjectAccounts({ codex: codexAccounts, readClaude: readClaudeAccountCache });
const { ClaudeAccountUsage, readClaudeAccount } = require('./features/agents/claude-account-usage.cjs');
const claudeAccounts = new ClaudeAccountUsage({ changed: () => queueClaudeAccounts(), read: options => readClaudeAccount({ ...options,
  routes: localClaudeMeters().map(s => ({ cwd: s.usageCwd, env: s.usageEnv || process.env })),
  fetch: (url, options) => electronNet.fetch(url, options),
}) });
const { agentCommand } = require('./features/agents/agent-command.cjs');
const { setThumbnailer, isGeneratedImage, setGeneratedPreview, setConversationTranslator } = require('./conversation.cjs');
const { saveDialogOptions, saveTarget } = require('./image-save.cjs');
const { registerVoiceIpc } = require('./features/voice/ipc.cjs');
const { createIpcAdapter } = require('./shared/ipc.cjs');
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, Notification, clipboard, shell, screen, protocol, session: electronSession, net: electronNet, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { desktopGlassKind, desktopGlassOptions, applyDesktopGlass } = require('./desktop-glass.cjs');
const { execFile, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const pty = require('node-pty');
const { WorkspaceStore } = require('./state.cjs');
const { createEventServer } = require('./events.cjs');
const { ProjectGit } = require('./project-git.cjs');
const { acceptShellEvent, SubmissionTracker, PromptMarkers, InputGate, isTerminalResponse } = require('./terminal-input.cjs');
const { PromptQueue, promptText, promptSummary: summarizeTask, rememberClaudeSource } = require('./prompt-queue.cjs');
const { CompletionWork } = require('./completion-work.cjs');
const { createTerminalEnvironment } = require('./terminal-env.cjs');
const { adoptSystemProxy } = require('./system-proxy.cjs');
const { PreviewResources } = require('./preview-resources.cjs');
const { createFileCards, documentText } = require('./features/files/file-cards.cjs');
const { UpdateManager, isInstalledBuild, distributionOf } = require('./updates.cjs');
const { getSSHInfo } = require('./ssh-config.cjs');
const { SSHAuthServer } = require('./ssh-auth.cjs');
const { RemoteConnection } = require('./remote-connection.cjs');
const { watchRemoteClaudeAccount } = require('./features/ssh/claude-account.cjs');
const { claudeResumeCommand } = require('./session-restore.cjs');
const { CodexActivityReader, monitorActivity } = require('./codex-activity.cjs');
const { TerminalTitleTracker, wholeThread } = require('./terminal-title.cjs');
const { FileOperations } = require('./file-operations.cjs');
const { ClipboardWrites } = require('./clipboard-writes.cjs');
const { VoiceManager } = require('./voice.cjs');
const { ActionLog, TranscriptTail, claudeRecord, codexRecord, skillDescription } = require('./agent-actions.cjs');
const { ConversationLog, claudeConversation, codexConversation } = require('./conversation.cjs');
const { ReadingHistory } = require('./reading-history.cjs');
const { conversationBatchDelay, pollAfterSubmission } = require('./conversation-timing.cjs');
const { listAgentCommands, isLocalAgentCommand } = require('./agent-commands.cjs');
const { claudeConfigDir, findClaudeSession } = require('./claude-sessions.cjs');
const { AgentsManager, onPath } = require('./agents.cjs');
const { macShell, linuxShell, shellEnvironment, zshEnvironment, bashArguments, withoutAppImage, terminalLocale } = require('./zsh-terminal.cjs');

const root = path.join(__dirname, '..');
const integrationDir = app.isPackaged ? path.join(process.resourcesPath, 'integration') : path.join(root, 'integration');
const { accountEnvironment } = require(path.join(integrationDir, 'codex-account-scope.cjs'));
const devUrl = !app.isPackaged ? process.env.AGENTRIX_DEV_URL : null;
const { installed, appUserModelId, relaunchDisplayName, voiceDirectory } = configureApplication(app);
const dashboard = new DashboardRecords(app.getPath('userData'));
registerAppSchemes(protocol);

const { translate } = require('./i18n.cjs');
// Text shown by the main process follows the language chosen in settings (Chinese source -> locales/en.json).
const t = (text, values) => translate(store?.settings.language, text, values);
setConversationTranslator(t);
let window, tray, store, eventServer, sshAuth, updateManager, quitting = false, updatesIpc, projectImageAuto, windowZoom, dashboardWindow = null, labWindow = null, quitCleaned = false;
let macTitlebar = null;
const desktopGlassBackend = desktopGlassKind();
let desktopGlassWindow = false, desktopGlassActive = false;
function windowBackgroundColor() { return store.settings.theme === 'light' ? '#f8f9fb' : '#181818'; }
// macOS draws its own window parts (the full-screen title strip, menus, dialogs) in the system appearance unless given the theme's.
function applyNativeTheme() { if (process.platform === 'darwin') nativeTheme.themeSource = store.settings.theme === 'light' ? 'light' : 'dark'; }
function updateStoreSettings(patch) {
  const { theme, uiZoom, language, shortcuts } = store.settings;
  store.updateSettings(patch);
  if (theme !== store.settings.theme) applyNativeTheme();
  // An active system backdrop needs its transparent ground, including when the theme changes.
  if (theme !== store.settings.theme && window && !window.isDestroyed() && !desktopGlassActive) window.setBackgroundColor(windowBackgroundColor());
  // The settings IPC broadcasts after applying the window's new zoom.
  if (uiZoom !== store.settings.uiZoom) windowZoom?.update();
  const languageChanged = language !== store.settings.language;
  if (languageChanged) trayMenu();
  if (languageChanged || JSON.stringify(shortcuts) !== JSON.stringify(store.settings.shortcuts)) {
    macTitlebar?.refresh();
    if (process.platform === 'darwin') rebuildMacMenu();
  }
}
const sessions = new Map();
const readingHistory = new ReadingHistory(() => { if (window && store && !quitting) broadcast(); });
function prepareReading(id, restore, filename) {
  const project = findProject(id);
  if (project.kind === 'ssh' || !['codex', 'claude'].includes(restore?.agent) || !/^[\w-]{1,100}$/.test(restore?.threadId || '')) return Promise.resolve();
  return readingHistory.bind(id, { agent: restore.agent, threadId: restore.threadId,
    cwd: sessions.get(id)?.agentCwd || restore.cwd || store.findTerminal(id)?.record.restore?.cwd || project.path,
    home: restore.agent === 'claude' ? claudeConfigDir() : sessions.get(id)?.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), filename });
}
const { handoffFile, memoryDir, memoryFolder, scrubProjectSkills, sshHandoff } = createProjectHandoff({ app, getStore: () => store, sessions });
const { setBranch, captureBranch, getBranch, forgetBranch, remoteBranch } = createGitRuntime({ getProjects: () => store.projects, execFile, broadcast });
const projectGit = new ProjectGit(id => remoteFor(id));
const startupErrors = new Map();
const restorePlans = new Map();
const previewResources = new PreviewResources({ remote: project => remoteFor(project.id), getProjects: () => store?.projects || [] });
function generatedPreview(item, spec) {
  if (!isGeneratedImage(item.savedPath)) return null;
  try {
    const folder = fs.realpathSync.native(path.dirname(item.savedPath));
    const project = { id: spec.projectId, path: folder, kind: 'local', previewRoot: folder, previewSingleFile: true, previewProjectPath: spec.cwd };
    return { images: [previewResources.open(project, path.basename(item.savedPath), 'image', undefined, true).url] };
  } catch { return null; }
}
const { thumbnail, small, pictureOf, thumbnailProjectImage, pictureFrom } = createImageTools({ nativeImage, BrowserWindow, previewResources });
async function projectImageCandidates(folder, candidates = 6, theme = 'mono') {
  const result = await listProjectImageCandidates(folder, thumbnailProjectImage, { ...PROJECT_IMAGE_LIMITS, candidates });
  return { ...result, candidates: result.candidates.map(candidate => ({ ...candidate, image: projectSvgForTheme(candidate.image, theme) })) };
}

setThumbnailer(pictureOf, url => thumbnail(nativeImage.createFromDataURL(url)) || url);
setGeneratedPreview(item => generatedPreview(item, { projectId: null, cwd: path.dirname(item.savedPath) }));
const capturePage = require('./features/files/capture-page.cjs').createPageCapture(BrowserWindow);
const fileCard = createFileCards({ previews: previewResources, capture: capturePage, shrink: pictureOf, shrinkBytes: bytes => small(nativeImage.createFromBuffer(bytes)) });
let stateTimer;
let runtimeDir;
let nativeSessions, claudeRuntime, dispatchControl, controlAddress, terminalInput;
const nativeSpecs = new Map();
const { prepareAskpass, cleanupAskpass } = createSshRuntime({ fs, execFileSync, tempDirectory: () => app.getPath('temp'), integrationDir });
let zshStartup;
let shellPathReady = Promise.resolve();
let activeTerminal = null;
let activeFileTree = null;
let fileOperations, filesIpc;
let voiceManager;
let skills;
let attentionTimer;
const { allowEditorClose, affectsEditor, getEditorFile, registerEditorIpc } = createEditorGuard({ getWindow: () => window, showWindow, send, randomUUID, dialog, t });
const { confirmTerminalClose, requestQuit, liveTerminalCount } = createCloseGuards({ app, dialog, getWindow: () => window,
  sessions, findProject, allowEditorClose, t, setQuitting: value => { quitting = value; } });
const clipboardWrites = new ClipboardWrites();
const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cmdPath = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
function send(channel, data) { if (window && !window.isDestroyed()) window.webContents.send(channel, data); }
const agents = new AgentsManager({ onChange: state => send('agents:changed', state), translate: t });
function findProject(id) {
  if (typeof id !== 'string') throw new Error('无效的项目。');
  const project = store.findTerminal(id)?.project;
  if (!project) throw new Error('项目不存在。');
  return project;
}
// The folder a terminal's conversations belong to: where its restored session ran, else its project's folder.
function folderOf(id) { return store.findTerminal(id)?.record.restore?.cwd || findProject(id).path; }
function publicState() {
  return {
    projects: store.projects.map(p => {
      const opened = terminalIds(p);
      const terminals = shownTerminalIds(p).map(id => {
        const current = sessions.get(id), s = current?.switchPreviousHost || current;
        const reading = !s?.nativeStructured && !s?.error && !startupErrors.has(id) && (s?.codexActive || !s?.inputDirty && (restorePlans.has(id) || s?.agentStarting)) ? readingHistory.summary(id) : null;
        return { id, title: t('终端 {n}', { n: opened.indexOf(id) + 1 }), shell: s?.shellKind || (p.kind === 'ssh' ? 'bash' : localShell().kind), sessionId: s?.nativeStructured ? null : s?.sessionId || null, status: s?.status || 'stopped', codexActive: s?.codexActive || false, agent: s?.codexActive ? s.agent || 'codex' : null,
          ...(reading ? { readingHistory: reading } : {}),
          agentStarting: !!s?.agentStarting && !s.codexActive && s.status !== 'exited' && !s.error,
          agentStartedAt: s?.codexActive ? s.activitySince : null,
          nativeMode: s?.nativeMode || null, nativeRuntimeSessionId: s?.nativeRuntimeSessionId || null, nativePathReason: s?.nativePathReason || null, switchState: s?.switchState || null,
          // The model, effort and fast mode its records show, above the reading view's message box.
          agentSettings: s?.codexActive ? s.agentSettings || null : null,
          // The service its model is reached through, the context it fills and the tokens it took, for the activity pane.
          agentUsage: s?.nativeStructured ? s.nativeUsage?.snapshot(s.calls?.snapshot()) || dispatchedOnly(s)
            : s?.codexActive && s.usage ? s.usage.snapshot(s.usageHistory) : dispatchedOnly(s),
          // A run of the CLI that is no conversation (update, --version, login), for the reading view to say so.
          agentCommand: s?.codexActive ? s.agentCommand || null : null,
          codexActivity: s?.completionWork?.reading ? 'working' : s?.codexActivity || 'unknown', needsInput: s?.needsInput?.message || null, shellReady: !!s?.ready && !s?.inputDirty, codexAvailable: s?.codexAvailable ?? null,
          mainTurn: s?.codexActive ? s.completionWork?.mainTurn(s.activitySnapshot) || null : null,
          cliState: s?.codexActive ? s.cliState || null : null,
          lastCompletedAt: s?.lastCompletedAt || null, error: s?.error || startupErrors.get(id) || null,
          // The step a working agent is on, for the card's one-line status; the full list is sent separately.
          action: s?.codexActive && s.codexActivity === 'working' ? briefAction(s.actions.current()) : null,
          // What the round was asked to do, in a few words, for the activity overview.
          task: s?.codexActive ? s.promptQueue.task?.summary || s.lastTaskSummary || s.lastTask || '' : '',
          taskTitle: s?.codexActive ? s.promptQueue.task?.title || s.lastTaskTitle || '' : '',
          // The prompts sent and not finished yet: the ones being worked on, then the ones waiting.
          prompts: s?.codexActive ? s.promptQueue.list() : [] };
      });
      const first = terminals[0];
      const activeCodex = terminals.filter(item => item.codexActive);
      const activity = activeCodex.some(item => item.codexActivity === 'working') ? 'working' : activeCodex.some(item => item.codexActivity === 'interrupted') ? 'interrupted' : activeCodex.length && activeCodex.every(item => item.codexActivity === 'complete') ? 'complete' : 'unknown';
      const status = activeCodex.length ? 'codex' : terminals.some(item => item.status === 'shell') ? 'shell' : terminals.some(item => item.status === 'starting') ? 'starting' : first.status;
      return {
        id: p.id, name: p.name, path: p.path, unread: p.unread, lastCompletedAt: p.lastCompletedAt,
        kind: p.kind || 'local', ssh: p.ssh || null,
        ...(p.image ? { image: projectSvgForTheme(p.image, store.settings.theme) } : {}),
        ...(p.imageMode ? { imageMode: p.imageMode } : {}),
        branch: getBranch(p.id) || '',
        terminals, sessionId: first.sessionId, status,
        codexActive: activeCodex.length > 0, codexActivity: activity, agent: activeCodex[0]?.agent || null,
        shellReady: first.shellReady, codexAvailable: first.codexAvailable,
        error: terminals.find(item => item.error)?.error || null,
        action: terminals.find(item => item.action)?.action || null,
      };
    }),
    settings: store.settings,
    uiZoom: windowZoom?.percent ?? 100,
    desktopGlass: { supported: !!desktopGlassBackend, compatibility: desktopGlassBackend === 'windows-compat', active: desktopGlassActive, restart: store.settings.surface === 'glass' && store.settings.glassBackground === 'desktop' && !!desktopGlassBackend && !desktopGlassWindow, failed: desktopGlassWindow && !desktopGlassActive },
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
  return !sessions.has(project.id) && project.primaryTerminalClosed === true && extra.length ? extra : [project.id, ...extra];
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
  store.setTerminalOrder(project.id, ids);
}

function disposeProjectTerminals(project) {
  for (const id of [project.id, ...(project.terminals || []).map(item => item.id)]) { readingHistory.close(id); restorePlans.delete(id); disposeTerminal(id); startupErrors.delete(id); }
}
function updateIndicators() {
  const unread = store.projects.filter(p => p.unread > 0).length;
  if (window && !window.isDestroyed()) {
    window.setTitle(process.platform === 'darwin' && window.isFullScreen() ? '' : `${unread ? `(${unread}) ` : ''}${t('Agentrix')}`);
    if (!unread) window.flashFrame(false);
  }
  if (tray && !tray.isDestroyed()) {
    tray.setImage(trayImage(unread ? 'icon-alert.png' : 'icon.png'));
    tray.setToolTip(unread ? t('Agentrix · {count} 个项目待查看', { count: unread }) : t('Agentrix'));
  }
}
// The macOS menu bar draws an image at its own size in points, so the 256-pixel icon is scaled to fit it.
function trayImage(name) {
  const image = nativeImage.createFromPath(path.join(root, 'assets', name));
  return process.platform === 'darwin' ? image.resize({ width: 18, height: 18 }) : image;
}
// macOS: the application menu gives ⌘Q, ⌘H and ⌘M their usual meaning. Copy and paste stay with the window's
// own key handling (before-input-event and the terminals), so there is no Edit menu to compete with it.
function macMenu() {
  return Menu.buildFromTemplate(buildMacMenuTemplate({
    appName: app.name, t, shortcuts: store?.settings.shortcuts,
    updateReady: updateManager?.getState().status === 'ready', command: command => {
      showWindow();
      send('menu:command', command);
    },
    quit: () => { showWindow(); requestQuit().catch(report); }, close: () => window?.close(),
    // A separate window: no need to show the main one. Errors reach the main window like the other main-process failures.
    openDashboard: () => dashboardWindow?.open().catch(report),
    openLab: () => labWindow?.open().catch(report),
  }));
}

function rebuildMacMenu() {
  if (process.platform === 'darwin') Menu.setApplicationMenu(macMenu());
}

// Rebuilt when the language changes; Electron menus keep the labels they were built with.
function trayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('打开 Agentrix'), click: () => showWindow() },
    { type: 'separator' },
    { label: t('退出应用'), click: () => { showWindow(); requestQuit().catch(report); } },
  ]));
}

function broadcast() {
  dashboardWindow?.sync();
  syncDashboardLive();
  labWindow?.sync();
  skills?.syncWatchers();
  clearTimeout(stateTimer);
  stateTimer = null;
  updateIndicators();
  send('workspace:changed', publicState());
}
function scheduleState() { if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = null; broadcast(); }, 700); }
function report(error) { send('app:error', String(error?.message || error)); }

function showWindow(id) {
  if (!window || window.isDestroyed()) return;
  window.show();
  if (window.isMinimized()) window.restore();
  window.focus();
  if (id) send('project:focus', id);
}

function notifyCompletion(project) {
  if (!window.isFocused()) {
    window.flashFrame(true); clearTimeout(attentionTimer);
    attentionTimer = setTimeout(() => { if (window && !window.isDestroyed()) window.flashFrame(false); }, 9000);
    attentionTimer.unref?.();
  }
  if (store.settings.notifications && Notification.isSupported()) {
    const note = new Notification({
      title: t('{name} · 本轮已完成', { name: project.name }),
      body: t('这一轮任务已结束，点击查看终端。'),
      icon: path.join(root, 'assets/icon-alert.png'),
      silent: !store.settings.sound,
    });
    note.on('click', () => showWindow(project.id));
    note.on('failed', () => {});
    note.show();
  }
}

function briefAction(action) { return action ? { kind: action.kind, tool: action.tool, target: action.target, detail: action.detail, done: action.done, phrase: action.phrase, object: action.object } : null; }
// A step that starts or ends changes the card's one-line status.
function publishAction(s, change) {
  if (sessions.get(s.terminalId) !== s) return;
  scheduleState();
  // Only a successful tool result proves a read; round settlement/idle callbacks do not.
  if (change?.finished) skills?.recordAction(change.action, { cwd: s.actionsCwd || findProject(s.terminalId).path, project: s.projectId,
    agent: s.agent, since: s.activitySince || 0, clockOffset: s.activityClockOffset || 0, remotePaths: s.terminal.info?.skills || null });
}
// The conversation for the reading view reaches the window in small batches.
function publishConversation(s, change) {
  if (sessions.get(s.terminalId) !== s || s.conversation.loading) return;
  (s.conversationChanges ||= []).push(change);
  const delay = conversationBatchDelay(s.conversationChanges);
  if (s.conversationTimer && s.conversationDelay === delay) return;
  clearTimeout(s.conversationTimer); s.conversationDelay = delay;
  s.conversationTimer = setTimeout(() => {
    const changes = s.conversationChanges; s.conversationChanges = []; s.conversationTimer = null; s.conversationDelay = null;
    if (sessions.get(s.terminalId) !== s || s.conversation.loading) return;
    // An answer streamed word by word puts the same entry many times in one batch: only its latest version goes.
    const latest = new Map();
    for (const item of changes) if (item.entry) latest.set(item.entry.id, item.entry);
    const scope = { id: s.terminalId, sessionId: s.sessionId, historyKey: readingHistory.summary(s.terminalId)?.key };
    send('terminal:conversation', latest.size > 40 || changes.some(item => item.reset) ? { ...scope, list: s.conversation.snapshot() } : { ...scope, changes: [...latest.values()] });
  }, delay);
}
// How often an agent's records are read when nothing told of a write: often while it works, so the reading view keeps
// up with it (and over SSH, where no write is told), seldom while it waits.
const readEvery = s => s.codexActivity === 'working' ? 250 : 1000;
// The model, effort and fast mode an agent's record shows (agent-settings.cjs), and the tokens it reports
// (agent-usage.cjs): a change is published with the state.
function noteSettings(s, agent, record) {
  const next = agentSettings(s.agentSettings || null, agent, record);
  if (next !== (s.agentSettings || null)) { s.agentSettings = next; scheduleState(); }
  const limits = s.usage?.limits;
  if (s.usage?.apply(record) && (!s.usageHistory || s.usage.limits !== limits)) {
    if (!s.usageHistory) s.recordQuota?.(agent, s.usage.limits);
    scheduleState(); scheduleUsageRollover();
  }
  if (agent === 'codex' && record?.type === 'session_meta') s.bindUsageAccount?.();
  if (agent === 'codex' && !s.usageHistory && record?.type === 'event_msg') {
    if (record.payload?.type === 'token_count') s.usageAccount?.refresh(30000);
    else if (['task_complete', 'turn_completed'].includes(record.payload?.type)) s.usageAccount?.refresh();
  }
}
// A skill step names the skill; what the skill is for comes from its SKILL.md, a moment later.
function describeActions(s, cwd, actions) {
  s.actionsCwd = cwd;
  for (const action of actions || []) {
    if (action.kind !== 'skill') continue;
    const skill = skills?.matchFile(action.skillFile, action.cwd || cwd, s.projectId, s.terminal.info?.skills || null);
    if (skill) { action.description = skill.description; s.actions.update(action); continue; }
    if (findProject(s.terminalId).kind === 'ssh') continue;
    skillDescription(action.target, cwd, action.skillFile).then(description => { if (description) { action.description = description; s.actions.update(action); } }).catch(() => {});
  }
}
function startSkillSession(project, s, sequence, started = true) {
  skills.endSession(project.id, s.skillSessionId);
  s.skillSessionId = randomUUID();
  const remote = project.kind === 'ssh';
  const delivery = skills.delivery(project, remote, s.skillSessionId, { agent: s.agent, started });
  const note = startupNote(READING_NOTE, remote ? '{AGENTRIX_HANDOFF}' : handoffFile(s.terminalId),
    (remote ? path.posix : path).join(project.path, 'skills'), delivery, remote ? '{AGENTRIX_DISPATCH}' : path.join(integrationDir, 'dispatch.cjs'));
  if (remote) {
    void s.terminal.request('skill-note', { sequence, note, skills: delivery.bundle }).then(paths => {
      if (s.terminal.info) s.terminal.info.skills = paths;
    }).catch(report);
  } else {
    writeFileAtomic(s.skillNoteFile, note); s.skillNote = note;
  }
}

function endSkillSession(s) {
  skills.endSession(s.projectId, s.skillSessionId);
  s.skillSessionId = null;
}

// Wrappers reread idle shells' notes. Running agents keep the note actually delivered at their launch.
function refreshSkillNotes() {
  for (const s of sessions.values()) {
    if (!s.skillNoteFile || s.codexActive || s.status === 'exited') continue;
    const project = store.projects.find(project => project.id === s.projectId);
    if (!project) continue;
    const note = startupNote(READING_NOTE, handoffFile(s.terminalId), path.join(project.path, 'skills'), skills.delivery(project, false, s.sessionId), path.join(integrationDir, 'dispatch.cjs'));
    if (note !== s.skillNote) { writeFileAtomic(s.skillNoteFile, note); s.skillNote = note; }
  }
}
// Claude Code writes each tool call to its transcript; follow it while the session lasts.
function followClaude(project, s, event) {
  const remote = project.kind === 'ssh', paths = remote ? path.posix : path;
  const file = typeof event.transcriptPath === 'string' && (!remote || paths.isAbsolute(event.transcriptPath)) ? paths.resolve(event.transcriptPath) : '';
  if (!file || paths.basename(file) !== `${event.sessionId}.jsonl`) return;
  // The worker checks remote paths against its own Claude projects folder before reading them.
  if (!remote && !file.toLowerCase().startsWith(claudeConfigDir().toLowerCase() + path.sep)) return;
  if (!remote) void prepareReading(s.terminalId, { agent: 'claude', threadId: event.sessionId }, file);
  s.claudeFollowRequest = (s.claudeFollowRequest || 0) + 1;
  s.claudeSessionId = event.sessionId;
  s.approval?.context('claude-session', event.sessionId);
  s.usage?.calls.setFolder(remote ? null : path.join(path.dirname(file), event.sessionId, 'subagents'));
  if (s.claudeTranscript?.filename !== file) {
    let tail;
    const readCurrent = () => sessions.get(s.terminalId) === s && (!tail || s.claudeTranscript === tail)
      && (s.codexActive && s.agent === 'claude' || s.claudeResumeId === event.sessionId);
    const onHistory = ready => {
      if (ready) s.conversation.endHistory();
      else { s.conversation.beginHistory(); s.actions.reset(); s.conversation.reset(); s.usage?.reset(true); }
      if (!ready && s.completionWork?.reset()) store.expectCompletion(project.id, false);
      if (s.completionWork) s.completionWork.reading = !ready;
      usageHistory(s, ready);
    };
    s.activitySnapshot = s.activityRawSnapshot = null;
    tail = s.claudeTranscript = remote ? { filename: file } : new TranscriptTail(file, { onHistory: ready => { if (readCurrent()) onHistory(ready); }, catchUpHistory: true,
      isCurrent: readCurrent,
      onReset: partial => { if (readCurrent() && s.usage?.rates) s.usage.rates.partial = partial; }, onWorkRecord: record => onRecord({ ...record, workOnly: true }) });
    s.activityMonitor?.stop();
    const onRecord = record => {
      if (!readCurrent()) return;
      s.completionWork?.record(record, 'claude', remote ? s.activityClockOffset || 0 : 0);
      // Finish this user round even if later background records replace the poll's final snapshot.
      const endedAt = s.completionWork?.endedAt;
      if (endedAt && endedAt >= (s.activitySince || 0) && endedAt > s.promptQueue.finishedAt) s.promptQueue.finish(endedAt);
      if (record.workOnly) {
        if (['queue-operation', 'user', 'attachment'].includes(record.type)) claudeConversation(s.conversation, record, project.path, { queueOnly: true });
        return;
      }
      const turn = s.completionWork?.turn;
      if (turn && turn.updatedAt >= Math.max(s.activitySince || 0, s.activityRawSnapshot?.updatedAt || 0)) {
        s.activityRawSnapshot = { ...turn, threadId: s.claudeSessionId };
      }
      claudeConversation(s.conversation, record, project.path); describeActions(s, project.path, claudeRecord(s.actions, record, project.path));
      noteSettings(s, 'claude', record);
    };
    const since = Number.isFinite(event.sentAt) ? event.sentAt : s.activitySince || Date.now();
    const remoteStatus = value => {
      if (!value || !readCurrent() || !s.activityMonitor) return null;
      if (value.reset) onHistory(false);
      for (const record of Array.isArray(value.records) ? value.records : []) { try { onRecord(record); } catch { } }
      if (value.historyDone) onHistory(true);
      if (s.completionWork) s.completionWork.reading = !value.historyDone;
      if (s.completionWork && value.completionUncertain) s.completionWork.uncertain = true;
      return s.activityRawSnapshot && { ...s.activityRawSnapshot, workVersion: s.completionWork?.version, reading: !!s.completionWork?.reading, transcriptRead: true };
    };
    s.activityMonitor = monitorActivity(async () => {
      if (remote) return s.terminal.request('claude-status', { path: file, since }).then(remoteStatus);
      await tail.read(onRecord);
      if (!readCurrent()) return null;
      if (s.completionWork) {
        s.completionWork.reading = tail.historyPending || tail.offset < tail.fileSize || tail.buffer.length > 0;
        s.completionWork.uncertain ||= tail.workHistory?.uncertain;
      }
      return s.activityRawSnapshot && { ...s.activityRawSnapshot, workVersion: s.completionWork?.version, reading: !!s.completionWork?.reading, transcriptRead: true };
    }, snapshot => applyActivity(project, s, snapshot), { interval: () => readEvery(s), watch: () => remote ? null : tail.filename });
  } else void s.activityMonitor?.poll();
}

// Workspace broadcasts can happen while history is still reading: hold a clean snapshot until it finishes.
function usageHistory(s, ready) {
  s.calls?.history(!ready);
  if (!s.usage) return;
  s.usageHistory = ready ? null : s.usage.snapshot();
  scheduleUsageRollover();
  if (ready) scheduleState();
}

// What the activity pane shows of the model route and the tokens spent. Which service a model is reached through is
// read from this computer's settings; over SSH, Claude's stays unnamed and Codex's is the id its records give.
// The called models belong to the terminal session, so workers dispatched from a plain shell, or before the agent
// restarts, stay visible; the agent's usage meter shares them while it runs.
function callsOf(s, project) {
  if (s.switchPreviousHost) return callsOf(s.switchPreviousHost, project);
  if (s.calls) return s.calls;
  const helperPids = new WeakMap();
  return s.calls ||= new AgentCalls({ changed: () => scheduleState(), finished: s.recordRun, local: project.kind !== 'ssh',
    dispatchAlive: call => {
      if (project.kind === 'ssh') return null;
      let pid = call.helperPid || helperPids.get(call);
      if (!pid || call.done) {
        try {
          const team = require('./features/team/team.cjs').projectTeam(project.path);
          if (!team || !/^[a-f\d-]{36}$/i.test(call.key)) return null;
          const file = path.join(team.board, call.key + '.json');
          if (fs.statSync(file).size > 65536) return null;
          const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (entry.id !== call.key || path.resolve(entry.cwd) !== path.resolve(call.cwd) || !Number.isSafeInteger(entry.pid) || entry.pid <= 0) return null;
          pid = entry.pid; helperPids.set(call, pid);
        } catch (error) { return call.done && error.code === 'ENOENT' ? false : null; }
      }
      return AgentCalls.alive(pid);
    },
    codexHome: () => s.codexHome || s.usageEnv?.CODEX_HOME || path.join(os.homedir(), '.codex'),
    claudeHome: () => s.usageEnv?.CLAUDE_CONFIG_DIR || claudeConfigDir(),
    feedChanged: event => { if (sessions.get(s.terminalId)?.calls === s.calls) send('terminal:subagent-feed', { terminalId: s.terminalId, ...event }); } });
}
// An owner intervention's target, from the call the terminal's own tracker holds: never from the renderer. The planner
// binding is the terminal session together with its CLI conversation, so a replaced conversation is never written to.
function resolveIntervention(terminalId, callId) {
  const s = sessions.get(terminalId), project = store.findTerminal(terminalId)?.project, call = s?.calls?.byId(callId);
  if (!s?.sessionId || !project || !call) return null;
  return { terminalId, callId, parentSessionId: `${s.plannerSessionId || s.sessionId}:${s.claudeSessionId || s.rootThreadId || s.reportedThreadId || ''}`,
    confirmed: !call.unconfirmed, done: !!call.done, title: call.title, route: call.dispatch ? 'dispatch' : 'parent', projectPath: project.path,
    ...(call.dispatch ? { local: project.kind !== 'ssh', runId: callId.slice('dispatch:'.length), cwd: call.cwd } : {}) };
}
const interventions = createInterventions({ resolve: resolveIntervention,
  noteInput: (target, messageId, message) => sessions.get(target.terminalId)?.calls?.ownerInput(target.callId, messageId, message),
  pushControl: (runId, control) => dispatchControl?.pushControl(runId, control),
  sendDirect: async () => { throw new Error('该子代理没有直达控制通道。'); } });
// The dashboard's 正在运行 strip: every terminal's running sub-agents and dispatched workers, with their project.
function syncDashboardLive() {
  dashboardWindow?.live([...sessions.values()].flatMap(s => (s.calls?.running() ?? []).map(call => ({ ...call, project: s.projectId ?? null }))));
}
function dispatchedOnly(s) {
  const calls = s?.calls?.snapshot(null) || [];
  return calls.length ? { provider: null, context: null, round: null, total: null, limits: [], calls } : null;
}

function startUsage(project, s, event) {
  stopUsageAccount(s);
  s.usageCwd = event.cwd || project.path;
  const usage = s.usage = new UsageMeter(s.agent, { rates: project.kind !== 'ssh', calls: callsOf(s, project), codexHome: event.codexHome || s.codexHome,
    changed: () => { if (s.usage === usage && !s.usageHistory) scheduleState(); } });
  if (s.agent === 'codex') {
    s.terminalAccount = null;
    let binding;
    s.bindUsageAccount = () => {
      const options = { codexHome: event.codexHome || s.codexHome, cwd: event.cwd || project.path,
        recordedCwd: usage.scopeCwd, env: s.usageEnv || process.env, provider: usage.providerId,
        remote: project.kind === 'ssh', accountLaunch: event.accountLaunch, projectId: project.id, scopeReported: usage.scopeReported };
      const scope = codexAccounts.scopeFor(options), next = scope.key || scope.reason;
      if (s.usage !== usage || (s.usageAccount && binding === next)) return;
      s.usageAccount?.dispose(); binding = next;
      s.usageAccount = codexAccounts.watch(options, account => {
        if (s.usage === usage && s.codexActive && sessions.get(s.terminalId) === s) {
          s.terminalAccount = account;
          usage.codexAccount(account); s.recordQuota?.('codex', usage.limits); scheduleState(); scheduleUsageRollover();
          if (account.atLimit && !s.nativeStructured) void resetTerminalCodex(project, s, options);
        }
      });
    };
    s.bindUsageAccount();
  }
  if (project.kind === 'ssh') {
    if (s.agent === 'claude') bindRemoteClaudeAccount(s);
    return;
  }
  const named = update => { if (s.usage === usage) { update(); scheduleState(); } };
  if (s.agent === 'claude') {
    void claudeProvider(event.cwd || project.path, claudeConfigDir()).then(provider => named(() => { usage.provider = provider; })).catch(() => {});
    void refreshClaudeAccounts();
  } else void codexProvider(event.codexHome || s.codexHome).then(names => named(() => { usage.names = names; })).catch(() => {});
}
async function resetTerminalCodex(project, s, options) {
  const usage = s.usage;
  const current = () => sessions.get(s.terminalId) === s && s.agent === 'codex' && s.usage === usage && s.codexActive && nativeSessions?.getSettings().codexAutoReset === true;
  if (project.kind === 'ssh' || !current()) return;
  try {
    const result = await codexAccounts.resetAtLimit({ ...options, owner: 'gui' }, { enabled: true, atLimit: true, current });
    if (!current()) return;
    const text = resetCreditMessage(result, t); if (!text) return;
    s.conversation.put({ id: randomUUID(), at: Date.now(), role: 'assistant', text: text + (result.auditFailed ? t('自动重置的日志未能保存。') : '') + (result.confirmed ? t('现在可以继续发送消息。') : '') });
    scheduleState();
  } catch (error) { report(error); }
}
function bindRemoteClaudeAccount(s) {
  const usage = s.usage;
  s.usageAccount?.dispose();
  s.usageAccount = watchRemoteClaudeAccount(s.terminal, account => {
    // The observation uses the worker's clock; API reset timestamps already use the server's absolute time.
    const observed = { ...account, at: account.at + (Number.isFinite(s.activityClockOffset) ? s.activityClockOffset : 0) };
    usage.provider = 'Anthropic';
    if (usage.account(observed, observed)) {
      s.recordQuota?.('claude', usage.limits); scheduleState(); scheduleUsageRollover();
    }
  }, { current: () => s.usage === usage && s.codexActive && s.agent === 'claude' && sessions.get(s.terminalId) === s });
}
function stopUsageAccount(s) {
  s.bindUsageAccount = null; s.usageAccount?.dispose(); s.usageAccount = null;
  s.usageHistory = null;
  if (s.usage) {
    if (!localClaudeMeters(s).length) disposeClaudeAccounts();
    scheduleUsageRollover(s);
  }
}
// These files are shared by local Claude terminals. Watch their folders so atomic replacement keeps working.
let claudeAccountTimer = null;
let claudeAccountSoon = null, claudeAccountPending = null, claudeAccountQueued = false, claudeAccountGeneration = 0;
const claudeAccountWatchers = new Map();
function localClaudeMeters(skip) {
  return [...sessions.values()].filter(s => s !== skip && s.codexActive && s.agent === 'claude' && s.usage?.agent === 'claude' &&
    store.projects.some(p => p.id === s.projectId && p.kind !== 'ssh'));
}
function disposeClaudeAccounts() {
  ++claudeAccountGeneration;
  claudeAccounts.setActive(false);
  clearInterval(claudeAccountTimer); if (claudeAccountSoon) clearTimeout(claudeAccountSoon);
  claudeAccountTimer = null; claudeAccountSoon = null; claudeAccountPending = null; claudeAccountQueued = false;
  for (const { watcher } of claudeAccountWatchers.values()) watcher.close();
  claudeAccountWatchers.clear();
}
function queueClaudeAccounts() {
  if (claudeAccountSoon) return;
  claudeAccountSoon = setTimeout(() => { claudeAccountSoon = null; void refreshClaudeAccounts(); }, 25);
  claudeAccountSoon.unref?.();
}
function watchClaudeAccounts() {
  const folders = new Map();
  for (const file of claudeAccountFiles()) {
    try {
      let folder = path.dirname(file);
      // CodePulse's folder may not exist yet. Its nearest existing parent tells us when it is created.
      while (!fs.existsSync(folder) && path.dirname(folder) !== folder) folder = path.dirname(folder);
      if (!folders.has(folder)) folders.set(folder, new Set());
      folders.get(folder).add(path.relative(folder, file).split(path.sep)[0]);
    } catch { }
  }
  for (const [folder, entry] of claudeAccountWatchers) {
    if (folders.has(folder)) entry.names = folders.get(folder);
    else { entry.watcher.close(); claudeAccountWatchers.delete(folder); }
  }
  for (const [folder, names] of folders) {
    if (claudeAccountWatchers.has(folder)) continue;
    try {
      const entry = { names };
      // Normalize only the OS watch path; ownership and event filters still use the caller's folder.
      let watchDirectory = folder;
      try { watchDirectory = fs.realpathSync.native(watchDirectory); } catch { }
      entry.watcher = fs.watch(watchDirectory, { persistent: false }, (_event, name) => {
        if (claudeAccountWatchers.get(folder) === entry && (!name || entry.names.has(String(name)))) queueClaudeAccounts();
      });
      entry.watcher.unref?.();
      entry.watcher.on('error', () => { entry.watcher.close(); if (claudeAccountWatchers.get(folder) === entry) claudeAccountWatchers.delete(folder); });
      claudeAccountWatchers.set(folder, entry);
    } catch { }
  }
}
async function refreshClaudeAccounts() {
  if (quitting || !localClaudeMeters().length) { disposeClaudeAccounts(); return; }
  claudeAccounts.setActive(true); claudeAccounts.refresh();
  if (claudeAccountSoon) clearTimeout(claudeAccountSoon);
  claudeAccountSoon = null;
  watchClaudeAccounts();
  // Folder watchers deliver live updates; this slower local-file fallback repairs missed events and watcher errors.
  claudeAccountTimer ??= setInterval(() => void refreshClaudeAccounts(), 30000);
  claudeAccountTimer.unref?.();
  if (claudeAccountPending) { claudeAccountQueued = true; return claudeAccountPending; }
  const generation = claudeAccountGeneration;
  const pending = claudeAccountPending = Promise.resolve().then(() => claudeAccount(undefined, undefined, claudeAccounts.account)).then(account => {
    if (generation !== claudeAccountGeneration) return;
    let changed = false;
    for (const s of localClaudeMeters()) if (s.usage.account(account, claudeAccounts.account)) {
      s.recordQuota?.('claude', s.usage.limits); changed = true;
    }
    if (changed) { scheduleState(); scheduleUsageRollover(); }
  }).finally(() => {
    if (claudeAccountPending !== pending) return;
    claudeAccountPending = null;
    if (claudeAccountQueued) { claudeAccountQueued = false; queueClaudeAccounts(); }
  });
  return pending;
}

let usageRolloverTimer = null, usageRolloverAt = null;
function scheduleUsageRollover(skip) {
  const now = Date.now();
  let next = Infinity;
  if (!quitting) for (const s of sessions.values()) {
    if (s === skip || !s.codexActive || store.projects.find(p => p.id === s.projectId)?.kind === 'ssh') continue;
    for (const limit of s.usage?.limits || []) {
      if (Number.isFinite(limit.resetsAt) && limit.resetsAt > now) next = Math.min(next, limit.resetsAt);
    }
  }
  if (next === usageRolloverAt) return;
  if (usageRolloverTimer) clearTimeout(usageRolloverTimer);
  usageRolloverTimer = null; usageRolloverAt = next;
  if (!Number.isFinite(next)) return;
  usageRolloverTimer = setTimeout(() => {
    usageRolloverTimer = null; usageRolloverAt = null;
    if (Date.now() >= next) {
      for (const s of sessions.values()) if (s.codexActive && s.usage?.agent === 'codex') s.usageAccount?.refresh();
      void refreshClaudeAccounts();
    }
    scheduleUsageRollover();
  }, Math.min(next - now, 2147483647));
  usageRolloverTimer.unref?.();
}

// Restores know the id before Claude emits its next prompt hook.
async function followClaudeSession(project, s, id) {
  if (project.kind === 'ssh') return false;
  const request = s.claudeFollowRequest = (s.claudeFollowRequest || 0) + 1;
  const cwd = store.findTerminal(s.terminalId)?.record.restore?.cwd || project.path;
  const file = await findClaudeSession(cwd, id);
  if (!file || sessions.get(s.terminalId) !== s || (!s.codexActive && s.claudeResumeId !== id) || (s.codexActive && s.agent !== 'claude')) return false;
  if (s.claudeFollowRequest !== request) return s.claudeSessionId === id && s.claudeTranscript?.filename === file;
  followClaude(project, s, { sessionId: id, transcriptPath: file });
  store.setRestore(s.terminalId, { threadId: id });
  await s.activityMonitor?.poll();
  return true;
}


// CLI interaction is independent of project completion: progress never arms another completion notification.
function publishCliState(s, state, { at = Date.now(), threadId, turnId, requestId, eventId, message: detail, bind = false, progress = false, expectedRevision, newTurn = false } = {}) {
  if (!s.sessionId || s.nativeStructured || !s.codexActive || sessions.get(s.terminalId) !== s || !Number.isFinite(at)) return false;
  if (!s.cliStateMeta || s.cliState?.sessionId !== s.sessionId) s.cliStateMeta = { at: 0, events: new Set(), closed: new Set(), turnId: null, requestId: null };
  const meta = s.cliStateMeta, before = s.cliState;
  if (expectedRevision != null && expectedRevision !== before?.revision) return false;
  const bound = s.cliProviderId || (s.agent === 'claude' ? s.claudeSessionId || s.claudeResumeId : s.reportedThreadId || s.rootThreadId);
  if (!bind && threadId && bound && threadId !== bound && !(s.agent === 'codex' && bound.length >= 8 && threadId.toLowerCase().startsWith(bound.toLowerCase()))) return false;
  if (at < Math.max(s.activitySince || 0, s.activityInputAt || 0, meta.at)) return false;
  if (eventId && meta.events.has(eventId)) return false;
  if (!bind && turnId && (meta.closed.has(turnId) || state !== 'working' && meta.turnId && turnId !== meta.turnId)) return false;
  // PermissionRequest/Elicitation have no tool_use_id in Claude 2.1.317. A sibling's
  // asynchronous progress cannot prove that such a dialog has been answered. A tool
  // observation only releases a matching wait; it cannot advance a working turn's watermark.
  if (progress && (before?.state !== 'waiting' || !meta.requestId || requestId !== meta.requestId)) return false;
  if (bind && threadId !== bound) { meta.closed.clear(); meta.turnId = null; }
  if (newTurn) { if (meta.turnId) meta.closed.add(meta.turnId); meta.turnId = null; }
  if (threadId) s.cliProviderId = threadId;
  if (turnId && turnId !== meta.turnId) { if (meta.turnId) meta.closed.add(meta.turnId); meta.turnId = turnId; }
  if (eventId) { meta.events.add(eventId); if (meta.events.size > 256) meta.events.delete(meta.events.values().next().value); }
  meta.at = at;
  if (state === 'idle' && turnId) meta.closed.add(turnId);
  const message = state === 'waiting' ? String(detail ?? '').slice(0, 300) : undefined;
  meta.requestId = state === 'waiting' ? requestId || null : null;
  s.needsInput = state === 'waiting' ? { message, since: Date.now() } : null;
  s.cliStateRevision = (s.cliStateRevision || 0) + 1;
  s.cliState = { sessionId: s.sessionId, revision: s.cliStateRevision,
    updatedAt: Date.now(), state, ...(message ? { message } : {}) };
  s.observeNativeSwitch?.();
  broadcast();
  return true;
}

// One place turns an agent's turn state into lights and completion alerts, for Codex and Claude alike.
function applyActivity(project, s, snapshot) {
  if (sessions.get(s.terminalId) !== s || !s.codexActive) return;
  if (snapshot.updatedAt < (s.activitySince || 0)) return;
  const bound = s.cliProviderId || (s.agent === 'claude' ? s.claudeSessionId : s.reportedThreadId);
  if (bound && snapshot.threadId && bound !== snapshot.threadId && !(s.agent === 'codex' && bound.length >= 8 && snapshot.threadId.toLowerCase().startsWith(bound.toLowerCase()))) return;
  if (s.agent === 'codex' && snapshot.turnId && s.cliStateMeta?.closed.has(snapshot.turnId)
    && (snapshot.state === 'working' || snapshot.turnId !== s.cliStateMeta.turnId)) return;
  // Readers deduplicate snapshots. Retain even a completion hidden by provisional
  // input so that expiring that submission can replay it without another record.
  if (snapshot.updatedAt >= (s.activityRawSnapshot?.updatedAt || 0)) s.activityRawSnapshot = snapshot;
  // Neither a polled result from before new input nor a result from before newer attention can end this interaction.
  if (snapshot.updatedAt < Math.max(s.activityInputAt || 0, s.cliStateMeta?.at || 0)) return;
  if (snapshot.ended || ['working', 'complete', 'interrupted'].includes(snapshot.state)) publishCliState(s, snapshot.state === 'working' ? 'working' : 'idle',
    { at: snapshot.updatedAt, threadId: snapshot.threadId, turnId: s.agent === 'codex' ? snapshot.turnId : undefined,
      eventId: `record:${snapshot.threadId}:${snapshot.turnId}:${snapshot.state}:${snapshot.updatedAt}` });
  if (s.completionWork?.reading) { s.codexActivity = 'working'; scheduleState(); return; }
  if (snapshot.ended || ['complete', 'interrupted'].includes(snapshot.state)) {
    s.completionWork?.end(snapshot.updatedAt);
    s.promptQueue.finish?.(snapshot.updatedAt);
  }
  s.activitySnapshot = snapshot;
  const queued = s.promptQueue.list?.().some(item => item.state === 'queued') || !!s.conversation?.queue?.length;
  const state = s.completionWork?.state(snapshot, { queued })
    || (queued && snapshot.state === 'complete' ? 'working' : snapshot.state);
  if (snapshot.ended && snapshot.state === 'unknown' || snapshot.state === 'interrupted' || state === 'interrupted') store.expectCompletion(project.id, false);
  snapshot = { ...snapshot, state };
  s.rootThreadId = snapshot.threadId;
  s.approval?.context('activity', [snapshot.threadId, snapshot.turnId, snapshot.state]);
  // Keep the last prompt that named work; bare continuations and background callbacks cannot replace it.
  const task = summarizeTask(snapshot.prompt, { spoken: true });
  if (task) { s.lastTask = task; s.lastTaskSummary = summarizeTask(snapshot.prompt); s.lastTaskTitle = snapshot.prompt; }
  if (s.agent === 'codex') store.setRestore(s.terminalId, { threadId: snapshot.threadId });
  s.codexActivity = snapshot.state;
  if (s.agent === 'claude') {
    s.claudeActivitySnapshot = snapshot;
    if (snapshot.state === 'complete' && project.kind !== 'ssh') void refreshClaudeAccounts();
    if (['complete', 'interrupted'].includes(snapshot.state)) {
      // The last poll may still add tool calls. Settle both views afterward, unless another round has started.
      const settle = () => {
        if (sessions.get(s.terminalId) === s && s.codexActive && s.agent === 'claude' && s.claudeActivitySnapshot === snapshot && s.codexActivity !== 'working' && !(s.activityInputAt > snapshot.updatedAt)) {
          s.actions.settle(); s.conversation.settle();
        }
      };
      if (snapshot.transcriptRead || !s.activityMonitor) settle();
      else void Promise.resolve(s.activityMonitor.poll()).then(settle);
    }
  }
  if (snapshot.state === 'complete' && snapshot.turnId) {
    s.lastCompletedAt = snapshot.updatedAt;
    const allComplete = [...sessions.values()].filter(item => item.projectId === project.id || item.terminalId === project.id)
      .every(item => !item.codexActive || item.codexActivity === 'complete');
    if (allComplete && store.complete(project.id, `${snapshot.threadId}:${snapshot.turnId}`, snapshot.updatedAt)) notifyCompletion(project);
  }
  // The round that ended joins the folder's permanent memory (project-memory.cjs), here or over SSH alike. Claude's
  // transcript is read a moment later, when its last reply has arrived.
  if (['complete', 'interrupted'].includes(snapshot.state) && snapshot.threadId) {
    const agent = s.agent === 'claude' ? 'claude' : 'codex', folder = memoryFolder(project, s);
    setTimeout(() => { void remember(memoryDir(), folder, roundsOf(s.conversation.list, agent, snapshot.threadId)).catch(() => {}); }, 1500).unref?.();
    if (project.kind !== 'ssh') void scrubProjectSkills(project).catch(() => {});
  }
  broadcast();
}

// Claude Code hooks: UserPromptSubmit -> working, Stop -> complete (integration/claude-hook.ps1). SessionStart -> the
// conversation Claude writes from now on: after /clear or /resume the reading view follows the new file at once.
// Notification -> attention while Claude waits for a permission answer in its own screen; that only
// sets the waiting indicator and never changes the round's lifecycle.
function claudeActivity(project, s, event) {
  if (!s.codexActive || s.agent !== 'claude' || !['working', 'complete', 'attention', 'session', 'progress'].includes(event.state)) return;
  if (typeof event.sessionId !== 'string' || !/^[\w-]{1,100}$/.test(event.sessionId) || typeof event.eventId !== 'string' || event.eventId.length > 200) return;
  const at = Number.isFinite(event.sentAt) ? event.sentAt + (project.kind === 'ssh' ? s.activityClockOffset || 0 : 0) : Date.now();
  const bound = s.cliProviderId || s.claudeSessionId || s.claudeResumeId;
  if (at < Math.max(s.activitySince || 0, s.cliStateMeta?.at || 0) || s.cliStateMeta?.events.has(event.eventId) || event.state !== 'session' && bound && bound !== event.sessionId) return;
  const evidence = { at, threadId: event.sessionId, turnId: event.turnId, requestId: event.requestId, eventId: event.eventId };
  // Hook eventId is an event identity, not a native approval request ID. A different observed event invalidates
  // actions conservatively, even if its message is identical. Duplicate events leave the epoch alone.
  s.approval?.context('claude-event', [event.sessionId, event.eventId, event.state]);
  if (event.state === 'attention') { publishCliState(s, 'waiting', { ...evidence, message: event.message }); return; }
  if (event.state === 'progress') { publishCliState(s, 'working', { ...evidence, progress: true }); return; }
  if (event.state === 'session') {
    if (publishCliState(s, event.sessionSource === 'compact' && s.cliState?.state === 'working' ? 'working' : 'idle', { ...evidence, bind: true })) {
      s.claudeSessionSource = event.sessionSource; followClaude(project, s, event);
    }
    return;
  }
  if (s.usage && project.kind !== 'ssh') void refreshClaudeAccounts();
  // Claude Code runs its prompt hooks for some local slash commands (/context, /doctor, /compact) too. They open a screen
  // or print a line and no round follows, so they neither start a round nor end one; the card would stay "working".
  if (event.state === 'working') {
    if (typeof event.prompt === 'string' && promptText(event.prompt, event) === null) return;
    const local = typeof event.prompt === 'string' && isLocalAgentCommand('claude', event.prompt);
    if (local) { if (publishCliState(s, 'working', evidence)) s.claudeLocalCommand = true; return; }
    if (!publishCliState(s, 'working', evidence)) return;
    s.claudeLocalCommand = false;
    // UserPromptSubmit is actual input, unlike a polled working snapshot or a Stop callback.
    if (s.claudePromptEventId !== event.eventId) {
      s.claudePromptEventId = event.eventId;
      if (promptText(event.prompt, event) !== null) {
        s.activityConfirmedInputAt = Math.max(s.activityConfirmedInputAt || 0, at);
        s.activityInputAt = Math.max(s.activityInputAt || 0, s.activityConfirmedInputAt);
        s.completionWork?.begin(); store.expectCompletion(project.id);
      }
    }
  } else if (event.state === 'complete' && s.claudeLocalCommand) { if (publishCliState(s, 'idle', evidence)) s.claudeLocalCommand = false; return; }
  if (event.state === 'complete' && !publishCliState(s, 'idle', evidence)) return;
  const revision = s.cliState.revision;
  const turnId = event.eventId.slice(event.sessionId.length + 1);
  // Remember the conversation and whether its turn is still open, so a restart can resume it and continue.
  store.setRestore(s.terminalId, { threadId: event.sessionId, interrupted: event.state === 'working' });
  followClaude(project, s, event);
  const snapshot = { threadId: event.sessionId, turnId: event.state === 'complete' ? turnId : null, state: event.state, updatedAt: at, prompt: typeof event.prompt === 'string' ? event.prompt.slice(0, 2000) : undefined };
  // Stop can beat the last tool-result write. Read it before granting a completion,
  // and let a newer turn/input win if it started while the read was in flight.
  if (event.state === 'complete' && s.activityMonitor) {
    const promptEvent = s.claudePromptEventId;
    void Promise.resolve(s.activityMonitor.poll()).then(() => {
      if (s.agent !== 'claude' || s.cliState?.revision !== revision || s.claudeSessionId && s.claudeSessionId !== event.sessionId || s.claudePromptEventId !== promptEvent || s.activityRawSnapshot?.updatedAt > snapshot.updatedAt) return;
      applyActivity(project, s, { ...snapshot, state: s.completionWork?.turn?.state === 'interrupted' ? 'interrupted' : snapshot.state, transcriptRead: true });
    }).catch(() => {});
  } else applyActivity(project, s, snapshot);
}

async function openCodexFromShell(project, s, event) {
  try {
    const launch = require('./features/agents/agent-command.cjs').codexLaunch(event.args === undefined && !event.command ? [] : event.args);
    const paths = project.kind === 'ssh' ? path.posix : path;
    if (typeof event.cwd !== 'string' || !paths.isAbsolute(event.cwd) || event.cwd.length > 4096 || event.cwd.includes('\0')) throw new Error('Codex 启动目录无效，请重启终端后重试。');
    launch.cwd = launch.cwd ? paths.resolve(event.cwd, launch.cwd) : event.cwd;
    if (launch.cwd.length > 4096) throw new Error('Codex 启动目录无效，请重启终端后重试。');
    if (typeof event.codexHome === 'string' && paths.isAbsolute(event.codexHome) && event.codexHome.length <= 4096 && !event.codexHome.includes('\0')) launch.codexHome = event.codexHome;
    if (!nativeSessions) throw new Error('Codex 原生模式连接失败，请重试。');
    launchPlans.delete(s.terminalId); restorePlans.delete(s.terminalId);
    const opened = await nativeSessions.start(s.terminalId, { agent: 'codex', resume: launch.resume, launch });
    if (launch.prompt) await nativeSessions.send(s.terminalId, opened.runtimeSessionId, { clientMessageId: randomUUID(), text: launch.prompt });
    broadcast();
  } catch (error) {
    if (sessions.get(s.terminalId) === s && !s.nativeStructured) {
      const data = `\r\n${error.message}\r\n`;
      s.chunks.push(data); s.bytes += data.length; s.pending += data; s.flush();
    } else if (store.findTerminal(s.terminalId)) startupErrors.set(s.terminalId, error.message);
    broadcast();
  }
}

function onEvent(event) {
  const s = sessions.get(event.projectId);
  if (!s || event.sessionKey !== s.sessionKey) return;
  const project = store.projects.find(p => p.id === s.projectId);
  if (!project) return;
  if (['dispatch-start', 'dispatch-rate', 'dispatch-end', 'dispatch-receipt'].includes(event.type)) {
    if (require('./features/agents/dispatch-events.cjs').acceptDispatch(s, event, callsOf(s, project))) {
      if (event.type === 'dispatch-start' && event.agent === 'claude' && event.unconfirmed !== true) rememberClaudeSource(event.sessionId, 'dispatch');
      broadcast();
    }
    return;
  }
  if (event.type === 'agent-activity') { claudeActivity(project, s, event); return; }
  if (event.type !== 'turn-complete' && !acceptShellEvent(s, event)) return;
  if (event.type === 'codex-started' && event.agent !== 'claude') { void openCodexFromShell(project, s, event); return; }
  if (event.type === 'codex-exited' && event.agent !== 'claude') return;
  s.approval?.context('shell-event', [event.type, event.sequence]);
  if (event.type === 'shell-ready' || event.type === 'shell-prompt') {
    s.cliState = s.cliStateMeta = s.cliProviderId = null;
    endSkillSession(s);
    s.needsInput = null; s.agentCommand = null; stopUsageAccount(s);
    s.claudeResumeId = null; s.claudeFollowRequest = (s.claudeFollowRequest || 0) + 1;
    s.activityMonitor?.stop(); s.activityMonitor = null;
    s.codexActive = false; s.codexActivity = 'unknown'; s.reportedThreadId = null; s.promptQueue.reset(); s.activitySnapshot = s.activityRawSnapshot = null;
    if (s.completionWork?.reset()) store.expectCompletion(project.id, false);
    s.ready = event.type === 'shell-prompt';
    s.inputDirty = false;
    s.status = 'shell';
    // A prompt after the launch command was typed means the agent ended before it started: show the terminal.
    if (!launchPlans.has(s.terminalId)) s.agentStarting = false;
    s.codexAvailable = event.codexAvailable === true;
    s.claudeAvailable = event.claudeAvailable === true;
    if (typeof event.codexHome === 'string') s.codexHome = event.codexHome;
    if (!quitting && typeof event.cwd === 'string') store.setRestore(s.terminalId, { cwd: event.cwd });
  } else if (event.type === 'codex-started') {
    s.cliState = s.cliStateMeta = s.cliProviderId = null;
    s.needsInput = null;
    s.agentStarting = false;
    const restored = store.findTerminal(s.terminalId)?.record.restore;
    const startingAgent = event.agent === 'claude' ? 'claude' : 'codex';
    // A new CLI run must learn its own root before a received prompt can bind CLI state.
    if (startingAgent === 'codex') s.rootThreadId = null;
    s.agentCwd = event.cwd || restored?.cwd || project.path;
    if (typeof event.codexHome === 'string') s.codexHome = event.codexHome;
    if (restored?.codex !== true || (restored.agent || 'codex') !== startingAgent) readingHistory.close(s.terminalId);
    else void prepareReading(s.terminalId, { ...restored, agent: startingAgent, cwd: event.cwd || restored.cwd });
    // A run of the CLI that is no conversation (codex update, claude --version: agent-command.cjs): the reading view
    // says what it does and shows its output; nothing is handed over, followed or restored for it.
    s.agentCommand = agentCommand(event.agent, event.command);
    if (s.agentCommand) {
      readingHistory.close(s.terminalId);
      stopUsageAccount(s);
      s.ready = false; s.codexActive = true; s.status = 'codex'; s.error = null; s.codexActivity = 'unknown'; s.agentSettings = null; s.usage = null;
      s.agent = event.agent === 'claude' ? 'claude' : 'codex';
      startSkillSession(project, s, event.sequence, false);
      s.activityMonitor?.stop(); s.activityMonitor = null; s.actions.reset(); s.conversation.reset(); s.promptQueue.reset();
      broadcast(); return;
    }
    // The work done in this folder before, brought up to date for the CLI that starts now (handoff.cjs).
    if (project.kind !== 'ssh') {
      void writeHandoff(handoffFile(s.terminalId), event.cwd || project.path, { memoryDir: memoryDir(), codexHome: event.codexHome || s.codexHome || undefined }).catch(() => {});
      void scrubProjectSkills(project).catch(() => {});
    } else void sshHandoff(project, s).catch(() => {});
    const claudeResumeId = event.agent === 'claude' ? s.claudeResumeId : null;
    const keepClaudeHistory = claudeResumeId && s.claudeSessionId === claudeResumeId && s.claudeTranscript;
    if (!keepClaudeHistory) s.claudeSessionId = null;
    s.ready = false;
    s.codexActive = true;
    // A resumed Claude conversation whose transcript is still followed keeps what its records showed.
    if (!keepClaudeHistory) s.agentSettings = null;
    s.status = 'codex';
    s.error = null;
    s.submissions.reset();
    s.codexActivity = 'unknown'; s.activitySince = Date.now(); s.activityInputAt = s.activityConfirmedInputAt = 0;
    s.activitySnapshot = s.activityRawSnapshot = null;
    // The kept tail has already replayed its prefix, including outstanding workers.
    if (!keepClaudeHistory) s.completionWork?.reset();
    s.activityPromptAt = 0; s.claudePromptEventId = null;
    s.activityClockOffset = Number.isFinite(event.sentAt) ? s.activitySince - event.sentAt : 0;
    if (!keepClaudeHistory) { s.actions.reset(); s.conversation.reset(); s.claudeTranscript = null; s.claudeSessionId = null; }
    s.promptQueue.reset();
    s.agent = event.agent === 'claude' ? 'claude' : 'codex';
    startSkillSession(project, s, event.sequence);
    if (!keepClaudeHistory) { s.activityMonitor?.stop(); s.activityMonitor = null; }
    if (!keepClaudeHistory || !s.usage) startUsage(project, s, event);
    else if (project.kind === 'ssh') bindRemoteClaudeAccount(s);
    // A terminal restores the agent it last ran. Switching agents drops the other one's conversation id.
    const previousAgent = store.findTerminal(s.terminalId)?.record.restore?.agent || 'codex';
    const agentRestore = { agent: s.agent, ...(previousAgent !== s.agent ? { threadId: null, interrupted: false } : {}) };
    if (s.agent === 'claude') {
      // Claude reports turns and its session id through hooks (claudeActivity).
      store.setRestore(s.terminalId, { terminal: true, codex: true, cwd: event.cwd, ...agentRestore });
      s.claudeResumeId = null;
      if (claudeResumeId) void followClaudeSession(project, s, claudeResumeId).catch(error => { s.error = String(error); broadcast(); });
      broadcast(); return;
    }
    store.setRestore(s.terminalId, agentRestore);
    const remoteSince = Number.isFinite(event.sentAt) ? event.sentAt : s.activitySince;
    s.activityMonitor?.stop();
    const readCurrent = () => sessions.get(s.terminalId) === s && s.codexReadEvent === event && s.codexActive && s.agent === 'codex';
    // Its records feed the reading view and the activity pane: read here, or, over SSH, read on that computer and
    // sent back compacted with each status (integration/remote-worker.py), with the same history start and end.
    const onHistory = ready => {
      if (ready) s.conversation.endHistory();
      else {
        s.activitySnapshot = s.activityRawSnapshot = null;
        s.conversation.beginHistory(); s.actions.reset(); s.conversation.reset(); s.usage?.reset(true);
        if (s.completionWork?.reset()) store.expectCompletion(project.id, false);
        s.usage?.resetScope(); s.bindUsageAccount?.();
      }
      if (s.completionWork) s.completionWork.reading = !ready;
      usageHistory(s, ready);
    };
    const onRecord = record => {
      if (!readCurrent()) return;
      s.completionWork?.record(record, 'codex', project.kind === 'ssh' ? s.activityClockOffset || 0 : 0);
      if (record.workOnly) return;
      codexConversation(s.conversation, record, event.cwd || project.path); describeActions(s, event.cwd || project.path, codexRecord(s.actions, record, event.cwd || project.path));
      noteSettings(s, 'codex', record);
      if (record?.type === 'event_msg' && ['task_complete', 'turn_completed', 'turn_aborted', 'turn_interrupted'].includes(record.payload?.type)) {
        const at = Date.parse(record.timestamp) + (project.kind === 'ssh' ? s.activityClockOffset || 0 : 0);
        s.promptQueue.finish(Number.isFinite(at) ? at : Date.now());
      }
    };
    s.codexReadEvent = event;
    const remoteStatus = value => {
      if (!value || typeof value !== 'object' || !('snapshot' in value)) return value;
      if (!readCurrent()) return null;
      if (value.reset) onHistory(false);
      for (const record of Array.isArray(value.records) ? value.records : []) { try { onRecord(record); } catch { } }
      if (value.historyDone) onHistory(true);
      if (s.completionWork) s.completionWork.reading = !value.historyDone;
      if (s.completionWork && value.completionUncertain) s.completionWork.uncertain = true;
      return value.snapshot;
    };
    const reader = project.kind === 'ssh' ? null : new CodexActivityReader(event.cwd || project.path, event.codexHome || s.codexHome, s.activitySince, { threadId: () => s.reportedThreadId, requireBinding: () => (project.terminals?.length || 0) > 0,
      onHistory: ready => { if (readCurrent()) onHistory(ready); },
      catchUpHistory: true, isCurrent: readCurrent,
      onReset: partial => { if (readCurrent() && s.usage?.rates) s.usage.rates.partial = partial; }, onRecord, onWorkRecord: record => onRecord({ ...record, workOnly: true }) });
    s.activityMonitor = monitorActivity(
      async () => {
        let snapshot = await (reader ? reader.read() : project.terminals?.length && !s.reportedThreadId ? null : s.terminal.request('codex-status', { since: remoteSince, threadId: s.reportedThreadId }).then(remoteStatus));
        if (!readCurrent()) return null;
        // Fresh SSH snapshots use the remote clock; cached snapshots already use this clock.
        if (snapshot && !reader) snapshot = { ...snapshot, updatedAt: snapshot.updatedAt + s.activitySince - remoteSince };
        if (reader?.filename && snapshot?.threadId) void prepareReading(s.terminalId,
          { agent: 'codex', threadId: snapshot.threadId, cwd: event.cwd || project.path }, reader.filename);
        if (s.completionWork && reader) {
          s.completionWork.reading = reader.historyPending || reader.offset < reader.fileSize || reader.buffer.length > 0;
          s.completionWork.uncertain ||= reader.workHistory?.uncertain;
        }
        const latest = snapshot || s.activityRawSnapshot;
        return latest && { ...latest, workVersion: s.completionWork?.version, reading: !!s.completionWork?.reading };
      },
      snapshot => {
        // Codex can record the received prompt after task_started for the same open turn.
        if (snapshot.state === 'working' && s.activityPromptAt > snapshot.updatedAt) snapshot = { ...snapshot, updatedAt: s.activityPromptAt };
        applyActivity(project, s, snapshot);
      },
      // A rollout here is read as it is written; over SSH the server is asked more often while the agent works.
      { interval: () => readEvery(s), watch: () => reader?.filename || null },
    );
    store.setRestore(s.terminalId, { terminal: true, codex: true, cwd: event.cwd });
    // Unread completion is independent of session activity. It survives new turns.
  } else if (event.type === 'codex-exited') {
    s.cliState = s.cliStateMeta = s.cliProviderId = null;
    readingHistory.close(s.terminalId);
    endSkillSession(s);
    s.needsInput = null; s.agentCommand = null; stopUsageAccount(s);
    s.claudeResumeId = null; s.claudeFollowRequest = (s.claudeFollowRequest || 0) + 1;
    s.activityMonitor?.stop(); s.activityMonitor = null; s.codexActivity = 'unknown';
    if (s.completionWork?.reset()) store.expectCompletion(project.id, false);
    s.activitySnapshot = s.activityRawSnapshot = null;
    s.ready = false;
    s.codexActive = false;
    s.status = 'shell';
    s.reportedThreadId = null;
    if (!quitting) store.setRestore(s.terminalId, { codex: false });
    const code = Number(event.exitCode);
    if (code && code !== 130 && code !== -1073741510) s.error = t('{agent} 已退出（代码 {code}），请查看终端输出。', { agent: s.agent === 'claude' ? 'Claude Code' : 'Codex', code });
  } else if (event.type === 'turn-complete') {
    if (s.agent === 'codex' && event.threadId && event.turnId && s.cliStateMeta?.turnId === event.turnId
      && (s.cliProviderId || s.rootThreadId || s.reportedThreadId) === event.threadId) {
      // Notify is an immediate UI hint, not a newer rollout record. Preserve the
      // record watermark so this turn's earlier task_complete can still end its work.
      publishCliState(s, 'idle', { at: s.cliStateMeta.at, threadId: event.threadId, turnId: event.turnId, eventId: `notify:${event.eventId}` });
    }
    // notify is inherited by child agents. It only requests a refresh; the
    // interactive parent's task lifecycle is the authority for completion.
    if (s.codexActive && (!s.rootThreadId || event.threadId === s.rootThreadId)) { s.usageAccount?.refresh(); void s.activityMonitor?.poll(); }
    return;
  } else return;
  broadcast();
  if (event.type === 'shell-prompt') { void resumeAfterPrompt(project, s); launchAfterPrompt(project, s); }
}

// The agent chosen on a new project's card, typed at its terminal's first prompt (see agent:launch).
const launchPlans = new Map();
function launchAfterPrompt(project, session) {
  const plan = launchPlans.get(session.terminalId);
  if (!plan || !session.ready || session.inputDirty || session.codexActive) return;
  launchPlans.delete(session.terminalId);
  if (!session.claudeAvailable) {
    session.error = t('没有找到 {agent}，请在设置 › 编码助手中安装。', { agent: 'Claude Code' }); broadcast(); return;
  }
  session.ready = false;
  if (plan.threadId) { session.claudeResumeId = plan.threadId; void followClaudeSession(project, session, plan.threadId); }
  session.gate.afterPrompt(plan.command);
  broadcast();
}

async function resumeAfterPrompt(project, session) {
  const plan = restorePlans.get(session.terminalId);
  if (!plan || !session.ready) return;
  restorePlans.delete(session.terminalId);
  session.agentStarting = true;
  try {
    if (session.inputDirty) return;
    const restore = store.findTerminal(session.terminalId)?.record.restore;
    // Claude Code resumes its own conversation, here or on the terminal's SSH channel.
    if (restore?.agent === 'claude') {
      if (!session.claudeAvailable || !plan.codex) return;
      const command = claudeResumeCommand(restore);
      if (sessions.get(session.terminalId) !== session || !session.ready || session.inputDirty || session.codexActive) return;
      store.expectCompletion(project.id, restore.interrupted === true);
      session.ready = false;
      session.claudeResumeId = restore.threadId || null;
      if (project.kind === 'ssh') session.gate.input(command); else session.gate.afterPrompt(command);
      // Remote SessionStart hooks bind the server transcript; never search this computer for that path.
      if (restore.threadId && project.kind !== 'ssh') await followClaudeSession(project, session, restore.threadId);
      broadcast();
      return;
    }
    // Codex restoration belongs to restoreTerminal, before a shell is created.

  } catch (error) { session.error = `恢复会话失败：${error.message}`; broadcast(); }
  finally {
    if (sessions.get(session.terminalId) === session && session.ready) { session.agentStarting = false; readingHistory.close(session.terminalId); broadcast(); }
  }
}

function remoteFor(id) {
  const project = findProject(id);
  const channel = session => session.remoteConnection || session.terminal;
  const session = channel(sessions.get(id) || {})?.connected ? sessions.get(id) : [...sessions.values()].find(item => item.projectId === project.id && channel(item)?.connected);
  if (project.kind !== 'ssh' || !session || channel(session).closed) throw new Error('请先启动终端，连接 SSH 服务器。');
  return channel(session);
}

// New local terminals use the chosen shell: Bash by default on macOS, the login shell's kind on Linux,
// PowerShell or Command Prompt on Windows.
// Recheck macOS and Linux shells when a terminal starts, so one installed meanwhile is used.
let localShells = null;
function localShell(fresh = false) {
  if (!['darwin', 'linux'].includes(process.platform)) return { kind: store.settings.shell === 'cmd' ? 'cmd' : 'powershell', file: null };
  if (fresh || localShells?.choice !== store.settings.shell) {
    const choose = process.platform === 'darwin' ? macShell : linuxShell;
    localShells = { ...choose(store.settings.shell), choice: store.settings.shell };
  }
  return localShells;
}

function nativeSpec(id, agent, resume, validateOnly = false, launch = null) {
  const project = findProject(id), old = sessions.get(id);
  if (project.kind === 'ssh' && agent !== 'codex') throw new Error('SSH 原生会话目前仅支持 Codex。');
  if (validateOnly) return;
  if (old?.nativeStructured && old.status !== 'exited') return old.nativeSpec;
  if (old?.codexActive && old.status !== 'exited') throw new Error('请先停止当前会话。');
  if (old) disposeTerminal(id, { preserveNative: !!old.nativeStructured });
  const saved = store.findTerminal(id).record.restore;
  const cwd = launch?.cwd || (resume ? saved?.cwd || project.path : project.path);
  const providerSessionId = launch?.latest ? null : launch?.providerSessionId || (resume && (saved?.agent || 'codex') === agent ? saved?.threadId || null : null);
  const runOptions = { model: launch?.model || null, effort: launch?.effort || 'high', fast: launch?.fast ?? true };
  const sessionId = randomUUID(), sessionKey = randomUUID(), controlCapability = randomUUID();
  if (project.kind === 'ssh') {
    const spec = { agent, owner: 'gui', kind: 'ssh', projectId: project.id, terminalId: id,
      sessionId, sessionKey, cwd, env: {}, ...runOptions, providerSessionId };
    nativeSpecs.set(id, spec); return spec;
  }
  const bootstrapFile = path.join(runtimeDir, `${sessionId}.json`);
  fs.writeFileSync(bootstrapFile, JSON.stringify({ projectId: id, projectPath: project.path, sessionKey,
    controlAddress, controlCapability, pipeName: process.platform === 'win32' ? eventServer.name : eventServer.address }), { mode: 0o600 });
  const env = createTerminalEnvironment(withoutAppImage(process.env), bootstrapFile);
  if (launch?.codexHome) {
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'CODEX_HOME') delete env[key];
    env.CODEX_HOME = launch.codexHome;
  }
  const context = startupNote(READING_NOTE, handoffFile(id), path.join(project.path, 'skills'),
    skills.delivery(project, false, sessionId, { agent, started: true }), path.join(integrationDir, 'dispatch.cjs'));
  const spec = { agent, owner: 'gui', projectId: project.id, terminalId: id, cwd, env, context,
    sessionId, sessionKey, bootstrapFile, controlCapability, ...runOptions, providerSessionId };
  if (spec.providerSessionId && [...sessions.values()].some(s => s.codexActive && [s.claudeSessionId, s.reportedThreadId, s.claudeResumeId].includes(spec.providerSessionId))) throw new Error('该会话正在其他终端运行。');
  nativeSpecs.set(id, spec); return spec;
}

function structuredEvent(id, event) {
  if (event.replay || quitting) return;
  if (event.type === 'switch.updated') {
    const host = sessions.get(id), s = host?.switchPreviousHost || host;
    if (s && (!s.nativeRuntimeSessionId || s.nativeRuntimeSessionId === event.runtimeSessionId)) { s.switchState = event.payload; s.nativePathReason = event.payload.reason; }
    scheduleState(); return;
  }
  const spec = nativeSpecs.get(id), project = store.findTerminal(id)?.project;
  if (!spec || !project) return;
  let s = sessions.get(id);
  if (!s || !s.nativeStructured || s.nativeRuntimeSessionId !== event.runtimeSessionId) {
    if (event.type !== 'session.state' || event.payload.state !== 'starting') return;
    s = { nativeStructured: true, nativeSpec: spec, terminalId: id, projectId: project.id, sessionId: spec.sessionId,
      sessionKey: spec.sessionKey, controlCapability: spec.controlCapability, bootstrapFile: spec.bootstrapFile,
      status: 'codex', ready: false, codexActive: true, agent: spec.agent, nativeMode: event.transport,
      activitySince: Date.now(), codexActivity: 'unknown', error: null, nativeMessages: new Map(), usageEnv: spec.env,
      recordRun: (call, value) => dashboard.run(project, call, value),
      terminal: { kill: () => { void nativeSessions.stop(id, event.runtimeSessionId).catch(report); }, resize() {} },
      gate: { dispose() {}, write() { throw new Error('请使用原生会话输入框。'); } },
      promptQueue: new PromptQueue(() => scheduleState()), completionWork: new CompletionWork(),
      actions: new ActionLog(() => {}), conversation: new ConversationLog(() => {}) };
    if (spec.switchHost) { retainAgentState(s, spec.switchHost); delete spec.switchHost; }
    sessions.set(id, s);
  }
  s.nativeRuntimeSessionId = event.runtimeSessionId;
  s.nativeUsage ||= createNativeUsage(spec.agent);
  s.nativeUsage.apply(event, event.type === 'usage.updated' ? nativeSessions.tokenRate(id, event.runtimeSessionId) : null);
  if (event.type === 'error' && event.payload.code === 'native_cli_outdated') store.warning = t(event.payload.message);
  if (event.providerSessionId) {
    if (spec.agent === 'claude') s.claudeSessionId = event.providerSessionId;
    else s.reportedThreadId = event.providerSessionId;
  }
  if (event.type === 'routing.updated') {
    const { observed, effective } = event.payload;
    if (typeof observed?.model === 'string') s.nativeObservedModel = observed.model;
    s.agentSettings = Object.fromEntries(['model', 'effort', 'fast'].map(key => [key, observed?.[key] ?? effective?.[key] ?? s.agentSettings?.[key] ?? null]));
  }
  if (event.type === 'item.upsert' && event.payload.kind === 'user-message' && event.payload.content.unsent !== true && event.payload.content.text) {
    const clientId = event.payload.content.clientMessageId || event.itemId;
    s.nativeMessages.set(clientId, event.payload.content.text);
    s.promptQueue.enqueue(event.payload.content.text, event.receivedAtMs, clientId);
  }
  if (event.type === 'input.receipt' && event.payload.status === 'consumed') {
    const text = s.nativeMessages.get(event.payload.clientMessageId);
    if (text) s.promptQueue.start(text, event.receivedAtMs, event.payload.clientMessageId);
  }
  if (event.type === 'turn.started') {
    if (event.payload.origin === 'user') { s.completionWork.begin(event.receivedAtMs); store.expectCompletion(project.id); }
    s.activityInputAt = event.receivedAtMs;
    applyActivity(project, s, { threadId: event.providerSessionId || event.runtimeSessionId, turnId: event.turnId, state: 'working', updatedAt: event.receivedAtMs });
  }
  if (event.type === 'turn.completed') {
    applyActivity(project, s, { threadId: event.providerSessionId || event.runtimeSessionId, turnId: event.turnId,
      state: event.payload.status === 'completed' ? 'complete' : event.payload.status === 'unknown' ? 'unknown' : 'interrupted', ended: true, updatedAt: event.receivedAtMs });
  }
  if (event.type === 'session.state') {
    s.nativeState = event.payload.state;
    if (['stopped', 'failed', 'disconnected'].includes(event.payload.state)) {
      s.status = 'exited'; s.codexActive = false;
      store.setRestore(id, { terminal: false, codex: false });
    }
    if (event.payload.state === 'failed') s.error = event.payload.reason;
  }
  scheduleState();
}

async function readNativeConnections(projectId) {
  const result = {}, observed = new Map();
  for (const agent of ['claude', 'codex']) {
    const host = [...sessions.values()].reverse().find(s => (!projectId || s.projectId === projectId) && s.agent === agent && s.codexActive === true && s.status !== 'exited');
    if (!host) { result[agent] = projectAccounts.snapshot(projectId)?.[agent]?.connection || { kind: 'none', source: null, observedAt: null };
      result[agent] = { ...result[agent], active: false }; continue; }
    observed.set(agent, host);
    if (host.nativeStructured) {
      if (agent === 'claude') result[agent] = claudeRuntime.connection(host.nativeRuntimeSessionId);
      else {
        try { result[agent] = await host.nativeReadConnection?.(); } catch { }
        result[agent] ||= { kind: 'unknown', source: 'codex-app-server account/read', observedAt: null };
      }
    } else if (agent === 'claude') result[agent] = { kind: 'subscription', source: 'Claude Code terminal login', observedAt: host.activitySince || null };
    else {
      // The existing terminal reader may have no login-mode evidence. Quota alone proves neither billing path.
      const connection = host.terminalAccount?.connection;
      // The reader names the account it read; the name goes with the kind it was read for.
      const kind = ['api', 'subscription'].includes(connection?.kind) ? connection.kind : 'unknown';
      result[agent] = { kind, source: 'codex-account-usage', observedAt: host.terminalAccount?.at || null,
        ...(kind !== 'unknown' && connection.scopeId ? { scopeId: connection.scopeId } : {}) };
    }
  }
  for (const agent of observed.keys()) result[agent] = { ...result[agent], active: true };
  for (const [agent, host] of observed) if (sessions.get(host.terminalId) !== host || !host.codexActive || host.status === 'exited') result[agent] = { kind: 'none', active: false, source: null, observedAt: null };
  return result;
}

function readNativeSubscriptionLimits(projectId) {
  const latest = candidates => candidates.filter(Boolean).sort((a, b) => (b.observedAtMs ?? -Infinity) - (a.observedAtMs ?? -Infinity))[0] || null;
  const account = projectAccounts.snapshot(projectId);
  const claude = [subscriptionLimits(account?.claude || (!projectId ? claudeAccounts.account : null), 'claude-account', 120000)];
  // Meters also hold the existing local-cache fallback. Reading them must never refresh an account.
  for (const s of localClaudeMeters()) if ((!projectId || s.projectId === projectId) && s.usage.limits.length) claude.push(subscriptionLimits({
    limits: s.usage.limits, at: s.usage.limitsAt, source: s.usage.limitsFrom }, 'claude-account', 120000));
  const codex = projectId ? [subscriptionLimits(account?.codex, 'codex-account', 2 * codexAccounts.interval)]
    : [...codexAccounts.entries].map(([key, entry]) => subscriptionLimits(entry.value, key, 2 * codexAccounts.interval));
  return { claude: latest(claude), codex: latest(codex) };
}

async function readNativeUsageInputs(projectId) {
  if (projectId) await shellPathReady;
  const [claudeCli, codexFile] = await Promise.all([inspectClaudeExecutable(), codexExecutable()]);
  claudeRuntime?.observeCli?.(claudeCli);
  const cli = { claude: claudeCli, codex: { status: codexFile ? 'ok' : 'missing' } };
  const project = store.projects.find(project => project.id === projectId);
  if (project && project.kind !== 'ssh') {
    if (!quitting && store.projects.includes(project)) await projectAccounts.read(project, { cli,
      env: createTerminalEnvironment(withoutAppImage(process.env), '') });
  }
  return { cli, limits: readNativeSubscriptionLimits(projectId) };
}

function localSwitchSessions() {
  const result = [];
  for (const [id, current] of sessions) {
    const s = current.switchPreviousHost || current, project = store.findTerminal(id)?.project;
    if (!project || project.kind === 'ssh' || !s.codexActive || s.nativeStructured || s.status === 'exited' || s.agent !== 'claude') continue;
    s.nativeRuntimeSessionId ||= randomUUID();
    const providerSessionId = s.claudeSessionId || s.claudeResumeId || null;
    result.push({ identity: s, path: 'terminal', spec: { owner: 'gui', agent: s.agent, kind: project.kind,
      projectId: project.id, terminalId: id, runtimeSessionId: s.nativeRuntimeSessionId, providerSessionId,
      sessionId: s.sessionId, sessionKey: s.sessionKey, controlCapability: s.controlCapability, bootstrapFile: s.bootstrapFile,
      cwd: store.findTerminal(id)?.record.restore?.cwd || project.path, env: s.usageEnv, context: s.skillNote || '',
      hasHistory: s.conversation?.list.some(entry => ['user', 'assistant'].includes(entry.role)),
      model: s.agentSettings?.model || null, effort: s.agentSettings?.effort || 'high', fast: s.agentSettings?.fast ?? true } });
  }
  return result;
}
function observeSwitchTerminal(session) {
  const s = session.identity;
  const work = s.completionWork;
  const tasks = new Set([...(work?.tasks?.values() || [])].map(task => task.id));
  for (const id of work?.services || []) tasks.add(id);
  for (const call of s.calls?.running?.() || []) tasks.add(call.id);
  // A fresh CLI does not create its transcript until the first prompt. ENOENT here is an empty observation,
  // whereas unreadable history, a resumed thread or a failed reader must still remain unknown.
  const empty = s.agent === 'claude' && s.claudeSessionSource === 'startup' && s.claudeTranscript?.missing === true
    && !s.claudeResumeId && !session.spec?.hasHistory && !s.activityInputAt;
  return { state: s.cliState?.sessionId === s.sessionId && s.cliState.state === 'idle' ? 'idle' : 'working',
    pending: !!s.nativeInputRequests?.size || s.promptQueue?.list().some(item => item.state === 'queued'),
    draftBlocked: !!s.submissions?.hasText,
    background: !work || work.uncertain || work.reading && !empty ? { known: false, count: null } : { known: true, count: tasks.size } };
}
function retainAgentState(target, source) {
  target.plannerSessionId = source.plannerSessionId || source.sessionId;
  target.switchBootstrapFiles = [...new Set([...(source.switchBootstrapFiles || []), source.bootstrapFile].filter(file => file && file !== target.bootstrapFile))];
  for (const key of ['sessionKey', 'controlCapability', 'calls', 'completionWork', 'promptQueue', 'lastCompletedAt', 'lastTask', 'lastTaskSummary', 'lastTaskTitle',
    'activityInputAt', 'activityConfirmedInputAt', 'activityPromptAt', 'claudePromptEventId', 'nativeMessages', 'switchState']) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  target.completionWork.changed = () => {
    if (sessions.get(target.terminalId) === target && target.codexActive && target.activitySnapshot) applyActivity(findProject(target.terminalId), target, target.activitySnapshot);
  };
  target.promptQueue.changed = expired => {
    if (sessions.get(target.terminalId) !== target) return;
    if (expired?.length) target.activityInputAt = Math.max(target.activityConfirmedInputAt || 0, ...target.promptQueue.items.map(item => item.at));
    scheduleState();
  };
}
async function prepareSwitchTerminal(spec, _handoff, currentChange, transition = {}) {
  const id = spec.terminalId, old = sessions.get(id);
  if (!old?.nativeStructured || spec.agent !== 'claude') throw new Error('session_changed');
  sessions.delete(id);
  launchPlans.set(id, { agent: spec.agent, command: launchCommand(spec.agent, spec.providerSessionId ? { id: spec.providerSessionId } : null), threadId: spec.providerSessionId });
  let staged;
  const cancel = () => {
    const owned = staged && sessions.get(id) === staged;
    if (owned) disposeTerminal(id, { preserveSwitch: true });
    launchPlans.delete(id);
    if ((owned || !staged && currentChange()) && store.findTerminal(id)) { sessions.set(id, old); nativeSpecs.set(id, old.nativeSpec); }
    broadcast();
  };
  try {
    startTerminal(id, null, true, old); staged = sessions.get(id);
    staged.nativeRuntimeSessionId = spec.runtimeSessionId;
    Object.assign(spec, { sessionId: staged.sessionId, bootstrapFile: staged.bootstrapFile, env: staged.usageEnv || spec.env });
    // OS/shell cold starts have no reliable wall-clock limit. Keep the source
    // surface until the same CLI is ready; closing or changing the switch
    // cancels this wait and disposes only the staged PTY.
    while (currentChange() && sessions.get(id) === staged && staged.status !== 'exited') {
      if (staged.error) throw new Error('terminal_start_failed');
      if (staged.status === 'shell' && staged.ready && !staged.agentStarting && !launchPlans.has(id)) throw new Error('terminal_agent_exited');
      const provider = staged.claudeSessionId;
      const ready = staged.cliState?.state === 'idle';
      if (provider && ready) {
        if (spec.providerSessionId && provider !== spec.providerSessionId) throw new Error('terminal_resume_identity_mismatch');
        spec.providerSessionId = provider; break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!currentChange() || sessions.get(id) !== staged || staged.status === 'exited') throw new Error('session_changed');
    return { session: { identity: staged, path: 'terminal', spec }, cancel,
      async send(input) {
        const tracker = staged.submissions;
        if (!terminalInput || spec.agent !== 'claude' || sessions.get(id) !== staged || !currentChange()
          || staged.cliState?.state !== 'idle' || !tracker || tracker.hasText || tracker.history || tracker.pasting
          || !input.text || input.text.length > 4000 || /^[!/]/.test(input.text) || /[\x00-\x08\x0b-\x1f\x7f]/.test(input.text)) return { status: 'rejected' };
        // Reuse the tracked terminal input path. Never clear or overwrite a CLI draft.
        terminalInput.write(id, `\x1b[200~${input.text}\x1b[201~`);
        await new Promise(resolve => setTimeout(resolve, 400));
        if (sessions.get(id) !== staged || !currentChange() || staged.cliState?.state !== 'idle' || tracker.history
          || tracker.text !== input.text) return { status: 'unknown' };
        terminalInput.write(id, '\r');
        return { status: 'delivered' };
      },
      commit() {
        store.setRestore(id, { terminal: true, codex: true, agent: spec.agent, threadId: spec.providerSessionId, nativeTransport: null });
        retainAgentState(staged, old); delete staged.switchPreviousHost; staged.nativeRuntimeSessionId = spec.runtimeSessionId; broadcast();
        if (transition.discardBackground) staged.completionWork?.discardBackground?.();
      } };
  } catch (error) { cancel(); throw error; }
}

async function initializeNativeSessions() {
  // Load optional provider composition after app.ready; neither module starts a real account session here.
  const { createCodexRuntime } = await import('./features/codex-app-server/index.cjs');
  const { createDispatchControl } = await import('./features/agents/dispatch-control.cjs');
  const { projectTeam } = require('./features/team/team.cjs');
  dispatchControl = createDispatchControl({ resolveRun: registration => {
    const s = sessions.get(registration.projectId), project = store.findTerminal(registration.projectId)?.project;
    if (!s || !project || s.sessionKey !== registration.sessionKey || s.controlCapability !== registration.capability) return null;
    const worker = projectTeam(project.path)?.live().find(run => run.id === registration.runId);
    if (!worker) return null;
    return { runId: worker.id, projectId: registration.projectId, cwd: worker.cwd, worktree: worker.cwd, allow: worker.allow,
      readOnly: worker.readOnly === true || worker.role === '调查' || worker.role === '审查', roundtable: worker.role === '圆桌' };
  } });
  ({ address: controlAddress } = await dispatchControl.listen());
  const directory = path.join(app.getPath('userData'), 'native-session');
  claudeRuntime = createClaudeRuntime({ directory, safeStorage: require('electron').safeStorage,
    loadSdk: createSdkLoader({ packaged: app.isPackaged }),
    connectionSpec: projectId => {
      const project = projectId && store.projects.find(project => project.id === projectId);
      if (projectId && (!project || project.kind === 'ssh')) throw new Error('原生会话仅支持本地项目。');
      return { agent: 'claude', owner: 'gui', projectId, cwd: project?.path || process.cwd(), effort: 'high', fast: true };
    },
    onCost: entry => {
      if (entry.spec.owner === 'dispatch') return;
      const project = store.findTerminal(entry.spec.terminalId)?.project; if (!project) return;
      dashboard.run(project, { source: 'native', sourceAgent: 'claude', title: 'Claude API', startedAt: Date.now(), model: entry.spec.model },
        { id: entry.usageRecordId, source: 'native', model: entry.spec.model, endedAt: Date.now(), reportedCostUsd: entry.deltaUsdMicros / 1e6,
          billingPath: 'api', usageRecordId: entry.usageRecordId, costCompleteness: 'estimated', reason: 'exit', exitCode: 0 });
    },
  });
  claudeRuntime.observeCli?.(await inspectClaudeExecutable());
  const codexFactory = createCodexRuntime({ renderImage: (item, spec) => spec.kind === 'ssh' ? null : generatedPreview(item, spec), translate: t,
    launchRemote: async (spec, { signal, readOnly = false }) => {
      const project = findProject(spec.terminalId);
      const delivery = readOnly ? null : skills.delivery(project, true, spec.sessionId, { agent: 'codex', started: true });
      const remote = new RemoteConnection({ ...project, id: spec.terminalId }, { integrationDir, auth: sshAuth,
        sessionKey: spec.sessionKey, onEvent, codingPath: spec.cwd, askpassPath: prepareAskpass(), native: true,
        skills: delivery?.bundle, readingNote: readOnly ? '' : startupNote(READING_NOTE, '{AGENTRIX_HANDOFF}',
          path.posix.join(project.path, 'skills'), delivery, '{AGENTRIX_DISPATCH}') });
      const cancel = () => remote.close();
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const host = sessions.get(spec.terminalId); if (host && !readOnly) host.remoteConnection = remote;
      try {
        const info = await remote.ready;
        if (signal.aborted) throw new Error('session_closed');
        return { cwd: info.cwd || info.root, context: info.context,
          child: require('./features/ssh/codex-process.cjs').createRemoteCodexProcess(remote) };
      } catch (error) { remote.close(); throw error; }
      finally { signal.removeEventListener('abort', cancel); }
    },
    resetAtLimit: (spec, evidence) => codexAccounts.resetAtLimit({ ...spec, remote: spec.kind === 'ssh', accountLaunch: 'project-open-v1' },
      { ...evidence, enabled: nativeSessions?.getSettings().codexAutoReset === true,
        current: () => evidence.current() && nativeSessions?.getSettings().codexAutoReset === true }) });
  const codex = { create(spec, emit) {
    const runtime = codexFactory.create(spec, emit), start = runtime.start, resume = runtime.resume, close = runtime.close;
    let accountBinding, accountWatch;
    const attach = async (open, value) => {
      const result = await open(value);
      const options = { cwd: spec.cwd, env: spec.env, projectId: spec.projectId };
      if (spec.kind === 'ssh') {
        const host = sessions.get(spec.terminalId);
        if (host) host.nativeReadConnection = () => runtime.readAccount();
        return result;
      }
      accountBinding = codexAccounts.attachRuntime?.(options, runtime);
      accountWatch = codexAccounts.watch(options, () => scheduleState());
      const host = sessions.get(spec.terminalId);
      if (host) host.nativeReadConnection = () => runtime.readAccount();
      return result;
    };
    runtime.start = value => attach(start, value); runtime.resume = value => attach(resume, value);
    runtime.close = async () => { accountWatch?.dispose(); accountBinding?.dispose(); await close(); };
    return runtime;
  } };
  nativeSessions = createNativeSessions({ directory, claude: claudeRuntime, codex, resolveSpec: nativeSpec,
    readHistory: async (id, { signal } = {}) => {
      const project = findProject(id);
      const spec = nativeSpecs.get(id);
      if (project.kind !== 'ssh' && spec?.agent !== 'codex') return folderHistory(folderOf(id));
      const saved = store.findTerminal(id).record.restore;
      const history = await codexFactory.history({ kind: project.kind, owner: 'gui', projectId: project.id, terminalId: id,
        cwd: spec?.cwd || saved?.cwd || project.path, env: spec?.env, sessionId: randomUUID(), sessionKey: randomUUID(), providerSessionId: null }, { signal }).catch(error => {
        if (error.code === 'codex_cli_required' && project.kind === 'ssh') throw Object.assign(new Error(t('远端未找到 Codex 程序。请在远端登录 shell 中安装 Codex，并确认 type -P codex 能找到它。')), { code: error.code });
        throw error;
      });
      if (findProject(id) !== project) throw new Error('项目已变化，请重试。');
      return { claude: null, codex: history };
    },
    readCommands: spec => {
      const env = spec.env || process.env;
      const value = name => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
      return listAgentCommands({ agent: spec.agent, projectPath: spec.cwd,
        home: value('USERPROFILE') || value('HOME') || require('node:os').homedir(),
        claudeHome: value('CLAUDE_CONFIG_DIR'), codexHome: value('CODEX_HOME') })
        .then(rows => rows.map(row => ({ ...row, description: t(row.description) })));
    },
    connections: readNativeConnections, usageInputs: readNativeUsageInputs,
    validateProject: projectId => { const project = projectId && store.projects.find(project => project.id === projectId); if (projectId && !project) throw new Error('项目已关闭。'); return project || null; },
    terminalSessions: localSwitchSessions, observeTerminal: observeSwitchTerminal, prepareTerminal: prepareSwitchTerminal,
    retireTerminal: (session, reason) => {
      const host = sessions.get(session.spec.terminalId);
      if (host !== session.identity) return;
      host.status = 'exited'; host.codexActive = false; host.nativePathReason = reason;
      store.setRestore(session.spec.terminalId, { codex: false }); broadcast();
    },
    activateNative: (spec, _handoff, transition = {}) => {
      const old = sessions.get(spec.terminalId);
      if (transition.newConversation) {
        if (!old?.nativeStructured) throw new Error('session_changed');
        spec.switchHost = old; nativeSpecs.set(spec.terminalId, spec); return;
      }
      if (!old || old.sessionId !== spec.sessionId || !transition.recovering && observeSwitchTerminal({ identity: old }).draftBlocked) throw new Error('session_changed');
      if (spec.bootstrapFile && !fs.existsSync(spec.bootstrapFile)) fs.writeFileSync(spec.bootstrapFile, JSON.stringify({ projectId: spec.terminalId,
        projectPath: spec.cwd, sessionKey: spec.sessionKey, controlAddress, controlCapability: spec.controlCapability,
        pipeName: process.platform === 'win32' ? eventServer.name : eventServer.address }), { mode: 0o600 });
      spec.switchHost = old; disposeTerminal(spec.terminalId, { preserveSwitch: true }); nativeSpecs.set(spec.terminalId, spec);
      if (transition.discardBackground) old.completionWork?.discardBackground?.();
    },
    emit: event => send('native:event', event), changed: (id, event) => { if (event) structuredEvent(id, event); else scheduleState(); },
    saveSession: (id, saved) => store.setRestore(id, { terminal: true, codex: true, agent: saved.agent, threadId: saved.providerSessionId,
      nativeTransport: saved.agent === 'claude' ? 'claude-sdk' : 'codex-app-server' }),
    saveInterrupted: (id, interrupted) => { if (!quitting) store.setRestore(id, { interrupted }); },
    terminal: async (spec, reason) => {
      const current = sessions.get(spec.terminalId); if (current?.nativeStructured) disposeTerminal(spec.terminalId, { preserveNative: true });
      nativeSpecs.delete(spec.terminalId);
      if (spec.bootstrapFile) fs.rmSync(spec.bootstrapFile, { force: true });
      const history = spec.providerSessionId ? { id: spec.providerSessionId } : null;
      launchPlans.set(spec.terminalId, { agent: spec.agent, command: launchCommand(spec.agent, history), threadId: history?.id || null });
      store.setRestore(spec.terminalId, { nativeTransport: null });
      startTerminal(spec.terminalId, null, true);
      const s = sessions.get(spec.terminalId); if (s) { s.nativePathReason = reason; s.nativeRuntimeSessionId = spec.runtimeSessionId; }
    } });
  registerClaudeWorker({ control: dispatchControl, claude: claudeRuntime, settings: nativeSessions.getSettings });
}

function restoreTerminal(id, ...args) {
  const found = store.findTerminal(id), saved = found?.record.restore;
  const localCodex = (saved?.agent || 'codex') === 'codex' && (saved?.codex || saved?.nativeTransport);
  if (localCodex || saved?.nativeTransport && nativeSessions) {
    restorePlans.delete(id);
    if (!nativeSessions) throw new Error('Codex 原生模式连接失败，请重试。');
    const interrupted = saved.interrupted === true;
    return nativeSessions.start(id, { agent: saved.agent || 'codex', resume: !!saved.threadId }).then(async opened => {
      if ((saved.agent || 'codex') === 'codex' && saved.threadId && interrupted) {
        await nativeSessions.continueInterrupted(id, opened.runtimeSessionId, () => store.setRestore(id, { interrupted: false }));
      }
      return opened;
    }).catch(error => {
      startupErrors.set(id, error.message); broadcast();
    });
  }
  startTerminal(id, ...args);
}

function startTerminal(id, nativeMode = null, agentStarting = false, transfer = null) {
  if (nativeMode !== null) throw new Error('Unsupported native session mode');
  const project = findProject(id);
  const old = sessions.get(id);
  if (old && old.status !== 'exited') return;
  if (old) disposeTerminal(id);
  if (!['win32', 'darwin', 'linux'].includes(process.platform)) throw new Error('此版本的终端集成面向 Windows 10/11、macOS 和 Linux。');
  if (project.kind !== 'ssh' && !fs.existsSync(project.path)) throw new Error('项目目录不存在，请重新添加。');
  const sessionId = randomUUID();
  const sessionKey = transfer?.sessionKey || randomUUID();
  const controlCapability = transfer?.controlCapability || randomUUID();
  const startPath = restorePlans.get(id)?.cwd || store.findTerminal(id)?.record.restore?.cwd || project.path;
  // Local terminals use the shell chosen in settings; SSH projects always run Bash on the server.
  const shell = project.kind === 'ssh' ? { kind: 'bash', file: null } : localShell(true), shellKind = shell.kind;
  const bootstrapFile = project.kind !== 'ssh' ? path.join(runtimeDir, `${sessionId}.json`) : null;
  const skillNoteFile = project.kind === 'ssh' ? null : path.join(runtimeDir, `${sessionId}-skills.txt`);
  if (bootstrapFile) fs.writeFileSync(bootstrapFile, JSON.stringify({
    projectId: id, projectPath: startPath, sessionKey, controlAddress, controlCapability, pipeName: process.platform === 'win32' ? eventServer.name : eventServer.address,
    powershellPath, notifyPath: path.join(integrationDir, 'notify.ps1'), claudeHookPath: path.join(integrationDir, 'claude-hook.ps1'),
    nodePath: process.execPath, accountScopeHelper: path.join(integrationDir, 'codex-account-scope.cjs'),
  }), { mode: 0o600 });
  let env = createTerminalEnvironment(withoutAppImage(process.env), bootstrapFile || '');
  if (project.kind !== 'ssh') env.AGENTRIX_ACCOUNT_BASELINE = JSON.stringify(accountEnvironment(env));
  // The agent wrappers tell Claude Code and Codex what the reading view shows (an SSH project's worker is told on start),
  // and where the work done in this folder before is written down for them (handoff.cjs), so either one carries it on.
  if (project.kind !== 'ssh') {
    env.AGENTRIX_READING_NOTE = startupNote(READING_NOTE, handoffFile(id), path.join(project.path, 'skills'),
      skills.delivery(project, false, sessionId), path.join(integrationDir, 'dispatch.cjs'));
    writeFileAtomic(skillNoteFile, env.AGENTRIX_READING_NOTE);
    env.AGENTRIX_READING_NOTE_FILE = skillNoteFile;
    void writeHandoff(handoffFile(id), startPath, { memoryDir: memoryDir() }).catch(() => {});
  }
  // zsh and Bash learn where to report from their environment (integration/zsh-integration.zsh and
  // bash-integration.bash), and report through integration/agent-event.cjs run by this executable as Node.
  const local = project.kind !== 'ssh' && ['zsh', 'bash'].includes(shellKind);
  const integration = local && { folder: zshStartup, socket: eventServer.address, projectId: id, sessionKey, node: process.execPath,
    helper: path.join(integrationDir, 'agent-event.cjs'), startDir: startPath,
    loginFiles: process.platform === 'darwin' && shellKind === 'bash',
    // Every glibc since 2.35 has C.UTF-8; a Linux desktop session normally sets LANG itself.
    locale: process.platform === 'darwin' ? terminalLocale(app.getPreferredSystemLanguages()) : 'C.UTF-8' };
  if (local) env = shellKind === 'zsh' ? zshEnvironment(env, integration) : shellEnvironment(env, integration);
  const sshAskpassPath = project.kind === 'ssh' ? prepareAskpass() : undefined;
  const terminalOptions = { name: 'xterm-256color', cols: 90, rows: 22, cwd: startPath, env,
    ...(!['zsh', 'bash'].includes(shellKind) ? { useConpty: true, useConptyDll: true } : {}) };
  const remoteSkills = project.kind === 'ssh' ? skills.delivery(project, true, sessionId) : null;
  const terminal = project.kind === 'ssh' ? new RemoteConnection({ ...project, id }, { integrationDir, auth: sshAuth, sessionKey, onEvent, codingPath: startPath, askpassPath: sshAskpassPath,
    readingNote: startupNote(READING_NOTE, '{AGENTRIX_HANDOFF}', path.posix.join(project.path, 'skills'), remoteSkills, '{AGENTRIX_DISPATCH}'), skills: remoteSkills.bundle,
    onReady: info => { remoteBranch(project.id, info.branch); },
  }) : shellKind === 'zsh' ? pty.spawn(shell.file, ['-l', '-i'], terminalOptions)
    : shellKind === 'bash' ? pty.spawn(shell.file, bashArguments(integrationDir), terminalOptions)
    : shellKind === 'cmd' ? pty.spawn(cmdPath, ['/D', '/Q', '/K', path.join(integrationDir, 'bootstrap.cmd')], terminalOptions)
    : pty.spawn(powershellPath, ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', path.join(integrationDir, 'bootstrap.ps1')], terminalOptions);
  const s = {
    switchPreviousHost: transfer, terminal, terminalId: id, projectId: project.id, sessionId, skillSessionId: null, sessionKey, controlCapability, bootstrapFile, skillNoteFile, skillNote: env.AGENTRIX_READING_NOTE, status: 'starting', agentStarting, ready: false, shellKind,
    recordRun: (call, event) => dashboard.run(project, call, event),
    recordQuota: (provider, limits) => dashboard.quota(provider, limits, quotaScope(provider, project, s)),
    // Command Prompt reports its prompts through markers in its output instead of the event pipe.
    usageEnv: project.kind === 'ssh' ? null : { ...env },
    prompts: shellKind === 'cmd' ? new PromptMarkers() : null,
    tools: shellKind === 'cmd' ? { codex: onPath('codex', env), claude: onPath('claude', env) } : null,
    titles: new TerminalTitleTracker(), reportedThreadId: null,
    codexActive: false, codexAvailable: null, seq: 0, chunks: [], bytes: 0, pending: '',
    flushTimer: null, error: null, submissions: new SubmissionTracker(), draftSubmissions: null,
    approval: new ApprovalGuard(sessionId), approvalRemote: project.kind === 'ssh',
    native: null, nativeMode: null,
    observeNativeSwitch: () => nativeSessions?.observe?.(id),
  };
  s.actions = new ActionLog(change => publishAction(s, change));
  s.gate = new InputGate(data => {
    if (sessions.get(id) !== s || s.status === 'exited') return;
    if (!isTerminalResponse(data)) s.approval.invalidate();
    if (!isTerminalResponse(data)) {
      nativeSessions?.input?.(id, s.nativeRuntimeSessionId);
      void Promise.resolve().then(() => s.observeNativeSwitch?.());
    }
    terminal.write(data);
  }, { shellOwnsInput: () => !s.codexActive });
  const refreshCompletion = () => {
    if (sessions.get(id) === s && s.codexActive && (s.activityRawSnapshot || s.activitySnapshot)) applyActivity(project, s, s.activityRawSnapshot || s.activitySnapshot);
  };
  s.completionWork = new CompletionWork({ changed: refreshCompletion });
  s.promptQueue = new PromptQueue(expired => {
    if (sessions.get(id) !== s) return;
    scheduleState();
    if (expired?.length) {
      // Release only the expired submissions' provisional guard. Received prompts
      // and submissions still waiting must continue to reject older completions.
      s.activityInputAt = Math.max(s.activityConfirmedInputAt || 0, ...s.promptQueue.items.map(item => item.at));
      queueMicrotask(() => {
        if (s.activityRawSnapshot) applyActivity(project, s, s.activityRawSnapshot);
      });
      return;
    }
    // Queue receipt/cancellation/expiry can change a deferred completion even if
    // no new lifecycle snapshot arrives. This never arms another notification.
    if (s.activitySnapshot?.state === 'complete') queueMicrotask(refreshCompletion);
  });
  // A prompt the agent's own record shows it received is being worked on. History read when a session is
  // resumed is older than the agent's start and is left out.
  s.conversation = new ConversationLog(change => {
    publishConversation(s, change);
    const entry = change.entry;
    // Local transcripts already use the main clock; the hook offset includes delivery latency.
    const at = (entry?.receivedAt ?? entry?.at) + (project.kind === 'ssh' ? s.activityClockOffset || 0 : 0);
    if (entry?.cancelled) s.promptQueue.cancel(entry.original ?? entry.text, at, entry.id);
    else if (entry?.role === 'user' && entry.queued && s.codexActive && at >= (s.activitySince || 0) - 1000) s.promptQueue.enqueue(entry.original ?? entry.text, at, entry.id);
    if (entry?.role === 'assistant' && s.codexActive) s.promptQueue.reply({ ...entry, at });
    // An answer to the agent's own question is not a prompt: it goes on with the round it answered.
    if (entry?.role === 'user' && !entry.answer && !entry.queued && s.codexActive) {
      const localCommand = isLocalAgentCommand(s.agent, entry.text);
      if (at >= (s.activitySince || 0) - 1000) {
        const inputAt = s.promptQueue.start(entry.original ?? entry.text, at, entry.id, localCommand);
        if (inputAt !== undefined) {
          s.activityConfirmedInputAt = Math.max(s.activityConfirmedInputAt || 0, inputAt);
          s.activityInputAt = Math.max(s.activityInputAt || 0, s.activityConfirmedInputAt);
        }
      }
      // Recalled prompts, custom slash commands and command-line prompts are not always visible to the key
      // tracker. Codex's received user message confirms them. A time watermark excludes history and replays;
      // working/completion snapshots alone can never grant another alert. Claude has UserPromptSubmit hooks.
      if (s.agent === 'codex' && !localCommand && at >= Math.max(s.activitySince || 0, s.activityInputAt || 0) && at > Math.max(s.activityPromptAt || 0, s.lastCompletedAt || 0)) {
        // task_started may already have published this turn before its user item arrives.
        // Retire the previous turn only when no newer start is awaiting its prompt receipt.
        const started = s.activitySnapshot?.state === 'working' && s.activitySnapshot.turnId
          && s.activitySnapshot.updatedAt > (s.activityPromptAt || 0);
        publishCliState(s, 'working', { at, threadId: s.reportedThreadId || s.rootThreadId, eventId: `input:${entry.id}`, newTurn: !started });
        s.activityPromptAt = at;
        s.completionWork?.begin(at);
        store.expectCompletion(project.id);
      }
    }
  });
  sessions.set(id, s);
  store.setRestore(id, { terminal: true, ...(restorePlans.has(id) ? {} : { codex: false }) });
  startupErrors.delete(id);
  const flush = () => {
    clearTimeout(s.flushTimer); s.flushTimer = null;
    if (!s.pending) return;
    send('terminal:data', { id, sessionId, seq: ++s.seq, data: s.pending, approval: approvalStamp(s) });
    s.pending = '';
  };
  s.flush = flush;
  terminal.onData(data => {
    if (sessions.get(id) !== s) return;
    // Before the 16 ms transport batch and the renderer's 100 ms publication: even coalesced A/B/A output
    // invalidates old tickets. Identical bytes can be a new request; terminal mode provides no native request ID.
    s.approval.invalidate();
    if (s.prompts) for (const cwd of s.prompts.write(data)) {
      onEvent({ projectId: id, sessionKey, type: 'shell-prompt', sequence: (s.lastShellEventSequence || 0) + 1, cwd, codexAvailable: s.tools.codex, claudeAvailable: s.tools.claude,
        codexHome: env.CODEX_HOME || path.join(os.homedir(), '.codex') });
    }
    for (const threadId of s.titles.write(data)) {
      if (s.reportedThreadId !== threadId) {
        const previous = readingHistory.summary(id);
        if (previous && !previous.threadId.toLowerCase().startsWith(threadId.toLowerCase())) readingHistory.close(id);
        if (s.agent === 'codex' && wholeThread(threadId)) void prepareReading(id, { agent: 'codex', threadId, cwd: store.findTerminal(id)?.record.restore?.cwd || project.path });
        s.reportedThreadId = threadId;
        if (s.agent === 'codex' && s.cliProviderId && !s.cliProviderId.toLowerCase().startsWith(threadId.toLowerCase())) {
          publishCliState(s, 'idle', { threadId, bind: true });
        }
        s.approval.context('terminal-title', threadId);
        // A title cut short names the session only by how its id begins: the whole id is kept once its record is found.
        if (s.codexActive) { s.codexActivity = 'unknown'; s.activityInputAt = s.activityConfirmedInputAt = 0; if (wholeThread(threadId)) store.setRestore(id, { threadId }); void s.activityMonitor?.poll(); }
      }
    }
    s.usageAccount?.output(data);
    s.gate.output(data);
    s.chunks.push(data); s.bytes += data.length; s.pending += data;
    while (s.bytes > 1024 * 1024 && s.chunks.length > 1) s.bytes -= s.chunks.shift().length;
    if (s.pending.length > 65536) flush();
    else if (!s.flushTimer) s.flushTimer = setTimeout(flush, 16);
  });
  terminal.on?.('error', () => {
    if (sessions.get(id) !== s || s.terminalFaulted) return;
    s.terminalFaulted = true; s.error = t('终端连接已断开。');
    try { terminal.kill(); } catch { }
  });
  terminal.onExit(({ exitCode }) => {
    if (sessions.get(id) !== s) return;
    if (nativeSessions?.failed?.(id, s.nativeRuntimeSessionId)) { s.ready = false; broadcast(); return; }
    flush();
    endSkillSession(s);
    skills.endSession(project.id, sessionId);
    stopUsageAccount(s);
    s.status = 'exited'; s.ready = false; s.codexActive = false;
    readingHistory.close(id);
    s.activityMonitor?.stop(); s.activityMonitor = null; s.codexActivity = 'unknown';
    if (s.completionWork.reset()) store.expectCompletion(project.id, false);
    s.activitySnapshot = s.activityRawSnapshot = null;
    restorePlans.delete(id);
    if (terminal.error || exitCode) s.error = terminal.error || t('终端已退出（代码 {code}）。', { code: exitCode });
    if (!quitting && !exitCode) store.setRestore(id, { terminal: false, codex: false });
    if (bootstrapFile || skillNoteFile) cleanupTerminalFiles(s);
    s.calls?.dispose();
    broadcast();
  });
  captureBranch(project);
  broadcast();
}

function cleanupTerminalFiles(s) {
  if (s.bootstrapFile) {
    const folder = path.dirname(s.bootstrapFile), prefix = `${s.sessionId}-claude-settings-`;
    // Runs in pty exit callbacks and the quit loop: a vanished runtime folder must not throw there.
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') report(error); }
    for (const entry of entries) {
      if (!entry.isDirectory() && entry.name.startsWith(prefix)) fs.rmSync(path.join(folder, entry.name), { force: true });
    }
    fs.rmSync(s.bootstrapFile, { force: true });
  }
  if (s.skillNoteFile) fs.rmSync(s.skillNoteFile, { force: true });
  for (const file of s.switchBootstrapFiles || []) fs.rmSync(file, { force: true });
}

function disposeTerminal(id, { preserveNative = false, preserveSwitch = false } = {}) {
  readingHistory.close(id);
  const s = sessions.get(id);
  sessions.delete(id);
  nativeSpecs.delete(id);
  if (!preserveNative && !preserveSwitch) void nativeSessions?.forget(id).catch(report);
  if (!s) return;
  if (!preserveSwitch) {
    s.calls?.dispose(); syncDashboardLive(); endSkillSession(s); skills.endSession(s.projectId, s.sessionId);
  }
  stopUsageAccount(s);
  clearTimeout(s.flushTimer); clearTimeout(s.actionTimer); clearTimeout(s.conversationTimer);
  for (const timer of s.submissionPolls || []) clearTimeout(timer);
  s.activityMonitor?.stop(); s.gate.dispose();
  if (!preserveSwitch) { s.promptQueue.reset(); s.completionWork?.reset(); }
  try { if (!s.nativeStructured) s.terminal.kill(); } catch { }
  if (!preserveSwitch) cleanupTerminalFiles(s);
}

function registerUnavailableNative(handle) {
  const settings = { claudePath: 'terminal-only', monthlyBudgetUsd: null, codexAutoReset: false };
  function start(id, options) {
    if (!options || typeof options !== 'object' || Object.keys(options).some(key => !['agent', 'resume'].includes(key)) ||
      !['claude', 'codex'].includes(options.agent) || options.resume !== undefined && typeof options.resume !== 'boolean') throw new Error('无效的原生会话请求。');
    const project = findProject(id), saved = store.findTerminal(id).record.restore;
    if (options.agent === 'codex') throw new Error('Codex 原生模式连接失败，请重试。');
    if (project.kind === 'ssh') throw new Error('SSH 原生会话目前仅支持 Codex。');
    const history = options.resume && saved?.agent === options.agent && /^[a-f\d-]{36}$/i.test(saved.threadId || '') ? { id: saved.threadId } : null;
    launchPlans.set(id, { agent: options.agent, command: launchCommand(options.agent, history), threadId: history?.id || null });
    startTerminal(id, null, true); broadcast();
    return { runtimeSessionId: randomUUID() };
  }
  handle('native:start', start);
  handle('native:resume', (id, options) => start(id, { ...options, resume: true }));
  handle('native:settings-get', () => ({ ...settings }));
  handle('native:snapshot', id => { findProject(id); return null; });
  handle('native:usage', async projectId => {
    const connections = await readNativeConnections(projectId), limits = readNativeSubscriptionLimits();
    const summary = claudeRuntime?.usage.summary() || { month: new Date().toISOString().slice(0, 7),
      todayUsdMicros: null, monthUsdMicros: null, estimated: true, apiRecords: false };
    return { ...summary, budgetUsd: null, switches: { waiting: 0 }, agents: { claude: { path: 'terminal', reason: 'native_unavailable',
        next: { path: 'terminal', reason: 'native_unavailable' }, limits: limits.claude, connection: connections.claude },
        codex: { path: null, reason: 'native_unavailable', next: { path: null, reason: 'native_unavailable' }, limits: limits.codex, connection: connections.codex } } };
  });
  for (const name of ['send', 'interrupt', 'stop', 'answer', 'commands', 'settings-set', 'key-save', 'key-clear', 'key-status']) {
    handle(`native:${name}`, () => { throw new Error('原生会话暂不可用，已保留终端模式。'); });
  }
  handle('native:test-connection', (...args) => {
    if (args.length > 1 || args[0] !== undefined && (typeof args[0] !== 'string' || !/^[\w:.-]{1,160}$/.test(args[0]))) throw new Error('无效的原生会话请求。');
    throw new Error('原生会话暂不可用，已保留终端模式。');
  });
}

function registerIpc() {
  const { handle, listen } = createIpcAdapter({ ipcMain, getWindow: () => window, devUrl, t, report });
  if (nativeSessions) nativeSessions.register(handle);
  else registerUnavailableNative(handle);
  if (process.platform === 'darwin') listen('titlebar:state', state => macTitlebar?.update(state));
  registerSkillsIpc({ handle, skills, dialog, getWindow: () => window });
  registerAgentsIpc({ handle, agents, openExternal: url => shell.openExternal(url), getSession: id => sessions.get(id), findProject,
    gradeDelivery: (grade, project, session) => dashboard.grade(grade, project, session),
    readingPage: (id, request) => readingHistory.page(id, request.key, request.cursor),
    // The legacy reply IPC remains inert; no planner relay requests are emitted.
    listAgentCommands, interventions, relayResult() {}, t });
  registerSshIpc({ handle, getSSHInfo, sshAuth, addSSH: input => store.addSSH(input), hasSession: id => sessions.has(id), getSession: id => sessions.get(id),
    startTerminal, setStartupError: (id, message) => startupErrors.set(id, message), broadcast });
  updatesIpc = registerUpdatesIpc({ handle, updateManager, updateSettings: patch => { updateStoreSettings(patch); broadcast(); }, openExternal: url => shell.openExternal(url), getWindow: () => window, dialog, t,
    allowEditorClose, liveTerminalCount, setQuitting: value => { quitting = value; } });
  registerWorkspaceIpc({ handle, publicState, dialog, getWindow: () => window, t, addProject: (folder, name) => {
    const added = store.add(folder, name); projectImageAuto.enqueue(added.project); return added;
  }, getRecentProjects: () => store.recentProjects(), getRecentSSH: () => store.recentSSH(), forgetRecentSSH: (host, folder) => store.forgetSSH(host, folder), clearSSHHistory: () => store.clearSSHHistory(), existsSync: fs.existsSync,
    getRecentEntry: folder => store.recentEntry(folder), forgetRecent: folder => store.forget(folder), clearHistory: () => store.clearHistory(),
    getEditorFile, allowEditorClose, confirmTerminalClose, disposeProjectTerminals, findProject, closeProjectPreviews: id => previewResources.closeProject(id),
    removeProject: id => { projectAccounts.close(id); codexAccounts.closeProject(id); store.remove(id); },
    forgetBranch, broadcast, acknowledgeProject: id => store.acknowledge(id), reorderProjects: ids => store.reorderProjects(ids), reorderTerminals,
    setProjectImage: (id, image, mode) => {
      store.setProjectImage(id, image, mode);
      if (mode === 'auto' && !image) projectImageAuto.enqueue(store.projects.find(project => project.id === id));
    },
    listProjectImageCandidates: folder => projectImageCandidates(folder, 6, store.settings.theme),
    getSettings: () => store.settings, updateStoreSettings,
    clearRestorePlans: () => restorePlans.clear(), chooseVoiceModel: model => voiceManager.choose(model) });
  filesIpc = registerFilesIpc({ handle, listen, findProject, remoteFor, fileOperations, clipboardWrites, clipboard, previewResources, affectsEditor, allowEditorClose, shell,
    getActiveFileTree: () => activeFileTree, setActiveFileTree: value => { activeFileTree = value; }, setActiveTerminal: value => { activeTerminal = value; }, send });
  registerGitIpc({ handle, findProject, projectGit, setBranch, affectsEditor, allowEditorClose, getWindow: () => window, dialog, t });
  registerVoiceIpc({ handle, voiceManager });
  registerEditorIpc({ handle, listen });
  // A new project's card offers Claude Code and Codex, fresh or continuing this folder's latest conversation.
  handle('project:card', (id, file) => fileCard(findProject(id), file, folderOf(id)));
  registerImageIpc({ handle, app, findProject, getSession: id => sessions.get(id), clipboard, nativeImage, isGeneratedImage });
  // The result card's 「保存图片」: a copy of the picture Codex generated on this computer, to where the reader picks. Null when the
  // dialog is dismissed. A picture an SSH project's agent drew stays on that computer; the card does not offer this for it.
  handle('agent:saveImageAs', async file => {
    if (!isGeneratedImage(file) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error('只能保存本机上生成的图片。');
    const picked = await dialog.showSaveDialog(window, saveDialogOptions(file, app.getPath('pictures'), t('图片')));
    if (picked.canceled || !picked.filePath) return null;
    const target = saveTarget(picked.filePath, file);
    await fs.promises.copyFile(file, target);
    return target;
  });
  // A Markdown file an agent wrote outside the project (its memory, a note in a temporary folder), whole, for its popup:
  // only Markdown, read where the project is (this computer, or the SSH computer through its worker).
  handle('agent:document', (id, file) => documentText(previewResources, findProject(id), file));
  // A decision waits on the reader (a permission, a question, a sign-in): with the window in the background, a short
  // notice names the project and what kind of thing it is, never the command or the answers; a click opens the
  // decisions. The window itself shows it on the home page and the count beside its tab.
  handle('decision:notify', (id, title, kind) => {
    const project = findProject(id);
    if (!window || window.isDestroyed() || window.isFocused()) return false;
    window.flashFrame(true); clearTimeout(attentionTimer);
    attentionTimer = setTimeout(() => { if (window && !window.isDestroyed()) window.flashFrame(false); }, 9000);
    attentionTimer.unref?.();
    if (store.settings.notifications && Notification.isSupported()) {
      const note = new Notification({ title: t('{name} · {kind}', { name: project.name, kind: String(kind).slice(0, 20) }), body: String(title).slice(0, 120), icon: path.join(root, 'assets/icon-alert.png'), silent: !store.settings.sound });
      note.on('click', () => { showWindow(); send('decision:show'); });
      note.on('failed', () => {});
      note.show();
    }
    return true;
  });
  handle('agent:history', id => {
    if (findProject(id).kind !== 'ssh') return folderHistory(folderOf(id));
    // A launcher mount is not permission to connect or prompt for an SSH password.
    const saved = store.findTerminal(id).record.restore;
    return { claude: null, codex: saved?.threadId ? { id: saved.threadId } : null };
  });
  handle('agent:launch', async (id, agent, mode) => {
    const project = findProject(id);
    if (!['claude', 'codex'].includes(agent)) throw new Error('无效的助手。');
    if (project.kind === 'ssh' && agent !== 'codex') throw new Error('SSH 原生会话目前仅支持 Codex。');
    if (!['new', 'continue'].includes(mode)) throw new Error('Unsupported agent session mode');
    if (agent === 'codex') {
      if (!nativeSessions) throw new Error('Codex 原生模式连接失败，请重试。');
      launchPlans.delete(id); restorePlans.delete(id);
      // start resolves the saved thread, or queries folder history, only after this click.
      await nativeSessions.start(id, { agent, resume: mode === 'continue' }); broadcast(); return true;
    }
    const history = mode === 'continue' ? (await folderHistory(folderOf(id)))[agent] : null;
    launchPlans.set(id, { agent, command: launchCommand(agent, history), threadId: history?.id || null });
    startTerminal(id, null, true); broadcast(); return true;
  });
  registerNativeIpc({ handle });
  terminalInput = registerTerminalIpc({ handle, listen, findProject, getSession: id => sessions.get(id), hasSession: id => sessions.has(id), startTerminal,
    addTerminal: id => store.addTerminal(id), removeTerminal: id => { store.removeTerminal(id); fs.promises.rm(handoffFile(id), { force: true }).catch(() => {}); }, confirmTerminalClose, forgetRestorePlan: id => restorePlans.delete(id),
    disposeTerminal, clearStartupError: id => startupErrors.delete(id), broadcast, getProjectById: id => store.projects.find(p => p.id === id),
    acknowledgeProject: id => store.acknowledge(id), expectCompletion: id => store.expectCompletion(id), scheduleState, applyActivity, pollAfterSubmission, send,
    getActiveTerminal: () => activeTerminal, setActiveTerminal: value => { activeTerminal = value; }, setActiveFileTree: value => { activeFileTree = value; } });
  registerClipboardIpc({ handle, clipboardWrites, clipboard });
  registerWindowIpc({ handle, listen, getWindow: () => window, requestQuit });
}

if (!app.requestSingleInstanceLock()) {
  console.log(`Agentrix is already running with the profile ${app.getPath('userData')}; its window was brought to the front.`);
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  // Clicking the Dock icon brings back a window that was closed to the menu bar.
  app.on('activate', () => showWindow());
  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && !app.isPackaged && !process.env.AGENTRIX_DATA_DIR) app.dock.setIcon(path.join(root, 'assets/icon-mac.png'));
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    // Before any terminal or agent starts: they inherit the system proxy only through process.env.
    await adoptSystemProxy({ session: electronSession.defaultSession }).catch(error => console.warn('System proxy:', error.message));
    const shellIcon = prepareWindowIcon({ app, shell, root, installed, appUserModelId, relaunchDisplayName });
    const shellIntegration = prepareShellIntegration({ app, integrationDir, agents });
    zshStartup = shellIntegration.startup; shellPathReady = shellIntegration.ready;
    store = new WorkspaceStore(path.join(app.getPath('userData'), 'workspace.json'));
    if (store.settings.restoreSessions && (!process.env.AGENTRIX_DATA_DIR || process.env.AGENTRIX_TEST_RESTORE === '1')) {
      for (const project of store.projects) for (const record of [project, ...(project.terminals || [])]) {
        if (record.restore?.codex === true) void prepareReading(record.id, { ...record.restore, agent: record.restore.agent || 'codex' });
      }
    }
    skills = new SkillsStore({ dataDir: app.getPath('userData'), builtinDir: app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.join(root, 'resources', 'skills'),
      getProjects: () => store.projects, getAgents: () => agents.getState(), activeProjects: () => [...sessions.values()].filter(s => s.codexActive).map(s => s.projectId),
      changed: (infos, { deliveryChanged }) => { send('skills:changed', infos); if (deliveryChanged) refreshSkillNotes(); }, report,
      routingNote: () => routingNote(app.getPath('userData')) });
    skills.syncWatchers();
    projectImageAuto = createProjectImageAuto({
      getProject: id => quitting ? null : store.projects.find(project => project.id === id),
      listCandidates: folder => projectImageCandidates(folder, 1),
      setProjectImage: (id, image, mode) => store.setProjectImage(id, image, mode), broadcast,
    });
    voiceManager = new VoiceManager({ directory: voiceDirectory, model: store.settings.voiceModel, fetcher: (url, options) => electronNet.fetch(url, options), changed: state => send('voice:state', state) });
    // Download the offline model in the background after installation so dictation works on first use.
    // Waits for startup and session restore first; isolated test profiles skip the 239 MB download.
    if (!process.env.AGENTRIX_DATA_DIR) setTimeout(() => { if (!quitting) voiceManager.prepare().catch(() => {}); }, 8000);
    fileOperations = new FileOperations({ integrationDir, cacheRoot: path.join(app.getPath('userData'), 'file-clipboard'), remote: remoteFor, clipboardWrites,
      trash: filename => shell.trashItem(filename),
      confirmDelete: async (project, paths) => (await dialog.showMessageBox(window, { type: 'question', title: t('删除文件'), message: t('删除 {count} 个文件或文件夹？', { count: paths.length }),
        detail: `${paths.slice(0, 5).join('\n')}${paths.length > 5 ? '\n…' : ''}\n\n${project.kind === 'ssh' ? t('远程文件会被永久删除。') : t('本地文件会移入回收站。')}`,
        buttons: [t('取消'), t('删除')], defaultId: 0, cancelId: 0 })).response === 1,
      progress: value => filesIpc.setProgress(value),
    });
    runtimeDir = fs.mkdtempSync(path.join(app.getPath('userData'), 'runtime-'));
    eventServer = await createEventServer(onEvent);
    try { await initializeNativeSessions(); }
    catch {
      try { dispatchControl?.close(); } catch { }
      dispatchControl = null; controlAddress = null; nativeSessions = null;
      store.warning = t('原生会话暂不可用，已保留终端模式。');
    }
    const nativeWarnings = recoveryWarnings(path.join(app.getPath('userData'), 'native-session'), true);
    if (nativeWarnings.length) store.warning = nativeWarnings.map(message => t(message)).join(' ');
    sshAuth = await new SSHAuthServer(queue => send('ssh:auth-changed', queue)).start();
    let menuUpdateReady = false;
    updateManager = new UpdateManager({
      updater: isInstalledBuild(app.isPackaged, process.execPath) ? require('electron-updater').autoUpdater : null,
      channel: store.settings.updateChannel, betaAgreement: store.settings.betaAgreement,
      version: app.getVersion(), distribution: distributionOf({ isPackaged: app.isPackaged, platform: process.platform, installed }), onChange: state => {
        updatesIpc?.onStateChange(state);
        send('updates:changed', state);
        const ready = state.status === 'ready';
        if (ready !== menuUpdateReady) {
          menuUpdateReady = ready;
          rebuildMacMenu();
        }
      },
    });
    registerAppProtocols({ protocol, root, electronNet, previewResources, t });
    registerIpc();
    desktopGlassWindow = store.settings.surface === 'glass' && store.settings.glassBackground === 'desktop' && !!desktopGlassBackend;
    applyNativeTheme();
    window = new BrowserWindow({
      width: 1500, height: 940, minWidth, minHeight,
      title: t('Agentrix'), backgroundColor: windowBackgroundColor(),
      ...(desktopGlassWindow ? desktopGlassOptions(desktopGlassBackend) : {}),
      // macOS keeps its own window buttons over the title bar; Windows draws them in the page.
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 12 } } : { frame: false }),
      show: false, icon: path.join(root, 'assets/icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false },
    });
    macTitlebar = registerMacTitlebar({ window, t, send, broadcast, getShortcuts: () => store.settings.shortcuts });
    if (desktopGlassWindow) {
      try { await applyDesktopGlass(window, runtimeDir, desktopGlassBackend); desktopGlassActive = true; }
      catch { window.setBackgroundColor(windowBackgroundColor()); }
    }
    if (process.platform === 'win32') window.setAppDetails({ appId: appUserModelId, appIconPath: shellIcon, appIconIndex: 0,
      relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${root}"`,
      relaunchDisplayName,
    });
    windowZoom = registerWindowZoom({ window, screen, getZoom: () => store.settings.uiZoom, broadcast });
    dashboardWindow = createDashboard({ app, root, BrowserWindow, ipcMain, devUrl, t, records: dashboard,
      getProjects: () => store.projects, getSettings: () => store.settings, getMainWindow: () => window,
      getUiZoom: () => windowZoom?.percent ?? 100, backgroundColor: windowBackgroundColor });
    syncDashboardLive();
    labWindow = createLab({ app, root, BrowserWindow, ipcMain, devUrl, t, records: dashboard, helper: path.join(integrationDir, 'dispatch.cjs'),
      getProjects: () => store.projects, getSettings: () => store.settings, getMainWindow: () => window,
      getUiZoom: () => windowZoom?.percent ?? 100, backgroundColor: windowBackgroundColor });
    registerWindowContents({ window, Menu, clipboard, previewResources, pictureFrom, devUrl, t,
      getActiveTerminal: () => activeTerminal, getActiveFileTree: () => activeFileTree, getShortcuts: () => store.settings.shortcuts });
    registerWindowLifecycle({ window, getSettings: () => store.settings, isQuitting: () => quitting, hasTray: () => !!tray,
      requestQuit, report, send, updateIndicators, clearAttention: () => clearTimeout(attentionTimer) });
    tray = new Tray(trayImage('icon.png'));
    tray.setToolTip(t('Agentrix'));
    trayMenu();
    tray.on('click', () => showWindow());
    Menu.setApplicationMenu(process.platform === 'darwin' ? macMenu() : null);
    for (const project of store.projects) captureBranch(project);
    await window.loadURL(devUrl || 'agentrix://app/index.html');
    for (const project of store.projects) projectImageAuto.enqueue(project);
    updateIndicators();
    if (!process.env.AGENTRIX_DATA_DIR) updateManager.start();
    restoreTerminals({ store, restorePlans, startupErrors, startTerminal: restoreTerminal, broadcast, isQuitting: () => quitting });
  }).catch(error => {
    dialog.showErrorBox(t('Agentrix 无法启动'), t(String(error?.stack || error)));
    app.exit(1);
  });
}
app.on('before-quit', event => {
  let nativeDrain;
  // On macOS the Dock's Quit and logging out reach here directly; they ask about running terminals like ⌘Q.
  if (process.platform === 'darwin' && !quitting && window && !window.isDestroyed()) { event.preventDefault(); showWindow(); requestQuit().catch(report); return; }
  if (!quitCleaned) {
    quitCleaned = true;
    dashboardWindow?.dispose();
    labWindow?.dispose();
    clearTimeout(attentionTimer);
    voiceManager?.close(); fileOperations?.cancel();
    skills?.close();
    quitting = true;
    nativeDrain = Promise.allSettled([nativeSessions?.close(), claudeRuntime?.close()]);
    updateManager?.dispose();
    projectAccounts.close();
    codexAccounts.dispose();
    claudeAccounts.dispose();
    disposeClaudeAccounts();
    clearTimeout(usageRolloverTimer);
    clearTimeout(stateTimer);
    for (const id of sessions.keys()) disposeTerminal(id);
    sshAuth?.close();
    eventServer?.close();
    dispatchControl?.close();
    tray?.destroy();
    cleanupAskpass();
    if (runtimeDir) {
      // Only this launch's generated, now-empty runtime directory is removed.
      try { fs.rmdirSync(runtimeDir); } catch { }
    }
  }
  const drains = [dashboard.waitForQuit(), labWindow?.waitForQuit(), nativeDrain].filter(Boolean);
  if (drains.length) {
    event.preventDefault();
    void Promise.allSettled(drains).then(() => app.quit());
  }
});
app.on('window-all-closed', () => { if (quitting) app.quit(); });
