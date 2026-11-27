const { loadPreload } = require('./helpers/load-with-stubs.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createDashboardWindow } = require('../electron/features/dashboard/window.cjs');
const { createDashboard } = require('../electron/features/dashboard/index.cjs');
const { DashboardRecords } = require('../electron/features/dashboard/records.cjs');

class Contents extends EventEmitter {
  constructor(url = 'agentrix://app/index.html') { super(); this.mainFrame = { url }; this.zoom = 1; this.messages = []; }
  setZoomMode(value) { this.zoomMode = value; }
  setZoomFactor(value) { this.zoom = value; }
  getZoomFactor() { return this.zoom; }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
  send(...args) { this.messages.push(args); }
}
class FakeWindow extends EventEmitter {
  constructor(options = {}) { super(); this.options = options; this.webContents = new Contents(); this.focused = 0; this.shown = 0; }
  isDestroyed() { return !!this.destroyed; }
  isMinimized() { return !!this.minimized; }
  isMaximized() { return !!this.maximized; }
  restore() { this.minimized = false; }
  show() { this.shown++; }
  focus() { this.focused++; }
  close() { this.destroyed = true; this.emit('closed'); }
  minimize() { this.minimized = true; }
  maximize() { this.maximized = true; }
  unmaximize() { this.maximized = false; }
  getMinimumSize() { return this.minimum ?? [this.options.minWidth ?? 0, this.options.minHeight ?? 0]; }
  setMinimumSize(width, height) { this.minimum = [width, height]; }
  getContentSize() { return this.size ?? [this.options.width, this.options.height]; }
  setContentSize(width, height) { const minimum = this.getMinimumSize(); this.size = [Math.max(width, minimum[0]), Math.max(height, minimum[1])]; }
  setBackgroundColor(value) { this.background = value; }
  async loadURL(url) { this.url = url; this.webContents.mainFrame.url = url; this.webContents.emit('did-finish-load'); }
}
class FakeIpc extends EventEmitter {
  constructor() { super(); this.handlers = new Map(); }
  handle(name, fn) { this.handlers.set(name, fn); }
  removeHandler(name) { this.handlers.delete(name); }
  invoke(name, event, ...args) { return this.handlers.get(name)(event, ...args); }
}
const sender = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
const query = { projectId: null, range: 'all' };

function windowLab(extra = {}) {
  const created = [], main = new FakeWindow();
  const settings = { theme: 'dark', language: 'zh', uiZoom: null };
  const window = createDashboardWindow({ BrowserWindow: class extends FakeWindow { constructor(options) { super(options); created.push(this); } },
    getSettings: () => settings, getMainWindow: () => main, t: value => value, platform: 'win32', ...extra });
  return { created, main, settings, window };
}

async function lab(t, extra = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-window-')));
  const created = [], main = new FakeWindow(), ipcMain = new FakeIpc();
  const settings = { theme: 'dark', language: 'zh', uiZoom: 100 };
  const records = new DashboardRecords(directory, { now: () => 9000 });
  const dashboard = createDashboard({ userData: directory, getProjects: () => [{ id: 'p', name: 'Project', kind: 'local', path: directory }],
    getSettings: () => settings, getMainWindow: () => main, BrowserWindow: class extends FakeWindow {
      constructor(options) { super(options); created.push(this); }
    }, ipcMain, records, platform: 'win32', now: () => 10000, ...extra });
  t.after(async () => { dashboard.dispose(); await records.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, created, main, ipcMain, settings, records, dashboard };
}

test('dashboard window is a single sandboxed instance with its own preload and main-window zoom', async () => {
  const { created, main, window } = windowLab();
  main.webContents.zoom = 0.85;
  await Promise.all([window.open(), window.open()]);
  assert.equal(created.length, 1);
  const selected = created[0], options = selected.options;
  assert.equal(options.frame, false);
  assert.equal(options.show, false); assert.equal(options.backgroundColor, '#181818');
  assert.deepEqual({ ...options.webPreferences, preload: path.relative(path.resolve(__dirname, '..'), options.webPreferences.preload).split(path.sep).join('/') }, {
    preload: 'electron/features/dashboard/preload.cjs', nodeIntegration: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false,
  });
  assert.equal(selected.url, 'agentrix://app/dashboard.html'); assert.equal(selected.webContents.zoomMode, 'isolated');
  assert.equal(selected.webContents.zoom, 0.85);
  selected.minimized = true; await window.open();
  assert.equal(selected.minimized, false); assert.ok(selected.shown > 0); assert.ok(selected.focused > 0);
  selected.close(); await window.open(); assert.equal(created.length, 2);
});

test('dashboard initial and minimum dimensions use content sizes on every platform', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const { created, window } = windowLab({ platform });
    await window.open();
    const options = created[0].options;
    assert.equal(options.useContentSize, true, `${platform}: sizes must exclude the native frame`);
    assert.deepEqual([options.width, options.height], [1180, 820]);
    assert.deepEqual([options.minWidth, options.minHeight], [820, 600]);
  }
});

