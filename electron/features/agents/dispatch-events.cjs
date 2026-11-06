const { TASK_KINDS } = require('../dashboard/records-routing.cjs');
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const line = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const number = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const routing = value => line(value?.model, 160) && (value.effort === null || line(value.effort, 32)) && (value.fast === null || typeof value.fast === 'boolean');
const totals = event => Number.isSafeInteger(event.outputTokens) && event.outputTokens >= 0 && number(event.activeMs);
const optionalCount = value => value == null || Number.isSafeInteger(value) && value >= 0;

function validDispatch(event) {
  if (!event || !uuid(event.id) || Buffer.byteLength(JSON.stringify(event)) > 16384) return false;
  if (event.type === 'dispatch-rate') return totals(event) && event.activeMs > 0;
  if (event.type === 'dispatch-input') return line(event.sessionId, 160) && line(event.entryId, 200)
    && event.entryId.startsWith('u:') && (event.inputId == null || line(event.inputId, 160)) && ['owner', 'planner'].includes(event.origin)
    && (event.ownerMessageIds == null || Array.isArray(event.ownerMessageIds) && event.ownerMessageIds.length <= 32 && event.ownerMessageIds.every(uuid));
  if (event.type === 'dispatch-receipt') return typeof event.messageId === 'string' && /^[\w-]{1,160}$/.test(event.messageId)
    && ['queued', 'delivered', 'consumed', 'rejected', 'unknown'].includes(event.status);
  if (!routing(event)) return false;
  if (event.type === 'dispatch-start') return ['codex', 'claude'].includes(event.agent) && ['执行', '调查', '审查', '圆桌'].includes(event.role) &&
    line(event.title, 1024) && ['cwd', 'brief', 'out'].every(key => line(event[key], 4096)) &&
    (event.unconfirmed === undefined || typeof event.unconfirmed === 'boolean') &&
    (line(event.sessionId, 160) || event.unconfirmed === true && event.sessionId === null) &&
    number(event.startedAt) && (event.declared === undefined || routing(event.declared)) &&
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
function acceptDispatch(session, event, calls) {
  if (!session || event.sessionKey !== session.sessionKey || event.projectId !== session.terminalId || !validDispatch(event)) return false;
  const agent = ['claude', 'codex'].includes(session.agent) ? session.agent : null;
  const model = session.nativeStructured ? session.nativeObservedModel : session.usage?.rates?.model;
  const planner = { kind: 'planner', agent, model: line(model, 160) && model !== '<synthetic>' ? model : null };
  return calls?.dispatch(event.type === 'dispatch-start' ? { ...event, planner } : event) || false;
}

module.exports = { acceptDispatch, validDispatch };
