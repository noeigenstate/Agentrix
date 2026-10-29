const { registerWindowIpc } = require('./app/window-ipc.cjs');
const { registerAppSchemes, registerAppProtocols } = require('./app/protocols.cjs');
const { configureApplication, prepareWindowIcon, prepareShellIntegration } = require('./app/platform-startup.cjs');
const { registerWindowContents, registerWindowLifecycle } = require('./app/window-events.cjs');
const { registerWindowZoom } = require('./app/window-zoom.cjs');
const { minWidth, minHeight } = require('./window-zoom.json');
const { createImageTools, registerImageIpc } = require('./app/images.cjs');
const { createProjectHandoff } = require('./app/project-handoff.cjs');
const { createCloseGuards, restoreTerminals } = require('./app/terminal-lifecycle.cjs');
const { registerClipboardIpc } = require('./shared/clipboard-ipc.cjs');
const { registerTerminalIpc } = require('./features/terminal/ipc.cjs');
const { ApprovalGuard, approvalStamp } = require('./features/terminal/approval-guard.cjs');
const { createNativeSession } = require('./features/terminal/native-session.cjs');
const { registerNativeIpc } = require('./features/terminal/native-ipc.cjs');
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
const { registerSkillsIpc } = require('./features/skills/ipc.cjs');
const { SkillsStore } = require('./features/skills/store.cjs');
const { nativeSkillActions } = require('./features/skills/native-actions.cjs');
const { writeFileAtomic } = require('./atomic-write.cjs');
const { folderHistory, launchCommand } = require('./features/agents/launch.cjs');
const { READING_NOTE } = require('./features/agents/reading-note.cjs');
const { writeHandoff, startupNote } = require('./features/agents/handoff.cjs');
const { remember, roundsOf } = require('./features/agents/project-memory.cjs');
const { agentSettings } = require('./features/agents/agent-settings.cjs');
const { UsageMeter, claudeProvider, codexProvider, claudeAccount, claudeAccountFiles } = require('./features/agents/agent-usage.cjs');
const { CodexAccountUsage } = require('./features/agents/codex-account-usage.cjs');
const codexAccounts = new CodexAccountUsage();
const { ClaudeAccountUsage, readClaudeAccount } = require('./features/agents/claude-account-usage.cjs');
const claudeAccounts = new ClaudeAccountUsage({ changed: () => queueClaudeAccounts(), read: options => readClaudeAccount({ ...options,
  routes: localClaudeMeters().map(s => ({ cwd: s.usageCwd, env: s.usageEnv || process.env })),
  fetch: (url, options) => electronNet.fetch(url, options),
}) });
const { agentCommand } = require('./features/agents/agent-command.cjs');
const { setThumbnailer, isGeneratedImage } = require('./conversation.cjs');
const { saveDialogOptions, saveTarget } = require('./image-save.cjs');
const { registerVoiceIpc } = require('./features/voice/ipc.cjs');
const { createIpcAdapter } = require('./shared/ipc.cjs');
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, Notification, clipboard, shell, screen, protocol, session: electronSession, net: electronNet } = require('electron');
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
const { PromptQueue, promptText, promptSummary: summarizeTask } = require('./prompt-queue.cjs');
const { CompletionWork } = require('./completion-work.cjs');
const { createTerminalEnvironment } = require('./terminal-env.cjs');
const { adoptSystemProxy } = require('./system-proxy.cjs');
const { PreviewResources } = require('./preview-resources.cjs');
const { createFileCards, documentText } = require('./features/files/file-cards.cjs');
const { UpdateManager, isInstalledBuild, distributionOf } = require('./updates.cjs');
const { getSSHInfo } = require('./ssh-config.cjs');
const { SSHAuthServer } = require('./ssh-auth.cjs');
const { RemoteConnection } = require('./remote-connection.cjs');
const { recentSession, resumeCommand, claudeResumeCommand } = require('./session-restore.cjs');
const { CodexActivityReader, monitorActivity } = require('./codex-activity.cjs');
const { TerminalTitleTracker, wholeThread } = require('./terminal-title.cjs');
const { FileOperations } = require('./file-operations.cjs');
const { ClipboardWrites } = require('./clipboard-writes.cjs');
const { VoiceManager } = require('./voice.cjs');
const { ActionLog, TranscriptTail, claudeRecord, codexRecord, skillDescription } = require('./agent-actions.cjs');
const { ConversationLog, claudeConversation, codexConversation } = require('./conversation.cjs');
const { conversationBatchDelay, pollAfterSubmission } = require('./conversation-timing.cjs');
const { listAgentCommands, isLocalAgentCommand } = require('./agent-commands.cjs');
const { claudeConfigDir, findClaudeSession, listClaudeSessions } = require('./claude-sessions.cjs');
const { listCodexSessions } = require('./codex-sessions.cjs');
const { AgentsManager, onPath } = require('./agents.cjs');
const { ZSH, linuxShell, shellEnvironment, zshEnvironment, bashArguments, withoutAppImage, terminalLocale } = require('./zsh-terminal.cjs');

const root = path.join(__dirname, '..');
const integrationDir = app.isPackaged ? path.join(process.resourcesPath, 'integration') : path.join(root, 'integration');
const { accountEnvironment } = require(path.join(integrationDir, 'codex-account-scope.cjs'));
const devUrl = !app.isPackaged ? process.env.AGENTRIX_DEV_URL : null;
const { installed, appUserModelId, relaunchDisplayName, voiceDirectory } = configureApplication(app);
registerAppSchemes(protocol);

const { translate } = require('./i18n.cjs');
// Text shown by the main process follows the language chosen in settings (Chinese source -> locales/en.json).
const t = (text, values) => translate(store?.settings.language, text, values);
let window, tray, store, eventServer, sshAuth, updateManager, quitting = false, updatesIpc, projectImageAuto, windowZoom;
const desktopGlassBackend = desktopGlassKind();
let desktopGlassWindow = false, desktopGlassActive = false;
function windowBackgroundColor() { return store.settings.theme === 'light' ? '#f8f9fb' : '#181818'; }
function updateStoreSettings(patch) {
  const { theme, uiZoom } = store.settings;
  store.updateSettings(patch);
  // An active system backdrop needs its transparent ground, including when the theme changes.
  if (theme !== store.settings.theme && window && !window.isDestroyed() && !desktopGlassActive) window.setBackgroundColor(windowBackgroundColor());
  // The settings IPC broadcasts after applying the window's new zoom.
  if (uiZoom !== store.settings.uiZoom) windowZoom?.update();
}
const sessions = new Map();
const { handoffFile, memoryDir, memoryFolder, scrubProjectSkills, sshHandoff } = createProjectHandoff({ app, getStore: () => store, sessions });
const { setBranch, captureBranch, getBranch, forgetBranch, remoteBranch } = createGitRuntime({ getProjects: () => store.projects, execFile, broadcast });
const projectGit = new ProjectGit(id => remoteFor(id));
const startupErrors = new Map();
const restorePlans = new Map();
const previewResources = new PreviewResources({ remote: project => remoteFor(project.id) });
const { thumbnail, small, pictureOf, thumbnailProjectImage, pictureFrom } = createImageTools({ nativeImage, BrowserWindow, previewResources });
async function projectImageCandidates(folder, candidates = 6, theme = 'mono') {
  const result = await listProjectImageCandidates(folder, thumbnailProjectImage, { ...PROJECT_IMAGE_LIMITS, candidates });
  return { ...result, candidates: result.candidates.map(candidate => ({ ...candidate, image: projectSvgForTheme(candidate.image, theme) })) };
}