test('Windows native frame rounding preserves the exact content minimum before the dashboard is shown', async () => {
  for (const { frame, rounding } of [{ frame: [0, 0], rounding: [0, 0] }, { frame: [14, 7], rounding: [1, 2] },
    { frame: [0, 0], rounding: [4, -4] }, { frame: [0, 0], rounding: [-4, 4] }]) {
    let selected;
    const { window } = windowLab({ BrowserWindow: class extends FakeWindow {
      constructor(options) {
        super(options); selected = this;
        this.minimum = [options.minWidth + frame[0], options.minHeight + frame[1]];
      }
      setMinimumSize(width, height) { assert.equal(this.shown, 0); super.setMinimumSize(width, height); }
      setContentSize(width, height) {
        this.size = [Math.max(width, this.minimum[0] - frame[0] + rounding[0]),
          Math.max(height, this.minimum[1] - frame[1] + rounding[1])];
      }
    } });
    await window.open();
    assert.deepEqual(selected.getContentSize(), [1180, 820]);
    for (const size of [[820, 600], [900, 820], [1180, 820]]) {
      selected.setContentSize(...size);
      assert.deepEqual(selected.getContentSize(), size);
    }
    selected.setContentSize(1, 1);
    assert.deepEqual(selected.getContentSize(), [820, 600], 'smaller requests still clamp to the content minimum');
  }
});

test('Windows skips minimum calibration when either content dimension is not clamped within four pixels', async () => {
  for (const content of [[1, 1], [820, 1], [1, 600], [825, 600], [815, 600], [820, 605], [820, 595]]) {
    let selected;
    const { window } = windowLab({ BrowserWindow: class extends FakeWindow {
      constructor(options) { super(options); selected = this; }
      setMinimumSize() { assert.fail(`unclamped content ${content} must not change the minimum`); }
      setContentSize(width, height) { this.size = width === 1 && height === 1 ? content : [width, height]; }
    } });
    await window.open();
    assert.deepEqual(selected.getMinimumSize(), [820, 600]);
    assert.deepEqual(selected.getContentSize(), [1180, 820]); assert.equal(selected.shown, 1);
  }
});

test('macOS title bar and development URL follow the dashboard window contract', async () => {
  const { created, window } = windowLab({ platform: 'darwin', devUrl: 'http://localhost:5173/' });
  await window.open();
  assert.equal(created[0].options.titleBarStyle, 'hidden'); assert.equal(created[0].options.frame, undefined);
  assert.deepEqual(created[0].options.trafficLightPosition, { x: 16, y: 12 });
  assert.equal(created[0].url, 'http://localhost:5173/dashboard.html');
});

test('dashboard refuses navigation, child frames, webviews and new windows', async () => {
  const { window, created } = windowLab(); await window.open();
  const contents = created[0].webContents;
  for (const event of ['will-navigate', 'will-frame-navigate', 'will-attach-webview']) {
    let prevented = false; contents.emit(event, { preventDefault() { prevented = true; } }); assert.equal(prevented, true, event);
  }
  assert.deepEqual(contents.openHandler({ url: 'https://example.test' }), { action: 'deny' });
});

test('appearance changes push only current theme, language and effective zoom without focusing the window', async () => {
  let zoom = 100;
  const { window, created, settings } = windowLab({ getUiZoom: () => zoom });
  await window.open(); const selected = created[0], focus = selected.focused;
  selected.webContents.messages = [];
  settings.theme = 'light'; settings.language = 'en'; zoom = 90;
  window.sync(); window.sync();
  assert.deepEqual(selected.webContents.messages, [['dashboard:appearance-changed', { theme: 'light', language: 'en', uiZoom: 90 }]]);
  assert.equal(selected.background, '#f8f9fb'); assert.equal(selected.webContents.zoom, 0.9); assert.equal(selected.focused, focus);
  selected.webContents.zoom = 1.5; selected.webContents.emit('zoom-changed'); assert.equal(selected.webContents.zoom, 0.9);
});

