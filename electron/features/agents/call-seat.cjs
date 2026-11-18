const DESCRIPTION_PREFIX = /^\[([a-z][a-z0-9-]{0,31}(?:\/[a-z][a-z0-9-]{0,23})?)\]\s*/;

function declaredSeat(value) {
  if (typeof value !== 'string' || !value) return null;
  const [seat, specialty] = value.split('/');
  return { seat, ...(specialty ? { specialty } : {}), seatSource: 'declared' };
}

function agentDescription(description) {
  const prefix = DESCRIPTION_PREFIX.exec(description);
  return prefix ? { title: description.slice(prefix[0].length), labels: declaredSeat(prefix[1]) }
    : { title: description, labels: null };
}

function inferredSeat({ role, kind, agentType }, model) {
  if (role === '审查' || kind === 'review') return 'reviewer';
  if (kind === 'ui-check' || kind === 'test') return 'qa';
  if (role === '调查' || kind === 'investigate' || agentType === 'Explore' || /^(?:claude-)?haiku(?:[-\[]|$)/i.test(model || '')) return 'researcher';
  if (agentType === 'Plan') return 'architect';
  return 'developer';
}

function callSeat(call, model) {
  return call.seatSource === 'declared'
    ? { seat: call.seat, ...(call.specialty ? { specialty: call.specialty } : {}), seatSource: 'declared' }
    : { seat: inferredSeat(call, model), seatSource: 'inferred' };
}

module.exports = { agentDescription, declaredSeat, callSeat };
