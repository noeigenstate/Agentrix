const { createUsageHost, createCodexServices, createClaudeAccountService, createCliChecks, createModelProbes } = require('./features/agents/usage-host.cjs');
const { registerApplicationIpc } = require('./app/application-ipc.cjs');
const { createPublicState } = require('./app/public-state.cjs');
const { createSessionPresentation } = require('./app/session-presentation.cjs');
const { createWindowHost, createTranslator } = require('./app/window-host.cjs');
const { openMainWindow, loadMainWindow } = require('./app/window-startup.cjs');
const { createProjectPreviews, autoProjectImages } = require('./app/project-previews.cjs');
const { registerQuit, cleanStaleRuntimeFolders, startNativeWithWarnings, startEventServer, startHookServer, workerParent } = require('./app/process-lifecycle.cjs');
const { registerWindowIpc } = require('./app/window-ipc.cjs');
const { registerAppSchemes, registerAppProtocols } = require('./app/protocols.cjs');
const { configureApplication, prepareWindowIcon, prepareShellIntegration } = require('./app/platform-startup.cjs');
const { registerWindowContents, registerWindowLifecycle } = require('./app/window-events.cjs');
const { registerWindowZoom } = require('./app/window-zoom.cjs');
const { registerMacTitlebar } = require('./app/mac-titlebar.cjs');
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
const { adapters, adapterOf, adapterOfModel, bindNativeAdapters, legacyRestoreAgent, support } = require('./features/cli-adapters/registry.cjs');
const { createSdkLoader } = require('./features/claude-sdk/runtime.cjs');
const { registerClaudeWorker, registerAgyWorker } = require('./features/native-session/worker.cjs');
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
const { registerRoutingIpc } = require('./features/routing/ipc.cjs');
const { RoutingStore, probeCodex, probeClaude } = require('./features/routing/store.cjs');
const { writeFileAtomic } = require('./atomic-write.cjs');
const { retryFileOperation } = require('./file-retry.cjs');
const { folderHistory, launchCommand } = require('./features/agents/launch.cjs');
const { READING_NOTE } = require('./features/agents/reading-note.cjs');
const { writeHandoff, startupNote } = require('./features/agents/handoff.cjs');
const { writeSeatMap } = require('./features/agents/call-seat.cjs');
const { remember, roundsOf } = require('./features/agents/project-memory.cjs');
const { agentSettings } = require('./features/agents/agent-settings.cjs');
const { createDispatchIntake, reportDispatchRefusal } = require('./features/agents/dispatch-intake.cjs');
const { UsageMeter, claudeProvider, codexProvider, claudeAccount, claudeAccountFiles, readClaudeAccountCache } = require('./features/agents/agent-usage.cjs');
const { AgentCalls } = require('./features/agents/agent-calls.cjs');
const { sameDirectory } = require('./session-files.cjs');
const { DashboardRecords, quotaScope } = require('./features/dashboard/records.cjs');
const { createDashboard } = require('./features/dashboard/index.cjs');
const { createLab } = require('./features/lab/index.cjs');
const { routingNote } = require('./features/dashboard/decisions.cjs');
const { CodexAccountUsage, resetCreditMessage } = require('./features/agents/codex-account-usage.cjs');
const { createRpc: createResetRpc } = require('./features/codex-app-server/codex-rpc.cjs');
const { createCodexLocator } = require('./features/codex-runtime/locator.cjs');
const { scanDrives, fixedDrives } = require('./features/codex-runtime/drive-scan.cjs');
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
const { pollAfterSubmission } = require('./conversation-timing.cjs');
const { listAgentCommands, isLocalAgentCommand } = require('./agent-commands.cjs');
const { claudeConfigDir, findClaudeSession } = require('./claude-sessions.cjs');
const { AgentsManager, claudeState, codexState, onPath } = require('./agents.cjs');
const { macShell, linuxShell, shellEnvironment, zshEnvironment, bashArguments, withoutAppImage, terminalLocale } = require('./zsh-terminal.cjs');