test('a failed page load releases the singleton so a later explicit open can retry', async () => {
  let attempts = 0;
  const { window, created } = windowLab({ BrowserWindow: class extends FakeWindow {
    constructor(options) { super(options); created.push(this); }
    async loadURL(url) { if (++attempts === 1) throw new Error('failed page'); return super.loadURL(url); }
  } });
  await assert.rejects(window.open(), /failed page/); assert.equal(window.getWindow(), null);
  await window.open(); assert.equal(attempts, 2); assert.equal(created.length, 2);
});

test('open accepts only the main main-frame and every other dashboard IPC accepts only the dashboard main-frame', async t => {
  const { ipcMain, main, created, dashboard } = await lab(t);
  const foreign = new FakeWindow();
  assert.equal((await ipcMain.invoke('dashboard:open', sender(foreign))).ok, false);
  assert.equal(created.length, 0);
  assert.equal((await ipcMain.invoke('dashboard:open', { ...sender(main), senderFrame: { url: main.webContents.mainFrame.url } })).ok, false);
  assert.equal((await ipcMain.invoke('dashboard:open', sender(main))).ok, true);
  const own = created[0];
  assert.equal((await ipcMain.invoke('dashboard:open', sender(own))).ok, false);
  for (const [channel, args] of [['dashboard:summary', [query]], ['dashboard:appearance', []]]) {
    assert.equal((await ipcMain.invoke(channel, sender(main), ...args)).ok, false, channel);
    assert.equal((await ipcMain.invoke(channel, sender(foreign), ...args)).ok, false, channel);
    assert.equal((await ipcMain.invoke(channel, { ...sender(own), senderFrame: { url: own.url } }, ...args)).ok, false, channel);
  }
  assert.equal((await ipcMain.invoke('dashboard:summary', sender(own), query)).ok, true);
  own.webContents.mainFrame.url = 'agentrix://app/index.html';
  assert.equal((await ipcMain.invoke('dashboard:appearance', sender(own))).ok, false);
  own.webContents.mainFrame.url = 'https://app/dashboard.html';
  assert.equal((await ipcMain.invoke('dashboard:appearance', sender(own))).ok, false);
  own.webContents.mainFrame.url = own.url;
  dashboard.dispose(); assert.equal(ipcMain.handlers.size, 0); assert.equal(ipcMain.eventNames().length, 0);
});

test('development IPC checks the precise page and origin rather than a URL prefix', async t => {
  const { ipcMain, main, created } = await lab(t, { devUrl: 'http://localhost:5173' });
  main.webContents.mainFrame.url = 'http://localhost:5173/';
  assert.equal((await ipcMain.invoke('dashboard:open', sender(main))).ok, true);
  const own = created[0];
  for (const bad of ['http://localhost:5173.evil.test/dashboard.html', 'http://localhost:5174/dashboard.html', 'http://localhost:5173/other.html']) {
    own.webContents.mainFrame.url = bad; assert.equal((await ipcMain.invoke('dashboard:appearance', sender(own))).ok, false, bad);
  }
  own.webContents.mainFrame.url = own.url;
  assert.equal((await ipcMain.invoke('dashboard:appearance', sender(own))).ok, true);
});

test('window button events are sender checked and maximize toggles without adding bridge capabilities', async t => {
  const { ipcMain, main, created, dashboard } = await lab(t); await dashboard.open(); const own = created[0];
  for (const action of ['minimize', 'maximize', 'close']) ipcMain.emit(`dashboard:${action}`, sender(main));
  assert.equal(own.minimized, undefined); assert.equal(own.maximized, undefined); assert.equal(own.destroyed, undefined);
  ipcMain.emit('dashboard:maximize', sender(own)); assert.equal(own.maximized, true);
  ipcMain.emit('dashboard:maximize', sender(own)); assert.equal(own.maximized, false);
  ipcMain.emit('dashboard:minimize', sender(own)); assert.equal(own.minimized, true);
  ipcMain.emit('dashboard:close', sender(own)); assert.equal(own.destroyed, true);
});

