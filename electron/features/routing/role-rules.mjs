export const MAX_CUSTOM_ROLES = 8;
export const MAX_ENABLED_ROLES = 16;
export const ROLE_TEXT_LIMITS = Object.freeze({ name: [1, 12], duty: [1, 160], outputs: [0, 60] });

export const validRoleId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(id);
export const validCustomRoleId = id => typeof id === 'string' && /^x-[a-z][a-z0-9-]{1,21}$/.test(id);

/** @param {string} from @param {Iterable<string>} taken */
export function nextRoleId(from, taken) {
  const used = new Set(taken);
  let number = 1;
  while (used.has('x-' + from + '-' + number)) number++;
  return 'x-' + from + '-' + number;
}

/** @param {string} id @param {readonly string[]} authors */
export function roleKind(id, authors) {
  if (id === 'orchestrator') return 'lead';
  if (id === 'reviewer') return 'reviewer';
  return authors.includes(id) ? 'author' : 'member';
}

/** @typedef {'enabled' | 'fresh' | 'text' | 'copy'} RoleLock */

/** @param {ReturnType<typeof roleKind>} kind @param {'builtin' | 'library' | 'custom'} source @returns {RoleLock[]} */
export function roleLocks(kind, source) {
  if (kind === 'lead') return ['enabled', 'text', 'copy'];
  return source === 'custom' ? [] : ['text'];
}

const TEXT = /^[\p{L}\p{N}\p{M} &+.,()\-\u3001\uFF0C\u3002\uFF08\uFF09\u00B7]*$/u;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/** @param {keyof typeof ROLE_TEXT_LIMITS} field @param {unknown} value */
export function normalizeRoleText(field, value) {
  if (typeof value !== 'string' || !TEXT.test(value) || IGNORABLE.test(value)) return null;
  const text = value.normalize('NFC').trim(), length = [...text].length;
  const [min, max] = ROLE_TEXT_LIMITS[field];
  const badMarks = /(?:^|[^\p{L}\p{N}\p{M}])\p{M}|\p{M}{3}/u.test(text.normalize('NFD'));
  if (length < min || length > max || text.includes('  ') || badMarks) return null;
  if (field === 'name' && /[,.()]/.test(text)) return null;
  return text;
}

// Fold letters separately so final sigma and ligatures compare with their equivalents.
// Dotless i has a distinct default fold outside Turkic locales.
const nameKey = name => [...name.normalize('NFKC').toLowerCase()]
  .map(char => char === '\u0131' ? char : char.toUpperCase().toLowerCase()).join('').normalize('NFC');

/** @param {string} id @param {{ from?: string, name?: unknown, duty?: unknown, outputs?: unknown }} config @param {readonly string[]} sources */
export function validateCustomRole(id, config, sources) {
  if (!validCustomRoleId(id) || !config.from || config.from === 'orchestrator' || !sources.includes(config.from)) {
    return { code: /** @type {const} */ ('invalid-role'), role: id };
  }
  const fields = /** @type {const} */ (['name', 'duty', 'outputs']);
  const badField = fields.find(field => normalizeRoleText(field, field === 'outputs' && config.outputs === undefined ? '' : config[field]) === null);
  return badField ? { code: /** @type {const} */ ('role-text'), role: id, field: badField } : null;
}

/** @param {readonly { id: string, name: string, enabled: boolean, kind: ReturnType<typeof roleKind>, source: string }[]} roles @param {readonly string[]} reservedNames */
export function checkTeamRules(roles, reservedNames = []) {
  const enabled = roles.filter(role => role.enabled);
  const leads = roles.filter(role => role.kind === 'lead');
  if (leads.length !== 1 || !leads[0].enabled) return { code: /** @type {const} */ ('lead-locked'), role: leads[0]?.id };
  if (roles.filter(role => role.source === 'custom').length > MAX_CUSTOM_ROLES || enabled.length > MAX_ENABLED_ROLES) {
    return { code: /** @type {const} */ ('role-limit') };
  }
  const names = new Set();
  const reserved = new Set([...reservedNames, ...roles.filter(role => role.source !== 'custom').map(role => role.name)].map(nameKey));
  const collision = roles.find(role => role.source === 'custom' && reserved.has(nameKey(role.name)));
  if (collision) return { code: /** @type {const} */ ('role-text'), role: collision.id, field: /** @type {const} */ ('name') };
  for (const role of enabled) {
    const key = nameKey(role.name);
    if (names.has(key)) return { code: /** @type {const} */ ('role-text'), role: role.id, field: /** @type {const} */ ('name') };
    names.add(key);
  }
  return null;
}

