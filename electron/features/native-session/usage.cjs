const { decide, nameOf } = require('../claude-runtime/decide.cjs');
const { cliFact } = require('../claude-runtime/resolver.cjs');
const { adapterOf } = require('../cli-adapters/registry.cjs');

// What a new session takes, in the usage panel's words: only the CLI check given here counts (an SSH project gives none,
// and this computer's CLI is not its), and a path the settings chose says so (set_terminal, set_api).
const SAID = { terminal_selected: 'set_terminal', native_cli_required: 'cli_missing', cli_too_old: 'cli_too_old' };
function nextPath(agent, config, facts = [], cli) {
  const policy = adapterOf(agent)?.nativePolicy;
  const fact = cliFact(cli);
  if (!policy?.usesClaudeAvailability) return fact ? { path: null, reason: SAID[nameOf(fact.reason)] ?? nameOf(fact.reason) }
    : { path: policy?.path ?? null, reason: null };
  const given = [...facts.filter(value => value.name !== 'cli'), fact].filter(Boolean);
  const { path, reason, wire } = decide(given, config, { agent });
  if (path === 'api') return { path, reason: config.claudePath === 'api-only' ? 'set_api' : null };
  return { path, reason: SAID[nameOf(reason)] ?? wire };
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

function expireQuotaWindows(limits, now) {
  if (!limits) return limits;
  const limitsById = Object.fromEntries(Object.entries(limits.limitsById || {}).map(([id, group]) => [id,
    Object.fromEntries(Object.entries(group).map(([slot, window]) => [slot,
      Number.isFinite(window?.resetsAtMs) && window.resetsAtMs <= now ? { ...window, usedPercent: null } : window]))]));
  return { ...limits, limitsById };
}

module.exports = { nextPath, subscriptionLimits, expireQuotaWindows };
