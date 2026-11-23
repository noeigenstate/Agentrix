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
const { firstRefusal } = seatsLib;

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
function seatsInfo({ global = {}, project = null, ...overrides } = {}) {
  const template = { roles: global }, applied = project ? { roles: project } : null;
  return {
    skill: 'model-routing', seats: SEATS, roles: team.roles.map(role => shipped(role)), lead: 'orchestrator',
    authors: ['developer'], leadAgent: 'claude', leads: { claude: DEFAULTS.orchestrator, codex: DEFAULTS.developer },
    fresh: ['qa', 'reviewer'], defaults: clone(DEFAULTS), template, config: applied,
    effective: { ...clone(DEFAULTS), ...(applied ?? template).roles }, current: null, currentRoles: null, leadPending: null, routing: source(),
    catalog: catalog(), installed: { claude: true, codex: true }, ...overrides,
  };
}

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
  assert.deepEqual(seatsLib.cleanDraft(info, info.config), { roles: project });
});

test('routing saves send one scoped config and the on-disk base, and preserve structured refusals', async () => {
  const calls = [], config = { roles: { architect: { model: 'sonnet', effort: 'low' } } };
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
    if (['./RoleEditor', './RoutingReview'].includes(name)) return compile(name.slice(2) + '.tsx', hooks, stubs);
    if (name.endsWith('/role-rules.mjs')) return original(name);
    if (name === '../../shared/routing-command.ts') return { OPEN_SEATS: 'agentrix:open-seats',
      routingModelName: require('../src/shared/routing-command.ts').routingModelName,
      modelLabel: require('../src/shared/model-name.ts').modelLabel, aliasTarget: require('../src/shared/model-name.ts').aliasTarget,
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
  hooks.useLayoutEffect = hooks.useEffect;
  const component = compile(file, hooks, stubs)[name];
  const handle = { props, render(commit) { cursor = 0; const tree = component(handle.props); commit?.(tree); while (effects.length) effects.shift()(); return tree; }, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
  t.after(() => { handle.unmount(); globalThis.window = previous.window; globalThis.document = previous.document; });
  return handle;
}
const inlineComponents = new Set([
  'RoutingTabs', 'MenuHeader',
  'DialogHeader', 'DialogToolbar', 'RoutingStatus', 'DialogStrip', 'ConversationChoices', 'TeamChart', 'ModelPalette', 'DialogMenu',
  'TeamCard', 'SeatPicker', 'PickerSettings', 'TeamModelOptions', 'RoleLibrary', 'RoleActions', 'RoutingReview', 'RoleTextFields', 'RoleModel',
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

test('model menu bounds keep a margin at both window edges', () => {
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
});

test('the dialog saves the chosen scope and the edited map; the keyboard 更换 menu assigns a model, effort and fast', async t => {
  const h = dialogHarness(t, seatsInfo({ project: null }));
  let tree = h.render();
  assert.ok(byAttr(tree, 'data-save').props.disabled, '保存 waits for a change');
  assert.equal(textOf(byAttr(tree, 'data-save')), 'Save routing');
  assert.doesNotMatch(byAttr(tree, 'data-save').props.className, /is-primary/);
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
  byAttr(tree, 'data-pop-effort', 'xhigh').props.onClick();
  tree = h.render();
  assert.match(textOf(tree), /1 unsaved change/);
  const save = byAttr(tree, 'data-save');
  assert.equal(save.props.disabled, false);
  save.props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['project', 'p1', { roles: { architect: { model: 'gpt-6.2-sol', effort: 'xhigh' } } }, 'at-open']], 'only the changed seat');
  tree = h.render();
  assert.match(textOf(byAttr(tree, 'data-routing-status')), /^✓Saved\. Takes effect immediately\.$/);
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
  assert.deepEqual(h.calls, [['project', 'p1', { roles: {} }, 'at-open']], 'an empty map clears the global scope');
  const project = dialogHarness(t, seatsInfo());
  tree = project.render();
  byAttr(tree, 'data-scope', 'project').props.onClick();
  byAttr(project.render(), 'data-pick', 'researcher').props.onClick(pickButton('researcher'));
  byAttr(find(project.render(), node => node.props.role === 'menu'), 'data-assign', 'haiku').props.onClick();
  byAttr(project.render(), 'data-save').props.onClick();
  await settle();
  assert.deepEqual(project.calls, [['project', 'p1', { roles: { researcher: { model: 'haiku', effort: 'high' } } }, 'at-open']]);
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
  const modelOf = slot => textOf(find(byAttr(tree, 'data-slot', slot), node => node.props.className === 'seats-gem-name'));
  assert.equal(modelOf('developer'), 'Sonnet');
  assert.equal(modelOf('designer'), 'GPT-6.2-Sol');
  const haiku = byAttr(tree, 'data-chip', 'haiku');
  haiku.props.onPointerDown({ button: 0, clientX: 0, clientY: 0 });
  target = 'qa';
  listeners.pointermove({ clientX: 80, clientY: 80 });
  listeners.pointerup({ clientX: 80, clientY: 80 });
  tree = h.render();
  assert.equal(modelOf('qa'), 'Haiku');
  assert.match(textOf(byAttr(tree, 'className', 'seats-notice')), /QA \/ Tester now uses Haiku/);
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

test('the chart places connector drops at the columns and moves the palette into a drawer below 1400 px', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/seats-dialog.css'), 'utf8');
  const compact = css.slice(css.indexOf('@media (max-width: 940px)'), css.indexOf('@media (max-width: 700px)'));
  assert.match(css, /\.seats-team-grid \{[^}]*grid-template-columns: repeat\(4,/);
  assert.match(compact, /\.seats-team-grid \{[^}]*grid-template-columns: repeat\(2,/);
  assert.match(css, /\.seats-palette \{ display: none; \}/);
  assert.match(css, /\.seats-palette\.is-open \{[^}]*display: flex/);
  assert.match(css, /@media \(width >= 1400px\) \{[^]*?\.seats-palette \{[^}]*display: flex/);
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
  assert.deepEqual(h.calls, [['template', null, { roles: { researcher: { model: 'opus', effort: 'high' } } }, null]]);
  byAttr(h.render(), 'data-scope', 'project').props.onClick();
  assert.match(textOf(byAttr(h.render(), 'data-pick', 'researcher')), /Haiku/);
});

test('the template scope says new projects start from it', t => {
  const h = dialogHarness(t, seatsInfo());
  const project = h.render();
  const message = /New projects start from this template/;
  assert.doesNotMatch(textOf(byAttr(project, 'data-routing-status')), message);
  byAttr(project, 'data-scope', 'template').props.onClick();
  assert.match(textOf(byAttr(h.render(), 'data-routing-status')), message);
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
  } }, 'at-open']]);
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
  assert.match(textOf(after), /1 unsaved change/);
  panel(after).props.onKeyDown(keyEvent('Escape'));
  assert.ok(byAttr(h.render(), 'role', 'alertdialog'), 'the next Escape still reaches the dialog');
  assert.deepEqual(h.closed, []);
});

// ---- catalog-driven dialog (round cat-r1): the menu follows each row, a typed-in id is accepted by the helper's syntax, the lists can be refreshed ----
const openMenu = (h, slot) => { byAttr(h.render(), 'data-pick', slot).props.onClick(pickButton(slot)); return liveMenu(h); };
const optionValues = select => findAll(select, node => node.type === 'option').map(node => node.props.value);
const assignable = menu => findAll(menu, node => node.props.role === 'menuitemradio').map(node => node.props['data-assign']);
const liveMenu = h => find(h.render(), node => node.props.role === 'menu' || node.props['data-model-picker-menu']);
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
  const choices = findAll(byAttr(menu, 'data-effort', 'developer'), node => node.props['data-pop-effort']);
  assert.deepEqual(choices.map(node => node.props['data-pop-effort']), ['low', 'high', 'ultra'], 'the effort menu is the row’s list');
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
  assert.match(textOf(byAttr(tree, 'className', 'seats-notice')), /gpt-6\.3-sol/);
  byAttr(tree, 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['project', 'p1', { roles: { developer: { model: 'gpt-6.3-sol', effort: 'high', fast: true } } }, 'at-open']]);
  // A custom model of the other family can be used by the orchestrator.
  const lead = dialogHarness(t, seatsInfo());
  byAttr(openMenu(lead, 'orchestrator'), 'data-custom').props.onClick();
  typeCustom(lead, 'claude-opus-9'); applyCustom(lead);
  assert.match(textOf(byAttr(lead.render(), 'data-seat', 'orchestrator')), /Opus 9/);
});

