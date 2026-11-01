const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');

function popupModule(bridge) {
  const filename = path.resolve('src/features/files/file-popup.ts'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = dependency => dependency === 'react' ? { useSyncExternalStore: (subscribe, snapshot) => {
    subscribe(() => { const target = snapshot(); if (target) bridge.showPopup?.(target); else bridge.closePopup?.(); });
    return snapshot();
  } } : original(dependency);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  mod.exports.usePopup();
  return mod.exports;
}

// Exercise the real component's handlers, effects and async continuations without Electron or a desktop.
// Only React's hook host and unrelated child renderers are substituted; no save/load logic is copied here.
function component(file, name, props, bridge) {
  const slots = [], listeners = new Map(), timers = new Map();
  let cursor = 0, effects = [], changed = false, tree, mounted = true, guard, timerId = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hooks = {
    ...React, lazy: () => function Markdown() {},
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => {
        assert.ok(mounted, 'no state update after unmount');
        const next = typeof value === 'function' ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; changed = true; }
      }];
    },
    useRef(initial) { return slots[cursor++] ||= { current: initial }; },
    useMemo(make, deps) { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value: make(), deps }; return slots[index].value; },
    useEffect(make, deps) {
      const index = cursor++, before = slots[index];
      if (!before || !same(before.deps, deps)) {
        slots[index] = { deps };
        effects.push(() => { before?.cleanup?.(); slots[index].cleanup = make(); });
      }
    },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  const oldWindow = global.window, oldDocument = global.document;
  const oldSetTimeout = global.setTimeout, oldClearTimeout = global.clearTimeout;
  global.setTimeout = callback => { const id = ++timerId; timers.set(id, callback); return id; };
  global.clearTimeout = id => timers.delete(id);
  global.window = {
    agentrix: bridge,
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
  };
  global.document = { activeElement: null };
  const filename = path.resolve('src/features/files', file), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = dependency => dependency === 'react' ? hooks
    : dependency === '@phosphor-icons/react' ? new Proxy({}, { get: () => () => null })
    : dependency === './CodeEditor' ? { CodeEditor() {}, findConflicts: () => [] }
    : dependency === './editor-commands' || dependency.endsWith('.css') ? {}
    : dependency === './FilePreview' ? { TextContent: function TextContent() {} }
    : dependency === './file-popup' ? popupModule(bridge)
    : dependency.endsWith('/i18n') ? { t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]) }
    : original(dependency);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  props = { ...props, registerGuard: value => { guard = value; } };
  const render = () => {
    let count = 0;
    do { assert.ok(++count < 30, 'render settles'); cursor = 0; changed = false; tree = mod.exports[name](props); const pending = effects; effects = []; pending.forEach(effect => effect()); } while (changed);
    return tree;
  };
  const settle = async () => { for (let i = 0; i < 16; i++) { await Promise.resolve(); if (mounted) render(); } };
  const dispose = () => { if (!mounted) return; for (const slot of slots) slot?.cleanup?.(); mounted = false; };
  return {
    render, settle, get tree() { return tree; }, get timers() { return timers.size; }, get guard() { return guard; },
    update(patch) { props = { ...props, ...patch }; render(); },
    tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); render(); },
    event(type, value) { for (const callback of listeners.get(type) || []) callback(value); render(); },
    dispose,
    restore() { dispose(); global.window = oldWindow; global.document = oldDocument; global.setTimeout = oldSetTimeout; global.clearTimeout = oldClearTimeout; },
  };
}
function elements(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  return [node, ...elements(node.props?.children)];
}
const find = (ui, predicate) => elements(ui.tree).find(predicate);
const textarea = ui => find(ui, node => node.type === 'textarea');
const button = (ui, label) => find(ui, node => node.type === 'button' && (node.props['aria-label'] === label || node.props.children === label));
const text = ui => elements(ui.tree).flatMap(node => [node.props?.children].flat()).filter(value => typeof value === 'string').join(' ');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function preview(content, revision = 'r1', kind = 'text', index = 0, count = 1, id = `${kind}-${revision}-${index}`) {
  return { ok: true, value: { kind, content, revision, name: 'test.txt', path: 'test.txt', size: content.length, modifiedAt: 1,
    page: { index, count, encoding: 'utf8' }, ...(kind === 'text' ? {} : { url: `project-preview://${id}/test.md`, previewId: id }) } };
}
const keyEvent = () => ({ ctrlKey: true, key: 's', preventDefault() {}, stopPropagation() {} });
function editor(autoSave = true, overrides = {}) {
  const saves = [], dirties = [], closed = [], confirms = [];
  const bridge = {
    readFile: async () => preview('original'),
    saveFile(...args) { const pending = deferred(); saves.push({ ...pending, args }); return pending.promise; },
    editorDirty(value) { dirties.push(value); }, gitStatus: async () => ({ ok: false }),
    closePreview: async id => { closed.push(id); },
    confirmEditorClose: async () => { confirms.push(true); return { ok: true, value: 'cancel' }; },
    ...overrides,
  };
  const ui = component('FilePreview.tsx', 'FilePreview', { projectId: 'p', filePath: 'test.txt', autoSave, onClose() {}, onError() {}, onOpenLink() {} }, bridge);
  const edit = value => { textarea(ui).props.onChange({ target: { value } }); ui.render(); };
  const save = () => { textarea(ui).props.onKeyDown(keyEvent()); ui.render(); };
  return Object.assign(ui, { saves, dirties, closed, confirms, edit, save });
}

