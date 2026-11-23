const modelSeats = require('./model-seats.cjs');
const { roleKind, roleLocks, validRoleId, validateCustomRole, normalizeRoleText, checkTeamRules } = require('./role-rules.mjs');
const { familyOf, BASE_EFFORTS } = require('./seat-rules.mjs');
const { outsideFences, region } = require('./builtin-format.cjs');

const seatKeys = ['model', 'effort', 'fast', 'ultracode'];
const roleKeys = [...seatKeys, 'enabled', 'fresh', 'from', 'name', 'duty', 'outputs'];
const textKeys = ['name', 'duty', 'outputs'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const emptyConfig = () => ({ roles: {} });
const fail = (code, role, message = code) => { throw Object.assign(new Error(message), { code, role }); };
const unknownKey = (value, keys) => Object.keys(value).some(key => !keys.includes(key));
const unsafeFileModel = value => typeof value === 'string' && (value.endsWith(':') || value.includes('://'));
const fileEffort = value => {
  if (value?.effort === undefined || typeof value.model !== 'string') return true;
  const family = familyOf(value.model);
  return BASE_EFFORTS[family].includes(value.effort) || value.effort === (family === 'claude' ? 'adaptive' : 'minimal');
};

function roleConfig(id, raw, entry, catalog, stored, ignored, file) {
  if (stored && !validRoleId(id)) fail('bad-format');
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
  const isLead = id === entry.seats[0];
  if (Object.hasOwn(raw, 'ultracode') && typeof raw.ultracode !== 'boolean') fail('ultracode-not-allowed', id);
  if (seatKeys.some(key => Object.hasOwn(raw, key) && (key !== 'ultracode' || isLead))) {
    try {
      if (file && !fileEffort(raw)) fail('invalid-effort', id);
      Object.assign(fields, modelSeats.cleanSeat(raw, id, catalog, stored, isLead));
    }
    catch (error) {
      if (!stored) throw error;
      ignored.push('roles.' + id + '.seat');
    }
  }
  return fields;
}

function cleanConfig(raw, entry, catalog, stored = false, file = false) {
  if (!object(raw) || !object(raw.roles)) fail('bad-format');
  if (unknownKey(raw, ['roles', 'conductor'])) fail('unknown-key');
  if (raw.conductor !== undefined && typeof raw.conductor !== 'boolean') fail('bad-format');
  const ignored = [];
  const roles = Object.fromEntries(Object.entries(raw.roles).flatMap(([id, value]) => {
    if (file && unsafeFileModel(value?.model)) fail('bad-format', id);
    const fields = roleConfig(id, value, entry, catalog, stored, ignored, file);
    return fields ? [[id, fields]] : [];
  }));
  return { config: { roles, ...(raw.conductor && { conductor: true }) }, ignored: ignored.slice(0, 16) };
}

function baseRows(entry) {
  const authors = entry.authors ?? ['developer'], source = new Map((entry.roles || []).map(role => [role.id, role]));
  const row = (id, kind, type) => ({
    ...source.get(id) || { id, name: id, duty: '', detail: '', outputs: '' },
    kind, source: type, defaultEnabled: type === 'builtin', defaultFresh: !!entry.fresh?.includes(id) || kind === 'reviewer', locked: roleLocks(kind, type),
  });
  return entry.seats.flatMap((id, index) => [
    row(id, index === 0 ? 'lead' : roleKind(id, authors), 'builtin'),
    ...(id === 'developer' ? (entry.library || []).map(item => row(item, roleKind(item, authors), 'library')) : []),
  ]);
}

const seatFrom = override => override.model === undefined ? undefined : Object.fromEntries(seatKeys.filter(key => Object.hasOwn(override, key)).map(key => [key, override[key]]));
const sameSeat = (left, right) => left?.model === right?.model && left?.effort === right?.effort
  && !!left?.fast === !!right?.fast && !!left?.ultracode === !!right?.ultracode;

function resolveTeam(entry, config, defaults) {
  const builtIn = baseRows(entry), overrides = config.roles;
  const lead = defaults[entry.seats[0]], librarySeat = needsCodexFallback(defaults) ? lead : lead && { model: 'sonnet', effort: 'high' };
  const rows = new Map(builtIn.map(row => [row.id, row]));
  const picks = new Map();
  const chosen = id => {
    if (picks.has(id)) return picks.get(id);
    const row = rows.get(id), override = Object.hasOwn(overrides, id) ? overrides[id] : {};
    const inherits = row.source === 'library' && row.kind === 'author' ? 'developer' : undefined;
    const defaultSeat = row.source === 'library' ? librarySeat : defaults[id];
    const inherited = inherits ? chosen(inherits).seat : defaultSeat;
    const resolved = { inherited, seat: seatFrom(override) ?? inherited, row: {
      ...row, ...(inherits ? { inherits } : { defaultSeat }),
      enabled: override.enabled ?? row.defaultEnabled, fresh: override.fresh ?? row.defaultFresh,
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
        from: base.id, inherits: base.id, defaultEnabled: true, defaultFresh: resolved.row.fresh,
        enabled: value.enabled ?? true, fresh: value.fresh ?? resolved.row.fresh, locked: roleLocks(base.kind, 'custom') },
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

const needsCodexFallback = defaults => !Object.values(defaults).some(seat => familyOf(seat.model) === 'claude');
const englishNamesByEntry = new WeakMap();

function englishNames(entry) {
  if (englishNamesByEntry.has(entry)) return englishNamesByEntry.get(entry);
  const { visible } = outsideFences((entry.text || '').split(/\r?\n/));
  const names = ['team', 'library'].flatMap(name => {
    const bounds = region(visible, name);
    return bounds ? visible.slice(bounds.start + 1, bounds.end).flatMap(line => {
      const [, id, label] = line.split('|').map(cell => cell.trim());
      return label && (entry.seats.includes(id) || entry.library?.includes(id)) ? [label] : [];
    }) : [];
  });
  englishNamesByEntry.set(entry, names);
  return names;
}

function validateTeam(team, entry) {
  const error = checkTeamRules(team.roles, entry ? englishNames(entry) : []);
  return error ? { ok: false, ...error, message: error.code } : null;
}

function compactConfig(entry, config) {
  const both = { claude: true, codex: true };
  const team = resolveTeam(entry, config, modelSeats.defaultsFor(both, [], entry.seats));
  const roles = Object.fromEntries(team.team.flatMap(({ row, seat, inherited }) => {
    if (!Object.hasOwn(config.roles, row.id)) return [];
    const override = config.roles[row.id];
    const fields = row.from ? { from: row.from, name: row.name, duty: row.duty, ...(row.outputs && { outputs: row.outputs }) } : {};
    if (row.enabled !== row.defaultEnabled) fields.enabled = row.enabled;
    if (row.fresh !== row.defaultFresh) fields.fresh = row.fresh;
    if (override.model !== undefined && !sameSeat(seat, inherited)) Object.assign(fields, seatFrom(override));
    return Object.keys(fields).length ? [[row.id, fields]] : [];
  }));
  return { roles, ...(config.conductor && { conductor: true }) };
}

module.exports = { cleanConfig, compactConfig, emptyConfig, resolveTeam, validateTeam };
