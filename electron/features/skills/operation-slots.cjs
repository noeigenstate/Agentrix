const { BASE_EFFORTS, EFFORT, familyOf, validModel, unsupportedEffort,
  BACKGROUND_MODEL_ENV: BACKGROUND, SUBAGENT_MODEL_ENV: SUBAGENT } = require('./seat-rules.mjs');
const { checkReviewer, concreteAlias } = require('./model-seats.cjs');

const CODEX_KEYS = {
  subagent: ['agents.default_subagent_model', 'agents.default_subagent_reasoning_effort'],
  memory: ['memories.extract_model', 'memories.consolidation_model'],
  review: ['review_model'],
};
const slots = {
  lookup: { name: '检索', nameEn: 'Lookup', covers: 'Searching, listing and reading files, log excerpts',
    families: ['claude', 'codex'], effort: 'always', default: { model: 'haiku', effort: 'high' } },
  background: { name: '后台小任务', nameEn: 'Background helpers', covers: "Claude Code's light background calls, including titles and web-page summaries",
    families: ['claude'], effort: 'never', default: { model: 'haiku' }, note: "Claude Code's built-in Explore agent also follows this setting." },
  subagent: { name: '子代理默认', nameEn: 'Sub-agent default', covers: 'Sub-agents started without an explicit model',
    families: ['claude', 'codex'], effort: 'codex', follow: 'follows the conversation', default: 'follow' },
  memory: { name: '记忆整理', nameEn: 'Memory', covers: 'Extracting and consolidating memories', families: ['codex'], effort: 'never', follow: 'Codex default',
    default: 'follow', note: 'This setting applies when Codex memories are enabled.' },
  review: { name: '审查', nameEn: 'Review pass', covers: "Codex's built-in review (/review, review/start)", families: ['codex'], effort: 'never',
    follow: 'Reviewer seat', default: 'follow' },
  compaction: { name: '压缩', nameEn: 'Compaction', covers: "Compacting a long conversation's context", note: 'Built into Claude Code and Codex.' },
  titles: { name: '标题', nameEn: 'Titles', covers: 'Conversation titles', note: 'Built in. Claude titles move with the background helpers.' },
};
const defaults = Object.fromEntries(Object.entries(slots).flatMap(([id, slot]) => slot.default ? [[id, slot.default]] : []));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const refusal = (code, operation, message) => ({ ok: false, code, operation, message });
const fail = (code, id, message) => { throw Object.assign(new Error(message), refusal(code, id, message)); };
const allowsEffort = (slot, family) => slot.effort === 'always' || slot.effort === family;

function cleanValue(id, value, catalog) {
  const slot = Object.hasOwn(defaults, id) && slots[id];
  if (!slot) fail('unknown-operation', id, 'Unknown operation.');
  if (value === 'follow') {
    if (!slot.follow) fail('follow-not-allowed', id, 'This operation requires a model.');
    return value;
  }
  if (!object(value) || !validModel(value.model) || Object.keys(value).some(key => !['model', 'effort'].includes(key))) {
    fail('invalid-model', id, 'Expected a valid model id of at most 160 characters and an optional effort.');
  }
  const { model, effort } = value, family = familyOf(model);
  if (!slot.families.includes(family)) fail('family-not-allowed', id, `This operation requires a ${slot.families[0] === 'claude' ? 'Claude' : 'Codex'} model.`);
  if (effort === undefined) return { model };
  if (!allowsEffort(slot, family) || typeof effort !== 'string' || !EFFORT.test(effort)
      || catalog && !(catalog.find(row => row.model === model)?.efforts || BASE_EFFORTS[family]).includes(effort)) {
    fail('invalid-effort', id, unsupportedEffort(family));
  }
  return { model, effort };
}

function clean(raw, catalog) {
  if (!object(raw)) fail('invalid-model', undefined, 'Expected an operation map.');
  return Object.fromEntries(Object.entries(raw).map(([id, value]) => [id, cleanValue(id, value, catalog)]));
}

function cleanStored(raw) {
  if (!object(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([id, value]) => {
    try { return [[id, cleanValue(id, value)]]; } catch { return []; }
  }));
}

const resolve = (global, project) => structuredClone({ ...defaults, ...global, ...project });
const difference = (values, lower) => Object.fromEntries(Object.entries(values).filter(([id, value]) =>
  typeof value === 'string' || typeof lower[id] === 'string' ? value !== lower[id]
    : value.model !== lower[id]?.model || value.effort !== lower[id]?.effort));

function checkReview(values, seats, catalog) {
  const { review } = values;
  if (!review || review === 'follow') return null;
  const blocked = checkReviewer({ reviewer: review, developer: seats.developer }, catalog);
  return blocked ? refusal('review-same-model', 'review', blocked.message) : null;
}