test('autosave drains edits whose debounce expired during a slow save, using each returned revision', async t => {
  const ui = editor(); t.after(() => ui.restore()); ui.render(); await ui.settle();
  ui.edit('A'); ui.tick(); assert.equal(ui.saves.length, 1);
  assert.equal(textarea(ui).props.disabled, false, 'quiet save keeps editor enabled');
  ui.edit('B'); ui.tick(); assert.equal(ui.saves.length, 1, 'no parallel writes');
  ui.saves[0].resolve(preview('A', 'r2')); await ui.settle();
  assert.equal(ui.saves.length, 2, 'latest draft follows the completed save without another keystroke');
  assert.deepEqual(ui.saves[1].args, ['p', 'test.txt', 0, 'r2', 'B']);
  assert.equal(textarea(ui).props.value, 'B'); assert.equal(ui.dirties.at(-1), true);
  assert.ok(!text(ui).includes('已自动保存'), 'no saved notice for an unsaved newer draft');
  ui.edit('C'); ui.tick(); assert.equal(ui.saves.length, 2);
  ui.saves[1].resolve(preview('B', 'r3')); await ui.settle();
  assert.deepEqual(ui.saves[2].args, ['p', 'test.txt', 0, 'r3', 'C']);
  ui.saves[2].resolve(preview('C', 'r4')); await ui.settle(); ui.tick(); await ui.settle();
  assert.equal(ui.saves.length, 3); assert.equal(ui.dirties.at(-1), false); assert.match(text(ui), /已自动保存/);
});

test('a failed drain preserves the draft and stops until a new edit or explicit save', async t => {
  const ui = editor(); t.after(() => ui.restore()); ui.render(); await ui.settle();
  ui.edit('A'); ui.tick(); ui.edit('B'); ui.tick();
  ui.saves[0].resolve(preview('A', 'r2')); await ui.settle();
  ui.saves[1].resolve({ ok: false, error: 'changed on disk' }); await ui.settle(); ui.tick(); await ui.settle();
  assert.equal(ui.saves.length, 2); assert.equal(ui.timers, 0); assert.equal(textarea(ui).props.value, 'B');
  assert.equal(ui.dirties.at(-1), true); assert.match(text(ui), /changed on disk/);
  ui.save(); assert.deepEqual(ui.saves[2].args.slice(-2), ['r2', 'B']);
  ui.saves[2].resolve(preview('B', 'r3')); await ui.settle();
  assert.match(text(ui), /已保存/); assert.equal(ui.dirties.at(-1), false);
});

