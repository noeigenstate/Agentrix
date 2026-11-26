function registerApplicationIpc(host) {
  const { createIpcAdapter, ipcMain, devUrl, t, report, nativeSessions, registerUnavailableNative, registerRoutingIpc, routing, dialog, store,
    workerTerminals, registerAgentsIpc, agents, shell, sessions, findProject, dashboard, readingHistory, listAgentCommands, interventions,
    registerSshIpc, getSSHInfo, sshAuth, startTerminal, startupErrors, broadcast, registerUpdatesIpc, updateManager, updateStoreSettings,
    allowEditorClose, liveTerminalCount, registerFilesIpc, remoteFor, fileOperations, clipboardWrites, clipboard, previewResources, affectsEditor,
    send, registerGitIpc, projectGit, setBranch, registerVoiceIpc, voiceManager, registerEditorIpc, registerNativeIpc, registerClipboardIpc, registerWindowIpc, requestQuit } = host;
  const { handle, listen } = createIpcAdapter({ ipcMain, getWindow: () => host.window, devUrl, t, report });
  if (nativeSessions) nativeSessions.register(handle);
  else registerUnavailableNative(handle);
  registerTitlebarState(host, listen);
  registerRoutingIpc({ handle, routing, claudeFastRefusal: () => store.claudeFastMode?.reason });
  workerTerminals.register({ handle, listen, getWebContents: () => host.window?.webContents, report });
  registerAgentsIpc({ handle, agents, openExternal: url => shell.openExternal(url), getSession: id => sessions.get(id), findProject,
    routingOwned: projectId => routing.routingOwned(projectId),
    gradeDelivery: (grade, project, session) => dashboard.grade(grade, project, session),
    readingPage: (id, request) => readingHistory.page(id, request.key, request.cursor),
    // The legacy reply IPC remains inert; no planner relay requests are emitted.
    listAgentCommands, interventions, relayResult() {}, t });
  registerCallFile(host, handle);
  registerSshIpc({ handle, getSSHInfo, sshAuth, addSSH: input => store.addSSH(input), hasSession: id => sessions.has(id), getSession: id => sessions.get(id),
    startTerminal, setStartupError: (id, message) => startupErrors.set(id, message), broadcast });
  host.updatesIpc = registerUpdatesIpc({ handle, updateManager, updateSettings: patch => { updateStoreSettings(patch); broadcast(); },
    openExternal: url => shell.openExternal(url), getWindow: () => host.window, dialog, t,
    allowEditorClose, liveTerminalCount, setQuitting: value => { host.quitting = value; } });
  registerAppWorkspace(host, handle);
  host.filesIpc = registerFilesIpc({ handle, listen, findProject, remoteFor, fileOperations, clipboardWrites, clipboard, previewResources, affectsEditor, allowEditorClose, shell,
    getActiveFileTree: () => host.activeFileTree, setActiveFileTree: value => { host.activeFileTree = value; }, setActiveTerminal: value => { host.activeTerminal = value; }, send });
  registerGitIpc({ handle, findProject, projectGit, setBranch, affectsEditor, allowEditorClose, getWindow: () => host.window, dialog, t });
  registerVoiceIpc({ handle, voiceManager });
  registerEditorIpc({ handle, listen });
  registerReadingIpc(host, handle);
  registerAgentLaunch(host, handle);
  registerNativeIpc({ handle });
  host.terminalInput = registerAppTerminal(host, { handle, listen });
  registerClipboardIpc({ handle, clipboardWrites, clipboard });
  registerWindowIpc({ handle, listen, getWindow: () => host.window, requestQuit });
}

function registerCallFile(host, handle) {
  const { store, sessions, AgentCalls } = host;
  handle('agents:callFile', (terminalId, callId, kind) => {
    if (typeof terminalId !== 'string' || !terminalId || terminalId.length > 160) return { ok: false, code: 'refused' };
    if (store.findTerminal(terminalId)?.project.kind !== 'local') return { ok: false, code: 'unavailable' };
    return AgentCalls.forTerminal(sessions, terminalId)?.callFile(callId, kind) ?? { ok: false, code: 'unavailable' };
  });
}

function registerTitlebarState(host, listen) {
  if ((host.process || process).platform === 'darwin') listen('titlebar:state', state => host.macTitlebar?.update(state));
}

function removeProject({ projectAccounts, codexAccounts, clearDispatchAccount, store }, id) {
  projectAccounts.close(id);
  codexAccounts.closeProject(id);
  clearDispatchAccount(id);
  store.remove(id);
}

