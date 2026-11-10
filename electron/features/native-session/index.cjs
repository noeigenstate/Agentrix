const path = require('node:path');
const { createSettings } = require('./settings.cjs');
const { createRouter } = require('./router.cjs');
const { registerIpc } = require('./ipc.cjs');
const { choosePath } = require('./routing.cjs');
const { accountChanged, retainConnection, retainLimits } = require('../agents/agent-usage.cjs');
// Nothing tells this module that a project was removed, so it holds the last usage of the most recently read ones.
const HELD_PROJECTS = 64;
function createNativeSessions(options) {
  // Per project: its read counter, the last usage sent and, per agent, the time a quota that names no account must be newer than.
  const projects = new Map();
  const storedSettings = createSettings(path.join(options.directory, 'settings.json'));
  const settings = { ...storedSettings, set(patch) {
    const result = storedSettings.set(patch);
    if (Object.keys(patch).some(key => key !== 'codexAutoReset')) { options.claude.resetAvailability?.(); router.reconcile(true); }
    return result;
  } };
  const router = createRouter({ ...options, settings });
  async function testConnection(projectId) {
    if (options.validateProject?.(projectId)?.kind === 'ssh') projectId = undefined;
    const result = await options.claude.testConnection({ ...settings.get(), projectId }), config = settings.get();
    const failures = { missing: 'no_key', invalid: 'invalid_key', forbidden: 'API 密钥没有模型列表权限。',
      rate_limited: 'rate_limited', unreachable: '无法连接 Anthropic API。', error: '无法完成 API 连接检查。' };
    const reason = result.key.status !== 'ok' ? failures[result.key.status]
      : result.cli.status === 'too_old' ? 'Claude Code 版本过低，请升级到 2.1.317 或更高'
        : result.cli.status === 'missing' ? 'native_cli_required'
          : result.billing?.status !== 'ok' ? result.reason || '无法确认 Claude Code 的计费来源。' : null;
    const selection = choosePath({ agent: 'claude', ...config,
      apiState: reason ? { reason } : options.claude.apiState(config.monthlyBudgetUsd, projectId) });
    router.reconcile();
    return { ...result, ...selection, reason: reason || selection.reason };
  }
  const facade = { ...router, testConnection,
    async close() { projects.clear(); await router.close(); },
    async usage(projectId) {
      const remote = options.validateProject?.(projectId)?.kind === 'ssh';
      const key = `${remote ? 'ssh' : 'local'}:${projectId || ''}`, project = projects.get(key) || { revision: 0, floor: {} };
      projects.delete(key); projects.set(key, project);
      if (projects.size > HELD_PROJECTS) projects.delete(projects.keys().next().value);
      const revision = ++project.revision;
      const inputs = remote ? {} : await Promise.resolve().then(() => options.usageInputs?.(projectId)).catch(() => undefined);
      const usage = router.usage(inputs, projectId);
      const connections = await Promise.resolve().then(() => options.connections?.(projectId)).catch(() => null);
      const previous = project.usage;
      if (project.revision !== revision && previous) for (const agent of ['claude', 'codex']) {
        usage.agents[agent] = { ...previous.agents[agent], limits: usage.agents[agent].limits };
      }
      for (const agent of ['claude', 'codex']) {
        if (remote && agent === 'claude') continue;
        const state = usage.agents[agent], held = previous?.agents[agent];
        // What the account reader named and what main read from the session, oldest first: each is an observation of its
        // own, so the session's (which may name no account) does not hide the reader's by being the later of the two.
        const session = connections?.[agent], account = inputs?.limits?.[agent]?.accountConnection;
        const observed = (session?.kind === 'api' && session.active) || !Number.isFinite(account?.observedAt) ? [session]
          : [{ ...account, active: session?.active ?? false }, session].sort((a, b) => (a?.observedAt ?? -Infinity) - (b?.observedAt ?? -Infinity));
        state.connection = observed.reduce((connection, next) => retainConnection(connection, next), held?.connection)
          || { kind: 'unknown', active: false, source: null, observedAt: null };
        const changed = accountChanged(held?.connection, state.connection);
        // Quota is shown only for the account now observed. A reading that names its account must name this one. One
        // that names none (a session's, which the router may hold from before the change) must be newer than the change
        // and than what the earlier account showed; the account's own read then stands in for it.
        if (changed) project.floor[agent] = Math.max(state.connection.observedAt ?? -Infinity, held.limits?.observedAtMs ?? -Infinity);
        const floor = project.floor[agent];
        const own = limits => limits && (limits.accountScopeId && state.connection.scopeId ? limits.accountScopeId === state.connection.scopeId
          : floor == null || limits.observedAtMs > floor) ? limits : null;
        state.limits = retainLimits(changed ? null : held?.limits, own(state.limits) || own(inputs?.limits?.[agent])) || null;
        if (state.connection.kind === 'none' && Number.isFinite(state.connection.observedAt)) state.limits = null;
      }
      if (remote) {
        usage.agents.claude = { path: null, reason: null, next: { path: null, reason: null }, limits: null,
          connection: { kind: 'none', active: false, source: null, observedAt: null } };
        usage.agents.codex.next = { path: 'native', reason: null }; usage.switches = { waiting: 0 };
      }
      project.usage = structuredClone(usage);
      return usage;
    },
  };
  return { ...facade, getSettings: settings.get, register: handle => registerIpc({ handle, router: facade, settings, claude: options.claude }) };
}
module.exports = { createNativeSessions, createNativeUsage: require('./agent-usage.cjs').createNativeUsage };
