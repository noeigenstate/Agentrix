const { remoteGuide } = require('../routing/store.cjs');

// A role the conductor started has ended: a native conductor hears it as its next message, so it can report without polling.
function roleEnded(deps, s, project, event) {
  if (!s?.nativeStructured || !s.nativeRuntimeSessionId || !deps.routing?.seatsInfo(project.id)?.conductor) return;
  const text = `[Agentrix] Role run ${event.id} has ended (${event.reason}${event.exitCode == null ? '' : `, exit ${event.exitCode}`}). Read it with role_result and report to the owner.`;
  deps.nativeSessions?.send(s.terminalId, s.nativeRuntimeSessionId, { clientMessageId: deps.randomUUID(), text }).catch(deps.report);
}

// The owner switched a running session's mode. A native session hears it as its next message; Claude Code in a terminal
// with the owner's next prompt (hook-response.cjs), and a switch back before that prompt leaves nothing to tell.
function tellMode(deps, s, project) {
  const text = deps.routing.modeNote(project, s.skillSessionId || s.nativeSpec?.skillSessionId || s.sessionId, s.agent);
  const delivery = (deps.adapterOf(s.agent) ?? deps.adapterOf('codex')).notes.message(text, { native: s.nativeStructured });
  if (!s.nativeStructured) { s.modeNote = delivery.hook && !s.modeNote ? text : null; return; }
  if (s.nativeRuntimeSessionId) deps.nativeSessions?.send(s.terminalId, s.nativeRuntimeSessionId, { clientMessageId: deps.randomUUID(), text: delivery.send }).catch(deps.report);
}

function tellRemoteRouting(deps, s, project, remote, modeChanged) {
  if (!s.cliActive) return;
  if (s.nativeStructured) { if (modeChanged) tellMode(deps, s, project); return; }
  if (!deps.adapterOf(s.agent)?.notes.message(null).hook) return;
  const change = deps.routing.routingChange(project.id, s.skillSessionId || s.sessionId, s.toldSeats);
  const mode = modeChanged ? deps.routing.modeNote(project, s.skillSessionId || s.nativeSpec?.skillSessionId || s.sessionId, s.agent) : null;
  if (!mode && !change) return;
  if (change) s.toldSeats = change.table;
  // The remote prompt hook hands over the mode and routing together with the owner's next prompt.
  remote.request('prompt-note', { ...(mode && { mode }), ...(change && { note: change.note }) }).catch(deps.report);
}

// The note a terminal's next prompt carries, handed over once.
function takeModeNote(deps, terminalId) {
  const s = deps.sessions.get(terminalId);
  const note = [s?.modeNote, s?.routingNote].filter(Boolean).join(' ') || null;
  if (s) { s.modeNote = null; s.routingNote = null; }
  return note;
}

function nativeSubagent(deps, spec, signal, { runtimeSessionId, providerSessionId, folder }) {
  const s = deps.sessions.get(spec.terminalId), project = deps.store.findTerminal(spec.terminalId)?.project;
  if (deps.quitting || !project || deps.nativeSpecs.get(spec.terminalId) !== spec || !s?.nativeStructured || !s.cliActive
    || s.agent !== 'claude' || s.nativeRuntimeSessionId !== runtimeSessionId || s.claudeSessionId !== providerSessionId
    || signal.terminalId !== spec.terminalId) return;
  const calls = deps.callsOf(s, project);
  if (folder) calls.setFolder(folder);
  if (signal.kind === 'seat') calls.observeSeatInput(signal);
  // An untyped SDK hook may belong to Claude's own helper. Use the same hold as terminal hooks.
  else calls.subagent(signal, !signal.agentType);
  deps.scheduleState();
}

