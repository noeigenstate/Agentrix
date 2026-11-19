const modelSeats = require('./model-seats.cjs');
const operations = require('./operation-slots.cjs');
const { roleKind, roleLocks, validateCustomRole, normalizeRoleText, checkTeamRules } = require('./role-rules.mjs');

const roleKeys = ['model', 'effort', 'fast', 'enabled', 'fresh', 'from', 'name', 'duty', 'outputs'];
const seatKeys = ['model', 'effort', 'fast'];
const textKeys = ['name', 'duty', 'outputs'];
const operationKeys = Object.keys(operations.defaults);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const emptyConfig = () => ({ roles: {}, operations: {} });
const fail = (code, role, message = code) => { throw Object.assign(new Error(message), { code, role }); };
const unknownKey = (value, keys) => Object.keys(value).some(key => !keys.includes(key));

function roleConfig(id, raw, entry, catalog, stored, ignored) {
  if (!object(raw)) fail('invalid-role', id);
  if (unknownKey(raw, roleKeys)) fail('unknown-key', id);
  const builtIn = entry.seats.includes(id), library = entry.library?.includes(id);
  const custom = id.startsWith('x-');
  if (!builtIn && !library && !custom) {
    if (!stored) fail('invalid-role', id);
    ignored.push('roles.' + id);
    return null;
  }
  const fields = {};
  for (const key of ['enabled', 'fresh']) if (Object.hasOwn(raw, key)) {
    if (typeof raw[key] !== 'boolean') fail('invalid-role', id);
    fields[key] = raw[key];
  }
  if (custom) {
    const sources = [...entry.seats.slice(1), ...entry.library || []];
    const error = validateCustomRole(id, raw, sources);
    if (error) fail(error.code, id, error.field ?? error.code);
    fields.from = raw.from;
    for (const key of textKeys) fields[key] = normalizeRoleText(key, raw[key] ?? '');
  } else if (['from', ...textKeys].some(key => Object.hasOwn(raw, key))) {
    fail('invalid-role', id);
  }
  if (seatKeys.some(key => Object.hasOwn(raw, key))) {
    try { Object.assign(fields, modelSeats.cleanSeat(raw, id, catalog, stored)); }
    catch (error) {
      if (!stored) throw error;
      ignored.push('roles.' + id + '.seat');
    }
  }
  return fields;
}

function cleanConfig(raw, entry, catalog, stored = false) {
  if (!object(raw) || !object(raw.roles) || !object(raw.operations)) fail('bad-format');
  if (unknownKey(raw, ['roles', 'operations'])) fail('unknown-key');
  const ignored = [];
  const roles = Object.fromEntries(Object.entries(raw.roles).flatMap(([id, value]) => {
    const fields = roleConfig(id, value, entry, catalog, stored, ignored);
    return fields ? [[id, fields]] : [];
  }));
  for (const [id, value] of Object.entries(raw.operations)) {
    if (!operationKeys.includes(id) || object(value) && unknownKey(value, ['model', 'effort'])) fail('unknown-key');
  }
  const values = stored ? operations.cleanStored(raw.operations) : operations.clean(raw.operations, catalog);
  for (const id of Object.keys(raw.operations)) if (!Object.hasOwn(values, id)) ignored.push('operations.' + id);
  return { config: { roles, operations: values }, ignored };
}

function baseRows(entry) {
  const authors = entry.authors ?? ['developer'], source = new Map((entry.roles || []).map(role => [role.id, role]));
  const row = (id, kind, type) => ({
    ...source.get(id) || { id, name: id, duty: '', detail: '', outputs: '' },
    kind, source: type, enabled: type === 'builtin', fresh: !!entry.fresh?.includes(id) || kind === 'reviewer', locked: roleLocks(kind, type),
  });
  return entry.seats.flatMap((id, index) => [
    row(id, index === 0 ? 'lead' : roleKind(id, authors), 'builtin'),
    ...(id === 'developer' ? (entry.library || []).map(item => row(item, roleKind(item, authors), 'library')) : []),
  ]);
}

