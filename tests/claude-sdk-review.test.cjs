const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createUsage } = require('../electron/features/claude-sdk/usage.cjs');
const { createSettings } = require('../electron/features/native-session/settings.cjs');
const { recoveryWarnings } = require('../electron/features/native-session/storage.cjs');
const { createEventStream } = require('../electron/features/native-session/events.cjs');
const { createNormalizer } = require('../electron/features/claude-sdk/normalize.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const key = 'sk-ant-api03-offline-review-only-not-real';
const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text).reverse(), decryptString: bytes => Buffer.from(bytes).reverse().toString() };
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() >= deadline) assert.fail('offline fixture did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function runtime(t, overrides = {}) {
  const dir = temp(t), fake = fakeSdk({ auto: false, closeError: true, sessionId: overrides.providerSessionId || randomUUID() }), events = [];
  const factory = createClaudeRuntime({ directory: dir, safeStorage, resolveExecutable: async () => process.execPath, loadSdk: async () => fake.sdk });
  factory.credentials.save(key);
  const spec = { agent: 'claude', cwd: dir, owner: 'gui', projectId: 'p', terminalId: 't', runtimeSessionId: randomUUID(), monthlyBudgetUsd: 10, env: {}, ...overrides };
  const session = factory.create(spec, event => events.push(event)); t.after(() => factory.close());
  return { dir, fake, events, factory, spec, session };
}
test('B4 stop requests a final result before AbortError and a resumed cumulative total is counted once', async t => {
  const { session, fake, factory, spec } = runtime(t);
  await session.start(); await session.send({ clientMessageId: randomUUID(), text: 'hold' }); await until(() => fake.inputs.length === 1);
  await session.close();
  assert.equal(factory.apiState(10).status, 'ready'); assert.equal(factory.usage.available(10), 10000000);
  assert.equal(factory.usage.summary().monthUsdMicros, 0);
  const resumed = factory.create({ ...spec, providerSessionId: fake.sessionId }, () => {});
  await resumed.resume(); await resumed.send({ clientMessageId: randomUUID(), text: 'resume' }); await until(() => fake.inputs.length === 2);
  fake.emit({ type: 'result', uuid: 'resume', subtype: 'success', total_cost_usd: 1, modelUsage: {}, queued_turn_count: 0 });
  await until(() => resumed.snapshot().state === 'idle');
  assert.equal(factory.usage.available(10), 9000000); assert.equal(factory.usage.summary().monthUsdMicros, 1000000);
});
test('B4 SDK failure keeps bounded unverified spend without locking the month', async t => {
  const { session, fake, factory } = runtime(t);
  await session.start(); await session.send({ clientMessageId: randomUUID(), text: 'hold' }); await until(() => fake.inputs.length === 1);
  fake.fail(new Error('synthetic SDK crash')); await until(() => session.snapshot().state === 'failed');
  assert.equal(factory.apiState(10).status, 'ready'); assert.equal(factory.usage.available(10), 5000000);
});
test('B4 missing resume baseline anchors history, holds one lease, and reconciles on later cumulative evidence', async t => {
  const id = randomUUID(), { session, fake, factory } = runtime(t, { providerSessionId: id });
  // The fixture uses the same provider id as the imported transcript.
  await session.resume(); await session.send({ clientMessageId: randomUUID(), text: 'resume old' }); await until(() => fake.inputs.length === 1);
  fake.emit({ type: 'result', uuid: 'baseline', total_cost_usd: 20, modelUsage: {}, queued_turn_count: 0 });
  await until(() => session.snapshot().state === 'idle');
  assert.equal(factory.apiState(10).status, 'ready'); assert.equal(factory.usage.available(10), 5000000);
  await session.send({ clientMessageId: randomUUID(), text: 'next' }); await until(() => fake.inputs.length === 2);
  fake.emit({ type: 'result', uuid: 'next', total_cost_usd: 20.2, modelUsage: {}, queued_turn_count: 0 });
  await until(() => session.snapshot().state === 'idle'); assert.equal(factory.usage.available(10), 9800000);
});
test('M2 opened idle sessions reserve nothing and finished idle queries release their unused budget', async t => {
  const { session, factory, fake, spec } = runtime(t);
  const second = factory.create({ ...spec, terminalId: 'other', runtimeSessionId: randomUUID() }, () => {});
  await session.start(); await second.start(); assert.equal(factory.usage.available(10), 10000000); assert.equal(fake.calls.length, 0);
  await session.send({ clientMessageId: randomUUID(), text: 'work' }); await until(() => fake.inputs.length === 1);
  fake.emit({ type: 'result', uuid: 'finished', total_cost_usd: 0.1, modelUsage: {}, queued_turn_count: 0 });
  await until(() => session.snapshot().state === 'idle'); assert.equal(factory.usage.available(10), 9900000);
  assert.equal(factory.apiState(10).status, 'ready');
});

