const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { WorkspaceStore } = require('../electron/state.cjs');
const { BETA_AGREEMENT_VERSION, UpdateManager } = require('../electron/updates.cjs');
const { createIpcAdapter } = require('../electron/shared/ipc.cjs');
const { registerUpdatesIpc } = require('../electron/features/updates/ipc.cjs');

function fixture(t, { supported = true, channel = 'stable', betaAgreement = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-update-ipc-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'workspace.json'), store = new WorkspaceStore(file);
  store.updateSettings({ updateChannel: channel, betaAgreement });
  const updater = supported ? new EventEmitter() : null;
  let checks = 0;
  if (updater) updater.checkForUpdates = async () => { checks++; return { isUpdateAvailable: false }; };
  const states = [], handlers = new Map();
  const manager = new UpdateManager({ updater, version: '1.3.26', channel, betaAgreement, onChange: state => states.push(state) });
  t.after(() => manager.dispose());
  const webContents = { mainFrame: { url: 'agentrix://app/index.html' } };
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const adapter = createIpcAdapter({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getWindow: () => ({ webContents }), t: text => text });
  registerUpdatesIpc({ ...adapter, updateManager: manager, updateSettings: patch => store.updateSettings(patch) });
  return { file, store, manager, updater, states, checks: () => checks, invoke: (...args) => handlers.get('updates:set-channel')(event, ...args) };
}

test('IPC refuses beta without the current agreement before persistence, reconfiguration or checks', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file, 'utf8');
  for (const version of [undefined, null, '', 'old-agreement', true, {}, [BETA_AGREEMENT_VERSION]]) {
    assert.deepEqual(await f.invoke('beta', version), { ok: false, error: '请先阅读并同意测试协议。' });
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    assert.equal(f.updater.allowPrerelease, false);
    assert.equal(f.checks(), 0);
    assert.deepEqual(f.states, []);
  }
});

test('IPC accepts current beta consent, persists it, broadcasts the new state and starts a check', async t => {
  const f = fixture(t);
  const result = await f.invoke('beta', BETA_AGREEMENT_VERSION);
  assert.equal(result.ok, true);
  assert.equal(result.value.channel, 'beta');
  assert.equal(result.value.agreementVersion, BETA_AGREEMENT_VERSION);
  assert.equal(result.value.agreed, true);
  assert.equal(f.updater.allowPrerelease, true);
  assert.equal(f.updater.allowDowngrade, false);
  assert.equal(f.checks(), 1);
  assert.deepEqual(f.states.at(-1), result.value);
  const restored = new WorkspaceStore(f.file);
  assert.equal(restored.settings.updateChannel, 'beta');
  assert.equal(restored.settings.betaAgreement, BETA_AGREEMENT_VERSION);
});

test('IPC always allows stable, without accepting or erasing an agreement', async t => {
  for (const betaAgreement of [null, 'old-agreement', BETA_AGREEMENT_VERSION]) {
    const f = fixture(t, { channel: 'beta', betaAgreement });
    const result = await f.invoke('stable', 'not-an-acceptance');
    assert.equal(result.ok, true);
    assert.equal(result.value.channel, 'stable');
    assert.equal(result.value.agreed, betaAgreement === BETA_AGREEMENT_VERSION);
    assert.equal(f.updater.allowPrerelease, false);
    assert.equal(f.updater.allowDowngrade, false);
    assert.equal(f.checks(), 1);
    assert.equal(new WorkspaceStore(f.file).settings.betaAgreement, betaAgreement);
  }
});

test('invalid IPC channels are refused without changing saved settings', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file, 'utf8');
  for (const channel of ['latest', '', 'Beta', null, undefined, true, {}, ['beta']]) {
    assert.deepEqual(await f.invoke(channel, BETA_AGREEMENT_VERSION), { ok: false, error: '未知的更新通道。' });
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  }
  assert.equal(f.checks(), 0);
});

test('unsupported builds persist channel changes while remaining unavailable', async t => {
  const f = fixture(t, { supported: false });
  assert.equal((await f.invoke('beta')).ok, false);
  const beta = await f.invoke('beta', BETA_AGREEMENT_VERSION);
  assert.equal(beta.value.supported, false);
  assert.equal(beta.value.channel, 'beta');
  assert.equal(beta.value.agreed, true);
  assert.equal(beta.value.status, 'unavailable');
  assert.equal(new WorkspaceStore(f.file).settings.updateChannel, 'beta');
  const stable = await f.invoke('stable');
  assert.equal(stable.value.channel, 'stable');
  assert.equal(stable.value.status, 'unavailable');
  assert.equal(f.checks(), 0);
  assert.equal(f.states.at(-1).channel, 'stable');
});

test('preload forwards both set-channel arguments and returns the original IPC result', async () => {
  let api;
  const calls = [], response = { ok: false, error: '请先阅读并同意测试协议。' };
  const electron = { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: { invoke: async (...args) => { calls.push(args); return response; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), { require: name => { assert.equal(name, 'electron'); return electron; } });
  assert.equal(await api.setUpdateChannel('beta', BETA_AGREEMENT_VERSION), response);
  assert.equal(await api.setUpdateChannel('stable'), response);
  assert.deepEqual(calls, [['updates:set-channel', 'beta', BETA_AGREEMENT_VERSION], ['updates:set-channel', 'stable', undefined]]);
});