test('the refresh button asks main for the seats, shows the new catalog and when each list was read, and says when it fails', async t => {
  const now = Date.now(), at = { claude: now - 3 * 3600000 - 1000, codex: null };
  const refreshed = seatsInfo({ catalog: [...catalog(), row('gpt-6.2-sol', 'GPT-6.2-Sol', 'codex', 3)], catalogAt: { claude: now, codex: now - 120000 } });
  const h = dialogHarness(t, seatsInfo({ catalogAt: at }), { refreshed });
  let tree = h.render();
  assert.match(byAttr(tree, 'data-catalog-at').props.title, /Claude 3 h ago · Codex not refreshed$/);
  byAttr(tree, 'data-refresh').props.onClick();
  await settle();
  assert.deepEqual(h.refreshes, [['p1', 't1', 'dialog'], ['p1', 't1', 'manual']], 'once when the dialog opens (throttled in main), once for the button (always)');
  tree = h.render();
  assert.match(byAttr(tree, 'data-catalog-at').props.title, /Claude just now · Codex 2 min ago$/);
  assert.match(textOf(byAttr(tree, 'className', 'seats-notice')), /Model lists refreshed/);
  assert.ok(assignable(openMenu(h, 'architect')).includes('gpt-6.2-sol'), 'the new model is offered');
  const failing = dialogHarness(t, seatsInfo(), { refreshError: 'probe timed out' });
  byAttr(failing.render(), 'data-refresh').props.onClick();
  await settle();
  const after = failing.render();
  assert.match(textOf(byAttr(after, 'className', 'seats-notice')), /Not refreshed: probe timed out/);
  assert.equal(byAttr(after, 'data-refresh').props.disabled, false, 'the button is usable again');
  const none = dialogHarness(t, seatsInfo());
  byAttr(none.render(), 'data-refresh').props.onClick();
  await settle();
  assert.match(textOf(byAttr(none.render(), 'className', 'seats-notice')), /Not refreshed: no seats information/);
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
  assert.match(textOf(byAttr(tree, 'data-moved')), /Defaults moved to Developer: GPT-6\.2-Sol → gpt-6\.3-sol/);
  assert.ok(findAll(tree, node => node.props['data-unlisted'] !== undefined).length >= 1, 'Sonnet is marked as no longer listed');
  assert.match(textOf(byAttr(openMenu(h, 'designer'), 'data-assign', 'sonnet')), /Not in the latest list/);
  // Editing the seat makes its saved issue stale: the mark goes.
  byAttr(liveMenu(h), 'data-pop-effort', 'low').props.onClick();
  assert.equal(findAll(h.render(), node => node.props.className?.startsWith('seats-state')).length, 2);
  // A record without the new fields still renders (an older main).
  assert.match(byAttr(dialogHarness(t, seatsInfo()).render(), 'data-catalog-at').props.title, /Claude not refreshed · Codex not refreshed/);
});

