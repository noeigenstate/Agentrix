const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { registerFilesIpc } = require('../electron/features/files/ipc.cjs');

function loadPopup(popups) {
  const filename = path.join(__dirname, '../src/features/files/file-popup.ts');
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => name === 'react' ? { useSyncExternalStore: (subscribe, snapshot) => { subscribe(() => popups.push(snapshot())); return snapshot(); } } : original(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  mod.exports.usePopup();
  return mod.exports;
}

function loadResultActions(popup) {
  const filename = path.join(__dirname, '../src/features/reading/ResultCard.tsx');
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => {
    const key = name.startsWith('.') ? path.basename(name) : name;
    if (name.endsWith('.css')) return {};
    if (key === '@phosphor-icons/react') return new Proxy({}, { get: () => () => React.createElement('svg') });
    if (key === 'i18n') return { t: text => text };
    if (key === 'file-popup') return popup;
    if (key === 'Timeline') return { stepTime: () => '' };
    if (key === 'useNow.ts') return { useNow: () => 0 };
    if (key === 'PathText') return { PathText: () => null };
    if (key === 'result-round') return require('../src/features/reading/result-round.ts');
    if (key === 'markdown-escape') return require('../src/features/reading/markdown-escape.ts');
    return original(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports.ResultActions;
}

function restoreWindow(t) {
  const previous = globalThis.window;
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
}

function card(written, openLink) {
  const calls = [], popups = [], errors = [], continued = [];
  let pending;
  globalThis.window = { agentrix: { openLink: (...args) => { calls.push(args); return pending = openLink(...args); } } };
  const ResultActions = loadResultActions(loadPopup(popups));
  const tree = ResultActions({ result: { kind: 'code', written, reply: '' }, projectId: 'project', remote: false, canSend: true,
    onContinue: value => continued.push(value), onRetry() {}, onError: message => errors.push(message) });
  const button = label => React.Children.toArray(tree.props.children).find(node => node.props['aria-label'] === label);
  return { calls, popups, errors, continued, button, settle: async () => { if (pending) await pending.catch(() => {}); await Promise.resolve(); } };
}

function filesBridge(project, options = {}) {
  const handlers = new Map();
  registerFilesIpc({ handle: (name, fn) => handlers.set(name, fn), listen() {}, findProject: id => {
    assert.equal(id, project.id); return project;
  }, shell: {}, previewResources: {}, ...options });
  const invoke = async (name, ...args) => {
    try { return { ok: true, value: await handlers.get(name)(...args) }; }
    catch (error) { return { ok: false, error: error.message }; }
  };
  return { openLink: (...args) => invoke('project:open-link', ...args), readFile: (...args) => invoke('project:file', ...args) };
}

test('opening the first written file resolves absolute and relative paths through the main process', async t => {
  restoreWindow(t);
  const root = path.resolve(__dirname, '..'), relative = 'src/features/reading/ResultCard.tsx';
  const absolute = path.join(root, relative), bridge = filesBridge({ id: 'project', kind: 'local', path: root });
  assert.deepEqual(await bridge.readFile('project', absolute), { ok: false, error: '无效的项目文件路径。' });
  for (const written of [absolute, relative]) {
    const h = card([written, 'another-file.ts'], bridge.openLink);
    h.button('打开文件').props.onClick();
    assert.deepEqual(h.calls, [['project', written]]);
    assert.deepEqual(h.popups, [], 'wait for the main process to resolve the path');
    await h.settle();
    assert.deepEqual(h.popups, [{ kind: 'file', projectId: 'project', path: relative }]);
    assert.deepEqual(h.errors, []);
    const preview = await bridge.readFile('project', h.popups[0].path);
    assert.equal(preview.ok, true);
    assert.match(preview.value.content, /export function ResultActions/);
    h.button('继续修改').props.onClick();
    assert.deepEqual(h.continued, [undefined]);
  }
});

test('opening follows the main process result for directories, external links and errors', async t => {
  restoreWindow(t);
  for (const [result, expectedPopup, expectedError] of [
    [{ ok: true, value: { kind: 'directory', path: 'src' } }, { kind: 'folder', projectId: 'project', path: 'src' }, null],
    [{ ok: true, value: { kind: 'external' } }, null, null],
    [{ ok: false, error: '未找到链接文件。' }, null, '未找到链接文件。'],
  ]) {
    const h = card(['/remote/project/src'], async () => result);
    h.button('打开文件').props.onClick(); await h.settle();
    assert.deepEqual(h.popups, expectedPopup ? [expectedPopup] : []);
    assert.deepEqual(h.errors, expectedError ? [expectedError] : []);
  }
});

test('missing and outside project paths report the main process failure without a popup', async t => {
  restoreWindow(t);
  const root = path.resolve(__dirname, '..'), bridge = filesBridge({ id: 'project', kind: 'local', path: root });
  const missing = path.join(root, 'src', '__missing_result_card_file__.tsx');
  assert.equal(fs.existsSync(missing), false);
  for (const [written, message] of [[missing, /未找到链接文件/], [path.dirname(root), /无效的项目文件路径/]]) {
    const h = card([written], bridge.openLink);
    h.button('打开文件').props.onClick(); await h.settle();
    assert.deepEqual(h.popups, []);
    assert.equal(h.errors.length, 1); assert.match(h.errors[0], message);
  }
});

test('remote absolute paths use the remote project root and open files or folders', async t => {
  restoreWindow(t);
  const requests = [], remote = { ready: Promise.resolve(), info: { root: '/remote/project' },
    request: async (method, args) => { requests.push([method, args.path]); return args.path === 'src' ? { directory: true, realPath: 'src' } : { directory: false }; } };
  const bridge = filesBridge({ id: 'project', kind: 'ssh', path: '/remote/project' }, { remoteFor: () => remote });
  for (const [written, target] of [
    ['/remote/project/src/file.ts', { kind: 'file', projectId: 'project', path: 'src/file.ts' }],
    ['/remote/project/src', { kind: 'folder', projectId: 'project', path: 'src' }],
  ]) {
    const h = card([written], bridge.openLink);
    h.button('打开文件').props.onClick(); await h.settle();
    assert.deepEqual(h.popups, [target]); assert.deepEqual(h.errors, []);
  }
  assert.deepEqual(requests, [['stat', 'src/file.ts'], ['stat', 'src']]);
});

test('opening reports a rejected bridge request through the card error handler', async t => {
  restoreWindow(t);
  const h = card(['src/file.ts'], async () => { throw new Error('connection closed'); });
  h.button('打开文件').props.onClick(); await h.settle();
  assert.deepEqual(h.popups, []);
  assert.deepEqual(h.errors, ['Error: connection closed']);
});
