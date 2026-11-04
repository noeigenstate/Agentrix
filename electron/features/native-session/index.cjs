const path = require('node:path');
const { createSettings } = require('./settings.cjs');
const { createRouter } = require('./router.cjs');
const { registerIpc } = require('./ipc.cjs');
const { choosePath } = require('./routing.cjs');
function createNativeSessions(options) {
  const settings = createSettings(path.join(options.directory, 'settings.json'));
  const router = createRouter({ ...options, settings });
  async function testConnection() {
    const result = await options.claude.testConnection(), config = settings.get();
    const failures = { missing: 'no_key', invalid: 'invalid_key', forbidden: 'API 密钥没有模型列表权限。',
      rate_limited: 'rate_limited', unreachable: '无法连接 Anthropic API。', error: '无法完成 API 连接检查。' };
    const reason = result.key.status !== 'ok' ? failures[result.key.status]
      : result.cli.status === 'too_old' ? 'Claude Code 版本过低，请升级到 2.1.317 或更高'
        : result.cli.status === 'missing' ? 'native_cli_required' : null;
    const selection = choosePath({ agent: 'claude', ...config,
      apiState: reason ? { reason } : options.claude.apiState(config.monthlyBudgetUsd) });
    return { ...result, ...selection };
  }
  const facade = { ...router, testConnection,
    async usage() {
      const usage = router.usage(await options.usageInputs?.());
      const connections = await options.connections?.();
      for (const agent of ['claude', 'codex']) usage.agents[agent].connection = connections?.[agent] || { kind: 'none', source: null, observedAt: null };
      return usage;
    },
  };
  return { ...facade, getSettings: settings.get, register: handle => registerIpc({ handle, router: facade, settings, claude: options.claude }) };
}
module.exports = { createNativeSessions };
