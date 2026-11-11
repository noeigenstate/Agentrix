const { TASK_KINDS } = require('../dashboard/records-routing.cjs');
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const line = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const number = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const routing = value => line(value?.model, 160) && (value.effort === null || line(value.effort, 32)) && (value.fast === null || typeof value.fast === 'boolean');
const totals = event => Number.isSafeInteger(event.outputTokens) && event.outputTokens >= 0 && number(event.activeMs);
const optionalCount = value => value == null || Number.isSafeInteger(value) && value >= 0;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const percent = value => value === null || Number.isFinite(value) && value >= 0 && value <= 100;
// An observation time: never later than a minute past this clock.
const observed = value => number(value) && value <= Date.now() + 60000;
const NOTICES = ['credits_required', 'spend_limit', 'rate_limited'];

// A quota window as the worker's app-server merged it (mergeLimits); undefined when it is not one.
function quotaWindow(value) {
  if (value === null) return null;
  if (!object(value) || !percent(value.usedPercent) || !optionalCount(value.windowDurationMins) || !optionalCount(value.resetsAtMs)) return undefined;
  return { usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins ?? null, resetsAtMs: value.resetsAtMs ?? null };
}
const validNotice = notice => notice == null
  || object(notice) && NOTICES.includes(notice.code) && optionalCount(notice.resetsAtMs) && line(notice.message, 200);
function quota(value) {
  if (!object(value) || !['ready', 'unavailable'].includes(value.state) || !observed(value.observedAtMs) || !object(value.limitsById)) return undefined;
  const buckets = Object.entries(value.limitsById), limitsById = {};
  if (buckets.length > 8) return undefined;
  for (const [id, bucket] of buckets) {
    if (!/^[\w.-]{1,64}$/.test(id) || !object(bucket)) return undefined;
    limitsById[id] = {};
    for (const name of ['primary', 'secondary']) if (name in bucket) {
      const parsed = quotaWindow(bucket[name]);
      if (parsed === undefined) return undefined;
      limitsById[id][name] = parsed;
    }
  }
  const { resetCredits: credits, notice, ordinaryUsageAllowed, providerStatus } = value;
  if (!(credits === null || object(credits) && optionalCount(credits.availableCount))) return undefined;
  if (!(ordinaryUsageAllowed === null || typeof ordinaryUsageAllowed === 'boolean')) return undefined;
  if (!(providerStatus === undefined || providerStatus === 'rejected') || !validNotice(notice)) return undefined;
  return { state: value.state, observedAtMs: value.observedAtMs, limitsById, ordinaryUsageAllowed,
    resetCredits: credits && { availableCount: credits.availableCount ?? null },
    ...(providerStatus ? { providerStatus } : {}),
    ...(notice ? { notice: { code: notice.code, resetsAtMs: notice.resetsAtMs ?? null, message: notice.message } } : {}) };
}

// A dispatched Codex worker's account and quota as its own app-server read them, rebuilt from known fields only, as the
// limits payload an account read gives (subscriptionLimits). The account's name was made with main's key (a local
// helper receives it at control registration), so it is used as given; the connection goes with the payload as
// host-only evidence. null when the report is not one.
function dispatchAccount(event) {
  const { connection: reported, limits: read } = event;
  if (!object(reported) || !['api', 'subscription', 'none', 'unknown'].includes(reported.kind)) return null;
  if (!(reported.observedAt === null || observed(reported.observedAt))) return null;
  if (!(reported.scopeId === undefined || typeof reported.scopeId === 'string' && /^[a-f\d]{64}$/.test(reported.scopeId))) return null;
  const limits = read === null ? null : quota(read), named = reported.kind !== 'unknown';
  if (limits === undefined) return null;
  const connection = { kind: reported.kind, active: false, source: 'codex-app-server account/read', observedAt: named ? reported.observedAt : null,
    ...(named && reported.scopeId ? { scopeId: reported.scopeId } : {}) };
  const observedAtMs = limits?.observedAtMs ?? connection.observedAt;
  if (observedAtMs === null) return null;
  const payload = { state: 'unavailable', limitsById: {}, resetCredits: null, ordinaryUsageAllowed: null, ...limits,
    scopeId: connection.scopeId ? `codex-dispatch:${connection.scopeId}` : 'codex-dispatch', accountScopeId: connection.scopeId || null,
    billingRoute: 'subscription', observedAtMs, source: 'codex-app-server' };
  return Object.defineProperty(payload, 'accountConnection', { value: connection });
}
const envelope = event => !!event && uuid(event.id) && Buffer.byteLength(JSON.stringify(event)) <= 16384;

