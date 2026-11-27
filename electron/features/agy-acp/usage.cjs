const { adapterOf } = require('../cli-adapters/registry.mjs');
const { readUsageWindows, isUsageGroup } = require('./usage-reader.cjs');

const { usage: { provider: source } } = adapterOf('agy').manifest;
const QUOTA_INTERVAL = 5 * 60 * 1000;

async function readAgyAccount({ now = Date.now, ...options } = {}) {
  const limits = await readUsageWindows(options);
  const at = now();
  return { limits, at, source, connection: { kind: limits.length ? 'subscription' : 'unknown', source, observedAt: at } };
}

function agyAccountLimits(account) {
  const limitsById = {};
  for (const [index, value] of account.limits.entries()) {
    const id = value.minutes === null ? `${value.id}-${index + 1}` : value.id;
    const group = limitsById[id] ??= {};
    const slot = value.minutes === 10080 ? 'secondary' : 'primary';
    if ((group[slot]?.usedPercent ?? -1) < value.percent) {
      group[slot] = { usedPercent: value.percent, windowDurationMins: value.minutes, resetsAtMs: value.resetsAt };
    }
  }
  const ready = account.limits.length > 0;
  const limits = { scopeId: 'agy-account', accountScopeId: null, billingRoute: ready ? 'subscription' : 'unknown', observedAtMs: account.at,
    state: ready ? 'ready' : 'unavailable', limitsById, resetCredits: null, ordinaryUsageAllowed: null, source: account.source };
  return Object.defineProperty(limits, 'accountConnection', { value: account.connection });
}

const remoteReads = new WeakMap();
function remoteAgyLimits(remote, now = Date.now) {
  if (!remote || remote.closed) return Promise.resolve(null);
  const at = now(), previous = remoteReads.get(remote);
  if (previous && at - previous.at < QUOTA_INTERVAL) return previous.reading;
  const entry = { at, value: previous?.value ?? null };
  entry.reading = Promise.resolve().then(() => remote.request('agy-usage', {}, { timeout: 16000 })).then(rows => {
    if (!Array.isArray(rows)) return entry.value;
    const limits = rows.slice(0, 64).flatMap(row => {
      if (!row || !isUsageGroup(row.id)
        || !Number.isFinite(row.percent) || row.percent < 0 || row.percent > 100) return [];
      return [{ id: row.id, percent: row.percent, minutes: [300, 10080].includes(row.minutes) ? row.minutes : null,
        resetsAt: Number.isSafeInteger(row.resetsAt) && row.resetsAt > 0 ? row.resetsAt : null }];
    });
    return entry.value = limits.length ? { ...agyAccountLimits({ limits, at: now(), source }), scopeId: 'agy-ssh-account' } : null;
  }).catch(() => entry.value).then(value => remote.closed ? null : value);
  remoteReads.set(remote, entry);
  return entry.reading;
}

module.exports = { readAgyAccount, agyAccountLimits, remoteAgyLimits, isUsageGroup, QUOTA_INTERVAL };
