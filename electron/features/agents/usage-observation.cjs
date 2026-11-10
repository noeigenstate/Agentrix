// Account reads are observations, not resets. Empty/loading/error replies carry
// no evidence that a previously observed login or allowance disappeared.
const dated = value => Number.isFinite(value);
const known = value => value && ['api', 'subscription', 'none'].includes(value.kind) && (value.kind !== 'none' || dated(value.observedAt));
function accountChanged(previous, next) {
  return !!previous && !!next && (dated(next.observedAt) && next.scopeId && previous.scopeId && next.scopeId !== previous.scopeId
    || known(next) && next.kind !== previous.kind && previous.kind !== 'unknown');
}
function retainConnection(previous, next) {
  // A reader that cannot name the account (a terminal login, a running session) never replaces one that named it for the
  // same kind of login, whatever its date: the named observation stays with its own time, so the next reader to name
  // an account is compared with it and a change is seen.
  const unnamed = !!previous?.scopeId && !next?.scopeId && next?.kind === previous.kind;
  if (unnamed || !known(next) && !accountChanged(previous, next) || dated(previous?.observedAt) && (!dated(next?.observedAt) || next.observedAt < previous.observedAt)) {
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
const measuredWindow = window => dated(window?.usedPercent);
const quotaMeasured = limits => Object.values(limits.limitsById || {}).some(bucket => measuredWindow(bucket?.primary) || measuredWindow(bucket?.secondary))
  || Number.isSafeInteger(limits.resetCredits?.availableCount);
// Whether a payload says anything of the quota. One that does not is a failed read, a placeholder or an account-change signal.
const quotaRead = limits => quotaMeasured(limits) || limits.providerStatus != null || limits.notice != null || typeof limits.ordinaryUsageAllowed === 'boolean';
// accountScopeId: the account a payload was read for, when its reader could name it (subscriptionLimits).
function retainLimits(previous, next) {
  if (!previous || !next) return next || previous;
  if (dated(previous.observedAtMs) && (!dated(next.observedAtMs) || next.observedAtMs < previous.observedAtMs)) return previous;
  // Quota read for one account is never kept for another, nor merged into its reading.
  if (previous.accountScopeId && next.accountScopeId && previous.accountScopeId !== next.accountScopeId) return next;
  if (previous.billingRoute !== next.billingRoute) return next;
  if (!quotaRead(next)) {
    // Dated, with neither a billing route nor a quota: the provider's own word that the account changed (Codex
    // account/updated). Whose quota the held one is can no longer be told, so it goes. Any other unreadable reply is a
    // failed read and keeps it.
    if (next.billingRoute === 'unknown' && next.state === 'unavailable' && dated(next.observedAtMs)) return next;
    return { ...previous, state: ['loading', 'error', 'unavailable'].includes(next.state) ? 'stale' : previous.state };
  }
  // Another reader's or session's reading replaces the held one whole; only a reader's own sparse update is completed from it.
  if (previous.scopeId !== next.scopeId) return next;
  const limitsById = structuredClone(previous.limitsById || {});
  for (const [id, bucket] of Object.entries(next.limitsById || {})) {
    const held = limitsById[id] ||= {};
    // A percent and its reset time are one reading: a newer percent takes its own reset time, known or not.
    for (const name of ['primary', 'secondary']) if (measuredWindow(bucket?.[name])) {
      held[name] = { ...bucket[name], windowDurationMins: bucket[name].windowDurationMins ?? held[name]?.windowDurationMins ?? null };
    }
  }
  return { ...next, limitsById, observedAtMs: quotaMeasured(next) ? next.observedAtMs : previous.observedAtMs,
    resetCredits: Number.isSafeInteger(next.resetCredits?.availableCount) ? next.resetCredits : previous.resetCredits };
}
module.exports = { accountChanged, retainConnection, retainAccount, retainLimits, quotaRead };
