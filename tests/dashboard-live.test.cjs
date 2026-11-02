const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createDashboard } = require('../electron/features/dashboard/index.cjs');
const { DashboardRecords, QUOTA_INTERVAL } = require('../electron/features/dashboard/records.cjs');
const { DashboardDecisions } = require('../electron/features/dashboard/decisions.cjs');

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
  const created = [], records = new DashboardRecords(directory), decisions = new DashboardDecisions(directory), main = new FakeWindow();
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  const journals = { starts: 0, stops: 0, async start() { this.starts++; }, stop() { this.stops++; }, async sync() {}, async read() { return []; } };
  const dashboard = createDashboard({ userData: directory, records, decisions, journals, getProjects: () => [{ id: 'p', name: 'P', kind: 'local', path: directory }],
    getSettings: () => ({ theme: 'dark', language: 'zh', uiZoom: 100 }), getMainWindow: () => main, ipcMain, t: value => value,
    BrowserWindow: class extends FakeWindow { constructor() { super(); created.push(this); } }, ...extra });
  t.after(async () => { dashboard.dispose(); await records.flush(); await decisions.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, dashboard, records, decisions, journals, created };
}

const liveRun = (id = 'dispatch:one', extra = {}) => ({ id, project: 'p', agent: 'Codex', model: 'gpt-6.1-sol',
  title: 'Synthetic task', role: '执行', startedAt: NOW - 5000,
  rate: { outputTokens: 20, activeMs: 1000, samples: 1, updatedAt: NOW, partial: false }, ...extra });
const changed = window => window.webContents.messages.filter(([channel]) => channel === 'dashboard:changed');

test('an open dashboard refreshes on each minute, advances its range, and stops on close or dispose', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const { dashboard, records, journals, created } = await lab(t);
  await fs.mkdir(records.directory);
  await fs.writeFile(records.file('runs'), JSON.stringify({ v: 1, id: 'edge', at: NOW - 7 * DAY + 30_000,
    projectId: 'p', model: 'gpt-6.1-sol', agent: 'codex' }) + '\n');
  await dashboard.open(); const own = created[0], focus = own.focused;
  assert.equal((await dashboard.summary(query)).kpis.runs, 1);
  t.mock.timers.tick(59_999); assert.equal(changed(own).length, 0);
  t.mock.timers.tick(1); assert.equal(changed(own).length, 1);
  const fresh = await dashboard.summary(query);
  assert.equal(fresh.generatedAt, NOW + 60_000); assert.equal(fresh.kpis.runs, 0);
  assert.equal(journals.starts, 2); assert.equal(own.focused, focus);
  own.close(); t.mock.timers.tick(120_000);
  assert.equal(changed(own).length, 1); assert.equal(journals.starts, 2);
  await Promise.all([dashboard.open(), dashboard.open()]);
  t.mock.timers.tick(60_000); assert.equal(changed(created[1]).length, 1, 'reopening creates one minute timer');
  dashboard.dispose(); const starts = journals.starts;
  t.mock.timers.tick(120_000); assert.equal(journals.starts, starts);
});

test('live calls keep the latest snapshot, throttle progress with a trailing push, and never refocus', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const { dashboard, created } = await lab(t);
  const initial = liveRun(); dashboard.live([initial]);
  initial.title = 'Changed by the caller'; initial.rate.outputTokens = 900;
  await dashboard.open(); const own = created[0], focus = own.focused;
  const before = await dashboard.summary(query);
  assert.equal(before.live.at, NOW); assert.equal(before.live.running[0].title, 'Synthetic task');
  assert.equal(before.live.running[0].tokensPerSecond, 20);
  dashboard.live([liveRun('dispatch:one', { title: 'First progress' })]);
  t.mock.timers.tick(999); assert.equal(changed(own).length, 0);
  t.mock.timers.tick(1); assert.equal(changed(own).length, 1);
  t.mock.timers.tick(1000); dashboard.live([liveRun('dispatch:one', { title: 'Middle' })]);
  t.mock.timers.tick(3000); dashboard.live([liveRun('dispatch:one', { title: 'Newest' })]);
  t.mock.timers.tick(999); assert.equal(changed(own).length, 1);
  t.mock.timers.tick(1); assert.equal(changed(own).length, 2);
  assert.equal((await dashboard.summary(query)).live.running[0].title, 'Newest');
  dashboard.live([]); t.mock.timers.tick(5000);
  assert.equal(changed(own).length, 3); assert.deepEqual((await dashboard.summary(query)).live.running, []);
  assert.equal(own.focused, focus);
  own.close(); dashboard.live([liveRun()]); t.mock.timers.tick(5000);
  await dashboard.open(); assert.equal((await dashboard.summary(query)).live.running.length, 1);
});

