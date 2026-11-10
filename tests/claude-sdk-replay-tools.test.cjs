const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a tool call that history left without a result is unknown after a resume: not running, not done, not background work', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-sdk-replay-')), fake = fakeSdk(), events = [], id = fake.sessionId;
  const call = (uuid, tool) => ({ type: 'assistant', uuid, session_id: id, message: { id: uuid, content: [{ type: 'tool_use', id: tool, name: 'Bash', input: { command: 'npm test' } }] } });
  fake.sdk.getSessionMessages = async () => [
    { type: 'user', uuid: 'earlier-user', session_id: id, message: { content: 'Earlier input' } },
    call('first-call', 'finished'),
    { type: 'user', uuid: 'first-result', session_id: id, message: { content: [{ type: 'tool_result', tool_use_id: 'finished', content: 'ok' }] } },
    call('last-call', 'orphan'),
  ];
  const runtime = createClaudeRuntime({ directory, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'synthetic-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  runtime.credentials.save('sk-ant-offline-replay-not-a-real-key');
  const session = runtime.create({ owner: 'gui', agent: 'claude', projectId: 'p', terminalId: 't', runtimeSessionId: 'r', cwd: directory, monthlyBudgetUsd: 5,
    providerSessionId: id, env: { PATH: '', HOME: directory, CLAUDE_CONFIG_DIR: path.join(directory, 'claude') } }, event => events.push(event));
  t.after(async () => { await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const status = item => session.snapshot().events.find(event => event.itemId === item)?.payload.status;
  await session.resume(); await session.prepareResume();
  assert.deepEqual([status('finished'), status('orphan')], ['completed', 'unknown']);
  assert.deepEqual(session.activity(), { known: true, count: 0 });
  assert.ok(events.filter(event => event.type === 'item.upsert').every(event => event.replay));

  await session.send({ clientMessageId: 'next', text: 'go on' }); await tick(); await tick();
  assert.equal(events.findLast(event => event.type === 'turn.completed')?.payload.status, 'completed');
  assert.equal(status('orphan'), 'unknown', 'a later turn’s end does not rewrite history as an interruption of that turn');
  assert.ok(events.filter(event => event.itemId === 'orphan').every(event => event.replay));
  fake.emit({ type: 'system', subtype: 'task_started', task_id: 'live-job', run_id: 1, is_backgrounded: true }); await tick();
  assert.equal(session.activity().count, 1, 'a task started by this query is still background work');
});
