const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const time = value => count(value) !== null && Number.isSafeInteger(value * 1000) ? value * 1000 : null;

function mergeLimits(previous, update, scopeId, now = Date.now()) {
  const buckets = { ...previous?.limitsById };
  const supplied = update.rateLimitsByLimitId || (update.rateLimits ? { [update.rateLimits.limitId || 'codex']: update.rateLimits } : {});
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
  return { scopeId, billingRoute: previous?.billingRoute || 'unknown', observedAtMs: now, state: 'ready', limitsById: buckets,
    resetCredits, ordinaryUsageAllowed: 'ordinaryUsageAllowed' in update ? (typeof update.ordinaryUsageAllowed === 'boolean' ? update.ordinaryUsageAllowed : null) : previous?.ordinaryUsageAllowed ?? null,
    source: 'codex-app-server' };
}

function tokenUsage(value) {
  const total = value?.total || {};
  return { input: count(total.inputTokens), cachedInput: count(total.cachedInputTokens), cacheWrite: null,
    output: count(total.outputTokens), reasoning: count(total.reasoningOutputTokens), contextWindow: count(value?.modelContextWindow),
    costUsdMicros: null, costEstimated: false };
}

module.exports = { mergeLimits, tokenUsage };