function validDispatch(event) {
  if (!envelope(event)) return false;
  if (event.type === 'dispatch-rate') return totals(event) && event.activeMs > 0;
  if (event.type === 'dispatch-input') return line(event.sessionId, 160) && line(event.entryId, 200)
    && event.entryId.startsWith('u:') && (event.inputId == null || line(event.inputId, 160)) && ['owner', 'planner'].includes(event.origin)
    && (event.ownerMessageIds == null || Array.isArray(event.ownerMessageIds) && event.ownerMessageIds.length <= 32 && event.ownerMessageIds.every(uuid));
  if (event.type === 'dispatch-receipt') return typeof event.messageId === 'string' && /^[\w-]{1,160}$/.test(event.messageId)
    && ['queued', 'delivered', 'consumed', 'rejected', 'unknown'].includes(event.status);
  if (event.type === 'dispatch-account') return !!dispatchAccount(event);
  if (!routing(event)) return false;
  if (event.type === 'dispatch-routing') return true;
  if (event.type === 'dispatch-start') return ['codex', 'claude'].includes(event.agent) && ['执行', '调查', '审查', '圆桌'].includes(event.role) &&
    line(event.title, 1024) && ['cwd', 'brief', 'out'].every(key => line(event[key], 4096)) &&
    (event.unconfirmed === undefined || typeof event.unconfirmed === 'boolean') &&
    (line(event.sessionId, 160) || event.unconfirmed === true && event.sessionId === null) &&
    number(event.startedAt) && (event.declared === undefined || routing(event.declared)) && (event.requestedModel == null || line(event.requestedModel, 160)) &&
    (event.kind == null || TASK_KINDS.includes(event.kind)) &&
    (event.meeting == null || typeof event.meeting === 'string' && /^[\w.-]{1,64}$/.test(event.meeting)) &&
    (event.skipMeeting == null || line(event.skipMeeting, 1024));
  return event.type === 'dispatch-end' && ['exit', 'killed', 'capacity', 'error', 'unconfirmed', 'scope'].includes(event.reason) &&
    (event.outOfScope === undefined || Array.isArray(event.outOfScope) && event.outOfScope.length <= 50 && event.outOfScope.every(file => line(file, 4096))) &&
    (event.exitCode === null || Number.isSafeInteger(event.exitCode) && Math.abs(event.exitCode) <= 0xffffffff) && number(event.endedAt) &&
    (event.outputTokens === null || Number.isSafeInteger(event.outputTokens) && event.outputTokens >= 0) &&
    (event.activeMs === null || number(event.activeMs)) && optionalCount(event.inputTokens) && optionalCount(event.cachedTokens) && optionalCount(event.totalOutputTokens) &&
    optionalCount(event.outOfScopeCount) && optionalCount(event.skillProposals) && (event.reportedCostUsd == null || number(event.reportedCostUsd)) &&
    (event.verdict === undefined || ['ok', 'mismatch', 'unverified'].includes(event.verdict));
}

// calls: the session's called models (AgentCalls), present whether or not an agent runs in that terminal.
// observeAccount: takes a running Codex call's account report as a limits payload (dispatchAccount); it may decline it.
function acceptDispatch(session, event, calls, observeAccount) {
  if (!session || event.sessionKey !== session.sessionKey || event.projectId !== session.terminalId) return false;
  if (event.type === 'dispatch-account') {
    const call = envelope(event) && calls?.byId(`dispatch:${event.id}`), payload = call?.sourceAgent === 'codex' && !call.done && dispatchAccount(event);
    return !!payload && (observeAccount?.(payload) || false);
  }
  if (!validDispatch(event)) return false;
  const agent = ['claude', 'codex'].includes(session.agent) ? session.agent : null;
  const model = session.nativeStructured ? session.nativeObservedModel : session.usage?.rates?.model;
  const planner = { kind: 'planner', agent, model: line(model, 160) && model !== '<synthetic>' ? model : null };
  return calls?.dispatch(event.type === 'dispatch-start' ? { ...event, planner } : event) || false;
}

module.exports = { acceptDispatch, validDispatch, dispatchAccount };
