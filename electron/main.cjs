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
const { createCloseGuards, createTerminalLifecycle, restoreTerminals } = require('./app/terminal-lifecycle.cjs');
const { registerClipboardIpc } = require('./shared/clipboard-ipc.cjs');
const { registerTerminalIpc } = require('./features/terminal/ipc.cjs');
const { ApprovalGuard, approvalStamp } = require('./features/terminal/approval-guard.cjs');
const { registerNativeIpc } = require('./features/terminal/native-ipc.cjs');
const { createSwitchHost } = require('./features/terminal/switch-host.cjs');
const { createShellEvents } = require('./features/terminal-events/shell-events.cjs');
const { createClaudeActivity } = require('./features/terminal-events/claude-activity.cjs');
const { writeBootstrap, removeBootstrap, updateBootstrapBackground, updateBootstrapLead, updateBootstrapMode, updateDispatchSeats, updateDispatchLaunchSeats } = require('./features/terminal-events/bootstrap-file.cjs');
const { refreshRemoteRouting } = require('./features/ssh/routing.cjs');
const { claudeBackgroundEnvironment } = require('./shared/claude-background.cjs');
const { createHookServer } = require('./features/terminal-events/hook-server.cjs');
const { createHookIngest } = require('./features/terminal-events/hook-ingest.cjs');
const { terminalHooks, reportHookChannel, startHookLaunch } = require('./features/terminal-events/hook-channel.cjs');
const { createNativeHost } = require('./features/native-session/host.cjs');
const { createNativeSessions, createNativeUsage } = require('./features/native-session/index.cjs');
const { createHostInputs } = require('./features/native-session/host-inputs.cjs');
const { createProjectAccounts } = require('./features/native-session/project-accounts.cjs');
const { inspectClaudeExecutable, resolveClaudeExecutable } = require('./features/claude-sdk/executable.cjs');
const { createLocator } = require('./features/claude-runtime/locator.cjs');
const { recoveryWarnings, readJson: readNativeJson, writeJson: writeNativeJson } = require('./features/native-session/storage.cjs');
const { netRequest, apiEnvironment, listModels } = require('./features/claude-sdk/index.cjs');
const { adapterOf, legacyRestoreAgent, support } = require('./features/cli-adapters/registry.cjs');
const { createSdkLoader } = require('./features/claude-sdk/runtime.cjs');
const { registerClaudeWorker } = require('./features/native-session/worker.cjs');
const { createWorkerTerminals } = require('./features/worker-terminals/worker-terminals.cjs');
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
const { SkillsStore, probeCodex, probeClaude } = require('./features/skills/store.cjs');
const { writeFileAtomic } = require('./atomic-write.cjs');
const { folderHistory, launchCommand } = require('./features/agents/launch.cjs');
const { READING_NOTE } = require('./features/agents/reading-note.cjs');
const { writeHandoff, startupNote, startupNoteFields } = require('./features/agents/handoff.cjs');
const { writeSeatMap } = require('./features/agents/call-seat.cjs');
const { remember, roundsOf } = require('./features/agents/project-memory.cjs');
const { agentSettings } = require('./features/agents/agent-settings.cjs');
const { createDispatchIntake } = require('./features/agents/dispatch-intake.cjs');
const { UsageMeter, claudeProvider, codexProvider, claudeAccount, claudeAccountFiles, readClaudeAccountCache } = require('./features/agents/agent-usage.cjs');
const { AgentCalls } = require('./features/agents/agent-calls.cjs');
const { sameDirectory } = require('./session-files.cjs');
const { DashboardRecords, quotaScope } = require('./features/dashboard/records.cjs');
const { createDashboard } = require('./features/dashboard/index.cjs');
const { createLab } = require('./features/lab/index.cjs');
const { routingNote } = require('./features/dashboard/decisions.cjs');
const { CodexAccountUsage, resetCreditMessage } = require('./features/agents/codex-account-usage.cjs');
const { createRpc: createResetRpc } = require('./features/codex-app-server/rpc.cjs');
const { createCodexLocator } = require('./features/codex-runtime/locator.cjs');
const { scanDrives, fixedDrives } = require('./features/codex-runtime/drive-scan.cjs');
// One Codex locator for the terminal, native mode, the account reads and the settings (codex-runtime/BOUNDARY.md). They
// all run the file it found in main's environment; a terminal is told where that file was found. When its fast search
// finds nothing it scans the local drives in the background (never the temporary folder), keeps a hit, or when it
// found none, the time, for the next start, and tells the settings. An isolated profile (AGENTRIX_DATA_DIR) never
// scans: its PATH keeps it from this machine's real Codex, and a scan would not.
const codexHitFile = () => path.join(app.getPath('userData'), 'codex-location.json');
let offerCodexSandboxSetup;
const codexLocator = createCodexLocator({ scan: process.env.AGENTRIX_DATA_DIR ? null
  : async walk => scanDrives({ ...walk, drives: await fixedDrives(process.env), skipPaths: [process.env.TEMP, process.env.TMP, os.tmpdir()] }),
  store: { read: () => readNativeJson(codexHitFile(), null), write: value => writeNativeJson(codexHitFile(), value) },
  changed: () => {
    agents.changed();
    if (codexLocator.peek()?.file) void offerCodexSandboxSetup?.();
  } });