function backgroundModel(model, catalog) {
  if (model === 'haiku') return {};
  const pinnedHaiku = concreteAlias('haiku', catalog);
  if (!pinnedHaiku) return { reason: 'No concrete Haiku version is listed.' };
  const target = ['opus', 'sonnet'].includes(model) ? concreteAlias(model, catalog) : model;
  if (!target) return { reason: `No concrete ${model} version is listed.` };
  return { target, pinnedHaiku };
}

function choicesFor(values, seats, catalog) {
  const choices = {};
  for (const [id, value] of Object.entries(values)) {
    if (value === 'follow') {
      choices[id] = id === 'review' && seats.reviewer && familyOf(seats.reviewer.model) === 'codex' ? { model: seats.reviewer.model } : null;
      continue;
    }
    const family = familyOf(value.model), row = catalog.find(row => row.model === value.model), efforts = row?.efforts || BASE_EFFORTS[family];
    const defaultLookup = id === 'lookup' && value.model === defaults.lookup.model && value.effort === defaults.lookup.effort;
    const effort = defaultLookup || efforts.includes(value.effort) ? value.effort : row?.defaultEffort || (efforts.includes('high') ? 'high' : efforts[0]);
    choices[id] = allowsEffort(slots[id], family) ? { model: value.model, effort } : { model: value.model };
  }
  return choices;
}

function agentStates(choices, installed, background) {
  return Object.fromEntries(Object.entries(choices).map(([id, choice]) => {
    const state = agent => {
      if (!slots[id].families.includes(agent) || choice && familyOf(choice.model) !== agent) return { state: 'not-applicable' };
      if (!installed[agent]) return { state: 'not-effective', reason: agent === 'claude' ? 'Claude Code is not installed.' : 'Codex is not installed.' };
      if (id === 'background' && background.reason) return { state: 'not-effective', reason: background.reason };
      return { state: 'applies' };
    };
    return [id, { claude: state('claude'), codex: state('codex') }];
  }));
}

function levers(input, seats, catalog, installed) {
  const values = resolve(input), choices = choicesFor(values, seats, catalog);
  const background = installed.claude ? backgroundModel(choices.background.model, catalog) : {};
  const agents = agentStates(choices, installed, background);
  const applies = (id, agent) => agents[id][agent].state === 'applies' && choices[id];
  const claude = { env: {} }, codex = { config: {} };
  if (background.target) claude.env[BACKGROUND] = background.target;
  if (applies('subagent', 'claude')) {
    const model = choices.subagent.model;
    claude.env[SUBAGENT] = model === 'haiku' && background.pinnedHaiku ? background.pinnedHaiku : model;
  }
  if (applies('lookup', 'claude')) {
    const { model, effort } = choices.lookup;
    claude.lookupAgent = { model: model === 'haiku' && background.pinnedHaiku ? background.pinnedHaiku : model, effort };
  }
  for (const [id, keys] of Object.entries(CODEX_KEYS)) {
    if (!applies(id, 'codex')) continue;
    for (const key of keys) codex.config[key] = key.endsWith('_effort') ? choices[id].effort : choices[id].model;
  }
  return { values, choices, agents, claude, codex, pinnedHaiku: background.pinnedHaiku };
}

const version = model => (/\d+(?:[.-]\d+)*/.exec(model)?.[0] || '').split(/[.-]/).map(Number);
function newest(left, right) {
  const a = version(left), b = version(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const order = (b[index] || 0) - (a[index] || 0);
    if (order) return order;
  }
  return right.localeCompare(left, 'en', { numeric: true });
}

function makeRows(operation, catalog) {
  const suggestion = catalog.filter(row => row.family === 'codex' && row.available && row.listed !== false && row.rank < 3)
    .sort((a, b) => a.rank - b.rank || newest(a.model, b.model))[0]?.model;
  const readOnly = { claude: { state: 'not-applicable' }, codex: { state: 'not-applicable' } };
  return Object.entries(slots).map(([id, slot]) => ({
    id, families: [], effort: 'never', follow: null, default: null, ...structuredClone(slot), editable: !!slot.default,
    effective: operation.choices[id] ?? null, agents: operation.agents[id] ?? readOnly,
    ...(id === 'memory' && suggestion ? { suggestion } : {}),
  }));
}

function applyRefusals(agents, refused) {
  const result = structuredClone(agents);
  for (const [id, keys] of Object.entries(CODEX_KEYS)) {
    const reason = keys.map(key => refused[key]).find(Boolean);
    if (reason && result[id].codex.state === 'applies') result[id].codex = { state: 'not-effective', reason };
  }
  return result;
}

module.exports = { defaults, clean, cleanStored, resolve, difference, checkReview, levers, makeRows, applyRefusals };
