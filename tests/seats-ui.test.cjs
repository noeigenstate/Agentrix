const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const seatsLib = require('../src/features/agents/skill-seats.ts');
const { assignModel, swapSlots, setEffort, setFast, reviewerBlock, firstRefusal, scopePayload, changedCount, mergeSeats, baselineFor, lowerLayer, startScope, fallbackFor, saveSeats } = seatsLib;

const en = require('../electron/locales/en.json');
const additions = path.join(__dirname, '../locale-additions-seats.json');
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
  assert.deepEqual(setFast(map, 'execution', true), { ok: false, reason: 'fast' }, 'fast on a Claude seat is refused');
  assert.equal(setFast(map, 'core', false).map.core.fast, false);
  assert.deepEqual(setEffort(map, 'core', 'max'), { ok: false, reason: 'effort' }, 'GPT has no max');
  assert.equal(setEffort(map, 'architect', 'max').map.architect.effort, 'max');
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
const pickButton = (slot) => ({ currentTarget: { getBoundingClientRect: () => ({ left: 100, bottom: 200 }), focus() {} }, slot });
const settle = async () => { for (let turn = 0; turn < 6; turn++) await null; };

function dialogHarness(t, info, props = {}) {
  const calls = [], closed = [];
  const api = { setSkillSeats: async (...args) => { calls.push(args); return props.reply ?? { ok: true }; } };
  globalThis.window = { agentrix: api, innerWidth: 1280, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
  globalThis.document = { activeElement: null, elementFromPoint: () => null };
  const h = mount(t, 'SeatsDialog.tsx', 'SeatsDialog', { info, projectId: 'p1', terminalId: 't1', onClose: () => closed.push(true), ...props.dialog });
  return Object.assign(h, { calls, closed });
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
