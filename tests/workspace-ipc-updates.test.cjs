const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { WorkspaceStore } = require('../electron/state.cjs');
const { BETA_AGREEMENT_VERSION, UpdateManager } = require('../electron/updates.cjs');
const { createIpcAdapter } = require('../electron/shared/ipc.cjs');
const { registerWorkspaceIpc } = require('../electron/features/workspace/ipc.cjs');
const { registerUpdatesIpc } = require('../electron/features/updates/ipc.cjs');

function fixture(t, channel, betaAgreement) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-settings-gate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'workspace.json'), store = new WorkspaceStore(file);
  store.updateSettings({ updateChannel: channel, betaAgreement });
  const calls = [], states = [], handlers = new Map();
  const manager = new UpdateManager({ updater: null, version: '1.3.26', channel, betaAgreement, onChange: state => states.push(state) });
  t.after(() => manager.dispose());
  const webContents = { mainFrame: { url: 'agentrix://app/index.html' } };
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const adapter = createIpcAdapter({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getWindow: () => ({ webContents }), t: text => text });
  registerWorkspaceIpc({ ...adapter, getSettings: () => store.settings,
    updateStoreSettings: patch => { calls.push('save'); store.updateSettings(patch); },
    broadcast: () => calls.push('broadcast'), clearRestorePlans: () => calls.push('restore'), chooseVoiceModel: () => calls.push('voice'),
  });
  registerUpdatesIpc({ ...adapter, updateManager: manager, updateSettings: patch => store.updateSettings(patch) });
  let api;
  const electron = { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: { invoke: (name, ...args) => handlers.get(name)(event, ...structuredClone(args)) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), { require: name => { assert.equal(name, 'electron'); return electron; } });
  return { api, file, store, calls, states, manager };
}

test('api.settings refuses channel and agreement writes without changing either field or running side effects', async t => {
  for (const [channel, agreement] of [['stable', null], ['beta', 'old-agreement'], ['beta', BETA_AGREEMENT_VERSION]]) {
    const f = fixture(t, channel, agreement);
    const saved = fs.readFileSync(f.file, 'utf8'), settings = { ...f.store.settings }, update = f.manager.getState();
    for (const patch of [
      { updateChannel: 'beta', betaAgreement: BETA_AGREEMENT_VERSION },
      { updateChannel: 'stable' }, { betaAgreement: BETA_AGREEMENT_VERSION }, { betaAgreement: null },
      { updateChannel: undefined }, { betaAgreement: undefined },
      { updateChannel: 'beta', betaAgreement: BETA_AGREEMENT_VERSION, fontSize: 14, restoreSessions: false },
    ]) {
      assert.deepEqual(await f.api.settings(patch), { ok: false, error: '请在“关于”页面切换更新通道。' });
      assert.deepEqual(f.store.settings, settings);
      assert.equal(fs.readFileSync(f.file, 'utf8'), saved);
      const restored = new WorkspaceStore(f.file);
      assert.equal(restored.settings.updateChannel, channel);
      assert.equal(restored.settings.betaAgreement, agreement);
      assert.deepEqual(f.manager.getState(), update);
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.states, []);
    }
  }
});

test('ordinary settings still save while only setUpdateChannel can accept the agreement and change channels', async t => {
  const f = fixture(t, 'stable', null);
  assert.equal((await f.api.settings({ fontSize: 14, restoreSessions: false })).ok, true);
  assert.equal(f.store.settings.fontSize, 14);
  assert.equal(f.store.settings.updateChannel, 'stable');
  assert.equal(f.store.settings.betaAgreement, null);
  assert.deepEqual(f.calls, ['save', 'broadcast', 'restore', 'voice']);
  assert.deepEqual(await f.api.setUpdateChannel('beta'), { ok: false, error: '请先阅读并同意测试协议。' });
  const result = await f.api.setUpdateChannel('beta', BETA_AGREEMENT_VERSION);
  assert.equal(result.ok, true);
  assert.equal(result.value.channel, 'beta');
  assert.equal(result.value.agreed, true);
  assert.equal(new WorkspaceStore(f.file).settings.updateChannel, 'beta');
  assert.equal(new WorkspaceStore(f.file).settings.betaAgreement, BETA_AGREEMENT_VERSION);
  assert.deepEqual(f.states.at(-1), result.value);
});
