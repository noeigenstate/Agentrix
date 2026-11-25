function registerQuit(host) {
  let quitCleaned = false;
  host.app.on('before-quit', event => {
    const { app, platform, quitting, window, showWindow, requestQuit, report, disposeDispatchInbox, dashboardWindow, labWindow,
      attentionTimer, voiceManager, fileOperations, skills, nativeSessions, claudeRuntime, updateManager, projectAccounts,
      codexAccounts, claudeAccounts, disposeClaudeAccounts, usageRolloverTimer, stateTimer, sessions, disposeTerminal,
      workerTerminals, sshAuth, eventServer, hookServer, dispatchControl, tray, cleanupAskpass, runtimeDir, fs, path, dashboard } = host;
    let nativeDrain, workerDrain;
    // On macOS the Dock's Quit and logging out reach here directly; they ask about running terminals like ⌘Q.
    if (platform === 'darwin' && !quitting && window && !window.isDestroyed()) { event.preventDefault(); showWindow(); requestQuit().catch(report); return; }
    if (!quitCleaned) {
      quitCleaned = true;
      disposeDispatchInbox();
      dashboardWindow?.dispose();
      labWindow?.dispose();
      clearTimeout(attentionTimer);
      voiceManager?.close(); fileOperations?.cancel();
      skills?.close();
      host.quitting = true;
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

module.exports = { registerQuit, startEventServer, startHookServer, workerParent };
