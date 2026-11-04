const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const { terminalPreparation, completeSwitch } = require('./fixtures/native-switch.cjs');

async function until(check) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('offline budget fixture did not settle');
}
function fixture(t, budget = 10) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-turn-budget-')), events = [];
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fake = fakeSdk({ auto: false, closeError: true, interruptResult: false });
  const runtime = createClaudeRuntime({ directory, loadSdk: async () => fake.sdk, resolveExecutable: async () => process.execPath,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).reverse(), decryptString: value => Buffer.from(value).reverse().toString() } });
  runtime.credentials.save('sk-ant-api03-budget-offline-test-only');
  const session = runtime.create({ agent: 'claude', owner: 'gui', runtimeSessionId: randomUUID(), projectId: 'p', terminalId: 't', cwd: directory, monthlyBudgetUsd: budget }, event => events.push(event));
  t.after(() => runtime.close());
  async function send() { const id = randomUUID(); await session.send({ clientMessageId: id, text: 'offline turn' }); await until(() => fake.inputs.some(input => input.uuid === id)); return id; }
  async function result(total, extra = {}) {
    const count = events.filter(event => event.type === 'turn.completed').length;
    fake.emit({ type: 'result', uuid: randomUUID(), subtype: 'success', total_cost_usd: total, modelUsage: {}, ...extra });
    await until(() => session.snapshot().state === 'idle' && events.filter(event => event.type === 'turn.completed').length > count);
  }
  return { directory, runtime, session, fake, events, send, result };
}

test('M1 each explicit idle turn renews its five-dollar cap without charging resumed history', { timeout: 5000 }, async t => {
  const f = fixture(t); await f.session.start();
  for (const total of [2, 4, 6]) { await f.send(); await f.result(total); }
  assert.deepEqual(f.fake.calls.map(call => call.options.maxBudgetUsd), [5, 5, 5]);
  assert.equal(f.fake.calls[1].options.resume, f.fake.sessionId); assert.equal(f.fake.calls[2].options.resume, f.fake.sessionId);
  assert.equal(f.fake.closes.length, 2, 'the idle query is retained until the next explicit send');
  assert.equal(f.runtime.usage.available(10), 4e6); assert.equal(f.runtime.usage.summary().monthUsdMicros, 6e6);
  await f.send(); assert.equal(f.fake.calls[3].options.maxBudgetUsd, 4);
  assert.equal(f.fake.inputs.length, 4, 'no input is automatically replayed');
});

test('M1 live background tasks preserve their process until a safe explicit message boundary', { timeout: 5000 }, async t => {
  const f = fixture(t); await f.session.start(); await f.send();
  f.fake.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'monitor', run_id: '2' }] });
  await f.result(1); await f.send(); assert.equal(f.fake.calls.length, 1);
  f.fake.emit({ type: 'system', subtype: 'task_notification', task_id: 'monitor', run_id: '1', status: 'completed' });
  await f.result(2); await f.send(); assert.equal(f.fake.calls.length, 1, 'a late task completion cannot permit a restart');
  f.fake.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  await f.result(3); await f.send(); assert.equal(f.fake.calls.length, 2);
});

test('M1 a query cap interruption leaves remaining monthly funds available for the next explicit turn', { timeout: 5000 }, async t => {
  const f = fixture(t); await f.session.start(); await f.send();
  await f.result(5, { subtype: 'error_max_budget_usd', is_error: true });
  const turn = f.events.findLast(event => event.type === 'turn.completed');
  assert.equal(turn.payload.status, 'interrupted'); assert.match(turn.payload.error, /本轮 API 预算/);
  assert.equal(f.runtime.apiState(10).status, 'ready');
  await f.send(); assert.equal(f.fake.calls[1].options.maxBudgetUsd, 5);
  assert.ok(!f.events.some(event => event.type === 'session.state' && event.payload.state === 'failed'));
});

for (const limit of ['month', 'query']) test(`M1 automatic wake with no ${limit} allowance stops cleanly instead of failing the session`, { timeout: 5000 }, async t => {
  const f = fixture(t); await f.session.start(); await f.send(); await f.result(1);
  if (limit === 'month') f.runtime.usage.record('other-offline-session', { uuid: 'other-cost', total_cost_usd: 9, modelUsage: {} });
  else { await f.send(); await f.result(6); }
  f.fake.emit({ type: 'assistant', uuid: randomUUID(), message: { id: randomUUID(), content: [{ type: 'text', text: 'background wake' }] } });
  await until(() => f.fake.closes.length === (limit === 'month' ? 1 : 2) && f.session.snapshot().state === 'idle');
  const turn = f.events.findLast(event => event.type === 'turn.completed');
  assert.equal(turn.payload.status, 'interrupted'); assert.match(turn.payload.error, limit === 'month' ? /本月 API 预算/ : /本轮 API 预算/);
  assert.equal(f.runtime.apiState(10).status, limit === 'month' ? 'budget_exhausted' : 'ready');
  assert.ok(!f.events.some(event => event.type === 'error' && event.payload.code === 'sdk_failed'));
  assert.ok(!f.events.some(event => event.type === 'session.state' && event.payload.state === 'failed'));
});

for (const mode of ['api-only', 'api-then-terminal']) test(`M1 monthly exhaustion follows ${mode} without failing or replaying input`, { timeout: 5000 }, async t => {
  const f = fixture(t), terminals = [];
  fs.writeFileSync(path.join(f.directory, 'settings.json'), JSON.stringify({ claudePath: mode, codexView: 'native', monthlyBudgetUsd: 1 }));
  const native = createNativeSessions({ directory: f.directory, claude: f.runtime,
    prepareTerminal: terminalPreparation(spec => terminals.push(spec)),
    resolveSpec: id => ({ agent: 'claude', owner: 'gui', projectId: 'p', terminalId: id, cwd: f.directory }),
    terminal: async (...args) => terminals.push(args), emit: event => f.events.push(event) });
  t.after(() => native.close());
  const { runtimeSessionId } = await native.start('t', { agent: 'claude' });
  await native.send('t', runtimeSessionId, { clientMessageId: randomUUID(), text: 'first' });
  await until(() => f.fake.inputs.length === 1);
  f.fake.emit({ type: 'result', uuid: randomUUID(), subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 1, modelUsage: {} });
  await until(() => native.snapshot('t').state === (mode === 'api-only' ? 'stopped' : 'idle'));
  const turn = f.events.findLast(event => event.type === 'turn.completed');
  assert.equal(turn.payload.status, 'interrupted'); assert.match(turn.payload.error, /本月 API 预算/);
  const next = () => native.send('t', runtimeSessionId, { clientMessageId: randomUUID(), text: 'keep this draft' });
  assert.equal((await next()).status, 'rejected'); assert.equal(terminals.length, 0, 'unsent input cannot bypass the switch coordinator');
  if (mode === 'api-then-terminal') { await completeSwitch(native, 't'); assert.equal(terminals.length, 1); }
  assert.equal(f.fake.inputs.length, 1, 'neither mode automatically resends a pending draft');
});
