// C-1: a Reason says why something is not as expected, as a code from a closed table and flat facts; the words for it
// are chosen by the window from src/shared/reason-words. Plain Node: the dispatcher's helper carries this file.
const { stderrTail } = require('../features/agents/start-failure.cjs');

const TABLES = {
  claude: require('./reasons/claude.cjs'),
  dispatch: require('./reasons/dispatch.cjs'),
  term: require('./reasons/term.cjs'),
  codex: require('./reasons/codex.cjs'),
};
const DETAIL_LIMIT = 300;
const FIELDS = ['code', 'params', 'detail', 'stage', 'source', 'observedAt'];

const entryOf = code => {
  if (typeof code !== 'string') return null;
  const dot = code.indexOf('.'), ns = code.slice(0, dot), name = code.slice(dot + 1);
  return dot > 0 && Object.hasOwn(TABLES, ns) && Object.hasOwn(TABLES[ns].codes, name) ? TABLES[ns].codes[name] : null;
};
const isFlat = params => !!params && typeof params === 'object' && !Array.isArray(params)
  && Object.values(params).every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value));

// The codes of one namespace as full codes, "<ns>.<name>".
function codesOf(ns) {
  if (!Object.hasOwn(TABLES, ns)) throw new Error(`Unknown reason namespace: ${ns}`);
  return Object.keys(TABLES[ns].codes).map(name => `${ns}.${name}`);
}

// Why the field values are not a Reason of this code, or null.
function problemOf(code, value) {
  const { params, detail, stage, source, observedAt } = value;
  const entry = entryOf(code);
  if (!entry) return `unknown code ${code}`;
  const extra = Object.keys(value).filter(name => !FIELDS.includes(name));
  if (extra.length) return `${extra.join(', ')} is not a Reason field`;
  if (typeof source !== 'string' || !source) return 'source is missing';
  if (!Number.isFinite(observedAt)) return 'observedAt is not a time';
  if (params !== undefined && !isFlat(params)) return 'params is not a flat map of strings, numbers, booleans and null';
  const undeclared = Object.keys(params || {}).filter(name => !entry.params?.includes(name));
  if (undeclared.length) return `${undeclared.join(', ')} is not a param of ${code}`;
  if (detail !== undefined && (typeof detail !== 'string' || /[\r\n]/.test(detail) || detail.length > DETAIL_LIMIT)) return `detail is not one line of at most ${DETAIL_LIMIT} characters`;
  if (stage !== undefined && !entry.stages?.includes(stage)) return `stage ${stage} is not one of ${(entry.stages || []).join(', ') || 'none'}`;
  return null;
}

// fields: { source, params?, detail?, stage?, observedAt? }. A detail, which may come from process output, is redacted
// and cut to one line first. Throws on an unknown code or a field that breaks the contract.
function reason(code, fields = {}) {
  // The code is the first argument only: one in fields would replace it after the checks of the code asked for.
  if (Object.hasOwn(fields, 'code')) throw new Error(`Invalid reason ${code}: code is not one of the fields`);
  const { detail, observedAt = Date.now(), ...rest } = fields;
  const redacted = detail === undefined ? undefined : stderrTail(String(detail), { limit: DETAIL_LIMIT });
  const built = { code, ...rest, ...(redacted ? { detail: redacted } : {}), observedAt };
  const problem = problemOf(code, built);
  if (problem) throw new Error(`Invalid reason ${code}: ${problem}`);
  return built;
}

const isReason = value => !!value && typeof value === 'object' && typeof value.code === 'string' && !problemOf(value.code, value);

module.exports = { reason, isReason, codesOf };
