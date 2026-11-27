const { agentOfModel } = require('../cli-adapters/registry.mjs');

function createCodexServices(host) {
  const { createCodexLocator, scanDrives, fixedDrives, os, path, app, readNativeJson, writeNativeJson,
    CodexAccountUsage, adapterOf, createResetRpc, createProjectAccounts, readClaudeAccountCache, env = process.env } = host;
  // One Codex locator for the terminal, native mode, the account reads and the settings (codex-runtime/BOUNDARY.md). They
  // all run the file it found in main's environment; a terminal is told where that file was found. When its fast search
  // finds nothing it scans the local drives in the background (never the temporary folder), keeps a hit, or when it
  // found none, the time, for the next start, and tells the settings. An isolated profile (AGENTRIX_DATA_DIR) never
  // scans: its PATH keeps it from this machine's real Codex, and a scan would not.
  const codexHitFile = () => path.join(app.getPath('userData'), 'codex-location.json');
  const codexLocator = createCodexLocator({ scan: env.AGENTRIX_DATA_DIR ? null
    : async walk => scanDrives({ ...walk, drives: await fixedDrives(env), skipPaths: [env.TEMP, env.TMP, os.tmpdir()] }),
    store: { read: () => readNativeJson(codexHitFile(), null), write: value => writeNativeJson(codexHitFile(), value) },
    changed: () => host.agents.changed() });
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
  const projectAccounts = withFocusedAccountReaders(createProjectAccounts({ codex: codexAccounts, readClaude: readClaudeAccountCache }), {
    cwd: () => app.getPath('userData'), seats: projectId => host.routing?.seatsInfo(projectId)?.effective,
    registered: () => [...host.agents.installers.keys()].map(adapterOf),
  });

  return { codexLocator, codexExecutable, codexAccounts, projectAccounts };
}

// The visible usage pane supplies the refresh signal. Share one recent reading per provider and CLI home across panes.
function withFocusedAccountReaders(base, { cwd, seats = () => null, now = Date.now, registered }) {
  const focusedReaders = () => registered().filter(({ usage }) => usage?.focusedLimits);
  const cache = new Map();
  let focus;

  async function load({ manifest: { id }, usage }, env) {
    const key = usage.quotaHome({}, env), held = cache.get(id);
    if (held && held.key === key && !held.abort.signal.aborted) {
      if (held.pending) return held.pending;
      if (held.value && now() < held.nextReadAt) return held.value;
    }
    held?.abort?.abort();
    const entry = { key, abort: new AbortController() };
    cache.set(id, entry);
    entry.pending = Promise.allSettled([held?.pending]).then(() => entry.abort.signal.aborted ? null
      : usage.accountReader({ env, cwd: cwd(), now, signal: entry.abort.signal }))
      .then(value => {
        if (entry.abort.signal.aborted) return null;
        entry.nextReadAt = now() + usage.focusedInterval;
        return entry.value = value;
      }).finally(() => { entry.pending = null; });
    return entry.pending;
  }

  return {
    ...base,
    snapshot(id) {
      const original = base.snapshot(id);
      return focus?.id === id && focus.accounts ? { ...original, ...focus.accounts } : original;
    },
    focusedLimits(id) {
      if (focus?.id !== id || !focus?.accounts) return {};
      return Object.fromEntries(focusedReaders().flatMap(({ manifest: { id: agent }, usage }) => {
        const account = focus.accounts[agent];
        return account ? [[agent, usage.focusedLimits(account)]] : [];
      }));
    },
    close(id) {
      const closing = base.close(id);
      if (id && focus?.id !== id) return closing;
      focus = null;
      const pending = [...cache.values()].flatMap(entry => {
        if (!entry.pending) return [];
        entry.abort.abort();
        return [entry.pending];
      });
      if (!id) cache.clear();
      return Promise.allSettled([closing, ...pending]);
    },
    async read(project, options) {
      const env = options.env;
      if (!project || project.kind === 'ssh' || (env.AGENTRIX_DATA_DIR && env.AGENTRIX_TEST_AGENTS !== '1')) return base.read(project, options);
      if (focus?.id !== project.id) focus = { id: project.id };
      const current = focus, revision = current.revision = (current.revision ?? 0) + 1;
      const runningOrSaved = [project, ...(project.terminals ?? [])].flatMap(({ restore }) => restore?.threadId ? [restore.agent] : []);
      const selected = Object.values(seats(project.id) ?? {}).map(({ model }) => agentOfModel(model));
      const eligible = new Set([...(project.quotaAgents ?? []), ...runningOrSaved, ...selected]);
      const readers = focusedReaders().filter(({ manifest }) => eligible.has(manifest.id));
      const [original, accounts] = await Promise.all([base.read(project, options), Promise.allSettled(readers.map(adapter => load(adapter, env)))]);
      if (focus !== current || current.revision !== revision || !original) return original;
      current.accounts = Object.fromEntries(accounts.flatMap((result, index) => result.status === 'fulfilled' && result.value
        ? [[readers[index].manifest.id, result.value]] : []));
      return { ...original, ...current.accounts };
    },
  };
}