const { codexLocator, codexExecutable, codexAccounts, projectAccounts } = createCodexServices({
  createCodexLocator, scanDrives, fixedDrives, os, path, app, readNativeJson, writeNativeJson, CodexAccountUsage, adapterOf,
  createResetRpc, createProjectAccounts, readClaudeAccountCache,
  get agents() { return agents; },
  get routing() { return routing; },
});
const { ClaudeAccountUsage } = require('./features/agents/claude-account-usage.cjs');
const claudeAccounts = createClaudeAccountService({ ClaudeAccountUsage, adapterOf, electronNet,
  queueClaudeAccounts: () => queueClaudeAccounts(), localClaudeMeters: () => localClaudeMeters() });
const root = path.join(__dirname, '..');
const integrationDir = app.isPackaged ? path.join(process.resourcesPath, 'integration') : path.join(root, 'integration');
const { accountEnvironment } = require(path.join(integrationDir, 'codex-account-scope.cjs'));
const devUrl = !app.isPackaged ? process.env.AGENTRIX_DEV_URL : null;
const { installed, appUserModelId, relaunchDisplayName, voiceDirectory } = configureApplication(app);
const dashboard = new DashboardRecords(app.getPath('userData'));
registerAppSchemes(protocol);

// Text shown by the main process follows the language chosen in settings (Chinese source -> locales/en.json).
const t = createTranslator(() => store);
setConversationTranslator(t);
let window, tray, store, eventServer, hookServer, sshAuth, updateManager, quitting = false, updatesIpc, projectImageAuto, windowZoom, dashboardWindow = null, labWindow = null;
let macTitlebar = null;
const desktopGlassBackend = desktopGlassKind();
let desktopGlassWindow = false, desktopGlassActive = false;
const sessions = new Map();
const readingHistory = new ReadingHistory(() => { if (window && store && !quitting) broadcast(); });
const { handoffFile, memoryDir, memoryFolder, scrubProjectSkills, sshHandoff } = createProjectHandoff({ app, getStore: () => store, sessions });
const { setBranch, captureBranch, getBranch, forgetBranch, remoteBranch } = createGitRuntime({ getProjects: () => store.projects, execFile, broadcast });
const projectGit = new ProjectGit(id => remoteFor(id));
const startupErrors = new Map();
const restorePlans = new Map();
const { findProject, folderOf, publicState: readPublicState, reorderTerminals, disposeProjectTerminals } = createPublicState({
  app, t, sessions, readingHistory, startupErrors, restorePlans, getBranch, desktopGlassBackend,
  get store() { return store; }, get windowZoom() { return windowZoom; }, get macTitlebar() { return macTitlebar; },
  get desktopGlassActive() { return desktopGlassActive; }, get desktopGlassWindow() { return desktopGlassWindow; },
  get localShell() { return localShell; }, get dispatchedOnly() { return dispatchedOnly; }, get disposeTerminal() { return disposeTerminal; },
});
const previewResources = new PreviewResources({ remote: project => remoteFor(project.id), getProjects: () => store?.projects || [] });
const { thumbnail, small, pictureOf, thumbnailProjectImage, pictureFrom } = createImageTools({ nativeImage, BrowserWindow, previewResources });
const { generatedPreview, projectImageCandidates } = createProjectPreviews({
  isGeneratedImage, fs, path, previewResources, listProjectImageCandidates, PROJECT_IMAGE_LIMITS, projectSvgForTheme, thumbnailProjectImage,
});
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
const seatModelRuntimes = Object.fromEntries(adapters().map(({ manifest: { id } }) => [id, new Set()]));
const { prepareAskpass, cleanupAskpass } = createSshRuntime({ fs, execFileSync, tempDirectory: () => app.getPath('temp'), integrationDir });
let zshStartup;
let shellPathReady = Promise.resolve();
// The first looks for Claude Code and Codex, started as soon as the app is ready; terminals restored at start-up wait for both.
let claudeFirst = Promise.resolve(), codexFirst = Promise.resolve();
let activeTerminal = null;
let activeFileTree = null;
let fileOperations, filesIpc;
let voiceManager;
let routing;
let attentionTimer;
const { prepareReading, publishAction, publishConversation, readEvery, describeActions, startSkillSession, endSkillSession, refreshRoutingNotes } =
  createSessionPresentation({
    findProject, adapterOf, sessions, readingHistory, scheduleState, send, skillDescription, startupNote,
    READING_NOTE, handoffFile, writeFileAtomic, path, report, randomUUID, refreshRemoteRouting, updateDispatchSeats,
    updateBootstrapMode, updateBootstrapLead, t,
    get store() { return store; }, get routing() { return routing; }, get nativeSessions() { return nativeSessions; },
    get tellMode() { return tellMode; }, get tellRemoteRouting() { return tellRemoteRouting; },
  });