test('M2 a result with queued turns retains its query and reservation until the final queued result', async t => {
  const { session, factory, fake } = runtime(t);
  await session.start();
  await session.send({ clientMessageId: randomUUID(), text: 'first' });
  await session.send({ clientMessageId: randomUUID(), text: 'queued' });
  await until(() => fake.inputs.length === 2);
  fake.emit({ type: 'result', uuid: 'first', total_cost_usd: 0.1, modelUsage: {}, queued_turn_count: 1 });
  await until(() => factory.usage.baseline(fake.sessionId) === 100000);
  assert.equal(fake.calls.length, 1); assert.equal(factory.usage.available(10), 5000000);
  fake.emit({ type: 'result', uuid: 'queued', total_cost_usd: 0.2, modelUsage: {}, queued_turn_count: 0 });
  await until(() => session.snapshot().state === 'idle');
  assert.equal(factory.usage.available(10), 9800000); assert.equal(fake.calls.length, 1);
});
test('M3 a smaller resumed cumulative value begins a new epoch and is charged once', t => {
  const usage = createUsage({ file: path.join(temp(t), 'usage.json') });
  usage.record('s', { uuid: 'old', total_cost_usd: 5 });
  const lease = usage.reserve(10, { sessionId: 's', resume: true });
  const result = { uuid: 'new', total_cost_usd: 0.2 };
  assert.equal(usage.record('s', result, { resume: true, reservationId: lease.id }).deltaUsdMicros, 200000);
  assert.equal(usage.record('s', result, { resume: true, reservationId: lease.id }).deltaUsdMicros, 0);
  assert.equal(usage.summary().monthUsdMicros, 5200000);
});
test('M1 owner hooks stay silent so normal permission rules decide, and show a card only when canUseTool is called', async t => {
  const { session, fake, events } = runtime(t); await session.start(); await session.send({ clientMessageId: randomUUID(), text: 'read' });
  const options = fake.calls[0].options;
  assert.equal(options.permissionMode, 'bypassPermissions'); assert.equal(options.allowDangerouslySkipPermissions, true);
  for (const name of ['Read', 'Grep', 'Glob', 'TodoWrite', 'Bash']) {
    const result = await options.hooks.PreToolUse[0].hooks[0]({ tool_name: name, tool_input: {} });
    // A hook answering 'defer' makes the real CLI pause the tool and end the turn: tests/claude-sdk-real-cli.test.cjs.
    assert.deepEqual(result, {});
  }
  assert.equal(events.filter(event => event.type === 'request.opened').length, 0);
  const waiting = options.canUseTool('Bash', { command: 'needs confirmation' }, {});
  assert.equal(events.filter(event => event.type === 'request.opened').length, 1);
  await session.close(); assert.equal((await waiting).behavior, 'deny');
});
test('a reply the CLI writes as one record per block keeps every block, and a repeated record adds nothing', () => {
  const events = [], normalize = createNormalizer((type, payload, extra) => events.push({ type, payload, itemId: extra?.itemId }));
  const record = (uuid, ...content) => ({ type: 'assistant', uuid, message: { id: 'm1', content } });
  const stream = event => ({ type: 'stream_event', event });
  normalize(stream({ type: 'message_start', message: { id: 'm1' } }));
  normalize(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }));
  normalize(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }));
  normalize(record('a', { type: 'thinking', thinking: '' }));
  normalize(stream({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }));
  normalize(stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'par' } }));
  normalize(record('b', { type: 'text', text: 'partial answer' }));
  normalize(record('c', { type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'ls' } }));
  normalize(stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' late' } }));
  const seen = events.length;
  normalize(record('b-again', { type: 'text', text: 'partial answer' }));
  normalize(record('whole', { type: 'thinking', thinking: '' }, { type: 'text', text: 'partial answer' }, { type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'ls' } }));
  assert.equal(events.length, seen);
  const deltas = events.filter(event => event.type === 'item.delta'), items = events.filter(event => event.type === 'item.upsert');
  assert.deepEqual(deltas.map(event => [event.itemId, event.payload.text]), [['m1:0', 'hmm'], ['m1:1', 'par']], 'a late delta of a finished block is dropped; the live text is not');
  assert.deepEqual(items.map(event => [event.itemId, event.payload.kind]), [['m1:0', 'reasoning-summary'], ['m1:1', 'agent-message'], ['tool', 'command']]);
  assert.equal(items[1].payload.content.text, 'partial answer');
});
test('M4 a finished Claude tool keeps its kind, name and input in live events and replay snapshots', () => {
  const live = [], stream = createEventStream({ agent: 'claude', projectId: 'p', terminalId: 't', runtimeSessionId: 'r' }, event => live.push(event));
  const normalize = createNormalizer(stream.publish);
  normalize({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'npm test' } }] } });
  stream.publish('item.delta', { channel: 'output', text: 'partial' }, { itemId: 'tool' });
  assert.equal(stream.snapshot().events[0].payload.content.output, 'partial');
  normalize({ type: 'user', uuid: 'u', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'passed' }] } });
  assert.equal(live.at(-1).payload.kind, 'command');
  const saved = stream.snapshot().events[0]; assert.equal(saved.payload.content.name, 'Bash');
  assert.match(saved.payload.content.input, /npm test/); assert.equal(saved.payload.content.output, 'passed');
  stream.publish('item.upsert', { kind: 'command', status: 'completed', content: { output: 'final' } }, { itemId: 'tool' });
  assert.equal(stream.snapshot().events[0].payload.content.name, 'Bash');
});
for (const file of ['settings.json', 'usage.json', 'policy-audit.json']) test(`N7 corrupt ${file} is quarantined without changing unrelated settings`, t => {
  const dir = temp(t), original = { claudePath: 'api-only', codexView: 'terminal', monthlyBudgetUsd: 7 };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(original));
  fs.writeFileSync(path.join(dir, file), '{broken');
  const factory = createClaudeRuntime({ directory: dir, safeStorage, loadSdk: async () => ({}), resolveExecutable: async () => null });
  const settings = createSettings(path.join(dir, 'settings.json'));
  assert.deepEqual(settings.get(), { ...(file === 'settings.json' ? { claudePath: 'api-then-terminal', codexView: 'native', monthlyBudgetUsd: null } : original), codexAutoReset: true });
  if (file !== 'settings.json') assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'))), original);
  assert.ok(fs.readdirSync(dir).some(name => name.startsWith(file + '.') && name.endsWith('.corrupt')));
  const warnings = recoveryWarnings(dir, true);
  assert.ok(warnings.some(message => message.includes(file === 'settings.json' ? '已使用默认设置' : '运行方式设置未改变')));
  assert.equal(factory.usage.summary().monthUsdMicros, null);
});
test('B3 SDK spawn forces credential scrubbing and all persisted app metadata omit the fake key', async t => {
  const { session, fake, dir } = runtime(t, { owner: 'dispatch', allow: ['**'] }); await session.start(); await session.send({ clientMessageId: randomUUID(), text: 'work' });
  await until(() => fake.inputs.length === 1);
  assert.equal(fake.calls[0].options.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
  fake.emit({ type: 'result', uuid: 'r', user_message_uuid: fake.inputs[0].uuid, total_cost_usd: 0.1, modelUsage: {}, queued_turn_count: 0 });
  await until(() => session.snapshot().state === 'idle');
  for (const file of fs.readdirSync(dir, { recursive: true })) {
    const full = path.join(dir, file);
    if (fs.statSync(full).isFile()) assert.ok(!fs.readFileSync(full).includes(Buffer.from(key)), file);
  }
});