setThumbnailer(pictureOf, url => thumbnail(nativeImage.createFromDataURL(url)) || url);
const capturePage = require('./features/files/capture-page.cjs').createPageCapture(BrowserWindow);
const fileCard = createFileCards({ previews: previewResources, capture: capturePage, shrink: pictureOf, shrinkBytes: bytes => small(nativeImage.createFromBuffer(bytes)) });
let stateTimer;
let runtimeDir;
const { prepareAskpass, cleanupAskpass } = createSshRuntime({ fs, execFileSync, tempDirectory: () => app.getPath('temp'), integrationDir });
let zshStartup;
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
function publicState() {
  return {
    projects: store.projects.map(p => {
      const opened = terminalIds(p);
      const terminals = shownTerminalIds(p).map(id => {
        const s = sessions.get(id);
        return { id, title: t('终端 {n}', { n: opened.indexOf(id) + 1 }), shell: s?.shellKind || (p.kind === 'ssh' ? 'bash' : localShell().kind), sessionId: s?.sessionId || null, status: s?.status || 'stopped', codexActive: s?.codexActive || false, agent: s?.codexActive ? s.agent || 'codex' : null,
          agentStarting: !!s?.agentStarting && !s.codexActive && s.status !== 'exited' && !s.error,
          agentStartedAt: s?.codexActive ? s.activitySince : null,
          nativeMode: s?.nativeMode || null, nativeApprovals: s?.native?.registry.list() || [], nativeMessages: s?.nativeMessages || [], nativeReady: !!s?.nativeReady,
          // The model, effort and fast mode its records show, above the reading view's message box.
          agentSettings: s?.codexActive ? s.agentSettings || null : null,
          // The service its model is reached through, the context it fills and the tokens it took, for the activity pane.
          agentUsage: s?.codexActive && s.usage ? s.usage.snapshot(s.usageHistory) : null,
          // A run of the CLI that is no conversation (update, --version, login), for the reading view to say so.
          agentCommand: s?.codexActive ? s.agentCommand || null : null,
          codexActivity: s?.codexActivity || 'unknown', needsInput: s?.needsInput?.message || null, shellReady: !!s?.ready && !s?.inputDirty, codexAvailable: s?.codexAvailable ?? null,
          mainTurn: s?.codexActive ? s.completionWork?.mainTurn(s.activitySnapshot) || null : null,
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
    // Linux: the shell new local terminals use and whether zsh is installed, for the choice in Settings.
    localShell: process.platform === 'linux' ? (({ kind, zsh }) => ({ kind, zsh }))(localShell()) : null,
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
  for (const id of [project.id, ...(project.terminals || []).map(item => item.id)]) { restorePlans.delete(id); disposeTerminal(id); startupErrors.delete(id); }
}
function updateIndicators() {
  const unread = store.projects.filter(p => p.unread > 0).length;
  if (window && !window.isDestroyed()) {
    window.setTitle(`${unread ? `(${unread}) ` : ''}${t('Agentrix')}`);
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
  return Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about', label: t('关于 Agentrix') }, { type: 'separator' },
      { role: 'hide', label: t('隐藏 Agentrix') }, { role: 'hideOthers', label: t('隐藏其他') }, { role: 'unhide', label: t('全部显示') }, { type: 'separator' },
      { label: t('退出 Agentrix'), accelerator: 'Command+Q', click: () => { showWindow(); requestQuit().catch(report); } },
    ] },
    { label: t('窗口'), submenu: [
      { role: 'minimize', label: t('最小化') }, { role: 'zoom', label: t('缩放') }, { role: 'togglefullscreen', label: t('切换全屏') },
      { type: 'separator' }, { label: t('关闭窗口'), accelerator: 'Command+W', click: () => window?.close() },
    ] },
  ]);
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
    send('terminal:conversation', latest.size > 40 || changes.some(item => item.reset) ? { id: s.terminalId, list: s.conversation.snapshot() } : { id: s.terminalId, changes: [...latest.values()] });
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
  if (s.usage?.apply(record) && (!s.usageHistory || s.usage.limits !== limits)) { scheduleState(); scheduleUsageRollover(); }
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
  s.claudeFollowRequest = (s.claudeFollowRequest || 0) + 1;
  s.claudeSessionId = event.sessionId;
  s.approval?.context('claude-session', event.sessionId);
  s.usage?.calls.setFolder(remote ? null : path.join(path.dirname(file), event.sessionId, 'subagents'));
  if (s.claudeTranscript?.filename !== file) {
    const onHistory = ready => {
      if (ready) s.conversation.endHistory();
      else { s.conversation.beginHistory(); s.actions.reset(); s.conversation.reset(); s.usage?.reset(true); }
      if (!ready && s.completionWork?.reset()) store.expectCompletion(project.id, false);
      if (s.completionWork) s.completionWork.reading = !ready;
      usageHistory(s, ready);
    };
    s.activitySnapshot = s.activityRawSnapshot = null;
    s.claudeTranscript = remote ? { filename: file } : new TranscriptTail(file, { onHistory, onReset: partial => { if (s.usage?.rates) s.usage.rates.partial = partial; }, onWorkRecord: record => onRecord({ ...record, workOnly: true }) });
    s.activityMonitor?.stop();
    const tail = s.claudeTranscript;
    const onRecord = record => {
      if (sessions.get(s.terminalId) !== s || s.claudeTranscript !== tail) return;
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
      if (!value || sessions.get(s.terminalId) !== s || s.claudeTranscript !== tail || !s.activityMonitor) return null;
      if (value.reset) onHistory(false);
      for (const record of Array.isArray(value.records) ? value.records : []) { try { onRecord(record); } catch { } }
      if (value.historyDone) onHistory(true);
      if (s.completionWork) s.completionWork.reading = !value.historyDone;
      if (s.completionWork && value.completionUncertain) s.completionWork.uncertain = true;
      return s.activityRawSnapshot && { ...s.activityRawSnapshot, workVersion: s.completionWork?.version, transcriptRead: true };
    };
    s.activityMonitor = monitorActivity(async () => {
      if (remote) return s.terminal.request('claude-status', { path: file, since }).then(remoteStatus);
      await tail.read(onRecord);
      if (s.completionWork) {
        s.completionWork.reading = tail.historyPending || tail.offset < tail.fileSize || tail.buffer.length > 0;
        s.completionWork.uncertain ||= tail.workHistory?.uncertain;
      }
      return s.activityRawSnapshot && { ...s.activityRawSnapshot, workVersion: s.completionWork?.version, transcriptRead: true };
    }, snapshot => applyActivity(project, s, snapshot), { interval: () => readEvery(s), watch: () => remote ? null : tail.filename });
  } else void s.activityMonitor?.poll();
}

// Workspace broadcasts can happen while history is still reading: hold a clean snapshot until it finishes.
function usageHistory(s, ready) {
  if (!s.usage) return;
  s.usageHistory = ready ? null : s.usage.snapshot();
  scheduleUsageRollover();
  if (ready) scheduleState();
}

// What the activity pane shows of the model route and the tokens spent. Which service a model is reached through is
// read from this computer's settings; over SSH, Claude's stays unnamed and Codex's is the id its records give.
function startUsage(project, s, event) {
  stopUsageAccount(s);
  s.usageCwd = event.cwd || project.path;
  const usage = s.usage = new UsageMeter(s.agent, { rates: project.kind !== 'ssh', codexHome: event.codexHome || s.codexHome,
    changed: () => { if (s.usage === usage && !s.usageHistory) scheduleState(); } });
  if (s.agent === 'codex') {
    let binding;
    s.bindUsageAccount = () => {
      const next = JSON.stringify([usage.providerId, usage.scopeCwd, event.accountLaunch, event.codexHome || s.codexHome]);
      if (s.usage !== usage || (s.usageAccount && binding === next)) return;
      s.usageAccount?.dispose(); binding = next;
      s.usageAccount = codexAccounts.watch({ codexHome: event.codexHome || s.codexHome, cwd: event.cwd || project.path,
        recordedCwd: usage.scopeCwd, env: s.usageEnv || process.env, provider: usage.providerId,
        remote: project.kind === 'ssh', accountLaunch: event.accountLaunch }, account => {
        if (s.usage === usage && s.codexActive && sessions.get(s.terminalId) === s) { usage.codexAccount(account); scheduleState(); scheduleUsageRollover(); }
      });
    };
    s.bindUsageAccount();
  }
  if (project.kind === 'ssh') return;
  const named = update => { if (s.usage === usage) { update(); scheduleState(); } };
  if (s.agent === 'claude') {
    void claudeProvider(event.cwd || project.path, claudeConfigDir()).then(provider => named(() => { usage.provider = provider; })).catch(() => {});
    void refreshClaudeAccounts();
  } else void codexProvider(event.codexHome || s.codexHome).then(names => named(() => { usage.names = names; })).catch(() => {});
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
      entry.watcher = fs.watch(folder, { persistent: false }, (_event, name) => {
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
    for (const s of localClaudeMeters()) if (s.usage.account(account, claudeAccounts.account)) changed = true;
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

// Restores and the reading-view picker know the id before Claude emits its next prompt hook.
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


// One place turns an agent's turn state into lights and completion alerts, for Codex and Claude alike.
function applyActivity(project, s, snapshot) {
  if (sessions.get(s.terminalId) !== s || !s.codexActive) return;
  if (snapshot.updatedAt < (s.activitySince || 0)) return;
  // Readers deduplicate snapshots. Retain even a completion hidden by provisional
  // input so that expiring that submission can replay it without another record.
  if (snapshot.updatedAt >= (s.activityRawSnapshot?.updatedAt || 0)) s.activityRawSnapshot = snapshot;
  if (['complete', 'interrupted'].includes(snapshot.state)) {
    s.completionWork?.end(snapshot.updatedAt);
    s.promptQueue.finish?.(snapshot.updatedAt);
  }
  // Resumed history and a slow response from before a new submission
  // must not make newly running work look complete.
  if (snapshot.updatedAt < (s.activityInputAt || 0)) return;
  s.activitySnapshot = snapshot;
  const queued = s.promptQueue.list?.().some(item => item.state === 'queued') || !!s.conversation?.queue?.length;
  const state = s.completionWork?.state(snapshot, { queued })
    || (queued && snapshot.state === 'complete' ? 'working' : snapshot.state);
  if (snapshot.state === 'interrupted' || state === 'interrupted') store.expectCompletion(project.id, false);
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
  if (!s.codexActive || s.agent !== 'claude' || !['working', 'complete', 'attention', 'session'].includes(event.state)) return;
  if (typeof event.sessionId !== 'string' || !/^[\w-]{1,100}$/.test(event.sessionId) || typeof event.eventId !== 'string' || event.eventId.length > 200) return;
  // Hook eventId is an event identity, not a native approval request ID. A different observed event invalidates
  // actions conservatively, even if its message is identical. Duplicate events leave the epoch alone.
  s.approval?.context('claude-event', [event.sessionId, event.eventId, event.state]);
  if (event.state === 'attention') { s.needsInput = { message: typeof event.message === 'string' ? event.message.slice(0, 300) : '', since: Date.now() }; broadcast(); return; }
  if (event.state === 'session') { followClaude(project, s, event); broadcast(); return; }
  if (s.usage && project.kind !== 'ssh') void refreshClaudeAccounts();
  // Claude Code runs its prompt hooks for some local slash commands (/context, /doctor, /compact) too. They open a screen
  // or print a line and no round follows, so they neither start a round nor end one; the card would stay "working".
  if (event.state === 'working') {
    if (typeof event.prompt === 'string' && promptText(event.prompt, event) === null) return;
    s.claudeLocalCommand = typeof event.prompt === 'string' && isLocalAgentCommand('claude', event.prompt);
    if (s.claudeLocalCommand) return;
    // UserPromptSubmit is actual input, unlike a polled working snapshot or a Stop callback.
    if (s.claudePromptEventId !== event.eventId) {
      s.claudePromptEventId = event.eventId;
      if (promptText(event.prompt, event) !== null) {
        s.activityConfirmedInputAt = Math.max(s.activityConfirmedInputAt || 0, Date.now());
        s.activityInputAt = Math.max(s.activityInputAt || 0, s.activityConfirmedInputAt);
        s.completionWork?.begin(); store.expectCompletion(project.id);
      }
    }
  } else if (event.state === 'complete' && s.claudeLocalCommand) { s.claudeLocalCommand = false; return; }
  s.needsInput = null;
  const turnId = event.eventId.slice(event.sessionId.length + 1);
  // Remember the conversation and whether its turn is still open, so a restart can resume it and continue.
  store.setRestore(s.terminalId, { threadId: event.sessionId, interrupted: event.state === 'working' });
  followClaude(project, s, event);
  const snapshot = { threadId: event.sessionId, turnId: event.state === 'complete' ? turnId : null, state: event.state, updatedAt: Date.now(), prompt: typeof event.prompt === 'string' ? event.prompt.slice(0, 2000) : undefined };
  // Stop can beat the last tool-result write. Read it before granting a completion,
  // and let a newer turn/input win if it started while the read was in flight.
  if (event.state === 'complete' && s.activityMonitor) {
    const promptEvent = s.claudePromptEventId;
    void Promise.resolve(s.activityMonitor.poll()).then(() => {
      if (s.agent !== 'claude' || s.claudeSessionId && s.claudeSessionId !== event.sessionId || s.claudePromptEventId !== promptEvent || s.activityRawSnapshot?.updatedAt > snapshot.updatedAt) return;
      applyActivity(project, s, { ...snapshot, state: s.completionWork?.turn?.state === 'interrupted' ? 'interrupted' : snapshot.state, transcriptRead: true });
    }).catch(() => {});
  } else applyActivity(project, s, snapshot);
}

function onEvent(event) {
  const s = sessions.get(event.projectId);
  if (!s || event.sessionKey !== s.sessionKey) return;
  const project = store.projects.find(p => p.id === s.projectId);
  if (!project) return;
  if (['dispatch-start', 'dispatch-rate', 'dispatch-end'].includes(event.type)) {
    if (require('./features/agents/dispatch-events.cjs').acceptDispatch(s, event)) broadcast();
    return;
  }
  if (event.type === 'agent-activity') { claudeActivity(project, s, event); return; }
  if (event.type !== 'turn-complete' && !acceptShellEvent(s, event)) return;
  s.approval?.context('shell-event', [event.type, event.sequence]);
  if (event.type === 'shell-ready' || event.type === 'shell-prompt') {
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
    s.agentStarting = false;
    // A run of the CLI that is no conversation (codex update, claude --version: agent-command.cjs): the reading view
    // says what it does and shows its output; nothing is handed over, followed or restored for it.
    s.agentCommand = agentCommand(event.agent, event.command);
    if (s.agentCommand) {
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
    s.ready = false;
    s.codexActive = true;
    // A resumed Claude conversation whose transcript is still followed keeps what its records showed.
    if (!keepClaudeHistory) s.agentSettings = null;
    s.status = 'codex';
    s.error = null;
    s.submissions.reset();
    s.codexActivity = 'unknown'; s.activitySince = Date.now(); s.activityInputAt = s.activityConfirmedInputAt = 0;
    s.activitySnapshot = s.activityRawSnapshot = null; s.completionWork?.reset();
    s.activityPromptAt = 0; s.claudePromptEventId = null;
    s.activityClockOffset = Number.isFinite(event.sentAt) ? s.activitySince - event.sentAt : 0;
    if (!keepClaudeHistory) { s.actions.reset(); s.conversation.reset(); s.claudeTranscript = null; s.claudeSessionId = null; }
    s.promptQueue.reset();
    s.agent = event.agent === 'claude' ? 'claude' : 'codex';
    startSkillSession(project, s, event.sequence);
    if (!keepClaudeHistory) { s.activityMonitor?.stop(); s.activityMonitor = null; }
    if (!keepClaudeHistory || !s.usage) startUsage(project, s, event);
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
    // Its records feed the reading view and the activity pane: read here, or, over SSH, read on that computer and
    // sent back compacted with each status (integration/remote-worker.py), with the same history start and end.
    const onHistory = ready => {
      if (ready) s.conversation.endHistory();
      else {
        s.conversation.beginHistory(); s.actions.reset(); s.conversation.reset(); s.usage?.reset(true);
        if (s.completionWork?.reset()) store.expectCompletion(project.id, false);
        s.usage?.resetScope(); s.bindUsageAccount?.();
      }
      if (s.completionWork) s.completionWork.reading = !ready;
      usageHistory(s, ready);
    };
    const onRecord = record => {
      s.completionWork?.record(record, 'codex', project.kind === 'ssh' ? s.activityClockOffset || 0 : 0);
      if (record.workOnly) return;
      codexConversation(s.conversation, record, event.cwd || project.path); describeActions(s, event.cwd || project.path, codexRecord(s.actions, record, event.cwd || project.path));
      noteSettings(s, 'codex', record);
      if (record?.type === 'event_msg' && ['task_complete', 'turn_completed', 'turn_aborted', 'turn_interrupted'].includes(record.payload?.type)) {
        const at = Date.parse(record.timestamp) + (project.kind === 'ssh' ? s.activityClockOffset || 0 : 0);
        s.promptQueue.finish(Number.isFinite(at) ? at : Date.now());
      }
    };
    const remoteStatus = value => {
      if (!value || typeof value !== 'object' || !('snapshot' in value)) return value;
      if (sessions.get(s.terminalId) !== s) return null;
      if (value.reset) onHistory(false);
      for (const record of Array.isArray(value.records) ? value.records : []) { try { onRecord(record); } catch { } }
      if (value.historyDone) onHistory(true);
      if (s.completionWork) s.completionWork.reading = !value.historyDone;
      if (s.completionWork && value.completionUncertain) s.completionWork.uncertain = true;
      return value.snapshot;
    };
    const reader = project.kind === 'ssh' ? null : new CodexActivityReader(event.cwd || project.path, event.codexHome || s.codexHome, s.activitySince, { threadId: () => s.reportedThreadId, requireBinding: () => (project.terminals?.length || 0) > 0, onHistory, onReset: partial => { if (s.usage?.rates) s.usage.rates.partial = partial; }, onRecord, onWorkRecord: record => s.completionWork?.record(record, 'codex') });
    s.activityMonitor = monitorActivity(
      async () => {
        const snapshot = await (reader ? reader.read() : project.terminals?.length && !s.reportedThreadId ? null : s.terminal.request('codex-status', { since: remoteSince, threadId: s.reportedThreadId }).then(remoteStatus));
        if (s.completionWork && reader) {
          s.completionWork.reading = reader.historyPending || reader.offset < reader.fileSize || reader.buffer.length > 0;
          s.completionWork.uncertain ||= reader.workHistory?.uncertain;
        }
        return snapshot && { ...snapshot, workVersion: s.completionWork?.version };
      },
      snapshot => {
        if (!reader) snapshot = { ...snapshot, updatedAt: snapshot.updatedAt + s.activitySince - remoteSince };
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
  if (!(plan.agent === 'claude' ? session.claudeAvailable : session.codexAvailable)) {
    session.error = t('没有找到 {agent}，请在设置 › 编码助手中安装。', { agent: plan.agent === 'claude' ? 'Claude Code' : 'Codex' }); broadcast(); return;
  }
  session.ready = false;
  if (plan.agent === 'claude' && plan.threadId) { session.claudeResumeId = plan.threadId; void followClaudeSession(project, session, plan.threadId); }
  session.gate.afterPrompt(plan.command);
  broadcast();
}

async function resumeAfterPrompt(project, session) {
  const plan = restorePlans.get(session.terminalId);
  if (!plan || !session.ready || session.inputDirty) return;
  restorePlans.delete(session.terminalId);
  const restore = store.findTerminal(session.terminalId)?.record.restore;
  // Claude Code resumes its own conversation, here or on the terminal's SSH channel.
  if (restore?.agent === 'claude') {
    if (!session.claudeAvailable || !plan.codex) return;
    try {
      const command = claudeResumeCommand(restore);
      if (sessions.get(session.terminalId) !== session || !session.ready || session.inputDirty || session.codexActive) return;
      store.expectCompletion(project.id, restore.interrupted === true);
      session.ready = false;
      session.claudeResumeId = restore.threadId || null;
      if (project.kind === 'ssh') session.gate.input(command); else session.gate.afterPrompt(command);
      // Remote SessionStart hooks bind the server transcript; never search this computer for that path.
      if (restore.threadId && project.kind !== 'ssh') await followClaudeSession(project, session, restore.threadId);
      broadcast();
    } catch (error) { session.error = `恢复会话失败：${error.message}`; broadcast(); }
    return;
  }
  if (!session.codexAvailable) return;
  try {
    const info = project.kind === 'ssh' ? await session.terminal.request('resume-info', { threadId: restore?.threadId }) : await recentSession(restore?.cwd || project.path, session.codexHome, restore?.threadId);
    // Legacy versions did not record which process owned a conversation. Open
    // that history, but do not submit work to a possibly still-running session.
    const remembered = info || (restore?.threadId ? { id: restore.threadId, state: 'unknown' } : null);
    const command = project.terminals?.length && !restore?.threadId ? 'codex\r' : resumeCommand(remembered && !plan.codex ? { ...remembered, state: 'unknown' } : remembered, plan.codex);
    if (command && sessions.get(session.terminalId) === session && session.ready && !session.inputDirty && !session.codexActive) {
      // Opening completed history is not new input. Only the automatic
      // continuation of interrupted work may produce another completion alert.
      store.expectCompletion(project.id, info?.state === 'interrupted' && plan.codex);
      session.ready = false;
      // The prompt has not been drawn yet; a remote shell asks no question to wait for.
      if (project.kind === 'ssh') session.gate.input(command); else session.gate.afterPrompt(command);
      broadcast();
    }
  } catch (error) { session.error = `恢复会话失败：${error.message}`; broadcast(); }
}

function remoteFor(id) {
  const project = findProject(id);
  const session = sessions.get(id)?.terminal.connected ? sessions.get(id) : [...sessions.values()].find(item => item.projectId === project.id && item.terminal.connected);
  if (project.kind !== 'ssh' || !session || session.terminal.closed) throw new Error('请先启动终端，连接 SSH 服务器。');
  return session.terminal;
}

// The local shell for a new terminal: PowerShell or Command Prompt on Windows, zsh on macOS, and on Linux
// Bash or zsh as chosen in Settings (the login shell's kind until one is chosen).
// Linux looks for the shells again whenever a terminal starts, so one installed meanwhile is used.
let linuxShells = null;
function localShell(fresh = false) {
  if (process.platform === 'darwin') return { kind: 'zsh', file: ZSH };
  if (process.platform !== 'linux') return { kind: store.settings.shell === 'cmd' ? 'cmd' : 'powershell', file: null };
  if (fresh || linuxShells?.choice !== store.settings.shell) linuxShells = { ...linuxShell(store.settings.shell), choice: store.settings.shell };
  return linuxShells;
}

function nativeSessionEvent(id, sessionId, message) {
  const s = sessions.get(id); if (!s || s.sessionId !== sessionId || !s.native) return;
  const project = findProject(id), at = Date.now(), p = message.params;
  const thread = message.method === 'thread/started' ? p?.thread?.id : null;
  if (thread && s.completionWork?.find(thread)) return;
  const next = s.nativeMode === 'claude-sdk' ? message.type === 'system' && message.subtype === 'init' && message.session_id : thread;
  const previous = s.nativeMode === 'claude-sdk' ? s.claudeSessionId : s.reportedThreadId;
  if (next && previous && next !== previous) {
    if (s.completionWork?.reset()) store.expectCompletion(project.id, false);
    s.promptQueue.reset(); s.activitySnapshot = s.activityRawSnapshot = null; s.codexActivity = 'unknown';
  }
  s.completionWork?.native(message, s.agent, at, s.reportedThreadId);
  if (s.nativeMode !== 'claude-sdk' && s.reportedThreadId && p?.threadId && p.threadId !== s.reportedThreadId) return;
  describeActions(s, project.path, nativeSkillActions(s.actions, message, project.path, at));
  const add = (role, text, entryId, provenance = message) => {
    if (typeof text !== 'string' || !text) return;
    // Native user-item replays must retain the original prompt's input watermark.
    if (role === 'user' && (promptText(text, provenance) === null || entryId && s.conversation.list.some(entry => entry.id === entryId))) return;
    s.conversation.put({ id: entryId || randomUUID(), at, role, text: text.slice(0, 20000), original: text });
    if (s.nativeMode === 'claude-sdk') {
      s.nativeMessages = [...s.nativeMessages, { role, text: text.slice(0, 20000) }].slice(-100);
      scheduleState();
    }
  };
  if (message.type === 'managed-ready') { s.nativeReady = true; scheduleState(); }
  if (message.type === 'managed-prompt' && promptText(message.text, message) !== null) {
    s.completionWork?.begin(at);
    add('user', message.text);
    s.activityInputAt = s.activityConfirmedInputAt = at;
    store.expectCompletion(project.id);
    applyActivity(project, s, { threadId: s.claudeSessionId || sessionId, turnId: null, state: 'working', updatedAt: at, prompt: message.text });
  }
  if (s.nativeMode === 'claude-sdk') {
    if (message.session_id) s.claudeSessionId = message.session_id;
    if (message.type === 'assistant') add('assistant', message.message?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n'), message.uuid);
    if (message.type === 'result') {
      if (message.is_error) add('assistant', (message.errors || ['Managed CLI turn failed']).join('\n'));
      applyActivity(project, s, { threadId: s.claudeSessionId || sessionId, turnId: message.uuid || null, state: message.is_error ? 'interrupted' : 'complete', updatedAt: at });
    }
    return;
  }
  if (message.method === 'thread/started' && p?.thread?.id) s.reportedThreadId = p.thread.id;
  if (message.method === 'item/completed' && p?.item) {
    const item = p.item;
    if (item.type === 'agentMessage') add('assistant', item.text, item.id);
    if (item.type === 'userMessage') add('user', item.content?.filter(part => part.type === 'text').map(part => part.text).join('\n'), item.id, { ...message, ...p, ...item });
  }
  if (['turn/started', 'turn/completed', 'turn/interrupted'].includes(message.method) && p?.threadId && p?.turn?.id) {
    // Advance the stale-snapshot guard for the parent, without arming idle or child turns.
    if (message.method === 'turn/started') s.activityInputAt = s.activityConfirmedInputAt = at;
    applyActivity(project, s, { threadId: p.threadId, turnId: p.turn.id, state: message.method === 'turn/started' ? 'working' : message.method === 'turn/interrupted' || p.turn.status === 'interrupted' || p.turn.status === 'failed' ? 'interrupted' : 'complete', updatedAt: at });
  }
}

function startTerminal(id, nativeMode = null, agentStarting = false) {
  const project = findProject(id);
  const old = sessions.get(id);
  if (old && old.status !== 'exited') return;
  if (old) disposeTerminal(id);
  if (!['win32', 'darwin', 'linux'].includes(process.platform)) throw new Error('此版本的终端集成面向 Windows 10/11、macOS 和 Linux。');
  if (project.kind !== 'ssh' && !fs.existsSync(project.path)) throw new Error('项目目录不存在，请重新添加。');
  const sessionId = randomUUID();
  const sessionKey = randomUUID();
  const startPath = restorePlans.get(id)?.cwd || store.findTerminal(id)?.record.restore?.cwd || project.path;
  // Local terminals use the shell chosen in settings (zsh on macOS); SSH projects always run Bash on the server.
  const shell = project.kind === 'ssh' ? { kind: 'bash', file: null } : localShell(true), shellKind = shell.kind;
  const bootstrapFile = project.kind !== 'ssh' ? path.join(runtimeDir, `${sessionId}.json`) : null;
  const skillNoteFile = project.kind === 'ssh' ? null : path.join(runtimeDir, `${sessionId}-skills.txt`);
  if (bootstrapFile) fs.writeFileSync(bootstrapFile, JSON.stringify({
    projectId: id, projectPath: startPath, sessionKey, pipeName: process.platform === 'win32' ? eventServer.name : eventServer.address,
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
    // Every glibc since 2.35 has C.UTF-8; a Linux desktop session normally sets LANG itself.
    locale: process.platform === 'darwin' ? terminalLocale(app.getPreferredSystemLanguages()) : 'C.UTF-8' };
  if (local) env = shellKind === 'zsh' ? zshEnvironment(env, integration) : shellEnvironment(env, integration);
  const sshAskpassPath = project.kind === 'ssh' ? prepareAskpass() : undefined;
  if (nativeMode && project.kind === 'ssh') throw new Error('Native approval sessions are local only');
  const native = nativeMode ? createNativeSession({ binding: { provider: nativeMode === 'claude-sdk' ? 'claude' : 'codex', projectId: project.id, terminalId: id, sessionId },
    mode: nativeMode, cwd: startPath, env, pty, changed: scheduleState,
    event: message => nativeSessionEvent(id, sessionId, message),
  }) : null;
  if (native) {
    env.AGENTRIX_READING_NOTE = startupNote(READING_NOTE, handoffFile(id), path.join(project.path, 'skills'),
      skills.delivery(project, false, sessionId, { agent: nativeMode === 'claude-sdk' ? 'claude' : 'codex', started: true }), path.join(integrationDir, 'dispatch.cjs'));
    writeFileAtomic(skillNoteFile, env.AGENTRIX_READING_NOTE);
  }
  const terminalOptions = { name: 'xterm-256color', cols: 90, rows: 22, cwd: startPath, env,
    ...(!['zsh', 'bash'].includes(shellKind) ? { useConpty: true, useConptyDll: true } : {}) };
  const remoteSkills = project.kind === 'ssh' ? skills.delivery(project, true, sessionId) : null;
  const terminal = native || (project.kind === 'ssh' ? new RemoteConnection({ ...project, id }, { integrationDir, auth: sshAuth, sessionKey, onEvent, codingPath: startPath, askpassPath: sshAskpassPath,
    readingNote: startupNote(READING_NOTE, '{AGENTRIX_HANDOFF}', path.posix.join(project.path, 'skills'), remoteSkills, '{AGENTRIX_DISPATCH}'), skills: remoteSkills.bundle,
    onReady: info => { remoteBranch(project.id, info.branch); },
  }) : shellKind === 'zsh' ? pty.spawn(shell.file, ['-l', '-i'], terminalOptions)
    : shellKind === 'bash' ? pty.spawn(shell.file, bashArguments(integrationDir), terminalOptions)
    : shellKind === 'cmd' ? pty.spawn(cmdPath, ['/D', '/Q', '/K', path.join(integrationDir, 'bootstrap.cmd')], terminalOptions)
    : pty.spawn(powershellPath, ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', path.join(integrationDir, 'bootstrap.ps1')], terminalOptions));
  const s = {
    terminal, terminalId: id, projectId: project.id, sessionId, skillSessionId: nativeMode ? sessionId : null, sessionKey, bootstrapFile, skillNoteFile, skillNote: env.AGENTRIX_READING_NOTE, status: 'starting', agentStarting, ready: false, shellKind,
    // Command Prompt reports its prompts through markers in its output instead of the event pipe.
    usageEnv: project.kind === 'ssh' ? null : { ...env },
    prompts: !native && shellKind === 'cmd' ? new PromptMarkers() : null,
    tools: shellKind === 'cmd' ? { codex: onPath('codex', env), claude: onPath('claude', env) } : null,
    titles: new TerminalTitleTracker(), reportedThreadId: null,
    codexActive: false, codexAvailable: null, seq: 0, chunks: [], bytes: 0, pending: '',
    flushTimer: null, error: null, submissions: new SubmissionTracker(),
    approval: new ApprovalGuard(sessionId), approvalRemote: project.kind === 'ssh',
    native, nativeMode, nativeReady: false, nativeMessages: [],
  };
  if (native) { s.status = 'codex'; s.codexActive = true; s.agent = nativeMode === 'claude-sdk' ? 'claude' : 'codex'; s.activitySince = Date.now(); s.codexActivity = 'unknown'; }
  s.actions = new ActionLog(change => publishAction(s, change));
  s.gate = new InputGate(data => {
    if (sessions.get(id) !== s || s.status === 'exited') return;
    if (!isTerminalResponse(data)) s.approval.invalidate();
    terminal.write(data);
  }, { shellOwnsInput: () => !s.codexActive });
  const refreshCompletion = () => {
    if (sessions.get(id) === s && s.codexActive && s.activitySnapshot) applyActivity(project, s, s.activitySnapshot);
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
        if (inputAt !== undefined && !s.native) {
          s.activityConfirmedInputAt = Math.max(s.activityConfirmedInputAt || 0, inputAt);
          s.activityInputAt = Math.max(s.activityInputAt || 0, s.activityConfirmedInputAt);
        }
      }
      // Recalled prompts, custom slash commands and command-line prompts are not always visible to the key
      // tracker. Codex's received user message confirms them. A time watermark excludes history and replays;
      // working/completion snapshots alone can never grant another alert. Claude has UserPromptSubmit hooks.
      if (s.agent === 'codex' && !localCommand && at >= Math.max(s.activitySince || 0, s.activityInputAt || 0) && at > Math.max(s.activityPromptAt || 0, s.lastCompletedAt || 0)) {
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
        s.reportedThreadId = threadId;
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
  terminal.onExit(({ exitCode }) => {
    if (sessions.get(id) !== s) return;
    flush();
    s.native?.registry.close();
    endSkillSession(s);
    skills.endSession(project.id, sessionId);
    if (skillNoteFile) fs.rmSync(skillNoteFile, { force: true });
    stopUsageAccount(s);
    s.status = 'exited'; s.ready = false; s.codexActive = false;
    s.activityMonitor?.stop(); s.activityMonitor = null; s.codexActivity = 'unknown';
    if (s.completionWork.reset()) store.expectCompletion(project.id, false);
    s.activitySnapshot = s.activityRawSnapshot = null;
    restorePlans.delete(id);
    if (terminal.error || exitCode) s.error = terminal.error || t('终端已退出（代码 {code}）。', { code: exitCode });
    if (!quitting && !exitCode) store.setRestore(id, { terminal: false, codex: false });
    if (bootstrapFile) fs.rmSync(bootstrapFile, { force: true });
    broadcast();
  });
  captureBranch(project);
  broadcast();
}

function disposeTerminal(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  endSkillSession(s);
  skills.endSession(s.projectId, s.sessionId);
  s.native?.registry.close();
  stopUsageAccount(s);
  clearTimeout(s.flushTimer); clearTimeout(s.actionTimer); clearTimeout(s.conversationTimer);
  for (const timer of s.submissionPolls || []) clearTimeout(timer);
  s.activityMonitor?.stop(); s.gate.dispose(); s.promptQueue.reset(); s.completionWork?.reset();
  try { s.terminal.kill(); } catch { }
  if (s.bootstrapFile) fs.rmSync(s.bootstrapFile, { force: true });
  if (s.skillNoteFile) fs.rmSync(s.skillNoteFile, { force: true });
}

function registerIpc() {
  const { handle, listen } = createIpcAdapter({ ipcMain, getWindow: () => window, devUrl, t, report });
  registerSkillsIpc({ handle, skills, dialog, getWindow: () => window });
  registerAgentsIpc({ handle, agents, openExternal: url => shell.openExternal(url), getSession: id => sessions.get(id), findProject,
    getRestoreCwd: id => store.findTerminal(id)?.record.restore?.cwd, listClaudeSessions, listCodexSessions, followClaudeSession, listAgentCommands, t });
  registerSshIpc({ handle, getSSHInfo, sshAuth, addSSH: input => store.addSSH(input), hasSession: id => sessions.has(id), getSession: id => sessions.get(id),
    startTerminal, setStartupError: (id, message) => startupErrors.set(id, message), broadcast });
  updatesIpc = registerUpdatesIpc({ handle, updateManager, openExternal: url => shell.openExternal(url), getWindow: () => window, dialog, t,
    allowEditorClose, liveTerminalCount, setQuitting: value => { quitting = value; } });
  registerWorkspaceIpc({ handle, publicState, dialog, getWindow: () => window, t, addProject: (folder, name) => {
    const added = store.add(folder, name); projectImageAuto.enqueue(added.project); return added;
  }, getRecentProjects: () => store.recentProjects(), getRecentSSH: () => store.recentSSH(), forgetRecentSSH: (host, folder) => store.forgetSSH(host, folder), clearSSHHistory: () => store.clearSSHHistory(), existsSync: fs.existsSync,
    getRecentEntry: folder => store.recentEntry(folder), forgetRecent: folder => store.forget(folder), clearHistory: () => store.clearHistory(),
    getEditorFile, allowEditorClose, confirmTerminalClose, disposeProjectTerminals, findProject, closeProjectPreviews: id => previewResources.closeProject(id),
    removeProject: id => store.remove(id), forgetBranch, broadcast, acknowledgeProject: id => store.acknowledge(id), reorderProjects: ids => store.reorderProjects(ids), reorderTerminals,
    setProjectImage: (id, image, mode) => {
      store.setProjectImage(id, image, mode);
      if (mode === 'auto' && !image) projectImageAuto.enqueue(store.projects.find(project => project.id === id));
    },
    listProjectImageCandidates: folder => projectImageCandidates(folder, 6, store.settings.theme),
    getSettings: () => store.settings, updateStoreSettings,
    rebuildMenus: () => { trayMenu(); if (process.platform === 'darwin') Menu.setApplicationMenu(macMenu()); },
    clearRestorePlans: () => restorePlans.clear(), chooseVoiceModel: model => voiceManager.choose(model) });
  filesIpc = registerFilesIpc({ handle, listen, findProject, remoteFor, fileOperations, clipboardWrites, clipboard, previewResources, affectsEditor, allowEditorClose, shell,
    getActiveFileTree: () => activeFileTree, setActiveFileTree: value => { activeFileTree = value; }, setActiveTerminal: value => { activeTerminal = value; }, send });
  registerGitIpc({ handle, findProject, projectGit, setBranch, affectsEditor, allowEditorClose, getWindow: () => window, dialog, t });
  registerVoiceIpc({ handle, voiceManager });
  registerEditorIpc({ handle, listen });
  // A new project's card offers Claude Code and Codex, fresh or continuing this folder's latest conversation.
  const folderOf = id => store.findTerminal(id)?.record.restore?.cwd || findProject(id).path;
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
  handle('agent:history', id => findProject(id).kind === 'ssh' ? { claude: null, codex: null } : folderHistory(folderOf(id)));
  handle('agent:launch', async (id, agent, mode) => {
    const project = findProject(id);
    if (!['claude', 'codex'].includes(agent)) throw new Error('无效的助手。');
    if (project.kind === 'ssh') throw new Error('SSH 项目请先启动终端，再在终端里运行助手。');
    if (mode === 'native') {
      const current = sessions.get(id);
      if (current && current.status !== 'exited') throw new Error('Start a native session in a new or stopped terminal');
      launchPlans.delete(id); restorePlans.delete(id);
      startTerminal(id, agent === 'claude' ? 'claude-sdk' : 'codex-native'); broadcast(); return true;
    }
    if (!['new', 'continue'].includes(mode)) throw new Error('Unsupported agent session mode');
    const history = mode === 'continue' ? (await folderHistory(folderOf(id)))[agent] : null;
    launchPlans.set(id, { agent, command: launchCommand(agent, history), threadId: history?.id || null });
    startTerminal(id, null, true); broadcast(); return true;
  });
  registerNativeIpc({ handle, findProject, getSession: id => sessions.get(id) });
  registerTerminalIpc({ handle, listen, findProject, getSession: id => sessions.get(id), hasSession: id => sessions.has(id), startTerminal,
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
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    // Before any terminal or agent starts: they inherit the system proxy only through process.env.
    await adoptSystemProxy({ session: electronSession.defaultSession }).catch(error => console.warn('System proxy:', error.message));
    const shellIcon = prepareWindowIcon({ app, shell, root, installed, appUserModelId, relaunchDisplayName });
    zshStartup = prepareShellIntegration({ app, integrationDir, agents });
    store = new WorkspaceStore(path.join(app.getPath('userData'), 'workspace.json'));
    skills = new SkillsStore({ dataDir: app.getPath('userData'), builtinDir: app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.join(root, 'resources', 'skills'),
      getProjects: () => store.projects, getAgents: () => agents.getState(), activeProjects: () => [...sessions.values()].filter(s => s.codexActive).map(s => s.projectId),
      changed: (infos, { deliveryChanged }) => { send('skills:changed', infos); if (deliveryChanged) refreshSkillNotes(); }, report });
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
    sshAuth = await new SSHAuthServer(queue => send('ssh:auth-changed', queue)).start();
    updateManager = new UpdateManager({
      updater: isInstalledBuild(app.isPackaged, process.execPath) ? require('electron-updater').autoUpdater : null,
      version: app.getVersion(), distribution: distributionOf({ isPackaged: app.isPackaged, platform: process.platform, installed }), onChange: state => {
        updatesIpc?.onStateChange(state);
        send('updates:changed', state);
      },
    });
    registerAppProtocols({ protocol, root, electronNet, previewResources, t });
    registerIpc();
    desktopGlassWindow = store.settings.surface === 'glass' && store.settings.glassBackground === 'desktop' && !!desktopGlassBackend;
    window = new BrowserWindow({
      width: 1500, height: 940, minWidth, minHeight,
      title: t('Agentrix'), backgroundColor: windowBackgroundColor(),
      ...(desktopGlassWindow ? desktopGlassOptions(desktopGlassBackend) : {}),
      // macOS keeps its own window buttons over the title bar; Windows draws them in the page.
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 12 } } : { frame: false }),
      show: false, icon: path.join(root, 'assets/icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false },
    });
    if (desktopGlassWindow) {
      try { await applyDesktopGlass(window, runtimeDir, desktopGlassBackend); desktopGlassActive = true; }
      catch { window.setBackgroundColor(windowBackgroundColor()); }
    }
    if (process.platform === 'win32') window.setAppDetails({ appId: appUserModelId, appIconPath: shellIcon, appIconIndex: 0,
      relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${root}"`,
      relaunchDisplayName,
    });
    windowZoom = registerWindowZoom({ window, screen, getZoom: () => store.settings.uiZoom, broadcast });
    registerWindowContents({ window, Menu, clipboard, previewResources, pictureFrom, devUrl, t,
      getActiveTerminal: () => activeTerminal, getActiveFileTree: () => activeFileTree, getShortcuts: () => store.settings.shortcuts });
    registerWindowLifecycle({ window, getSettings: () => store.settings, isQuitting: () => quitting, hasTray: () => !!tray,
      requestQuit, report, send, clearAttention: () => clearTimeout(attentionTimer) });
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
    restoreTerminals({ store, restorePlans, startupErrors, startTerminal, broadcast, isQuitting: () => quitting });
  }).catch(error => {
    dialog.showErrorBox(t('Agentrix 无法启动'), t(String(error?.stack || error)));
    app.exit(1);
  });
}
app.on('before-quit', event => {
  // On macOS the Dock's Quit and logging out reach here directly; they ask about running terminals like ⌘Q.
  if (process.platform === 'darwin' && !quitting && window && !window.isDestroyed()) { event.preventDefault(); showWindow(); requestQuit().catch(report); return; }
  clearTimeout(attentionTimer);
  voiceManager?.close(); fileOperations?.cancel();
  skills?.close();
  quitting = true;
  updateManager?.dispose();
  codexAccounts.dispose();
  claudeAccounts.dispose();
  disposeClaudeAccounts();
  clearTimeout(usageRolloverTimer);
  clearTimeout(stateTimer);
  for (const id of sessions.keys()) disposeTerminal(id);
  sshAuth?.close();
  eventServer?.close();
  tray?.destroy();
  cleanupAskpass();
  if (runtimeDir) {
    // Only this launch's generated, now-empty runtime directory is removed.
    try { fs.rmdirSync(runtimeDir); } catch { }
  }
});
app.on('window-all-closed', () => { if (quitting) app.quit(); });