function createClaudeAccountService(host) {
  const { ClaudeAccountUsage, adapterOf, electronNet, process = globalThis.process } = host;
  return new ClaudeAccountUsage({ changed: () => host.queueClaudeAccounts(), read: options => adapterOf('claude').usage.accountReader({ ...options,
    routes: host.localClaudeMeters().map(s => ({ cwd: s.usageCwd, env: s.usageEnv || process.env })),
    fetch: (url, options) => electronNet.fetch(url, options),
  }) });
}

function createCliChecks(host) {
  // The CLI the native path runs, from the locator. `mode`: 'locate' only stats what it chose; 'refresh' (start-up, the
  // connection test, an install) reads the stored Windows PATH and searches again; 'focus' does that at most once a
  // minute. The agents' state is told again whenever what it says of Claude Code changed.
  async function inspectClaude(mode) {
    const { claudeLocator, claudeState, inspectClaudeExecutable, agents } = host;
    const seen = () => { const found = claudeLocator.peek(); return found && JSON.stringify(claudeState(found)); };
    const before = seen();
    try { return await inspectClaudeExecutable({ locator: claudeLocator, fresh: mode !== 'locate', throttled: mode === 'focus' }); }
    finally { if (seen() !== before) agents.changed(); }
  }
  // Codex is searched again like Claude Code ('refresh' or 'focus'; 'scan', after the user installed, also scans the
  // drives at once when nothing is found), and the agents' state told when what it says changed.
  async function checkCodex(mode) {
    const { codexLocator, codexState, agents } = host;
    const seen = () => { const found = codexLocator.peek(); return found && JSON.stringify(codexState(found)); };
    const before = seen();
    try { return await codexLocator.refresh(undefined, { throttled: mode === 'focus', scan: mode === 'scan' }); }
    finally { if (seen() !== before) agents.changed(); }
  }
  // The runtime numbers each CLI check: a stale one comes back as the newer result and changes nothing.
  function checkClaude(mode = 'locate') {
    const check = inspectClaude(mode);
    return host.claudeRuntime?.trackCli?.(check) ?? check;
  }

  let manualPending, manualCheckedAt = -Infinity;
  async function checkManualInstalls(mode) {
    const { agents, adapters, process = globalThis.process } = host;
    if (process.env.AGENTRIX_DATA_DIR && process.env.AGENTRIX_TEST_AGENTS !== '1') return;
    if (manualPending) return manualPending;
    if (mode === 'focus' && Date.now() - manualCheckedAt < 60000) return;
    const manual = adapters().filter(({ manifest }) => manifest.install.commands);
    if (!manual.length) return;
    manualCheckedAt = Date.now();
    const snapshot = () => JSON.stringify(manual.map(({ manifest: { id } }) => agents.installers.get(id).peek()));
    const before = snapshot();
    manualPending = Promise.allSettled(manual.map(({ manifest: { id } }) =>
      Promise.resolve().then(() => agents.installers.get(id).refresh(process.env)))).then(() => {
      if (snapshot() !== before) agents.changed();
    }).finally(() => { manualPending = null; });
    return manualPending;
  }

  return { inspectClaude, checkClaude, checkCodex, checkManualInstalls };
}