function registerAppWorkspace(host, handle) {
  const { registerWorkspaceIpc, publicState, dialog, t, store, projectImageAuto, fs, getEditorFile, allowEditorClose,
    confirmTerminalClose, disposeProjectTerminals, findProject, previewResources,
    forgetBranch, broadcast, reorderTerminals, projectImageCandidates, updateStoreSettings, restorePlans, voiceManager } = host;
  registerWorkspaceIpc({ handle, publicState, dialog, getWindow: () => host.window, t, addProject: (folder, name) => {
    const added = store.add(folder, name); projectImageAuto.enqueue(added.project); return added;
  }, getRecentProjects: () => store.recentProjects(), getRecentSSH: () => store.recentSSH(),
    forgetRecentSSH: (host, folder) => store.forgetSSH(host, folder), clearSSHHistory: () => store.clearSSHHistory(), existsSync: fs.existsSync,
    getRecentEntry: folder => store.recentEntry(folder), forgetRecent: folder => store.forget(folder), clearHistory: () => store.clearHistory(),
    getEditorFile, allowEditorClose, confirmTerminalClose, disposeProjectTerminals, findProject, closeProjectPreviews: id => previewResources.closeProject(id),
    removeProject: id => removeProject(host, id),
    forgetBranch, broadcast, acknowledgeProject: id => store.acknowledge(id), reorderProjects: ids => store.reorderProjects(ids), reorderTerminals,
    setProjectImage: (id, image, mode) => {
      store.setProjectImage(id, image, mode);
      if (mode === 'auto' && !image) projectImageAuto.enqueue(store.projects.find(project => project.id === id));
    },
    listProjectImageCandidates: folder => projectImageCandidates(folder, 6, store.settings.theme),
    getSettings: () => store.settings, updateStoreSettings,
    clearRestorePlans: () => restorePlans.clear(), chooseVoiceModel: model => voiceManager.choose(model) });
}

function registerReadingIpc(host, handle) {
  const { fileCard, findProject, folderOf, remoteImage, remoteFor, registerImageIpc, app, sessions, clipboard,
    nativeImage, isGeneratedImage, documentText, previewResources, store, Notification, t, path, root, showWindow, send } = host;
  // A new project's card offers Claude Code and Codex, fresh or continuing this folder's latest conversation.
  handle('project:card', (id, file) => fileCard(findProject(id), file, folderOf(id)));
  const remoteProjectImage = (id, file) => remoteImage(remoteFor(id), file);
  registerImageIpc({ handle, app, findProject, getSession: id => sessions.get(id), clipboard, nativeImage, isGeneratedImage, remoteImage: remoteProjectImage });
  registerImageSave(host, handle, remoteProjectImage);
  // A Markdown file an agent wrote outside the project (its memory, a note in a temporary folder), whole, for its popup:
  // only Markdown, read where the project is (this computer, or the SSH computer through its worker).
  handle('agent:document', (id, file) => documentText(previewResources, findProject(id), file));
  // A decision waits on the reader (a permission, a question, a sign-in): with the window in the background, a short
  // notice names the project and what kind of thing it is, never the command or the answers; a click opens the
  // decisions. The window itself shows it on the home page and the count beside its tab.
  handle('decision:notify', (id, title, kind) => {
    const project = findProject(id), { window } = host;
    if (!window || window.isDestroyed() || window.isFocused()) return false;
    window.flashFrame(true); clearTimeout(host.attentionTimer);
    host.attentionTimer = setTimeout(() => { if (host.window && !host.window.isDestroyed()) host.window.flashFrame(false); }, 9000);
    host.attentionTimer.unref?.();
    if (store.settings.notifications && Notification.isSupported()) {
      const note = new Notification({ title: t('{name} · {kind}', { name: project.name, kind: String(kind).slice(0, 20) }),
        body: String(title).slice(0, 120), icon: path.join(root, 'assets/icon-alert.png'), silent: !store.settings.sound });
      note.on('click', () => { showWindow(); send('decision:show'); });
      note.on('failed', () => {});
      note.show();
    }
    return true;
  });
}