const { windowBackgroundColor, systemTheme, applyNativeTheme, updateStoreSettings, updateIndicators, trayImage,
  macMenu, trayMenu, showWindow, notifyCompletion, updateListener } = createWindowHost({
  nativeTheme, nativeImage, app, Menu, Notification, path, root, t, send, updateBootstrapBackground, RemoteConnection, sessions, report,
  get store() { return store; }, get window() { return window; }, get tray() { return tray; }, get updatesIpc() { return updatesIpc; },
  get windowZoom() { return windowZoom; }, get macTitlebar() { return macTitlebar; }, get updateManager() { return updateManager; },
  get desktopGlassActive() { return desktopGlassActive; }, get dashboardWindow() { return dashboardWindow; }, get labWindow() { return labWindow; },
  get requestQuit() { return requestQuit; }, get attentionTimer() { return attentionTimer; }, set attentionTimer(value) { attentionTimer = value; },
});
const { inspectClaude, checkClaude, checkCodex, checkManualInstalls } = createCliChecks({
  adapters, inspectClaudeExecutable, claudeState, codexState, codexLocator, get claudeLocator() { return claudeLocator; },
  get agents() { return agents; }, get claudeRuntime() { return claudeRuntime; },
});
const usageHost = createUsageHost({
  fs, path, agentSettings, UsageMeter, claudeProvider, codexProvider, claudeConfigDir, watchRemoteClaudeAccount, claudeAccount, claudeAccountFiles,
  codexAccounts, claudeAccounts, sessions, scheduleState, resetCreditMessage, t, randomUUID, report,
  get store() { return store; }, get nativeSessions() { return nativeSessions; }, get quitting() { return quitting; }, get callsOf() { return callsOf; },
});
const { startUsage, stopUsageAccount, noteSettings, usageHistory, localClaudeMeters, disposeClaudeAccounts, queueClaudeAccounts,
  refreshClaudeAccounts, bindRemoteClaudeAccount } = usageHost;
const { allowEditorClose, affectsEditor, getEditorFile, registerEditorIpc } = createEditorGuard({ getWindow: () => window, showWindow, send, randomUUID, dialog, t });
const { confirmTerminalClose, requestQuit, liveTerminalCount } = createCloseGuards({ app, dialog, getWindow: () => window,
  sessions, findProject, allowEditorClose, t, setQuitting: value => { quitting = value; } });
