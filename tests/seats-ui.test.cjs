const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const seatsLib = require('../src/features/agents/skill-seats.ts');
const { sceneScale, menuPlacement, topAlternatives, withInstalled, canonicalModel, sameModel, assignModel, assignCustom, rankByName, rowFor, issuesOf, ageOf, swapSlots, setEffort, setFast, reviewerBlock, firstRefusal, scopePayload, changedCount, mergeSeats, baselineFor, lowerLayer, startScope, fallbackFor, saveSeats } = seatsLib;

const en = require('../electron/locales/en.json');
const additions = path.join(__dirname, '../locale-additions-cat.json');
if (fs.existsSync(additions)) Object.assign(en, JSON.parse(fs.readFileSync(additions, 'utf8')));

// ---- fixtures: the catalog and defaults main sends (model-seats.cjs: opus = sol = 3, sonnet 2, haiku 1) ----
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'], GPT_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const row = (model, label, family, rank, extra = {}) => ({ model, label, family, efforts: family === 'claude' ? CLAUDE_EFFORTS : GPT_EFFORTS, fast: family === 'codex', rank, available: true, ...extra });
const catalog = (overrides = {}) => [row('opus', 'Opus', 'claude', 3), row('sonnet', 'Sonnet', 'claude', 2), row('haiku', 'Haiku', 'claude', 1), row('gpt-6.1-sol', 'GPT-6.1-Sol', 'codex', 3)]
  .map(entry => ({ ...entry, ...overrides[entry.model] }));
const DEFAULTS = {
  lead: { claude: { model: 'opus', effort: 'high' }, codex: { model: 'gpt-6.1-sol', effort: 'high', fast: true } },
  architect: { model: 'opus', effort: 'high' }, core: { model: 'gpt-6.1-sol', effort: 'high', fast: true }, execution: { model: 'sonnet', effort: 'high' },
  visual: { model: 'sonnet', effort: 'high' }, lookup: { model: 'haiku', effort: 'high' }, reviewer: { model: 'opus', effort: 'high' },
};
const SEATS = ['lead', 'architect', 'core', 'execution', 'visual', 'lookup', 'reviewer'];
const clone = value => JSON.parse(JSON.stringify(value));
function seatsInfo(overrides = {}) {
  const info = { skill: 'model-routing', seats: SEATS, fresh: ['visual', 'reviewer'], defaults: clone(DEFAULTS), global: {}, project: null, effective: clone(DEFAULTS), current: null,
    catalog: catalog(), installed: { claude: true, codex: true }, ...overrides };
  return info;
}

test('the mirror holds a reviewer to the rank rule: refused only while another available model at least as strong exists', () => {
  const same = { ...clone(DEFAULTS), core: { model: 'opus', effort: 'high' } };
  const block = reviewerBlock(same, catalog());
  assert.deepEqual(block.hit, ['core'], 'the reviewer runs the core seat’s model');
  assert.deepEqual(block.alternatives.map(entry => entry.model), ['gpt-6.1-sol'], 'sonnet is weaker and does not count');
  assert.equal(block.fix.model, 'gpt-6.1-sol', 'the one-click fix is a model no author seat runs');
  assert.equal(firstRefusal(same, catalog()).code, 'reviewer-same-model');
  const single = catalog({ 'gpt-6.1-sol': { available: false, reason: 'Codex is not installed.' }, sonnet: { available: false, reason: 'off' }, haiku: { available: false, reason: 'off' } });
  assert.equal(reviewerBlock(same, single), null, 'a single-model setup may keep the same model');
  assert.equal(firstRefusal(same, single), null);
  const sonnet = { ...clone(DEFAULTS), execution: { model: 'sonnet', effort: 'high' }, reviewer: { model: 'sonnet', effort: 'high' } };
  assert.ok(reviewerBlock(sonnet, catalog()), 'sonnet has opus and sol above it');
  assert.equal(reviewerBlock(clone(DEFAULTS), catalog()), null, 'the defaults pass');
  assert.equal(reviewerBlock({ ...same, reviewer: { model: 'opus', effort: 'high' } }, catalog({ 'gpt-6.1-sol': { available: false } })), null, 'an alternative that is not available does not count');
  assert.equal(reviewerBlock({ ...same, reviewer: { model: 'unlisted-gpt', effort: 'high' }, core: { model: 'unlisted-gpt', effort: 'high' } }, catalog())?.fix.model, 'opus', 'an unlisted GPT id ranks 3, as main ranks it');
});

test('the mirror keeps fast to GPT seats, a lead slot to its own family and an effort inside its family', () => {
  const map = clone(DEFAULTS);
  assert.deepEqual(setFast(map, 'execution', true, catalog()), { ok: false, reason: 'fast' }, 'fast on a Claude seat is refused');
  assert.equal(setFast(map, 'core', false, catalog()).map.core.fast, false);
  assert.deepEqual(setEffort(map, 'core', 'max', catalog()), { ok: false, reason: 'effort' }, 'GPT has no max');
  assert.equal(setEffort(map, 'architect', 'max', catalog()).map.architect.effort, 'max');
  assert.deepEqual(assignModel(map, 'lead.codex', 'opus', catalog()), { ok: false, reason: 'family' });
  assert.deepEqual(assignModel(map, 'lead.claude', 'gpt-6.1-sol', catalog()), { ok: false, reason: 'family' });
  assert.deepEqual(swapSlots(map, 'lead.claude', 'lead.codex', catalog()), { ok: false, reason: 'family' }, 'the two lead slots cannot trade');
  assert.equal(firstRefusal({ ...map, execution: { model: 'sonnet', effort: 'high', fast: true } }, catalog()).code, 'fast-not-allowed');
  assert.equal(firstRefusal({ ...map, lead: { ...map.lead, codex: { model: 'opus', effort: 'high' } } }, catalog()).code, 'lead-family');
  assert.equal(firstRefusal({ ...map, core: { model: 'gpt-6.1-sol', effort: 'max' } }, catalog()).code, 'invalid-effort');
});

