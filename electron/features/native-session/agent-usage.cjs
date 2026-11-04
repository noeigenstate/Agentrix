const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function createNativeUsage(agent) {
  let total = null, round = null, context = null, model = null, limits = [], limitsAt = null, limitsFrom = null;
  const tokens = value => {
    if (!value || count(value.input) === null || count(value.output) === null || count(value.cachedInput) === null) return null;
    const input = agent === 'claude' ? value.input + value.cachedInput + (count(value.cacheWrite) ?? 0) : value.input;
    return { input, cached: value.cachedInput, output: value.output };
  };
  return {
    apply(event) {
      if (event.replay && event.type === 'turn.started') return;
      const value = event.payload;
      if (event.type === 'turn.started') round = null;
      if (event.type === 'usage.updated') {
        total = tokens(value); round = tokens(value.round);
        context = count(value.contextTokens) !== null && count(value.contextWindow) > 0 ? { used: value.contextTokens, window: value.contextWindow } : null;
      }
      if (event.type === 'routing.updated') model = value.observed.model;
      if (event.type === 'limits.updated') {
        limits = Object.values(value.limitsById).flatMap(bucket => [bucket.primary, bucket.secondary]).filter(item => Number.isFinite(item?.usedPercent) && item.usedPercent >= 0 && item.usedPercent <= 100)
          .map(item => ({ minutes: item.windowDurationMins, percent: item.usedPercent, resetsAt: item.resetsAtMs }));
        limitsAt = value.observedAtMs; limitsFrom = value.source;
      }
    },
    snapshot(calls) { return { provider: agent === 'claude' ? 'Anthropic' : 'Codex', context, round, total, limits, limitsAt, limitsFrom, model, rate: null, calls: calls || [] }; },
  };
}
module.exports = { createNativeUsage };
