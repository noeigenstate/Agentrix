const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
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

test('lab window has one sandboxed instance, its own preload and synchronized appearance without refocusing', async t => {
  let zoom = 90;
  const { lab, main, created, settings } = fixture(t, { getUiZoom: () => zoom });
  await Promise.all([lab.open(), lab.open()]);
  assert.equal(created.length, 1);
  const own = created[0], options = own.options, focus = own.focused;
  assert.equal(own.url, 'agentrix://app/lab.html');
  assert.equal(options.webPreferences.sandbox, true); assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false); assert.equal(options.webPreferences.nodeIntegrationInSubFrames, false);
  assert.ok(options.webPreferences.preload.endsWith('lab/preload.cjs'));
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
  const requests = [['list'], ['projects'], ['sample', {}], ['estimate', {}], ['start', {}], ['stop', 'id'], ['remove', 'id'], ['appearance']];
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
  assert.deepEqual(Object.keys(bridge).sort(), ['appearance', 'close', 'estimate', 'list', 'maximize', 'minimize', 'onAppearance', 'onChange', 'projects', 'remove', 'sample', 'start', 'stop']);
  await bridge.list(); await bridge.projects(); await bridge.sample({ size: 1 }); await bridge.estimate({}); await bridge.start({});
  await bridge.stop('id'); await bridge.remove('id'); await bridge.appearance(); bridge.close(); bridge.minimize(); bridge.maximize();
  assert.deepEqual(calls, [['lab:list'], ['lab:projects'], ['lab:sample', { size: 1 }], ['lab:estimate', {}], ['lab:start', {}],
    ['lab:stop', 'id'], ['lab:remove', 'id'], ['lab:appearance'], ['lab:close'], ['lab:minimize'], ['lab:maximize']]);
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