async function initializeNativeSessions(deps) {
  // Load optional provider composition after app.ready without opening a session.
  const createCodexRuntime = await deps.adapterOf('codex').native.load(), createClaudeRuntime = deps.adapterOf('claude').native.load();
  const { createDispatchControl } = await deps.loadDispatchControl();
  const { locateTeam } = deps.loadTeamLocator();
  const { resolveRegistration } = deps.loadDispatchRegistration();
  deps.dispatchControl = createDispatchControl({ resolveRun: registration => resolveRegistration({ sessions: deps.sessions, store: deps.store, locateTeam }, registration) });
  ({ address: deps.controlAddress } = await deps.dispatchControl.listen());
  const directory = deps.path.join(deps.app.getPath('userData'), 'native-session');
  deps.claudeRuntime = createClaudeProvider(deps, directory, createClaudeRuntime);
  // The first look at the CLI (already under way since the app was ready) seeds what later looks compare with.
  deps.checkClaude().catch(() => {});
  const codexFactory = createCodexProvider(deps, createCodexRuntime);
  const codex = { create(spec, emit) {
    const runtime = codexFactory.create(spec, emit), start = runtime.start, resume = runtime.resume, close = runtime.close;
    let accountBinding, accountWatch;
    const attach = async (open, value) => {
      const result = await open(value);
      const options = { cwd: spec.cwd, env: spec.env, projectId: spec.projectId };
      if (spec.kind === 'ssh') {
        const host = deps.sessions.get(spec.terminalId);
        if (host) host.nativeReadConnection = () => runtime.readAccount();
        return result;
      }
      accountBinding = deps.codexAccounts.attachRuntime?.(options, runtime);
      accountWatch = deps.codexAccounts.watch(options, () => deps.scheduleState());
      const host = deps.sessions.get(spec.terminalId);
      if (host) host.nativeReadConnection = () => runtime.readAccount();
      return result;
    };
    runtime.start = value => attach(start, value); runtime.resume = value => attach(resume, value);
    runtime.close = async () => { accountWatch?.dispose(); accountBinding?.dispose(); await close(); };
    return !deps.routing ? runtime : deps.routing.trackModelRuntime(runtime,
      { family: 'codex', local: spec.kind !== 'ssh', runtimes: deps.seatModelRuntimes.codex });
  } };
  const createClaude = deps.claudeRuntime.create.bind(deps.claudeRuntime);
  deps.claudeRuntime.create = (...args) => {
    const runtime = createClaude(...args);
    return !deps.routing ? runtime : deps.routing.trackModelRuntime(runtime,
      { family: 'claude', local: args[0]?.kind !== 'ssh', runtimes: deps.seatModelRuntimes.claude });
  };
  wireNativeSessions(deps, directory, codex, codexFactory);
}

function createClaudeProvider(deps, directory, createClaudeRuntime) {
  return createClaudeRuntime({ directory, safeStorage: deps.safeStorage,
    loadSdk: deps.createSdkLoader({ packaged: deps.app.isPackaged }), request: deps.netRequest(deps.electronNet),
    inspectCli: () => deps.inspectClaude('refresh'), resolveExecutable: () => deps.resolveClaudeExecutable({ locator: deps.claudeLocator }),
    connectionSpec: deps.connectionSpec,
    onCost: entry => {
      if (entry.spec.owner === 'dispatch') return;
      const project = deps.store.findTerminal(entry.spec.terminalId)?.project; if (!project) return;
      deps.dashboard.run(project, { source: 'native', sourceAgent: 'claude', title: 'Claude API', startedAt: Date.now(), model: entry.spec.model },
        { id: entry.usageRecordId, source: 'native', model: entry.spec.model, endedAt: Date.now(), reportedCostUsd: entry.deltaUsdMicros / 1e6,
          billingPath: 'api', usageRecordId: entry.usageRecordId, costCompleteness: 'estimated', reason: 'exit', exitCode: 0 });
    },
  });
}