test('the dialog reads once when it opens, keeps the opened info until the answer, and shows a moved default from any answer', async t => {
  const moved = [{ seat: 'developer', from: 'gpt-6.2-sol', to: 'gpt-6.3-sol' }];
  const h = dialogHarness(t, seatsInfo(), { refreshed: seatsInfo({ defaultsMoved: moved }) });
  let tree = h.render();
  assert.deepEqual(h.refreshes, [['p1', 't1', 'dialog']], 'one read on open');
  assert.equal(byAttr(tree, 'data-moved'), undefined, 'the note waits for the answer');
  assert.equal(findAll(tree, node => node.props.className === 'seats-notice' && textOf(node)).length, 0, 'an opening read says nothing while it works');
  await settle();
  assert.match(textOf(byAttr(h.render(), 'data-moved')), /Defaults moved to Developer: GPT-6\.2-Sol → gpt-6\.3-sol/);
  const quiet = dialogHarness(t, seatsInfo(), { refreshError: 'offline' });
  quiet.render(); await settle();
  assert.match(textOf(byAttr(quiet.render(), 'className', 'seats-notice')), /Not refreshed: offline/, 'a failed opening read keeps the info and says so');
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
  const info = seatsInfo();
  const h = dialogHarness(t, info);
  let publish, finishOpening;
  window.agentrix.onSkills = listener => { publish = listener; return () => {}; };
  window.agentrix.skillSeats = async () => info;
  window.agentrix.skillSeatsRefresh = () => new Promise(resolve => { finishOpening = resolve; });
  h.render();
  publish();
  await settle();
  finishOpening({ ...info, defaultsMoved: [{ seat: 'developer', from: 'gpt-6.2-sol', to: 'gpt-6.3-sol' }] });
  await settle();
  assert.ok(byAttr(h.render(), 'data-moved'));
  byAttr(openMenu(h, 'architect'), 'data-assign', 'haiku').props.onClick();
  assert.equal(byAttr(h.render(), 'data-save').props.disabled, false);
  assert.match(textOf(byAttr(h.render(), 'data-moved')), /Defaults moved to Developer/);
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/seats-dialog.css'), 'utf8');
  assert.match(css, /\.seats-strip:not\(:has\(p:not\(:empty\), \.seats-banner, button\)\)/);
});

// ---- second acceptance round: no tile overlaps another, small-tile chips shorten and ellipsize, the one-click fix is chosen by rule ----