const codexExecutable = () => codexLocator.locate().then(found => found.file);
const codexAccounts = new CodexAccountUsage({ read: options => adapterOf('codex').usage.accountReader({ ...options, resolveExecutable: codexExecutable }),
  resetClient: { rpcFactory: createResetRpc, resolveExecutable: codexExecutable }, resetStorage: {
  read: () => readNativeJson(path.join(app.getPath('userData'), 'codex-reset-attempts.json'), null),
  write: value => writeNativeJson(path.join(app.getPath('userData'), 'codex-reset-attempts.json'), value),
}, audit: event => {
  const file = path.join(app.getPath('userData'), 'codex-reset-events.json');
  const previous = readNativeJson(file, []);
  writeNativeJson(file, [...(Array.isArray(previous) ? previous : []), event].slice(-500));
} });
const projectAccounts = createProjectAccounts({ codex: codexAccounts, readClaude: readClaudeAccountCache });
const { ClaudeAccountUsage } = require('./features/agents/claude-account-usage.cjs');
const claudeAccounts = new ClaudeAccountUsage({ changed: () => queueClaudeAccounts(), read: options => adapterOf('claude').usage.accountReader({ ...options,
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
const { createGeneratedImages, remoteImage } = require('./features/generated-images/generated-images.cjs');
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
const { AgentsManager, claudeState, codexState, onPath } = require('./agents.cjs');
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
let window, tray, store, eventServer, hookServer, sshAuth, updateManager, quitting = false, updatesIpc, projectImageAuto, windowZoom, dashboardWindow = null, labWindow = null, quitCleaned = false;
let macTitlebar = null;
const desktopGlassBackend = desktopGlassKind();
let desktopGlassWindow = false, desktopGlassActive = false;
function windowBackgroundColor() { return store.settings.theme === 'light' ? '#f8f9fb' : '#181818'; }
// A first launch (no workspace file) follows this; read before applyNativeTheme, which overrides it on macOS.
function systemTheme() { try { return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'; } catch { return 'light'; } }
// macOS draws its own window parts (the full-screen title strip, menus, dialogs) in the system appearance unless given the theme's.
function applyNativeTheme() { if (process.platform === 'darwin') nativeTheme.themeSource = store.settings.theme === 'light' ? 'light' : 'dark'; }
function updateStoreSettings(patch) {
  const { theme, uiZoom, language, shortcuts, claudeBackgroundTasks } = store.settings || {};
  store.updateSettings(patch);
  if (claudeBackgroundTasks !== store.settings?.claudeBackgroundTasks) for (const session of sessions.values()) {
    if (session.bootstrapFile) {
      void Promise.resolve(updateBootstrapBackground(session.bootstrapFile, store.settings?.claudeBackgroundTasks)).catch(error => report(error));
    }
    const remote = session.remoteConnection || (session.terminal instanceof RemoteConnection ? session.terminal : null);
    remote?.setBackgroundTasks?.(store.settings?.claudeBackgroundTasks).catch(error => report(error));
  }
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
  const transcript = adapterOf(restore?.agent)?.transcript, session = sessions.get(id);
  if (project.kind === 'ssh' || !transcript || !/^[\w-]{1,100}$/.test(restore?.threadId || '')) return Promise.resolve();
  return readingHistory.bind(id, { agent: restore.agent, threadId: restore.threadId,
    cwd: session?.agentCwd || restore.cwd || store.findTerminal(id)?.record.restore?.cwd || project.path,
    home: transcript.terminalHome?.(session) ?? transcript.home(), filename });
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
const shrinkBytes = bytes => small(nativeImage.createFromBuffer(bytes));
const fileCard = createFileCards({ previews: previewResources, capture: capturePage, shrink: pictureOf, shrinkBytes });
const generatedImages = createGeneratedImages({ findProject, remoteFor: id => remoteFor(id), preview: generatedPreview, shrinkBytes, translate: t });
let stateTimer;
let runtimeDir;
let nativeSessions, claudeRuntime, dispatchControl, controlAddress, terminalInput;
const nativeSpecs = new Map();
const seatModelRuntimes = { codex: new Set(), claude: new Set() };
const { prepareAskpass, cleanupAskpass } = createSshRuntime({ fs, execFileSync, tempDirectory: () => app.getPath('temp'), integrationDir });
let zshStartup;
let shellPathReady = Promise.resolve();
// The first looks for Claude Code and Codex, started as soon as the app is ready; terminals restored at start-up wait for both.
let claudeFirst = Promise.resolve(), codexFirst = Promise.resolve();
let activeTerminal = null;
let activeFileTree = null;
let fileOperations, filesIpc;
let voiceManager;
let skills;
let attentionTimer;
const { allowEditorClose, affectsEditor, getEditorFile, registerEditorIpc } = createEditorGuard({ getWindow: () => window, showWindow, send, randomUUID, dialog, t });
const { confirmTerminalClose, requestQuit, liveTerminalCount } = createCloseGuards({ app, dialog, getWindow: () => window,
  sessions, findProject, allowEditorClose, t, setQuitting: value => { quitting = value; } });
// The modules carved out of main read the app shell through `host` on every call, the way main's own functions read
// its scope, so its late values (the store, the event server, the native runtime) are current. Their functions join
// it, which is how they reach each other.
const host = {
  sessions, nativeSpecs, projectAccounts, claudeAccounts, codexAccounts, randomUUID, send, broadcast, scheduleState, findProject,
  launchCommand, callsOf, prepareReading, usageHistory, noteSettings, describeActions, notifyCompletion,
  noteClaudeFastMode: echo => {
    try { store.recordClaudeFastMode(echo); } catch (error) { report(error); }
  },
  refreshClaudeAccounts, localClaudeMeters, checkClaude, codexExecutable, memoryFolder, memoryDir, scrubProjectSkills, remember, roundsOf,
  summarizeTask, promptText, isLocalAgentCommand, rememberClaudeSource, claudeConfigDir, findClaudeSession, TranscriptTail, claudeRecord,
  claudeConversation, monitorActivity, createTerminalEnvironment, withoutAppImage, writeBootstrap, startupNote, READING_NOTE,
  handoffFile, integrationDir,
  dispatchRefused: ({ code, id }) => console.warn('Dispatch event refused:', code, id || ''),
  get store() { return store; }, get quitting() { return quitting; }, get eventServer() { return eventServer; },
  get controlAddress() { return controlAddress; }, set controlAddress(value) { controlAddress = value; },
  get claudeRuntime() { return claudeRuntime; }, set claudeRuntime(value) { claudeRuntime = value; }, get terminalInput() { return terminalInput; },
  get shellPathReady() { return shellPathReady; }, get readEvery() { return readEvery; }, get launchPlans() { return launchPlans; },
  get runtimeDir() { return runtimeDir; }, get skills() { return skills; },
  accountEnvironment, ActionLog, adapterOf, AgentCalls, app, ApprovalGuard, approvalStamp, bashArguments, captureBranch, claudeResumeCommand,
  codexLocator, CompletionWork, ConversationLog, dashboard, endSkillSession, fs, InputGate, isTerminalResponse, legacyRestoreAgent, linuxShell,
  macShell, onPath, os, path, prepareAskpass, PromptMarkers, PromptQueue, pty, publishAction, publishConversation, quotaScope,
  readingHistory, remoteBranch, RemoteConnection, removeBootstrap, restorePlans, shellEnvironment, startupErrors,
  startupNoteFields, stopUsageAccount, SubmissionTracker, syncDashboardLive, t, terminalHooks, terminalLocale, TerminalTitleTracker, wholeThread,
  writeFileAtomic, writeHandoff, zshEnvironment,
  get claudeFirst() { return claudeFirst; },
  get claudeLocator() { return claudeLocator; }, get cmdPath() { return cmdPath; }, get codexFirst() { return codexFirst; },
  get hookServer() { return hookServer; }, get nativeSessions() { return nativeSessions; }, set nativeSessions(value) { nativeSessions = value; },
  get powershellPath() { return powershellPath; },
  get sshAuth() { return sshAuth; }, get zshStartup() { return zshStartup; },
  acceptShellEvent, agentCommand, bindRemoteClaudeAccount, CodexActivityReader, codexConversation, codexRecord, createNativeUsage,
  reportHookChannel, sshHandoff, startHookLaunch, startSkillSession, startUsage,
  claudeBackgroundEnvironment, createNativeSessions, createSdkLoader, electronNet, folderHistory, folderOf, generatedImages,
  inspectClaude, listAgentCommands, netRequest, registerClaudeWorker, resolveClaudeExecutable, seatModelRuntimes, support, updateBootstrapLead,
  updateDispatchLaunchSeats, updateDispatchSeats, writeSeatMap,
  get workerTerminals() { return workerTerminals; },
  get dispatchControl() { return dispatchControl; }, set dispatchControl(value) { dispatchControl = value; },
  loadDispatchControl: () => import('./features/agents/dispatch-control.cjs'),
  loadTeamLocator: () => require('./features/team/team-locate.cjs'),
  loadDispatchRegistration: () => require('./features/agents/dispatch-registration.cjs'),
  get safeStorage() { return require('electron').safeStorage; },
  createRemoteCodexProcess: remote => require('./features/ssh/codex-process.cjs').createRemoteCodexProcess(remote),
  roleResultServer: (runId, folder) => require(path.join(integrationDir, 'role-artifacts.cjs')).roleResultServer(path.join(integrationDir, 'dispatch.cjs'), runId, folder),
};
Object.assign(host, createClaudeActivity(host), createSwitchHost(host), createHostInputs(host), createDispatchIntake(host));
Object.assign(host, createTerminalLifecycle(host), createShellEvents(host), createNativeHost(host));
const { initializeNativeSessions, registerUnavailableNative, tellMode, tellRemoteRouting, takeModeNote } = host;
const { onEvent } = host;
const { firstLooksSettled, remoteFor, localShell, restoreTerminal, startTerminal, disposeTerminal, cleanupTerminalFiles } = host;
const { followClaudeSession, publishCliState, applyActivity, claudeActivity, claudeHook, acceptDispatchEvent, clearDispatchAccount, bindDispatchInbox, disposeDispatchInbox } = host;
const { localSwitchSessions, observeSwitchTerminal, retainAgentState, prepareSwitchTerminal, retireTerminal, activateNative } = host;
const { readNativeConnections, readNativeSubscriptionLimits, readNativeUsageInputs, connectionSpec, nativeEnvironment, nativeSpec } = host;
const clipboardWrites = new ClipboardWrites();
const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cmdPath = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
function send(channel, data) { if (window && !window.isDestroyed()) window.webContents.send(channel, data); }
// One Claude Code locator for the terminal and the native path (claude-runtime/BOUNDARY.md).
const claudeLocator = createLocator();
// A local terminal lead's Claude workers, each in a hidden terminal of its own, never in `sessions` (worker-terminals/BOUNDARY.md).
const workerTerminals = createWorkerTerminals({ spawn: (file, args, options) => pty.spawn(file, args, options), send, cmdPath, powershellPath,
  screenMonitoring: true,
  allowBackgroundTasks: () => store.settings?.claudeBackgroundTasks,
  claudeFile: () => claudeLocator.peek()?.terminal?.path || null, runtimeDir: () => runtimeDir, claudeHome: () => claudeConfigDir(),
  // Only a Claude terminal lead's own environment: a terminal that switched to a native session since registration has none.
  parent: run => { const s = sessions.get(run.projectId); return s?.usageEnv && s.agent === 'claude' && !s.nativeStructured ? { env: s.usageEnv, sessionKey: s.sessionKey, bootstrapFile: s.bootstrapFile } : null; },
  calls: run => { const s = sessions.get(run.projectId), project = s && store.findTerminal(run.projectId)?.project; return project ? callsOf(s, project) : null; },
  hooks: ({ terminalId, sessionKey, env, cwd }) => terminalHooks({ port: hookServer?.port, terminalId, sessionKey, eventServer, env, cwd, workerPermission: true,
    shell: { posix: process.platform !== 'win32', powershellPath, script: path.join(integrationDir, 'claude-hook.ps1'), node: process.execPath,
      helper: path.join(integrationDir, 'agent-event.cjs') } }) });
const agents = new AgentsManager({ onChange: state => send('agents:changed', state), translate: t,
  claude: () => claudeLocator.peek(), refreshClaude: () => checkClaude('refresh'), codex: () => codexLocator.peek(), refreshCodex: () => checkCodex('scan') });
// The CLI the native path runs, from the locator. `mode`: 'locate' only stats what it chose; 'refresh' (start-up, the
// connection test, an install) reads the stored Windows PATH and searches again; 'focus' does that at most once a
// minute. The agents' state is told again whenever what it says of Claude Code changed.
async function inspectClaude(mode) {
  const seen = () => { const found = claudeLocator.peek(); return found && JSON.stringify(claudeState(found)); };
  const before = seen();
  try { return await inspectClaudeExecutable({ locator: claudeLocator, fresh: mode !== 'locate', throttled: mode === 'focus' }); }
  finally { if (seen() !== before) agents.changed(); }
}
// Codex is searched again like Claude Code ('refresh' or 'focus'; 'scan', after the user installed, also scans the
// drives at once when nothing is found), and the agents' state told when what it says changed.
async function checkCodex(mode) {
  const seen = () => { const found = codexLocator.peek(); return found && JSON.stringify(codexState(found)); };
  const before = seen();
  try { return await codexLocator.refresh(undefined, { throttled: mode === 'focus', scan: mode === 'scan' }); }
  finally { if (seen() !== before) agents.changed(); }
}
// The runtime numbers each CLI check: a stale one comes back as the newer result and changes nothing.
function checkClaude(mode = 'locate') {
  const check = inspectClaude(mode);
  return claudeRuntime?.trackCli?.(check) ?? check;
}
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
        const reading = !s?.nativeStructured && !s?.error && !startupErrors.has(id) && (s?.cliActive || !s?.inputDirty && (restorePlans.has(id) || s?.agentStarting)) ? readingHistory.summary(id) : null;
        const usage = s?.nativeStructured ? s.nativeUsage?.snapshot(s.calls?.snapshot()) || dispatchedOnly(s)
          : s?.cliActive && s.usage ? s.usage.snapshot(s.usageHistory) : dispatchedOnly(s);
        return { id, title: t('终端 {n}', { n: opened.indexOf(id) + 1 }), shell: s?.shellKind || (p.kind === 'ssh' ? 'bash' : localShell().kind), sessionId: s?.nativeStructured ? null : s?.sessionId || null, status: s?.status || 'stopped', cliActive: s?.cliActive || false, agent: s?.cliActive ? s.agent || 'codex' : null,
          ...(reading ? { readingHistory: reading } : {}),
          agentStarting: !!s?.agentStarting && !s.cliActive && s.status !== 'exited' && !s.error,
          agentStartedAt: s?.cliActive ? s.activitySince : null,
          nativeMode: s?.nativeMode || null, nativeRuntimeSessionId: s?.nativeRuntimeSessionId || null, nativePathReason: s?.nativePathReason || null, switchState: s?.switchState || null,
          // The model, effort and fast mode its records show, above the reading view's message box.
          agentSettings: s?.cliActive ? s.agentSettings || null : null,
          // The service its model is reached through, the context it fills and the tokens it took, for the activity pane.
          agentUsage: s?.calls?.usage(usage) || usage,
          // A run of the CLI that is no conversation (update, --version, login), for the reading view to say so.
          agentCommand: s?.cliActive ? s.agentCommand || null : null,
          codexActivity: s?.completionWork?.reading ? 'working' : s?.codexActivity || 'unknown', needsInput: s?.needsInput?.message || null, shellReady: !!s?.ready && !s?.inputDirty, codexAvailable: s?.codexAvailable ?? null,
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
      const activity = activeCodex.some(item => item.codexActivity === 'working') ? 'working' : activeCodex.some(item => item.codexActivity === 'interrupted') ? 'interrupted' : activeCodex.length && activeCodex.every(item => item.codexActivity === 'complete') ? 'complete' : 'unknown';
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
  if (s.usage?.agent === agent) s.usage.facet?.terminal?.refreshOnRecord?.(s, record);
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
  if (remote) {
    const note = startupNote(READING_NOTE, '{AGENTRIX_HANDOFF}', path.posix.join(project.path, 'skills'), delivery, '{AGENTRIX_DISPATCH}');
    void s.terminal.request('skill-note', { sequence, note, skills: delivery.bundle }).then(paths => {
      if (s.terminal.info) s.terminal.info.skills = paths;
    }).catch(report);
  } else {
    const note = startupNoteFields(READING_NOTE, handoffFile(s.terminalId), path.join(project.path, 'skills'), delivery);
    writeFileAtomic(s.skillNoteFile, note.full);
    if (s.bootstrapFile) writeFileAtomic(s.bootstrapFile + '.launch-note', note.launch);
    s.skillNote = note.full;
  }
}

function endSkillSession(s) {
  skills.endSession(s.projectId, s.skillSessionId);
  s.skillSessionId = null;
}

// Wrappers reread idle shells' notes. Running agents keep the note actually delivered at their launch.
function refreshSkillNotes() {
  const remoteWrites = [];
  for (const s of sessions.values()) {
    if (s.status === 'exited') continue;
    const project = store.projects.find(project => project.id === s.projectId);
    if (!project) continue;
    const lead = s.nativeStructured && nativeSessions && skills.leadOptions(project.id, s.agent);
    // A running terminal conductor reads its seats once; a change rides its next prompt, as a mode switch does.
    if (!s.nativeStructured && s.agent === 'claude' && s.cliActive && project.kind !== 'ssh') {
      const change = skills.routingChange(project.id, s.sessionId, s.toldSeats);
      if (change) { s.toldSeats = change.table; s.routingNote = change.note; }
    }
    if (lead) nativeSessions.applyRouting(s.terminalId, { model: lead.model, effort: lead.effort, fast: lead.fast === true }).catch(report);
    if (project.kind === 'ssh') {
      const remote = s.remoteConnection || s.terminal;
      if (remote?.request && !remote.closed) {
        const lead = s.nativeStructured ? null : skills.terminalLead(project.id, { remote: true });
        const routing = skills.seatsInfo(project.id);
        const refresh = { ...(lead ?? { seatsMap: skills.dispatchSeats(project.id) ?? {} }), conductor: routing?.conductor === true };
        const update = refreshRemoteRouting(remote, refresh, routing, {
          bound: () => sessions.get(s.terminalId) === s && (s.remoteConnection || s.terminal) === remote,
          changed: modeChanged => { tellRemoteRouting(s, project, remote, modeChanged); send('skills:changed', skills.infos()); },
          failed: () => report(new Error(t('远程请求失败。'))),
        });
        if (update) remoteWrites.push(update);
      }
      continue;
    }
    if (s.bootstrapFile) {
      try {
        updateDispatchSeats(s.bootstrapFile, skills.dispatchSeats(project.id) ?? {});
        if (updateBootstrapMode(s.bootstrapFile, skills.seatsInfo(project.id)?.conductor) && s.cliActive) tellMode(s, project);
      } catch (error) { report(error); }
      if (s.skillNoteFile || lead && adapterOf(s.agent)?.terminal?.hookSession) {
        try { updateBootstrapLead(s.bootstrapFile, s.nativeStructured ? lead : skills.terminalLead(project.id)); } catch (error) { report(error); }
      }
    }
    if (!s.skillNoteFile || s.cliActive) continue;
    const note = startupNoteFields(READING_NOTE, handoffFile(s.terminalId), path.join(project.path, 'skills'),
      skills.delivery(project, false, s.sessionId, { agent: 'claude' }));
    if (note.full !== s.skillNote) {
      writeFileAtomic(s.skillNoteFile, note.full);
      if (s.bootstrapFile) writeFileAtomic(s.bootstrapFile + '.launch-note', note.launch);
      s.skillNote = note.full;
    }
  }
  return remoteWrites.length ? Promise.allSettled(remoteWrites) : null;
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
  const id = s.terminalId;
  const calls = s.calls || AgentCalls.forTerminal(sessions, id, () => {
    const helperPids = new WeakMap(), current = () => sessions.get(id);
    return new AgentCalls({ terminalId: id, changed: () => scheduleState(), finished: s.recordRun, local: project.kind !== 'ssh',
      roles: () => (current()?.remoteConnection || current()?.terminal)?.appliedRouting?.roles ?? skills?.sessionRoles?.(project.id) ?? null,
      dispatchAlive: async call => {
        if (project.kind === 'ssh') return null;
        let pid = call.helperPid || helperPids.get(call);
        if (!pid || call.done) {
          try {
            const team = await require('./features/team/team-locate.cjs').locateTeam(project.path);
            if (!team || !/^[a-f\d-]{36}$/i.test(call.key)) return null;
            const file = path.join(team.board, call.key + '.json');
            if (fs.statSync(file).size > 65536) return null;
            const { readBoard } = require('./features/team/inbox.cjs');
            const entry = readBoard(fs.readFileSync(file, 'utf8'));
            if (entry?.id !== call.key || path.resolve(entry.cwd) !== path.resolve(call.cwd)) return null;
            pid = entry.pid; helperPids.set(call, pid);
          } catch (error) { return call.done && error.code === 'ENOENT' ? false : null; }
        }
        return AgentCalls.alive(pid);
      },
      codexHome: () => current()?.codexHome || current()?.usageEnv?.CODEX_HOME || path.join(os.homedir(), '.codex'),
      claudeHome: () => current()?.usageEnv?.CLAUDE_CONFIG_DIR || claudeConfigDir(),
      feedChanged: event => { if (current()?.calls === calls) send('terminal:subagent-feed', { terminalId: id, ...event }); } });
  });
  if (s.nativeStructured && calls.setFolder === AgentCalls.prototype.setFolder) {
    const setFolder = calls.setFolder.bind(calls);
    // Keep this guard when the native tracker returns to a terminal host, including trackers retained from an earlier terminal.
    calls.setFolder = folder => { if (!sameDirectory(folder, calls.folder)) setFolder(folder); };
  }
  return s.calls = calls;
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
  const policy = usage.facet?.terminal;
  policy?.bind?.(s, project, event, { bindCodexAccount });
  if (project.kind === 'ssh') {
    policy?.bindRemote?.(s, { bindRemoteClaudeAccount });
    return;
  }
  const named = update => { if (s.usage === usage) { update(); scheduleState(); } };
  policy?.bindLocal?.({ cwd: s.usageCwd, codexHome: event.codexHome || s.codexHome }, {
    loadClaudeProvider: cwd => void claudeProvider(cwd, claudeConfigDir()).then(provider => named(() => { usage.provider = provider; })).catch(() => {}),
    loadCodexProviders: home => void codexProvider(home).then(names => named(() => { usage.names = names; })).catch(() => {}),
    refreshClaudeAccounts,
  });
}
function bindCodexAccount(project, s, event) {
  const usage = s.usage;
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
      if (s.usage === usage && s.cliActive && sessions.get(s.terminalId) === s) {
        s.terminalAccount = account;
        usage.codexAccount(account); s.recordQuota?.('codex', usage.limits); scheduleState(); scheduleUsageRollover();
        if (account.atLimit && !s.nativeStructured) void resetTerminalCodex(project, s, options);
      }
    });
  };
  s.bindUsageAccount();
}
async function resetTerminalCodex(project, s, options) {
  const usage = s.usage;
  const current = () => sessions.get(s.terminalId) === s && s.agent === 'codex' && s.usage === usage && s.cliActive && nativeSessions?.getSettings().codexAutoReset === true;
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
  }, { current: () => s.usage === usage && s.cliActive && s.agent === 'claude' && sessions.get(s.terminalId) === s });
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
  return [...sessions.values()].filter(s => s !== skip && s.cliActive && s.agent === 'claude' && s.usage?.agent === 'claude' &&
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
    if (s === skip || !s.cliActive || store.projects.find(p => p.id === s.projectId)?.kind === 'ssh') continue;
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
      for (const s of sessions.values()) if (s.cliActive && s.usage?.agent === 'codex') s.usageAccount?.refresh();
      void refreshClaudeAccounts();
    }
    scheduleUsageRollover();
  }, Math.min(next - now, 2147483647));
  usageRolloverTimer.unref?.();
}

