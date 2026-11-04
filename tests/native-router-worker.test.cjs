const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { registerClaudeWorker } = require('../electron/features/native-session/worker.cjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
function setup(t, { auto = true, cli = true, key = true, claudePath = 'api-then-terminal' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-worker-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = fakeSdk({ auto }), events = []; let handler, onControl;
  const claude = createClaudeRuntime({ directory: dir, safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    loadSdk: async () => fake.sdk, resolveExecutable: async () => cli ? process.execPath : null });
  if (key) claude.credentials.save('sk-ant-api03-fake-worker-only-credential');
  t.after(() => claude.close());
  registerClaudeWorker({ control: { onRequest(name, fn) { assert.equal(name, 'claude-sdk.run'); handler = fn; } }, claude,
    settings: () => ({ claudePath, monthlyBudgetUsd: 10 }), env: () => ({ PATH: '' }) });
  const run = { runId: randomUUID(), projectId: 'project', cwd: dir, worktree: dir, allow: ['src/**'], readOnly: false, roundtable: false };
  const stream = { emit: event => events.push(event), onControl(fn) { onControl = fn; return () => { onControl = null; }; } };
  return { fake, events, claude, run, dir, start: payload => handler(run, { prompt: 'fake task', model: 'fake', effort: 'high', ...payload }, stream), control: value => onControl(value) };
}
async function until(fn) { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('worker fake did not settle'); }
test('SDK worker broker applies trusted run scopes and streams events without credentials', async t => {
  const { start, events, fake, run, dir } = setup(t, { auto: false }); const task = start();
  await until(() => fake.inputs.length === 1);
  assert.equal((await fake.calls[0].options.canUseTool('Bash', { command: 'python -m pytest' }, {})).behavior, 'allow');
  fake.emit({ type: 'result', uuid: 'r', user_message_uuid: fake.inputs[0].uuid, total_cost_usd: 0.1, modelUsage: {}, queued_turn_count: 0 }); await task;
  assert.equal(fake.calls[0].options.cwd, run.cwd); assert.deepEqual(fake.calls[0].options.settingSources, []);
  assert.ok(events.some(event => event.type === 'turn.completed')); assert.ok(events.every(event => event.runId === run.runId));
  assert.ok(!JSON.stringify(events).includes('fake-worker-only-credential'));
  const audit = JSON.parse(fs.readFileSync(path.join(dir, 'policy-audit.json'), 'utf8'));
  assert.ok(Array.isArray(audit));
});
test('SDK worker broker uses terminal path before input when API is unavailable', async t => {
  const { start, events, fake } = setup(t, { key: false }); await start();
  assert.equal(fake.calls.length, 0); assert.equal(events[0].type, 'path.changed'); assert.equal(events[0].payload.selected, 'terminal');
});
test('SDK worker broker does not fall back for api-only with missing native CLI', async t => {
  const { start, events, fake } = setup(t, { cli: false, claudePath: 'api-only' }); await assert.rejects(start());
  assert.equal(fake.calls.length, 0); assert.ok(!events.some(event => event.type === 'path.changed'));
});
test('SDK worker broker signals terminal fallback for a missing native CLI before task input', async t => {
  const { start, events, fake } = setup(t, { cli: false }); await start();
  assert.equal(fake.calls.length, 0); assert.ok(events.some(event => event.type === 'path.changed' && /未找到原生 Claude Code/.test(event.payload.reason)));
});
test('SDK worker broker cannot accept renderer paths or SDK options', async t => {
  const { start, fake } = setup(t); await assert.rejects(start({ cwd: '/untrusted', env: {} })); assert.equal(fake.calls.length, 0);
});
test('SDK worker controls append during a live turn and drain queued work before closing', async t => {
  const { start, fake, control, events } = setup(t, { auto: false });
  let ended = false; const task = start().then(() => { ended = true; });
  await until(() => fake.inputs.length === 1);
  const id = randomUUID(); assert.equal(await control({ messageId: id, type: 'intervene', text: 'follow-up' }), 'queued');
  await until(() => fake.inputs.length === 2);
  fake.emit({ type: 'result', uuid: 'r1', user_message_uuid: fake.inputs[0].uuid, total_cost_usd: 0.1, modelUsage: {}, queued_turn_count: 1 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ended, false);
  fake.emit({ type: 'result', uuid: 'r2', user_message_uuid: fake.inputs[1].uuid, total_cost_usd: 0.2, modelUsage: {}, queued_turn_count: 0 });
  await task; assert.equal(events.filter(event => event.type === 'turn.completed').length, 2);
});
