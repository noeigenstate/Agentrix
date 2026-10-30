// What a finished run would cost at public API prices (the dashboard also shows the subscription quota used, which is
// a different thing). Pure: the caller loads prices.json and passes it in.

// A model id as a run reports it: "claude-opus-5-5[1m]", "claude-sonnet-5-5-20260101" and "gpt-6.1-sol" all name a
// price row without their context-window or date suffix.
const modelKey = model => String(model ?? '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');

const count = value => Number.isFinite(value) && value >= 0;

function priceOf(model, prices) {
  const wanted = modelKey(model);
  if (!wanted) return null;
  const row = Object.entries(prices?.models ?? {}).find(([id]) => modelKey(id) === wanted)?.[1];
  return row?.currency === 'USD' ? row : null;
}

// inputTokens is the input that missed the cache and cachedTokens the cache reads, so the three parts add up and no
// token is charged twice. A run missing any count, or a model missing a price it needs, has no estimate: unknown, never 0.
function estimateCost(run, prices) {
  if (count(run?.reportedCostUsd)) return { usd: run.reportedCostUsd, basis: 'reported' };
  const { inputTokens, cachedTokens, outputTokens } = run ?? {};
  const price = priceOf(run?.model, prices);
  const priced = (tokens, perM) => tokens === 0 || Number.isFinite(perM);
  if (!price || ![inputTokens, cachedTokens, outputTokens].every(count)
    || !priced(inputTokens, price.inputPerM) || !priced(cachedTokens, price.cachedInputPerM) || !priced(outputTokens, price.outputPerM)) {
    return { usd: null, basis: 'unknown' };
  }
  const part = (tokens, perM) => tokens === 0 ? 0 : tokens * perM;
  const usd = (part(inputTokens, price.inputPerM) + part(cachedTokens, price.cachedInputPerM) + part(outputTokens, price.outputPerM)) / 1e6;
  return { usd, basis: 'estimated' };
}

module.exports = { estimateCost };