test('the card, banner, palette and menu name a Claude model by its release, and an alias by the release it runs', t => {
  assert.equal(shortLabel('Opus (follows latest)'), 'Opus (latest)');
  assert.equal(shortLabel('GPT-6.2-Sol'), 'GPT-6.2-Sol');
  const rows = catalog({ opus: { label: 'Opus (follows latest)' } });
  const h = dialogHarness(t, seatsInfo({ catalog: rows, defaultsMoved: [{ seat: 'architect', from: 'sonnet', to: 'opus' }] }));
  const tree = h.render();
  const slot = byAttr(tree, 'data-slot', 'architect');
  const gem = find(slot, node => node.props.className?.startsWith('seats-gem'));
  // No release of the line is listed: the alias is all there is to show, without "latest".
  assert.equal(textOf(find(gem, node => node.props.className === 'seats-gem-name')), 'Opus');
  assert.equal(gem.props.title, 'Opus · high');
  assert.equal(textOf(byAttr(tree, 'data-chip', 'opus')), 'Opus');
  assert.match(textOf(byAttr(tree, 'data-moved')), /Opus/);
  assert.doesNotMatch(textOf(tree) + textOf(openMenu(h, 'architect')), /latest/);
  // With the release listed, the seat that holds the alias reads as that release and the alias chip is gone.
  const listed = [...rows, row('claude-opus-5-5', 'Opus', 'claude', 3), row('claude-opus-5', 'claude-opus-5', 'claude', 3)];
  const known = dialogHarness(t, seatsInfo({ catalog: listed }));
  const knownTree = known.render();
  assert.equal(textOf(find(byAttr(knownTree, 'data-slot', 'architect'), node => node.props.className === 'seats-gem-name')), 'Opus 5.5');
  assert.equal(textOf(byAttr(knownTree, 'data-chip', 'claude-opus-5-5')), 'Opus 5.5');
  assert.equal(findAll(knownTree, node => node.props['data-chip'] === 'opus').length, 0);
  const menu = openMenu(known, 'architect');
  assert.match(textOf(menu), /Opus 5\.5/);
  assert.equal(findAll(menu, node => node.props['data-assign'] === 'opus').length, 0, 'the menu lists the release, checked for the alias');
  assert.equal(byAttr(menu, 'data-assign', 'claude-opus-5-5').props['aria-checked'], true);
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/seats-dialog.css'), 'utf8');
  assert.match(css, /\.seats-gem-name, \.seats-gem-summary \{[^}]*text-overflow: ellipsis/);
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
  assert.deepEqual(groups.map(group => [group.family, group.total]), [['claude', 14], ['codex', 11]]);
  assert.deepEqual(groups[0].lines.map(line => line.name), ['Opus', 'Sonnet', 'Haiku', 'Fable'], 'Claude lines in catalog order');
  assert.deepEqual(groups[1].lines.map(line => line.name), ['Sol', 'Astra', 'Terra', 'Luna', ''], 'Codex lines, the unnamed one last');
  const opus = lineNamed(groups, 'claude', 'Opus');
  assert.deepEqual(ids(opus.shown), ['claude-opus-5[1m]', 'claude-opus-5'], 'the newest release; its alias reads the same and is not listed');
  assert.deepEqual(ids(opus.older), ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5-20251101'], 'older versions newest first, a date suffix is not a version');
  assert.deepEqual(ids(lineNamed(groups, 'claude', 'Fable').older), ['claude-fable-5'], 'Fable 5.1 is newer than 5');
  assert.equal(lineNamed(groups, 'claude', 'Haiku').older.length, 0, 'a line with nothing older has no fold');
  const sol = lineNamed(groups, 'codex', 'Sol');
  assert.deepEqual(ids(sol.shown), ['gpt-6.2-sol']);
  assert.deepEqual(ids(sol.older), ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol']);
  assert.deepEqual(ids(lineNamed(groups, 'codex', '').shown), ['gpt-5.5']);
  const total = groups.flatMap(group => group.lines).reduce((n, line) => n + line.shown.length + line.older.length, 0);
  assert.equal(total, REAL.length - 3, 'every model but the three aliases is in exactly one place');
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
  assert.equal(groups[0].lines[0].shown.length + groups[0].lines[0].older.length, 6, 'every Opus row matches, old ones too');
  assert.deepEqual(ids(lineNamed(paletteGroups(REAL, 'SOL'), 'codex', 'Sol').older), ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol'], 'case does not matter');
  assert.deepEqual(paletteGroups(REAL, 'zzz'), []);
  const h = dialogHarness(t, seatsInfo({ catalog: REAL }));
  let tree = h.render();
  const chips = () => findAll(h.render(), node => node.props['data-chip'] !== undefined).map(node => node.props['data-chip']);
  assert.equal(chips().length, 13, 'the 12 older versions are folded away');
  byAttr(tree, 'data-palette-search').props.onChange({ target: { value: 'sol' } });
  assert.deepEqual(chips(), ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol'], 'search includes matching older versions');
  byAttr(h.render(), 'data-palette-search').props.onChange({ target: { value: 'zzz' } });
  assert.match(textOf(h.render()), /No matching models/);
});

test('the palette shows the newest of each line, folds earlier versions once per provider', t => {
  const h = dialogHarness(t, seatsInfo({ catalog: REAL }));
  let tree = h.render();
  const shown = () => findAll(h.render(), node => node.props['data-chip'] !== undefined).map(node => node.props['data-chip']);
  assert.ok(shown().includes('claude-opus-5') && !shown().includes('claude-opus-4-8'));
  const fold = byAttr(tree, 'data-fold', 'claude');
  assert.equal(textOf(fold), 'Earlier versions (6)');
  assert.equal(fold.props['aria-expanded'], false);
  fold.props.onClick();
  assert.ok(shown().includes('claude-opus-4-8') && shown().includes('claude-opus-4-5-20251101'), 'the Claude fold shows earlier Opus versions');
  assert.equal(byAttr(h.render(), 'data-fold', 'claude').props['aria-expanded'], true);
  byAttr(h.render(), 'data-fold', 'claude').props.onClick();
  assert.ok(!shown().includes('claude-opus-4-8'), 'and closes again');
  assert.equal(findAll(h.render(), node => node.props['data-fold'] !== undefined).length, 2, 'one fold per provider');
  const groups = findAll(h.render(), node => node.props['data-group'] !== undefined).map(node => node.props['data-group']);
  assert.deepEqual(groups, ['claude', 'codex']);
  const picker = openMenu(h, 'architect');
  assert.equal(byAttr(picker, 'data-assign', 'claude-opus-4-8'), undefined);
  byAttr(picker, 'data-picker-fold', 'claude').props.onClick();
  assert.ok(byAttr(liveMenu(h), 'data-assign', 'claude-opus-4-8'));
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
  assert.equal(textOf(find(byAttr(tree, 'data-slot', 'researcher'), node => node.props.className?.startsWith('seats-gem-name'))), 'Sonnet 5');
  const off = byAttr(tree, 'data-chip', 'gpt-6.2-sol');
  assert.match(off.props.className, /is-off/);
  assert.match(off.props.title, /Codex is not installed/);
  off.props.onPointerDown({ button: 0, clientX: 0, clientY: 0 });
  assert.equal(Object.keys(listeners).length, 0, 'a greyed chip cannot be dragged');
});

test('the picker footer changes effort and fast and explains unsupported fast mode', async t => {
  const rows = catalog({ opus: { fast: true, efforts: ['low', 'high', 'ultra'] }, 'gpt-6.2-sol': { efforts: ['low', 'high'] }, sonnet: { fastReason: 'unsupported' } });
  const h = dialogHarness(t, seatsInfo({ catalog: rows }));
  const efforts = menu => findAll(menu, node => node.props['data-pop-effort']).map(node => node.props['data-pop-effort']);
  const pop = openMenu(h, 'architect');
  assert.equal(byAttr(byAttr(pop, 'role', 'menu'), 'data-tile-effort'), undefined);
  assert.equal(byAttr(byAttr(pop, 'role', 'menu'), 'role', 'switch'), undefined);
  assert.deepEqual(efforts(pop), ['low', 'high', 'ultra']);
  assert.equal(byAttr(pop, 'data-tile-fast', 'architect').props.disabled, false);
  assert.match(textOf(byAttr(pop, 'data-fast-note')), /billed at a different price \(for example Opus fast\)/);
  byAttr(pop, 'data-pop-effort', 'ultra').props.onClick();
  assert.equal(byAttr(liveMenu(h), 'data-pop-effort', 'ultra').props['aria-pressed'], true);
  assert.match(textOf(byAttr(h.render(), 'data-pick', 'architect')), /ultra/);
  assert.match(textOf(h.render()), /1 unsaved change/);
  assert.match(byAttr(h.render(), 'data-save').props.className, /is-primary/);
  assert.deepEqual(efforts(openMenu(h, 'developer')), ['low', 'high']);
  byAttr(liveMenu(h), 'data-tile-fast', 'developer').props.onClick();
  assert.equal(byAttr(liveMenu(h), 'data-tile-fast', 'developer').props['aria-checked'], false);
  const designer = openMenu(h, 'designer');
  const fresh = byAttr(designer, 'data-fresh', 'designer');
  assert.equal(fresh.props['aria-checked'], false);
  fresh.props.onClick();
  assert.match(textOf(byAttr(h.render(), 'data-pick', 'designer')), /Fresh instance/);
  const fast = byAttr(designer, 'data-tile-fast', 'designer');
  assert.equal(fast.props.disabled, true);
  assert.match(fast.props.title, /does not support fast mode/);
  byAttr(h.render(), 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['project', 'p1', { roles: {
    architect: { model: 'opus', effort: 'ultra' }, developer: { model: 'gpt-6.2-sol', effort: 'high' }, designer: { fresh: true },
  } }, 'at-open']]);
});

test('picker arrows reach provider folds and other models in both directions', t => {
  const h = dialogHarness(t, seatsInfo({ catalog: REAL }));
  const menu = byAttr(openMenu(h, 'architect'), 'role', 'menu');
  const rows = findAll(menu, node => ['menuitem', 'menuitemradio'].includes(node.props.role));
  const controls = rows.map(row => ({ row, focus() { document.activeElement = this; } }));
  const currentTarget = { querySelectorAll: selector => controls.filter(({ row }) =>
    selector.includes(`[role="${row.props.role}"]`) && !row.props.disabled) };
  for (const attr of ['data-picker-fold', 'data-custom']) {
    const index = controls.findIndex(({ row }) => row.props[attr] !== undefined);
    assert.ok(index > 0);
    const previous = currentTarget.querySelectorAll('[role="menuitemradio"], [role="menuitem"]').filter(item => controls.indexOf(item) < index).at(-1);
    previous.focus();
    menu.props.onKeyDown({ ...keyEvent('ArrowDown'), currentTarget });
    assert.equal(document.activeElement, controls[index]);
    menu.props.onKeyDown({ ...keyEvent('ArrowUp'), currentTarget });
    assert.equal(document.activeElement, previous);
  }
});

test('the model and role menus close on an outside click, on a second click of their button, on ✕ and on Escape', t => {
  const h = dialogHarness(t, seatsInfo());
  const closes = [];
  for (const [kind, attr, open] of [['model', 'data-pick', 'developer'], ['role', 'data-role-more', 'developer']]) {
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
  byAttr(h.render(), 'data-role-more', 'architect').props.onClick(pickButton('architect'));
  assert.match(liveMenu(h).props.className, /is-role/);
});

// ---- second acceptance of layout A: controls must be clickable, nothing that holds a control moves, tile text is 14px, the banner names what the fix prefers ----
test('org chart uses fixture order and gives each seat its own model, effort and fast controls', t => {
  const h = dialogHarness(t, seatsInfo({ catalog: team.catalog }));
  const tree = h.render();
  const owner = byAttr(tree, 'data-owner');
  assert.equal(textOf(find(owner, node => node.type === 'h3')), 'Human / Owner');
  assert.equal(textOf(find(owner, node => node.type === 'p')), 'Goals, budget, major decisions, and final authorization');
  assert.deepEqual(findAll(tree, node => node.props['data-seat']).map(node => node.props['data-seat']), SEATS);
  for (const id of SEATS) {
    const card = byAttr(tree, 'data-seat', id);
    assert.equal(byAttr(card, 'data-pick', id).type, 'button');
    assert.equal(byAttr(card, 'data-role-more', id).type, 'button');
    assert.equal(byAttr(card, 'data-tile-effort', id), undefined);
    const picker = openMenu(h, id);
    assert.ok(byAttr(picker, 'data-tile-effort', id));
    assert.equal(byAttr(picker, 'data-tile-fast', id).type, 'button');
    byAttr(picker, 'data-menu-close').props.onClick();
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
  window.agentrix = { skillSeats: async () => seatsInfo() };
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
  assert.equal(findAll(tree, node => /^activity-routing-row( |$)/.test(node.props.className)).length, 10);
  assert.equal(findAll(tree, node => node.props.className === 'activity-routing-row is-unavailable').length, 9, 'native mode greys every role but the lead');
  const developer = byAttr(tree, 'data-seat', 'developer');
  assert.deepEqual(developer.props.children.slice(0, 3).map(textOf), ['Developer', 'GPT-6.2-Sol', 'high · Fast']);
  tree.props.onClick();
  assert.deepEqual(events, [{ projectId: 'p1', terminalId: 't1' }]);
});

test('routing rows reduce height before using two columns and expand as usage shrinks', async t => {
  let resize, singleHeight = 668;
  const attributes = new Set();
  const observed = new Set(), usage = {}, button = {};
  const pane = {
    children: [usage, button], clientHeight: 708,
    get scrollHeight() {
      const saved = attributes.has('data-compact') ? 100 : attributes.has('data-dense') ? 40 : 0;
      return Math.max(this.clientHeight, singleHeight - saved);
    },
  };
  const rows = {
    closest: selector => selector === '.activity-pane' ? pane : null,
    removeAttribute: name => { attributes.delete(name); },
    toggleAttribute: (name, value) => {
      if (value) attributes.add(name);
      else attributes.delete(name);
      return value;
    },
  };
  const observers = { ResizeObserver: globalThis.ResizeObserver, MutationObserver: globalThis.MutationObserver };
  t.after(() => Object.assign(globalThis, observers));
  globalThis.ResizeObserver = class {
    constructor(callback) { resize = callback; }
    observe(node) { observed.add(node); }
    disconnect() { observed.clear(); }
  };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const h = mount(t, 'RoutingKeyCard.tsx', 'RoutingKeyCard', { terminalId: 't1' });
  window = { agentrix: { skillSeats: async () => seatsInfo() } };
  h.render();
  await settle();
  h.render(tree => { byAttr(tree, 'className', 'activity-routing-rows').props.ref.current = rows; });
  assert.deepEqual([...observed], [pane, usage, button]);
  assert.deepEqual([...attributes], []);
  singleHeight = 748;
  resize();
  assert.deepEqual([...attributes], ['data-dense'], '24px rows still fit in one column');
  singleHeight = 749;
  resize();
  assert.deepEqual([...attributes], ['data-dense', 'data-compact']);
  resize();
  assert.deepEqual([...attributes], ['data-dense', 'data-compact'], 'a two-column layout that fits must stay put');
  singleHeight = 748;
  resize();
  assert.deepEqual([...attributes], ['data-dense']);
  singleHeight = 708;
  resize();
  assert.deepEqual([...attributes], []);
});

test('role drafts follow their sources', () => {
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
  } };
  const roles = seatsLib.draftRoles(info, project);
  const models = seatsLib.resolveDraftSeats(info.defaults, roles, project);
  assert.equal(roles.find(role => role.id === 'x-review').kind, 'reviewer');
  assert.equal(roles.find(role => role.id === 'x-review').fresh, true);
  assert.deepEqual(models['x-ui'], { model: 'opus', effort: 'max' });
});

test('the role library locks only the orchestrator and the editor supports copy and replace', t => {
  const h = dialogHarness(t, seatsInfo());
  byAttr(h.render(), 'data-routing-tab', 'library').props.onClick();
  const tree = h.render();
  assert.equal(byAttr(tree, 'data-toggle-role', 'reviewer').props.disabled, false);
  assert.equal(byAttr(tree, 'data-toggle-role', 'orchestrator').props.disabled, true);
  byAttr(tree, 'data-replace-role', 'reviewer').props.onClick();
  const editor = find(h.render(), node => node.type?.name === 'RoleEditor');
  assert.equal(editor.props.initial.from, 'reviewer');
  assert.equal(editor.props.id, 'x-reviewer-1');
  assert.equal(editor.props.replace, 'reviewer');
  editor.props.save(editor.props.id, { ...editor.props.initial, name: 'Review copy' });
  const next = h.render();
  assert.equal(byAttr(next, 'data-toggle-role', 'reviewer').props.disabled, false);
  assert.equal(byAttr(next, 'data-toggle-role', 'x-reviewer-1').props.disabled, false);
});

for (const action of ['disable', 'delete', 'replace']) test(`role menu ${action} keeps Escape and the Tab trap after removing the card`, t => {
  const custom = action === 'delete' ? { 'x-build': { from: 'developer', name: 'Builder', duty: 'Build features' } } : null;
  const id = custom ? 'x-build' : 'designer';
  const h = dialogHarness(t, seatsInfo({ project: custom }));
  const focusable = () => ({ isConnected: true, getClientRects: () => [true], focus() {
    document.activeElement = this.isConnected ? this : document.body;
  } });
  document.body = {};
  const first = focusable(), teamTab = focusable(), opener = { ...focusable(), ...pickButton(id).currentTarget, focus: focusable().focus };
  const panel = { ...focusable(), contains: node => [first, teamTab, opener].includes(node), querySelectorAll: () => [first, teamTab],
    querySelector: () => teamTab };
  const dialog = tree => byAttr(tree, 'aria-labelledby', 'seats-title');
  const initial = h.render(tree => { dialog(tree).props.ref.current = panel; });
  byAttr(initial, 'data-role-more', id).props.onClick({ currentTarget: opener });
  const menu = liveMenu(h);
  if (action === 'replace') {
    byAttr(menu, 'data-replace-role', id).props.onClick();
    assert.equal(document.activeElement, opener);
    const editor = find(h.render(), node => node.type?.name === 'RoleEditor');
    editor.props.save(editor.props.id, editor.props.initial);
  } else if (action === 'delete') {
    find(menu, node => node.type === 'button' && textOf(node) === 'Delete role').props.onClick();
  } else byAttr(menu, 'data-toggle-role', id).props.onClick();
  const next = h.render(() => {
    opener.isConnected = false;
    if (document.activeElement === opener) document.activeElement = document.body;
  });
  assert.equal(byAttr(next, 'data-seat', id), undefined);
  assert.equal(document.activeElement, action === 'replace' ? panel : teamTab);
  teamTab.focus();
  dialog(next).props.onKeyDown(keyEvent('Tab'));
  assert.equal(document.activeElement, first);
  dialog(next).props.onKeyDown(keyEvent('Escape'));
  assert.ok(byAttr(h.render(), 'role', 'alertdialog'));
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
  const checkCreate = tree => {
    const button = byAttr(tree, 'data-save');
    assert.equal(textOf(button), 'Create project configuration');
    assert.match(textOf(byAttr(tree, 'id', button.props['aria-describedby'])), /Creates \.agentrix\/routing\.json/);
  };
  checkCreate(h.render());
  byAttr(h.render(), 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['project', 'p1', { roles: {} }, null]]);
  h.deliver({ ...info, routing: source({ digest: 'other', state: 'pending', actions: ['keep'] }) });
  await settle();
  assert.ok(byAttr(h.render(), 'data-routing-review', 'pending'));
  byAttr(h.render(), 'data-now').props.onClick();
  assert.match(textOf(byAttr(h.render(), 'aria-label', 'This conversation (read-only)')), /Orchestrator/);
});

test('a dirty first project draft still creates a file and SSH explains its local scope in the header', t => {
  const h = dialogHarness(t, seatsInfo({ routing: source({ layer: 'template', state: 'absent', digest: null }) }));
  byAttr(openMenu(h, 'designer'), 'data-assign', 'haiku').props.onClick();
  const dirty = h.render(), save = byAttr(dirty, 'data-save');
  assert.equal(textOf(save), 'Create project configuration');
  assert.match(textOf(byAttr(dirty, 'id', save.props['aria-describedby'])), /Creates \.agentrix\/routing\.json/);
  const remote = dialogHarness(t, seatsInfo({ routing: source({ layer: 'local', state: 'absent', remote: true, digest: null }) }));
  assert.match(textOf(byAttr(remote.render(), 'data-scope', 'project')), /SSH \(local settings\)/);
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
  const fresh = find(tree, node => node.type === 'input' && node.props.type === 'checkbox' && !node.props.disabled && node.props.checked && node !== find(tree, item => item.type === 'input' && item.props.type === 'checkbox'));
  assert.ok(fresh, 'a reviewer copy starts as a fresh instance and the choice stays editable');
  change(byAttr(tree, 'data-role-text', 'duty'), 'Review code');
  tree = handle.render();
  assert.equal(byAttr(tree, 'data-save-role').props.disabled, false);
  byAttr(tree, 'data-save-role').props.onClick();
  assert.equal(saves[0][0], 'x-reviewer-2');
  assert.equal(saves[0][1].from, 'reviewer');
  assert.equal(saves[0][1].model, undefined);
});

test('the role editor scrim confirms discarding typed changes and keeps the draft on Escape', t => {
  let closed = 0;
  dialogHarness(t, seatsInfo());
  const roles = team.roles.map(role => shipped(role));
  const editor = mount(t, 'RoleEditor.tsx', 'RoleEditor', {
    id: 'x-developer-1', initial: { from: 'developer', name: 'Role', duty: 'Build' },
    roles, catalog: catalog(), models: DEFAULTS, taken: [],
    save: () => assert.fail('scrim saved a role'), close: () => { closed++; }, copy: () => {},
  });
  const scrim = tree => tree.props.onMouseDown({ target: document.body, currentTarget: document.body, preventDefault() {} });
  let tree = editor.render();
  byAttr(tree, 'data-role-text', 'duty').props.onChange({ target: { value: 'Build the app' } });
  scrim(editor.render());
  tree = editor.render();
  assert.equal(closed, 0);
  assert.equal(byAttr(tree, 'role', 'alertdialog').props['aria-label'], 'Discard unsaved changes?');
  byAttr(tree, 'aria-labelledby', 'role-editor-title').props.onKeyDown(keyEvent('Escape'));
  tree = editor.render();
  assert.equal(byAttr(tree, 'role', 'alertdialog'), undefined);
  assert.equal(byAttr(tree, 'data-role-text', 'duty').props.value, 'Build the app');
  scrim(tree);
  const prompt = byAttr(editor.render(), 'role', 'alertdialog');
  find(prompt, node => node.type === 'button' && textOf(node) === en['放弃修改']).props.onClick();
  assert.equal(closed, 1);
});

test('the routing key refreshes accepted roles and shows the lead the conversation runs now', async t => {
  const lead = shipped(team.roles.find(role => role.id === 'orchestrator'));
  const roles = [lead, ...Array.from({ length: 15 }, (_, index) => ({
    id: 'x-role-' + index, name: 'Saved ' + index, enabled: true, source: 'custom',
  }))];
  const saved = { model: 'gpt-6.2-sol', effort: 'medium', fast: true };
  const effective = Object.fromEntries(roles.map(role => [role.id, saved]));
  const initial = seatsInfo({ current: DEFAULTS, currentRoles: team.roles.map(role => shipped(role)) });
  let info = initial, notify;
  globalThis.window = { agentrix: { skillSeats: async () => info, onSkills: listener => { notify = listener; } } };
  const handle = mount(t, 'RoutingKeyCard.tsx', 'RoutingKeyCard', { projectId: 'p1', terminalId: 't1' }, {});
  handle.render();
  await settle();
  assert.equal(byAttr(handle.render(), 'data-seat', 'x-role-0'), undefined);
  assert.doesNotMatch(textOf(handle.render()), /after restart/i);
  info = { ...initial, effective, roles: [...roles, { id: 'x-off', enabled: false }],
    routing: source({ state: 'pending' }) };
  notify();
  await settle();
  const tree = handle.render();
  assert.equal(findAll(tree, node => node.props['data-seat']).length, 16);
  assert.equal(byAttr(tree, 'data-seat', 'x-off'), undefined);
  assert.match(textOf(byAttr(tree, 'data-seat', 'x-role-0')), /Saved 0GPT-6\.2-Solmedium · Fast/i);
  assert.match(textOf(byAttr(tree, 'data-seat', 'orchestrator')), /Orchestrator AgentOpushigh/i);
  assert.doesNotMatch(textOf(tree), /after restart/i);
  assert.match(tree.props['aria-label'], /needs review/);
});

test('the conversation box uses accepted settings across drafts and never asks for a restart', async t => {
  const info = seatsInfo({ project: { orchestrator: { model: 'gpt-6.2-sol', effort: 'medium', fast: true }, architect: { model: 'sonnet', effort: 'medium' } },
    current: DEFAULTS, currentRoles: team.roles.map(role => shipped(role)) });
  const h = dialogHarness(t, info, { language: 'zh' });
  byAttr(openMenu(h, 'architect'), 'data-assign', 'haiku').props.onClick();
  byAttr(h.render(), 'data-now').props.onClick();
  const choices = byAttr(h.render(), 'aria-label', '本次对话（只读）');
  assert.match(textOf(byAttr(choices, 'data-current-seat', 'architect')), /Sonnet · medium/);
  assert.doesNotMatch(textOf(choices), /Haiku|→/);
  assert.match(textOf(byAttr(choices, 'data-current-seat', 'orchestrator')), /Opus · high/);
  assert.doesNotMatch(textOf(h.render()), /重启后生效/);
  byAttr(h.render(), 'data-save').props.onClick();
  await settle();
  const notice = byAttr(h.render(), 'data-routing-status');
  assert.equal(textOf(notice), '✓已保存，立即生效');
});

test('the role library and Developer specialties use the supplied labels and duties', t => {
  const roles = [...team.roles.map(role => shipped(role)),
    { ...shipped({ id: 'ai', name: '人工智能', duty: '模型接入', detail: '主进程提供的模型职责', outputs: '' }, 'library'), kind: 'author' },
    shipped({ id: 'a11y', name: '无障碍', duty: '无障碍验证', detail: '主进程提供的无障碍职责', outputs: '' }, 'library'),
  ];
  const h = dialogHarness(t, seatsInfo({ roles }), { language: 'zh' });
  const chart = h.render();
  assert.deepEqual(findAll(chart, node => node.props.role === 'tab').map(node => node.props['data-routing-tab']), ['team', 'library']);
  const developer = byAttr(chart, 'data-seat', 'developer');
  const specialty = byAttr(developer, 'className', 'seats-tag');
  assert.match(specialty.props['aria-label'], /人工智能/);
  assert.equal(specialty.props.tabIndex, 0);
  const details = findAll(developer, node => node.type === 'p' && node.props['data-role-detail']);
  assert.equal(details.length, 2);
  for (const detail of details) {
    assert.equal(detail.props['aria-label'], textOf(detail));
    assert.equal(detail.props.tabIndex, 0);
  }
  assert.doesNotMatch(textOf(developer), /\bAI\b/);
  byAttr(h.render(), 'data-routing-tab', 'library').props.onClick();
  const library = h.render();
  assert.match(textOf(byAttr(library, 'data-library-role', 'ai')), /人工智能.*主进程提供的模型职责/);
  assert.match(textOf(byAttr(library, 'data-library-role', 'a11y')), /无障碍.*主进程提供的无障碍职责/);
});

test('English counts one specialty and multiple specialties with the right inflection', t => {
  const specialist = id => ({ ...shipped({ id, name: id, duty: '', detail: '', outputs: '' }, 'library'), kind: 'author' });
  const defaults = team.roles.map(role => shipped(role));
  for (const count of [1, 2]) {
    const roles = [...defaults, ...['frontend', 'backend'].slice(0, count).map(specialist)];
    const h = dialogHarness(t, seatsInfo({ roles }));
    const card = byAttr(h.render(), 'data-seat', 'developer');
    assert.equal(textOf(byAttr(card, 'className', 'seats-tag')), count === 1 ? '1 specialty' : '2 specialties');
  }
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

test('the library displays both limits and the orchestrator lock beside their controls', t => {
  const custom = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [
    'x-dev-' + i, { from: 'developer', name: 'Extra ' + i, duty: 'Develop', enabled: i < 6 },
  ]));
  const libraryRole = shipped({ id: 'a11y', name: '无障碍', duty: '无障碍验证', detail: '', outputs: '' }, 'library');
  const info = seatsInfo({ roles: [...team.roles.map(role => shipped(role)), libraryRole], config: { roles: custom } });
  const h = dialogHarness(t, info, { language: 'zh' });
  const teamChart = h.render();
  assert.equal(byAttr(openMenu(h, 'reviewer'), 'data-role-lock', 'fresh'), undefined);
  assert.match(textOf(byAttr(teamChart, 'data-scope', 'project')), /本项目 \.agentrix\/routing\.json/);
  byAttr(teamChart, 'data-routing-tab', 'library').props.onClick();
  const library = h.render();
  assert.match(textOf(byAttr(library, 'data-role-limit', 'enabled')), /已启用 16 个角色（上限 16）；停用一个后才能再启用/);
  assert.match(textOf(byAttr(library, 'data-role-limit', 'custom')), /已创建 8 个项目角色/);
  assert.equal(byAttr(library, 'data-new-role').props.disabled, true);
  const join = byAttr(library, 'data-toggle-role', 'a11y');
  assert.equal(textOf(join), '加入团队');
  assert.equal(join.props.disabled, true);
  assert.match(textOf(byAttr(library, 'id', join.props['aria-describedby'])), /停用一个后才能再启用/);
  assert.equal(textOf(byAttr(library, 'data-toggle-role', 'developer')), '移出团队');
  for (const [id, reason] of [['orchestrator', /总指挥必须保留/]]) {
    const card = byAttr(library, 'data-library-role', id);
    const actions = find(card, node => node.props.className === 'seats-role-actions');
    const children = React.Children.toArray(actions.props.children)
      .flatMap(node => node.type === React.Fragment ? React.Children.toArray(node.props.children) : node);
    assert.ok(children.some(node => node.props['data-edit-role'] === id));
    assert.equal(children.find(node => node.props['data-toggle-role'] === id).props.disabled, true);
    assert.match(textOf(byAttr(card, 'data-role-lock', 'membership')), reason);
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
  const config = { roles: { a11y: { fresh: false }, frontend: { enabled: true } } };
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

test('pending and invalid project files replace the saved status and show the template label once', async t => {
  const info = seatsInfo({ routing: source({ layer: 'template', state: 'pending', actions: ['apply', 'keep'] }) });
  const h = dialogHarness(t, info, { language: 'zh' });
  const check = (tree, status) => {
    const row = find(tree, node => node.props.className === 'seats-head');
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
  const notice = byAttr(h.render(), 'data-routing-status');
  assert.equal(textOf(notice), '✓Saved. Takes effect immediately.');
  byAttr(h.render(), 'data-now').props.onClick();
  assert.match(textOf(byAttr(h.render(), 'data-current-seat', 'architect')), /Sonnet · medium/);
});
