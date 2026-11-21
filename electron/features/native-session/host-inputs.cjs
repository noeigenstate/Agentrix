const { subscriptionLimits } = require('./usage.cjs');
const fs = require('node:fs');
const path = require('node:path');

// What the native sessions read from the app shell: each agent's connection and subscription limits as the running
// sessions and the account reads give them, the CLI checks, the spec a connection test runs with, and a native
// session's environment and spec. `deps` is the app shell (main.cjs), read on every call so its late values are current; these
// functions are among its members and reach each other through it too.
function createHostInputs(deps) {
  async function readNativeConnections(projectId) {
    const { sessions, projectAccounts, claudeRuntime, liveHost } = deps;
    const result = {}, observed = new Map();
    for (const agent of ['claude', 'codex']) {
      const host = liveHost(projectId, agent);
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

  // The agent's running session in a project (any project without one), the latest started.
  function liveHost(projectId, agent) {
    const { sessions } = deps;
    return [...sessions.values()].reverse().find(s => (!projectId || s.projectId === projectId) && s.agent === agent && s.codexActive === true && s.status !== 'exited');
  }

  function readNativeSubscriptionLimits(projectId) {
    const { projectAccounts, claudeAccounts, codexAccounts, localClaudeMeters, dispatchReading } = deps;
    const latest = candidates => candidates.filter(Boolean).sort((a, b) => (b.observedAtMs ?? -Infinity) - (a.observedAtMs ?? -Infinity))[0] || null;
    const account = projectAccounts.snapshot(projectId);
    const claude = [subscriptionLimits(account?.claude || (!projectId ? claudeAccounts.account : null), 'claude-account', 120000)];
    // Meters also hold the existing local-cache fallback. Reading them must never refresh an account.
    for (const s of localClaudeMeters()) if ((!projectId || s.projectId === projectId) && s.usage.limits.length) claude.push(subscriptionLimits({
      limits: s.usage.limits, at: s.usage.limitsAt, source: s.usage.limitsFrom }, 'claude-account', 120000));
    const codex = projectId ? [subscriptionLimits(account?.codex, 'codex-account', 2 * codexAccounts.interval), dispatchReading(projectId, account?.codex, 2 * codexAccounts.interval)]
      : [...codexAccounts.entries].map(([key, entry]) => subscriptionLimits(entry.value, key, 2 * codexAccounts.interval));
    return { claude: latest(claude), codex: latest(codex) };
  }

  async function readNativeUsageInputs(projectId) {
    const { shellPathReady, checkClaude, codexExecutable, projectAccounts, nativeEnvironment, readNativeSubscriptionLimits } = deps;
    if (projectId) await shellPathReady;
    const [claudeCli, codexFile] = await Promise.all([checkClaude(), codexExecutable()]);
    const cli = { claude: claudeCli, codex: { status: codexFile ? 'ok' : 'missing' } };
    // Read after the checks: the app can start quitting, or the project close, while they run.
    const { store } = deps, project = store.projects.find(project => project.id === projectId);
    if (project && project.kind !== 'ssh') {
      if (!deps.quitting && store.projects.includes(project)) await projectAccounts.read(project, { cli, env: nativeEnvironment('') });
    }
    return { cli, limits: readNativeSubscriptionLimits(projectId) };
  }

  function connectionSpec(projectId) {
    const { store } = deps;
    const project = projectId && store.projects.find(project => project.id === projectId);
    if (projectId && (!project || project.kind === 'ssh')) throw new Error('原生会话仅支持本地项目。');
    return { agent: 'claude', owner: 'gui', projectId, cwd: project?.path || process.cwd(), effort: 'high', fast: true };
  }

  // The environment a native session's CLI runs with, and an account read: a terminal's, pointed at the session's
  // bootstrap file, with the Codex home its launch names. A planner's env has the shims; the owner's own commands
  // (`planner: false`) run without them.
  function nativeEnvironment(bootstrapFile, codexHome, { planner = true } = {}) {
    const { createTerminalEnvironment, withoutAppImage } = deps;
    let env = createTerminalEnvironment(withoutAppImage(process.env), bootstrapFile, { allowBackgroundTasks: deps.store?.settings?.claudeBackgroundTasks });
    if (planner && bootstrapFile && fs.existsSync(bootstrapFile)) {
      const { shims } = JSON.parse(fs.readFileSync(bootstrapFile, 'utf8'));
      if (shims) env = require(path.join(shims, 'intercept.cjs')).withShims(env, { depth: 0 });
    }
    if (codexHome) {
      for (const key of Object.keys(env)) if (key.toUpperCase() === 'CODEX_HOME') delete env[key];
      env.CODEX_HOME = codexHome;
    }
    return env;
  }

  // The spec a native session starts with, the router's resolveSpec: it clears the terminal's ended host, asks the
  // skills library for the session's delivery, writes the bootstrap file and keeps the spec in nativeSpecs.
  function nativeSpec(id, agent, resume, validateOnly = false, launch = null) {
    const { findProject, sessions, nativeSpecs, store, randomUUID, skills } = deps;
    const project = findProject(id), old = sessions.get(id);
    if (project.kind === 'ssh' && agent !== 'codex') throw new Error('SSH 原生会话目前仅支持 Codex。');
    if (validateOnly) return;
    if (old?.nativeStructured && old.status !== 'exited') return old.nativeSpec;
    if (old?.codexActive && old.status !== 'exited') throw new Error('请先停止当前会话。');
    if (old) deps.disposeTerminal(id, { preserveNative: !!old.nativeStructured, preserveCalls: true });
    const saved = store.findTerminal(id).record.restore;
    const cwd = launch?.cwd || (resume ? saved?.cwd || project.path : project.path);
    const savedThread = resume && (saved?.agent || 'codex') === agent ? saved?.threadId || null : null;
    const providerSessionId = launch?.latest ? null : launch?.providerSessionId || savedThread;
    // A Codex session runs with the permissions Settings say when it is made; /permissions changes only that session afterwards.
    const lead = skills?.leadOptions?.(project.id, agent);
    const runOptions = { model: lead?.model ?? null, effort: lead?.effort ?? null, fast: lead ? lead.fast === true : null,
      ...(agent === 'codex' ? { permissions: store.settings.codexPermissions } : {}) };
    const sessionId = randomUUID(), sessionKey = randomUUID(), controlCapability = randomUUID();
    if (project.kind === 'ssh') {
      skills?.delivery?.(project, true, sessionId, { agent, started: true });
      const spec = { agent, owner: 'gui', kind: 'ssh', projectId: project.id, terminalId: id,
        sessionId, sessionKey, cwd, env: {}, ...runOptions, providerSessionId };
      nativeSpecs.set(id, spec); return spec;
    }
    // The outbox is beside this file and outlives a host process restart.
    const bootstrapFile = path.join(deps.runtimeDir, `${id}.json`);
    const conductor = !!skills?.seatsInfo?.(project.id)?.conductor;
    const delivery = skills?.delivery?.(project, false, sessionId, { agent, started: true });
    const dispatchSnapshot = deps.writeBootstrap({ file: bootstrapFile, eventServer: deps.eventServer, projectId: id, projectPath: project.path,
      sessionKey, controlAddress: deps.controlAddress, controlCapability, claudeBackgroundTasks: store.settings?.claudeBackgroundTasks,
      dispatchSeats: delivery?.agentSeats ?? null, conductor });
    // The owner's own ! commands run without the shims: a typed claude or codex is the real CLI.
    const env = deps.nativeEnvironment(bootstrapFile, launch?.codexHome);
    const shellEnv = deps.nativeEnvironment(bootstrapFile, launch?.codexHome, { planner: false });
    const context = deps.startupNote(deps.READING_NOTE, deps.handoffFile(id), path.join(project.path, 'skills'), delivery);
    const spec = { agent, owner: 'gui', projectId: project.id, terminalId: id, cwd, env, shellEnv, context,
      sessionId, sessionKey, bootstrapFile, controlCapability, ...runOptions, seatsMap: delivery?.agentSeats, providerSessionId,
      roleServer: roleServer(env) };
    env.AGENTRIX_SEATS = agent === 'codex' ? dispatchSnapshot ?? 'null' : JSON.stringify(spec.seatsMap ?? null);
    if (agent === 'claude') spec.onSubagent = (signal, binding) => deps.nativeSubagent(spec, signal, binding);
    if (agent === 'claude') spec.onSeat = (observed, binding) => deps.nativeSubagent(spec, { ...observed, kind: 'seat', terminalId: id }, binding);
    const running = s => s.codexActive && [s.claudeSessionId, s.reportedThreadId, s.claudeResumeId].includes(spec.providerSessionId);
    if (spec.providerSessionId && [...sessions.values()].some(running)) throw new Error('该会话正在其他终端运行。');
    nativeSpecs.set(id, spec); return spec;
  }

  // The conductor's role tools, served by the worker engine over MCP stdio. Every lead has them and they refuse in native
  // mode, so a session started in native mode can call roles once the owner switches it.
  function roleServer(env) {
    return { command: process.execPath, args: [path.join(deps.integrationDir, 'dispatch.cjs'), 'mcp'], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
  }

  return { readNativeConnections, liveHost, readNativeSubscriptionLimits, readNativeUsageInputs, connectionSpec, nativeEnvironment, nativeSpec };
}

module.exports = { createHostInputs };
