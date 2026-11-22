const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const DESCRIPTION_PREFIX = /^\[([a-z][a-z0-9-]{0,31}(?:\/[a-z][a-z0-9-]{0,23})?)\]\s*/;
const CLAUDE_ALIAS = /^(sonnet|opus|haiku|fable)$/;
const CLAUDE_EFFORT = /^(low|medium|high|xhigh|max)$/;
const familyOf = model => /^(opus|sonnet|haiku|fable|claude-)/.test(model) ? 'claude' : 'codex';
const SEAT_BYTES = 8192;
const SEAT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL = /^[A-Za-z0-9][\w.:@+/[\]-]{0,159}$/;
const EFFORT = /^[a-z][a-z0-9-]{0,31}$/;

function parseSeatMap(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > SEAT_BYTES) return null;
  let seats;
  try { seats = JSON.parse(text); } catch { return null; }
  if (!seats || typeof seats !== 'object' || Array.isArray(seats)) return null;
  return Object.entries(seats).every(([id, choice]) => SEAT_ID.test(id) && choice && typeof choice === 'object'
    && typeof choice.model === 'string' && MODEL.test(choice.model) && typeof choice.effort === 'string' && EFFORT.test(choice.effort)
    && (!Object.hasOwn(choice, 'fast') || typeof choice.fast === 'boolean')
    && (choice.agentModel == null || typeof choice.agentModel === 'string' && CLAUDE_ALIAS.test(choice.agentModel))) ? seats : null;
}

function readSeatMap(bootstrap, suffix) {
  if (typeof bootstrap !== 'string' || !path.isAbsolute(bootstrap) || /^[\\/]{2}/.test(bootstrap)) return null;
  let descriptor;
  try {
    const file = bootstrap + suffix, named = fs.lstatSync(file, { bigint: true });
    if (!named.isFile() || named.size > BigInt(SEAT_BYTES)) return null;
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) return null;
    const data = Buffer.alloc(SEAT_BYTES + 1);
    const count = fs.readSync(descriptor, data, 0, data.length, null);
    if (count > SEAT_BYTES) return null;
    return parseSeatMap(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, count)));
  } catch { return null; }
  finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

const liveSeatMap = bootstrap => readSeatMap(bootstrap, '.seats');
const launchSeatMap = bootstrap => readSeatMap(bootstrap, '.launch-seats');

function seatExpectation(choice) {
  const { model, effort, fast } = choice ?? {};
  if (typeof model !== 'string' || !MODEL.test(model) || typeof effort !== 'string' || !EFFORT.test(effort)) return null;
  if (fast != null && typeof fast !== 'boolean') return null;
  return { model, effort, fast: fast === true };
}

function claudeLeadSeat(bootstrap) {
  try {
    if (typeof bootstrap !== 'string' || !path.isAbsolute(bootstrap) || /^[\\/]{2}/.test(bootstrap)) return null;
    const file = bootstrap + '.lead', stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 2 * SEAT_BYTES) return null;
    const [model, effort] = fs.readFileSync(file, 'utf8').split(/\r?\n/, 2);
    return familyOf(model) === 'claude' ? seatExpectation({ model, effort }) : null;
  } catch { return null; }
}

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

module.exports = { agentDescription, declaredSeat, callSeat, launchSeat, CLAUDE_ALIAS, CLAUDE_EFFORT, familyOf,
  liveSeatMap, launchSeatMap, parseSeatMap, seatExpectation, claudeLeadSeat, SEAT_BYTES };
