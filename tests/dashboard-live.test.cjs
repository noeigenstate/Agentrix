const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createDashboard } = require('../electron/features/dashboard/index.cjs');
const { DashboardRecords } = require('../electron/features/dashboard/records.cjs');

const NOW = new Date(2026, 10, 2, 12).getTime(), DAY = 86400000;
const query = { projectId: null, range: '7d' };

class FakeWindow extends EventEmitter {
  constructor() {
    super(); this.focused = 0;
    const contents = this.webContents = new EventEmitter();
    Object.assign(contents, { mainFrame: { url: 'agentrix://app/index.html' }, messages: [],
      getZoomFactor: () => 1, setZoomFactor() {}, setZoomMode() {}, setWindowOpenHandler() {},
      send: (...args) => contents.messages.push(args) });
  }
  isDestroyed() { return !!this.destroyed; }
  isMinimized() { return false; }
  getMinimumSize() { return this.minimum ?? [0, 0]; }
  setMinimumSize(width, height) { this.minimum = [width, height]; }
  getContentSize() { return this.size ?? [1180, 820]; }
  setContentSize(width, height) { this.size = [width, height]; }
  setBackgroundColor() {}
  async loadURL(url) { this.webContents.mainFrame.url = url; this.webContents.emit('did-finish-load'); }
  show() {}
  focus() { this.focused++; }
  close() { this.destroyed = true; this.emit('closed'); }
}

async function lab(t, extra = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-live-')));
  const created = [], records = new DashboardRecords(directory), main = new FakeWindow();
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  const dashboard = createDashboard({ userData: directory, records, getProjects: () => [{ id: 'p', name: 'P', kind: 'local', path: directory }],
    getSettings: () => ({ theme: 'dark', language: 'zh', uiZoom: 100 }), getMainWindow: () => main, ipcMain, t: value => value,
    BrowserWindow: class extends FakeWindow { constructor() { super(); created.push(this); } }, ...extra });
  t.after(async () => { dashboard.dispose(); await records.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, dashboard, records, created };
}

const changed = window => window.webContents.messages.filter(([channel]) => channel === 'dashboard:changed');

test('an open dashboard refreshes on each minute, advances its range, and stops on close or dispose', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const { dashboard, records, created } = await lab(t);
  await fs.mkdir(records.directory);
  await fs.writeFile(records.file('runs'), JSON.stringify({ v: 1, id: 'edge', at: NOW - 7 * DAY + 30_000,
    projectId: 'p', model: 'gpt-6.1-sol', agent: 'codex', source: 'dispatch', reason: 'exit', exitCode: 0 }) + '\n');
  await dashboard.open(); const own = created[0], focus = own.focused;
  assert.equal((await dashboard.summary(query)).models[0].tasks, 1);
  t.mock.timers.tick(59_999); assert.equal(changed(own).length, 0);
  t.mock.timers.tick(1); assert.equal(changed(own).length, 1);
  const fresh = await dashboard.summary(query);
  assert.equal(fresh.generatedAt, NOW + 60_000); assert.deepEqual(fresh.models, []);
  assert.equal(own.focused, focus);
  own.close(); t.mock.timers.tick(120_000);
  assert.equal(changed(own).length, 1);
  await Promise.all([dashboard.open(), dashboard.open()]);
  t.mock.timers.tick(60_000); assert.equal(changed(created[1]).length, 1, 'reopening creates one minute timer');
  dashboard.dispose();
  t.mock.timers.tick(120_000); assert.equal(changed(created[1]).length, 1);
});
