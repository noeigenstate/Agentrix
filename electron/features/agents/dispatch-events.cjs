const uuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const line = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const number = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const routing = value => line(value?.model, 160) && (value.effort === null || line(value.effort, 32)) && (value.fast === null || typeof value.fast === 'boolean');
const totals = event => Number.isSafeInteger(event.outputTokens) && event.outputTokens >= 0 && number(event.activeMs);

function validDispatch(event) {
  if (!event || !uuid(event.id) || Buffer.byteLength(JSON.stringify(event)) > 16384) return false;
  if (event.type === 'dispatch-rate') return totals(event) && event.activeMs > 0;
  if (!routing(event)) return false;
  if (event.type === 'dispatch-start') return ['codex', 'claude'].includes(event.agent) && ['执行', '调查', '审查'].includes(event.role) &&
    line(event.title, 1024) && ['cwd', 'brief', 'out'].every(key => line(event[key], 4096)) &&
    (event.unconfirmed === undefined || typeof event.unconfirmed === 'boolean') &&
    (line(event.sessionId, 160) || event.unconfirmed === true && event.sessionId === null) &&
    number(event.startedAt) && (event.declared === undefined || routing(event.declared));
  return event.type === 'dispatch-end' && ['exit', 'killed', 'capacity', 'error', 'unconfirmed', 'scope'].includes(event.reason) &&
    (event.outOfScope === undefined || Array.isArray(event.outOfScope) && event.outOfScope.length <= 50 && event.outOfScope.every(file => line(file, 4096))) &&
    (event.exitCode === null || Number.isSafeInteger(event.exitCode) && Math.abs(event.exitCode) <= 0xffffffff) && number(event.endedAt) &&
    (event.outputTokens === null || Number.isSafeInteger(event.outputTokens) && event.outputTokens >= 0) &&
    (event.activeMs === null || number(event.activeMs));
}

function acceptDispatch(session, event) {
  if (!session || event.sessionKey !== session.sessionKey || event.projectId !== session.terminalId || !validDispatch(event)) return false;
  return session.usage?.calls.dispatch(event) || false;
}

module.exports = { acceptDispatch, validDispatch };
