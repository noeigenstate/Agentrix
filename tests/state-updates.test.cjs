const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceStore, cleanSettings } = require('../electron/state.cjs');
const { BETA_AGREEMENT_VERSION } = require('../electron/updates.cjs');

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-update-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'workspace.json');
  return { file, store: new WorkspaceStore(file) };
}

test('update channels default to stable without consent, including old saved settings', t => {
  const { file, store } = workspace(t);
  assert.equal(store.settings.updateChannel, 'stable');
  assert.equal(store.settings.betaAgreement, null);
  fs.writeFileSync(file, JSON.stringify({ version: 2, projects: [], settings: { fontSize: 14 } }));
  const restored = new WorkspaceStore(file);
  assert.equal(restored.settings.updateChannel, 'stable');
  assert.equal(restored.settings.betaAgreement, null);
  assert.equal(restored.settings.fontSize, 14);
});

test('channel and consent persist independently across settings changes and restart', t => {
  const { file, store } = workspace(t);
  store.updateSettings({ updateChannel: 'beta', betaAgreement: BETA_AGREEMENT_VERSION });
  store.updateSettings({ fontSize: 14 });
  let restored = new WorkspaceStore(file);
  assert.equal(restored.settings.updateChannel, 'beta');
  assert.equal(restored.settings.betaAgreement, BETA_AGREEMENT_VERSION);
  restored.updateSettings({ updateChannel: 'stable' });
  restored = new WorkspaceStore(file);
  assert.equal(restored.settings.updateChannel, 'stable');
  assert.equal(restored.settings.betaAgreement, BETA_AGREEMENT_VERSION);
  restored.updateSettings({ updateChannel: 'beta', betaAgreement: 'old-agreement' });
  restored = new WorkspaceStore(file);
  assert.equal(restored.settings.updateChannel, 'beta', 'stale consent must not rewrite the chosen channel');
  assert.equal(restored.settings.betaAgreement, 'old-agreement');
  restored.updateSettings({ betaAgreement: null });
  assert.equal(new WorkspaceStore(file).settings.betaAgreement, null);
});

test('invalid channels and malformed agreement values are rejected on save and load', t => {
  const { file, store } = workspace(t);
  for (const value of ['latest', 'Beta', '', 0, true, null, undefined, {}, [], ['beta']]) {
    assert.equal(cleanSettings({ updateChannel: value }).updateChannel, 'stable');
    store.updateSettings({ updateChannel: 'beta' });
    store.updateSettings({ updateChannel: value });
    assert.equal(new WorkspaceStore(file).settings.updateChannel, 'stable');
  }
  for (const value of ['', ' ', ' old-agreement', 'old-agreement ', 'bad\nversion', 'bad\0version', 'bad\x7fversion', 'x'.repeat(81), 0, true, undefined, {}, []]) {
    assert.equal(cleanSettings({ betaAgreement: value }).betaAgreement, null);
    store.updateSettings({ betaAgreement: BETA_AGREEMENT_VERSION });
    store.updateSettings({ betaAgreement: value });
    assert.equal(new WorkspaceStore(file).settings.betaAgreement, null);
    fs.writeFileSync(file, JSON.stringify({ version: 2, projects: [], settings: { updateChannel: 'beta', betaAgreement: value } }));
    assert.equal(new WorkspaceStore(file).settings.betaAgreement, null);
  }
});
