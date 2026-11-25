const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rendererLoader } = require('./helpers/hook-harness.cjs');
const { handleAppShortcut } = rendererLoader({}, /\/shortcuts$/)('src/app-commands.ts');

function fixture({ modal = false, tour = false, popup = false } = {}) {
  const calls = [], popupNode = {}, field = { value: '', classList: { contains: () => false } };
  const target = inside => ({ closest: selector => selector === '.reading-terminal-popup' && inside ? popupNode : null });
  const body = target(false), terminal = target(true), search = target(false);
  search.closest = selector => selector.includes('input, textarea') ? field : null;
  const open = { 'dialog[open]': modal || popup, 'dialog:modal': modal, '.tour-layer': tour };
  const document = { activeElement: body, querySelector: selector => selector.split(', ').some(part => open[part]) ? {} : null };
  const press = (code, element = document.activeElement, repeat = false) => {
    const event = { code, ctrlKey: true, shiftKey: true, target: element, repeat, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    handleAppShortcut(document, event, action => calls.push(action)); return event;
  };
  return { press, calls, document, body, terminal, search };
}

test('a background terminal popup cannot lock search or add-project after search is cleared and blurred', () => {
  const f = fixture({ popup: true });
  assert.equal(f.press('KeyF').defaultPrevented, true);
  f.document.activeElement = f.search;
  assert.equal(f.press('KeyN').defaultPrevented, true, 'app shortcuts remain available in the search field');
  f.document.activeElement = f.body;
  assert.equal(f.press('KeyN').defaultPrevented, true, 'blur leaves app shortcuts available');
  assert.deepEqual(f.calls, ['search', 'addProject', 'addProject']);
});

test('keys inside a terminal popup belong to the CLI, including when focus moved after key dispatch', () => {
  const f = fixture({ popup: true });
  // Focus may already differ by the time the capture handler runs; the event's target owns the key.
  f.document.activeElement = f.search;
  for (const code of ['KeyF', 'KeyN']) {
    const event = f.press(code, f.terminal);
    assert.equal(event.defaultPrevented, false); assert.equal(event.stopped, false);
  }
  assert.deepEqual(f.calls, []);
});

test('modal dialogs and the tour keep app shortcuts blocked everywhere', () => {
  for (const state of [{ modal: true }, { tour: true }]) {
    const f = fixture(state);
    for (const target of [f.body, f.search, f.terminal]) {
      assert.equal(f.press('KeyN', target).defaultPrevented, false);
      assert.equal(f.press('KeyF', target).defaultPrevented, false);
    }
    assert.deepEqual(f.calls, []);
  }
});

test('one held add-project shortcut runs once while repeated keys are still consumed', () => {
  const f = fixture({ popup: true });
  assert.equal(f.press('KeyN').defaultPrevented, true);
  assert.equal(f.press('KeyN', f.body, true).defaultPrevented, true);
  assert.deepEqual(f.calls, ['addProject']);
});

test('focus animation changes keep the workspace subscription and an older snapshot cannot overwrite a push', async t => {
  const { appView } = require('./helpers/app-view.cjs');
  const callbacks = [], focuses = new Map();
  let push, snapshot;
  const project = { id: 'p', name: 'Live', terminals: [] };
  const app = appView(t, { project, bridge: {
    onState(fn) { callbacks.push(fn); push = fn; return () => {}; },
    getState: () => new Promise(resolve => { snapshot = resolve; }),
    acknowledge: async () => ({ ok: true }),
  }, './useProjectFocusMotion': { useProjectFocusMotion: animation => {
    if (!focuses.has(animation)) focuses.set(animation, () => {});
    return { focusedId: project.id, focus: focuses.get(animation) };
  } } });
  push({ projects: [project], settings: { focusAnimation: 'off' } });
  assert.ok(app.render().some(node => node.type === app.AgentSidebar));
  snapshot({ ok: true, value: { projects: [], settings: {} } });
  await Promise.resolve(); await Promise.resolve();
  assert.ok(app.render().some(node => node.type === app.AgentSidebar));
  assert.equal(callbacks.length, 1);
});

test('a removed project with an open editor asks the navigation guard once across state pushes', async t => {
  const { appView } = require('./helpers/app-view.cjs');
  const project = { id: 'p', name: 'Live', terminals: [] };
  let push, confirms = 0;
  const app = appView(t, { project, bridge: {
    onState(fn) { push = fn; push({ projects: [project], settings: {} }); return () => {}; },
  } });
  const sidebar = app.render().find(node => node.type === app.AgentSidebar);
  await sidebar.props.children({}).props.onSelectFile('draft.txt');
  const editor = app.render().find(node => node.props?.registerGuard);
  editor.props.registerGuard(async () => { confirms++; return false; });
  for (const settings of [{}, { focusAnimation: 'off' }, {}]) {
    push({ projects: [], settings });
    app.render();
    await Promise.resolve(); await Promise.resolve();
  }
  assert.equal(confirms, 1);
  assert.equal(app.render().find(node => node.props?.registerGuard)?.props.filePath, 'draft.txt');
});