test('all dashboard handlers and buttons reject subframes, navigated pages and destroyed windows', async t => {
  const { ipcMain, main, created, dashboard } = await lab(t); await dashboard.open(); const own = created[0];
  const requests = [['dashboard:summary', [query]], ['dashboard:appearance', []]];
  for (const url of ['agentrix://app/index.html', 'agentrix://other/dashboard.html', 'https://app/dashboard.html']) {
    own.webContents.mainFrame.url = url;
    for (const [channel, args] of requests) assert.equal((await ipcMain.invoke(channel, sender(own), ...args)).ok, false);
    for (const action of ['minimize', 'maximize', 'close']) ipcMain.emit(`dashboard:${action}`, sender(own));
    assert.equal(own.minimized, undefined); assert.equal(own.maximized, undefined); assert.equal(own.destroyed, undefined);
  }
  own.webContents.mainFrame.url = own.url;
  const child = { ...sender(own), senderFrame: { url: own.url } };
  for (const action of ['minimize', 'maximize', 'close']) ipcMain.emit(`dashboard:${action}`, child);
  assert.equal(own.destroyed, undefined); assert.equal(own.minimized, undefined); assert.equal(own.maximized, undefined);
  own.destroyed = true;
  for (const [channel, args] of requests) assert.equal((await ipcMain.invoke(channel, sender(own), ...args)).ok, false);
  main.webContents.mainFrame.url = own.url;
  assert.equal((await ipcMain.invoke('dashboard:open', sender(main))).ok, false);
});

test('summary validates its query and reads the run records through the dashboard frame only', async t => {
  const { dashboard, ipcMain, created, records } = await lab(t);
  await records.append('runs', { id: 'r1', projectId: 'p', project: 'Project', agent: 'codex', source: 'dispatch', model: 'gpt-6.1-sol',
    kind: 'core', reason: 'exit', exitCode: 0, outOfScope: 0, checks: { passed: 2, failed: 0, skipped: 0 } });
  await dashboard.open(); const own = created[0];
  const result = await ipcMain.invoke('dashboard:summary', sender(own), query);
  assert.equal(result.ok, true); assert.deepEqual(result.value.query, query);
  assert.deepEqual(result.value.models.map(row => [row.model, row.tasks, row.passed]), [['gpt-6.1-sol', 1, 1]]);
  assert.equal(ipcMain.handlers.has('dashboard:decide'), false);
  for (const bad of [null, {}, { projectId: null, range: 'year' }, { ...query, path: 'not accepted' }, { ...query, projectId: '' }]) {
    assert.equal((await ipcMain.invoke('dashboard:summary', sender(own), bad)).ok, false);
  }
});

test('only persisted runs refresh the dashboard, coalesced without refocusing the window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { dashboard, records, created } = await lab(t); await dashboard.open(); const own = created[0], focus = own.focused;
  own.webContents.messages = [];
  await records.append('grades', {}); await records.append('quota', {});
  t.mock.timers.tick(1000); assert.deepEqual(own.webContents.messages, []);
  await records.append('runs', {}); await records.append('runs', {});
  t.mock.timers.tick(999); assert.deepEqual(own.webContents.messages, []);
  t.mock.timers.tick(1); assert.deepEqual(own.webContents.messages, [['dashboard:changed']]); assert.equal(own.focused, focus);
  own.close(); await records.append('runs', {}); t.mock.timers.tick(2000);
  assert.equal(own.webContents.messages.length, 1);
});

test('dashboard preload exposes exactly DashboardBridge and subscriptions remove their listeners', async () => {
  const ipcRenderer = new EventEmitter(), calls = []; let name, bridge;
  ipcRenderer.invoke = (...args) => { calls.push(args); return Promise.resolve({ ok: true }); };
  ipcRenderer.send = (...args) => calls.push(args);
  loadPreload('electron/features/dashboard/preload.cjs', { ipcRenderer, contextBridge: {
    exposeInMainWorld(key, value) { name = key; bridge = value; },
  } });
  assert.equal(name, 'agentrixDashboard');
  assert.deepEqual(Object.keys(bridge).sort(), ['appearance', 'close', 'maximize', 'minimize', 'onAppearance', 'onChanged', 'summary']);
  await bridge.summary(query); await bridge.appearance();
  bridge.close(); bridge.minimize(); bridge.maximize();
  assert.deepEqual(calls, [['dashboard:summary', query], ['dashboard:appearance'],
    ['dashboard:close'], ['dashboard:minimize'], ['dashboard:maximize']]);
  let appearance, changed = 0;
  const stopAppearance = bridge.onAppearance(value => { appearance = value; });
  const stopChanged = bridge.onChanged((...args) => { assert.equal(args.length, 0); changed++; });
  const value = { theme: 'light', language: 'zh', uiZoom: 100 };
  ipcRenderer.emit('dashboard:appearance-changed', { secretEvent: true }, value); ipcRenderer.emit('dashboard:changed', { secretEvent: true });
  assert.deepEqual(appearance, value); assert.equal(changed, 1);
  stopAppearance(); stopChanged(); assert.equal(ipcRenderer.eventNames().length, 0);
});