function createCodexProvider(deps, createCodexRuntime) {
  return createCodexRuntime({ resolveExecutable: deps.codexExecutable, renderImage: deps.generatedImages.render,
    settleImage: deps.generatedImages.settle, translate: deps.t, launchRemote: launchRemote.bind(null, deps),
    resetAtLimit: (spec, evidence) => deps.codexAccounts.resetAtLimit({ ...spec, remote: spec.kind === 'ssh', accountLaunch: 'project-open-v1' },
      { ...evidence, enabled: deps.nativeSessions?.getSettings().codexAutoReset === true,
        current: () => evidence.current() && deps.nativeSessions?.getSettings().codexAutoReset === true }) });
}

function wireNativeSessions(deps, directory, codex, codexFactory) {
  deps.nativeSessions = deps.createNativeSessions(nativeRouterOptions(deps, directory, codex, codexFactory));
  deps.registerClaudeWorker({ control: deps.dispatchControl, claude: deps.claudeRuntime, settings: deps.nativeSessions.getSettings, terminals: deps.workerTerminals,
    roleResultServer: deps.roleResultServer,
    env: () => deps.claudeBackgroundEnvironment(deps.withoutAppImage((deps.process ?? process).env), deps.store.settings?.claudeBackgroundTasks) });
}

function registerUnavailableNative(deps, handle) {
  const settings = { claudePath: 'terminal-only', codexAutoReset: false };
  function start(id, options) {
    const adapter = deps.adapterOf(options?.agent);
    if (!options || typeof options !== 'object' || Object.keys(options).some(key => !['agent', 'resume'].includes(key)) ||
      !adapter || options.resume !== undefined && typeof options.resume !== 'boolean') throw new Error('无效的原生会话请求。');
    const project = deps.findProject(id), saved = deps.store.findTerminal(id).record.restore;
    if (!deps.support(adapter.manifest, 'terminal').ok) throw new Error('Codex 原生模式连接失败，请重试。');
    if (project.kind === 'ssh') throw new Error('SSH 原生会话目前仅支持 Codex。');
    const history = options.resume && saved?.agent === options.agent && /^[a-f\d-]{36}$/i.test(saved.threadId || '') ? { id: saved.threadId } : null;
    deps.launchPlans.set(id, { agent: options.agent, command: deps.launchCommand(options.agent, history), threadId: history?.id || null });
    deps.startTerminal(id, true); deps.broadcast();
    return { runtimeSessionId: deps.randomUUID() };
  }
  handle('native:start', start);
  handle('native:resume', (id, options) => start(id, { ...options, resume: true }));
  handle('native:settings-get', () => ({ ...settings }));
  handle('native:snapshot', id => { deps.findProject(id); return null; });
  handle('native:usage', async projectId => {
    // Codex is the project's reading, where a dispatched worker's report counts. Nothing reads a project's Claude account
    // without the native runtime, so Claude keeps the global reading.
    const connections = await deps.readNativeConnections(projectId);
    const limits = { claude: deps.readNativeSubscriptionLimits().claude, codex: deps.readNativeSubscriptionLimits(projectId).codex };
    const summary = deps.claudeRuntime?.usage.summary() || { month: new Date().toISOString().slice(0, 7),
      todayUsdMicros: null, monthUsdMicros: null, estimated: true, apiRecords: false };
    return { ...summary, switches: { waiting: 0 }, agents: { claude: { path: 'terminal', reason: 'native_unavailable',
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

async function launchRemote(deps, spec, { signal, readOnly = false }) {
  const project = deps.findProject(spec.terminalId);
  const launch = readOnly ? null : deps.routing.launch(project, true, spec.skillSessionId || spec.sessionId, { agent: 'codex', started: true });
  const routing = readOnly ? null : deps.routing.seatsInfo(project.id);
  const remote = new deps.RemoteConnection({ ...project, id: spec.terminalId }, { integrationDir: deps.integrationDir, auth: deps.sshAuth,
    allowBackgroundTasks: deps.store.settings?.claudeBackgroundTasks,
    claudeLead: readOnly ? null : { conductor: routing?.conductor === true, seatsMap: deps.routing.dispatchSeats(project.id) ?? {}, launchSeatsMap: launch?.agentSeats ?? {} },
    sessionKey: spec.sessionKey, onEvent: deps.onEvent, codingPath: spec.cwd, askpassPath: deps.prepareAskpass(), native: true,
    guide: remoteGuide(launch?.guide), readingNote: readOnly ? '' : deps.startupNote(deps.READING_NOTE, '{AGENTRIX_HANDOFF}',
      deps.path.posix.join(project.path, 'skills'), launch, '{AGENTRIX_DISPATCH}') });
  const cancel = () => remote.close();
  if (routing) remote.appliedRouting = { effective: routing.effective, roles: routing.roles, conductor: routing.conductor === true };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const host = deps.sessions.get(spec.terminalId); if (host && !readOnly) host.remoteConnection = remote;
  try {
    const info = await remote.ready;
    if (signal.aborted) throw new Error('session_closed');
    // The host's alias and address are redacted from a failed start's reason.
    return { cwd: info.cwd || info.root, context: info.context, roleServer: info.roleServer, hosts: [project.ssh.host, project.ssh.host.split('@').at(-1)],
      child: deps.createRemoteCodexProcess(remote) };
  } catch (error) { remote.close(); throw error; }
  finally { signal.removeEventListener('abort', cancel); }
}

function nativeRouterOptions(deps, directory, codex, codexFactory) {
  return { directory, claude: deps.claudeRuntime, codex, resolveSpec: deps.nativeSpec,
    prepareConversation: spec => {
      const project = deps.findProject(spec.terminalId), previous = spec.skillSessionId || spec.sessionId, skillSessionId = deps.randomUUID();
      const { nativePolicy } = deps.adapterOf(spec.agent);
      const lead = deps.routing.leadOptions(project.id, spec.agent);
      const launch = deps.routing.launch(project, project.kind === 'ssh', skillSessionId, { agent: spec.agent, started: true });
      Object.assign(spec, { skillSessionId, model: lead?.model ?? null, effort: lead?.effort ?? null, fast: lead ? lead.fast === true : null,
        seatsMap: launch?.agentSeats,
        env: { ...spec.env, AGENTRIX_SEATS: project.kind === 'ssh' ? JSON.stringify(launch?.agentSeats ?? null) : deps.writeSeatMap(launch?.agentSeats) } });
      nativePolicy.observeSubagents?.(spec, nativeSubagent.bind(null, deps));
      if (project.kind !== 'ssh') spec.context = deps.startupNote(deps.READING_NOTE, deps.handoffFile(spec.terminalId), deps.path.join(project.path, 'skills'),
        launch);
      return committed => {
        if (committed && spec.bootstrapFile) {
          try { deps.updateDispatchLaunchSeats(spec.bootstrapFile, launch?.agentSeats); } catch (error) { deps.report(error); }
          try { deps.updateDispatchSeats(spec.bootstrapFile, deps.routing.dispatchSeats?.(spec.projectId) ?? launch?.agentSeats ?? {}); } catch (error) { deps.report(error); }
          if (nativePolicy.bootstrapLead) {
            try { deps.updateBootstrapLead(spec.bootstrapFile, lead); } catch (error) { deps.report(error); }
          }
        }
        deps.routing.endSession(project.id, committed ? previous : skillSessionId);
      };
    },
    readHistory: async (id, { signal } = {}) => {
      const project = deps.findProject(id);
      const spec = deps.nativeSpecs.get(id);
      const agent = project.kind === 'ssh' ? deps.legacyRestoreAgent : spec?.agent;
      const nativePolicy = deps.adapterOf(agent)?.nativePolicy;
      if (!nativePolicy?.structuredHistory) return deps.folderHistory(deps.folderOf(id));
      const saved = deps.store.findTerminal(id).record.restore;
      const history = await codexFactory.history({ kind: project.kind, owner: 'gui', projectId: project.id, terminalId: id,
        cwd: spec?.cwd || saved?.cwd || project.path, env: spec?.env, sessionId: deps.randomUUID(), sessionKey: deps.randomUUID(), providerSessionId: null }, { signal }).catch(error => {
        const message = project.kind === 'ssh' && nativePolicy.remoteHistoryError?.(error);
        if (message) throw Object.assign(new Error(deps.t(message)), { code: error.code });
        throw error;
      });
      if (deps.findProject(id) !== project) throw new Error('项目已变化，请重试。');
      return { claude: null, codex: history };
    },
    readCommands: spec => {
      const env = spec.env || (deps.process ?? process).env;
      const value = name => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
      return deps.listAgentCommands({ agent: spec.agent, projectPath: spec.cwd,
        home: value('USERPROFILE') || value('HOME') || require('node:os').homedir(),
        claudeHome: value('CLAUDE_CONFIG_DIR'), codexHome: value('CODEX_HOME') })
        .then(rows => rows.map(row => ({ ...row, description: deps.t(row.description) })));
    },
    connections: deps.readNativeConnections, usageInputs: deps.readNativeUsageInputs,
    validateProject: projectId => {
      const project = projectId && deps.store.projects.find(project => project.id === projectId);
      if (projectId && !project) throw new Error('项目已关闭。');
      return project || null;
    },
    terminalSessions: deps.localSwitchSessions, observeTerminal: deps.observeSwitchTerminal, prepareTerminal: deps.prepareSwitchTerminal,
    retireTerminal: deps.retireTerminal, activateNative: deps.activateNative,
    emit: event => deps.send('native:event', event), changed: (id, event) => { if (event) deps.structuredEvent(id, event); else deps.scheduleState(); },
    saveSession: (id, saved) => deps.store.setRestore(id, { terminal: true, codex: true, agent: saved.agent, threadId: saved.providerSessionId,
      nativeTransport: deps.adapterOf(saved.agent).nativePolicy.transport }),
    invalidateSession: (id, threadId, agent) => {
      const saved = deps.store.findTerminal(id)?.record.restore;
      if (threadId && saved?.threadId === threadId && (saved.agent || deps.legacyRestoreAgent) === agent) deps.store.setRestore(id, { threadId: null, interrupted: false });
    },
    saveInterrupted: (id, interrupted) => { if (!deps.quitting) deps.store.setRestore(id, { interrupted }); },
    terminal: async (spec, reason) => {
      const current = deps.sessions.get(spec.terminalId);
      if (current?.nativeStructured) deps.disposeTerminal(spec.terminalId, { preserveNative: true, preserveCalls: true });
      deps.nativeSpecs.delete(spec.terminalId);
      if (spec.bootstrapFile) deps.removeBootstrap(spec.bootstrapFile);
      const history = spec.providerSessionId ? { id: spec.providerSessionId } : null;
      deps.launchPlans.set(spec.terminalId, { agent: spec.agent, command: deps.launchCommand(spec.agent, history), threadId: history?.id || null });
      deps.store.setRestore(spec.terminalId, { nativeTransport: null });
      deps.startTerminal(spec.terminalId, true);
      const s = deps.sessions.get(spec.terminalId); if (s) { s.nativePathReason = reason; s.nativeRuntimeSessionId = spec.runtimeSessionId; }
    } };
}

function createNativeHost(deps) {
  return {
    initializeNativeSessions: initializeNativeSessions.bind(null, deps),
    createClaudeProvider: createClaudeProvider.bind(null, deps),
    createCodexProvider: createCodexProvider.bind(null, deps),
    wireNativeSessions: wireNativeSessions.bind(null, deps),
    nativeRouterOptions: nativeRouterOptions.bind(null, deps),
    registerUnavailableNative: registerUnavailableNative.bind(null, deps),
    roleEnded: roleEnded.bind(null, deps),
    tellMode: tellMode.bind(null, deps),
    tellRemoteRouting: tellRemoteRouting.bind(null, deps),
    takeModeNote: takeModeNote.bind(null, deps),
    nativeSubagent: nativeSubagent.bind(null, deps),
  };
}

module.exports = { createNativeHost };
