const { subscriptionLimits } = require('./usage.cjs');

// What the native sessions read from the app shell: each agent's connection and subscription limits as the running
// sessions and the account reads give them, the CLI checks, the spec a connection test runs with, and a native
// session's environment. `deps` is the app shell (main.cjs), read on every call so its late values are current; these
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
  // bootstrap file, with the Codex home its launch names.
  function nativeEnvironment(bootstrapFile, codexHome) {
    const { createTerminalEnvironment, withoutAppImage } = deps;
    const env = createTerminalEnvironment(withoutAppImage(process.env), bootstrapFile);
    if (codexHome) {
      for (const key of Object.keys(env)) if (key.toUpperCase() === 'CODEX_HOME') delete env[key];
      env.CODEX_HOME = codexHome;
    }
    return env;
  }

  return { readNativeConnections, liveHost, readNativeSubscriptionLimits, readNativeUsageInputs, connectionSpec, nativeEnvironment };
}

module.exports = { createHostInputs };