// The modules carved out of main read the app shell through `host` on every call, the way main's own functions read
// its scope, so its late values (the store, the event server, the native runtime) are current. Their functions join
// it, which is how they reach each other.
const host = {
  sessions, nativeSpecs, projectAccounts, claudeAccounts, codexAccounts, randomUUID, send, broadcast, scheduleState, findProject,
  launchCommand, prepareReading, usageHistory, noteSettings, describeActions, notifyCompletion,
  noteClaudeFastMode: echo => {
    try { store.recordClaudeFastMode(echo); } catch (error) { report(error); }
  },
  refreshClaudeAccounts, localClaudeMeters, checkClaude, codexExecutable, memoryFolder, memoryDir, scrubProjectSkills, remember, roundsOf,
  summarizeTask, promptText, isLocalAgentCommand, rememberClaudeSource, claudeConfigDir, findClaudeSession, TranscriptTail, claudeRecord,
  claudeConversation, monitorActivity, createTerminalEnvironment, withoutAppImage, writeBootstrap, startupNote, READING_NOTE,
  handoffFile, integrationDir,
  dispatchRefused: reportDispatchRefusal, sameDirectory, get dashboardWindow() { return dashboardWindow; },
  get store() { return store; }, get quitting() { return quitting; }, get eventServer() { return eventServer; },
  get controlAddress() { return controlAddress; }, set controlAddress(value) { controlAddress = value; },
  get claudeRuntime() { return claudeRuntime; }, set claudeRuntime(value) { claudeRuntime = value; }, get terminalInput() { return terminalInput; },
  get shellPathReady() { return shellPathReady; }, get readEvery() { return readEvery; }, get launchPlans() { return launchPlans; },
  get runtimeDir() { return runtimeDir; }, get routing() { return routing; },
  accountEnvironment, ActionLog, adapterOf, adapters, AgentCalls, app, ApprovalGuard, approvalStamp, bashArguments, captureBranch, claudeResumeCommand,
  codexLocator, CompletionWork, ConversationLog, dashboard, endSkillSession, fs, InputGate, isTerminalResponse, legacyRestoreAgent, linuxShell,
  macShell, onPath, os, path, prepareAskpass, PromptMarkers, PromptQueue, pty, publishAction, publishConversation, quotaScope,
  readingHistory, remoteBranch, RemoteConnection, removeBootstrap, restorePlans, retryFileOperation, shellEnvironment, startupErrors,
  stopUsageAccount, SubmissionTracker, t, terminalHooks, terminalLocale, TerminalTitleTracker, wholeThread,
  writeFileAtomic, writeHandoff, zshEnvironment,
  get claudeFirst() { return claudeFirst; },
  get claudeLocator() { return claudeLocator; }, get cmdPath() { return cmdPath; }, get codexFirst() { return codexFirst; },
  get hookServer() { return hookServer; }, get nativeSessions() { return nativeSessions; }, set nativeSessions(value) { nativeSessions = value; },
  get powershellPath() { return powershellPath; },
  get sshAuth() { return sshAuth; }, get zshStartup() { return zshStartup; },
  acceptShellEvent, agentCommand, bindRemoteClaudeAccount, CodexActivityReader, codexConversation, codexRecord, createNativeUsage,
  reportHookChannel, sshHandoff, startHookLaunch, startSkillSession, startUsage,
  claudeBackgroundEnvironment, createNativeSessions, createSdkLoader, electronNet, folderHistory, folderOf, generatedImages,
  inspectClaude, listAgentCommands, netRequest, resolveClaudeExecutable, seatModelRuntimes, support, updateBootstrapLead,
  registerClaudeWorker(options) {
    registerClaudeWorker(options);
    let factory;
    registerAgyWorker({ control: options.control, adapterOf, adapterOfModel, roleResultServer: options.roleResultServer,
      readRoleResult: (folder, id) => require(path.join(integrationDir, 'role-artifacts.cjs')).readRoleResultFile(folder, id),
      env: () => withoutAppImage(process.env),
      runtimeOf: async adapter => {
        const { id } = adapter.manifest;
        factory ??= adapter.native.load();
        const createRuntime = await factory;
        let treeStopFailure;
        const provider = { create(spec, emit) {
          const runtime = createRuntime({ dataDir: app.getPath('userData'), clientVersion: app.getVersion(),
            onTreeStopFailure: error => { treeStopFailure = error; } }).create(spec, emit);
          const close = runtime.close.bind(runtime);
          runtime.close = async () => { await close(); if (treeStopFailure) throw treeStopFailure; };
          return runtime;
        } };
        return bindNativeAdapters({ [id]: provider })(id).native;
      } });
  },
  updateDispatchLaunchSeats, updateDispatchSeats, writeSeatMap,
  get workerTerminals() { return workerTerminals; },
  get dispatchControl() { return dispatchControl; }, set dispatchControl(value) { dispatchControl = value; },
  loadDispatchControl: () => import('./features/agents/dispatch-control.cjs'),
  loadTeamLocator: () => require('./features/team/team-locate.cjs'),
  loadDispatchRegistration: () => require('./features/agents/dispatch-registration.cjs'),
  get safeStorage() { return require('electron').safeStorage; },
  createRemoteCodexProcess: remote => require('./features/ssh/codex-process.cjs').createRemoteCodexProcess(remote),
  createRemoteAgyProcess: (remote, options) => require('./features/ssh/codex-process.cjs').createRemoteAgyProcess(remote, options),
  roleResultServer: (runId, folder) => require(path.join(integrationDir, 'role-artifacts.cjs')).roleResultServer(path.join(integrationDir, 'dispatch.cjs'), runId, folder),
};
Object.assign(host, createClaudeActivity(host), createSwitchHost(host), createHostInputs(host), createDispatchIntake(host));
Object.assign(host, createTerminalLifecycle(host), createShellEvents(host), createNativeHost(host));
const { initializeNativeSessions, registerUnavailableNative, tellMode, tellRemoteRouting, takeModeNote } = host;
const { onEvent, callsOf, dispatchedOnly, resolveIntervention, syncDashboardLive } = host;
const { firstLooksSettled, remoteFor, localShell, restoreTerminal, startTerminal, disposeTerminal, cleanupTerminalFiles } = host;
const { followClaudeSession, publishCliState, applyActivity, claudeActivity, claudeHook, acceptDispatchEvent, clearDispatchAccount, bindDispatchInbox, disposeDispatchInbox } = host;
const { localSwitchSessions, observeSwitchTerminal, retainAgentState, prepareSwitchTerminal, retireTerminal, activateNative } = host;
const { readNativeConnections, readNativeSubscriptionLimits, readNativeUsageInputs, connectionSpec, nativeEnvironment, nativeSpec } = host;
const clipboardWrites = new ClipboardWrites();
const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cmdPath = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
function send(channel, ...args) { if (window && !window.isDestroyed()) window.webContents.send(channel, ...args); }
// One Claude Code locator for the terminal and the native path (claude-runtime/BOUNDARY.md).
const claudeLocator = createLocator();
// A local terminal lead's Claude workers, each in a hidden terminal of its own, never in `sessions` (worker-terminals/BOUNDARY.md).
const workerTerminals = createWorkerTerminals({ spawn: (file, args, options) => pty.spawn(file, args, options), send, cmdPath, powershellPath,
  screenMonitoring: true,
  allowBackgroundTasks: () => store.settings?.claudeBackgroundTasks,
  claudeFile: () => claudeLocator.peek()?.terminal?.path || null, runtimeDir: () => runtimeDir, claudeHome: () => claudeConfigDir(),
  // Only a Claude terminal lead's own environment: a terminal that switched to a native session since registration has none.
  parent: run => workerParent(sessions, run),
  calls: run => { const s = sessions.get(run.projectId), project = s && store.findTerminal(run.projectId)?.project; return project ? callsOf(s, project) : null; },
  hooks: ({ terminalId, sessionKey, env, cwd }) => terminalHooks({ port: hookServer?.port, terminalId, sessionKey, eventServer, env, cwd, workerPermission: true,
    shell: { posix: process.platform !== 'win32', powershellPath, script: path.join(integrationDir, 'claude-hook.ps1'), node: process.execPath,
      helper: path.join(integrationDir, 'agent-event.cjs') } }) });
