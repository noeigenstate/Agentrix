const os = require('node:os');
const path = require('node:path');
const { readClaudeAccount } = require('../agents/claude-account-usage.cjs');
const { readCodexAccount } = require('../agents/codex-account-usage.cjs');
const { readAgyAccount, agyAccountLimits, isUsageGroup, QUOTA_INTERVAL } = require('../agy-acp/usage.cjs');
const { localModel } = require('./registry.mjs');

const claude = {
  accountReader: readClaudeAccount,
  applyRecord: (meter, record) => meter.applyClaude(record),
  observeCachedAccount: (meter, account, direct) => meter.observeClaudeAccount(account, direct),
  terminal: {
    bindRemote: (session, { bindRemoteClaudeAccount }) => bindRemoteClaudeAccount(session),
    bindLocal: ({ cwd }, { loadClaudeProvider, refreshClaudeAccounts }) => {
      loadClaudeProvider(cwd);
      void refreshClaudeAccounts();
    },
  },
  dashboardSession: session => session.claudeSessionId || session.claudeResumeId,
  quotaHome: (_session, env) => env.CLAUDE_CONFIG_DIR,
  defaultHome: '.claude',
};
const codex = {
  accountReader: readCodexAccount,
  applyRecord: (meter, record) => meter.applyCodex(record),
  observeResetAccount: (meter, account) => meter.observeCodexAccount(account),
  terminal: {
    bind: (session, project, event, { bindCodexAccount }) => bindCodexAccount(project, session, event),
    bindLocal: ({ codexHome }, { loadCodexProviders }) => loadCodexProviders(codexHome),
    refreshAtRollover: session => session.usageAccount?.refresh(),
    refreshOnRecord(session, record) {
      if (record?.type === 'session_meta') session.bindUsageAccount?.();
      if (session.usageHistory || record?.type !== 'event_msg') return;
      if (record.payload?.type === 'token_count') session.usageAccount?.refresh(30000);
      else if (['task_complete', 'turn_completed'].includes(record.payload?.type)) session.usageAccount?.refresh();
    },
  },
  dashboardSession: session => session.rootThreadId || session.reportedThreadId,
  quotaHome: (session, env) => session.codexHome || env.CODEX_HOME,
  defaultHome: '.codex',
};

const agy = {
  accountReader: readAgyAccount,
  focusedLimits: agyAccountLimits,
  focusedInterval: QUOTA_INTERVAL,
  quotaGroupId: id => isUsageGroup(id) ? id : null,
  quotaGroupOfModel(model) {
    const id = localModel(model);
    return id === 'unreported' ? null : id.startsWith('gemini-') ? 'gemini' : '3p';
  },
  dashboardSession: session => session.reportedThreadId,
  quotaHome: (_session, env) => path.resolve(env.USERPROFILE || env.HOME || os.homedir(), '.gemini'),
};

module.exports = { claude, codex, agy };