function registerImageSave(host, handle, remoteProjectImage) {
  const { findProject, isGeneratedImage, fs, dialog, saveDialogOptions, app, t, saveTarget } = host;
  // The result card's 「保存图片」: a copy of the picture Codex generated, to where the reader picks. Null when the dialog is
  // dismissed. A picture an SSH project's agent drew is read back over its connection first, as for showing it.
  handle('agent:saveImageAs', async (file, projectId) => {
    const remote = typeof projectId === 'string' && findProject(projectId).kind === 'ssh';
    if (!isGeneratedImage(file) || !remote && !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error('只能保存 Codex 生成的图片。');
    const bytes = remote ? await remoteProjectImage(projectId, file) : null;
    const picked = await dialog.showSaveDialog(host.window, saveDialogOptions(file, app.getPath('pictures'), t('图片')));
    if (picked.canceled || !picked.filePath) return null;
    const target = saveTarget(picked.filePath, file);
    await (bytes ? fs.promises.writeFile(target, bytes) : fs.promises.copyFile(file, target));
    return target;
  });
}

function registerAgentLaunch(host, handle) {
  const { findProject, folderOf, store, launchPlans, restorePlans, adapterOf, launchCommand, broadcast } = host;
  handle('agent:history', id => {
    if (findProject(id).kind !== 'ssh') return host.folderHistory(folderOf(id));
    // A launcher mount is not permission to connect or prompt for an SSH password.
    const saved = store.findTerminal(id).record.restore;
    return { claude: null, codex: saved?.threadId ? { id: saved.threadId } : null };
  });
  handle('agent:launch', async (id, agent, mode) => {
    const project = findProject(id), adapter = adapterOf(agent);
    if (!adapter) throw new Error('无效的助手。');
    if (!['new', 'continue'].includes(mode)) throw new Error('Unsupported agent session mode');
    if (adapter.terminal?.redirect === 'native') {
      const { nativeSessions } = host;
      if (!nativeSessions) throw new Error('Codex 原生模式连接失败，请重试。');
      launchPlans.delete(id); restorePlans.delete(id);
      // start resolves the saved thread, or queries folder history, only after this click.
      await nativeSessions.start(id, { agent, resume: mode === 'continue' }); broadcast(); return true;
    }
    // Claude Code on another computer keeps its own conversations: it is asked to continue, never searched for here.
    const history = mode === 'continue' && project.kind !== 'ssh' ? (await host.folderHistory(folderOf(id)))[agent] : null;
    const command = project.kind === 'ssh' && mode === 'continue' && adapter.terminal?.resumeLine ? adapter.terminal.resumeLine() : launchCommand(agent, history);
    const existing = host.sessions?.get(id);
    if (existing && existing.status !== 'exited') return false;
    launchPlans.set(id, { agent, command, threadId: history?.id || null });
    try { host.startTerminal(id, true); }
    catch (error) { launchPlans.delete(id); throw error; }
    broadcast(); return true;
  });
}

function registerAppTerminal(host, { handle, listen }) {
  const { registerTerminalIpc, findProject, sessions, nativeSpecs, startTerminal, claudeConfigDir, writeFileAtomic,
    store, fs, handoffFile, confirmTerminalClose, restorePlans, disposeTerminal, startupErrors, broadcast, scheduleState, applyActivity, pollAfterSubmission, send } = host;
  return registerTerminalIpc({ handle, listen, findProject, getSession: id => sessions.get(id), hasSession: id => sessions.has(id), nativeHost: id => nativeSpecs.has(id), startTerminal,
    fastSettings: { claudeConfigDir, writeFileAtomic, onQuit: fn => host.app?.once('will-quit', fn),
      report: error => { console.error('Fast settings:', error.message); host.report?.(error); } },
    addTerminal: id => store.addTerminal(id), removeTerminal: id => { store.removeTerminal(id); fs.promises.rm(handoffFile(id), { force: true }).catch(() => {}); },
    confirmTerminalClose, forgetRestorePlan: id => restorePlans.delete(id),
    disposeTerminal, clearStartupError: id => startupErrors.delete(id), broadcast, getProjectById: id => store.projects.find(p => p.id === id),
    acknowledgeProject: id => store.acknowledge(id), expectCompletion: id => store.expectCompletion(id), scheduleState, applyActivity, pollAfterSubmission, send,
    getActiveTerminal: () => host.activeTerminal, setActiveTerminal: value => { host.activeTerminal = value; }, setActiveFileTree: value => { host.activeFileTree = value; } });
}

module.exports = { registerApplicationIpc, registerCallFile, registerTitlebarState, registerImageSave, registerAgentLaunch,
  registerAppTerminal, registerAppWorkspace, removeProject };
