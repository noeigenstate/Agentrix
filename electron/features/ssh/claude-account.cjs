const { ClaudeAccountUsage } = require('../agents/claude-account-usage.cjs');

// The SSH boundary accepts numbers and fixed status words, never a remote response body or error message.
function remoteClaudeResult(value) {
  if (value?.state === 'ready') {
    const account = value.account;
    if (!Number.isFinite(account?.at) || account.at < 0 || !Array.isArray(account.limits) || !account.limits.length || account.limits.length > 2) return { state: 'error', reason: 'response' };
    const seen = new Set(), limits = [];
    for (const limit of account.limits) {
      if (![300, 10080].includes(limit?.minutes) || seen.has(limit.minutes) || !Number.isFinite(limit.percent) || limit.percent < 0 ||
        limit.resetsAt !== null && (!Number.isFinite(limit.resetsAt) || limit.resetsAt < 0)) return { state: 'error', reason: 'response' };
      seen.add(limit.minutes);
      limits.push({ minutes: limit.minutes, percent: limit.percent, resetsAt: limit.resetsAt });
    }
    return { state: 'ready', account: { limits, at: account.at, source: 'Claude' } };
  }
  if (value?.state === 'skipped' && ['route', 'credentials', 'scope', 'expired', 'cancelled', 'throttled'].includes(value.reason)) return { state: 'skipped', reason: value.reason };
  const reason = ['http', 'query', 'timeout', 'response', 'cancelled'].includes(value?.reason) ? value.reason : 'response';
  return { state: 'error', reason, ...(reason === 'http' && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? { status: value.status } : {}),
    ...(Number.isFinite(value?.retryAfterMs) && value.retryAfterMs >= 0 ? { retryAfterMs: Math.min(value.retryAfterMs, 900000) } : {}) };
}

function watchRemoteClaudeAccount(remote, changed, { current = () => true, ...options } = {}) {
  const poller = new ClaudeAccountUsage({ ...options,
    read: async ({ signal, beforeRequest }) => {
      if (signal.aborted || !current()) return { state: 'skipped', reason: 'cancelled' };
      if (!beforeRequest()) return { state: 'skipped', reason: 'throttled' };
      try {
        const value = await remote.request('claude-account', {}, { signal, timeout: 7000 });
        return signal.aborted || !current() ? { state: 'skipped', reason: 'cancelled' } : remoteClaudeResult(value);
      } catch { return { state: 'error', reason: 'query' }; }
    },
    changed: account => { if (current()) changed(account); },
  });
  poller.setActive(true);
  // A session's account watcher (s.usageAccount) is also fed each terminal chunk; Claude's limits come only from the poll.
  return { get account() { return poller.account; }, refresh: () => poller.refresh(), output() {}, dispose: () => poller.dispose() };
}

module.exports = { remoteClaudeResult, watchRemoteClaudeAccount };