const agyInstall = adapterOf('agy')?.install;
const agents = new AgentsManager({ onChange: state => send('agents:changed', state), translate: t,
  claude: () => claudeLocator.peek(), refreshClaude: () => checkClaude('refresh'), codex: () => codexLocator.peek(), refreshCodex: () => checkCodex('scan'),
  agy: agyInstall?.peek, refreshAgy: agyInstall?.refresh });
function broadcast() {
  dashboardWindow?.sync();
  syncDashboardLive();
  labWindow?.sync();
  routing?.syncWatchers();
  clearTimeout(stateTimer);
  stateTimer = null;
  updateIndicators();
  send('workspace:changed', publicState());
}
function scheduleState() { if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = null; broadcast(); }, 700); }
function report(error) { send('app:error', String(error?.message || error)); }

function publicState() {
  const pending = store.pendingRolePermissionsNotice;
  return { ...readPublicState(), rolePermissionsNotice: pending && {
    ...pending, message: t('角色现在和总指挥使用同一账号和权限运行，可以联网；提交和推送仍由总指挥负责。'),
  } };
}

const interventions = createInterventions({ resolve: resolveIntervention,
  noteInput: (target, messageId, message) => sessions.get(target.terminalId)?.calls?.ownerInput(target.callId, messageId, message),
  pushControl: (runId, control) => dispatchControl?.pushControl(runId, control),
  sendDirect: async () => { throw new Error('该子代理没有直达控制通道。'); } });