function createUsageHost(host) {
  const { setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout,
    setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval, Date = globalThis.Date } = host;

  function noteSettings(s, agent, record) {
    const { agentSettings, scheduleState } = host;
    const next = agentSettings(s.agentSettings || null, agent, record);
    if (next !== (s.agentSettings || null)) { s.agentSettings = next; scheduleState(); }
    const limits = s.usage?.limits;
    if (s.usage?.apply(record) && (!s.usageHistory || s.usage.limits !== limits)) {
      if (!s.usageHistory) s.recordQuota?.(agent, s.usage.limits);
      scheduleState(); scheduleUsageRollover();
    }
    if (s.usage?.agent === agent) s.usage.facet?.terminal?.refreshOnRecord?.(s, record);
  }
  // Workspace broadcasts can happen while history is still reading: hold a clean snapshot until it finishes.
  function usageHistory(s, ready) {
    const { scheduleState } = host;
    s.calls?.history(!ready);
    if (!s.usage) return;
    s.usageHistory = ready ? null : s.usage.snapshot();
    scheduleUsageRollover();
    if (ready) scheduleState();
  }

  function startUsage(project, s, event) {
    const { UsageMeter, callsOf, scheduleState, claudeProvider, codexProvider, claudeConfigDir } = host;
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
    const { codexAccounts, sessions, scheduleState } = host;
    const usage = s.usage;
    s.terminalAccount = null;
    let binding;
    s.bindUsageAccount = () => {
      const options = { codexHome: event.codexHome || s.codexHome, cwd: event.cwd || project.path,
        recordedCwd: usage.scopeCwd, env: s.usageEnv || (host.process || process).env, provider: usage.providerId,
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
    const { sessions, codexAccounts, resetCreditMessage, t, randomUUID, report, scheduleState } = host;
    const usage = s.usage;
    const current = () => sessions.get(s.terminalId) === s && s.agent === 'codex' && s.usage === usage && s.cliActive && host.nativeSessions?.getSettings().codexAutoReset === true;
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
    const { watchRemoteClaudeAccount, sessions, scheduleState } = host;
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
    const { sessions, store } = host;
    return [...sessions.values()].filter(s => s !== skip && s.cliActive && s.agent === 'claude' && s.usage?.agent === 'claude' &&
      store.projects.some(p => p.id === s.projectId && p.kind !== 'ssh'));
  }
  function disposeClaudeAccounts() {
    const { claudeAccounts } = host;
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
  async function refreshClaudeAccounts() {
    const { claudeAccounts, claudeAccount, fs, path, claudeAccountFiles, scheduleState } = host;
    if (host.quitting || !localClaudeMeters().length) { disposeClaudeAccounts(); return; }
    claudeAccounts.setActive(true); claudeAccounts.refresh();
    if (claudeAccountSoon) clearTimeout(claudeAccountSoon);
    claudeAccountSoon = null;
    watchClaudeAccountFolders({ fs, path, claudeAccountFiles, queueClaudeAccounts }, claudeAccountWatchers);
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
    const { sessions, store } = host;
    const now = Date.now();
    let next = Infinity;
    if (!host.quitting) for (const s of sessions.values()) {
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
        for (const s of sessions.values()) if (s.cliActive) s.usage?.facet?.terminal?.refreshAtRollover?.(s);
        void refreshClaudeAccounts();
      }
      scheduleUsageRollover();
    }, Math.min(next - now, 2147483647));
    usageRolloverTimer.unref?.();
  }


  function usageResources() {
    return { claudeAccountTimer, claudeAccountSoon, claudeAccountPending,
      claudeAccountWatchers: new Map(claudeAccountWatchers), usageRolloverTimer, usageRolloverAt };
  }

  return { startUsage, stopUsageAccount, noteSettings, usageHistory, resetTerminalCodex, bindCodexAccount,
      bindRemoteClaudeAccount, localClaudeMeters, disposeClaudeAccounts, queueClaudeAccounts, refreshClaudeAccounts, scheduleUsageRollover, usageResources,
    get usageRolloverTimer() { return usageRolloverTimer; } };
}

function watchClaudeAccountFolders({ fs, path, claudeAccountFiles, queueClaudeAccounts }, claudeAccountWatchers) {
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

function createModelProbes(host) {
  const { app, path, fs, seatModelRuntimes, agents, adapters } = host;
  const probeDirectory = path.join(app.getPath('userData'), 'model-probe');
  fs.mkdirSync(probeDirectory, { recursive: true });
  const liveModels = async family => {
    for (const runtime of seatModelRuntimes[family] ?? []) {
      try { await runtime.models(); return true; } catch { /* A closing runtime is not a catalog source. */ }
    }
    return false;
  };
  return Object.fromEntries(adapters().map(({ manifest: { id, install }, modelProbe }) => [id, async () => {
    const installed = () => agents.getState()[id]?.installed === true;
    if (!modelProbe || install.commands && !installed() || await liveModels(id)) return null;
    return modelProbe(host, probeDirectory, installed);
  }]));
}

module.exports = { createUsageHost, createCodexServices, createClaudeAccountService, createCliChecks, createModelProbes,
  watchClaudeAccountFolders, withFocusedAccountReaders };