test('assigning and swapping keep the settings a model can use and drop the ones it cannot', () => {
  const map = clone(DEFAULTS);
  const toClaude = assignModel(map, 'core', 'sonnet', catalog());
  assert.deepEqual(toClaude.map.core, { model: 'sonnet', effort: 'high' }, 'a Claude model takes no fast flag');
  const toGpt = assignModel({ ...map, execution: { model: 'sonnet', effort: 'max' } }, 'execution', 'gpt-6.1-sol', catalog());
  assert.deepEqual(toGpt.map.execution, { model: 'gpt-6.1-sol', effort: 'high', fast: true }, 'max is not a GPT effort; a new GPT seat starts fast');
  assert.deepEqual(assignModel(map, 'core', 'gpt-6.1-sol', catalog()), { ok: false, reason: 'same' });
  assert.deepEqual(assignModel(map, 'core', 'nope', catalog()), { ok: false, reason: 'unknown-model' });
  const swapped = swapSlots({ ...map, execution: { model: 'sonnet', effort: 'max' } }, 'core', 'execution', catalog());
  assert.deepEqual(swapped.map.core, { model: 'sonnet', effort: 'max' }, 'sonnet moves to core with its own settings: no fast flag appears');
  assert.deepEqual(swapped.map.execution, { model: 'gpt-6.1-sol', effort: 'high', fast: true });
  assert.equal(map.core.model, 'gpt-6.1-sol', 'the input map is not mutated');
  assert.deepEqual(swapSlots(map, 'lookup', 'lookup', catalog()), { ok: false, reason: 'same' });
});

test('an unavailable model cannot be placed and its seat shows the default it falls back to', () => {
  const off = catalog({ 'gpt-6.1-sol': { available: false, reason: 'Codex is not installed.' } });
  assert.deepEqual(assignModel(clone(DEFAULTS), 'execution', 'gpt-6.1-sol', off), { ok: false, reason: 'unavailable' });
  const info = seatsInfo({ catalog: off, defaults: { ...clone(DEFAULTS), core: { model: 'opus', effort: 'high' } } });
  const working = { ...clone(DEFAULTS), core: { model: 'gpt-6.1-sol', effort: 'high', fast: true } };
  assert.equal(fallbackFor(info, 'core', working).model, 'opus', 'the seat’s default stands in');
  assert.equal(fallbackFor(info, 'lead.codex', working), null, 'a lead slot has no stand-in: its agent is not installed');
  assert.equal(fallbackFor(info, 'execution', working), null, 'an available model needs none');
});

