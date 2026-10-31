const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { registerMacTitlebar } = require('../electron/app/mac-titlebar.cjs');
const { createIpcAdapter } = require('../electron/shared/ipc.cjs');
const { translate } = require('../electron/i18n.cjs');
const { buildMacTitlebar } = require('../scripts/build-mac-titlebar.cjs');

const root = path.join(__dirname, '..');
const binary = path.join(root, 'native/mac-titlebar/build/Release/mac_titlebar.node');
const script = path.join(root, 'scripts/build-mac-titlebar.cjs');
const main = ts.createSourceFile('main.cjs', fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const mainFunction = name => main.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name);

function fixture(options = {}) {
  const updates = [], messages = [], warnings = [];
  let click, detached = 0, attached = 0, broadcasts = 0, language = 'en', failure;
  const handle = Buffer.alloc(8);
  const frame = { url: 'agentrix://app/index.html' };
  const window = Object.assign(new EventEmitter(), {
    getNativeWindowHandle: () => handle, isDestroyed: () => false,
    webContents: { mainFrame: frame },
  });
  const addon = {
    attach: (value, callback) => { assert.equal(value, handle); attached++; click = callback; },
    update: value => { if (failure) throw failure; updates.push(value); },
    detach: () => detached++,
  };
  const controller = registerMacTitlebar({ window, platform: 'darwin',
    t: text => translate(language, text), send: (...args) => messages.push(args),
    broadcast: () => broadcasts++, loadAddon: () => addon, warn: message => warnings.push(message), ...options });
  return { controller, window, addon, updates, messages, warnings, click: id => click(id),
    setLanguage: value => { language = value; }, fail: () => { failure = new Error('update failed'); },
    get attached() { return attached; }, get detached() { return detached; }, get broadcasts() { return broadcasts; } };
}

test('attach publishes native availability only after initializing both translated buttons', () => {
  const f = fixture();
  assert.equal(f.attached, 1);
  assert.equal(f.controller.attached, true);
  assert.deepEqual(f.updates, [{ items: [
    { id: 'decisions', label: 'Decide', selected: false },
    { id: 'workspace', label: 'Workbench', selected: true },
  ] }]);
  assert.equal(f.broadcasts, 0, 'the initial workspace snapshot already contains availability');
  assert.deepEqual(f.warnings, []);
});

test('validated state updates count and selection; identical snapshots and extra fields do not update native controls', () => {
  const f = fixture();
  for (const value of [undefined, null, {}, [], 'workspace', { view: 'other', decisions: 1 },
    ...[-1, 0.5, NaN, Infinity, '2', Number.MAX_SAFE_INTEGER + 1].map(decisions => ({ view: 'decisions', decisions }))]) {
    f.controller.update(value);
  }
  assert.equal(f.updates.length, 1);
  f.controller.update({ view: 'decisions', decisions: 2, ignored: true });
  assert.deepEqual(f.updates.at(-1), { items: [
    { id: 'decisions', label: 'Decide 2', selected: true },
    { id: 'workspace', label: 'Workbench', selected: false },
  ] });
  f.controller.update({ view: 'decisions', decisions: 2 });
  f.controller.refresh();
  assert.equal(f.updates.length, 2);
  f.controller.update({ view: 'workspace', decisions: 0 });
  assert.equal(f.updates.at(-1).items[0].label, 'Decide', 'zero has no badge suffix');
});

test('clicks request navigation without selecting a page that a dialog may reject', () => {
  const f = fixture();
  f.click('decisions'); f.click('workspace'); f.click('settings');
  assert.deepEqual(f.messages, [['titlebar:navigate', 'decisions'], ['titlebar:navigate', 'workspace']]);
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].items[1].selected, true);
  f.window.isDestroyed = () => true;
  f.click('decisions');
  assert.equal(f.messages.length, 2);
});

test('language changes refresh the latest count and selected page through the real settings function', () => {
  const f = fixture();
  f.controller.update({ view: 'decisions', decisions: 3 });
  const store = { settings: { language: 'en' }, updateSettings(patch) { Object.assign(this.settings, patch); } };
  const context = vm.createContext({ store, macTitlebar: f.controller, process: { platform: 'darwin' },
    trayMenu() {}, rebuildMacMenu() {} });
  vm.runInContext(mainFunction('updateStoreSettings').getText(main), context);
  f.setLanguage('zh');
  context.updateStoreSettings({ language: 'zh' });
  assert.deepEqual(f.updates.at(-1), { items: [
    { id: 'decisions', label: '决策 3', selected: true },
    { id: 'workspace', label: '工作台', selected: false },
  ] });
  context.updateStoreSettings({ language: 'zh' });
  assert.equal(f.updates.length, 3);
});

test('closing releases the addon once and ignores queued clicks and subsequent state updates', () => {
  const f = fixture();
  f.window.emit('closed'); f.window.emit('closed');
  f.click('decisions');
  f.controller.update({ view: 'decisions', decisions: 1 });
  f.controller.refresh();
  assert.equal(f.detached, 1);
  assert.equal(f.controller.attached, false);
  assert.equal(f.updates.length, 1);
  assert.deepEqual(f.messages, []);
});

