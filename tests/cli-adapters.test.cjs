const { test } = require('node:test');
const assert = require('node:assert/strict');
const { adapters, adapterOf, adapterOfModel, agentOfModel } = require('../electron/features/cli-adapters/registry.cjs');
const shared = require('../electron/features/cli-adapters/registry.mjs');
const { CAPABILITY_KEYS, UNSUPPORTED, UNVERIFIED_VERSION, support } = require('../electron/features/cli-adapters/capabilities.mjs');
const { allowsUltracode } = require('../electron/features/skills/seat-rules.mjs');
const en = require('../electron/locales/en.json');

test('both registry entry points expose complete capability manifests', () => {
  assert.equal(shared.adapters(), adapters());
  assert.deepEqual(adapters().map(({ manifest }) => manifest.id), ['claude', 'codex']);
  for (const adapter of adapters()) {
    const { manifest } = adapter;
    assert.equal(adapterOf(manifest.id), adapter);
    assert.deepEqual(Object.keys(manifest.supports).sort(), [...CAPABILITY_KEYS].sort());
    for (const key of CAPABILITY_KEYS) {
      const capability = manifest.supports[key];
      if (capability.unsupported) assert.equal(capability.unsupported, UNSUPPORTED[key]);
      else assert.ok(['api', 'hook', 'screen', 'arg'].includes(capability.via), `${manifest.id} ${key}`);
    }
  }
  assert.equal(adapterOf('constructor'), undefined);
  for (const reason of [...Object.values(UNSUPPORTED), UNVERIFIED_VERSION]) assert.equal(typeof en[reason], 'string', reason);
  assert.match('2.1.331 (Claude Code)', adapterOf('claude').manifest.install.versionPattern);
  assert.match('codex-cli 0.166.0', adapterOf('codex').manifest.install.versionPattern);
});

test('the first matching model rule preserves existing seat ownership', () => {
  for (const model of ['opus', 'sonnet-5', 'haiku', 'fable', 'claude-opus-5-5']) assert.equal(agentOfModel(model), 'claude');
  for (const model of ['gpt-6.2-sol', 'third-party-model', 'Claude-opus', '']) assert.equal(agentOfModel(model), 'codex');
});

test('model defaults preserve effort order and restrict Ultracode to eligible leads', () => {
  for (const [model, agent, efforts, ultracode] of [
    ['fable', 'claude', ['low', 'medium', 'high', 'xhigh', 'max'], true],
    ['third-party-model', 'codex', ['low', 'medium', 'high', 'xhigh'], false],
  ]) {
    const adapter = adapterOfModel(model);
    assert.equal(adapter, adapterOf(agent));
    assert.equal(adapter, shared.adapterOfModel(model));
    assert.deepEqual(adapter.manifest.models.efforts, efforts);
    assert.equal(allowsUltracode(model, true), ultracode);
    assert.equal(allowsUltracode(model, false), false);
  }
});

test('support reports the implementation channel or an explicit unsupported reason', () => {
  const { manifest: claude } = adapterOf('claude'), { manifest: codex } = adapterOf('codex');
  assert.deepEqual(support(claude, 'terminal'), { ok: true, via: 'arg' });
  assert.deepEqual(support(claude, 'messageNote'), { ok: true, via: 'hook' });
  assert.deepEqual(support(codex, 'ssh.native', '0.166.0'), { ok: true, via: 'api' });
  assert.deepEqual(support(claude, 'ssh.native'), { ok: false, reason: UNSUPPORTED['ssh.native'] });
  assert.deepEqual(support(codex, 'terminal'), { ok: false, reason: UNSUPPORTED.terminal });
  assert.deepEqual(support({ supports: { native: true } }, 'native'), { ok: true });
  assert.deepEqual(support({ supports: {} }, 'resume'), { ok: false, reason: UNSUPPORTED.resume });
});

test('support honors inclusive numeric verification bounds', () => {
  const { manifest: claude } = adapterOf('claude');
  const screen = { ok: true, via: 'screen' };
  const unverified = { ok: false, reason: UNVERIFIED_VERSION, params: { cli: claude.label } };
  for (const key of ['liveModel', 'liveEffort', 'fast', 'ultracode']) {
    for (const version of [undefined, '2.1.331', '2.1.331+build.1']) assert.deepEqual(support(claude, key, version), screen);
    for (const version of ['2.1.330', '2.1.332', '2.1.331-beta.1', 'invalid']) assert.deepEqual(support(claude, key, version), unverified);
  }
  const fixture = { ...claude, supports: { liveModel: { via: 'screen', verified: ['2.1.9', '2.1.11'] } } };
  for (const version of ['2.1.9', '2.1.10', '2.1.11']) assert.deepEqual(support(fixture, 'liveModel', version), screen);
  assert.deepEqual(support(fixture, 'liveModel', '2.1.12'), unverified);
  assert.deepEqual(support(claude, 'native', '2.1.332'), { ok: true, via: 'api' });
});
