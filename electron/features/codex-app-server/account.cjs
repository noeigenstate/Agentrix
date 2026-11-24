const { accountScopeId } = require('../agents/codex-account-usage.cjs');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const time = value => count(value) !== null && Number.isSafeInteger(value * 1000) ? value * 1000 : null;

function restrictedLimits(previous, code, scopeId, now) {
  const reset = Object.values(previous?.limitsById || {}).flatMap(bucket => [bucket.primary, bucket.secondary])
    .filter(window => window?.usedPercent >= 100 && window.resetsAtMs >= now).map(window => window.resetsAtMs).sort((a, b) => a - b)[0] ?? null;
  const line = code === 'credits_required' ? 'Codex 额度不足，需要补充额度后继续。' : code === 'spend_limit' ? 'Codex 用量已达上限。' : 'Codex 请求受到限流。';
  return { scopeId, billingRoute: previous?.billingRoute || 'unknown', observedAtMs: now, state: 'unavailable', limitsById: previous?.limitsById || {},
    resetCredits: previous?.resetCredits || null, ordinaryUsageAllowed: false, source: 'codex-app-server', providerStatus: 'rejected',
    notice: { code, resetsAtMs: reset, message: line } };
}

function mergeLimits(previous, update, scopeId, now = Date.now()) {
  const buckets = { ...previous?.limitsById };
  const supplied = Object.keys(update.rateLimitsByLimitId || {}).length ? update.rateLimitsByLimitId : (update.rateLimits ? { [update.rateLimits.limitId || 'codex']: update.rateLimits } : {});
  for (const [id, raw] of Object.entries(supplied)) {
    if (!raw || typeof raw !== 'object') continue;
    const bucket = { ...buckets[id] };
    for (const name of ['primary', 'secondary']) {
      if (!(name in raw)) continue;
      const value = raw[name];
      bucket[name] = value === null ? null : {
        usedPercent: Number.isFinite(value.usedPercent) && value.usedPercent >= 0 && value.usedPercent <= 100 ? value.usedPercent : null,
        windowDurationMins: count(value.windowDurationMins), resetsAtMs: time(value.resetsAt),
      };
    }
    buckets[id] = bucket;
  }
  const resetCredits = 'rateLimitResetCredits' in update
    ? (update.rateLimitResetCredits ? { availableCount: count(update.rateLimitResetCredits.availableCount) } : null)
    : previous?.resetCredits ?? null;
  const ordinaryUsageAllowed = 'ordinaryUsageAllowed' in update
    ? (typeof update.ordinaryUsageAllowed === 'boolean' ? update.ordinaryUsageAllowed : null) : previous?.ordinaryUsageAllowed ?? null;
  // Quota snapshots describe windows and controls. Only a turn result can establish a request refusal.
  const notice = ordinaryUsageAllowed === true ? null : previous?.notice ?? null;
  return { scopeId, billingRoute: previous?.billingRoute || 'unknown', observedAtMs: now,
    state: ordinaryUsageAllowed === false || notice ? 'unavailable' : 'ready', limitsById: buckets, resetCredits, ordinaryUsageAllowed,
    source: 'codex-app-server', ...(notice ? { notice, providerStatus: 'rejected' } : { notice: null }) };
}

function tokenUsage(value, baseline = null) {
  const total = value?.total || {};
  const tokens = { input: count(total.inputTokens), cachedInput: count(total.cachedInputTokens), cacheWrite: count(total.cacheWriteInputTokens),
    output: count(total.outputTokens), reasoning: count(total.reasoningOutputTokens) };
  const round = baseline ? Object.fromEntries(Object.entries(tokens).map(([key, value]) => [key, value === null || baseline[key] === null ? null : count(value - baseline[key])])) : null;
  return { ...tokens,
    contextWindow: count(value?.modelContextWindow),
    costUsdMicros: null, costEstimated: false,
    contextTokens: count(value?.last?.totalTokens), round };
}

// A known account carries the same opaque name the account reader gives it, so a switch between two accounts of one
// kind is seen without waiting for account/updated. A dispatch helper passes main's account key (accountKey).
function accountConnection(result, observedAt = Date.now(), accountKey) {
  const type = result?.account?.type;
  const kind = result?.account === null ? 'none' : type === 'apiKey' ? 'api' : ['chatgpt', 'chatgptAuthTokens'].includes(type) ? 'subscription' : 'unknown';
  return { kind, source: 'codex-app-server account/read', observedAt, ...(kind === 'unknown' ? {} : { scopeId: accountScopeId(result.account, accountKey) }) };
}
module.exports = { mergeLimits, tokenUsage, accountConnection, restrictedLimits };
