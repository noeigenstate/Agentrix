const { readJson, writeJson } = require('../native-session/storage.cjs');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const micros = value => Number.isFinite(value) && value >= 0 ? count(Math.round(value * 1e6)) : null;
const utcDay = at => new Date(at).toISOString().slice(0, 10);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function snapshotOf(result) {
  const models = Object.values(result.modelUsage || {});
  const sum = field => models.length && models.every(model => count(model[field]) !== null)
    ? count(models.reduce((total, model) => total + model[field], 0)) : null;
  const windows = new Set(models.map(model => count(model.contextWindow)));
  return { input: sum('inputTokens'), cachedInput: sum('cacheReadInputTokens'), cacheWrite: sum('cacheCreationInputTokens'),
    output: sum('outputTokens'), reasoning: null, contextWindow: windows.size === 1 ? [...windows][0] : null,
    costUsdMicros: micros(result.total_cost_usd), costEstimated: true };
}
function validUsage(value) {
  return object(value) && value.version === 1 && object(value.days) && object(value.sessions) &&
    (value.unknownDays === undefined || Array.isArray(value.unknownDays) && value.unknownDays.every(day => /^\d{4}-\d{2}-\d{2}$/.test(day))) &&
    Object.values(value.days).every(value => count(value) !== null) &&
    Object.values(value.sessions).every(value => object(value) && count(value.cost) !== null && Array.isArray(value.seen));
}
function createUsage({ file, now = Date.now, warn = console.warn }) {
  const stored = readJson(file, { version: 1, days: {}, sessions: {}, unknownDays: [] }, { validate: validUsage });
  // Retired holds are ignored on read and disappear on the next spend write.
  let data = { version: 1, days: stored.days, sessions: stored.sessions, unknownDays: stored.unknownDays || [] };
  const commit = next => {
    data = next;
    try { writeJson(file, next); }
    catch (error) { warn(`Agentrix: the API usage ledger could not be saved (${error?.code || 'error'}); it is saved with the next change.`); }
  };
  const monthOf = () => utcDay(now()).slice(0, 7);
  const spent = () => Object.entries(data.days).filter(([day]) => day.startsWith(monthOf())).reduce((sum, [, value]) => sum + value, 0);
  return {
    record(sessionId, result, { replay = false, resume = false, rejected = false } = {}) {
      const snapshot = snapshotOf(result);
      if (replay || !sessionId) return { snapshot, deltaUsdMicros: null };
      if (rejected) return { snapshot: { ...snapshot, costUsdMicros: data.sessions[sessionId]?.cost ?? null }, deltaUsdMicros: 0 };
      if (snapshot.costUsdMicros === null) return { snapshot, deltaUsdMicros: null };
      const previous = data.sessions[sessionId];
      const resultId = result.uuid || (Number.isSafeInteger(result.result_index) ? `index:${result.result_index}` : null);
      if (resultId && previous?.seen.includes(resultId)) return { snapshot, deltaUsdMicros: 0 };
      // Zeroed failure totals are not a new accounting epoch.
      if (previous && result.is_error && snapshot.costUsdMicros === 0 && previous.cost > 0) return { snapshot, deltaUsdMicros: null };
      const baseline = previous?.cost ?? (resume ? null : 0);
      const regression = baseline !== null && snapshot.costUsdMicros < baseline;
      const delta = baseline === null ? null : regression ? snapshot.costUsdMicros : snapshot.costUsdMicros - baseline;
      const epoch = (previous?.epoch || 0) + (regression ? 1 : 0), next = structuredClone(data), day = utcDay(now());
      next.sessions[sessionId] = { cost: snapshot.costUsdMicros, epoch,
        seen: [...(previous?.seen || []), ...(resultId ? [resultId] : [])].slice(-256), at: now() };
      if (delta === null) {
        // An imported transcript anchors history without charging it locally.
        if (!next.unknownDays.includes(day)) next.unknownDays.push(day);
      } else next.days[day] = (next.days[day] || 0) + delta;
      for (const date of Object.keys(next.days)) if (date < utcDay(now() - 732 * 86400000)) delete next.days[date];
      next.sessions = Object.fromEntries(Object.entries(next.sessions).sort((a, b) => b[1].at - a[1].at).slice(0, 5000));
      commit(next);
      return { snapshot, deltaUsdMicros: delta, usageRecordId: `${sessionId}:${epoch}:${resultId || snapshot.costUsdMicros}` };
    },
    summary() {
      const observed = Object.keys(data.sessions).length > 0;
      return { month: monthOf(), apiRecords: observed, todayUsdMicros: !observed || data.unknownDays.includes(utcDay(now())) ? null : data.days[utcDay(now())] || 0,
        monthUsdMicros: !observed || data.unknownDays.some(day => day.startsWith(monthOf())) ? null : spent(), estimated: true };
    },
    baseline: id => data.sessions[id]?.cost ?? null,
  };
}
module.exports = { createUsage, snapshotOf };
