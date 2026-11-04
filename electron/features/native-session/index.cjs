const path = require('node:path');
const { createSettings } = require('./settings.cjs');
const { createRouter } = require('./router.cjs');
const { registerIpc } = require('./ipc.cjs');
const { choosePath } = require('./routing.cjs');
function createNativeSessions(options) {
  const storedSettings = createSettings(path.join(options.directory, 'settings.json'));
  const settings = { ...storedSettings, set(patch) {
    const result = storedSettings.set(patch); options.claude.resetAvailability?.(); router.reconcile(true); return result;
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
    async usage(projectId) {
      if (options.validateProject?.(projectId)?.kind === 'ssh') {
        const usage = router.usage({}, projectId);
        for (const agent of ['claude', 'codex']) usage.agents[agent] = { path: null, reason: null, next: { path: null, reason: null }, limits: null,
          connection: { kind: 'none', source: null, observedAt: null } };
        return { ...usage, switches: { waiting: 0 } };
      }
      const usage = router.usage(await options.usageInputs?.(projectId), projectId);
      const connections = await options.connections?.(projectId);
      for (const agent of ['claude', 'codex']) usage.agents[agent].connection = connections?.[agent] || { kind: 'none', source: null, observedAt: null };
      return usage;
    },
  };
  return { ...facade, getSettings: settings.get, register: handle => registerIpc({ handle, router: facade, settings, claude: options.claude }) };
}
module.exports = { createNativeSessions, createNativeUsage: require('./agent-usage.cjs').createNativeUsage };
