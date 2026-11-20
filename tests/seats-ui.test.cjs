const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const seatsLib = require('../src/features/agents/skill-seats.ts');
const { paletteGroups, lineOf, shortLabel, menuPlacement, withInstalled, canonicalModel, sameModel, assignModel, assignCustom,
  rowFor, issuesOf, ageOf, swapSlots, setEffort, setFast, baselineFor,
  startScope, fallbackFor, saveSeats } = seatsLib;
const reviewerRoles = { authors: ['developer'], reviewers: ['reviewer'] };
const reviewerBlock = (map, catalog, defaults, roles = reviewerRoles) => seatsLib.reviewerBlock(map, catalog, defaults, roles);
const firstRefusal = (map, catalog) => seatsLib.firstRefusal(map, catalog, reviewerRoles);
const topAlternatives = (rows, max, context) => seatsLib.topAlternatives(rows, max,
  context && { ...context, authors: reviewerRoles.authors, reviewer: 'reviewer' });

const en = require('../electron/locales/en.json');
const additions = path.join(__dirname, '../locale-additions-seats2.json');
if (fs.existsSync(additions)) Object.assign(en, JSON.parse(fs.readFileSync(additions, 'utf8')));

// ---- fixtures: the catalog and defaults main sends (model-seats.cjs: opus = sol = 3, sonnet 2, haiku 1) ----
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'], GPT_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const row = (model, label, family, rank, extra = {}) => ({ model, label, family, efforts: family === 'claude' ? CLAUDE_EFFORTS : GPT_EFFORTS, fast: family === 'codex', rank, available: true, ...extra });
const catalog = (overrides = {}) => [row('opus', 'Opus', 'claude', 3), row('sonnet', 'Sonnet', 'claude', 2), row('haiku', 'Haiku', 'claude', 1), row('gpt-6.2-sol', 'GPT-6.2-Sol', 'codex', 3)]
  .map(entry => ({ ...entry, ...overrides[entry.model] }));
const team = require('./fixtures/team-seats.json');
const DEFAULTS = team.defaults;
const { roleKind, roleLocks } = require('../electron/features/skills/role-rules.mjs');
const shipped = (role, source = 'builtin') => {
  const kind = roleKind(role.id, ['developer', 'frontend']);
  const defaultEnabled = source === 'builtin', defaultFresh = ['qa', 'reviewer'].includes(role.id);
  return { ...role, source, kind, enabled: defaultEnabled, fresh: defaultFresh, defaultEnabled, defaultFresh, locked: roleLocks(kind, source) };
};
const source = (patch = {}) => ({ layer: 'file', state: 'trusted', remote: false, path: '.agentrix/routing.json', digest: 'at-open', actions: [], ...patch });
const SEATS = team.seats;
const clone = value => JSON.parse(JSON.stringify(value));
function seatsInfo({ global = {}, project = null, operations, ...overrides } = {}) {
  const config = (roles, operations) => ({ roles, operations: operations ?? {} });
  const template = config(global, operations?.template);
  const applied = project || operations?.config ? config(project ?? {}, operations?.config) : null;
  return {
    skill: 'model-routing', seats: SEATS, roles: team.roles.map(role => shipped(role)), lead: 'orchestrator',
    authors: ['developer'], leadAgent: 'claude', leads: { claude: DEFAULTS.orchestrator, codex: DEFAULTS.developer },
    fresh: ['qa', 'reviewer'], defaults: clone(DEFAULTS), template, config: applied,
    effective: { ...clone(DEFAULTS), ...(applied ?? template).roles }, current: null, currentRoles: null, leadPending: null, routing: source(), operations,
    catalog: catalog(), installed: { claude: true, codex: true }, ...overrides,
  };
}

test('the mirror holds a reviewer to the rank rule: refused only while another available model at least as strong exists', () => {
  const same = { ...clone(DEFAULTS), developer: { model: 'opus', effort: 'high' } };
  const block = reviewerBlock(same, catalog());
  assert.deepEqual(block.hit, ['developer'], 'the reviewer runs the developer seat’s model');
  assert.deepEqual(block.alternatives.map(entry => entry.model), ['gpt-6.2-sol'], 'sonnet is weaker and does not count');
  assert.equal(block.fix.model, 'gpt-6.2-sol', 'the one-click fix is a model no author seat runs');
  assert.equal(firstRefusal(same, catalog()).code, 'reviewer-same-model');
  const single = catalog({ 'gpt-6.2-sol': { available: false, reason: 'Codex is not installed.' }, sonnet: { available: false, reason: 'off' }, haiku: { available: false, reason: 'off' } });
  assert.equal(reviewerBlock(same, single), null, 'a single-model setup may keep the same model');
  assert.equal(firstRefusal(same, single), null);
  const sonnet = { ...clone(DEFAULTS), developer: { model: 'sonnet', effort: 'high' }, reviewer: { model: 'sonnet', effort: 'high' } };
  assert.ok(reviewerBlock(sonnet, catalog()), 'sonnet has opus and sol above it');
  assert.equal(reviewerBlock(clone(DEFAULTS), catalog()), null, 'the defaults pass');
  assert.equal(reviewerBlock({ ...same, reviewer: { model: 'opus', effort: 'high' } }, catalog({ 'gpt-6.2-sol': { available: false } })), null, 'an alternative that is not available does not count');
  assert.equal(reviewerBlock({ ...same, reviewer: { model: 'unlisted-gpt', effort: 'high' }, developer: { model: 'unlisted-gpt', effort: 'high' } }, catalog())?.fix.model, 'opus', 'an unlisted GPT id ranks 3, as main ranks it');
});

test('the orchestrator accepts either family, with the model’s own effort and fast limits', () => {
  const map = clone(DEFAULTS);
  assert.equal(assignModel(map, 'orchestrator', 'gpt-6.2-sol', catalog()).map.orchestrator.model, 'gpt-6.2-sol');
  assert.equal(assignModel(map, 'developer', 'opus', catalog()).map.developer.model, 'opus');
  assert.deepEqual(setFast(map, 'designer', true, catalog()), { ok: false, reason: 'fast' });
  assert.deepEqual(setEffort(map, 'developer', 'max', catalog()), { ok: false, reason: 'effort' });
  assert.equal(firstRefusal({ ...map, designer: { model: 'sonnet', effort: 'high', fast: true } }, catalog()).code, 'fast-not-allowed');
});

test('assigning and swapping keep the settings a model can use and drop the ones it cannot', () => {
  const map = clone(DEFAULTS);
  const toClaude = assignModel(map, 'developer', 'sonnet', catalog());
  assert.deepEqual(toClaude.map.developer, { model: 'sonnet', effort: 'high' }, 'a Claude model takes no fast flag');
  const toGpt = assignModel({ ...map, designer: { model: 'sonnet', effort: 'max' } }, 'designer', 'gpt-6.2-sol', catalog());
  assert.deepEqual(toGpt.map.designer, { model: 'gpt-6.2-sol', effort: 'high', fast: true }, 'max is not a GPT effort; a new GPT seat starts fast');
  assert.deepEqual(assignModel(map, 'developer', 'gpt-6.2-sol', catalog()), { ok: false, reason: 'same' });
  assert.deepEqual(assignModel(map, 'developer', 'nope', catalog()), { ok: false, reason: 'unknown-model' });
  const swapped = swapSlots({ ...map, designer: { model: 'sonnet', effort: 'max' } }, 'developer', 'designer', catalog());
  assert.deepEqual(swapped.map.developer, { model: 'sonnet', effort: 'max' }, 'sonnet moves to developer with its own settings: no fast flag appears');
  assert.deepEqual(swapped.map.designer, { model: 'gpt-6.2-sol', effort: 'high', fast: true });
  assert.equal(map.developer.model, 'gpt-6.2-sol', 'the input map is not mutated');
  assert.deepEqual(swapSlots(map, 'researcher', 'researcher', catalog()), { ok: false, reason: 'same' });
});

test('an unavailable model cannot be placed and its seat shows the default it falls back to', () => {
  const off = catalog({ 'gpt-6.2-sol': { available: false, reason: 'Codex is not installed.' } });
  assert.deepEqual(assignModel(clone(DEFAULTS), 'designer', 'gpt-6.2-sol', off), { ok: false, reason: 'unavailable' });
  const info = seatsInfo({ catalog: off, defaults: { ...clone(DEFAULTS), developer: { model: 'opus', effort: 'high' } } });
  const working = { ...clone(DEFAULTS), developer: { model: 'gpt-6.2-sol', effort: 'high', fast: true } };
  assert.equal(fallbackFor(info, 'developer', working).model, 'opus', 'the seat’s default stands in');
  assert.equal(fallbackFor(info, 'designer', working), null, 'an available model needs none');
});

test('the applied project layer starts at built-in defaults and excludes template roles', () => {
  const project = { architect: { model: 'opus', effort: 'max' } };
  const info = seatsInfo({ global: { reviewer: { model: 'sonnet', effort: 'low' } }, project });
  const baseline = baselineFor(info, 'project');
  assert.equal(startScope(info, 'p1'), 'project');
  assert.deepEqual(baseline.architect, project.architect);
  assert.deepEqual(baseline.reviewer, DEFAULTS.reviewer);
  assert.deepEqual(seatsLib.cleanDraft(info, info.config), { roles: project, operations: {} });
});

test('routing saves send one scoped config and the on-disk base, and preserve structured refusals', async () => {
  const calls = [], config = { roles: { architect: { model: 'sonnet', effort: 'low' } }, operations: {} };
  const api = { setSkillRouting: async (...args) => { calls.push(args); return { ok: true }; } };
  assert.deepEqual(await saveSeats(api, 'project', 'p1', config, 'original'), { ok: true });
  assert.deepEqual(await saveSeats(api, 'template', 'p1', config, 'original'), { ok: true });
  assert.deepEqual(calls, [['project', 'p1', config, 'original'], ['template', null, config, null]]);
  const error = { ok: false, code: 'file-changed', message: 'Changed' };
  const refused = await saveSeats({ setSkillRouting: async () => error }, 'project', 'p1', config, 'original');
  assert.deepEqual(refused, { ok: false, message: error.message, error });
  assert.deepEqual(await saveSeats({ setSkillRouting: async () => { throw new Error('ipc closed'); } },
    'template', null, config, null), { ok: false, message: 'ipc closed' });
});