test('missing, invalid or failed addons retain web navigation and warn only once', () => {
  for (const loadAddon of [() => { throw new Error('missing binary'); }, () => ({}), () => null,
    () => ({ attach() { throw new Error('attach failed'); }, update() {}, detach() {} }),
    () => ({ attach() {}, update() { throw new Error('initial update failed'); }, detach() {} })]) {
    const f = fixture({ loadAddon });
    assert.equal(f.controller.attached, false);
    f.controller.update({ view: 'decisions', decisions: 1 }); f.controller.refresh();
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], /using web navigation/);
    assert.equal(f.broadcasts, 0);
  }
});

test('a runtime update failure detaches and broadcasts availability so the web buttons return', () => {
  const f = fixture();
  f.fail();
  f.controller.update({ view: 'decisions', decisions: 1 });
  f.controller.refresh(); f.window.emit('closed'); f.click('decisions');
  assert.equal(f.controller.attached, false);
  assert.equal(f.detached, 1);
  assert.equal(f.broadcasts, 1);
  assert.equal(f.warnings.length, 1);
  assert.deepEqual(f.messages, []);
});

test('Windows and Linux never load or attach the macOS binary', () => {
  for (const platform of ['win32', 'linux']) {
    const f = fixture({ platform, loadAddon: () => assert.fail('must not load the addon') });
    f.controller.update({ view: 'decisions', decisions: 1 }); f.controller.refresh();
    assert.equal(f.controller.attached, false);
    assert.equal(f.window.listenerCount('closed'), 0);
    assert.deepEqual(f.warnings, []);
    assert.deepEqual(f.updates, []);
  }
});

test('titlebar state uses the main-frame IPC guard and is registered only on macOS', () => {
  const statement = mainFunction('registerIpc').body.statements.find(node => ts.isIfStatement(node) && node.getText(main).includes('titlebar:state'));
  assert.ok(statement);
  for (const platform of ['darwin', 'win32', 'linux']) {
    const f = fixture(), ipcMain = new EventEmitter(), errors = [];
    const { listen } = createIpcAdapter({ ipcMain, getWindow: () => f.window, report: error => errors.push(error) });
    vm.runInNewContext(statement.getText(main), { process: { platform }, macTitlebar: f.controller, listen });
    assert.equal(ipcMain.listenerCount('titlebar:state'), platform === 'darwin' ? 1 : 0);
    const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
    ipcMain.emit('titlebar:state', { ...event, senderFrame: { url: 'agentrix://app/preview' } }, { view: 'decisions', decisions: 5 });
    assert.equal(f.updates.length, 1);
    ipcMain.emit('titlebar:state', event, { view: 'decisions', decisions: 5 });
    assert.equal(f.updates.length, platform === 'darwin' ? 2 : 1);
    assert.equal(errors.length, platform === 'darwin' ? 1 : 0);
  }
});

test('preload sends state and exposes an unsubscribable navigation listener without leaking the event', () => {
  const ipcRenderer = new EventEmitter(), messages = [];
  ipcRenderer.send = (...args) => messages.push(args);
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { ipcRenderer,
      contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'agentrix'); bridge = value; } } }; },
  });
  const state = { view: 'decisions', decisions: 4 }, pages = [];
  bridge.setTitlebarState(state);
  assert.deepEqual(messages, [['titlebar:state', state]]);
  const unsubscribe = bridge.onTitlebarNavigate(page => pages.push(page));
  ipcRenderer.emit('titlebar:navigate', { secret: true }, 'decisions');
  unsubscribe(); ipcRenderer.emit('titlebar:navigate', {}, 'workspace');
  assert.deepEqual(pages, ['decisions']);
  assert.equal(ipcRenderer.listenerCount('titlebar:navigate'), 0);
});

test('workspace availability follows the controller, including addon failure and window close', () => {
  const declaration = mainFunction('publicState').body.statements[0].expression.properties.find(node => node.name?.getText(main) === 'nativeTitlebar');
  assert.ok(declaration);
  const f = fixture(), macTitlebar = f.controller;
  assert.equal(vm.runInNewContext(declaration.initializer.getText(main), { macTitlebar }), true);
  f.window.emit('closed');
  assert.equal(vm.runInNewContext(declaration.initializer.getText(main), { macTitlebar }), false);
  assert.equal(vm.runInNewContext(declaration.initializer.getText(main), { macTitlebar: null }), false);
});

