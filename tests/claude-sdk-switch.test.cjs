const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');

function fixture(t, history = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-sdk-switch-'));
  const fake = fakeSdk(), events = [], providerSessionId = fake.sessionId;
  fake.sdk.getSessionMessages = async (id, options) => {
    assert.equal(id, providerSessionId); assert.equal(options.dir, directory);
    return history ? [
      { type: 'user', uuid: 'earlier-user', session_id: providerSessionId, message: { content: 'Earlier input' } },
      { type: 'assistant', uuid: 'earlier-answer', session_id: providerSessionId, message: { content: 'Earlier answer' } },
    ] : [];
  };
  const runtime = createClaudeRuntime({ directory, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'synthetic-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  runtime.credentials.save('sk-ant-offline-switch-not-a-real-key');
  const spec = { owner: 'gui', agent: 'claude', projectId: 'p', terminalId: 't', runtimeSessionId: 'r', cwd: directory,
    monthlyBudgetUsd: 5, providerSessionId, env: { PATH: '', HOME: directory, CLAUDE_CONFIG_DIR: path.join(directory, 'claude') } };
  const session = runtime.create(spec, event => events.push(event));
  t.after(async () => { await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { runtime, session, fake, events, spec };
}
test('SDK switch preparation initializes a real resumed query with zero input and no budget reservation, replaying only persisted history', async t => {
  const f = fixture(t); await f.session.resume(); assert.equal(f.fake.calls.length, 0, 'resume is still lazy for ordinary starts');
  await f.session.prepareResume();
  assert.equal(f.fake.calls.length, 1); assert.equal(f.fake.calls[0].options.resume, f.fake.sessionId); assert.equal(f.fake.inputs.length, 0);
  assert.equal(f.runtime.usage.available(5), 5000000);
  assert.ok(f.events.filter(event => event.type === 'item.upsert').every(event => event.replay));
  assert.equal(f.events.some(event => event.type === 'turn.started' || event.type === 'input.receipt'), false);
});
test('missing SDK history cannot be accepted as a successful idle resume', async t => {
  const f = fixture(t, false); await f.session.resume();
  await assert.rejects(f.session.prepareResume(), /resume_history_unavailable/);
  assert.equal(f.fake.calls.length, 0); assert.equal(f.fake.inputs.length, 0);
});

for (const initialized of [false, true]) test(`a cleared key can restore its prior API session without re-saving credentials (initialized=${initialized})`, async t => {
  const f = fixture(t); await f.session.resume();
  if (initialized) await f.session.prepareResume();
  const restore = f.session.checkpoint();
  f.runtime.credentials.clear(); await f.session.close();
  assert.deepEqual(f.runtime.credentials.status(), { saved: false });
  const events = [], session = restore({ ...f.spec, runtimeSessionId: 'restored' }, event => events.push(event));
  await session.resume(); await session.prepareResume();
  assert.equal(f.fake.inputs.length, 0);
  assert.deepEqual(f.runtime.credentials.status(), { saved: false });
  assert.equal(JSON.stringify(events).includes('sk-ant-offline-switch-not-a-real-key'), false);
});
test('background snapshots before stream init are authoritative and late task runs never clear newer work', async t => {
  const f = fixture(t); await f.session.resume(); await f.session.prepareResume();
  const tick = () => new Promise(resolve => setImmediate(resolve));
  assert.equal(f.session.activity().known, false);
  f.fake.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'watcher', run_id: '002' }] }); await tick();
  assert.deepEqual(f.session.activity(), { known: true, count: 1 });
  f.fake.emit({ type: 'system', subtype: 'task_notification', task_id: 'watcher', run_id: '001' }); await tick();
  assert.equal(f.session.activity().count, 1);
  f.fake.emit({ type: 'system', subtype: 'task_notification', task_id: 'watcher', run_id: '002' }); await tick();
  assert.deepEqual(f.session.activity(), { known: true, count: 0 });
  assert.equal(f.fake.inputs.length, 0); assert.equal(f.events.some(event => event.type === 'turn.started'), false);
});
