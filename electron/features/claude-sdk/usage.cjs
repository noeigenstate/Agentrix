const { randomUUID } = require('node:crypto');
const { readJson, writeJson } = require('../native-session/storage.cjs');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const micros = value => Number.isFinite(value) && value >= 0 ? count(Math.round(value * 1e6)) : null;
const utcDay = at => new Date(at).toISOString().slice(0, 10);
function snapshotOf(result) {
  const models = Object.values(result.modelUsage || {});
  const sum = field => models.length && models.every(model => count(model[field]) !== null) ? count(models.reduce((total, model) => total + model[field], 0)) : null;
  return { input: sum('inputTokens'), cachedInput: sum('cacheReadInputTokens'), cacheWrite: sum('cacheCreationInputTokens'),
    output: sum('outputTokens'), reasoning: null, contextWindow: count(models[0]?.contextWindow),
    costUsdMicros: micros(result.total_cost_usd), costEstimated: true };
}
function createUsage({ file, now = Date.now }) {
  let data = readJson(file, { version: 1, days: {}, sessions: {}, reservations: {} });
  data.unknownDays ||= [];
  const commit = next => { writeJson(file, next); data = next; };
  const monthOf = () => utcDay(now()).slice(0, 7);
  function spent(month = monthOf()) { return Object.entries(data.days).filter(([day]) => day.startsWith(month)).reduce((sum, [, value]) => sum + value, 0); }
  function held(month = monthOf()) { return Object.values(data.reservations).filter(value => value.month === month).reduce((sum, value) => sum + value.micros, 0); }
  return {
    available(budget) { return budget === null ? Infinity : data.unknownDays.some(day => day.startsWith(monthOf())) ? 0 : Math.max(0, micros(budget) - spent() - held()); },
    reserve(budget) {
      const available = this.available(budget);
      if (available <= 0) throw Object.assign(new Error('本月 API 预算已用完。'), { code: 'budget_exhausted' });
      const id = randomUUID(), amount = budget === null ? 0 : Math.min(available, 5e6);
      const next = structuredClone(data); next.reservations[id] = { month: monthOf(), micros: amount }; commit(next);
      return { id, maxBudgetUsd: budget === null ? undefined : amount / 1e6 };
    },
    release(id) { if (data.reservations[id]?.uncertain) return; const next = structuredClone(data); delete next.reservations[id]; commit(next); },
    unverified(id) {
      if (!data.reservations[id]) return;
      const next = structuredClone(data), day = utcDay(now()); next.reservations[id].uncertain = true;
      if (!next.unknownDays.includes(day)) next.unknownDays.push(day); commit(next);
    },
    record(sessionId, result, { replay = false, resume = false, reservationId } = {}) {
      const snapshot = snapshotOf(result);
      if (replay || !sessionId) return { snapshot, deltaUsdMicros: null };
      if (snapshot.costUsdMicros === null) {
        const next = structuredClone(data), day = utcDay(now());
        if (!next.unknownDays.includes(day)) next.unknownDays.push(day);
        if (reservationId && next.reservations[reservationId]) next.reservations[reservationId].uncertain = true;
        commit(next); return { snapshot, deltaUsdMicros: null };
      }
      const previous = data.sessions[sessionId];
      const resultId = result.uuid || (Number.isSafeInteger(result.result_index) ? `index:${result.result_index}` : null);
      if (resultId && previous?.seen.includes(resultId)) return { snapshot, deltaUsdMicros: 0 };
      // Startup failures can be zeroed; a lower observation cannot erase an established baseline.
      if (previous && snapshot.costUsdMicros < previous.cost) return { snapshot, deltaUsdMicros: null };
      const next = structuredClone(data);
      const delta = resume && !previous ? null : snapshot.costUsdMicros - (previous?.cost || 0);
      next.sessions[sessionId] = { cost: snapshot.costUsdMicros, seen: [...(previous?.seen || []), ...(resultId ? [resultId] : [])].slice(-256), at: now() };
      if (delta === null) {
        const day = utcDay(now()); if (!next.unknownDays.includes(day)) next.unknownDays.push(day);
        if (reservationId && next.reservations[reservationId]) next.reservations[reservationId].uncertain = true;
      }
      if (delta !== null) {
        const day = utcDay(now()); next.days[day] = (next.days[day] || 0) + delta;
        if (reservationId && next.reservations[reservationId]) next.reservations[reservationId].micros = Math.max(0, next.reservations[reservationId].micros - delta);
      }
      // Keep monthly totals for two years, without persisting conversation content.
      for (const day of Object.keys(next.days)) if (day < utcDay(now() - 732 * 86400000)) delete next.days[day];
      const sessions = Object.entries(next.sessions).sort((a, b) => b[1].at - a[1].at);
      next.sessions = Object.fromEntries(sessions.slice(0, 5000));
      commit(next);
      return { snapshot, deltaUsdMicros: delta, usageRecordId: `${sessionId}:${resultId || snapshot.costUsdMicros}` };
    },
    summary() { return { month: monthOf(), todayUsdMicros: data.unknownDays.includes(utcDay(now())) ? null : data.days[utcDay(now())] || 0,
      monthUsdMicros: data.unknownDays.some(day => day.startsWith(monthOf())) ? null : spent(), estimated: true }; },
    baseline: id => data.sessions[id]?.cost ?? null,
  };
}
module.exports = { createUsage, snapshotOf };
