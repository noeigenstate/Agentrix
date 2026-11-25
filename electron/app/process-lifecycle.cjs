const RUNTIME_FOLDER = /^runtime-[a-zA-Z0-9]+$/;

function removeRuntimeFolder({ fs, path, retryFileOperation }, root, folder) {
  if (path.relative(root, path.dirname(folder)) || !RUNTIME_FOLDER.test(path.basename(folder))) return;
  if (!fs.lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) return;
  if (path.relative(folder, fs.realpathSync(folder))) return;
  retryFileOperation(() => fs.rmSync(folder, { recursive: true, force: true }));
}

function cleanStaleRuntimeFolders(deps, directory, current) {
  const { fs, path, report } = deps;
  try {
    const root = fs.realpathSync(directory);
    const currentName = path.basename(current);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === currentName || !RUNTIME_FOLDER.test(entry.name)) continue;
      try { removeRuntimeFolder(deps, root, path.join(root, entry.name)); }
      catch (error) { report(error); }
    }
  } catch (error) { report(error); }
}

async function startNativeWithWarnings({ store, start, recover, onFailure, report }) {
  try { await start(); }
  catch (error) {
    report(error);
    onFailure();
    store.warnings.push('原生会话暂不可用，已保留终端模式。');
  }
  store.warnings.push(...recover());
}

function quitSteps(host) {
  const { app, report, disposeDispatchInbox, dashboardWindow, labWindow,
    attentionTimer, voiceManager, fileOperations, skills, nativeSessions, claudeRuntime, updateManager, projectAccounts,
    codexAccounts, claudeAccounts, disposeClaudeAccounts, usageRolloverTimer, stateTimer, sessions, disposeTerminal,
    workerTerminals, sshAuth, eventServer, hookServer, dispatchControl, tray, cleanupAskpass, runtimeDir, fs, path, dashboard } = host;
  const drains = [];
  const run = operation => {
    try {
      const result = operation();
      if (result && typeof result.then === 'function') drains.push(Promise.resolve(result).catch(report));
    } catch (error) { report(error); }
  };
  run(disposeDispatchInbox);
  run(() => dashboardWindow?.dispose());
  run(() => labWindow?.dispose());
  clearTimeout(attentionTimer);
  run(() => voiceManager?.close());
  run(() => fileOperations?.cancel());
  run(() => skills?.close());
  host.quitting = true;
  run(() => nativeSessions?.close());
  run(() => claudeRuntime?.close());
  run(() => updateManager?.dispose());
  run(() => projectAccounts.close());
  run(() => codexAccounts.dispose());
  run(() => claudeAccounts.dispose());
  run(disposeClaudeAccounts);
  clearTimeout(usageRolloverTimer);
  clearTimeout(stateTimer);
  for (const id of sessions.keys()) run(() => disposeTerminal(id));
  run(() => host.flushRestore?.());
  run(() => workerTerminals.closeAll());
  run(() => sshAuth?.close());
  run(() => eventServer?.close());
  run(() => hookServer?.close());
  run(() => dispatchControl?.close());
  run(() => tray?.destroy());
  run(cleanupAskpass);
  if (runtimeDir) run(() => removeRuntimeFolder(host, fs.realpathSync(app.getPath('userData')),
    path.join(fs.realpathSync(path.dirname(runtimeDir)), path.basename(runtimeDir))));
  run(() => dashboard.waitForQuit());
  run(() => labWindow?.waitForQuit());
  return drains;
}

function registerQuit(host) {
  let phase;
  host.app.on('before-quit', event => {
    const { app, platform, quitting, window, showWindow, requestQuit, report, quitTimeout = 5000 } = host;
    // On macOS the Dock's Quit and logging out reach here directly.
    if (platform === 'darwin' && !quitting && window && !window.isDestroyed()) {
      event.preventDefault(); showWindow(); requestQuit().catch(report); return;
    }
    if (phase === 'done') return;
    event.preventDefault();
    if (phase === 'draining') return;
    phase = 'draining';
    const drains = quitSteps(host);
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), quitTimeout); });
    void Promise.race([Promise.allSettled(drains), deadline]).then(result => {
      clearTimeout(timer);
      phase = 'done';
      if (result === 'timeout') report(new Error('Timed out waiting for shutdown cleanup.'));
      app.quit();
    });
  });
}

function startEventServer({ createEventServer, workerTerminals, onEvent }) {
  return createEventServer(event => workerTerminals.event(event) || onEvent(event));
}

function startHookServer({ createHookServer, createHookIngest, workerTerminals, sessions, claudeHook, takeModeNote }) {
  return createHookServer(createHookIngest({ keyOf: id => workerTerminals.keyOf(id) ?? sessions.get(id)?.hooks?.key,
    deliver: event => workerTerminals.hook(event) || claudeHook(event), noteOf: takeModeNote })).catch(() => null);
}

function workerParent(sessions, run) {
  const s = sessions.get(run.projectId);
  return s?.usageEnv && s.agent === 'claude' && !s.nativeStructured ? { env: s.usageEnv, sessionKey: s.sessionKey, bootstrapFile: s.bootstrapFile } : null;
}

module.exports = { registerQuit, cleanStaleRuntimeFolders, startNativeWithWarnings, startEventServer, startHookServer, workerParent };