// ---- a component harness: the hooks the components use, run without a DOM; a test re-renders after each handler ----
function compile(file, hooks, stubs = {}) {
  const filename = path.join(__dirname, '..', 'src/features/agents', file), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  const icon = new Proxy({}, { get: () => () => null });
  mod.require = name => {
    if (name === 'react') return { ...React, ...hooks };
    if (name === 'react-dom') return { createPortal: node => node };
    if (name === '@phosphor-icons/react') return icon;
    if (name === '../../shared/i18n') return {
      currentLanguage: () => stubs.language ?? 'en',
      t: (text, values = {}) => (stubs.language === 'zh' ? text : en[text] ?? text).replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match),
    };
    if (name === './skill-seats') return seatsLib;
    if (['./OperationRows', './RoleEditor', './RoutingReview'].includes(name)) return compile(name.slice(2) + '.tsx', hooks, stubs);
    if (name.endsWith('/role-rules.mjs')) return original(name);
    if (name === '../../shared/routing-command.ts') return { OPEN_SEATS: 'agentrix:open-seats',
      routingModelName: require('../src/shared/routing-command.ts').routingModelName,
      routingRoleName: text => stubs.language === 'zh' ? text : en['席位 · ' + text] ?? en[text] ?? text,
      openSeats: detail => window.dispatchEvent(new CustomEvent('agentrix:open-seats', { detail })) };
    if (name === '../../shared/model-name') return require('../src/shared/model-name.ts');
    if (name.endsWith('.css')) return {};
    if (name in stubs) return stubs[name];
    return name.startsWith('.') ? {} : original(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return mod.exports;
}
function mount(t, file, name, props, stubs) {
  const slots = [], effects = [], previous = { window: globalThis.window, document: globalThis.document };
  let cursor = 0;
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(callback, deps) {
      const index = cursor++, last = slots[index];
      if (last && deps.every((value, at) => Object.is(value, last.deps[at]))) return;
      effects.push(() => { last?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
    },
  };
  const component = compile(file, hooks, stubs)[name];
  const handle = { props, render(commit) { cursor = 0; const tree = component(handle.props); commit?.(tree); while (effects.length) effects.shift()(); return tree; }, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
  t.after(() => { handle.unmount(); globalThis.window = previous.window; globalThis.document = previous.document; });
  return handle;
}
const inlineComponents = new Set([
  'RoutingTabs', 'MenuHeader', 'OperationRows', 'OperationTitle', 'OperationCard', 'CurrentOperations', 'OperationSummary', 'Status',
  'DialogHeader', 'DialogStrip', 'ConversationChoices', 'TeamChart', 'ModelPalette', 'DialogMenu', 'ReviewOperationBanner',
  'RoleLibrary', 'RoleActions', 'RoutingReview', 'RoleTextFields', 'RoleModel',
]);
const childrenOf = node => inlineComponents.has(node.type?.name) ? node.type(node.props) : node.props.children;
const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach(child => walk(child, visit));
  if (!node || typeof node !== 'object' || !node.props) return;
  visit(node);
  walk(childrenOf(node), visit);
};
const findAll = (tree, test) => { const found = []; walk(tree, node => { if (test(node)) found.push(node); }); return found; };
const find = (tree, test) => findAll(tree, test)[0];
const byAttr = (tree, attr, value) => find(tree, node => value === undefined ? node.props[attr] !== undefined : node.props[attr] === value);
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return node?.props ? textOf(childrenOf(node)) : '';
}
const pickButton = (slot) => ({ detail: 0, currentTarget: { getBoundingClientRect: () => ({ left: 100, top: 168, bottom: 200 }), focus() {} }, slot });
const settle = async () => { for (let turn = 0; turn < 6; turn++) await null; };

function dialogHarness(t, info, props = {}) {
  const calls = [], closed = [], refreshes = [];
  let current = info, changed;
  const api = {
    onSkills: listener => { changed = listener; return () => { changed = undefined; }; },
    skillSeats: async () => current,
    resolveSkillRouting: props.resolveSkillRouting,
    setSkillRouting: async (...args) => {
      calls.push(args);
      if (props.reply && !props.reply.ok) return props.reply;
      const [scope, , config] = args, key = scope === 'project' ? 'config' : 'template';
      current = { ...current, [key]: config, routing: source() };
      if (current.operations) current.operations = { ...current.operations, [key]: config.operations };
      return { ok: true };
    },
    skillSeatsRefresh: async (...args) => { refreshes.push(args); if (props.refreshError) throw new Error(props.refreshError); return props.refreshed ?? null; } };
  globalThis.window = { agentrix: api, innerWidth: 1280, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
  const listeners = [];
  globalThis.document = { activeElement: null, elementFromPoint: () => null, addEventListener: (type, fn) => listeners.push([type, fn]), removeEventListener: (type, fn) => { const at = listeners.findIndex(entry => entry[0] === type && entry[1] === fn); if (at >= 0) listeners.splice(at, 1); } };
  const h = mount(t, 'SeatsDialog.tsx', 'SeatsDialog',
    { info, projectId: 'p1', terminalId: 't1', onClose: () => closed.push(true), ...props.dialog }, { language: props.language });
  const outsideMouseDown = target => listeners.filter(entry => entry[0] === 'mousedown').forEach(entry => entry[1]({ target }));
  return Object.assign(h, { calls, closed, refreshes, deliver: next => { current = next; changed?.(); }, outsideMouseDown });
}
const keyEvent = key => ({ key, stopPropagation() {}, preventDefault() {} });

function operationInfo({ global = {}, project = null, ...overrides } = {}) {
  const defaults = { lookup: { model: 'haiku', effort: 'high' }, background: { model: 'haiku' }, subagent: 'follow', memory: 'follow', review: 'follow' };
  const entries = [
    ['lookup', '检索', 'Lookup', ['claude', 'codex'], 'always', null],
    ['background', '后台小任务', 'Background helpers', ['claude'], 'never', null],
    ['subagent', '子代理默认', 'Sub-agent default', ['claude', 'codex'], 'codex', 'follows the conversation'],
    ['memory', '记忆整理', 'Memory', ['codex'], 'never', 'Codex default'],
    ['review', '审查', 'Review pass', ['codex'], 'never', 'Reviewer seat'],
    ['compaction', '压缩', 'Compaction', [], 'never', null],
    ['titles', '标题', 'Titles', [], 'never', null],
  ];
  const rows = entries.map(([id, name, nameEn, families, effort, follow]) => ({
    id, name, nameEn, covers: nameEn, families, effort, follow, editable: !!defaults[id], default: defaults[id] ?? null,
    effective: typeof defaults[id] === 'object' ? defaults[id] : null,
    agents: {
      claude: { state: families.includes('claude') ? 'applies' : 'not-applicable' },
      codex: id === 'memory' ? { state: 'not-effective', reason: 'The provider refused memories.consolidation_model.' }
        : { state: families.includes('codex') ? 'applies' : 'not-applicable' },
    },
    ...(id === 'memory' ? { suggestion: 'gpt-6-mini' } : {}),
  }));
  return { rows, defaults, template: global, config: project, effective: { ...defaults, ...(project ?? global) }, current: null, ...overrides };
}

const operationCatalog = () => [
  ...catalog({ sonnet: { available: false, reason: 'Unavailable from this account.', listed: false } }),
  row('gpt-6-mini', 'GPT-6 Mini', 'codex', 1),
];
function showOperations(h) {
  byAttr(h.render(), 'data-routing-tab', 'operations').props.onClick();
  return h.render();
}
function operationMenu(h, id, attr = 'data-op-model') {
  byAttr(h.render(), attr, id).props.onClick(pickButton(id));
  return find(h.render(), node => node.props.role === 'menu');
}
const menuRows = menu => findAll(menu, node => node.props['data-assign'] !== undefined);

test('a refused operation save keeps the draft and names the operation', async t => {
  const error = { ok: false, code: 'review-same-model', operation: 'review', message: 'Choose a different review model.' };
  const h = dialogHarness(t, seatsInfo({ operations: operationInfo(), catalog: operationCatalog() }), { reply: error });
  showOperations(h);
  // Main can see another project's Developer seat, which the dialog cannot validate locally.
  byAttr(operationMenu(h, 'review'), 'data-assign', 'gpt-6-mini').props.onClick();
  byAttr(h.render(), 'data-save').props.onClick();
  await settle();
  const tree = h.render();
  assert.match(textOf(find(tree, node => node.props['data-kind'] === 'error')), /Review pass: Choose a different review model/);
  assert.equal(textOf(byAttr(tree, 'data-op-model', 'review')), 'GPT-6 Mini');
  assert.equal(byAttr(tree, 'data-save').props.disabled, false);
});

test('review operations block a Developer collision before IPC and offer a valid Codex alternative', async t => {
  const rows = [...operationCatalog(), row('gpt-6.2-astra', 'GPT-6.2 Astra', 'codex', 3)];
  const h = dialogHarness(t, seatsInfo({ operations: operationInfo(), catalog: rows }));
  showOperations(h);
  byAttr(operationMenu(h, 'review'), 'data-assign', 'gpt-6.2-sol').props.onClick();
  let tree = h.render();
  assert.ok(byAttr(byAttr(tree, 'data-operation', 'review'), 'data-op-blocked'));
  assert.match(textOf(byAttr(tree, 'data-operation-block')), /uses the same model as Developer/);
  assert.equal(byAttr(tree, 'data-save').props.disabled, true);
  byAttr(tree, 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls, []);
  byAttr(tree, 'data-op-fix').props.onClick();
  tree = h.render();
  assert.equal(byAttr(tree, 'data-operation-block'), undefined);
  assert.equal(byAttr(tree, 'data-save').props.disabled, false);
  byAttr(tree, 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls[0][2].operations, { review: { model: 'gpt-6.2-astra' } });
});

test('review follows the live Reviewer seat and a single-family collision can fall back to it', t => {
  const rows = operationCatalog();
  const h = dialogHarness(t, seatsInfo({ operations: operationInfo(), catalog: rows }));
  byAttr(openMenu(h, 'reviewer'), 'data-assign', 'gpt-6.2-sol').props.onClick();
  let tree = showOperations(h);
  assert.ok(byAttr(byAttr(tree, 'data-operation', 'review'), 'data-op-blocked'));
  assert.equal(byAttr(tree, 'data-save').props.disabled, true);
  byAttr(tree, 'data-fix', 'opus').props.onClick();
  tree = h.render();
  assert.equal(byAttr(tree, 'data-op-blocked'), undefined);
  byAttr(operationMenu(h, 'review'), 'data-assign', 'gpt-6.2-sol').props.onClick();
  tree = h.render();
  assert.match(textOf(byAttr(tree, 'data-op-fix')), /Follow Reviewer seat/);
  byAttr(tree, 'data-op-fix').props.onClick();
  assert.equal(byAttr(h.render(), 'data-op-blocked'), undefined);
});

test('review operations keep distinct Codex IDs and allow a collision when no equally strong alternative is available', () => {
  const version = 'gpt-6.2-sol-20261119';
  const rows = [...operationCatalog(), row(version, version, 'codex', 3)];
  assert.equal(seatsLib.operationReviewerBlock({ model: version }, DEFAULTS, rows, undefined, reviewerRoles), null);
  const weaker = operationCatalog().filter(row => row.family === 'codex');
  assert.equal(seatsLib.operationReviewerBlock({ model: 'gpt-6.2-sol' }, DEFAULTS, weaker, undefined, reviewerRoles), null);
});

test('operation notes are localized by ID and the memory suggestion is a one-click draft on provider default', t => {
  const operations = operationInfo();
  operations.rows.find(row => row.id === 'background').note = 'explore-follows-background';
  const memory = operations.rows.find(row => row.id === 'memory');
  memory.note = 'codex-memories-enabled';
  memory.agents.codex = { state: 'default' };
  operations.rows.find(row => row.id === 'review').note = 'unrecognized provider note';
  for (const language of ['en', 'zh']) {
    const h = dialogHarness(t, seatsInfo({ operations, catalog: operationCatalog() }), { language });
    const tree = showOperations(h), memory = byAttr(tree, 'data-operation', 'memory');
    assert.match(textOf(byAttr(tree, 'data-operation', 'background')), language === 'en' ? /Explore agent also follows/ : /Explore 代理也使用此设置/);
    assert.match(textOf(memory), language === 'en' ? /when Codex memories are enabled/ : /开启 Codex 记忆功能时生效/);
    assert.match(textOf(byAttr(memory, 'data-op-state', 'default')), language === 'en' ? /Codex · default/ : /Codex · 默认/);
    assert.doesNotMatch(textOf(tree), /explore-follows-background|codex-memories-enabled|unrecognized provider note/);
    byAttr(memory, 'data-op-suggestion', 'gpt-6-mini').props.onClick();
    assert.equal(textOf(byAttr(h.render(), 'data-op-model', 'memory')), 'GPT-6 Mini');
  }
});

test('operation cards share the team model rows and add the family restriction only where needed', t => {
  const h = dialogHarness(t, seatsInfo({ operations: operationInfo(), catalog: operationCatalog() }));
  const teamMenu = openMenu(h, 'qa');
  const tree = showOperations(h);
  assert.equal(findAll(tree, node => node.props['data-operation']).length, 7);
  assert.equal(findAll(tree, node => node.props['data-op-slot']).length, 5);
  assert.equal(findAll(tree, node => node.props['data-seat']).length, 0);
  for (const id of ['compaction', 'titles']) {
    const readOnly = byAttr(tree, 'data-operation', id);
    assert.match(textOf(readOnly), /Built into Claude Code \/ Codex/);
    assert.equal(findAll(readOnly, node => node.type === 'button' || node.props.tabIndex !== undefined).length, 0);
  }
  const lookup = operationMenu(h, 'lookup');
  const describe = item => [item.props['data-assign'], item.props.disabled, !!byAttr(item, 'data-unlisted')];
  assert.deepEqual(menuRows(lookup).map(describe), menuRows(teamMenu).map(describe));
  assert.match(textOf(byAttr(lookup, 'data-assign', 'sonnet')), /Unavailable from this account.*Not in the latest list/);
  const background = operationMenu(h, 'background');
  assert.deepEqual(menuRows(background).map(item => item.props['data-assign']), menuRows(teamMenu).map(item => item.props['data-assign']));
  const codex = byAttr(background, 'data-assign', 'gpt-6-mini');
  assert.equal(codex.props.disabled, true);
  assert.match(textOf(codex), /only supports Claude/);
  const memory = operationMenu(h, 'memory');
  assert.match(textOf(byAttr(memory, 'data-assign', 'sonnet')), /Unavailable from this account.*only supports Codex.*Not in the latest list/);
  const reason = byAttr(byAttr(memory, 'data-assign', 'sonnet'), 'data-family-reason');
  assert.match(textOf(reason), /only supports Codex/);
  assert.match(memory.props.className, /is-operation/);
});

test('model menu bounds keep a margin at both window edges and the compact cards preserve the paired read-only rows', () => {
  const view = { width: 1280, height: 800 };
  const nearTop = menuPlacement({ left: 1250, top: 8, bottom: 40 }, view, 29);
  const nearBottom = menuPlacement({ left: 1250, top: 760, bottom: 792 }, view, 29);
  for (const menu of [nearTop, nearBottom]) {
    assert.ok(menu.left + menu.width <= view.width - 16);
    const offset = menu.top ?? menu.bottom;
    assert.ok(offset >= 16 && offset + menu.maxHeight <= view.height - 16);
  }
  assert.equal(nearTop.top, 44);
  assert.equal(nearBottom.bottom, 44);
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/seats-dialog.css'), 'utf8');
  assert.match(css, /\.seats-op-card \{[^}]*padding: 8px/);
  assert.match(css, /\.seats-menu\.is-operation \.seats-menu-details \{ grid-column: 2;[^}]*max-width: none/);
  assert.doesNotMatch(css, /max-width: 1150px[^]*?\.seats-op-card\.is-readonly \{ grid-column: 1 \/ -1; grid-template-areas/);
});

test('operation changes layer with seat changes, save both diffs, reset a scope, and preserve frozen values', async t => {
  const operations = operationInfo({
    global: { background: { model: 'opus' } },
    project: { memory: { model: 'gpt-6-mini' } },
    current: { values: { lookup: { model: 'haiku', effort: 'high' }, memory: 'follow' }, agents: {} },
  });
  const h = dialogHarness(t, seatsInfo({ operations, catalog: operationCatalog() }));
  assert.equal(byAttr(h.render(), 'data-scope', 'project').props['aria-pressed'], true, 'an operations-only project override chooses project scope');
  byAttr(openMenu(h, 'qa'), 'data-assign', 'haiku').props.onClick();
  showOperations(h);
  byAttr(operationMenu(h, 'lookup'), 'data-assign', 'opus').props.onClick();
  byAttr(operationMenu(h, 'lookup', 'data-op-effort'), 'data-pop-effort', 'max').props.onClick();
  let tree = h.render();
  assert.match(textOf(tree), /Unsaved draft · 2 changes/);
  find(tree, node => node.props.role === 'dialog').props.onKeyDown(keyEvent('Escape'));
  assert.match(textOf(find(h.render(), node => node.props.role === 'alertdialog')), /2 unsaved changes/);
  byAttr(h.render(), 'data-keep').props.onClick();
  tree = h.render();
  assert.match(textOf(byAttr(tree, 'data-op-model', 'memory')), /GPT-6 Mini/);
  byAttr(tree, 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls[0], ['project', 'p1', { roles: { qa: { model: 'haiku', effort: 'high' } }, operations: {
    memory: { model: 'gpt-6-mini' }, lookup: { model: 'opus', effort: 'max' },
  } }, 'at-open']);
  byAttr(h.render(), 'data-now').props.onClick();
  assert.match(textOf(byAttr(h.render(), 'data-now-operation', 'lookup')), /Haiku · high/);
  assert.match(textOf(byAttr(h.render(), 'data-now-operation', 'memory')), /Codex default/);
  assert.match(textOf(byAttr(h.render(), 'data-now-operation', 'memory')), /Takes effect on next launch: GPT-6 Mini/);
  assert.doesNotMatch(textOf(byAttr(h.render(), 'data-now-operation', 'lookup')), /next launch/);
  byAttr(h.render(), 'data-reset').props.onClick();
  byAttr(h.render(), 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls[1], ['project', 'p1', { roles: {}, operations: {} }, 'at-open']);
});

test('operation chips show the provider reason and model editing works through the suggestion, custom input and palette drag', t => {
  const h = dialogHarness(t, seatsInfo({ operations: operationInfo(), catalog: operationCatalog() }));
  const listeners = {};
  window.addEventListener = (type, callback) => { listeners[type] = callback; };
  window.removeEventListener = type => { delete listeners[type]; };
  document.elementFromPoint = () => ({ closest: () => ({ dataset: { opSlot: 'subagent' } }) });
  let tree = showOperations(h);
  const memory = byAttr(tree, 'data-operation', 'memory');
  assert.equal(byAttr(memory, 'data-op-state', 'not-applicable').type, 'span');
  assert.ok(byAttr(tree, 'data-op-state', 'applies'));
  const refused = byAttr(memory, 'data-op-state', 'not-effective');
  refused.props.onClick(pickButton('memory'));
  assert.match(textOf(h.render()), /provider refused memories/);
  byAttr(h.render(), 'data-op-state', 'not-effective').props.onClick(pickButton('memory'));
  assert.doesNotMatch(textOf(h.render()), /provider refused memories/);
  byAttr(h.render(), 'data-op-suggestion', 'gpt-6-mini').props.onClick();
  assert.equal(textOf(byAttr(h.render(), 'data-op-model', 'memory')), 'GPT-6 Mini');
  byAttr(operationMenu(h, 'memory'), 'data-custom').props.onClick();
  byAttr(h.render(), 'data-custom-input').props.onChange({ target: { value: 'claude-custom' } });
  byAttr(h.render(), 'data-custom-apply').props.onClick();
  assert.match(textOf(byAttr(h.render(), 'data-custom-error')), /only supports Codex/);
  byAttr(h.render(), 'data-custom-input').props.onChange({ target: { value: 'gpt-custom' } });
  byAttr(h.render(), 'data-custom-apply').props.onClick();
  assert.equal(textOf(byAttr(h.render(), 'data-op-model', 'memory')), 'gpt-custom');
  byAttr(h.render(), 'data-chip', 'gpt-6-mini').props.onPointerDown({ button: 0, clientX: 4, clientY: 4 });
  listeners.pointermove({ clientX: 40, clientY: 40 });
  listeners.pointerup({ clientX: 40, clientY: 40 });
  tree = h.render();
  assert.equal(textOf(byAttr(tree, 'data-op-model', 'subagent')), 'GPT-6 Mini');
  assert.ok(byAttr(tree, 'data-op-effort', 'subagent'));
  byAttr(operationMenu(h, 'subagent'), 'data-op-follow').props.onClick();
  assert.equal(byAttr(h.render(), 'data-op-effort', 'subagent'), undefined);
});

test('the dialog saves the chosen scope and the edited map; the keyboard 更换 menu assigns a model, effort and fast', async t => {
  const h = dialogHarness(t, seatsInfo({ project: null }));
  let tree = h.render();
  assert.ok(byAttr(tree, 'data-save').props.disabled, '保存 waits for a change');
  assert.equal(textOf(byAttr(tree, 'data-save')), 'Save routing');
  // 更换 on the architect seat opens a menu holding every model; picking one assigns it.
  byAttr(tree, 'data-pick', 'architect').props.onClick(pickButton('architect'));
  tree = h.render();
  const menu = find(tree, node => node.props.role === 'menu');
  assert.deepEqual(findAll(menu, node => node.props.role === 'menuitemradio').map(node => node.props['data-assign']), ['opus', 'sonnet', 'haiku', 'gpt-6.2-sol']);
  byAttr(menu, 'data-assign', 'gpt-6.2-sol').props.onClick();
  tree = h.render();
  assert.equal(find(tree, node => node.props.role === 'menu'), undefined, 'the menu closes after a pick');
  byAttr(tree, 'data-pick', 'architect').props.onClick(pickButton('architect'));
  tree = h.render();
  assert.equal(byAttr(tree, 'data-fast', 'architect').props['aria-checked'], true, 'a GPT seat offers fast, on from the start');
  byAttr(tree, 'data-fast', 'architect').props.onClick();
  tree = h.render();
  byAttr(tree, 'data-effort', 'architect').props.onChange({ target: { value: 'xhigh' } });
  tree = h.render();
  assert.match(textOf(tree), /Unsaved draft · 1 seats changed/);
  const save = byAttr(tree, 'data-save');
  assert.equal(save.props.disabled, false);
  save.props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['project', 'p1', { roles: { architect: { model: 'gpt-6.2-sol', effort: 'xhigh' } }, operations: {} }, 'at-open']], 'only the changed seat');
  tree = h.render();
  assert.match(textOf(find(tree, node => node.props.role === 'status')), /^Saved\. Takes effect immediately\.$/);
});

test('the scope select sends the project id, and 恢复默认 saves an empty map that clears the scope', async t => {
  const info = seatsInfo({ global: { researcher: { model: 'sonnet', effort: 'low' } } });
  const h = dialogHarness(t, info);
  let tree = h.render();
  assert.equal(byAttr(tree, 'data-reset').props.disabled, false, 'a saved choice can be reset');
  byAttr(tree, 'data-reset').props.onClick();
  tree = h.render();
  assert.equal(byAttr(tree, 'data-save').props.disabled, false, 'resetting is a change to save');
  byAttr(tree, 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['project', 'p1', { roles: {}, operations: {} }, 'at-open']], 'an empty map clears the global scope');
  const project = dialogHarness(t, seatsInfo());
  tree = project.render();
  byAttr(tree, 'data-scope', 'project').props.onClick();
  byAttr(project.render(), 'data-pick', 'researcher').props.onClick(pickButton('researcher'));
  byAttr(find(project.render(), node => node.props.role === 'menu'), 'data-assign', 'haiku').props.onClick();
  byAttr(project.render(), 'data-save').props.onClick();
  await settle();
  assert.deepEqual(project.calls, [['project', 'p1', { roles: { researcher: { model: 'haiku', effort: 'high' } }, operations: {} }, 'at-open']]);
});