test('the saved payload is only what differs from the layer under the scope, and the changed count is against the scope’s saved state', () => {
  const info = seatsInfo({ global: { reviewer: { model: 'sonnet', effort: 'low' } }, project: { core: { model: 'opus', effort: 'max' } } });
  assert.deepEqual(baselineFor(info, 'global').reviewer, { model: 'sonnet', effort: 'low' });
  assert.deepEqual(baselineFor(info, 'project').core, { model: 'opus', effort: 'max' });
  assert.deepEqual(baselineFor(info, 'project').reviewer, { model: 'sonnet', effort: 'low' }, 'the project view still carries the global choice');
  assert.deepEqual(lowerLayer(info, 'project').core, DEFAULTS.core, 'a project saves against defaults ← global');
  assert.equal(startScope(info, 'p1'), 'project');
  assert.equal(startScope(info, undefined), 'global');
  assert.equal(startScope(seatsInfo(), 'p1'), 'global');
  const working = { ...baselineFor(info, 'project'), lookup: { model: 'sonnet', effort: 'high' }, lead: { ...DEFAULTS.lead, codex: { model: 'gpt-6.1-sol', effort: 'low', fast: true } } };
  assert.deepEqual(scopePayload(working, lowerLayer(info, 'project')), {
    lead: { codex: { model: 'gpt-6.1-sol', effort: 'low', fast: true } }, core: { model: 'opus', effort: 'max' }, lookup: { model: 'sonnet', effort: 'high' } }, 'the global reviewer choice is not repeated; the lead saves only its changed slot');
  assert.equal(changedCount(SEATS, working, baselineFor(info, 'project')), 2, 'lead and lookup differ from what the project saved; core does not');
  assert.deepEqual(scopePayload(lowerLayer(info, 'project'), lowerLayer(info, 'project')), {}, 'nothing different clears the scope');
  assert.deepEqual(mergeSeats(DEFAULTS, { lead: { codex: { model: 'x', effort: 'low' } } }).lead.claude, DEFAULTS.lead.claude, 'a lead override merges slot by slot');
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
    if (name === '../../shared/i18n') return { t: (text, values = {}) => (en[text] ?? text).replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match) };
    if (name === './skill-seats') return seatsLib;
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
const pickButton = (slot) => ({ currentTarget: { getBoundingClientRect: () => ({ left: 100, top: 168, bottom: 200 }), focus() {} }, slot });
const settle = async () => { for (let turn = 0; turn < 6; turn++) await null; };

function dialogHarness(t, info, props = {}) {
  const calls = [], closed = [], refreshes = [];
  const api = { setSkillSeats: async (...args) => { calls.push(args); return props.reply ?? { ok: true }; },
    skillSeatsRefresh: async (...args) => { refreshes.push(args); if (props.refreshError) throw new Error(props.refreshError); return props.refreshed ?? null; } };
  globalThis.window = { agentrix: api, innerWidth: 1280, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
  globalThis.document = { activeElement: null, elementFromPoint: () => null };
  const h = mount(t, 'SeatsDialog.tsx', 'SeatsDialog', { info, projectId: 'p1', terminalId: 't1', onClose: () => closed.push(true), ...props.dialog });
  return Object.assign(h, { calls, closed, refreshes });
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
  assert.deepEqual(findAll(menu, node => node.props.role === 'menuitemradio').map(node => node.props['data-assign']), ['opus', 'sonnet', 'haiku', 'gpt-6.1-sol']);
  byAttr(menu, 'data-assign', 'gpt-6.1-sol').props.onClick();
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
  assert.deepEqual(h.calls, [['global', null, { architect: { model: 'gpt-6.1-sol', effort: 'xhigh', fast: false } }]], 'the global scope carries only the changed seat');
  tree = h.render();
  assert.match(textOf(find(tree, node => node.props.role === 'status')), /Saved\. It applies from the next conversation/);
});

test('the scope select sends the project id, and 恢复默认 saves an empty map that clears the scope', async t => {
  const info = seatsInfo({ global: { lookup: { model: 'sonnet', effort: 'low' } } });
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
  byAttr(project.render(), 'data-pick', 'lookup').props.onClick(pickButton('lookup'));
  byAttr(find(project.render(), node => node.props.role === 'menu'), 'data-assign', 'sonnet').props.onClick();
  byAttr(project.render(), 'data-save').props.onClick();
  await settle();
  assert.deepEqual(project.calls, [['project', 'p1', { lookup: { model: 'sonnet', effort: 'high' } }]]);
});

test('a blocked reviewer is framed, named 已阻止, explained with a one-click fix and cannot be saved; main’s refusal is shown', async t => {
  const info = seatsInfo({ global: { reviewer: { model: 'gpt-6.1-sol', effort: 'high', fast: true } } });
  const h = dialogHarness(t, info);
  let tree = h.render();
  assert.ok(find(tree, node => node.props.className?.includes('seats-plate is-blocked')), 'the reviewer tile has the red frame');
  assert.match(textOf(tree), /Blocked · same model/);
  const banner = find(tree, node => node.props.role === 'alert');
  assert.match(textOf(banner), /Review \(GPT-6\.1-Sol\) uses the same model as Core engineer, and Opus is also available/);
  assert.equal(byAttr(tree, 'data-save').props.disabled, true, '保存 is disabled');
  assert.match(textOf(tree), /A seat is blocked, so this cannot be saved/);
  const fix = byAttr(tree, 'data-fix');
  assert.equal(textOf(fix), 'Use Opus for review');
  fix.props.onClick();
  tree = h.render();
  assert.equal(find(tree, node => node.props.role === 'alert'), undefined, 'the fix clears the block');
  assert.equal(byAttr(tree, 'data-save').props.disabled, false);
  // Main can still refuse (another rule, or a stale catalog): its message is shown and nothing claims to be saved.
  const refused = dialogHarness(t, seatsInfo(), { reply: { ok: false, code: 'invalid-model', seat: 'lookup', message: 'Expected a valid model id.' } });
  tree = refused.render();
  byAttr(tree, 'data-pick', 'lookup').props.onClick(pickButton('lookup'));
  byAttr(find(refused.render(), node => node.props.role === 'menu'), 'data-assign', 'sonnet').props.onClick();
  byAttr(refused.render(), 'data-save').props.onClick();
  await settle();
  assert.match(textOf(find(refused.render(), node => node.props.role === 'status')), /Not saved: Expected a valid model id\./);
});

test('unavailable models are greyed with their reason, cannot be picked, and this conversation’s seats are shown read-only', t => {
  const info = seatsInfo({ catalog: catalog({ 'gpt-6.1-sol': { available: false, reason: 'Codex is not installed.' } }),
    current: { ...clone(DEFAULTS), architect: { model: 'sonnet', effort: 'low' } } });
  const h = dialogHarness(t, info);
  let tree = h.render();
  const gems = findAll(tree, node => node.props.className?.includes('seats-gem is-off'));
  assert.ok(gems.length >= 1, 'the tray token is greyed');
  assert.match(textOf(gems[0]), /Codex is not installed\./);
  assert.match(textOf(tree), /This conversation \(read-only\)/);
  assert.match(textOf(find(tree, node => node.props.className?.includes('seats-now is-diff'))), /Architect\s*Sonnet low → Opus high/, 'a seat that differs from this conversation shows both');
  byAttr(tree, 'data-pick', 'core').props.onClick(pickButton('core'));
  tree = h.render();
  const item = byAttr(find(tree, node => node.props.role === 'menu'), 'data-assign', 'gpt-6.1-sol');
  assert.equal(item.props.disabled, true);
  assert.match(textOf(item), /Codex is not installed\./);
  const lead = findAll(tree, node => node.props['data-slot'] === 'lead.claude' || node.props['data-slot'] === 'lead.codex');
  assert.equal(lead.length, 2, 'the lead tile holds a Claude slot and a Codex slot');
  byAttr(tree, 'data-pick', 'lead.codex').props.onClick(pickButton('lead.codex'));
  const leadMenu = find(h.render(), node => node.props.role === 'menu');
  assert.deepEqual(findAll(leadMenu, node => node.props.role === 'menuitemradio').map(node => node.props['data-assign']), ['gpt-6.1-sol'], 'the Codex slot lists GPT models only');
});

test('dragging a seat’s model onto another seat swaps them, and a tray model replaces the seat’s', t => {
  const h = dialogHarness(t, seatsInfo());
  const listeners = {};
  globalThis.window.addEventListener = (type, listener) => { listeners[type] = listener; };
  globalThis.window.removeEventListener = type => { delete listeners[type]; };
  let target = null;
  globalThis.document.elementFromPoint = () => target && { closest: () => ({ dataset: { slot: target } }) };
  let tree = h.render();
  const coreGem = find(byAttr(tree, 'data-slot', 'core'), node => node.props.className?.startsWith('seats-gem'));
  coreGem.props.onPointerDown({ button: 0, clientX: 10, clientY: 10 });
  target = 'execution';
  listeners.pointermove({ clientX: 40, clientY: 40 });
  listeners.pointerup({ clientX: 40, clientY: 40 });
  tree = h.render();
  const modelOf = slot => textOf(find(byAttr(tree, 'data-slot', slot), node => node.props.className?.startsWith('seats-gem')));
  assert.equal(modelOf('core'), 'Sonnet');
  assert.equal(modelOf('execution'), 'GPT-6.1-Sol');
  const trayGem = findAll(tree, node => node.props.className?.startsWith('seats-dock'))[0];
  const haiku = findAll(trayGem, node => node.props.className?.startsWith('seats-gem')).find(node => textOf(node) === 'Haiku');
  haiku.props.onPointerDown({ button: 0, clientX: 0, clientY: 0 });
  target = 'visual';
  listeners.pointermove({ clientX: 80, clientY: 80 });
  listeners.pointerup({ clientX: 80, clientY: 80 });
  tree = h.render();
  assert.equal(modelOf('visual'), 'Haiku');
  assert.match(textOf(find(tree, node => node.props.role === 'status')), /Visual and acceptance now uses Haiku/);
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
  byAttr(tree, 'data-pick', 'core').props.onClick(pickButton('core'));
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

test('the pane offers 模型路由 only when seats info exists, reads it for its project and terminal, refreshes on skills changes and opens the dialog', async t => {
  let answer = seatsInfo(), refresh = null, stopped = 0;
  const asked = [];
  globalThis.window = { agentrix: { skillSeats: async (...args) => { asked.push(args); return answer; }, onSkills: callback => { refresh = callback; return () => { stopped++; }; } } };
  const h = mount(t, 'ActivityPane.tsx', 'SeatsEntry', { projectId: 'p1', terminalId: 't1' });
  assert.equal(h.render(), null, 'nothing before the answer');
  await settle();
  const tree = h.render();
  const button = find(tree, node => node.type === 'button');
  assert.equal(textOf(button), 'Model routing');
  assert.deepEqual(asked, [['p1', 't1']]);
  assert.equal(find(tree, node => node.props.info), undefined, 'the dialog is closed until the button is pressed');
  button.props.onClick();
  const open = find(h.render(), node => node.props.info);
  assert.equal(open.props.info.skill, 'model-routing');
  assert.equal(open.props.projectId, 'p1');
  assert.equal(open.props.terminalId, 't1');
  // A skills change re-reads; when no skill declares seats any more, the button goes.
  answer = null;
  refresh();
  await settle();
  assert.equal(h.render(), null);
  assert.equal(asked.length, 2);
  h.unmount();
  assert.equal(stopped, 1, 'the subscription ends with the pane');
});

test('no seats info, no button: a skill-less install keeps the pane exactly as it was', async t => {
  globalThis.window = { agentrix: { skillSeats: async () => null, onSkills: () => () => {} } };
  const h = mount(t, 'ActivityPane.tsx', 'SeatsEntry', { projectId: undefined, terminalId: 't1' });
  h.render();
  await settle();
  assert.equal(h.render(), null);
  const source = fs.readFileSync(path.join(__dirname, '../src/features/agents/ActivityPane.tsx'), 'utf8');
  assert.match(source, /<ApiUsage terminal=\{terminal\} projectId=\{projectId\} \/>\s*<SeatsEntry projectId=\{projectId\} terminalId=\{terminal\.id\} \/>/, 'the entry sits under the allowance block');
});

test('the dialog’s motion stops under prefers-reduced-motion, its colours are the product tokens and the English strings exist', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/seats-dialog.css'), 'utf8');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  for (const rule of ['.seats-float', '.seats-gem.is-landing', '.seats-plate.is-ripple']) assert.ok(reduced.includes(rule), `${rule} has no motion when reduced`);
  assert.match(reduced, /transition: none !important/);
  const stray = css.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(line => /#[0-9a-fA-F]{3,6}\b/.test(line) && !line.includes('--'));
  assert.deepEqual(stray, [], 'a literal colour appears only where a lighting variable is defined');
  for (const light of [':root[data-theme="light"] .seats-dialog']) assert.ok(css.includes(light), 'the light lighting values are defined');
  const source = fs.readFileSync(path.join(__dirname, '../src/features/agents/SeatsDialog.tsx'), 'utf8');
  const missing = [...source.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map(match => match[1]).filter(key => /[一-鿿]/.test(key) && !(key in en));
  assert.deepEqual(missing, []);
});

test('switching the scope keeps only the slots edited in this dialog: untouched project overrides never reach global', async t => {
  const info = seatsInfo({ project: { core: { model: 'opus', effort: 'max' }, execution: { model: 'haiku', effort: 'low' } } });
  const h = dialogHarness(t, info);
  let tree = h.render();
  assert.equal(find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Scope of the setting').props.value, 'project');
  byAttr(tree, 'data-pick', 'lookup').props.onClick(pickButton('lookup'));
  byAttr(find(h.render(), node => node.props.role === 'menu'), 'data-assign', 'sonnet').props.onClick();
  tree = h.render();
  find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Scope of the setting').props.onChange({ target: { value: 'global' } });
  tree = h.render();
  assert.match(textOf(tree), /Unsaved draft · 1 seats changed/, 'the count is against the global baseline: the project overrides are not counted');
  byAttr(tree, 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['global', null, { lookup: { model: 'sonnet', effort: 'high' } }]], 'the project’s core and execution overrides stay in the project');
});

test('closing with an unsaved draft asks once, inline, before discarding', t => {
  const h = dialogHarness(t, seatsInfo());
  let tree = h.render();
  byAttr(tree, 'data-pick', 'lookup').props.onClick(pickButton('lookup'));
  byAttr(find(h.render(), node => node.props.role === 'menu'), 'data-assign', 'sonnet').props.onClick();
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
  const info = seatsInfo({ global: { core: { model: 'opus', effort: 'low' } }, project: { core: { model: 'haiku', effort: 'low' } } });
  info.effective = mergeSeats(info.defaults, info.global, info.project);
  const h = dialogHarness(t, info);
  const scopeSelect = tree => find(tree, node => node.type === 'select' && node.props['aria-label'] === 'Scope of the setting');
  scopeSelect(h.render()).props.onChange({ target: { value: 'global' } });
  byAttr(h.render(), 'data-pick', 'architect').props.onClick(pickButton('architect'));
  byAttr(find(h.render(), node => node.props.role === 'menu'), 'data-assign', 'sonnet').props.onClick();
  scopeSelect(h.render()).props.onChange({ target: { value: 'project' } });
  byAttr(h.render(), 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['project', 'p1', { core: { model: 'haiku', effort: 'low' }, architect: { model: 'sonnet', effort: 'high' } }]], 'the project keeps its own core override');
});

test('Escape on the discard banner means keep editing and moves focus to it; it never discards', t => {
  const h = dialogHarness(t, seatsInfo());
  byAttr(h.render(), 'data-pick', 'lookup').props.onClick(pickButton('lookup'));
  byAttr(find(h.render(), node => node.props.role === 'menu'), 'data-assign', 'sonnet').props.onClick();
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
  for (const name of ['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-haiku-5-5', 'gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6.2-sol-mini', 'gpt-6.1-nano']) assert.ok(fixture.some(entry => entry.model === name), `${name} is in the fixture`);
  assert.ok(fixture.some(entry => !/opus|sonnet|haiku|sol|nano|mini|lite/.test(entry.model)), 'the fixture holds an unknown id');
  for (const { model, rank } of fixture) assert.equal(rankByName(model), rank, `${model} ranks ${rank}`);
  assert.equal(rowFor(catalog(), 'gpt-6.2-sol-mini').rank, 1, 'an id the catalog does not list ranks by the same rule');
});

test('effort and fast follow the model’s own row: listed efforts, fast only where the row says so, turning fast off always allowed', () => {
  const rows = catalog({ opus: { fast: true, efforts: ['low', 'high', 'ultra'] }, 'gpt-6.1-sol': { efforts: ['medium', 'high'] } });
  const map = clone(DEFAULTS);
  assert.equal(setEffort(map, 'architect', 'ultra', rows).map.architect.effort, 'ultra', 'a level only this row lists is accepted');
  assert.deepEqual(setEffort(map, 'architect', 'max', rows), { ok: false, reason: 'effort' }, 'a base level the row does not list is refused');
  assert.deepEqual(setEffort(map, 'core', 'low', rows), { ok: false, reason: 'effort' });
  assert.equal(setFast(map, 'architect', true, rows).map.architect.fast, true, 'a Claude row that lists fast takes it');
  assert.deepEqual(setFast(map, 'execution', true, rows), { ok: false, reason: 'fast' });
  assert.equal(setFast({ ...map, execution: { model: 'sonnet', effort: 'high', fast: true } }, 'execution', false, rows).ok, true, 'a stale fast flag can still be turned off');
  assert.equal(firstRefusal({ ...map, architect: { model: 'opus', effort: 'ultra', fast: true } }, rows), null);
  assert.equal(firstRefusal({ ...map, architect: { model: 'opus', effort: 'max' } }, rows).code, 'invalid-effort');
  assert.equal(firstRefusal({ ...map, core: { model: 'gpt-6.1-sol', effort: 'high', fast: true } }, catalog({ 'gpt-6.1-sol': { fast: false } })).code, 'fast-not-allowed', 'a GPT row without fast refuses it too');
  assert.equal(assignModel({ ...map, execution: { model: 'sonnet', effort: 'high', fast: true } }, 'execution', 'opus', rows).map.execution.fast, true, 'a Claude seat with fast keeps it into a fast-capable Claude row');
  assert.equal(assignModel(map, 'execution', 'opus', rows).map.execution.fast, false, 'fast does not start on for Claude');
  assert.deepEqual(assignModel({ ...map, execution: { model: 'sonnet', effort: 'max' } }, 'execution', 'opus', rows).map.execution, { model: 'opus', effort: 'high', fast: false }, 'an effort the row lacks falls to high');
});

test('a typed-in model id follows the helper’s syntax, takes its family from the id and keeps lead slots to their family', () => {
  const map = clone(DEFAULTS), rows = catalog();
  const taken = assignCustom(map, 'core', 'gpt-6.3-sol', rows);
  assert.deepEqual(taken.map.core, { model: 'gpt-6.3-sol', effort: 'high', fast: true }, 'an unlisted GPT id gets the Codex base efforts and fast');
  assert.equal(firstRefusal(taken.map, rows), null, 'and it saves');
  assert.deepEqual(assignCustom(map, 'execution', 'claude-sonnet-9-9', rows).map.execution, { model: 'claude-sonnet-9-9', effort: 'high' }, 'an unlisted Claude id has no fast');
  for (const bad of ['-x', '', '--model', 'a b', 'gpt/;x y', 'x'.repeat(161)]) assert.deepEqual(assignCustom(map, 'core', bad, rows), { ok: false, reason: 'invalid-id' }, `${bad.slice(0, 12)} is refused`);
  assert.equal(assignCustom(map, 'core', 'x'.repeat(160), rows).ok, true, '160 characters is the limit');
  assert.deepEqual(assignCustom(map, 'lead.codex', 'claude-opus-9', rows), { ok: false, reason: 'family' });
  assert.deepEqual(assignCustom(map, 'lead.claude', 'gpt-6.3-sol', rows), { ok: false, reason: 'family' });
  assert.equal(assignCustom(map, 'lead.codex', 'gpt-6.3-sol', rows).map.lead.codex.model, 'gpt-6.3-sol');
  assert.deepEqual(assignCustom(map, 'core', 'gpt-6.1-sol', rows), { ok: false, reason: 'same' });
  assert.deepEqual(assignCustom(map, 'execution', 'gpt-6.1-sol', catalog({ 'gpt-6.1-sol': { available: false } })), { ok: false, reason: 'unavailable' }, 'a listed id keeps its row’s availability');
  assert.equal(setEffort(taken.map, 'core', 'xhigh', rows).ok, true);
  assert.deepEqual(setEffort(taken.map, 'core', 'max', rows), { ok: false, reason: 'effort' }, 'the base list bounds a typed-in id');
});

test('the 更换 menu lists the row’s own efforts, switches fast only where the row has it, says why not, and notes Opus fast billing', t => {
  const rows = catalog({ 'gpt-6.1-sol': { efforts: ['low', 'high', 'ultra'] }, opus: { fast: true }, sonnet: { fastReason: 'unsupported' }, haiku: { fastReason: 'agent-tool' } });
  const h = dialogHarness(t, seatsInfo({ catalog: rows }));
  let menu = openMenu(h, 'core');
  assert.deepEqual(optionValues(byAttr(menu, 'data-effort', 'core')), ['low', 'high', 'ultra'], 'the effort menu is the row’s list');
  assert.equal(byAttr(menu, 'data-fast', 'core').props.disabled, false);
  assert.equal(findAll(menu, node => node.props['data-fast-note'] !== undefined).length, 0, 'a GPT fast row has no billing note');
  menu = openMenu(h, 'architect');
  assert.equal(byAttr(menu, 'data-fast', 'architect').props.disabled, false, 'Opus lists fast');
  assert.match(textOf(byAttr(menu, 'data-fast-note')), /billed at a different price \(for example Opus fast\)/);
  byAttr(menu, 'data-fast', 'architect').props.onClick();
  assert.equal(byAttr(liveMenu(h), 'data-fast', 'architect').props['aria-checked'], true);
  menu = openMenu(h, 'execution');
  assert.equal(byAttr(menu, 'data-fast', 'execution').props.disabled, true, 'Sonnet has no fast');
  assert.match(textOf(byAttr(menu, 'data-fast-note')), /does not support fast mode/);
  assert.match(textOf(byAttr(openMenu(h, 'lookup'), 'data-fast-note')), /through the Agent tool/);
  const unknown = dialogHarness(t, seatsInfo({ catalog: catalog({ sonnet: { fastReason: 'unknown' } }) }));
  assert.match(textOf(byAttr(openMenu(unknown, 'execution'), 'data-fast-note')), /not known yet/);
});

test('其他模型… takes an id in the menu: a good id is assigned and saved, a refused one stays in the box with its reason', async t => {
  const h = dialogHarness(t, seatsInfo());
  byAttr(openMenu(h, 'core'), 'data-custom').props.onClick();
  typeCustom(h, '-x'); applyCustom(h);
  assert.match(textOf(byAttr(liveMenu(h), 'data-custom-error')), /starts with a letter or digit/);
  assert.equal(h.calls.length, 0);
  typeCustom(h, 'gpt-6.3-sol'); applyCustom(h);
  assert.equal(liveMenu(h), undefined, 'the menu closes after an accepted id');
  const tree = h.render();
  assert.match(textOf(find(tree, node => node.props.role === 'status')), /gpt-6\.3-sol/);
  byAttr(tree, 'data-save').props.onClick();
  await settle();
  assert.deepEqual(h.calls, [['global', null, { core: { model: 'gpt-6.3-sol', effort: 'high', fast: true } }]]);
  // A lead slot refuses the other family and says so.
  const lead = dialogHarness(t, seatsInfo());
  byAttr(openMenu(lead, 'lead.codex'), 'data-custom').props.onClick();
  typeCustom(lead, 'claude-opus-9'); applyCustom(lead);
  assert.match(textOf(byAttr(liveMenu(lead), 'data-custom-error')), /only takes Codex models/);
});

test('the refresh button asks main for the seats, shows the new catalog and when each list was read, and says when it fails', async t => {
  const now = Date.now(), at = { claude: now - 3 * 3600000 - 1000, codex: null };
  const refreshed = seatsInfo({ catalog: [...catalog(), row('gpt-6.2-sol', 'GPT-6.2-Sol', 'codex', 3)], catalogAt: { claude: now, codex: now - 120000 } });
  const h = dialogHarness(t, seatsInfo({ catalogAt: at }), { refreshed });
  let tree = h.render();
  assert.equal(textOf(byAttr(tree, 'data-catalog-at')), 'Claude 3 h ago · Codex not refreshed');
  byAttr(tree, 'data-refresh').props.onClick();
  await settle();
  assert.deepEqual(h.refreshes, [['p1', 't1', 'dialog'], ['p1', 't1', 'manual']], 'once when the dialog opens (throttled in main), once for the button (always)');
  tree = h.render();
  assert.equal(textOf(byAttr(tree, 'data-catalog-at')), 'Claude just now · Codex 2 min ago');
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
  const issues = [{ slot: 'execution', code: 'effort-unsupported', substitute: 'high' }, { slot: 'core', code: 'fast-unsupported', substitute: 'fast off' }, { slot: 'lead.claude', code: 'model-unlisted', substitute: 'opus' }];
  const h = dialogHarness(t, seatsInfo({ catalog: rows, issues, defaultsMoved: [{ seat: 'core', from: 'gpt-6.1-sol', to: 'gpt-6.2-sol' }] }));
  let tree = h.render();
  const marks = findAll(tree, node => node.props.className?.startsWith('seats-state'));
  assert.deepEqual(marks.map(node => node.props.title), [
    'Adjusted: this model is not in the current list; it runs as opus', 'Adjusted: this model does not support fast mode; it runs fast off', 'Adjusted: this model does not support the saved effort; it runs high']);
  assert.equal(issuesOf(seatsInfo({ issues }), 'core').length, 1);
  assert.match(textOf(byAttr(tree, 'data-moved')), /Defaults moved to Core engineer：GPT-6\.1-Sol → gpt-6\.2-sol/);
  assert.ok(findAll(tree, node => node.props['data-unlisted'] !== undefined).length >= 1, 'Sonnet is marked as no longer listed');
  assert.match(textOf(byAttr(openMenu(h, 'execution'), 'data-assign', 'sonnet')), /Not in the latest list/);
  // Editing the seat makes its saved issue stale: the mark goes.
  byAttr(liveMenu(h), 'data-effort', 'execution').props.onChange({ target: { value: 'low' } });
  assert.equal(findAll(h.render(), node => node.props.className?.startsWith('seats-state')).length, 2);
  // A record without the new fields still renders (an older main).
  assert.match(textOf(byAttr(dialogHarness(t, seatsInfo()).render(), 'data-catalog-at')), /Claude not refreshed · Codex not refreshed/);
});

test('the dialog reads once when it opens, keeps the opened info until the answer, and shows a moved default from any answer', async t => {
  const moved = [{ seat: 'core', from: 'gpt-6.1-sol', to: 'gpt-6.2-sol' }];
  const h = dialogHarness(t, seatsInfo(), { refreshed: seatsInfo({ defaultsMoved: moved }) });
  let tree = h.render();
  assert.deepEqual(h.refreshes, [['p1', 't1', 'dialog']], 'one read on open');
  assert.equal(byAttr(tree, 'data-moved'), undefined, 'the note waits for the answer');
  assert.equal(findAll(tree, node => node.props.role === 'status' && textOf(node)).length, 0, 'an opening read says nothing while it works');
  await settle();
  assert.match(textOf(byAttr(h.render(), 'data-moved')), /Defaults moved to Core engineer：GPT-6\.1-Sol → gpt-6\.2-sol/);
  const quiet = dialogHarness(t, seatsInfo(), { refreshError: 'offline' });
  quiet.render(); await settle();
  assert.match(textOf(find(quiet.render(), node => node.props.role === 'status')), /Not refreshed: offline/, 'a failed opening read keeps the info and says so');
  assert.ok(byAttr(quiet.render(), 'data-save'), 'the dialog still shows the info it opened with');
});

test('a 刷新 click during the opening read runs right after it, and an answer after the dialog closed is dropped', async t => {
  const h = dialogHarness(t, seatsInfo(), { refreshed: seatsInfo({ defaultsMoved: [{ seat: 'core', from: 'gpt-6.1-sol', to: 'gpt-6.2-sol' }] }) });
  const first = h.render();
  assert.equal(byAttr(first, 'data-refresh').props.disabled, false, 'the button is usable during the opening read');
  byAttr(first, 'data-refresh').props.onClick();
  await settle();
  assert.deepEqual(h.refreshes.map(args => args[2]), ['dialog', 'manual'], 'the click waited for the opening read, then ran');
  const closing = dialogHarness(t, seatsInfo(), { refreshed: seatsInfo({ defaultsMoved: [{ seat: 'core', from: 'a', to: 'b' }] }) });
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
  const map = { ...clone(DEFAULTS), core: { model: 'claude-opus-5-5', effort: 'high' } };
  const block = reviewerBlock(map, rows);
  assert.deepEqual(block.hit, ['core'], 'the reviewer "opus" runs the core seat’s model "claude-opus-5-5"');
  const names = block.alternatives.map(entry => entry.model);
  assert.ok(!names.includes('opus') && !names.includes('claude-opus-5-5'), 'neither spelling of the reviewer’s model is offered as an alternative');
  assert.ok(names.includes('claude-opus-5-4'), 'an older version is another model');
  assert.equal(new Set(names.map(name => canonicalModel(rows, name))).size, names.length, 'an alias and its id are listed once');
  assert.equal(reviewerBlock({ ...clone(DEFAULTS), core: { model: 'claude-opus-5-4', effort: 'high' } }, rows), null, 'a different version does not block');
  assert.equal(reviewerSameButAllowed({ ...map }, catalog({ 'gpt-6.1-sol': { available: false }, sonnet: { available: false }, haiku: { available: false } }).concat([row('claude-opus-5-5', 'Opus', 'claude', 3)])), true, 'the warning form follows the same rule');
});

function reviewerSameButAllowed(map, rows) { return seatsLib.reviewerSameButAllowed(map, rows); }

test('the blocked banner names the three strongest alternatives and counts the rest; the icon sits inline with the message', t => {
  const many = catalog().concat(Array.from({ length: 10 }, (_, index) => row(`gpt-6.${index}-luna`, `GPT-6.${index}-Luna`, 'codex', index < 4 ? 3 : 2)));
  const alternatives = many.filter(entry => entry.model !== 'opus');
  const { shown, total } = topAlternatives(alternatives);
  assert.equal(shown.length, 3);
  assert.equal(total, alternatives.length);
  assert.ok(shown.every(entry => entry.rank === 3), 'the strongest come first');
  const info = seatsInfo({ catalog: many, defaults: { ...clone(DEFAULTS), core: { model: 'opus', effort: 'high' } } });
  const h = dialogHarness(t, info);
  const banner = find(h.render(), node => node.props.className === 'seats-banner is-bad' && node.props.role === 'alert');
  const text = textOf(banner);
  assert.match(text, /and others \(\d+ in all\)/);
  assert.ok((text.match(/GPT-|Sonnet|Haiku/g) ?? []).length <= 4, 'not a list of every model');
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/seats-dialog.css'), 'utf8');
  assert.doesNotMatch(css.match(/\.seats-banner \{[^}]*\}/)[0], /flex-wrap/, 'the icon and the message share one row: the banner does not wrap its items');
});

test('the 更换 menu and the stage stay inside the viewport: the menu flips or takes the roomier side, the stage scales to the height left', () => {
  const view = { width: 1600, height: 1000 };
  const inside = (place, rows) => {
    assert.ok(place.left >= 8 && place.left + 280 <= view.width, 'inside horizontally');
    const top = place.top ?? view.height - place.bottom - place.maxHeight;
    assert.ok(place.maxHeight > 0 && top >= 0, 'starts inside');
    if (place.top !== undefined) assert.ok(place.top + place.maxHeight <= view.height, 'a menu under its button ends inside');
  };
  const roomy = menuPlacement({ left: 400, top: 100, bottom: 132 }, view, 4);
  assert.equal(roomy.top, 136, 'a short menu opens under its button');
  const flipped = menuPlacement({ left: 400, top: 860, bottom: 892 }, view, 18);
  assert.ok(flipped.bottom !== undefined && flipped.top === undefined, 'a long menu near the bottom opens above');
  assert.equal(flipped.maxHeight, 848);
  const tall = menuPlacement({ left: 400, top: 500, bottom: 532 }, view, 18);
  assert.ok(tall.maxHeight <= 500, '18 rows with 468 px each side: the roomier side, the list scrolls inside');
  for (const place of [roomy, flipped, tall, menuPlacement({ left: 1590, top: 20, bottom: 52 }, view, 18), menuPlacement({ left: -5, top: 990, bottom: 999 }, view, 18)]) inside(place);
  assert.equal(sceneScale(1400, 4000), 1, 'a roomy window keeps the stage whole');
  assert.equal(sceneScale(1400, 456), 456 / 580, 'a short window scales the stage to the height left');
  assert.equal(sceneScale(600, 4000), 600 / 900, 'a narrow dialog scales to its width');
  assert.equal(sceneScale(100, 50), 0.5, 'never below half');
});

test('the lead tile is wide enough for two slots, every model dot carries its family, and the tray greys the models of an agent that is not installed', t => {
  const info = seatsInfo({ installed: { claude: true, codex: false } });
  const h = dialogHarness(t, info);
  const tree = h.render();
  const lead = byAttr(tree, 'data-seat', 'lead');
  assert.equal(lead.props.style['--w'], '400px', 'two slots side by side with room for "Opus (follows latest)"');
  assert.equal(byAttr(tree, 'data-seat', 'core').props.style['--w'], '164px');
  const dots = findAll(tree, node => node.props.className === 'seats-mk');
  assert.ok(dots.length > 0 && dots.every(node => node.props['data-family'] === 'claude' || node.props['data-family'] === 'codex'), 'no dot is left without a family');
  assert.ok(dots.some(node => node.props['data-family'] === 'codex') && dots.some(node => node.props['data-family'] === 'claude'));
  const off = findAll(tree, node => node.props.className?.includes('seats-gem is-off'));
  assert.ok(off.length >= 1 && off.every(gem => /Codex is not installed/.test(textOf(gem))), 'a Codex model is greyed with its reason');
  assert.deepEqual(assignModel(clone(DEFAULTS), 'execution', 'gpt-6.1-sol', withInstalled(catalog(), { claude: true, codex: false }, () => 'x')), { ok: false, reason: 'unavailable' });
  assert.equal(withInstalled(catalog(), undefined, () => 'x').every(entry => entry.available), true, 'a record without the field changes nothing');
  byAttr(tree, 'data-pick', 'core').props.onClick(pickButton('core'));
  const item = byAttr(find(h.render(), node => node.props.role === 'menu'), 'data-assign', 'gpt-6.1-sol');
  assert.equal(item.props.disabled, true);
});

test('the moved-defaults note is a neutral banner and the discard question a warning one; only blocks are red', t => {
  const h = dialogHarness(t, seatsInfo({ defaultsMoved: [{ seat: 'core', from: 'gpt-6.1-sol', to: 'gpt-6.2-sol' }] }));
  const tree = h.render();
  assert.equal(byAttr(tree, 'data-moved').props.className, 'seats-banner', 'no is-bad on the note');
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/seats-dialog.css'), 'utf8');
  assert.match(css, /\.seats-banner \{[^}]*border: 1px solid var\(--border\)/, 'the base banner border is neutral');
  assert.match(css, /\.seats-banner\.is-bad \{ border-color: var\(--danger\)/);
  const mk = css.split('\n').filter(line => line.startsWith('.seats-mk'));
  assert.ok(mk.some(line => line.includes('--agent-claude')) && mk.some(line => line.includes('data-family="codex"') && line.includes('--agent-codex')), 'the family dots use the existing agent tokens');
});
