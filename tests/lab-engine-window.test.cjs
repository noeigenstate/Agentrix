require('./fixtures/lab-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createLab } = require('../electron/features/lab/index.cjs');
const { createLabWindow } = require('../electron/features/lab/window.cjs');
const { buildMacMenuTemplate } = require('../electron/app/mac-menu.cjs');

class Contents extends EventEmitter {
  constructor() { super(); this.mainFrame = { url: 'agentrix://app/index.html' }; this.zoom = 1; this.messages = []; }
  setZoomMode(value) { this.zoomMode = value; }
  setZoomFactor(value) { this.zoom = value; }
  getZoomFactor() { return this.zoom; }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
  send(...args) { this.messages.push(args); }
}
class Window extends EventEmitter {
  constructor(options = {}) { super(); this.options = options; this.webContents = new Contents(); this.focused = 0; }
  isDestroyed() { return !!this.destroyed; }
  isMinimized() { return !!this.minimized; }
  isMaximized() { return !!this.maximized; }
  restore() { this.minimized = false; }
  show() { this.shown = true; }
  focus() { this.focused++; }
  close() { this.destroyed = true; this.emit('closed'); }
  minimize() { this.minimized = true; }
  maximize() { this.maximized = true; }
  unmaximize() { this.maximized = false; }
  setBackgroundColor(value) { this.background = value; }
  async loadURL(url) { this.url = url; this.webContents.mainFrame.url = url; this.webContents.emit('did-finish-load'); }
}
class Ipc extends EventEmitter {
  constructor() { super(); this.handlers = new Map(); }
  handle(name, fn) { this.handlers.set(name, fn); }
  removeHandler(name) { this.handlers.delete(name); }
  invoke(name, event, ...args) { return this.handlers.get(name)(event, ...args); }
}
const sender = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });

function fixture(t, extra = {}) {
  const main = new Window(), created = [], ipcMain = new Ipc(), settings = { theme: 'dark', language: 'zh', uiZoom: 100 };
  const engine = { ready: Promise.resolve(), changes: null, calls: [], experiments: [],
    subscribe(listener) { this.changes = listener; return () => { this.changes = null; }; },
    async list() { return structuredClone(this.experiments); },
    async projects() { return [{ id: 'p', name: 'Project' }]; },
    async sources() { return []; },
    async aaKey(value) { this.calls.push(['aaKey', value]); return value !== null; },
    async sample(value) { this.calls.push(['sample', value]); return []; },
    async estimate(value) { this.calls.push(['estimate', value]); return { runs: 2, minutes: 2, costUsd: 0.5, basis: 'default' }; },
    async start(value) { if (this.error) throw new Error(this.error); this.calls.push(['start', value]); return 'id'; },
    async stop(value) { this.calls.push(['stop', value]); },
    async remove(value) { this.calls.push(['remove', value]); },
    close() { this.closed = true; },
    waitForQuit() { return null; },
  };
  const lab = createLab({ userData: '/unused', getProjects: () => [], getSettings: () => settings, getMainWindow: () => main,
    BrowserWindow: class extends Window { constructor(options) { super(options); created.push(this); } },
    ipcMain, engine, platform: 'win32', ...extra });
  t.after(() => lab.dispose());
  return { main, created, ipcMain, settings, engine, lab };
}

test('importing and wiring the lab before the first window never loads the engine or touches Electron safeStorage', async () => {
  const file = path.join(__dirname, '../electron/features/lab/index.cjs'), localRequire = createRequire(file);
  const module = { exports: {} }, ipcMain = new Ipc(); let engineLoads = 0, storageReads = 0;
  vm.runInNewContext(await fs.readFile(file, 'utf8'), {
    module, __dirname: path.dirname(file), process: { platform: 'darwin', versions: { electron: 'fixture' } },
    setTimeout, clearTimeout, setImmediate, clearImmediate,
    require(name) {
      if (name === './engine.cjs') { engineLoads++; throw new Error('Engine loaded before a window was shown.'); }
      if (name === 'electron') return { get safeStorage() { storageReads++; throw new Error('Keychain touched during startup.'); } };
      return localRequire(name);
    },
  });
  const lab = module.exports.createLab({ userData: '/unused', getSettings: () => ({ theme: 'dark', language: 'zh' }),
    getProjects: () => [], getMainWindow: () => null, BrowserWindow: Window, ipcMain });
  lab.sync(); assert.equal(lab.waitForQuit(), null); lab.dispose();
  assert.equal(engineLoads, 0); assert.equal(storageReads, 0); assert.equal(ipcMain.handlers.size, 0);
});

