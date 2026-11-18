const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createClaudeSession } = require('../electron/features/claude-sdk/session.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');

test('Claude SDK fast and effort survive acknowledged changes and model rows retain capabilities', async t => {
  const fake = fakeSdk({ auto: false }), flags = [];
  const query = fake.sdk.query;
  fake.sdk.query = spec => Object.assign(query(spec), {
    supportedModels: async () => [{ value: 'opus', resolvedModel: 'claude-opus-6-0', displayName: 'Opus', description: 'Synthetic',
      supportedEffortLevels: ['high', 'adaptive'], supportsFastMode: true }],
    applyFlagSettings: async patch => { flags.push(patch); },
    getContextUsage: async () => ({ model: 'claude-opus-6-0' }),
  });
  const spec = { agent: 'claude', owner: 'gui', runtimeSessionId: randomUUID(), terminalId: 'terminal', projectId: 'project',
    cwd: __dirname, worktree: __dirname, env: { PATH: '' }, model: 'opus', effort: 'high', fast: true };
  const session = createClaudeSession(spec, () => {}, { loadSdk: async () => fake.sdk, resolveExecutable: async () => 'synthetic-executable',
    credentials: { status: () => ({ saved: true }), read: () => 'synthetic-injected-key' }, usage: {} });
  t.after(() => session.close()); await session.start();
  const rows = await session.models();
  assert.deepEqual(rows, [{ value: 'claude-opus-6-0', alias: 'opus', displayName: 'Opus', description: 'Synthetic', efforts: ['high', 'adaptive'], fast: true }]);
  assert.equal(JSON.parse(fs.readFileSync(fake.calls[0].options.settings, 'utf8')).fastMode, true);
  assert.equal((await session.runOptions({ fast: false, effort: 'adaptive' })).fast, false);
  assert.deepEqual(flags, [{ effortLevel: 'adaptive', fastMode: false }]);
  assert.equal(spec.fast, false); assert.equal(spec.effort, 'adaptive');
  assert.equal((await session.runOptions({ fast: true })).fast, true);
  assert.equal((await session.runOptions({})).fast, true);
  assert.equal(fake.inputs.length, 0, 'model and option reads perform no inference');
});