test('a blocked reviewer is framed, named 已阻止, explained with a one-click fix and cannot be saved; main’s refusal is shown', async t => {
  const info = seatsInfo({ global: { reviewer: { model: 'gpt-6.2-sol', effort: 'high', fast: true } } });
  const h = dialogHarness(t, info);
  let tree = h.render();
  assert.ok(find(tree, node => node.props.className?.includes('seats-team-card is-blocked')), 'the reviewer tile has the red frame');
  assert.match(textOf(tree), /Blocked · same model/);
  const banner = find(tree, node => node.props.role === 'alert');
  assert.match(textOf(banner), /Review \(GPT-6\.2-Sol\) uses the same model as Developer, and Opus is also available/);
  assert.equal(byAttr(tree, 'data-save').props.disabled, true, '保存 is disabled');
  assert.match(textOf(tree), /A seat is blocked, so this cannot be saved/);
  const fix = byAttr(tree, 'data-fix');
  assert.equal(textOf(fix), 'Use Opus for review');
  fix.props.onClick();
  tree = h.render();
  assert.equal(find(tree, node => node.props.role === 'alert'), undefined, 'the fix clears the block');
  assert.equal(byAttr(tree, 'data-save').props.disabled, false);
  // Main can still refuse (another rule, or a stale catalog): its message is shown and nothing claims to be saved.
  const refused = dialogHarness(t, seatsInfo(), { reply: { ok: false, code: 'invalid-model', seat: 'researcher', message: 'Expected a valid model id.' } });
  tree = refused.render();
  byAttr(tree, 'data-pick', 'researcher').props.onClick(pickButton('researcher'));
  byAttr(find(refused.render(), node => node.props.role === 'menu'), 'data-assign', 'haiku').props.onClick();
  byAttr(refused.render(), 'data-save').props.onClick();
  await settle();
  assert.match(textOf(find(refused.render(), node => node.props.role === 'status')), /Not saved: Expected a valid model id\./);
});

test('unavailable models are greyed with their reason, cannot be picked, and this conversation’s seats are shown read-only', t => {
  const info = seatsInfo({ catalog: catalog({ 'gpt-6.2-sol': { available: false, reason: 'Codex is not installed.' } }),
    current: { ...clone(DEFAULTS), architect: { model: 'sonnet', effort: 'low' } } });
  const h = dialogHarness(t, info);
  let tree = h.render();
  const gems = findAll(tree, node => node.props.className?.includes('seats-chip') && node.props.className?.includes('is-off'));
  assert.ok(gems.length >= 1, 'the tray token is greyed');
  assert.match(gems[0].props.title, /Codex is not installed\./);
  byAttr(tree, 'data-now').props.onClick();
  tree = h.render();
  assert.match(textOf(tree), /This conversation \(read-only\)/);
  const current = byAttr(tree, 'aria-label', 'This conversation (read-only)');
  assert.match(textOf(byAttr(current, 'data-current-seat', 'architect')), /Architect\s*Opus · high/);
  assert.doesNotMatch(textOf(current), /Sonnet · low|after restart/i);
  byAttr(tree, 'data-pick', 'developer').props.onClick(pickButton('developer'));
  tree = h.render();
  const item = byAttr(find(tree, node => node.props.role === 'menu'), 'data-assign', 'gpt-6.2-sol');
  assert.equal(item.props.disabled, true);
  assert.match(textOf(item), /Codex is not installed\./);
  const orchestrator = byAttr(tree, 'data-seat', 'orchestrator');
  assert.ok(byAttr(orchestrator, 'data-pick', 'orchestrator'), 'the orchestrator has one model slot');
});

test('dragging a seat’s model onto another seat swaps them, and a tray model replaces the seat’s', t => {
  const h = dialogHarness(t, seatsInfo());
  const listeners = {};
  globalThis.window.addEventListener = (type, listener) => { listeners[type] = listener; };
  globalThis.window.removeEventListener = type => { delete listeners[type]; };
  let target = null;
  globalThis.document.elementFromPoint = () => target && { closest: () => ({ dataset: { slot: target } }) };
  let tree = h.render();
  const coreGem = find(byAttr(tree, 'data-slot', 'developer'), node => node.props.className?.startsWith('seats-gem'));
  coreGem.props.onPointerDown({ button: 0, clientX: 10, clientY: 10 });
  target = 'designer';
  listeners.pointermove({ clientX: 40, clientY: 40 });
  listeners.pointerup({ clientX: 40, clientY: 40 });
  tree = h.render();
  const modelOf = slot => textOf(find(byAttr(tree, 'data-slot', slot), node => node.props.className?.startsWith('seats-gem')));
  assert.equal(modelOf('developer'), 'Sonnet');
  assert.equal(modelOf('designer'), 'GPT-6.2-Sol');
  const haiku = byAttr(tree, 'data-chip', 'haiku');
  haiku.props.onPointerDown({ button: 0, clientX: 0, clientY: 0 });
  target = 'qa';
  listeners.pointermove({ clientX: 80, clientY: 80 });
  listeners.pointerup({ clientX: 80, clientY: 80 });
  tree = h.render();
  assert.equal(modelOf('qa'), 'Haiku');
  assert.match(textOf(find(tree, node => node.props.role === 'status')), /QA \/ Tester now uses Haiku/);
  // A click that never travels 5px is not a drag.
  haiku.props.onPointerDown({ button: 0, clientX: 0, clientY: 0 });
  target = 'architect';
  listeners.pointerup({ clientX: 2, clientY: 2 });
  assert.equal(modelOf('architect'), 'Opus', 'a press without travel changes nothing');
});

test('Escape closes the open menu first and then the dialog; the X closes it too', t => {
  const h = dialogHarness(t, seatsInfo());
  let tree = h.render();
  const dialog = find(tree, node => node.props.role === 'dialog');
  assert.equal(dialog.props['aria-modal'], 'true');
  byAttr(tree, 'data-pick', 'developer').props.onClick(pickButton('developer'));
  tree = h.render();
  find(tree, node => node.props.role === 'dialog').props.onKeyDown(keyEvent('Escape'));
  tree = h.render();
  assert.equal(find(tree, node => node.props.role === 'menu'), undefined);
  assert.deepEqual(h.closed, [], 'the first Escape only closes the menu');
  find(tree, node => node.props.role === 'dialog').props.onKeyDown(keyEvent('Escape'));
  assert.equal(h.closed.length, 1);
  byAttr(tree, 'aria-label', 'Close').props.onClick();
  assert.equal(h.closed.length, 2);
});

test('the chart places connector drops at the columns and collapses the palette in the two-column layout', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/seats-dialog.css'), 'utf8');
  const compact = css.slice(css.indexOf('@media (max-width: 1280px)'), css.indexOf('@media (max-width: 700px)'));
  assert.match(css, /\.seats-team-grid \{[^}]*grid-template-columns: repeat\(3,/);
  assert.match(compact, /\.seats-team-grid \{[^}]*grid-template-columns: repeat\(2,/);
  assert.match(compact, /\.seats-palette \{ display: none; \}/);
  assert.match(compact, /\.seats-palette\.is-open \{[^}]*display: flex/);
  assert.match(css, /\.seats-chart-bus::after \{[^}]*inset: 8px var\(--bus-inset\) 0/);
  assert.match(css, /\.seats-chart-link, \.seats-chart-bus \{[^}]*pointer-events: none/);
  assert.doesNotMatch(css, /@keyframes|animation:/);
});

test('the project and template retain independent unsaved drafts', async t => {
  const h = dialogHarness(t, seatsInfo({ project: { designer: { model: 'haiku', effort: 'low' } } }));
  assert.equal(byAttr(h.render(), 'data-scope', 'project').props['aria-pressed'], true);
  byAttr(openMenu(h, 'researcher'), 'data-assign', 'haiku').props.onClick();
  byAttr(h.render(), 'data-scope', 'template').props.onClick();
  assert.equal(byAttr(h.render(), 'data-save').props.disabled, true);
  byAttr(openMenu(h, 'researcher'), 'data-assign', 'opus').props.onClick();
  byAttr(h.render(), 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['template', null, { roles: { researcher: { model: 'opus', effort: 'high' } }, operations: {} }, null]]);
  byAttr(h.render(), 'data-scope', 'project').props.onClick();
  assert.match(textOf(byAttr(h.render(), 'data-pick', 'researcher')), /Haiku/);
});

