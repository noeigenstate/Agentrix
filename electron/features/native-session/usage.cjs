const { choosePath } = require('./routing.cjs');

// A CLI found but not verified (its check timed out, failed or printed no version) is not called missing.
const cliReason = cli => cli.status === 'too_old' ? 'cli_too_old' : cli.reason && cli.reason !== 'not_found' ? 'native_cli_unverified' : 'cli_missing';
function nextPath(agent, config, apiState, cli) {
  if (agent === 'codex') {
    return ['missing', 'too_old'].includes(cli?.status) ? { path: null, reason: cliReason(cli) } : choosePath({ agent });
  }
  if (config.claudePath === 'terminal-only') return { path: 'terminal', reason: 'set_terminal' };
  const selection = choosePath({ agent, ...config, apiState });
  if (selection.path === 'api' && ['missing', 'too_old'].includes(cli?.status)) {
    return choosePath({ agent, ...config, apiState: { reason: cliReason(cli) } });
  }
  if (selection.reason === 'native_cli_required') selection.reason = 'cli_missing';
  if (selection.path === 'api' && config.claudePath === 'api-only') selection.reason = 'set_api';
  return selection;
}

// Account readers already normalize reset times to milliseconds. Never query or scale them again here.
function subscriptionLimits(account, scopeId, staleAfterMs, now = Date.now()) {
  if (!account) return null;
  const connection = account.connection;
  const signedOut = connection?.kind === 'none' && Number.isFinite(connection.observedAt);
  const windows = signedOut ? [] : (account.limits || []).filter(value => Number.isFinite(value.percent) && value.percent >= 0);
  const left = account.resets?.left;
  if (!windows.length && !account.resetQuery && !Number.isSafeInteger(left) && !Number.isFinite(connection?.observedAt)) return null;
  const bucket = {};
  for (const [index, value] of windows.slice(0, 2).entries()) {
    const name = value.minutes === 10080 ? 'secondary' : value.minutes === 300 ? 'primary' : index === 0 ? 'primary' : 'secondary';
    bucket[name] = { usedPercent: value.percent, windowDurationMins: Number.isFinite(value.minutes) ? value.minutes : null,
      resetsAtMs: Number.isFinite(value.resetsAt) ? value.resetsAt : null };
  }
  const observedAtMs = windows.length && Number.isFinite(account.at) ? account.at : Number.isFinite(connection?.observedAt) ? connection.observedAt : Number.isFinite(account.at) ? account.at : null;
  const readable = !signedOut && (windows.length > 0 || Number.isSafeInteger(left) && left >= 0);
  const state = readable ? observedAtMs !== null && now - observedAtMs > staleAfterMs ? 'stale' : 'ready'
    : ['loading', 'error', 'unavailable'].includes(account.resetQuery?.state) ? account.resetQuery.state : 'unavailable';
  // accountScopeId names the account these numbers were read for, so they are never kept for or merged into another's.
  const result = { scopeId: connection?.scopeId ? `${scopeId}:${connection.scopeId}` : scopeId, accountScopeId: connection?.scopeId || null,
    billingRoute: 'subscription', observedAtMs, state,
    limitsById: windows.length ? { subscription: bucket } : {},
    resetCredits: !signedOut && Number.isSafeInteger(left) && left >= 0 ? { availableCount: left } : null,
    ordinaryUsageAllowed: null, source: account.source || scopeId };
  // Host-only evidence: the facade can compare a cache/account observation with
  // an older terminal-login placeholder. This metadata never crosses IPC.
  return Object.defineProperty(result, 'accountConnection', { value: connection });
}

module.exports = { nextPath, subscriptionLimits };
