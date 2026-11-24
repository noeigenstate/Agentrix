const { readClaudeAccount } = require('../agents/claude-account-usage.cjs');
const { readCodexAccount } = require('../agents/codex-account-usage.cjs');

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

module.exports = { claude, codex };
