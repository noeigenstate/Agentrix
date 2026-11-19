const DESCRIPTION_PREFIX = /^\[([a-z][a-z0-9-]{0,31}(?:\/[a-z][a-z0-9-]{0,23})?)\]\s*/;
const CLAUDE_ALIAS = /^(sonnet|opus|haiku|fable)$/;
const CLAUDE_EFFORT = /^(low|medium|high|xhigh|max)$/;
const familyOf = model => /^(opus|sonnet|haiku|fable|claude-)/.test(model) ? 'claude' : 'codex';

function launchSeat(value, enabledIds) {
  if (typeof value !== 'string' || !value) return null;
  const [seat, specialty] = value.split('/');
  if (seat === 'developer' && enabledIds.includes(specialty)) return specialty;
  return enabledIds.includes(seat) ? seat : null;
}

function declaredSeat(value, rolesOf) {
  if (typeof value !== 'string' || !value) return null;
  const roles = rolesOf() ?? [];
  const enabled = roles.flatMap(role => typeof role === 'string' ? [role] : role.enabled ? [role.id] : []);
  const [base, specialty] = value.split('/');
  const selected = launchSeat(value, enabled);
  const seat = selected ?? base;
  const role = roles.find(role => role.id === seat);
  if (!selected && !role) return null;
  const remapped = base === 'developer' && selected === specialty;
  return { seat, seatSource: 'declared', ...(specialty && !remapped ? { specialty } : {}),
    ...(role ? { seatName: role.name } : {}), ...(!selected ? { offTeam: true } : {}) };
}

function agentDescription(description, rolesOf) {
  const prefix = typeof description === 'string' && DESCRIPTION_PREFIX.exec(description);
  const labels = prefix ? declaredSeat(prefix[1], rolesOf) : null;
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
  if (call.seatSource !== 'declared') return { seat: inferredSeat(call, model), seatSource: 'inferred' };
  const { seat, specialty, seatSource, seatName, offTeam } = call;
  return { seat, seatSource, ...(specialty ? { specialty } : {}), ...(seatName === undefined ? {} : { seatName }), ...(offTeam ? { offTeam } : {}) };
}

module.exports = { agentDescription, declaredSeat, callSeat, launchSeat, CLAUDE_ALIAS, CLAUDE_EFFORT, familyOf };
