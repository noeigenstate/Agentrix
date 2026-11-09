const path = require('node:path');
const { createSettings } = require('./settings.cjs');
const { createRouter } = require('./router.cjs');
const { registerIpc } = require('./ipc.cjs');
const { choosePath } = require('./routing.cjs');
const { accountChanged, retainConnection, retainLimits } = require('../agents/agent-usage.cjs');
function createNativeSessions(options) {
  const observations = new Map(), reads = new Map();
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
    async close() { observations.clear(); reads.clear(); await router.close(); },
    async usage(projectId) {
      const remote = options.validateProject?.(projectId)?.kind === 'ssh';
      const key = `${remote ? 'ssh' : 'local'}:${projectId || ''}`, revision = (reads.get(key) || 0) + 1;
      reads.set(key, revision);
      const inputs = remote ? {} : await Promise.resolve().then(() => options.usageInputs?.(projectId)).catch(() => undefined);
      const usage = router.usage(inputs, projectId);
      const connections = await Promise.resolve().then(() => options.connections?.(projectId)).catch(() => null);
      const previous = observations.get(key);
      if (reads.get(key) !== revision && previous) for (const agent of ['claude', 'codex']) {
        usage.agents[agent] = { ...previous.agents[agent], limits: usage.agents[agent].limits };
      }
      for (const agent of ['claude', 'codex']) {
        if (remote && agent === 'claude') continue;
        const state = usage.agents[agent], held = previous?.agents[agent];
        let incoming = connections?.[agent];
        const account = inputs?.limits?.[agent]?.accountConnection;
        if (!(incoming?.kind === 'api' && incoming.active) && Number.isFinite(account?.observedAt) &&
          account.observedAt > (incoming?.observedAt ?? -Infinity)) incoming = { ...account, active: incoming?.active ?? false };
        state.connection = retainConnection(held?.connection, incoming) || { kind: 'unknown', active: false, source: null, observedAt: null };
        const changed = accountChanged(held?.connection, state.connection);
        // A router may still hold the previous runtime's last limits. A newly
        // observed account must not inherit that same old payload.
        if (changed && state.limits?.scopeId === held?.limits?.scopeId &&
          (state.limits?.observedAtMs ?? -Infinity) <= (held?.limits?.observedAtMs ?? -Infinity)) state.limits = null;
        state.limits = retainLimits(changed ? null : held?.limits, state.limits) || null;
        if (state.connection.kind === 'none' && Number.isFinite(state.connection.observedAt)) state.limits = null;
      }
      if (remote) {
        usage.agents.claude = { path: null, reason: null, next: { path: null, reason: null }, limits: null,
          connection: { kind: 'none', active: false, source: null, observedAt: null } };
        usage.agents.codex.next = { path: 'native', reason: null }; usage.switches = { waiting: 0 };
      }
      observations.set(key, structuredClone(usage));
      return usage;
    },
  };
  return { ...facade, getSettings: settings.get, register: handle => registerIpc({ handle, router: facade, settings, claude: options.claude }) };
}
module.exports = { createNativeSessions, createNativeUsage: require('./agent-usage.cjs').createNativeUsage };
