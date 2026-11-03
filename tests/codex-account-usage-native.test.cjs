const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { CodexAccountUsage } = require('../electron/features/agents/codex-account-usage.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
const options = { cwd: os.tmpdir(), codexHome: path.join(os.tmpdir(), 'synthetic-native-home'), env: {}, provider: 'openai', accountLaunch: 'model-only-v1' };

test('same-scope native and terminal watchers use one native read with the existing throttle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let nativeReads = 0, legacyReads = 0;
  const service = new CodexAccountUsage({ scope: async () => null, read: async () => { legacyReads++; return { resets: null, resetQuery: { state: 'unavailable' } }; } });
  t.after(() => service.dispose());
  const binding = service.attachRuntime(options, { readLimits: async () => { nativeReads++; return { resetCredits: { availableCount: 2 },
    limitsById: { codex: { primary: { usedPercent: 50, windowDurationMins: 300, resetsAtMs: 200000 } } }, observedAtMs: Date.now() }; } });
  const a = [], b = [], first = service.watch(options, value => a.push(value)), second = service.watch({ ...options, env: {} }, value => b.push(value));
  await flush(); assert.equal(nativeReads, 1); assert.equal(legacyReads, 0); assert.equal(a.at(-1).resets.left, 2); assert.equal(b.at(-1).limits[0].resetsAt, 200000);
  first.refresh(); second.refresh(); t.mock.timers.tick(4999); await flush(); assert.equal(nativeReads, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(nativeReads, 2);
  binding.dispose(); first.dispose(); second.dispose();
});

test('native scope bindings isolate accounts and closed watchers drop late native replies', async t => {
  let resolveNative, nativeReads = 0, legacyReads = 0;
  const service = new CodexAccountUsage({ scope: async () => null, read: async () => { legacyReads++; return { resets: null, resetQuery: { state: 'unavailable' } }; } });
  t.after(() => service.dispose());
  const binding = service.attachRuntime(options, { readLimits: () => { nativeReads++; return new Promise(resolve => { resolveNative = resolve; }); } });
  const values = [], watcher = service.watch(options, value => values.push(value)); await flush(); watcher.dispose();
  resolveNative({ resetCredits: { availableCount: 3 }, limitsById: {}, observedAtMs: Date.now() }); await flush();
  assert.equal(values.length, 1); assert.equal(values[0].resetQuery.state, 'loading');
  service.watch({ ...options, codexHome: options.codexHome + '-other' }, () => {}); await flush();
  assert.equal(nativeReads, 1); assert.equal(legacyReads, 1); binding.dispose();
});