test('closing with an unsaved draft asks once, inline, before discarding', t => {
  const h = dialogHarness(t, seatsInfo());
  let tree = h.render();
  byAttr(tree, 'data-pick', 'researcher').props.onClick(pickButton('researcher'));
  byAttr(find(h.render(), node => node.props.role === 'menu'), 'data-assign', 'haiku').props.onClick();
  byAttr(h.render(), 'aria-label', 'Close').props.onClick();
  assert.deepEqual(h.closed, [], 'the first close only asks');
  tree = h.render();
  assert.ok(find(tree, node => node.props.role === 'alertdialog'));
  byAttr(tree, 'data-keep').props.onClick();
  assert.equal(find(h.render(), node => node.props.role === 'alertdialog'), undefined);
  byAttr(h.render(), 'aria-label', 'Close').props.onClick();
  byAttr(h.render(), 'data-discard').props.onClick();
  assert.equal(h.closed.length, 1);
});

test('a file-watch refresh does not replace a draft’s compare-and-swap digest', async t => {
  const info = seatsInfo({ project: { developer: { model: 'haiku', effort: 'low' } } });
  const h = dialogHarness(t, info, { reply: { ok: false, code: 'file-changed', message: 'Changed' } });
  byAttr(openMenu(h, 'architect'), 'data-assign', 'sonnet').props.onClick();
  h.deliver({ ...info, routing: source({ digest: 'fresh' }) });
  await settle();
  byAttr(h.render(), 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['project', 'p1', { roles: {
    developer: { model: 'haiku', effort: 'low' }, architect: { model: 'sonnet', effort: 'high' },
  }, operations: {} }, 'at-open']]);
  assert.match(textOf(h.render()), /changed on disk/i);
});

for (const dismissal of ['Escape', 'Keep editing']) test(`${dismissal} preserves the draft and restores focus inside the dialog`, t => {
  const h = dialogHarness(t, seatsInfo());
  const panel = tree => byAttr(tree, 'role', 'dialog');
  const control = () => ({ focus() { document.activeElement = this; } });
  const previous = control(), first = control(), keep = control();
  const attached = new Set([previous, first, keep]);
  const panelNode = { contains: item => attached.has(item), querySelector: () => first };
  openMenu(h, 'researcher');
  byAttr(h.render(), 'data-assign', 'haiku').props.onClick();
  const before = h.render();
  panel(before).props.ref.current = panelNode;
  previous.focus();
  byAttr(before, 'aria-label', 'Close').props.onClick();
  // Attach the prompt button before the focus effect runs, as React does on commit.
  h.render(tree => { byAttr(tree, 'data-keep').props.ref.current = keep; });
  assert.equal(document.activeElement, keep);
  const prompt = h.render();
  if (dismissal === 'Escape') panel(prompt).props.onKeyDown(keyEvent('Escape'));
  else { attached.delete(previous); byAttr(prompt, 'data-keep').props.onClick(); }
  document.activeElement = null;
  const after = h.render();
  assert.equal(byAttr(after, 'role', 'alertdialog'), undefined);
  assert.equal(document.activeElement, dismissal === 'Escape' ? previous : first);
  assert.match(textOf(after), /Unsaved draft · 1 seats changed/);
  panel(after).props.onKeyDown(keyEvent('Escape'));
  assert.ok(byAttr(h.render(), 'role', 'alertdialog'), 'the next Escape still reaches the dialog');
  assert.deepEqual(h.closed, []);
});

// ---- catalog-driven dialog (round cat-r1): the menu follows each row, a typed-in id is accepted by the helper's syntax, the lists can be refreshed ----
const openMenu = (h, slot) => { byAttr(h.render(), 'data-pick', slot).props.onClick(pickButton(slot)); return find(h.render(), node => node.props.role === 'menu'); };
const optionValues = select => findAll(select, node => node.type === 'option').map(node => node.props.value);
const assignable = menu => findAll(menu, node => node.props.role === 'menuitemradio').map(node => node.props['data-assign']);
const liveMenu = h => find(h.render(), node => node.props.role === 'menu');
const typeCustom = (h, text) => byAttr(liveMenu(h), 'data-custom-input').props.onChange({ target: { value: text } });
const applyCustom = h => byAttr(liveMenu(h), 'data-custom-apply').props.onClick();

test('the dialog gives an unlisted model the shared fallback rank', () => {
  assert.equal(rowFor(catalog(), 'gpt-6.2-sol-mini').rank, 1, 'an id the catalog does not list ranks by the same rule');
});

test('effort and fast follow the model’s own row: listed efforts, fast only where the row says so, turning fast off always allowed', () => {
  const rows = catalog({ opus: { fast: true, efforts: ['low', 'high', 'ultra'] }, 'gpt-6.2-sol': { efforts: ['medium', 'high'] } });
  const map = clone(DEFAULTS);
  assert.equal(setEffort(map, 'architect', 'ultra', rows).map.architect.effort, 'ultra', 'a level only this row lists is accepted');
  assert.deepEqual(setEffort(map, 'architect', 'max', rows), { ok: false, reason: 'effort' }, 'a base level the row does not list is refused');
  assert.deepEqual(setEffort(map, 'developer', 'low', rows), { ok: false, reason: 'effort' });
  assert.equal(setFast(map, 'architect', true, rows).map.architect.fast, true, 'a Claude row that lists fast takes it');
  assert.deepEqual(setFast(map, 'designer', true, rows), { ok: false, reason: 'fast' });
  assert.equal(setFast({ ...map, designer: { model: 'sonnet', effort: 'high', fast: true } }, 'designer', false, rows).ok, true, 'a stale fast flag can still be turned off');
  assert.equal(firstRefusal({ ...map, architect: { model: 'opus', effort: 'ultra', fast: true } }, rows), null);
  assert.equal(firstRefusal({ ...map, architect: { model: 'opus', effort: 'max' } }, rows).code, 'invalid-effort');
  assert.equal(firstRefusal({ ...map, developer: { model: 'gpt-6.2-sol', effort: 'high', fast: true } }, catalog({ 'gpt-6.2-sol': { fast: false } })).code, 'fast-not-allowed', 'a GPT row without fast refuses it too');
  assert.equal(assignModel({ ...map, designer: { model: 'sonnet', effort: 'high', fast: true } }, 'designer', 'opus', rows).map.designer.fast, true, 'a Claude seat with fast keeps it into a fast-capable Claude row');
  assert.equal(assignModel(map, 'designer', 'opus', rows).map.designer.fast, false, 'fast does not start on for Claude');
  assert.deepEqual(assignModel({ ...map, designer: { model: 'sonnet', effort: 'max' } }, 'designer', 'opus', rows).map.designer, { model: 'opus', effort: 'high', fast: false }, 'an effort the row lacks falls to high');
});

test('a typed-in model id follows the helper’s syntax and the orchestrator can use either family', () => {
  const map = clone(DEFAULTS);
  assert.equal(assignCustom(map, 'orchestrator', 'gpt-new', catalog()).map.orchestrator.model, 'gpt-new');
  assert.equal(assignCustom(map, 'orchestrator', 'claude-new', catalog()).map.orchestrator.model, 'claude-new');
  assert.deepEqual(assignCustom(map, 'orchestrator', 'not valid!', catalog()), { ok: false, reason: 'invalid-id' });
});

test('the 更换 menu lists the row’s own efforts, switches fast only where the row has it, says why not, and notes Opus fast billing', t => {
  const rows = catalog({ 'gpt-6.2-sol': { efforts: ['low', 'high', 'ultra'] }, opus: { fast: true }, sonnet: { fastReason: 'unsupported' }, haiku: { fastReason: 'agent-tool' } });
  const h = dialogHarness(t, seatsInfo({ catalog: rows }));
  let menu = openMenu(h, 'developer');
  assert.deepEqual(optionValues(byAttr(menu, 'data-effort', 'developer')), ['low', 'high', 'ultra'], 'the effort menu is the row’s list');
  assert.equal(byAttr(menu, 'data-fast', 'developer').props.disabled, false);
  assert.equal(findAll(menu, node => node.props['data-fast-note'] !== undefined).length, 0, 'a GPT fast row has no billing note');
  menu = openMenu(h, 'architect');
  assert.equal(byAttr(menu, 'data-fast', 'architect').props.disabled, false, 'Opus lists fast');
  assert.match(textOf(byAttr(menu, 'data-fast-note')), /billed at a different price \(for example Opus fast\)/);
  byAttr(menu, 'data-fast', 'architect').props.onClick();
  assert.equal(byAttr(liveMenu(h), 'data-fast', 'architect').props['aria-checked'], true);
  menu = openMenu(h, 'designer');
  assert.equal(byAttr(menu, 'data-fast', 'designer').props.disabled, true, 'Sonnet has no fast');
  assert.match(textOf(byAttr(menu, 'data-fast-note')), /does not support fast mode/);
  const agentTool = dialogHarness(t, seatsInfo({ catalog: catalog({ sonnet: { fastReason: 'agent-tool' } }) }));
  assert.match(textOf(byAttr(openMenu(agentTool, 'researcher'), 'data-fast-note')), /through the Agent tool/);
  const unknown = dialogHarness(t, seatsInfo({ catalog: catalog({ sonnet: { fastReason: 'unknown' } }) }));
  assert.match(textOf(byAttr(openMenu(unknown, 'designer'), 'data-fast-note')), /not known yet/);
});

test('其他模型… takes an id in the menu: a good id is assigned and saved, a refused one stays in the box with its reason', async t => {
  const h = dialogHarness(t, seatsInfo());
  byAttr(openMenu(h, 'developer'), 'data-custom').props.onClick();
  typeCustom(h, '-x'); applyCustom(h);
  assert.match(textOf(byAttr(liveMenu(h), 'data-custom-error')), /starts with a letter or digit/);
  assert.equal(h.calls.length, 0);
  typeCustom(h, 'gpt-6.3-sol'); applyCustom(h);
  assert.equal(liveMenu(h), undefined, 'the menu closes after an accepted id');
  const tree = h.render();
  assert.match(textOf(find(tree, node => node.props.role === 'status')), /gpt-6\.3-sol/);
  byAttr(tree, 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['project', 'p1', { roles: { developer: { model: 'gpt-6.3-sol', effort: 'high', fast: true } }, operations: {} }, 'at-open']]);
  // A custom model of the other family can be used by the orchestrator.
  const lead = dialogHarness(t, seatsInfo());
  byAttr(openMenu(lead, 'orchestrator'), 'data-custom').props.onClick();
  typeCustom(lead, 'claude-opus-9'); applyCustom(lead);
  assert.match(textOf(byAttr(lead.render(), 'data-seat', 'orchestrator')), /claude-opus-9/);
});

test('the refresh button asks main for the seats, shows the new catalog and when each list was read, and says when it fails', async t => {
  const now = Date.now(), at = { claude: now - 3 * 3600000 - 1000, codex: null };
  const refreshed = seatsInfo({ catalog: [...catalog(), row('gpt-6.2-sol', 'GPT-6.2-Sol', 'codex', 3)], catalogAt: { claude: now, codex: now - 120000 } });
  const h = dialogHarness(t, seatsInfo({ catalogAt: at }), { refreshed });
  let tree = h.render();
  assert.match(textOf(byAttr(tree, 'data-catalog-at')), /Claude 3 h ago · Codex not refreshed$/);
  byAttr(tree, 'data-refresh').props.onClick();
  await settle();
  assert.deepEqual(h.refreshes, [['p1', 't1', 'dialog'], ['p1', 't1', 'manual']], 'once when the dialog opens (throttled in main), once for the button (always)');
  tree = h.render();
  assert.match(textOf(byAttr(tree, 'data-catalog-at')), /Claude just now · Codex 2 min ago$/);
  assert.match(textOf(find(tree, node => node.props.role === 'status')), /Model lists refreshed/);
  assert.ok(assignable(openMenu(h, 'architect')).includes('gpt-6.2-sol'), 'the new model is offered');
  const failing = dialogHarness(t, seatsInfo(), { refreshError: 'probe timed out' });
  byAttr(failing.render(), 'data-refresh').props.onClick();
  await settle();
  const after = failing.render();
  assert.match(textOf(find(after, node => node.props.role === 'status')), /Not refreshed: probe timed out/);
  assert.equal(byAttr(after, 'data-refresh').props.disabled, false, 'the button is usable again');
  const none = dialogHarness(t, seatsInfo());
  byAttr(none.render(), 'data-refresh').props.onClick();
  await settle();
  assert.match(textOf(find(none.render(), node => node.props.role === 'status')), /Not refreshed: no seats information/);
  assert.deepEqual([ageOf(null, now), ageOf(now - 30000, now), ageOf(now - 90 * 60000, now), ageOf(now - 3 * 86400000, now)].map(age => `${age.unit}:${age.count}`), ['never:0', 'now:0', 'hour:1', 'day:3']);
});

