// Account reads are observations, not resets. Empty/loading/error replies carry
// no evidence that a previously observed login or allowance disappeared.
const dated = value => Number.isFinite(value);
const known = value => value && ['api', 'subscription', 'none'].includes(value.kind) && (value.kind !== 'none' || dated(value.observedAt));
function accountChanged(previous, next) {
  return !!previous && !!next && (dated(next.observedAt) && next.scopeId && previous.scopeId && next.scopeId !== previous.scopeId
    || known(next) && next.kind !== previous.kind && previous.kind !== 'unknown');
}
function retainConnection(previous, next) {
  if (!known(next) && !accountChanged(previous, next) || dated(previous?.observedAt) && (!dated(next?.observedAt) || next.observedAt < previous.observedAt)) {
    return previous ? { ...previous, ...(typeof next?.active === 'boolean' ? { active: next.active } : {}) }
      : next?.kind === 'none' ? { ...next, kind: 'unknown' } : next;
  }
  return next;
}
function retainAccount(previous, next) {
  if (!next) return previous;
  if (!previous || ['provider', 'scope', 'remote'].includes(next.resetQuery?.reason)) return next;
  const connection = retainConnection(previous?.connection, next.connection);
  const changed = connection === next.connection && accountChanged(previous?.connection, connection);
  if (changed) {
    const minimumAt = connection.observedAt;
    return { ...next, connection, minimumAt,
      ...(dated(next.at) && next.at >= minimumAt ? {} : { limits: undefined, resets: undefined, at: undefined }) };
  }
  const newer = (!dated(previous.at) || dated(next.at) && next.at >= previous.at)
    && (!dated(previous.minimumAt) || dated(next.at) && next.at >= previous.minimumAt);
  const limits = newer && next.limits?.length ? next.limits : previous.limits;
  const resets = newer && Number.isSafeInteger(next.resets?.left) ? next.resets : previous.resets;
  return { ...previous, ...next, connection, limits, resets,
    at: newer && (next.limits?.length || Number.isSafeInteger(next.resets?.left)) ? next.at : previous.at,
    source: newer && next.limits?.length ? next.source : previous.source };
}
function retainLimits(previous, next) {
  if (!next) return previous;
  if (previous && next.billingRoute === 'unknown') return { ...previous, state: 'stale' };
  if (dated(previous?.observedAtMs) && (!dated(next.observedAtMs) || next.observedAtMs < previous.observedAtMs)) return previous;
  if (previous?.billingRoute !== next.billingRoute) return next;
  const measured = Object.values(next.limitsById || {}).some(bucket => [bucket?.primary, bucket?.secondary].some(window => dated(window?.usedPercent)))
    || Number.isSafeInteger(next.resetCredits?.availableCount);
  const readable = measured || next.providerStatus != null || next.notice != null || typeof next.ordinaryUsageAllowed === 'boolean';
  if (!readable && previous) return { ...previous, state: ['loading', 'error', 'unavailable'].includes(next.state) ? 'stale' : previous.state };
  if (!previous) return next;
  const limitsById = structuredClone(previous.limitsById || {});
  for (const [id, bucket] of Object.entries(next.limitsById || {})) {
    const held = limitsById[id] ||= {};
    for (const name of ['primary', 'secondary']) if (bucket?.[name]) {
      held[name] = { ...held[name], ...Object.fromEntries(Object.entries(bucket[name]).filter(([, value]) => dated(value))) };
    }
  }
  return { ...next, limitsById, observedAtMs: measured ? next.observedAtMs : previous.observedAtMs,
    resetCredits: Number.isSafeInteger(next.resetCredits?.availableCount) ? next.resetCredits : previous.resetCredits };
}
module.exports = { accountChanged, retainConnection, retainAccount, retainLimits };