async function mainStartup(t, engineFactory) {
  const main = await fs.readFile(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const start = main.indexOf('    window = new BrowserWindow({');
  const end = main.indexOf('    for (const project of store.projects) projectImageAuto.enqueue(project);', start);
  assert.ok(start > main.indexOf('app.whenReady()') && end > start);
  const created = [], ipcMain = new Ipc(), noop = () => {};
  const context = vm.createContext({ path, root: '/fixture/app', __dirname: '/fixture/app/electron', integrationDir: '/fixture/integration',
    app: { getPath: () => '/unused' }, process: { platform: 'darwin' }, minWidth: 820, minHeight: 560,
    store: { projects: [], settings: { theme: 'dark', language: 'zh', uiZoom: 100, shortcuts: {} } },
    t: value => value, windowBackgroundColor: () => '#181818', desktopGlassWindow: false,
    BrowserWindow: class extends Window {
      constructor(options) { super(options); created.push(this); }
      async loadURL(url) { await super.loadURL(url); this.emit('ready-to-show'); }
      show() { super.show(); this.emit('show'); }
    },
    macTitlebar: null, registerMacTitlebar: noop, send: noop, broadcast: noop, screen: {},
    windowZoom: null, registerWindowZoom: () => ({ percent: 100 }), dashboardWindow: null, createDashboard: noop,
    dashboard: {}, syncDashboardLive: noop, ipcMain, devUrl: null, labWindow: null,
    createLab: options => createLab({ ...options, engineFactory }), registerWindowContents: noop,
    registerWindowLifecycle: ({ window }) => window.once('ready-to-show', () => window.show()),
    Menu: { setApplicationMenu: noop }, clipboard: {}, previewResources: {}, pictureFrom: noop,
    quitting: false, requestQuit: noop, report: noop, updateIndicators: noop, attentionTimer: null, clearTimeout,
    tray: null, Tray: class extends EventEmitter { setToolTip() {} }, trayImage: noop, trayMenu: noop,
    showWindow: noop, macMenu: noop, captureBranch: noop,
  });
  await vm.runInContext(`(async () => { ${main.slice(start, end)} })()`, context);
  t.after(() => context.labWindow.dispose());
  return { context, created, ipcMain };
}

test('the actual main-window startup creates and shows its page while lab initialization never resolves', { timeout: 3000 }, async t => {
  let calls = 0;
  const { context, created } = await mainStartup(t, () => { calls++; return new Promise(() => {}); });
  assert.equal(created.length, 1); assert.equal(context.window.shown, true);
  assert.equal(context.window.url, 'agentrix://app/index.html'); assert.equal(calls, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(context.labWindow.waitForQuit(), null);
  assert.equal(context.window.shown, true); assert.equal(context.window.isDestroyed(), false);
});

test('an engine construction failure is returned only to lab IPC after the main window has loaded', async t => {
  let calls = 0;
  const { context, created, ipcMain } = await mainStartup(t, () => { calls++; throw new Error('fixture lab initialization failure'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.window.shown, true); assert.equal(context.window.url, 'agentrix://app/index.html');
  await context.labWindow.open();
  assert.deepEqual(await ipcMain.invoke('lab:list', sender(created[1])), { ok: false, error: 'fixture lab initialization failure' });
  assert.equal(calls, 1); assert.equal(context.window.isDestroyed(), false);
});

test('disposing during deferred initialization closes a late engine without leaking its rejected readiness promise', async t => {
  let complete, closed = 0;
  const { context, ipcMain } = await mainStartup(t, () => new Promise(resolve => { complete = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  context.labWindow.dispose();
  complete({ ready: Promise.reject(new Error('fixture late initialization failure')), close() { closed++; },
    subscribe() { assert.fail('a disposed lab cannot subscribe to its engine'); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1); assert.equal(ipcMain.handlers.size, 0);
});

test('lab window has one sandboxed instance, its own preload and synchronized appearance without refocusing', async t => {
  let zoom = 90;
  const { lab, main, created, settings } = fixture(t, { getUiZoom: () => zoom });
  await Promise.all([lab.open(), lab.open()]);
  assert.equal(created.length, 1);
  const own = created[0], options = own.options, focus = own.focused;
  assert.equal(own.url, 'agentrix://app/lab.html');
  assert.equal(options.webPreferences.sandbox, true); assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false); assert.equal(options.webPreferences.nodeIntegrationInSubFrames, false);
  assert.equal(options.webPreferences.preload, path.resolve(__dirname, '../electron/features/lab/preload.cjs'));
  assert.equal(options.frame, false); assert.equal(own.webContents.zoom, 0.9);
  own.webContents.messages = [];
  settings.theme = 'light'; settings.language = 'en'; zoom = 110; lab.sync(); lab.sync();
  assert.deepEqual(own.webContents.messages, [['lab:appearance-changed', { theme: 'light', language: 'en', uiZoom: 110 }]]);
  assert.equal(own.background, '#f8f9fb'); assert.equal(own.focused, focus);
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-attach-webview']) {
    let prevented = false; own.webContents.emit(name, { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  }
  assert.deepEqual(own.webContents.openHandler({ url: 'https://example.test' }), { action: 'deny' });
  own.minimized = true; await lab.open(); assert.equal(own.minimized, false);
  assert.equal(main.focused, 0); own.close(); await lab.open(); assert.equal(created.length, 2);
});

test('lab preload resolves to its own feature directory with both POSIX and Windows path rules', async () => {
  const source = await fs.readFile(path.join(__dirname, '../electron/features/lab/window.cjs'), 'utf8');
  for (const [paths, root, platform] of [
    [path.posix, '/Applications/Agentrix', 'darwin'],
    [path.win32, 'C:\\Program Files\\Agentrix', 'win32'],
  ]) {
    const module = { exports: {} }, feature = paths.join(root, 'electron', 'features', 'lab');
    vm.runInNewContext(source, {
      module, __dirname: feature, process: { platform },
      require(name) { assert.equal(name, 'node:path'); return paths; },
    });
    let options;
    const window = module.exports.createLabWindow({
      BrowserWindow: class extends Window { constructor(value) { super(value); options = value; } },
      getSettings: () => ({ theme: 'dark', language: 'zh', uiZoom: 100 }), getMainWindow: () => null, t: value => value,
    });
    await window.open();
    assert.equal(options.webPreferences.preload, paths.join(feature, 'preload.cjs'));
    assert.equal(paths.isAbsolute(options.webPreferences.preload), true);
    assert.equal(options.icon, paths.join(root, 'assets', 'icon.png'));
    assert.equal(options.webPreferences.sandbox, true); assert.equal(options.webPreferences.nodeIntegration, false);
    window.getWindow().close();
  }
});

test('macOS lab window keeps native traffic lights and failed loads can be retried', async () => {
  let attempts = 0;
  const created = [], window = createLabWindow({ BrowserWindow: class extends Window {
    constructor(options) { super(options); created.push(this); }
    async loadURL(url) { if (++attempts === 1) throw new Error('failed page'); return super.loadURL(url); }
  }, getSettings: () => ({ theme: 'dark', language: 'zh', uiZoom: 100 }), getMainWindow: () => null,
    platform: 'darwin', devUrl: 'http://localhost:5173/', t: value => value });
  await assert.rejects(window.open(), /failed page/); assert.equal(window.getWindow(), null);
  await window.open();
  assert.equal(created[1].url, 'http://localhost:5173/lab.html'); assert.equal(created[1].options.titleBarStyle, 'hidden');
  assert.deepEqual(created[1].options.trafficLightPosition, { x: 16, y: 12 });
  created[1].close();
});

test('lab IPC requires the exact main frame and page and only the main window may open it', async t => {
  const { main, created, ipcMain, lab, engine } = fixture(t);
  const foreign = new Window();
  assert.equal((await ipcMain.invoke('lab:open', sender(foreign))).ok, false);
  assert.equal(created.length, 0);
  assert.equal((await ipcMain.invoke('lab:open', { ...sender(main), senderFrame: { url: main.webContents.mainFrame.url } })).ok, false);
  assert.equal((await ipcMain.invoke('lab:open', sender(main))).ok, true);
  const own = created[0];
  const requests = [['list'], ['projects'], ['sources'], ['aa-key', null], ['sample', {}], ['estimate', {}], ['start', {}], ['stop', 'id'], ['remove', 'id'], ['appearance']];
  for (const [action, arg] of requests) {
    assert.equal((await ipcMain.invoke('lab:' + action, sender(main), arg)).ok, false, action);
    assert.equal((await ipcMain.invoke('lab:' + action, sender(foreign), arg)).ok, false, action);
    assert.equal((await ipcMain.invoke('lab:' + action, { ...sender(own), senderFrame: { url: own.url } }, arg)).ok, false, action);
  }
  assert.equal(engine.calls.length, 0);
  for (const url of ['agentrix://app/index.html', 'agentrix://other/lab.html', 'https://app/lab.html']) {
    own.webContents.mainFrame.url = url;
    for (const [action, arg] of requests) assert.equal((await ipcMain.invoke('lab:' + action, sender(own), arg)).ok, false);
    for (const action of ['minimize', 'maximize', 'close']) ipcMain.emit('lab:' + action, sender(own));
    assert.equal(own.destroyed, undefined); assert.equal(own.maximized, undefined);
  }
  own.webContents.mainFrame.url = own.url;
  assert.deepEqual(await ipcMain.invoke('lab:projects', sender(own)), { ok: true, value: [{ id: 'p', name: 'Project' }] });
  assert.equal((await ipcMain.invoke('lab:start', sender(own), {})).value, 'id');
  assert.equal((await ipcMain.invoke('lab:open', sender(own))).ok, false);
  ipcMain.emit('lab:maximize', sender(own)); assert.equal(own.maximized, true);
  ipcMain.emit('lab:maximize', sender(own)); assert.equal(own.maximized, false);
  ipcMain.emit('lab:minimize', sender(own)); assert.equal(own.minimized, true);
  lab.dispose(); assert.equal(engine.closed, true); assert.equal(ipcMain.handlers.size, 0); assert.equal(ipcMain.eventNames().length, 0);
});

test('development lab IPC rejects wrong origins, ports and paths and returns Result failures', async t => {
  const { main, created, ipcMain, engine } = fixture(t, { devUrl: 'http://localhost:5173' });
  main.webContents.mainFrame.url = 'http://localhost:5173/';
  assert.equal((await ipcMain.invoke('lab:open', sender(main))).ok, true);
  const own = created[0];
  for (const url of ['http://localhost:5173.evil.test/lab.html', 'http://localhost:5174/lab.html', 'http://localhost:5173/index.html']) {
    own.webContents.mainFrame.url = url; assert.equal((await ipcMain.invoke('lab:list', sender(own))).ok, false);
  }
  own.webContents.mainFrame.url = own.url;
  engine.error = 'invalid settings';
  assert.deepEqual(await ipcMain.invoke('lab:start', sender(own), {}), { ok: false, error: 'invalid settings' });
  assert.deepEqual(await ipcMain.invoke('lab:appearance', sender(own)), { ok: true, value: { theme: 'dark', language: 'zh', uiZoom: 100 } });
});

test('experiment changes push the full newest list at most four times a second', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine, lab, created } = fixture(t); await lab.open();
  const own = created[0], focus = own.focused; own.webContents.messages = [];
  for (let i = 0; i < 20; i++) { engine.experiments = [{ id: i }]; engine.changes(); }
  t.mock.timers.tick(249); assert.equal(own.webContents.messages.length, 0);
  t.mock.timers.tick(1); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(own.webContents.messages, [['lab:changed', [{ id: 19 }]]]); assert.equal(own.focused, focus);
  own.close(); engine.changes(); t.mock.timers.tick(1000); assert.equal(own.webContents.messages.length, 1);
});

test('lab preload exposes exactly LabBridge and removes event listeners without exposing IPC events', async () => {
  const source = await fs.readFile(path.join(__dirname, '../electron/features/lab/preload.cjs'), 'utf8');
  const ipcRenderer = new EventEmitter(), calls = []; let name, bridge;
  ipcRenderer.invoke = (...args) => { calls.push(args); return Promise.resolve({ ok: true }); };
  ipcRenderer.send = (...args) => calls.push(args);
  vm.runInNewContext(source, { require: key => {
    assert.equal(key, 'electron');
    return { ipcRenderer, contextBridge: { exposeInMainWorld(key, value) { name = key; bridge = value; } } };
  } });
  assert.equal(name, 'agentrixLab');
  assert.deepEqual(Object.keys(bridge).sort(), ['aaKey', 'appearance', 'close', 'estimate', 'list', 'maximize', 'minimize', 'onAppearance', 'onChange', 'projects', 'remove', 'sample', 'sources', 'start', 'stop']);
  await bridge.list(); await bridge.projects(); await bridge.sample({ size: 1 }); await bridge.estimate({}); await bridge.start({});
  await bridge.stop('id'); await bridge.remove('id'); await bridge.appearance(); bridge.close(); bridge.minimize(); bridge.maximize();
  await bridge.sources(); await bridge.aaKey(null);
  assert.deepEqual(calls, [['lab:list'], ['lab:projects'], ['lab:sample', { size: 1 }], ['lab:estimate', {}], ['lab:start', {}],
    ['lab:stop', 'id'], ['lab:remove', 'id'], ['lab:appearance'], ['lab:close'], ['lab:minimize'], ['lab:maximize'], ['lab:sources'], ['lab:aa-key', null]]);
  let experiments, appearance;
  const off = bridge.onChange(value => { experiments = value; }), offAppearance = bridge.onAppearance(value => { appearance = value; });
  ipcRenderer.emit('lab:changed', { secret: true }, [{ id: 'a' }]); ipcRenderer.emit('lab:appearance-changed', {}, { theme: 'light' });
  assert.deepEqual(experiments, [{ id: 'a' }]); assert.deepEqual(appearance, { theme: 'light' });
  off(); offAppearance(); assert.equal(ipcRenderer.eventNames().length, 0);
});

test('macOS Virtual Lab is beside settings and invokes its dedicated callback', () => {
  let opened = 0;
  const template = buildMacMenuTemplate({ appName: 'Agentrix', t: value => value, openLab: () => opened++ });
  const items = template[0].submenu, settings = items.findIndex(item => item.label === '设置…');
  assert.equal(items[settings + 1].label, '虚拟实验室'); items[settings + 1].click(); assert.equal(opened, 1);
});