test('issues show on their seat until it is edited, a moved default is said, and a row that left the list is marked', t => {
  const rows = catalog({ sonnet: { listed: false } });
  const issues = [{ slot: 'designer', code: 'effort-unsupported', substitute: 'high' }, { slot: 'developer', code: 'fast-unsupported', substitute: 'fast off' }, { slot: 'orchestrator', code: 'model-unlisted', substitute: 'opus' }];
  const h = dialogHarness(t, seatsInfo({ catalog: rows, issues, defaultsMoved: [{ seat: 'developer', from: 'gpt-6.2-sol', to: 'gpt-6.3-sol' }] }));
  let tree = h.render();
  const marks = findAll(tree, node => node.props.className?.startsWith('seats-state'));
  assert.deepEqual(marks.map(node => node.props.title), [
    'Adjusted: this model is not in the current list; it runs as opus', 'Adjusted: this model does not support the saved effort; it runs high', 'Adjusted: this model does not support fast mode; it runs fast off']);
  assert.equal(issuesOf(seatsInfo({ issues }), 'developer').length, 1);
  assert.match(textOf(byAttr(tree, 'data-moved')), /Defaults moved to Developer：GPT-6\.2-Sol → gpt-6\.3-sol/);
  assert.ok(findAll(tree, node => node.props['data-unlisted'] !== undefined).length >= 1, 'Sonnet is marked as no longer listed');
  assert.match(textOf(byAttr(openMenu(h, 'designer'), 'data-assign', 'sonnet')), /Not in the latest list/);
  // Editing the seat makes its saved issue stale: the mark goes.
  byAttr(liveMenu(h), 'data-effort', 'designer').props.onChange({ target: { value: 'low' } });
  assert.equal(findAll(h.render(), node => node.props.className?.startsWith('seats-state')).length, 2);
  // A record without the new fields still renders (an older main).
  assert.match(textOf(byAttr(dialogHarness(t, seatsInfo()).render(), 'data-catalog-at')), /Claude not refreshed · Codex not refreshed/);
});

test('the dialog reads once when it opens, keeps the opened info until the answer, and shows a moved default from any answer', async t => {
  const moved = [{ seat: 'developer', from: 'gpt-6.2-sol', to: 'gpt-6.3-sol' }];
  const h = dialogHarness(t, seatsInfo(), { refreshed: seatsInfo({ defaultsMoved: moved }) });
  let tree = h.render();
  assert.deepEqual(h.refreshes, [['p1', 't1', 'dialog']], 'one read on open');
  assert.equal(byAttr(tree, 'data-moved'), undefined, 'the note waits for the answer');
  assert.equal(findAll(tree, node => node.props.role === 'status' && textOf(node)).length, 0, 'an opening read says nothing while it works');
  await settle();
  assert.match(textOf(byAttr(h.render(), 'data-moved')), /Defaults moved to Developer：GPT-6\.2-Sol → gpt-6\.3-sol/);
  const quiet = dialogHarness(t, seatsInfo(), { refreshError: 'offline' });
  quiet.render(); await settle();
  assert.match(textOf(find(quiet.render(), node => node.props.role === 'status')), /Not refreshed: offline/, 'a failed opening read keeps the info and says so');
  assert.ok(byAttr(quiet.render(), 'data-save'), 'the dialog still shows the info it opened with');
});

test('a 刷新 click during the opening read runs right after it, and an answer after the dialog closed is dropped', async t => {
  const h = dialogHarness(t, seatsInfo(), { refreshed: seatsInfo({ defaultsMoved: [{ seat: 'developer', from: 'gpt-6.2-sol', to: 'gpt-6.3-sol' }] }) });
  const first = h.render();
  assert.equal(byAttr(first, 'data-refresh').props.disabled, false, 'the button is usable during the opening read');
  byAttr(first, 'data-refresh').props.onClick();
  await settle();
  assert.deepEqual(h.refreshes.map(args => args[2]), ['dialog', 'manual'], 'the click waited for the opening read, then ran');
  const closing = dialogHarness(t, seatsInfo(), { refreshed: seatsInfo({ defaultsMoved: [{ seat: 'developer', from: 'a', to: 'b' }] }) });
  closing.render();
  closing.unmount();
  await settle();
  assert.equal(byAttr(closing.render(), 'data-moved'), undefined, 'no state is set after the dialog closed');
});

// ---- UI acceptance fixes (round cat-r1): alias = resolved id, short banner, menu and stage inside the viewport, family colours, agents not installed ----
const withAliases = (extra = {}) => catalog(extra).concat([row('claude-opus-5-5', 'Opus', 'claude', 3), row('claude-opus-5-4', 'Opus 5.4', 'claude', 3), row('claude-sonnet-5-5', 'Sonnet', 'claude', 2)]);