// The agent chosen on a new project's card, typed at its terminal's first prompt (see agent:launch).
const launchPlans = new Map();

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
    const manualInstalls = shellPathReady.then(() => checkManualInstalls()).catch(report);
    if (process.platform !== 'win32') void shellPathReady.then(() => Promise.all([checkClaude('refresh'), checkCodex('refresh')])).catch(() => {});
    app.on('browser-window-focus', () => {
      checkClaude('focus').catch(() => {}); checkCodex('focus').catch(() => {}); checkManualInstalls('focus').catch(report);
    });
    store = new WorkspaceStore(path.join(app.getPath('userData'), 'workspace.json'), { systemTheme: systemTheme(), report });
    if (store.settings.restoreSessions && (!process.env.AGENTRIX_DATA_DIR || process.env.AGENTRIX_TEST_RESTORE === '1')) {
      for (const project of store.projects) for (const record of [project, ...(project.terminals || [])]) {
        if (record.restore?.codex === true) void prepareReading(record.id, { ...record.restore, agent: record.restore.agent || 'codex' });
      }
    }
    const modelProbes = createModelProbes({
      app, path, fs, seatModelRuntimes, agents, adapters, probeCodex, spawn: require('node:child_process').spawn, codexExecutable, report,
      loadCodexProbe: () => import('./features/codex-app-server/index.cjs'),
      probeClaude, createSdkLoader, resolveClaudeExecutable, claudeLocator, apiEnvironment, listModels, netRequest, electronNet,
      get claudeRuntime() { return claudeRuntime; },
    });
    routing = new RoutingStore({ dataDir: app.getPath('userData'), guideFile: path.join(app.isPackaged ? process.resourcesPath : path.join(root, 'resources'), 'routing', 'model-routing.md'),
      modelProbes,
      seatSession: id => {
        const session = sessions.get(id), spec = nativeSpecs.get(id);
        return session && session.status !== 'exited' && session.cliActive
          ? { projectId: session.projectId, sessionId: session.skillSessionId || spec?.sessionId || session.sessionId,
            appliedRouting: (session.remoteConnection || session.terminal)?.appliedRouting } : null;
      },
      getProjects: () => store.projects, getAgents: () => agents.getState(),
      changed: () => {
        const refreshed = refreshRoutingNotes();
        send('routing:changed');
        return refreshed;
      }, report,
      routingNote: () => routingNote(app.getPath('userData')) });
    routing.syncWatchers();
    Promise.all([codexFirst, manualInstalls]).then(() => routing.modelCatalog.refresh('startup')).catch(report);
    projectImageAuto = autoProjectImages({ createProjectImageAuto, store, projectImageCandidates, broadcast, get quitting() { return quitting; } });
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
    cleanStaleRuntimeFolders({ fs, path, retryFileOperation, report: error => console.error('Runtime cleanup:', error) }, app.getPath('userData'), runtimeDir);
    // A worker terminal's command hooks are its own, taken before any project terminal's (worker-terminals/BOUNDARY.md).
    eventServer = await startEventServer({ createEventServer, workerTerminals, onEvent });
    // Claude Code's HTTP hooks (C-2). Without the server, terminals keep command hooks and say why.
    hookServer = await startHookServer({ createHookServer, createHookIngest, workerTerminals, sessions, claudeHook, takeModeNote });
    await startNativeWithWarnings({
      store, start: initializeNativeSessions, report: error => console.error('Native session startup:', error),
      recover: () => recoveryWarnings(path.join(app.getPath('userData'), 'native-session'), true),
      onFailure: () => {
        try { dispatchControl?.close(); } catch (error) { console.error('Dispatch control cleanup:', error); }
        dispatchControl = null; controlAddress = null; nativeSessions = null;
      },
    });
    sshAuth = await new SSHAuthServer(queue => send('ssh:auth-changed', queue)).start();
    updateManager = new UpdateManager({
      updater: isInstalledBuild(app.isPackaged, process.execPath) ? require('electron-updater').autoUpdater : null,
      channel: store.settings.updateChannel, betaAgreement: store.settings.betaAgreement,
      version: app.getVersion(), distribution: distributionOf({ isPackaged: app.isPackaged, platform: process.platform, installed }), onChange: updateListener(),
    });
    registerAppProtocols({ protocol, root, electronNet, previewResources, t });
    const { listen } = createIpcAdapter({ ipcMain, getWindow: () => window, devUrl, t, report });
    listen('app:role-permissions-notice-shown', terminalId => store.acknowledgeRolePermissionsNotice(terminalId));
    registerApplicationIpc({
      createIpcAdapter, ipcMain, devUrl, t, report, registerUnavailableNative, registerRoutingIpc, routing, dialog, store,
      workerTerminals, registerAgentsIpc, agents, shell, sessions, findProject, dashboard, readingHistory, listAgentCommands, interventions,
      registerSshIpc, getSSHInfo, sshAuth, startTerminal, startupErrors, broadcast, registerUpdatesIpc, updateManager, updateStoreSettings,
      allowEditorClose, liveTerminalCount, registerFilesIpc, remoteFor, fileOperations, clipboardWrites, clipboard, previewResources, affectsEditor,
      send, registerGitIpc, projectGit, setBranch, registerVoiceIpc, voiceManager, registerEditorIpc, registerNativeIpc, registerClipboardIpc,
      registerWindowIpc, registerWorkspaceIpc, requestQuit, AgentCalls, publicState, projectImageAuto, fs, getEditorFile, confirmTerminalClose, disposeProjectTerminals,
      projectAccounts, codexAccounts, clearDispatchAccount, forgetBranch, reorderTerminals, projectImageCandidates, restorePlans, fileCard, folderOf,
      remoteImage, registerImageIpc, app, nativeImage, isGeneratedImage, documentText, Notification, path, root, showWindow, saveDialogOptions,
      saveTarget, launchPlans, adapterOf, folderHistory, launchCommand, registerTerminalIpc, nativeSpecs, claudeConfigDir, writeFileAtomic,
      handoffFile, disposeTerminal, scheduleState, applyActivity, pollAfterSubmission,
      get window() { return window; }, get macTitlebar() { return macTitlebar; }, get nativeSessions() { return nativeSessions; },
      get attentionTimer() { return attentionTimer; }, set attentionTimer(value) { attentionTimer = value; },
      set quitting(value) { quitting = value; }, set updatesIpc(value) { updatesIpc = value; }, set filesIpc(value) { filesIpc = value; },
      set terminalInput(value) { terminalInput = value; },
      get activeTerminal() { return activeTerminal; }, set activeTerminal(value) { activeTerminal = value; },
      get activeFileTree() { return activeFileTree; }, set activeFileTree(value) { activeFileTree = value; },
    });
    const windowStartup = {
      store, desktopGlassBackend, desktopGlassOptions, applyDesktopGlass, applyNativeTheme, runtimeDir, registerMacTitlebar,
      t, send, broadcast, appUserModelId, relaunchDisplayName, app, root, registerWindowZoom, screen, createDashboard, BrowserWindow,
      ipcMain, devUrl, dashboard, windowBackgroundColor, syncDashboardLive, createLab, integrationDir, registerWindowContents, Menu,
      clipboard, previewResources, pictureFrom, registerWindowLifecycle, requestQuit, report, updateIndicators,
      showRendererFailure: () => dialog.showErrorBox(t('Agentrix 窗口反复崩溃'), t('已停止自动重载。请退出并重新打开 Agentrix。')),
      Tray, trayImage, trayMenu, showWindow, macMenu, captureBranch,
      get window() { return window; }, set window(value) { window = value; },
      get desktopGlassWindow() { return desktopGlassWindow; }, set desktopGlassWindow(value) { desktopGlassWindow = value; },
      set desktopGlassActive(value) { desktopGlassActive = value; }, set macTitlebar(value) { macTitlebar = value; },
      get windowZoom() { return windowZoom; }, set windowZoom(value) { windowZoom = value; },
      set dashboardWindow(value) { dashboardWindow = value; }, set labWindow(value) { labWindow = value; },
      get tray() { return tray; }, set tray(value) { tray = value; },
      get activeTerminal() { return activeTerminal; }, get activeFileTree() { return activeFileTree; },
      get quitting() { return quitting; }, get attentionTimer() { return attentionTimer; },
    };
    const backdrop = openMainWindow(windowStartup, shellIcon);
    if (backdrop) await backdrop;
    const installPages = new Set(adapters().flatMap(({ manifest: { install } }) =>
      install.commands && install.page.startsWith('https://') ? [install.page] : []));
    if (installPages.size) window.webContents.setWindowOpenHandler(({ url }) => {
      if (installPages.has(url)) void shell.openExternal(url).catch(report);
      return { action: 'deny' };
    });
    await loadMainWindow(windowStartup);
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
registerQuit({
  app, platform: process.platform, showWindow, requestQuit, disposeDispatchInbox, projectAccounts, codexAccounts, claudeAccounts,
  report: error => { console.error('Shutdown cleanup:', error); report(error); },
  disposeClaudeAccounts, sessions, disposeTerminal, workerTerminals, cleanupAskpass, fs, path, retryFileOperation, dashboard,
  flushRestore: () => store?.flushRestore(),
  get quitting() { return quitting; }, set quitting(value) { quitting = value; },
  get window() { return window; }, get dashboardWindow() { return dashboardWindow; }, get labWindow() { return labWindow; },
  get attentionTimer() { return attentionTimer; }, get voiceManager() { return voiceManager; }, get fileOperations() { return fileOperations; },
  get routing() { return routing; }, get nativeSessions() { return nativeSessions; }, get claudeRuntime() { return claudeRuntime; },
  get updateManager() { return updateManager; }, get usageRolloverTimer() { return usageHost.usageRolloverTimer; }, get stateTimer() { return stateTimer; },
  get sshAuth() { return sshAuth; }, get eventServer() { return eventServer; }, get hookServer() { return hookServer; },
  get dispatchControl() { return dispatchControl; }, get tray() { return tray; }, get runtimeDir() { return runtimeDir; },
});
app.on('window-all-closed', () => { if (quitting) app.quit(); });
