const { nonnegative, text, modelOf, keyOf } = require('./summary-values.cjs');

function liveRuns(running) {
  const unique = new Map();
  for (const run of Array.isArray(running) ? running : []) {
    if (!run || !text(run.id)) continue;
    const rate = run.rate;
    const speed = nonnegative(rate?.outputTokens) && rate.activeMs > 0 && nonnegative(rate.activeMs) && rate.samples > 0
      ? rate.outputTokens * 1000 / rate.activeMs : null;
    const row = { id: text(run.id), project: text(run.project) || null, agent: text(run.agent, 32), model: modelOf(run.model), ...(run.modelUnconfirmed === true && { modelUnconfirmed: true }),
      title: text(run.title, 240), role: text(run.role, 32), startedAt: nonnegative(run.startedAt) ? run.startedAt : null,
      tokensPerSecond: nonnegative(speed) ? speed : null };
    unique.set(keyOf(row.project, row.id), row);
  }
  return [...unique.values()].sort((a, b) => (a.project || '').localeCompare(b.project || '') || a.id.localeCompare(b.id));
}

module.exports = { liveRuns };