test('an alias and the id it resolves to are one model for the reviewer rule, and count once among the alternatives', () => {
  const rows = withAliases();
  assert.equal(canonicalModel(rows, 'opus'), 'claude-opus-5-5', 'the alias follows the newest listed id of its tier (5.5 over 5.4)');
  assert.equal(canonicalModel(rows, 'claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(canonicalModel(rows, 'claude-opus-5-5-20260101'), 'claude-opus-5-5');
  assert.equal(canonicalModel(catalog(), 'opus'), 'opus', 'an alias with no listed id stays itself');
  assert.ok(sameModel(rows, 'opus', 'claude-opus-5-5') && !sameModel(rows, 'opus', 'claude-opus-5-4') && !sameModel(rows, 'opus', 'sonnet'));
  const map = { ...clone(DEFAULTS), developer: { model: 'claude-opus-5-5', effort: 'high' } };
  const block = reviewerBlock(map, rows);
  assert.deepEqual(block.hit, ['developer'], 'the reviewer "opus" runs the developer seat’s model "claude-opus-5-5"');
  const names = block.alternatives.map(entry => entry.model);
  assert.ok(!names.includes('opus') && !names.includes('claude-opus-5-5'), 'neither spelling of the reviewer’s model is offered as an alternative');
  assert.ok(names.includes('claude-opus-5-4'), 'an older version is another model');
  assert.equal(new Set(names.map(name => canonicalModel(rows, name))).size, names.length, 'an alias and its id are listed once');
  assert.equal(reviewerBlock({ ...clone(DEFAULTS), developer: { model: 'claude-opus-5-4', effort: 'high' } }, rows), null, 'a different version does not block');
  assert.equal(reviewerSameButAllowed({ ...map }, catalog({ 'gpt-6.2-sol': { available: false }, sonnet: { available: false }, haiku: { available: false } }).concat([row('claude-opus-5-5', 'Opus', 'claude', 3)])), true, 'the warning form follows the same rule');
});

function reviewerSameButAllowed(map, rows) { return seatsLib.reviewerSameButAllowed(map, rows, 'reviewer', reviewerRoles.authors); }

test('the blocked banner names the three strongest alternatives and counts the rest; the icon sits inline with the message', t => {
  const many = catalog().concat(Array.from({ length: 10 }, (_, index) => row(`gpt-6.${index}-luna`, `GPT-6.${index}-Luna`, 'codex', index < 4 ? 3 : 2)));
  const alternatives = many.filter(entry => entry.model !== 'opus');
  const { shown, total } = topAlternatives(alternatives);
  assert.equal(shown.length, 3);
  assert.equal(total, alternatives.length);
  assert.ok(shown.every((entry, at) => !at || shown[at - 1].rank >= entry.rank), 'the strongest first');
  assert.equal(new Set(shown.map(entry => lineOf(entry))).size, shown.length, 'one per model line');
  const info = seatsInfo({ catalog: many, defaults: { ...clone(DEFAULTS), developer: { model: 'opus', effort: 'high' } } });
  const h = dialogHarness(t, info);
  const banner = find(h.render(), node => node.props.className === 'seats-banner is-bad' && node.props.role === 'alert');
  const text = textOf(banner);
  assert.match(text, /and others \(\d+ in all\)/);
  assert.ok((text.match(/GPT-|Sonnet|Haiku/g) ?? []).length <= 4, 'not a list of every model');
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/seats-dialog.css'), 'utf8');
  assert.doesNotMatch(css.match(/\.seats-banner \{[^}]*\}/)[0], /flex-wrap/, 'the icon and the message share one row: the banner does not wrap its items');
});

test('the moved-defaults note is a neutral banner and the discard question a warning one; only blocks are red', t => {
  const h = dialogHarness(t, seatsInfo({ defaultsMoved: [{ seat: 'developer', from: 'gpt-6.2-sol', to: 'gpt-6.3-sol' }] }));
  const tree = h.render();
  assert.equal(byAttr(tree, 'data-moved').props.className, 'seats-banner', 'no is-bad on the note');
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/seats-dialog.css'), 'utf8');
  assert.match(css, /\.seats-banner \{[^}]*border: 1px solid var\(--border\)/, 'the base banner border is neutral');
  assert.match(css, /\.seats-banner\.is-bad \{ border-color: var\(--danger\)/);
  const mk = css.split('\n').filter(line => line.startsWith('.seats-mk'));
  assert.ok(mk.some(line => line.includes('--agent-claude')) && mk.some(line => line.includes('data-family="codex"') && line.includes('--agent-codex')), 'the family dots use the existing agent tokens');
});

test('a default-move receipt survives a newer read and the first edit without collapsing the notice slot', async t => {
  const info = seatsInfo({ operations: operationInfo(), catalog: operationCatalog() });
  const h = dialogHarness(t, info);
  let publish, finishOpening;
  window.agentrix.onSkills = listener => { publish = listener; return () => {}; };
  window.agentrix.skillSeats = async () => info;
  window.agentrix.skillSeatsRefresh = () => new Promise(resolve => { finishOpening = resolve; });
  showOperations(h);
  publish();
  await settle();
  finishOpening({ ...info, defaultsMoved: [{ seat: 'developer', from: 'gpt-6.2-sol', to: 'gpt-6.3-sol' }] });
  await settle();
  assert.ok(byAttr(h.render(), 'data-moved'));
  byAttr(operationMenu(h, 'lookup'), 'data-assign', 'opus').props.onClick();
  assert.match(textOf(byAttr(h.render(), 'data-moved')), /Defaults moved to Developer/);
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/seats-dialog.css'), 'utf8');
  assert.match(css, /\.seats-strip:has\(\[data-moved\]\) \.seats-notice:empty \{ display: flex; \}/);
});

// ---- second acceptance round: no tile overlaps another, small-tile chips shorten and ellipsize, the one-click fix is chosen by rule ----

test('the card, banner and palette use the same short alias label and the menu keeps the full name', t => {
  assert.equal(shortLabel('Opus (follows latest)'), 'Opus (latest)');
  assert.equal(shortLabel('GPT-6.2-Sol'), 'GPT-6.2-Sol');
  const rows = catalog({ opus: { label: 'Opus (follows latest)' } });
  const h = dialogHarness(t, seatsInfo({ catalog: rows, defaultsMoved: [{ seat: 'architect', from: 'sonnet', to: 'opus' }] }));
  const tree = h.render();
  const slot = byAttr(tree, 'data-slot', 'architect');
  const gem = find(slot, node => node.props.className?.startsWith('seats-gem'));
  assert.equal(textOf(find(gem, node => node.props.className === 'seats-gem-name')), 'Opus (latest)');
  assert.equal(gem.props.title, 'Opus (latest)');
  assert.equal(textOf(byAttr(tree, 'data-chip', 'opus')), 'Opus (latest)');
  assert.match(byAttr(tree, 'data-chip', 'opus').props.title, /Opus \(latest\)/);
  assert.match(textOf(byAttr(tree, 'data-moved')), /Opus \(latest\)/);
  assert.match(textOf(openMenu(h, 'architect')), /Opus \(follows latest\)/, 'the menu keeps the full name');
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/seats-dialog.css'), 'utf8');
  assert.match(css, /\.seats-gem-name \{[^}]*text-overflow: ellipsis/);
});

test('the one-click fix is the reviewer’s default if it is a candidate, else the strongest model another seat runs, else the strongest; never list order', () => {
  const rows = [row('fable', 'Fable', 'claude', 3), row('opus', 'Opus', 'claude', 3), row('sonnet', 'Sonnet', 'claude', 2), row('gpt-6.2-sol', 'GPT-6.2-Sol', 'codex', 3), row('gpt-6.2-sol', 'GPT-6.2-Sol', 'codex', 3)];
  const map = { ...clone(DEFAULTS), developer: { model: 'opus', effort: 'high' } };
  assert.equal(reviewerBlock(map, rows, DEFAULTS).fix.model, 'gpt-6.2-sol', 'the reviewer’s default is not "opus" here (it is blocked), so the default rule picks nothing and the running one wins');
  const reviewerDefault = { ...clone(DEFAULTS), reviewer: { model: 'gpt-6.2-sol', effort: 'high' } };
  assert.equal(reviewerBlock(map, rows, reviewerDefault).fix.model, 'gpt-6.2-sol', 'the reviewer seat’s default, when it is a valid alternative, comes first');
  const none = { ...clone(DEFAULTS), architect: { model: 'sonnet', effort: 'high' }, orchestrator: { model: 'sonnet', effort: 'high' }, devops: { model: 'sonnet', effort: 'high' }, product: { model: 'sonnet', effort: 'high' }, security: { model: 'sonnet', effort: 'high' }, qa: { model: 'sonnet', effort: 'high' }, researcher: { model: 'sonnet', effort: 'high' }, designer: { model: 'sonnet', effort: 'high' } };
  const strongest = reviewerBlock({ ...none, developer: { model: 'opus', effort: 'high' }, reviewer: { model: 'opus', effort: 'high' } }, rows, undefined);
  assert.equal(strongest.fix.model, 'gpt-6.2-sol', 'no other seat runs a candidate: the strongest, newest id (not Fable, which is only first in the list)');
  assert.equal(reviewerBlock({ ...none, developer: { model: 'opus', effort: 'high' }, reviewer: { model: 'opus', effort: 'high' } }, [...rows].reverse(), undefined).fix.model, 'gpt-6.2-sol', 'the same pick in any list order');
});

// ---- layout A (round cat-r2): effort on the tile, menus that close, the grouped 模型盘 ----
// The owner's real catalog (28 models): three "follows latest" aliases, the bare-named rows, and the versioned ids of Claude and Codex.
const REAL = [
  row('opus', 'Opus (follows latest)', 'claude', 3, { source: 'alias', fast: true }), row('sonnet', 'Sonnet (follows latest)', 'claude', 2, { source: 'alias' }), row('haiku', 'Haiku (follows latest)', 'claude', 1, { source: 'alias' }),
  row('claude-opus-5[1m]', 'Opus', 'claude', 3), row('claude-fable-5-1[1m]', 'Fable', 'claude', 3), row('claude-sonnet-5[1m]', 'Sonnet', 'claude', 2), row('claude-haiku-4-5[1m]', 'Haiku', 'claude', 1),
  row('claude-fable-5-1', 'claude-fable-5-1', 'claude', 3), row('claude-opus-5', 'claude-opus-5', 'claude', 3), row('claude-sonnet-5', 'claude-sonnet-5', 'claude', 2), row('claude-fable-5', 'claude-fable-5', 'claude', 3),
  row('claude-opus-4-8', 'claude-opus-4-8', 'claude', 3), row('claude-opus-4-7', 'claude-opus-4-7', 'claude', 3), row('claude-sonnet-4-6', 'claude-sonnet-4-6', 'claude', 2), row('claude-opus-4-6', 'claude-opus-4-6', 'claude', 3),
  row('claude-opus-4-5-20251101', 'claude-opus-4-5-20251101', 'claude', 3), row('claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001', 'claude', 1),
  ...[['gpt-6.2-sol', 'GPT-6.2-Sol'], ['gpt-6.2-astra', 'GPT-6.2-Astra'], ['gpt-6.1-terra', 'GPT-6.1 Terra'], ['gpt-6.1-sol', 'GPT-6.1-Sol'], ['gpt-6-astra', 'GPT-6-Astra'], ['gpt-6-sol', 'GPT-6-Sol'],
    ['gpt-6-luna', 'GPT-6-Luna'], ['gpt-5.6-sol', 'GPT-5.6-Sol'], ['gpt-5.6-terra', 'GPT-5.6-Terra'], ['gpt-5.6-luna', 'GPT-5.6-Luna'], ['gpt-5.5', 'GPT-5.5']].map(([id, label]) => row(id, label, 'codex', 3)),
];
const lineNamed = (groups, family, name) => groups.find(group => group.family === family).lines.find(line => line.name === name);
const ids = rows => rows.map(entry => entry.model);

test('the 模型盘 groups the real 28-model catalog by family and line, aliases and the newest version first, older versions folded; a new line appears by itself', () => {
  const groups = paletteGroups(REAL);
  assert.deepEqual(groups.map(group => [group.family, group.total]), [['claude', 17], ['codex', 11]]);
  assert.deepEqual(groups[0].lines.map(line => line.name), ['Opus', 'Sonnet', 'Haiku', 'Fable'], 'Claude lines in catalog order');
  assert.deepEqual(groups[1].lines.map(line => line.name), ['Sol', 'Astra', 'Terra', 'Luna', ''], 'Codex lines, the unnamed one last');
  const opus = lineNamed(groups, 'claude', 'Opus');
  assert.deepEqual(ids(opus.shown), ['opus', 'claude-opus-5[1m]', 'claude-opus-5'], 'the alias first, then the newest version');
  assert.deepEqual(ids(opus.older), ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5-20251101'], 'older versions newest first, a date suffix is not a version');
  assert.deepEqual(ids(lineNamed(groups, 'claude', 'Fable').older), ['claude-fable-5'], 'Fable 5.1 is newer than 5');
  assert.equal(lineNamed(groups, 'claude', 'Haiku').older.length, 0, 'a line with nothing older has no fold');
  const sol = lineNamed(groups, 'codex', 'Sol');
  assert.deepEqual(ids(sol.shown), ['gpt-6.2-sol']);
  assert.deepEqual(ids(sol.older), ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol']);
  assert.deepEqual(ids(lineNamed(groups, 'codex', '').shown), ['gpt-5.5']);
  const total = groups.flatMap(group => group.lines).reduce((n, line) => n + line.shown.length + line.older.length, 0);
  assert.equal(total, REAL.length, 'every model is in exactly one place');
  const withNew = paletteGroups([...REAL, row('gpt-7-nova', 'GPT-7-Nova', 'codex', 3), row('gpt-6.9-nova', 'GPT-6.9-Nova', 'codex', 3), row('claude-quill-1', 'claude-quill-1', 'claude', 3)]);
  assert.deepEqual(ids(lineNamed(withNew, 'codex', 'Nova').shown), ['gpt-7-nova'], 'a new line is a new group, its newest first');
  assert.deepEqual(ids(lineNamed(withNew, 'codex', 'Nova').older), ['gpt-6.9-nova']);
  assert.deepEqual(ids(lineNamed(withNew, 'claude', 'Quill').shown), ['claude-quill-1']);
  assert.deepEqual(['Opus', 'Sol', ''].map((name, at) => lineOf(REAL.find(entry => entry.model === ['claude-opus-4-7', 'gpt-6-sol', 'gpt-5.5'][at]))), ['Opus', 'Sol', '']);
});

test('the search in the 模型盘 keeps only matching models, in their lines, and says when nothing matches', t => {
  const groups = paletteGroups(REAL, 'opus');
  assert.deepEqual(groups.map(group => group.family), ['claude'], 'a family with no match disappears');
  assert.deepEqual(groups[0].lines.map(line => line.name), ['Opus']);
  assert.equal(groups[0].lines[0].shown.length + groups[0].lines[0].older.length, 7, 'every Opus row matches, old ones too');
  assert.deepEqual(ids(lineNamed(paletteGroups(REAL, 'SOL'), 'codex', 'Sol').older), ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol'], 'case does not matter');
  assert.deepEqual(paletteGroups(REAL, 'zzz'), []);
  const h = dialogHarness(t, seatsInfo({ catalog: REAL }));
  let tree = h.render();
  const chips = () => findAll(h.render(), node => node.props['data-chip'] !== undefined).map(node => node.props['data-chip']);
  assert.equal(chips().length, 16, 'the 12 older versions are folded away');
  byAttr(tree, 'data-palette-search').props.onChange({ target: { value: 'sol' } });
  assert.deepEqual(chips(), ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol'], 'a search opens the folds of the lines it matches in');
  byAttr(h.render(), 'data-palette-search').props.onChange({ target: { value: 'zzz' } });
  assert.match(textOf(h.render()), /No matching models/);
});

test('the palette shows the newest of each line, folds the rest under 更早版本 (N), and a fold opens and closes', t => {
  const h = dialogHarness(t, seatsInfo({ catalog: REAL }));
  let tree = h.render();
  const shown = () => findAll(h.render(), node => node.props['data-chip'] !== undefined).map(node => node.props['data-chip']);
  assert.ok(shown().includes('claude-opus-5') && !shown().includes('claude-opus-4-8'));
  const fold = byAttr(tree, 'data-fold', 'claudeOpus');
  assert.equal(textOf(fold), 'Earlier versions (4)');
  assert.equal(fold.props['aria-expanded'], false);
  fold.props.onClick();
  assert.ok(shown().includes('claude-opus-4-8') && shown().includes('claude-opus-4-5-20251101'), 'the fold shows the four older versions');
  assert.equal(byAttr(h.render(), 'data-fold', 'claudeOpus').props['aria-expanded'], true);
  byAttr(h.render(), 'data-fold', 'claudeOpus').props.onClick();
  assert.ok(!shown().includes('claude-opus-4-8'), 'and closes again');
  assert.equal(byAttr(h.render(), 'data-fold', 'claudeHaiku'), undefined, 'a line with nothing older has no fold');
  const groups = findAll(h.render(), node => node.props['data-group'] !== undefined).map(node => node.props['data-group']);
  assert.deepEqual(groups, ['claude', 'codex']);
});

test('dragging a model from the 模型盘 onto a seat assigns it, and a model the agent cannot run is greyed there', t => {
  const h = dialogHarness(t, seatsInfo({ catalog: REAL, installed: { claude: true, codex: false } }));
  const listeners = {};
  globalThis.window.addEventListener = (type, listener) => { listeners[type] = listener; };
  globalThis.window.removeEventListener = type => { delete listeners[type]; };
  let target = null;
  globalThis.document.elementFromPoint = () => target && { closest: () => ({ dataset: { slot: target } }) };
  let tree = h.render();
  const sonnet = byAttr(tree, 'data-chip', 'claude-sonnet-5');
  sonnet.props.onPointerDown({ button: 0, clientX: 0, clientY: 0 });
  target = 'researcher';
  listeners.pointermove({ clientX: 60, clientY: 60 });
  listeners.pointerup({ clientX: 60, clientY: 60 });
  tree = h.render();
  assert.equal(textOf(find(byAttr(tree, 'data-slot', 'researcher'), node => node.props.className?.startsWith('seats-gem-name'))), 'claude-sonnet-5');
  const off = byAttr(tree, 'data-chip', 'gpt-6.2-sol');
  assert.match(off.props.className, /is-off/);
  assert.match(off.props.title, /Codex is not installed/);
  off.props.onPointerDown({ button: 0, clientX: 0, clientY: 0 });
  assert.equal(Object.keys(listeners).length, 0, 'a greyed chip cannot be dragged');
});

test('the effort button on every tile opens a popover with the model’s own levels and the fast switch, and a pick changes the seat', async t => {
  const rows = catalog({ opus: { fast: true, efforts: ['low', 'high', 'ultra'] }, 'gpt-6.2-sol': { efforts: ['low', 'high'] }, sonnet: { fastReason: 'unsupported' } });
  const h = dialogHarness(t, seatsInfo({ catalog: rows }));
  let tree = h.render();
  const slotsWithButtons = findAll(tree, node => node.props['data-tile-effort'] !== undefined).map(node => node.props['data-tile-effort']);
  assert.deepEqual(slotsWithButtons, SEATS, 'every team card, including the orchestrator');
  assert.equal(textOf(byAttr(tree, 'data-tile-effort', 'architect')), 'high');
  byAttr(tree, 'data-tile-effort', 'architect').props.onClick(pickButton('architect'));
  const pop = liveMenu(h);
  assert.match(pop.props.className, /is-effort/);
  assert.deepEqual(findAll(pop, node => node.props['data-pop-effort'] !== undefined).map(node => node.props['data-pop-effort']), ['low', 'high', 'ultra'], 'the model’s own levels');
  assert.equal(byAttr(pop, 'data-pop-fast', 'architect').props.disabled, false, 'Opus lists fast');
  assert.match(textOf(byAttr(pop, 'data-fast-note')), /billed at a different price \(for example Opus fast\)/);
  byAttr(pop, 'data-pop-effort', 'ultra').props.onClick();
  assert.equal(liveMenu(h), undefined, 'a pick closes the popover');
  tree = h.render();
  assert.equal(textOf(byAttr(tree, 'data-tile-effort', 'architect')), 'ultra');
  assert.match(textOf(tree), /Unsaved draft · 1 seats changed/);
  byAttr(tree, 'data-tile-effort', 'developer').props.onClick(pickButton('developer'));
  assert.deepEqual(findAll(liveMenu(h), node => node.props['data-pop-effort'] !== undefined).map(node => node.props['data-pop-effort']), ['low', 'high']);
  byAttr(liveMenu(h), 'data-pop-fast', 'developer').props.onClick();
  assert.equal(byAttr(liveMenu(h), 'data-pop-fast', 'developer').props['aria-checked'], false, 'fast turned off in the popover');
  byAttr(h.render(), 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['project', 'p1', { roles: {
    architect: { model: 'opus', effort: 'ultra' }, developer: { model: 'gpt-6.2-sol', effort: 'high' },
  }, operations: {} }, 'at-open']], 'the tile controls are saved like the menu’s');
  // The fast switch on the tile is the same switch: on where the row lists fast, disabled with its reason where not.
  const tile = h.render();
  assert.equal(byAttr(tile, 'data-tile-fast', 'designer').props.disabled, true);
  assert.match(byAttr(tile, 'data-tile-fast', 'designer').props.title, /does not support fast mode/);
  byAttr(tile, 'data-tile-fast', 'developer').props.onClick();
  assert.equal(byAttr(h.render(), 'data-tile-fast', 'developer').props['aria-checked'], true);
});

test('the 更换 menu and the effort popover close on an outside click, on a second click of their button, on ✕ and on Escape', t => {
  const h = dialogHarness(t, seatsInfo());
  const closes = [];
  for (const [kind, attr, open] of [['model', 'data-pick', 'developer'], ['effort', 'data-tile-effort', 'developer']]) {
    byAttr(h.render(), attr, open).props.onClick(pickButton(open));
    assert.ok(liveMenu(h), `${kind} menu opens`);
    h.outsideMouseDown({ outside: true });
    closes.push(`${kind} outside: ${!liveMenu(h)}`);
    byAttr(h.render(), attr, open).props.onClick(pickButton(open));
    byAttr(h.render(), attr, open).props.onClick(pickButton(open));
    closes.push(`${kind} second click: ${!liveMenu(h)}`);
    byAttr(h.render(), attr, open).props.onClick(pickButton(open));
    byAttr(liveMenu(h), 'data-menu-close').props.onClick();
    closes.push(`${kind} ✕: ${!liveMenu(h)}`);
    byAttr(h.render(), attr, open).props.onClick(pickButton(open));
    byAttr(h.render(), 'role', 'dialog').props.onKeyDown({ key: 'Escape', stopPropagation() {}, preventDefault() {} });
    closes.push(`${kind} Escape: ${!liveMenu(h)}`);
    assert.equal(h.closed.length, 0, 'none of these closes the dialog itself');
  }
  assert.deepEqual(closes.filter(line => !line.endsWith('true')), [], closes.join('; '));
  // Another button moves the menu instead of closing it.
  byAttr(h.render(), 'data-pick', 'developer').props.onClick(pickButton('developer'));
  byAttr(h.render(), 'data-tile-effort', 'architect').props.onClick(pickButton('architect'));
  assert.match(liveMenu(h).props.className, /is-effort/);
});

// ---- second acceptance of layout A: controls must be clickable, nothing that holds a control moves, tile text is 14px, the banner names what the fix prefers ----
test('the blocked banner names what the one-click fix prefers, one per model line, the fix first, at most three', t => {
  const rows = REAL.slice();
  const map = { ...clone(DEFAULTS), developer: { model: 'opus', effort: 'high' } };
  const block = reviewerBlock(map, rows, DEFAULTS);
  assert.ok(block && block.fix, 'the reviewer shares the developer seat’s model');
  const { shown, total } = topAlternatives(block.alternatives, 3, { fix: block.fix, map, catalog: rows, defaults: DEFAULTS });
  assert.equal(shown.length, 3);
  assert.equal(shown[0].model, block.fix.model, 'the fix is named first');
  assert.equal(new Set(shown.map(entry => entry.family + lineOf(entry))).size, 3, 'three different lines, not Fable and Fable 5.1');
  assert.ok(shown.every(entry => !/^claude-opus-4|^claude-fable-5$|^gpt-5|^gpt-6-/.test(entry.model)), 'no old version stands for its line');
  assert.equal(total, block.alternatives.length);
  const reversed = topAlternatives([...block.alternatives].reverse(), 3, { fix: block.fix, map, catalog: rows, defaults: DEFAULTS });
  assert.deepEqual(reversed.shown.map(entry => entry.model), shown.map(entry => entry.model), 'the same names in any list order');
  const h = dialogHarness(t, seatsInfo({ catalog: rows, defaults: { ...clone(DEFAULTS), developer: { model: 'opus', effort: 'high' } } }));
  const text = textOf(find(h.render(), node => node.props.className === 'seats-banner is-bad' && node.props.role === 'alert'));
  assert.doesNotMatch(text, /Fable.*Fable/, 'the banner does not name one line twice');
  assert.match(text, /and others \(\d+ in all\)/);
});

test('org chart uses fixture order and gives each seat its own model, effort and fast controls', t => {
  const h = dialogHarness(t, seatsInfo({ catalog: team.catalog }));
  const tree = h.render();
  const owner = byAttr(tree, 'data-owner');
  assert.equal(textOf(find(owner, node => node.type === 'h3')), 'Human / Owner');
  assert.equal(textOf(find(owner, node => node.type === 'p')), 'Goals, budget, major decisions, and final authorization');
  assert.deepEqual(findAll(tree, node => node.props['data-seat']).map(node => node.props['data-seat']), SEATS);
  for (const id of SEATS) {
    const card = byAttr(tree, 'data-seat', id);
    for (const attr of ['data-pick', 'data-tile-effort', 'data-tile-fast']) {
      assert.equal(byAttr(card, attr, id).type, 'button');
    }
  }
});

test('the host keeps a migration that arrives after closing and the next dialog translates it until acknowledged', async t => {
  const migration = '总指挥沿用原领队 Claude 槽 sonnet·high·fast；原 Codex 槽 gpt-6.2-sol 未保留\nSample: 总指挥沿用原领队 Codex 槽 gpt-6.2-sol·high';
  const info = seatsInfo(), window = new EventTarget();
  let finishRefresh;
  window.agentrix = { skillSeats: async () => info, skillSeatsRefresh: () => new Promise(resolve => { finishRefresh = resolve; }) };
  const HTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = class {};
  t.after(() => { globalThis.HTMLElement = HTMLElement; });
  globalThis.window = window; globalThis.document = { activeElement: null };
  const host = mount(t, 'SeatsHost.tsx', 'SeatsHost', {});
  const props = () => find(host.render(), node => node.props.info)?.props;
  const open = async () => {
    window.dispatchEvent(new CustomEvent('agentrix:open-seats', { detail: { projectId: 'p1', terminalId: 't1', info } }));
    await settle();
    return mount(t, 'SeatsDialog.tsx', 'SeatsDialog', props());
  };
  host.render();
  const first = await open();
  assert.equal(byAttr(first.render(), 'data-migrated'), undefined);
  first.props.onClose(); first.unmount();
  const finishFirst = finishRefresh;
  const next = await open();
  assert.equal(byAttr(next.render(), 'data-migrated'), undefined);
  finishFirst(seatsInfo({ migrated: migration })); await settle();
  next.props = props();
  const notice = byAttr(next.render(), 'data-migrated');
  assert.deepEqual(findAll(notice, node => node.type === 'p').map(textOf), [
    'The Orchestrator kept the previous Claude seat (sonnet·high·fast). The previous Codex seat (gpt-6.2-sol) was dropped.',
    'Sample: The Orchestrator kept the previous Codex seat (gpt-6.2-sol·high).',
  ]);
  find(notice, node => node.type === 'button').props.onClick();
  finishRefresh(seatsInfo({ migrated: migration })); await settle();
  next.props = props();
  assert.equal(byAttr(next.render(), 'data-migrated'), undefined);
});

test('the app seats host opens only when main supplies routing info', async t => {
  const window = new EventTarget();
  let answer = null;
  window.agentrix = { skillSeats: async () => answer };
  globalThis.window = window;
  globalThis.document = { activeElement: null };
  const HTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = class {};
  t.after(() => { globalThis.HTMLElement = HTMLElement; });
  const h = mount(t, 'SeatsHost.tsx', 'SeatsHost', {});
  const show = () => window.dispatchEvent(new CustomEvent('agentrix:open-seats', { detail: { projectId: 'p1', terminalId: 't1' } }));
  assert.equal(h.render(), null);
  show(); await settle(); assert.equal(h.render(), null, 'routing is disabled');
  answer = seatsInfo(); show(); await settle();
  const dialog = find(h.render(), node => node.props.info);
  assert.equal(dialog.props.info, answer);
  assert.deepEqual([dialog.props.projectId, dialog.props.terminalId], ['p1', 't1']);
});

test('the activity key is one button with a row for each role and opens the scoped dialog', async t => {
  const window = new EventTarget(), events = [];
  const changes = { lookup: { model: 'gpt-6.2-sol', effort: 'high' }, review: { model: 'gpt-6-mini' }, background: { model: 'haiku' } };
  const operations = operationInfo({ current: { values: changes, agents: {} } });
  let loaded = operations;
  window.agentrix = { skillSeats: async () => seatsInfo({ operations: loaded }) };
  window.addEventListener('agentrix:open-seats', event => events.push(event.detail));
  globalThis.window = window;
  const props = { projectId: 'p1', terminalId: 't1', sessionId: 's1' };
  const h = mount(t, 'RoutingKeyCard.tsx', 'RoutingKeyCard', props);
  assert.equal(h.render(), null);
  await settle();
  const tree = h.render();
  assert.equal(findAll(tree, node => node.type === 'button').length, 1);
  const heading = byAttr(tree, 'className', 'activity-card-title activity-routing-title');
  assert.match(textOf(heading), /Model routing/i);
  assert.deepEqual(findAll(tree, node => node.props['data-seat']).map(node => node.props['data-seat']), SEATS);
  assert.equal(findAll(tree, node => node.props.className === 'activity-routing-row').length, 10);
  const summary = byAttr(tree, 'className', 'activity-routing-operations');
  assert.match(textOf(summary), /Lookup · Review/);
  assert.match(summary.props.title, /GPT-6\.2-Sol · high[\s\S]*GPT-6-Mini/i);
  assert.doesNotMatch(summary.props.title, /Background/);
  assert.equal(summary.props['data-seat'], undefined);
  tree.props.onClick();
  assert.deepEqual(events, [{ projectId: 'p1', terminalId: 't1' }]);
  loaded = operationInfo();
  h.props = { ...props, sessionId: 's2' };
  h.render();
  await settle();
  assert.match(textOf(byAttr(h.render(), 'className', 'activity-routing-operations')), /Operation models · default/i);
});

test('role drafts follow their sources and reviewer conflicts use enabled author roles', () => {
  const info = seatsInfo({ roles: [
    ...team.roles.map(role => shipped(role)),
    { ...shipped({ id: 'frontend', name: 'Frontend', detail: 'Frontend implementation', duty: 'UI', outputs: 'Code' }, 'library'), inherits: 'developer' },
  ] });
  const project = { roles: {
    frontend: { enabled: true },
    'x-ui': { from: 'frontend', name: 'UI specialist', duty: 'UI design' },
    'x-review': { from: 'reviewer', name: 'Review copy', duty: 'Review code' },
    reviewer: { enabled: false },
    developer: { model: 'opus', effort: 'max' },
  }, operations: {} };
  const roles = seatsLib.draftRoles(info, project);
  const models = seatsLib.resolveDraftSeats(info.defaults, roles, project);
  assert.equal(roles.find(role => role.id === 'x-review').kind, 'reviewer');
  assert.equal(roles.find(role => role.id === 'x-review').fresh, true);
  assert.deepEqual(models['x-ui'], { model: 'opus', effort: 'max' });
  const result = reviewerBlock(models, catalog(), info.defaults, { authors: ['x-ui', 'frontend'], reviewers: ['x-review'] });
  assert.deepEqual([result.reviewer, result.hit], ['x-review', ['x-ui', 'frontend']]);
  assert.equal(reviewerBlock(models, catalog(), info.defaults, { authors: [], reviewers: ['x-review'] }), null);
});

test('the role library locks the last reviewer and the editor supports copy and replace', t => {
  const h = dialogHarness(t, seatsInfo());
  byAttr(h.render(), 'data-routing-tab', 'library').props.onClick();
  const tree = h.render();
  assert.equal(byAttr(tree, 'data-toggle-role', 'reviewer').props.disabled, true);
  assert.equal(byAttr(tree, 'data-toggle-role', 'orchestrator').props.disabled, true);
  byAttr(tree, 'data-replace-role', 'reviewer').props.onClick();
  const editor = find(h.render(), node => node.type?.name === 'RoleEditor');
  assert.equal(editor.props.initial.from, 'reviewer');
  assert.equal(editor.props.id, 'x-reviewer-1');
  assert.equal(editor.props.replace, 'reviewer');
  editor.props.save(editor.props.id, { ...editor.props.initial, name: 'Review copy' });
  const next = h.render();
  assert.equal(byAttr(next, 'data-toggle-role', 'reviewer').props.disabled, false);
  assert.equal(byAttr(next, 'data-toggle-role', 'x-reviewer-1').props.disabled, true);
});

test('frozen role groups retain a row name and put off-team calls last after terminal reuse', () => {
  const dev = { ...team.roles.find(role => role.id === 'developer'), name: 'Developer' };
  const selected = [{ ...dev, id: 'x-ui', name: 'Selected name' }, dev];
  const row = (id, seat, seatName, startedAt, offTeam) => ({
    item: { id, seat, seatName, startedAt, offTeam, seatSource: 'declared' },
    call: { model: 'opus' },
  });
  const rows = [
    row('off', 'x-ui', 'Old name', 5, true),
    row('dev', 'developer', 'Developer', 4),
    row('old', 'x-other', 'Previous name', 1),
    row('new', 'x-other', 'Newest name', 9),
    row('ui', 'x-ui', 'Original name', 2),
  ];
  const groups = seatsLib.roleGroups(selected, rows);
  assert.deepEqual(groups.map(({ role, offTeam }) => [role.id, role.name, offTeam]), [
    ['x-ui', 'Selected name', false], ['developer', 'Developer', false], ['x-other', 'Newest name', false], ['x-ui', 'Selected name', true],
  ]);
  assert.equal(seatsLib.callSeatRole(selected, groups[0].rows[0].item).role.name, 'Original name');
  assert.equal(seatsLib.routeVerdict(rows[0], { current: { 'x-ui': { model: 'opus' } } }), 'unknown');
});

test('the first project file is an explicit save with a null base and frozen choices survive a watch event', async t => {
  const info = seatsInfo({
    routing: source({ layer: 'template', state: 'absent', digest: null }),
    current: DEFAULTS, currentRoles: team.roles.map(role => shipped(role)),
  });
  const h = dialogHarness(t, info);
  assert.match(textOf(h.render()), /Creates \.agentrix\/routing\.json/);
  byAttr(h.render(), 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['project', 'p1', { roles: {}, operations: {} }, null]]);
  h.deliver({ ...info, routing: source({ digest: 'other', state: 'pending', actions: ['keep'] }) });
  await settle();
  assert.ok(byAttr(h.render(), 'data-routing-review', 'pending'));
  byAttr(h.render(), 'data-now').props.onClick();
  assert.match(textOf(byAttr(h.render(), 'aria-label', 'This conversation (read-only)')), /Orchestrator/);
});

test('the role editor validates text, regenerates a new ID and clears the seat when the source changes', t => {
  const roles = team.roles.map(role => shipped(role)), saves = [];
  const initial = { from: 'developer', name: 'Role', duty: 'Implement feature', model: 'opus', effort: 'max' };
  const handle = mount(t, 'RoleEditor.tsx', 'RoleEditor', {
    id: 'x-developer-1', initial, roles, catalog: catalog(), models: DEFAULTS, taken: ['x-reviewer-1'],
    save: (...args) => saves.push(args), close: () => {}, copy: () => {},
  }, {});
  const change = (node, value) => node.props.onChange({ target: { value } });
  let tree = handle.render();
  assert.equal(byAttr(tree, 'data-save-role').props.disabled, false);
  change(byAttr(tree, 'data-role-text', 'duty'), 'bad | text');
  assert.equal(byAttr(handle.render(), 'data-save-role').props.disabled, true);
  assert.match(textOf(handle.render()), /Character \| is not allowed/);
  change(find(tree, node => node.type === 'select' && node.props.required), 'reviewer');
  tree = handle.render();
  assert.ok(find(tree, node => node.type === 'input' && node.props.value === 'x-reviewer-2'));
  assert.equal(find(tree, node => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked && node.props.disabled)?.props.checked, true);
  change(byAttr(tree, 'data-role-text', 'duty'), 'Review code');
  tree = handle.render();
  assert.equal(byAttr(tree, 'data-save-role').props.disabled, false);
  byAttr(tree, 'data-save-role').props.onClick();
  assert.equal(saves[0][0], 'x-reviewer-2');
  assert.equal(saves[0][1].from, 'reviewer');
  assert.equal(saves[0][1].model, undefined);
});

test('the routing key refreshes accepted roles while keeping the running lead and marking its saved settings', async t => {
  const lead = shipped(team.roles.find(role => role.id === 'orchestrator'));
  const roles = [lead, ...Array.from({ length: 15 }, (_, index) => ({
    id: 'x-role-' + index, name: 'Saved ' + index, enabled: true, source: 'custom',
  }))];
  const leadPending = { model: 'gpt-6.2-sol', effort: 'medium', fast: true };
  const effective = Object.fromEntries(roles.map(role => [role.id, leadPending]));
  const initial = seatsInfo({ current: DEFAULTS, currentRoles: team.roles.map(role => shipped(role)) });
  let info = initial, notify;
  globalThis.window = { agentrix: { skillSeats: async () => info, onSkills: listener => { notify = listener; } } };
  const handle = mount(t, 'RoutingKeyCard.tsx', 'RoutingKeyCard', { projectId: 'p1', terminalId: 't1' }, {});
  handle.render();
  await settle();
  assert.equal(byAttr(handle.render(), 'data-seat', 'x-role-0'), undefined);
  assert.doesNotMatch(textOf(handle.render()), /after restart/i);
  info = { ...initial, effective, leadPending, roles: [...roles, { id: 'x-off', enabled: false }],
    routing: source({ state: 'pending' }) };
  notify();
  await settle();
  const tree = handle.render();
  assert.equal(findAll(tree, node => node.props['data-seat']).length, 16);
  assert.equal(byAttr(tree, 'data-seat', 'x-off'), undefined);
  assert.ok(byAttr(tree, 'data-compact'));
  assert.match(textOf(byAttr(tree, 'data-seat', 'x-role-0')), /Saved 0GPT-6\.2-Solmedium · Fast/i);
  assert.match(textOf(byAttr(tree, 'data-seat', 'orchestrator')), /Orchestrator AgentOpushighAfter restart: GPT-6\.2-Sol · medium · Fast/i);
  assert.match(tree.props['aria-label'], /needs review/);
});

test('the conversation box uses accepted settings across drafts and limits restart wording to the pending lead', async t => {
  const leadPending = { model: 'gpt-6.2-sol', effort: 'medium', fast: true };
  const info = seatsInfo({ project: { orchestrator: leadPending, architect: { model: 'sonnet', effort: 'medium' } },
    current: DEFAULTS, currentRoles: team.roles.map(role => shipped(role)), leadPending });
  const h = dialogHarness(t, info, { language: 'zh' });
  byAttr(openMenu(h, 'architect'), 'data-assign', 'haiku').props.onClick();
  byAttr(h.render(), 'data-now').props.onClick();
  const choices = byAttr(h.render(), 'aria-label', '本次对话（只读）');
  assert.match(textOf(byAttr(choices, 'data-current-seat', 'architect')), /Sonnet · medium/);
  assert.doesNotMatch(textOf(choices), /Haiku|→/);
  assert.match(textOf(byAttr(choices, 'data-current-seat', 'orchestrator')), /Opus · high重启后生效：GPT-6\.2-Sol · medium · 快速/);
  byAttr(h.render(), 'data-save').props.onClick();
  await settle();
  const notice = find(h.render(), node => node.props.className === 'seats-notice');
  assert.equal(textOf(notice), '已保存，立即生效；总指挥重启后生效');
});

test('the role library and Developer specialties use the supplied labels and duties', t => {
  const roles = [...team.roles.map(role => shipped(role)),
    { ...shipped({ id: 'ai', name: '人工智能', duty: '模型接入', detail: '主进程提供的模型职责', outputs: '' }, 'library'), kind: 'author' },
    shipped({ id: 'a11y', name: '无障碍', duty: '无障碍验证', detail: '主进程提供的无障碍职责', outputs: '' }, 'library'),
  ];
  const h = dialogHarness(t, seatsInfo({ roles }), { language: 'zh' });
  const developer = byAttr(h.render(), 'data-seat', 'developer');
  assert.match(textOf(developer), /人工智能/);
  assert.doesNotMatch(textOf(developer), /\bAI\b/);
  byAttr(h.render(), 'data-routing-tab', 'library').props.onClick();
  const library = h.render();
  assert.match(textOf(byAttr(library, 'data-library-role', 'ai')), /人工智能.*主进程提供的模型职责/);
  assert.match(textOf(byAttr(library, 'data-library-role', 'a11y')), /无障碍.*主进程提供的无障碍职责/);
});

test('English localizes every shipped role library field and the copy suffix', () => {
  const { builtinMetadata } = require('../electron/features/skills/builtin-format.cjs');
  const shippedSkill = fs.readFileSync(path.join(__dirname, '../resources/skills/model-routing/SKILL.md'), 'utf8');
  const { library, roles } = builtinMetadata(shippedSkill, 'model-routing');
  for (const { name, duty, detail, outputs } of roles.filter(role => library.includes(role.id))) {
    for (const key of ['席位 · ' + name, name, duty, detail, outputs]) {
      assert.ok(en[key], 'missing translation for ' + key);
    }
  }
  assert.equal(en['副本'], ' copy');
});

test('the library displays both limits and the reviewer locks beside their controls', t => {
  const custom = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [
    'x-dev-' + i, { from: 'developer', name: 'Extra ' + i, duty: 'Develop', enabled: i < 6 },
  ]));
  const libraryRole = shipped({ id: 'a11y', name: '无障碍', duty: '无障碍验证', detail: '', outputs: '' }, 'library');
  const info = seatsInfo({ roles: [...team.roles.map(role => shipped(role)), libraryRole], config: { roles: custom, operations: {} } });
  const h = dialogHarness(t, info, { language: 'zh' });
  const teamChart = h.render();
  assert.match(textOf(byAttr(byAttr(teamChart, 'data-seat', 'reviewer'), 'data-role-lock', 'fresh')), /始终使用新实例/);
  assert.match(textOf(byAttr(teamChart, 'data-scope', 'project')), /本项目 · 保存在 \.agentrix\/routing\.json/);
  byAttr(teamChart, 'data-routing-tab', 'library').props.onClick();
  const library = h.render();
  assert.match(textOf(byAttr(library, 'data-role-limit', 'enabled')), /已启用 16 个角色（上限 16）；停用一个后才能再启用/);
  assert.match(textOf(byAttr(library, 'data-role-limit', 'custom')), /已创建 8 个项目角色/);
  assert.equal(byAttr(library, 'data-new-role').props.disabled, true);
  const join = byAttr(library, 'data-toggle-role', 'a11y');
  assert.equal(textOf(join), '加入团队');
  assert.equal(join.props.disabled, true);
  assert.match(join.props.title, /停用一个后才能再启用/);
  assert.equal(textOf(byAttr(library, 'data-toggle-role', 'developer')), '移出团队');
  for (const [id, reason] of [['orchestrator', /总指挥必须保留/], ['reviewer', /至少保留一个审查角色/]]) {
    const card = byAttr(library, 'data-library-role', id);
    const actions = find(card, node => node.props.className === 'seats-role-actions');
    const children = React.Children.toArray(actions.props.children)
      .flatMap(node => node.type === React.Fragment ? React.Children.toArray(node.props.children) : node);
    assert.ok(children.some(node => node.props['data-edit-role'] === id));
    assert.equal(children.find(node => node.props['data-toggle-role'] === id).props.disabled, true);
    assert.match(textOf(children.at(-1)), reason);
  }
  assert.match(textOf(byAttr(library, 'data-library-role', 'x-dev-0')), /项目角色/);
});

test('role editor errors name the invalid field, limit, character or conflicting role', t => {
  const roles = team.roles.map(role => shipped(role));
  const handle = mount(t, 'RoleEditor.tsx', 'RoleEditor', {
    id: 'x-editor-1', initial: { from: 'developer', name: 'Role', duty: 'Implement' },
    roles, catalog: catalog(), models: DEFAULTS, taken: [],
    save: () => assert.fail('invalid role saved'), close: () => {}, copy: () => {},
  }, { language: 'zh' });
  const change = (field, value, message) => {
    const input = byAttr(handle.render(), 'data-role-text', field);
    input.props.onChange({ target: { value } });
    const tree = handle.render(), error = byAttr(tree, 'data-role-error', field);
    assert.match(textOf(error), message);
    const invalid = byAttr(tree, 'data-role-text', field);
    assert.equal(invalid.props['aria-invalid'], true);
    assert.equal(invalid.props['aria-describedby'], error.props.id);
    assert.equal(byAttr(tree, 'data-save-role').props.disabled, true);
  };
  change('name', '', /请输入名称/);
  change('name', 'A'.repeat(13), /名称最多可填 12 个字符，当前为 13 个/);
  change('name', '开发', /名称与角色「开发」重复/);
  change('name', 'a|b', /不允许字符 \|/);
  change('duty', '', /请输入职责/);
  change('duty', 'A'.repeat(161), /职责最多可填 160 个字符/);
  change('outputs', 'A'.repeat(61), /产出最多可填 60 个字符/);
});

test('drafts use the main process role defaults and preserve its library order', t => {
  const mainRoles = team.roles.map(role => shipped(role));
  const developer = mainRoles.find(role => role.id === 'developer');
  const a11y = { ...shipped({ ...developer, id: 'a11y', name: '无障碍' }, 'library'),
    enabled: false, fresh: false, defaultEnabled: true, defaultFresh: true, defaultSeat: { model: 'gpt-6.2-sol', effort: 'low' } };
  const frontend = { ...shipped({ ...developer, id: 'frontend', name: '前端' }, 'library'), inherits: 'architect' };
  const info = seatsInfo({ roles: [...mainRoles, a11y, frontend] });
  const config = { roles: { a11y: { fresh: false }, frontend: { enabled: true } }, operations: {} };
  const roles = seatsLib.draftRoles(info, config);
  const seats = seatsLib.resolveDraftSeats(info.defaults, roles, config);
  assert.deepEqual(roles.slice(-2).map(role => role.id), ['a11y', 'frontend']);
  assert.deepEqual(roles.find(role => role.id === 'a11y'), { ...a11y, enabled: true });
  assert.deepEqual(seats.a11y, a11y.defaultSeat);
  assert.deepEqual(seats.frontend, seats.architect);
  assert.deepEqual(seatsLib.cleanDraft(info, { ...config, roles: { ...config.roles, a11y: { enabled: true, fresh: false, ...seats.a11y } } }), config);

  const h = dialogHarness(t, { ...info, config });
  const chart = h.render();
  assert.equal(find(byAttr(chart, 'data-seat', 'orchestrator'), node => node.props.type === 'checkbox'), undefined);
  assert.match(textOf(byAttr(byAttr(chart, 'data-seat', 'a11y'), 'data-fresh-override')), /Changed to reuse an instance/);
});

test('invalid editor fields override the normal border and keep the visible focus outline', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/seats-dialog.css'), 'utf8');
  assert.match(css, /\.seats-role-fields :is\(input, textarea, select\)\[aria-invalid="true"\] \{ border-color: var\(--danger\); \}/);
  assert.match(css, /\.seats-dialog :focus-visible \{ outline: 2px solid var\(--focus-ring\); outline-offset: 2px; \}/);
});

test('pending and invalid project files replace the green application status and show the template label once', async t => {
  const info = seatsInfo({ routing: source({ layer: 'template', state: 'pending', actions: ['apply', 'keep'] }) });
  const h = dialogHarness(t, info, { language: 'zh' });
  const check = (tree, status) => {
    const row = find(tree, node => node.props.className === 'seats-strip-row');
    assert.equal(textOf(find(row, node => node.props.className === 'seats-effective')), status);
    assert.doesNotMatch(textOf(row), /下一次对话生效|没有改动/);
    assert.equal(find(row, node => node.props.className?.includes('seats-dot')), undefined);
  };
  const pending = h.render();
  check(pending, '等你确认');
  const header = find(pending, node => node.props.className === 'seats-head');
  assert.equal((textOf(header).match(/我的默认模板/g) ?? []).length, 1);
  h.deliver({ ...info, routing: { ...info.routing, state: 'invalid', actions: ['keep'], error: { code: 'bad-json' } } });
  await settle();
  check(h.render(), '文件未应用');
});

test('a changed review digest temporarily disables every action and sends only the latest digest', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = digest => source({ state: 'pending', digest, actions: ['apply', 'keep', 'overwrite'] });
  const info = seatsInfo({ routing: pending('old'), current: DEFAULTS }), calls = [];
  const accepted = seatsInfo({ current: DEFAULTS, project: { architect: { model: 'sonnet', effort: 'medium' } } });
  const h = dialogHarness(t, info, { resolveSkillRouting: async (...args) => {
    calls.push(args);
    h.deliver(accepted);
    return { ok: true };
  } });
  const action = (tree, id = 'apply') => byAttr(tree, 'data-routing-action', id);
  assert.equal(action(h.render()).props.disabled, false);
  h.deliver({ ...info, routing: pending('new') });
  await settle();
  const changed = h.render();
  assert.match(textOf(byAttr(changed, 'data-review-refreshed')), /Review refreshed/);
  for (const id of ['apply', 'keep', 'overwrite']) {
    assert.equal(action(changed, id).props.disabled, true);
    action(changed, id).props.onClick();
  }
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1000);
  const ready = h.render();
  assert.equal(action(ready).props.disabled, false);
  action(ready).props.onClick();
  await settle();
  assert.deepEqual(calls, [['p1', 'apply', 'new']]);
  assert.equal(byAttr(h.render(), 'data-routing-review'), undefined);
  const notice = find(h.render(), node => node.props.className === 'seats-notice');
  assert.equal(textOf(notice), 'Saved. Takes effect immediately.');
  byAttr(h.render(), 'data-now').props.onClick();
  assert.match(textOf(byAttr(h.render(), 'data-current-seat', 'architect')), /Sonnet · medium/);
});