const seatFrom = override => override.model === undefined ? undefined : Object.fromEntries(seatKeys.filter(key => Object.hasOwn(override, key)).map(key => [key, override[key]]));
const sameSeat = (left, right) => left?.model === right?.model && left?.effort === right?.effort && !!left?.fast === !!right?.fast;

function resolveTeam(entry, config, defaults) {
  const builtIn = baseRows(entry), overrides = config.roles;
  const rows = new Map(builtIn.map(row => [row.id, row]));
  const picks = new Map();
  const chosen = id => {
    if (picks.has(id)) return picks.get(id);
    const row = rows.get(id), override = Object.hasOwn(overrides, id) ? overrides[id] : {};
    const inherited = row.source === 'library'
      ? row.kind === 'author' ? chosen('developer').seat : { model: 'sonnet', effort: 'high' } : defaults[id];
    const resolved = { inherited, seat: seatFrom(override) ?? inherited, row: {
      ...row, enabled: override.enabled ?? row.enabled, fresh: row.kind === 'reviewer' || (override.fresh ?? row.fresh),
    } };
    picks.set(id, resolved);
    return resolved;
  };
  const copies = Object.keys(overrides).sort().filter(id => overrides[id].from).map(id => [id, overrides[id]]);
  const team = builtIn.flatMap(base => {
    const resolved = chosen(base.id);
    const custom = copies.filter(([, value]) => value.from === base.id).map(([id, value]) => ({
      inherited: resolved.seat, seat: seatFrom(value) ?? resolved.seat,
      row: { id, name: value.name, duty: value.duty, detail: '', outputs: value.outputs, kind: base.kind, source: 'custom',
        from: base.id, enabled: value.enabled ?? true, fresh: base.kind === 'reviewer' || (value.fresh ?? resolved.row.fresh), locked: roleLocks(base.kind, 'custom') },
    }));
    return [resolved, ...custom];
  });
  const roles = team.map(item => item.row), enabled = roles.filter(row => row.enabled);
  return { team, roles: [...enabled, ...roles.filter(row => !row.enabled)], seats: enabled.map(row => row.id),
    authors: enabled.filter(row => row.kind === 'author').map(row => row.id),
    reviewers: enabled.filter(row => row.kind === 'reviewer').map(row => row.id),
    fresh: enabled.filter(row => row.fresh).map(row => row.id),
    effective: Object.fromEntries(team.filter(({ row, seat }) => row.enabled && seat).map(({ row, seat }) => [row.id, { ...seat }])) };
}

function validateTeam(team, config, catalog) {
  const error = checkTeamRules(team.roles);
  if (error) return { ok: false, ...error, message: error.code };
  const blocked = modelSeats.checkReviewer(team.effective, catalog, team.reviewers, team.authors);
  return blocked ? { ...blocked, role: blocked.seat } : operations.checkReview(config.operations, team.effective, catalog, team.authors);
}

function compactConfig(entry, config, team) {
  const base = new Map(baseRows(entry).map(row => [row.id, row]));
  const resolved = new Map(team.roles.map(row => [row.id, row]));
  const roles = Object.fromEntries(team.team.flatMap(({ row, seat, inherited }) => {
    if (!Object.hasOwn(config.roles, row.id)) return [];
    const override = config.roles[row.id], source = row.from ? resolved.get(row.from) : base.get(row.id);
    const fields = row.from ? { from: row.from, name: row.name, duty: row.duty, ...(row.outputs && { outputs: row.outputs }) } : {};
    if (row.enabled !== (row.from ? true : source.enabled)) fields.enabled = row.enabled;
    if (row.fresh !== source.fresh) fields.fresh = row.fresh;
    if (override.model !== undefined && !sameSeat(seat, inherited)) Object.assign(fields, seatFrom(override));
    return Object.keys(fields).length ? [[row.id, fields]] : [];
  }));
  const changed = operations.difference(config.operations, operations.defaults);
  return { roles, operations: Object.fromEntries(operationKeys.filter(id => Object.hasOwn(changed, id)).map(id => [id, changed[id]])) };
}

module.exports = { cleanConfig, compactConfig, emptyConfig, resolveTeam, validateTeam };