test('reverting the draft during a quiet write still guards close until the revert is saved', async t => {
  const ui = editor(); t.after(() => ui.restore()); ui.render(); await ui.settle();
  ui.edit('A'); ui.tick(); ui.edit('original');
  assert.equal(ui.dirties.at(-1), true, 'native close/file operations must still wait for the write');
  let prevented = false;
  ui.event('beforeunload', { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  ui.saves[0].resolve(preview('A', 'r2')); await ui.settle();
  assert.deepEqual(ui.saves[1].args.slice(-2), ['r2', 'original']);
  assert.equal(textarea(ui).props.disabled, false); assert.equal(ui.dirties.at(-1), true);
  ui.saves[1].resolve(preview('original', 'r3')); await ui.settle();
  assert.equal(ui.dirties.at(-1), false); assert.equal(await ui.guard(), true);
});

test('autosave off leaves new edits dirty; manual Ctrl+S uses the saved revision', async t => {
  const ui = editor(); t.after(() => ui.restore()); ui.render(); await ui.settle();
  ui.edit('A'); ui.tick(); ui.edit('B'); ui.update({ autoSave: false });
  ui.saves[0].resolve(preview('A', 'r2')); await ui.settle(); ui.tick(); ui.event('blur');
  assert.equal(ui.saves.length, 1); assert.equal(textarea(ui).props.value, 'B');
  assert.equal(await ui.guard(), false); assert.equal(ui.confirms.length, 1);
  ui.save(); assert.equal(textarea(ui).props.disabled, true);
  assert.deepEqual(ui.saves[1].args.slice(-2), ['r2', 'B']);
  ui.saves[1].resolve(preview('B', 'r3')); await ui.settle();
  assert.equal(textarea(ui).props.disabled, false); assert.equal(await ui.guard(), true);
});

test('Ctrl+S joins and flushes an in-flight quiet save even when autosave is switched off', async t => {
  const ui = editor(); t.after(() => ui.restore()); ui.render(); await ui.settle();
  ui.edit('A'); ui.tick(); ui.edit('B'); ui.update({ autoSave: false }); ui.save();
  assert.equal(ui.saves.length, 1); assert.equal(textarea(ui).props.disabled, true);
  ui.saves[0].resolve(preview('A', 'r2')); await ui.settle();
  assert.deepEqual(ui.saves[1].args.slice(-2), ['r2', 'B']);
  ui.saves[1].resolve(preview('B', 'r3')); await ui.settle();
  assert.equal(await ui.guard(), true); assert.match(text(ui), /已保存/);
});

test('guard waits for the latest draft and refuses navigation if the drain fails', async t => {
  const ui = editor(); t.after(() => ui.restore()); ui.render(); await ui.settle();
  ui.edit('A'); ui.tick(); ui.edit('B'); ui.tick();
  let decision; const leaving = ui.guard().then(value => { decision = value; });
  ui.saves[0].resolve(preview('A', 'r2')); await ui.settle(); assert.equal(decision, undefined);
  ui.saves[1].resolve({ ok: false, error: 'no permission' }); await leaving; await ui.settle();
  assert.equal(decision, false); assert.equal(textarea(ui).props.value, 'B');
  ui.save(); ui.saves[2].resolve(preview('B', 'r3')); await ui.settle();
  assert.equal(await ui.guard(), true);
});

test('manual saves work with autosave initially off and no blur/timer writes', async t => {
  const ui = editor(false); t.after(() => ui.restore()); ui.render(); await ui.settle();
  ui.edit('A'); assert.equal(ui.timers, 0); ui.event('blur'); assert.equal(ui.saves.length, 0);
  ui.save(); ui.saves[0].reject(new Error('write failed')); await ui.settle();
  assert.match(text(ui), /write failed/); assert.equal(textarea(ui).props.disabled, false);
  assert.equal(textarea(ui).props.value, 'A'); assert.equal(await ui.guard(), false);
});

test('guard starts a save before the debounce and drains edits before allowing close', async t => {
  const ui = editor(); t.after(() => ui.restore()); ui.render(); await ui.settle();
  ui.edit('A'); let decision;
  const leaving = ui.guard().then(value => { decision = value; });
  assert.equal(ui.saves.length, 1); ui.edit('B'); ui.tick();
  ui.saves[0].resolve(preview('A', 'r2')); await ui.settle(); assert.equal(decision, undefined);
  ui.saves[1].resolve(preview('B', 'r3')); await leaving; await ui.settle();
  assert.equal(decision, true); assert.equal(ui.confirms.length, 0);
});

test('editor page navigation waits for all drafts, then reads the new page', async t => {
  const reads = [];
  const ui = editor(true, { readFile: async (...args) => { reads.push(args); return preview(`page ${args[2]}`, 'r1', 'text', args[2], 3); } });
  t.after(() => ui.restore()); ui.render(); await ui.settle();
  ui.edit('A'); ui.tick(); ui.edit('B'); ui.tick();
  button(ui, '下一页').props.onClick(); ui.render();
  ui.saves[0].resolve(preview('A', 'r2', 'text', 0, 3)); await ui.settle(); assert.equal(reads.length, 1);
  ui.saves[1].resolve(preview('B', 'r3', 'text', 0, 3)); await ui.settle();
  assert.deepEqual(reads[1], ['p', 'test.txt', 1]); assert.equal(textarea(ui).props.value, 'page 1');
});

test('discard after an in-flight save restores the most recently saved baseline', async t => {
  const ui = editor(true, { confirmEditorClose: async () => ({ ok: true, value: 'discard' }) });
  t.after(() => ui.restore()); ui.render(); await ui.settle();
  ui.edit('A'); ui.tick(); ui.edit('B'); ui.update({ autoSave: false });
  const leaving = ui.guard(); ui.saves[0].resolve(preview('A', 'r2')); await leaving; await ui.settle();
  assert.equal(textarea(ui).props.value, 'A'); assert.equal(ui.dirties.at(-1), false); assert.equal(ui.saves.length, 1);
});

test('save success from an old file cannot change a new file or its dirty state', async t => {
  const ui = editor(true, { readFile: async (_, file) => preview(file === 'test.txt' ? 'original' : 'new file') });
  t.after(() => ui.restore()); ui.render(); await ui.settle();
  ui.edit('A'); ui.tick(); ui.update({ projectId: 'other', filePath: 'other.txt' }); await ui.settle();
  ui.edit('new draft');
  ui.saves[0].resolve(preview('A', 'r2', 'markdown', 0, 1, 'old-save-resource')); await ui.settle();
  assert.equal(textarea(ui).props.value, 'new draft'); assert.equal(ui.dirties.at(-1), true);
  assert.equal(ui.closed.filter(id => id === 'old-save-resource').length, 1);
  assert.ok(!text(ui).includes('已自动保存'));
  ui.tick(); assert.deepEqual(ui.saves[1].args, ['other', 'other.txt', 0, 'r1', 'new draft']);
  ui.saves[1].resolve(preview('new draft', 'r2')); await ui.settle();
});

test('pending saves and reads settle safely after the editor unmounts', async t => {
  const ui = editor(); t.after(() => ui.restore()); ui.render(); await ui.settle();
  ui.edit('A'); ui.save(); ui.dispose();
  ui.saves[0].resolve(preview('A', 'r2', 'markdown', 0, 1, 'after-unmount')); await ui.settle();
  assert.deepEqual(ui.closed, ['after-unmount']);
});

test('old file failures and late reads do not overwrite the new file session', async t => {
  const reads = [];
  const ui = editor(true, { readFile: () => { const pending = deferred(); reads.push(pending); return pending.promise; } });
  t.after(() => ui.restore()); ui.render();
  reads[0].resolve(preview('original')); await ui.settle(); ui.edit('A'); ui.save();
  ui.update({ filePath: 'new.md' }); reads[1].resolve(preview('new content')); await ui.settle();
  ui.saves[0].reject(new Error('old failure')); await ui.settle();
  assert.equal(textarea(ui).props.value, 'new content'); assert.equal(textarea(ui).props.disabled, false);
  assert.ok(!text(ui).includes('old failure'));
  ui.update({ filePath: 'pending.md' }); ui.update({ filePath: 'latest.md' });
  reads[3].resolve(preview('latest content')); await ui.settle();
  reads[2].resolve(preview('stale', 'r1', 'markdown', 0, 1, 'stale-read')); await ui.settle();
  assert.equal(textarea(ui).props.value, 'latest content'); assert.deepEqual(ui.closed, ['stale-read']);
});

function popup() {
  const reads = [], closed = [], navigation = [], closes = [], links = [];
  const target = { kind: 'file', projectId: 'p', path: 'large.md' };
  const ui = component('FilePopup.tsx', 'FilePopup', { target, onError() {} }, {
    readFile(...args) { const pending = deferred(); reads.push({ ...pending, args }); return pending.promise; },
    closePreview: async id => { closed.push(id); },
    openLink: async (id, link) => { links.push([id, link]); return { ok: true, value: { kind: 'file', path: link } }; },
    showPopup: value => navigation.push(value), closePopup: () => closes.push(true),
  });
  return Object.assign(ui, { reads, closed, navigation, closes, links, target });
}
const pageForm = ui => find(ui, node => node.type === 'form');
function jump(ui, page) {
  find(ui, node => node.type === 'input').props.onChange({ target: { value: String(page) } }); ui.render();
  pageForm(ui).props.onSubmit({ preventDefault() {} }); ui.render();
}

test('text popup reads selected bounded pages with keyboard jump, first/last and clear counts', async t => {
  const ui = popup(); t.after(() => ui.restore()); ui.render();
  assert.deepEqual(ui.reads[0].args, ['p', 'large.md', 0]);
  ui.reads[0].resolve(preview('first', 'r1', 'text', 0, 8)); await ui.settle();
  assert.equal(button(ui, '首页').props.disabled, true); assert.match(text(ui), /\/ 8 页/);
  jump(ui, 5); assert.deepEqual(ui.reads[1].args, ['p', 'large.md', 4]);
  assert.match(text(ui), /正在读取文件/); assert.equal(button(ui, '下一页').props.disabled, true);
  ui.reads[1].resolve(preview('fifth', 'r1', 'text', 4, 8)); await ui.settle();
  assert.equal(find(ui, node => node.type?.name === 'TextContent').props.content, 'fifth');
  assert.equal(find(ui, node => node.type === 'input').props.value, '5');
  button(ui, '末页').props.onClick(); ui.render();
  assert.deepEqual(ui.reads[2].args, ['p', 'large.md', 7]);
  ui.reads[2].resolve(preview('last', 'r1', 'text', 7, 8)); await ui.settle();
  assert.equal(button(ui, '下一页').props.disabled, true);
  button(ui, '上一页').props.onClick(); ui.render(); assert.equal(ui.reads[3].args[2], 6);
  ui.reads[3].resolve(preview('six', 'r1', 'text', 6, 8)); await ui.settle();
  jump(ui, 999); assert.equal(ui.reads[4].args[2], 7);
  ui.reads[4].resolve(preview('last', 'r1', 'text', 7, 8)); await ui.settle();
  button(ui, '首页').props.onClick(); ui.render(); assert.equal(ui.reads[5].args[2], 0);
});

test('Markdown pages keep link behavior and release each preview exactly once on switch and close', async t => {
  const ui = popup(); t.after(() => ui.restore()); ui.render();
  ui.reads[0].resolve(preview('# First', 'r1', 'markdown', 0, 3, 'md0')); await ui.settle();
  let markdown = find(ui, node => node.type?.name === 'Markdown');
  assert.equal(markdown.props.content, '# First');
  markdown.props.onOpenLink('linked.txt'); await ui.settle();
  assert.deepEqual(ui.links, [['p', 'linked.txt']]);
  assert.deepEqual(ui.navigation, [{ kind: 'file', projectId: 'p', path: 'linked.txt' }]);
  button(ui, '下一页').props.onClick(); ui.render(); assert.deepEqual(ui.closed, ['md0']);
  assert.deepEqual(ui.reads[1].args, ['p', 'large.md', 1]);
  ui.reads[1].resolve(preview('# Second', 'r1', 'markdown', 1, 3, 'md1')); await ui.settle();
  markdown = find(ui, node => node.type?.name === 'Markdown'); assert.equal(markdown.props.content, '# Second');
  assert.match(markdown.props.baseUrl, /md1/);
  ui.dispose(); assert.deepEqual(ui.closed, ['md0', 'md1']);
});

test('popup ignores stale page/target results, resets targets to page one and cleans late resources', async t => {
  const ui = popup(); t.after(() => ui.restore()); ui.render();
  ui.reads[0].resolve(preview('first', 'r1', 'markdown', 0, 4, 'first')); await ui.settle();
  jump(ui, 3); assert.equal(ui.reads[1].args[2], 2);
  ui.update({ target: { kind: 'file', projectId: 'other', path: 'other.txt' } });
  assert.deepEqual(ui.reads[2].args, ['other', 'other.txt', 0]); assert.equal(pageForm(ui), undefined);
  ui.reads[2].resolve(preview('other file', 'r1', 'text', 0, 2)); await ui.settle();
  ui.reads[1].resolve(preview('stale third', 'r1', 'markdown', 2, 4, 'stale-third')); await ui.settle();
  assert.equal(find(ui, node => node.type?.name === 'TextContent').props.content, 'other file');
  assert.equal(find(ui, node => node.type === 'input').props.value, '1');
  assert.deepEqual(ui.closed, ['first', 'stale-third']);
  jump(ui, 2); ui.dispose();
  ui.reads[3].resolve(preview('late second', 'r1', 'markdown', 1, 2, 'late-second')); await ui.settle();
  assert.deepEqual(ui.closed, ['first', 'stale-third', 'late-second']);
});

test('single-page and HTML popups keep their handling, Escape closes without bubbling', async t => {
  const ui = popup(); t.after(() => ui.restore()); ui.render();
  ui.reads[0].resolve(preview('<p>hello</p>', 'r1', 'html', 0, 5, 'html')); await ui.settle();
  assert.equal(pageForm(ui), undefined); assert.match(find(ui, node => node.type === 'iframe').props.src, /html/);
  ui.update({ target: { kind: 'file', projectId: 'p', path: 'short.txt' } });
  ui.reads[1].resolve(preview('short')); await ui.settle(); assert.equal(pageForm(ui), undefined);
  let prevented = false, stopped = false;
  ui.event('keydown', { key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented, true); assert.equal(stopped, true); assert.deepEqual(ui.closes, [true]);
  assert.deepEqual(ui.closed, ['html']);
});

test('popup page responses can finish out of order without replacing the selected page', async t => {
  const ui = popup(); t.after(() => ui.restore()); ui.render();
  ui.reads[0].resolve(preview('first', 'r1', 'markdown', 0, 4, 'first')); await ui.settle();
  jump(ui, 2); jump(ui, 4);
  assert.deepEqual(ui.reads.slice(1).map(read => read.args[2]), [1, 3]);
  ui.reads[2].resolve(preview('fourth', 'r1', 'markdown', 3, 4, 'fourth')); await ui.settle();
  ui.reads[1].resolve(preview('stale second', 'r1', 'markdown', 1, 4, 'second')); await ui.settle();
  assert.equal(find(ui, node => node.type?.name === 'Markdown').props.content, 'fourth');
  assert.equal(find(ui, node => node.type === 'input').props.value, '4');
  assert.deepEqual(ui.closed, ['first', 'second']); ui.dispose();
  assert.deepEqual(ui.closed, ['first', 'second', 'fourth']);
});

test('popup releases once when a target switches between read and render continuations', async t => {
  const ui = popup(); t.after(() => ui.restore()); ui.render();
  ui.reads[0].resolve(preview('old', 'r1', 'markdown', 0, 4, 'between-continuations'));
  await Promise.resolve();
  ui.update({ target: { kind: 'file', projectId: 'p', path: 'new.txt' } });
  await ui.settle(); assert.deepEqual(ui.closed, ['between-continuations']);
  ui.reads[1].resolve(preview('new')); await ui.settle(); ui.dispose();
  assert.deepEqual(ui.closed, ['between-continuations']);
});