// The agent chosen on a new project's card, typed at its terminal's first prompt (see agent:launch).
const launchPlans = new Map();

function registerIpc() {
  const { handle, listen } = createIpcAdapter({ ipcMain, getWindow: () => window, devUrl, t, report });
  if (nativeSessions) nativeSessions.register(handle);
  else registerUnavailableNative(handle);
  if (process.platform === 'darwin') listen('titlebar:state', state => macTitlebar?.update(state));
  registerSkillsIpc({ handle, skills, dialog, getWindow: () => window, claudeFastRefusal: () => store.claudeFastMode?.reason });
  workerTerminals.register({ handle, listen });
  registerAgentsIpc({ handle, agents, openExternal: url => shell.openExternal(url), getSession: id => sessions.get(id), findProject,
    routingOwned: projectId => skills.routingOwned(projectId),
    gradeDelivery: (grade, project, session) => dashboard.grade(grade, project, session),
    readingPage: (id, request) => readingHistory.page(id, request.key, request.cursor),
    // The legacy reply IPC remains inert; no planner relay requests are emitted.
    listAgentCommands, interventions, relayResult() {}, t });
  handle('agents:callFile', (terminalId, callId, kind) => {
    if (typeof terminalId !== 'string' || !terminalId || terminalId.length > 160) return { ok: false, code: 'refused' };
    if (store.findTerminal(terminalId)?.project.kind !== 'local') return { ok: false, code: 'unavailable' };
    return AgentCalls.forTerminal(sessions, terminalId)?.callFile(callId, kind) ?? { ok: false, code: 'unavailable' };
  });
  registerSshIpc({ handle, getSSHInfo, sshAuth, addSSH: input => store.addSSH(input), hasSession: id => sessions.has(id), getSession: id => sessions.get(id),
    startTerminal, setStartupError: (id, message) => startupErrors.set(id, message), broadcast });
  updatesIpc = registerUpdatesIpc({ handle, updateManager, updateSettings: patch => { updateStoreSettings(patch); broadcast(); }, openExternal: url => shell.openExternal(url), getWindow: () => window, dialog, t,
    allowEditorClose, liveTerminalCount, setQuitting: value => { quitting = value; } });
  registerWorkspaceIpc({ handle, publicState, dialog, getWindow: () => window, t, addProject: (folder, name) => {
    const added = store.add(folder, name); projectImageAuto.enqueue(added.project); return added;
  }, getRecentProjects: () => store.recentProjects(), getRecentSSH: () => store.recentSSH(), forgetRecentSSH: (host, folder) => store.forgetSSH(host, folder), clearSSHHistory: () => store.clearSSHHistory(), existsSync: fs.existsSync,
    getRecentEntry: folder => store.recentEntry(folder), forgetRecent: folder => store.forget(folder), clearHistory: () => store.clearHistory(),
    getEditorFile, allowEditorClose, confirmTerminalClose, disposeProjectTerminals, findProject, closeProjectPreviews: id => previewResources.closeProject(id),
    removeProject: id => { projectAccounts.close(id); codexAccounts.closeProject(id); clearDispatchAccount(id); store.remove(id); },
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
  const remoteProjectImage = (id, file) => remoteImage(remoteFor(id), file);
  registerImageIpc({ handle, app, findProject, getSession: id => sessions.get(id), clipboard, nativeImage, isGeneratedImage, remoteImage: remoteProjectImage });
  // The result card's 「保存图片」: a copy of the picture Codex generated, to where the reader picks. Null when the dialog is
  // dismissed. A picture an SSH project's agent drew is read back over its connection first, as for showing it.
  handle('agent:saveImageAs', async (file, projectId) => {
    const remote = typeof projectId === 'string' && findProject(projectId).kind === 'ssh';
    if (!isGeneratedImage(file) || !remote && !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error('只能保存 Codex 生成的图片。');
    const bytes = remote ? await remoteProjectImage(projectId, file) : null;
    const picked = await dialog.showSaveDialog(window, saveDialogOptions(file, app.getPath('pictures'), t('图片')));
    if (picked.canceled || !picked.filePath) return null;
    const target = saveTarget(picked.filePath, file);
    await (bytes ? fs.promises.writeFile(target, bytes) : fs.promises.copyFile(file, target));
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
    const project = findProject(id), adapter = adapterOf(agent);
    if (!adapter) throw new Error('无效的助手。');
    if (!['new', 'continue'].includes(mode)) throw new Error('Unsupported agent session mode');
    if (adapter.terminal?.redirect === 'native') {
      if (!nativeSessions) throw new Error('Codex 原生模式连接失败，请重试。');
      launchPlans.delete(id); restorePlans.delete(id);
      // start resolves the saved thread, or queries folder history, only after this click.
      await nativeSessions.start(id, { agent, resume: mode === 'continue' }); broadcast(); return true;
    }
    // Claude Code on another computer keeps its own conversations: it is asked to continue, never searched for here.
    const history = mode === 'continue' && project.kind !== 'ssh' ? (await folderHistory(folderOf(id)))[agent] : null;
    const command = project.kind === 'ssh' && mode === 'continue' && adapter.terminal?.resumeLine ? adapter.terminal.resumeLine() : launchCommand(agent, history);
    launchPlans.set(id, { agent, command, threadId: history?.id || null });
    startTerminal(id, true); broadcast(); return true;
  });
  registerNativeIpc({ handle });
  terminalInput = registerTerminalIpc({ handle, listen, findProject, getSession: id => sessions.get(id), hasSession: id => sessions.has(id), nativeHost: id => nativeSpecs.has(id), startTerminal,
    fastSettings: { claudeConfigDir, writeFileAtomic },
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
    // Claude Code and Codex are looked for now, again once a macOS or Linux login shell has given its PATH, and when the
    // window comes back at most once a minute, so one installed meanwhile is found without a restart.
    claudeFirst = checkClaude('refresh').catch(() => {});
    codexFirst = checkCodex('refresh').catch(() => {});
    if (process.platform !== 'win32') void shellPathReady.then(() => Promise.all([checkClaude('refresh'), checkCodex('refresh')])).catch(() => {});
    app.on('browser-window-focus', () => { checkClaude('focus').catch(() => {}); checkCodex('focus').catch(() => {}); });
    store = new WorkspaceStore(path.join(app.getPath('userData'), 'workspace.json'), { systemTheme: systemTheme() });
    if (store.settings.restoreSessions && (!process.env.AGENTRIX_DATA_DIR || process.env.AGENTRIX_TEST_RESTORE === '1')) {
      for (const project of store.projects) for (const record of [project, ...(project.terminals || [])]) {
        if (record.restore?.codex === true) void prepareReading(record.id, { ...record.restore, agent: record.restore.agent || 'codex' });
      }
    }
    const probeDirectory = path.join(app.getPath('userData'), 'model-probe');
    fs.mkdirSync(probeDirectory, { recursive: true });
    const liveModels = async family => {
      for (const runtime of seatModelRuntimes[family]) {
        try { await runtime.models(); return true; } catch { /* A closing runtime is not a catalog source. */ }
      }
      return null;
    };
    skills = new SkillsStore({ dataDir: app.getPath('userData'), builtinDir: app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.join(root, 'resources', 'skills'),
      modelProbes: {
        codex: async () => {
          const live = await liveModels('codex');
          if (live || !agents.getState().codex?.installed) return null;
          const { createRpc, stopProcess, workerEnvironment } = await import('./features/codex-app-server/index.cjs');
          return probeCodex({ rpcFactory: createRpc, stop: stopProcess, workerEnvironment, spawn: require('node:child_process').spawn,
            executable: codexExecutable, cwd: probeDirectory, env: process.env });
        },
        claude: async () => {
          const live = await liveModels('claude'); if (live) return null;
          const key = claudeRuntime?.credentials.read();
          let rows = [];
          try { if (agents.getState().claude?.installed) rows = await probeClaude({ loadSdk: createSdkLoader({ packaged: app.isPackaged }), options: {
            cwd: probeDirectory, pathToClaudeCodeExecutable: await resolveClaudeExecutable({ locator: claudeLocator }),
            ...(key ? { env: apiEnvironment(process.env, key) } : {}) } }); } catch { /* The keyed model list is independent of the SDK probe. */ }
          if (key) {
            const listed = await listModels(key, { request: netRequest(electronNet) });
            if (Array.isArray(listed.models)) for (const model of listed.models) if (!rows.some(row => (row.resolvedModel || row.value) === model)) rows.push({ model });
          }
          return rows;
        },
      },
      seatSession: id => {
        const session = sessions.get(id), spec = nativeSpecs.get(id);
        return session && session.status !== 'exited' && session.cliActive
          ? { projectId: session.projectId, sessionId: session.skillSessionId || spec?.sessionId || session.sessionId,
            appliedRouting: (session.remoteConnection || session.terminal)?.appliedRouting } : null;
      },
      getProjects: () => store.projects, getAgents: () => agents.getState(), activeProjects: () => [...sessions.values()].filter(s => s.cliActive).map(s => s.projectId),
      changed: (infos, { deliveryChanged }) => {
        const refreshed = deliveryChanged && refreshSkillNotes();
        send('skills:changed', infos);
        return refreshed;
      }, report,
      routingNote: () => routingNote(app.getPath('userData')) });
    skills.syncWatchers();
    codexFirst.then(() => skills.modelCatalog.refresh('startup')).catch(report);
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
    // A worker terminal's command hooks are its own, taken before any project terminal's (worker-terminals/BOUNDARY.md).
    eventServer = await createEventServer(event => workerTerminals.event(event) || onEvent(event));
    // Claude Code's HTTP hooks (C-2). Without the server, terminals keep command hooks and say why.
    hookServer = await createHookServer(createHookIngest({ keyOf: id => workerTerminals.keyOf(id) ?? sessions.get(id)?.hooks?.key,
      deliver: event => workerTerminals.hook(event) || claudeHook(event), noteOf: takeModeNote })).catch(() => null);
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
    if (process.platform === 'win32') {
      const mainWindow = window;
      mainWindow.once('show', () => {
        const { createSandboxSetup } = require('./features/codex-sandbox-setup/index.cjs');
        offerCodexSandboxSetup = createSandboxSetup({ find: async () => { await codexFirst; return codexExecutable(); },
          cwd: probeDirectory, show: options => dialog.showMessageBox(mainWindow, options), t,
          dismissed: () => store.settings.codexSandboxPromptDismissed,
          dismiss: () => store.updateSettings({ codexSandboxPromptDismissed: true }),
          progress: message => {
            mainWindow.setProgressBar(message ? 2 : -1, { mode: message ? 'indeterminate' : 'none' });
            mainWindow.webContents.send('app:sandbox-progress', message);
          },
          active: () => !quitting && !mainWindow.isDestroyed() });
        void offerCodexSandboxSetup();
      });
    }
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
    await firstLooksSettled();
    restoreTerminals({ store, restorePlans, startupErrors, startTerminal: restoreTerminal, broadcast, isQuitting: () => quitting });
  }).catch(error => {
    dialog.showErrorBox(t('Agentrix 无法启动'), t(String(error?.stack || error)));
    app.exit(1);
  });
}
app.on('before-quit', event => {
  let nativeDrain, workerDrain;
  // On macOS the Dock's Quit and logging out reach here directly; they ask about running terminals like ⌘Q.
  if (process.platform === 'darwin' && !quitting && window && !window.isDestroyed()) { event.preventDefault(); showWindow(); requestQuit().catch(report); return; }
  if (!quitCleaned) {
    quitCleaned = true;
    disposeDispatchInbox();
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
    workerDrain = workerTerminals.closeAll();
    sshAuth?.close();
    eventServer?.close();
    hookServer?.close();
    dispatchControl?.close();
    tray?.destroy();
    cleanupAskpass();
    if (runtimeDir) {
      // Verify the generated directory is directly inside this launch's userData before recursive cleanup.
      try {
        const root = fs.realpathSync(app.getPath('userData')), folder = fs.realpathSync(runtimeDir);
        if (!path.relative(root, path.dirname(folder)) && /^runtime-[a-zA-Z0-9]+$/.test(path.basename(folder)) && !fs.lstatSync(runtimeDir).isSymbolicLink()) {
          fs.rmSync(folder, { recursive: true, force: true });
        }
      } catch { }
    }
  }
  const drains = [dashboard.waitForQuit(), labWindow?.waitForQuit(), nativeDrain, workerDrain].filter(Boolean);
  if (drains.length) {
    event.preventDefault();
    void Promise.allSettled(drains).then(() => app.quit());
  }
});
app.on('window-all-closed', () => { if (quitting) app.quit(); });
