const DESCRIPTION_PREFIX = /^\[([a-z][a-z0-9-]{0,31}(?:\/[a-z][a-z0-9-]{0,23})?)\]\s*/;

function declaredSeat(value, seatIds) {
  if (typeof value !== 'string' || !value) return null;
  const [seat, specialty] = value.split('/');
  if (!seatIds().includes(seat)) return null;
  return { seat, ...(specialty ? { specialty } : {}), seatSource: 'declared' };
}

function agentDescription(description, seatIds) {
  const prefix = typeof description === 'string' && DESCRIPTION_PREFIX.exec(description);
  const labels = prefix ? declaredSeat(prefix[1], seatIds) : null;
  return { title: labels ? description.slice(prefix[0].length) : description, labels };
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
