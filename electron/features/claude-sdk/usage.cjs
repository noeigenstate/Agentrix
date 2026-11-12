const { randomUUID } = require('node:crypto');
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
  return object(value) && value.version === 1 && object(value.days) && object(value.sessions) && object(value.reservations) &&
    (value.unknownDays === undefined || Array.isArray(value.unknownDays) && value.unknownDays.every(day => /^\d{4}-\d{2}-\d{2}$/.test(day))) &&
    Object.values(value.days).every(value => count(value) !== null) &&
    Object.values(value.sessions).every(value => object(value) && count(value.cost) !== null && Array.isArray(value.seen)) &&
    [value.reservations, value.estimates || {}].every(entries => object(entries) &&
      Object.values(entries).every(value => object(value) && /^\d{4}-\d{2}$/.test(value.month) && count(value.micros) !== null));
}
// A signal-0 probe: only a process that does not exist refuses it with ESRCH.
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
// Why a month budget leaves a new query nothing, in the owner's words.
const REFUSALS = { zero: 'API 月预算设为 0，原生会话不使用 API。', spent: '本月 API 预算已用完。',
  held: '本月剩余的 API 预算被其他会话占用，或有会话的花费还未确认。' };
const refused = (cause, extra = {}) => Object.assign(new Error(REFUSALS[cause]), { code: 'budget_exhausted', refusal: cause, ...extra });
function createUsage({ file, now = Date.now, pid = process.pid, alive = processAlive }) {
  let data = readJson(file, { version: 1, days: {}, sessions: {}, reservations: {}, unknownDays: [] }, { validate: validUsage });
  data.unknownDays ||= [];
  data.estimates ||= {};
  const commit = next => { writeJson(file, next); data = next; };
  const monthOf = () => utcDay(now()).slice(0, 7);
  const spent = (month = monthOf()) => Object.entries(data.days).filter(([day]) => day.startsWith(month)).reduce((sum, [, value]) => sum + value, 0);
  const pending = value => [...Object.values(value.reservations), ...Object.values(value.estimates)];
  const held = (month = monthOf()) => pending(data).filter(value => value.month === month).reduce((sum, value) => sum + value.micros, 0);
  // A held entry lasts for its month and its process. An earlier month no longer counts. One left by a process that no longer runs
  // (or by a version that recorded none) can spend no more: it holds nothing and stays an uncertain marker of its session and day,
  // so that day's spend reads as unknown and the session's next cumulative result still settles it against its baseline.
  function adopt() {
    const next = structuredClone(data), month = monthOf(), marker = (entries, lease) => entries === next.estimates && lease.pid === undefined && lease.micros === 0;
    let changed = false;
    for (const entries of [next.reservations, next.estimates]) {
      for (const [id, lease] of Object.entries(entries)) {
        const ended = lease.pid !== pid && !(Number.isSafeInteger(lease.pid) && alive(lease.pid));
        if (lease.month >= month && (!ended || marker(entries, lease))) continue;
        delete entries[id]; changed = true;
        if (lease.month >= month) next.estimates[id] = { month: lease.month, micros: 0, sessionId: lease.sessionId ?? null,
          baseline: lease.baseline ?? null, day: lease.day || utcDay(now()), uncertain: true };
      }
    }
    if (changed) commit(next);
  }
  adopt();
  function uncertain(next, id) {
    const lease = next.reservations[id];
    if (!lease) return;
    lease.uncertain = true; lease.day ||= utcDay(now());
  }
  function settle(next, sessionId, exclude) {
    for (const entries of [next.reservations, next.estimates]) {
      for (const [id, lease] of Object.entries(entries)) {
        if (id !== exclude && lease.uncertain && lease.sessionId === sessionId) delete entries[id];
      }
    }
  }
  return {
    available(budget, reservationId = null) {
      const own = data.reservations[reservationId];
      return budget === null ? Infinity : Math.max(0, micros(budget) - spent() - held() + (own?.month === monthOf() ? own.micros : 0));
    },
    // Why nothing is left for a new query (zero, spent or held), or null while some is.
    refusal(budget) {
      if (this.available(budget) > 0) return null;
      return micros(budget) === 0 ? 'zero' : spent() >= micros(budget) ? 'spent' : 'held';
    },
    // The allowance a new query may use, in USD; none left is refused with its cause before any CLI starts.
    allowanceUsd(budget) {
      const cause = this.refusal(budget);
      if (cause) throw refused(cause, { beforeInput: true });
      return budget === null ? undefined : this.available(budget) / 1e6;
    },
    currentReservation(id) { return data.reservations[id]?.month === monthOf(); },
    reserve(budget, { sessionId = null, resume = false, maxBudgetUsd = Infinity } = {}) {
      const available = this.available(budget), cause = this.refusal(budget);
      if (cause) throw refused(cause);
      const cap = maxBudgetUsd === Infinity ? Infinity : micros(maxBudgetUsd);
      const id = randomUUID(), amount = budget === null ? 0 : Math.min(available, cap ?? 0);
      if (budget !== null && amount <= 0) throw Object.assign(new Error('API 预算上限已用完。'), { code: 'budget_exhausted' });
      const baseline = sessionId && data.sessions[sessionId] ? data.sessions[sessionId].cost : resume ? null : 0;
      const next = structuredClone(data);
      next.reservations[id] = { month: monthOf(), micros: amount, sessionId, baseline, day: utcDay(now()), pid };
      commit(next);
      return { id, maxBudgetUsd: budget === null ? undefined : amount / 1e6 };
    },
    bind(id, sessionId) {
      if (!data.reservations[id]) return;
      const next = structuredClone(data); next.reservations[id].sessionId = sessionId; commit(next);
    },
    release(id) {
      if (!data.reservations[id]) return true;
      if (data.reservations[id].uncertain) return false;
      const next = structuredClone(data); delete next.reservations[id]; commit(next);
      return true;
    },
    unverified(id) {
      if (!data.reservations[id]) return;
      const next = structuredClone(data); uncertain(next, id); commit(next);
    },
    finish(id, { started = true } = {}) {
      if (!data.reservations[id]) return;
      const next = structuredClone(data), lease = next.reservations[id];
      // A closed request has no live reservation. Its proved remaining cap is an unverified upper estimate.
      if (started && lease.uncertain) next.estimates[id] = lease;
      delete next.reservations[id]; commit(next);
    },
    record(sessionId, result, { replay = false, resume = false, reservationId, rejected = false } = {}) {
      const snapshot = snapshotOf(result);
      if (replay || !sessionId) return { snapshot, deltaUsdMicros: null };
      if (rejected) {
        this.release(reservationId);
        return { snapshot: { ...snapshot, costUsdMicros: data.sessions[sessionId]?.cost ?? null }, deltaUsdMicros: 0 };
      }
      if (snapshot.costUsdMicros === null) {
        this.unverified(reservationId);
        return { snapshot, deltaUsdMicros: null };
      }
      const previous = data.sessions[sessionId];
      const resultId = result.uuid || (Number.isSafeInteger(result.result_index) ? `index:${result.result_index}` : null);
      if (resultId && previous?.seen.includes(resultId)) return { snapshot, deltaUsdMicros: 0 };
      // A zeroed startup/abort failure is not evidence of a new accounting epoch.
      if (previous && result.is_error && snapshot.costUsdMicros === 0 && previous.cost > 0) {
        this.unverified(reservationId);
        return { snapshot, deltaUsdMicros: null };
      }
      const next = structuredClone(data), lease = next.reservations[reservationId];
      const knownLease = pending(data).find(value => value.sessionId === sessionId && value.baseline !== null && value.baseline !== undefined);
      const baseline = previous?.cost ?? knownLease?.baseline ?? (resume ? null : 0);
      const regression = baseline !== null && snapshot.costUsdMicros < baseline;
      const delta = baseline === null ? null : regression ? snapshot.costUsdMicros : snapshot.costUsdMicros - baseline;
      const epoch = (previous?.epoch || 0) + (regression ? 1 : 0);
      next.sessions[sessionId] = { cost: snapshot.costUsdMicros, epoch,
        seen: [...(previous?.seen || []), ...(resultId ? [resultId] : [])].slice(-256), at: now() };
      if (delta === null) {
        // This result anchors an imported transcript; its historic total is never charged locally.
        uncertain(next, reservationId);
        if (!lease && !next.unknownDays.includes(utcDay(now()))) next.unknownDays.push(utcDay(now()));
      } else {
        const day = utcDay(now()); next.days[day] = (next.days[day] || 0) + delta;
        // A later cumulative result covers the stopped query. Replace its held estimate with observed spend.
        settle(next, sessionId, reservationId);
        if (lease) {
          delete lease.uncertain;
          lease.micros = Math.max(0, lease.micros - delta);
          lease.baseline = snapshot.costUsdMicros;
        }
      }
      for (const day of Object.keys(next.days)) if (day < utcDay(now() - 732 * 86400000)) delete next.days[day];
      const sessions = Object.entries(next.sessions).sort((a, b) => b[1].at - a[1].at);
      next.sessions = Object.fromEntries(sessions.slice(0, 5000));
      commit(next);
      return { snapshot, deltaUsdMicros: delta, usageRecordId: `${sessionId}:${epoch}:${resultId || snapshot.costUsdMicros}` };
    },
    summary() {
      const unknown = [...data.unknownDays, ...pending(data).filter(value => value.uncertain).map(value => value.day)];
      const observed = Object.keys(data.sessions).length > 0;
      return { month: monthOf(), apiRecords: observed, todayUsdMicros: !observed || unknown.includes(utcDay(now())) ? null : data.days[utcDay(now())] || 0,
        monthUsdMicros: !observed || unknown.some(day => day?.startsWith(monthOf())) ? null : spent(), estimated: true };
    },
    baseline: id => data.sessions[id]?.cost ?? null,
  };
}
module.exports = { createUsage, snapshotOf, REFUSALS };
