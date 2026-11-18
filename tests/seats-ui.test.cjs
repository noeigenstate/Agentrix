const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const seatsLib = require('../src/features/agents/skill-seats.ts');
const { paletteGroups, lineOf, shortLabel, pickFix, menuPlacement, topAlternatives, withInstalled, canonicalModel, sameModel, assignModel, assignCustom, rankByName, rowFor, issuesOf, ageOf, swapSlots, setEffort, setFast, reviewerBlock, firstRefusal, scopePayload, changedCount, baselineFor, lowerLayer, startScope, fallbackFor, saveSeats } = seatsLib;

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
const SEATS = team.seats;
const clone = value => JSON.parse(JSON.stringify(value));
function seatsInfo(overrides = {}) {
  const info = { skill: 'model-routing', seats: SEATS, roles: team.roles, lead: 'orchestrator', authors: ['developer'], leadAgent: 'claude', leads: { claude: DEFAULTS.orchestrator, codex: DEFAULTS.developer }, fresh: ['qa', 'reviewer'], defaults: clone(DEFAULTS), global: {}, project: null, effective: clone(DEFAULTS), current: null,
    catalog: catalog(), installed: { claude: true, codex: true }, ...overrides };
  return info;
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

test('the saved payload contains only the seat overrides for the current scope', () => {
  const orchestration = { model: 'gpt-6.2-sol', effort: 'high', fast: true };
  const global = { reviewer: { model: 'sonnet', effort: 'low' } }, project = { architect: { model: 'opus', effort: 'max' } };
  const info = seatsInfo({ global, project });
  const baseline = baselineFor(info, 'project');
  const working = { ...baseline, orchestrator: orchestration };
  assert.equal(startScope(info, 'p1'), 'project');
  assert.deepEqual(baseline.architect, project.architect);
  assert.deepEqual(baseline.reviewer, global.reviewer);
  assert.deepEqual(scopePayload(working, lowerLayer(info, 'project')), { orchestrator: orchestration, ...project });
  assert.equal(changedCount(SEATS, working, baseline), 1);
});

test('saving sends the chosen scope with the edited map, a project id only for the project scope, and returns main’s refusal as text', async () => {
  const calls = [], working = { ...clone(DEFAULTS), architect: { model: 'sonnet', effort: 'low' } };
  const api = { setSkillSeats: async (...args) => { calls.push(args); return { ok: true }; } };
  assert.deepEqual(await saveSeats(api, 'project', 'p1', working, DEFAULTS), { ok: true });
  assert.deepEqual(await saveSeats(api, 'global', 'p1', working, DEFAULTS), { ok: true });
  assert.deepEqual(calls, [['project', 'p1', { architect: { model: 'sonnet', effort: 'low' } }], ['global', null, { architect: { model: 'sonnet', effort: 'low' } }]]);
  const refused = await saveSeats({ setSkillSeats: async () => ({ ok: false, code: 'reviewer-same-model', seat: 'reviewer', message: 'Choose a different reviewer.' }) }, 'global', null, working, DEFAULTS);
  assert.deepEqual(refused, { ok: false, message: 'Choose a different reviewer.' });
  assert.deepEqual(await saveSeats({ setSkillSeats: async () => { throw new Error('ipc closed'); } }, 'global', null, working, DEFAULTS), { ok: false, message: 'ipc closed' });
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
    if (name === '../../shared/i18n') return { currentLanguage: () => 'en', t: (text, values = {}) => (en[text] ?? text).replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match) };
    if (name === './skill-seats') return seatsLib;
    if (name === '../../shared/routing-command.ts') return { OPEN_SEATS: 'agentrix:open-seats',
      routingModelName: require('../src/shared/routing-command.ts').routingModelName,
      routingRoleName: text => en['席位 · ' + text] ?? en[text] ?? text,
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
  const handle = { props, render() { cursor = 0; const tree = component(handle.props); while (effects.length) effects.shift()(); return tree; }, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
  t.after(() => { handle.unmount(); globalThis.window = previous.window; globalThis.document = previous.document; });
  return handle;
}
const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach(child => walk(child, visit));
  if (!node || typeof node !== 'object' || !node.props) return;
  visit(node);
  walk(node.props.children, visit);
};
const findAll = (tree, test) => { const found = []; walk(tree, node => { if (test(node)) found.push(node); }); return found; };
const find = (tree, test) => findAll(tree, test)[0];
const byAttr = (tree, attr, value) => find(tree, node => value === undefined ? node.props[attr] !== undefined : node.props[attr] === value);
const textOf = node => { let text = ''; const add = child => { if (typeof child === 'string' || typeof child === 'number') text += child; else if (Array.isArray(child)) child.forEach(add); else if (child?.props) add(child.props.children); }; add(node); return text; };
const pickButton = (slot) => ({ detail: 0, currentTarget: { getBoundingClientRect: () => ({ left: 100, top: 168, bottom: 200 }), focus() {} }, slot });
const settle = async () => { for (let turn = 0; turn < 6; turn++) await null; };

function dialogHarness(t, info, props = {}) {
  const calls = [], closed = [], refreshes = [];
  const api = { setSkillSeats: async (...args) => { calls.push(args); return props.reply ?? { ok: true }; },
    skillSeatsRefresh: async (...args) => { refreshes.push(args); if (props.refreshError) throw new Error(props.refreshError); return props.refreshed ?? null; } };
  globalThis.window = { agentrix: api, innerWidth: 1280, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
  const listeners = [];
  globalThis.document = { activeElement: null, elementFromPoint: () => null, addEventListener: (type, fn) => listeners.push([type, fn]), removeEventListener: (type, fn) => { const at = listeners.findIndex(entry => entry[0] === type && entry[1] === fn); if (at >= 0) listeners.splice(at, 1); } };
  const h = mount(t, 'SeatsDialog.tsx', 'SeatsDialog', { info, projectId: 'p1', terminalId: 't1', onClose: () => closed.push(true), ...props.dialog });
  return Object.assign(h, { calls, closed, refreshes, outsideMouseDown: target => listeners.filter(entry => entry[0] === 'mousedown').forEach(entry => entry[1]({ target })) });
}
const keyEvent = key => ({ key, stopPropagation() {}, preventDefault() {} });

test('the dialog saves the chosen scope and the edited map; the keyboard 更换 menu assigns a model, effort and fast', async t => {
  const h = dialogHarness(t, seatsInfo({ project: null }));
  let tree = h.render();
  assert.ok(byAttr(tree, 'data-save').props.disabled, '保存 waits for a change');
  assert.equal(textOf(byAttr(tree, 'data-save')), 'Save');
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
  assert.deepEqual(h.calls, [['global', null, { architect: { model: 'gpt-6.2-sol', effort: 'xhigh', fast: false } }]], 'the global scope carries only the changed seat');
  tree = h.render();
  assert.match(textOf(find(tree, node => node.props.role === 'status')), /Saved\. It applies from the next conversation/);
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
  assert.deepEqual(h.calls, [['global', null, {}]], 'an empty map clears the global scope');
  const project = dialogHarness(t, seatsInfo());
  tree = project.render();
  find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Scope of the setting').props.onChange({ target: { value: 'project' } });
  byAttr(project.render(), 'data-pick', 'researcher').props.onClick(pickButton('researcher'));
  byAttr(find(project.render(), node => node.props.role === 'menu'), 'data-assign', 'haiku').props.onClick();
  byAttr(project.render(), 'data-save').props.onClick();
  await settle();
  assert.deepEqual(project.calls, [['project', 'p1', { researcher: { model: 'haiku', effort: 'high' } }]]);
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
  assert.match(textOf(find(tree, node => node.props.className?.includes('seats-now is-diff'))), /Architect\s*Sonnet · low → Opus · high/, 'a seat that differs from this conversation shows both');
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

test('the chart has three columns and uses static depth with pointer-transparent links', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/seats-dialog.css'), 'utf8');
  assert.match(css, /\.seats-team-grid \{[^}]*grid-template-columns: repeat\(3,/);
  assert.match(css, /\.seats-chart-link, \.seats-chart-bus \{[^}]*pointer-events: none/);
  assert.doesNotMatch(css, /@keyframes|animation:/);
});

test('switching the scope keeps only the slots edited in this dialog: untouched project overrides never reach global', async t => {
  const info = seatsInfo({ project: { developer: { model: 'opus', effort: 'max' }, designer: { model: 'haiku', effort: 'low' } } });
  const h = dialogHarness(t, info);
  let tree = h.render();
  assert.equal(find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Scope of the setting').props.value, 'project');
  byAttr(tree, 'data-pick', 'researcher').props.onClick(pickButton('researcher'));
  byAttr(find(h.render(), node => node.props.role === 'menu'), 'data-assign', 'haiku').props.onClick();
  tree = h.render();
  find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Scope of the setting').props.onChange({ target: { value: 'global' } });
  tree = h.render();
  assert.match(textOf(tree), /Unsaved draft · 1 seats changed/, 'the count is against the global baseline: the project overrides are not counted');
  byAttr(tree, 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['global', null, { researcher: { model: 'haiku', effort: 'high' } }]], 'the project’s developer and designer overrides stay in the project');
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

test('a scope switch never carries the old scope’s saved seats over the new scope’s own override', async t => {
  const info = seatsInfo({ global: { developer: { model: 'opus', effort: 'low' } }, project: { developer: { model: 'haiku', effort: 'low' } } });
  info.effective = { ...info.defaults, ...info.global, ...info.project };
  const h = dialogHarness(t, info);
  const scopeSelect = tree => find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Scope of the setting');
  scopeSelect(h.render()).props.onChange({ target: { value: 'global' } });
  byAttr(h.render(), 'data-pick', 'architect').props.onClick(pickButton('architect'));
  byAttr(find(h.render(), node => node.props.role === 'menu'), 'data-assign', 'sonnet').props.onClick();
  scopeSelect(h.render()).props.onChange({ target: { value: 'project' } });
  byAttr(h.render(), 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['project', 'p1', { developer: { model: 'haiku', effort: 'low' }, architect: { model: 'sonnet', effort: 'high' } }]], 'the project keeps its own developer override');
});

test('Escape on the discard banner means keep editing and moves focus to it; it never discards', t => {
  const h = dialogHarness(t, seatsInfo());
  byAttr(h.render(), 'data-pick', 'researcher').props.onClick(pickButton('researcher'));
  byAttr(find(h.render(), node => node.props.role === 'menu'), 'data-assign', 'haiku').props.onClick();
  byAttr(h.render(), 'aria-label', 'Close').props.onClick();
  h.render();
  const tree = h.render();
  assert.ok(find(tree, node => node.props.role === 'alertdialog'));
  find(tree, node => node.props.role === 'dialog').props.onKeyDown(keyEvent('Escape'));
  assert.deepEqual(h.closed, []);
  const after = h.render();
  assert.equal(find(after, node => node.props.role === 'alertdialog'), undefined, 'the banner is dismissed');
  assert.match(textOf(after), /Unsaved draft · 1 seats changed/, 'the draft is kept');
});

// ---- catalog-driven dialog (round cat-r1): the menu follows each row, a typed-in id is accepted by the helper's syntax, the lists can be refreshed ----
const openMenu = (h, slot) => { byAttr(h.render(), 'data-pick', slot).props.onClick(pickButton(slot)); return find(h.render(), node => node.props.role === 'menu'); };
const optionValues = select => findAll(select, node => node.type === 'option').map(node => node.props.value);
const assignable = menu => findAll(menu, node => node.props.role === 'menuitemradio').map(node => node.props['data-assign']);
const liveMenu = h => find(h.render(), node => node.props.role === 'menu');
const typeCustom = (h, text) => byAttr(liveMenu(h), 'data-custom-input').props.onChange({ target: { value: text } });
const applyCustom = h => byAttr(liveMenu(h), 'data-custom-apply').props.onClick();

test('the rank rule in the dialog mirrors the shared fixture list that the catalog builder is tested against', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/seat-ranks.json'), 'utf8'));
  for (const name of ['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-haiku-5-5', 'gpt-6.2-sol', 'gpt-6.2-sol', 'gpt-6.2-sol-mini', 'gpt-6.1-nano']) assert.ok(fixture.some(entry => entry.model === name), `${name} is in the fixture`);
  assert.ok(fixture.some(entry => !/opus|sonnet|haiku|sol|nano|mini|lite/.test(entry.model)), 'the fixture holds an unknown id');
  for (const { model, rank } of fixture) assert.equal(rankByName(model), rank, `${model} ranks ${rank}`);
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
  assert.deepEqual(h.calls, [['global', null, { developer: { model: 'gpt-6.3-sol', effort: 'high', fast: true } }]]);
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

function reviewerSameButAllowed(map, rows) { return seatsLib.reviewerSameButAllowed(map, rows); }

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

// ---- second acceptance round: no tile overlaps another, small-tile chips shorten and ellipsize, the one-click fix is chosen by rule ----

test('a small tile shows a shorter alias name and ends a long one in an ellipsis; the full text stays in the title, the tray and the menu', t => {
  assert.equal(shortLabel('Opus (follows latest)'), 'Opus (latest)');
  assert.equal(shortLabel('GPT-6.2-Sol'), 'GPT-6.2-Sol');
  const rows = catalog({ opus: { label: 'Opus (follows latest)' } });
  const h = dialogHarness(t, seatsInfo({ catalog: rows }));
  const tree = h.render();
  const slot = byAttr(tree, 'data-slot', 'architect');
  const gem = find(slot, node => node.props.className?.startsWith('seats-gem'));
  assert.equal(textOf(find(gem, node => node.props.className === 'seats-gem-name')), 'Opus (latest)');
  assert.match(gem.props.title, /Opus \(follows latest\)/, 'the tooltip has the full name');
  assert.match(byAttr(tree, 'data-chip', 'opus').props.title, /Opus \(follows latest\)/, 'the panel chip keeps the full name in its title');
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
  assert.equal(pickFix([], map, rows), null);
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
  assert.deepEqual(h.calls, [['global', null, { architect: { model: 'opus', effort: 'ultra' }, developer: { model: 'gpt-6.2-sol', effort: 'high', fast: false } }]], 'the tile controls are saved like the menu’s');
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
  assert.ok(byAttr(tree, 'data-owner'));
  assert.deepEqual(findAll(tree, node => node.props['data-seat']).map(node => node.props['data-seat']), SEATS);
  for (const id of SEATS) {
    const card = byAttr(tree, 'data-seat', id);
    for (const attr of ['data-pick', 'data-tile-effort', 'data-tile-fast']) {
      assert.equal(byAttr(card, attr, id).type, 'button');
    }
  }
});

test('a repeated migration notice is not shown after acknowledgement in the same dialog', async t => {
  const migration = 'The original Claude lead became the orchestrator';
  const h = dialogHarness(t, seatsInfo({ migrated: migration }), { refreshed: seatsInfo({ migrated: migration }) });
  assert.match(textOf(byAttr(h.render(), 'data-migrated')), /The original Claude lead/);
  const dismiss = find(byAttr(h.render(), 'data-migrated'), node => node.type === 'button');
  dismiss.props.onClick(); await settle();
  assert.equal(byAttr(h.render(), 'data-migrated'), undefined);
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
  assert.deepEqual(findAll(tree, node => node.props['data-seat']).map(node => node.props['data-seat']), SEATS);
  tree.props.onClick();
  assert.deepEqual(events, [{ projectId: 'p1', terminalId: 't1' }]);
});