test('live snapshots retain global project keys, preserve unknown and zero rates, and drop private fields', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const { dashboard, created } = await lab(t); await dashboard.open();
  const input = [liveRun('agent:unknown', { project: 'other', startedAt: NaN, rate: null, cwd: 'private-fixture', body: 'private-fixture' }),
    liveRun('agent:zero', { project: null, rate: { outputTokens: 0, activeMs: 100, samples: 1 } }),
    liveRun('agent:empty', { rate: { outputTokens: 0, activeMs: 0, samples: 0 } }),
    liveRun('agent:overflow', { rate: { outputTokens: Number.MAX_VALUE, activeMs: 1, samples: 1 } })];
  dashboard.live(input);
  const summary = await dashboard.summary({ ...query, projectId: 'p' });
  assert.equal(summary.live.running.length, 4, 'the renderer filters global live calls by project');
  const unknown = summary.live.running.find(row => row.id === 'agent:unknown');
  assert.equal(unknown.project, 'other'); assert.equal(unknown.startedAt, null); assert.equal(unknown.tokensPerSecond, null);
  assert.equal(summary.live.running.find(row => row.id === 'agent:zero').tokensPerSecond, 0);
  assert.equal(summary.live.running.find(row => row.id === 'agent:empty').tokensPerSecond, null);
  assert.equal(summary.live.running.find(row => row.id === 'agent:overflow').tokensPerSecond, null);
  assert.ok(!JSON.stringify(summary.live).includes('private-fixture'));
  t.mock.timers.tick(1000); const pushes = changed(created[0]).length;
  dashboard.live(input.slice().reverse()); t.mock.timers.tick(6000);
  assert.equal(changed(created[0]).length, pushes, 'unchanged snapshots do not push just because the calls reordered');
  summary.live.running[0].title = 'Mutated reply';
  assert.ok((await dashboard.summary(query)).live.running.every(row => row.title !== 'Mutated reply'));
});

test('minute discovery finds a newly initialized repository without closing the dashboard', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const { directory, dashboard } = await lab(t, { journals: undefined });
  await dashboard.open(); assert.deepEqual((await dashboard.summary(query)).rounds, []);
  execFileSync('git', ['init', '-q'], { cwd: directory, windowsHide: true, stdio: 'ignore' });
  const journalDirectory = path.join(directory, '.git', 'agentrix'); await fs.mkdir(journalDirectory);
  await fs.writeFile(path.join(journalDirectory, 'journal.jsonl'), JSON.stringify({ type: 'consolidate', meeting: 'new-repository', time: NOW }) + '\n');
  assert.deepEqual((await dashboard.summary(query)).rounds, [], 'reads do not bypass the negative-probe cache');
  t.mock.timers.tick(60_000);
  // Reading joins the in-flight minute discovery, without an explicit open retry.
  assert.equal((await dashboard.summary(query)).rounds[0].meeting, 'new-repository');
});

test('latest quota readings refresh the dashboard while durable history remains throttled', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const { dashboard, records, created } = await lab(t); await dashboard.open();
  records.quota('codex', [{ minutes: 300, percent: 10 }], 'synthetic-scope'); await records.flush();
  t.mock.timers.tick(1000); const pushes = changed(created[0]).length;
  records.quota('codex', [{ minutes: 300, percent: 25 }], 'synthetic-scope');
  assert.deepEqual((await records.read('quota')).map(record => record.windows[0].percent), [10]);
  assert.equal((await dashboard.summary(query)).kpis.quota.percent, 25);
  t.mock.timers.tick(1000); assert.equal(changed(created[0]).length, pushes + 1);
  // Closing the window cancels its heartbeat, not the record store's trailing durability timer.
  created[0].close(); t.mock.timers.tick(QUOTA_INTERVAL);
  assert.deepEqual((await records.read('quota')).map(record => record.windows[0].percent), [10, 25]);
});

test('successful decision writes join record refreshes and invalid decisions never invalidate the dashboard', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const { dashboard, decisions, records, created } = await lab(t); await dashboard.open();
  const weight = { model: 'gpt-6.1-sol', kind: 'core', from: 1, to: 0.8 };
  decisions.subscribe(() => { throw new Error('synthetic observer failure'); });
  assert.equal(await decisions.decide('synthetic-decision', 'adopted', weight), true);
  await records.append('runs', {});
  t.mock.timers.tick(999); assert.equal(changed(created[0]).length, 0);
  t.mock.timers.tick(1); assert.equal(changed(created[0]).length, 1);
  assert.deepEqual((await dashboard.summary(query)).weights, [weight]);
  assert.equal(await decisions.decide('synthetic-decision', 'invalid', weight), false);
  t.mock.timers.tick(1000); assert.equal(changed(created[0]).length, 1);
});