test('packaging includes and unpacks only the macOS binary, keeping node-pty unpacking', () => {
  const { getFileMatchers } = require('app-builder-lib/out/fileMatcher.js');
  const config = require('../package.json').build;
  assert.equal(config.npmRebuild, false);
  for (const [name, platform] of [['mac', 'darwin'], ['win', 'win32'], ['linux', 'linux']]) {
    const options = { defaultSrc: root, globalOutDir: path.join(root, 'release'), customBuildOptions: config[name],
      macroExpander: value => value.replaceAll('${platform}', platform).replaceAll('${arch}', 'arm64') };
    const includes = (kind, file) => getFileMatchers(config, kind, path.join(root, 'release/app'), options)
      .some(matcher => matcher.createFilter()(path.join(root, file), { isDirectory: () => false }));
    const native = 'native/mac-titlebar/build/Release/mac_titlebar.node';
    assert.equal(includes('files', native), name === 'mac', name);
    assert.equal(includes('asarUnpack', native), name === 'mac', name);
    assert.equal(includes('files', 'native/mac-titlebar/titlebar.mm'), false);
    assert.equal(includes('files', 'native/mac-titlebar/build/node-include/include/node/node_api.h'), false);
    assert.equal(includes('asarUnpack', `node_modules/node-pty/prebuilds/${platform}-arm64/pty.node`), true);
  }
});

function buildFixture(t) {
  const buildRoot = path.join(root, 'native/mac-titlebar/build');
  fs.mkdirSync(buildRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(buildRoot, 'test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'native/mac-titlebar');
  fs.mkdirSync(source, { recursive: true });
  for (const file of ['binding.gyp', 'titlebar.mm']) fs.writeFileSync(path.join(source, file), 'test source');
  const headers = path.join(directory, 'headers');
  fs.mkdirSync(path.join(headers, 'include/node'), { recursive: true });
  for (const file of ['node_api.h', 'common.gypi', 'config.gypi']) fs.writeFileSync(path.join(headers, 'include/node', file), 'test headers');
  const previous = process.env.npm_config_nodedir;
  process.env.npm_config_nodedir = headers;
  t.after(() => { if (previous === undefined) delete process.env.npm_config_nodedir; else process.env.npm_config_nodedir = previous; });
  return { root: directory, source, output: path.join(source, 'build/Release/mac_titlebar.node') };
}

test('build is offline with local headers, then a no-op; changed sources or architecture rebuild it', t => {
  const f = buildFixture(t), calls = [];
  const run = (node, args, options) => {
    calls.push(args);
    assert.equal(node, process.execPath);
    assert.equal(options.cwd, f.source);
    assert.equal(options.env.PYTHONDONTWRITEBYTECODE, '1');
    assert.ok(options.env.TMPDIR.startsWith(path.join(f.source, 'build')));
    assert.ok(args.includes('--nodedir=build/node-include'));
    assert.ok(!args.includes('install'), 'local headers require no download');
    assert.equal(fs.existsSync(f.output), false, 'a rebuild discards the previous architecture and dependency files');
    fs.mkdirSync(path.dirname(f.output), { recursive: true });
    fs.writeFileSync(f.output, 'test binary');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(f.output, future, future);
  };
  const options = { root: f.root, platform: 'darwin', arch: 'arm64', run };
  assert.equal(buildMacTitlebar(options), f.output);
  assert.equal(buildMacTitlebar(options), f.output);
  assert.equal(calls.length, 1);
  buildMacTitlebar({ ...options, arch: 'x64' });
  assert.equal(calls.length, 2);
  const past = new Date(0);
  fs.utimesSync(f.output, past, past);
  buildMacTitlebar({ ...options, arch: 'x64' });
  assert.equal(calls.length, 3);
});

test('failed rebuild removes a stale binary so optional startup uses the web fallback', t => {
  const f = buildFixture(t);
  fs.mkdirSync(path.dirname(f.output), { recursive: true });
  fs.writeFileSync(f.output, 'stale binary');
  assert.throws(() => buildMacTitlebar({ root: f.root, platform: 'darwin', run: () => { throw new Error('compiler missing'); } }), /compiler missing/);
  assert.equal(fs.existsSync(f.output), false);
});

test('the build script does nothing on Windows or Linux, including when sources are missing', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(buildMacTitlebar({ root: '/missing-source', platform, run: () => assert.fail('must not build') }), undefined);
  }
});

test('optional build failures warn and continue, while strict builds and macOS CI fail', { skip: process.platform !== 'darwin' }, () => {
  for (const [flags, ci, status] of [[['--optional'], '', 0], [[], '', 1], [['--optional'], 'true', 1]]) {
    const result = spawnSync(process.execPath, [script, '--arch=invalid', ...flags], {
      encoding: 'utf8', env: { ...process.env, CI: ci },
    });
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stderr, /Unsupported macOS architecture/);
  }
});

test('the compiled binary loads in plain Node and detached operations need no application or window', {
  skip: process.platform !== 'darwin' || !fs.existsSync(binary),
}, () => {
  const addon = require(binary);
  assert.deepEqual(Object.keys(addon).sort(), ['attach', 'detach', 'update']);
  addon.detach(); addon.detach();
  addon.update({ items: [
    { id: 'decisions', label: '决策 2', selected: true },
    { id: 'workspace', label: '工作台', selected: false },
  ] });
  assert.throws(() => addon.attach(Buffer.alloc(1), () => {}), /native window handle/);
  assert.throws(() => addon.update({ items: [] }), /decisions and workspace/);
});
