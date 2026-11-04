const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { apiEnvironment } = require('../electron/features/claude-sdk/credentials.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).reverse(),
  decryptString: value => Buffer.from(value).reverse().toString() };
const fakeKey = 'sk-ant-api03-rereview-only-never-real';
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < deadline, 'offline session did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-rereview-'));
  const fake = fakeSdk({ auto: false, closeError: true, ...options });
  const factory = createClaudeRuntime({ directory, safeStorage, loadSdk: async () => fake.sdk,
    resolveExecutable: async () => process.execPath });
  factory.credentials.save(fakeKey);
  t.after(async () => { await factory.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  function create(owner = 'gui') {
    const events = [], session = factory.create({ agent: 'claude', owner, allow: ['**'], cwd: directory,
      projectId: 'p', terminalId: randomUUID(), runtimeSessionId: randomUUID(), monthlyBudgetUsd: 10, env: {} }, event => events.push(event));
    return { session, events };
  }
  return { fake, factory, create, ledger: () => JSON.parse(fs.readFileSync(path.join(directory, 'usage.json'), 'utf8')) };
}
const send = session => session.send({ clientMessageId: randomUUID(), text: 'offline work' });
const result = (cost, extra = {}) => ({ type: 'result', uuid: randomUUID(), subtype: 'success', total_cost_usd: cost, modelUsage: {}, queued_turn_count: 0, ...extra });

test('N2 owner idle releases its lease without closing the query and accepts a background automatic turn', async t => {
  const { fake, factory, create, ledger } = setup(t), { session, events } = create();
  await session.start(); await send(session); await until(() => fake.inputs.length === 1);
  fake.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'offline-monitor', run_id: '1' }] });
  fake.emit(result(0.1)); await until(() => session.snapshot().state === 'idle');
  assert.equal(fake.closes.length, 0); assert.equal(factory.usage.available(10), 9900000);
  assert.deepEqual(ledger().reservations, {});
  fake.emit({ type: 'assistant', uuid: randomUUID(), message: { content: [{ type: 'text', text: 'background finished' }] } });
  await until(() => events.some(event => event.type === 'turn.started' && event.payload.origin === 'automatic'));
  assert.equal(session.snapshot().state, 'running'); assert.ok(factory.usage.available(10) < 9900000);
  fake.emit(result(0.2)); await until(() => session.snapshot().state === 'idle');
  await send(session); await until(() => fake.inputs.length === 2);
  assert.equal(fake.calls.length, 1); assert.equal(fake.closes.length, 0);
  fake.emit(result(0.3)); await until(() => session.snapshot().state === 'idle');
  assert.equal(factory.usage.available(10), 9700000);
});

test('N2 dispatch idle still retires the query and resumes only for the next explicit send', async t => {
  const { fake, create, ledger } = setup(t), { session } = create('dispatch');
  await session.start(); await send(session); await until(() => fake.inputs.length === 1);
  fake.emit(result(0.1, { user_message_uuid: fake.inputs[0].uuid })); await until(() => session.snapshot().state === 'idle');
  assert.equal(fake.closes.length, 1); assert.deepEqual(ledger().reservations, {});
  await send(session); await until(() => fake.inputs.length === 2);
  assert.equal(fake.calls.length, 2); assert.equal(fake.calls[1].options.resume, fake.sessionId);
  fake.emit(result(0.2, { user_message_uuid: fake.inputs[1].uuid })); await until(() => session.snapshot().state === 'idle');
});

test('N2 an owner query reopens at a message boundary only when another session reduces its available cap', async t => {
  const { fake, factory, create } = setup(t), { session } = create();
  await session.start(); await send(session); await until(() => fake.inputs.length === 1);
  fake.emit(result(0.1)); await until(() => session.snapshot().state === 'idle');
  factory.usage.record('other', result(7));
  await send(session); await until(() => fake.inputs.length === 2);
  assert.equal(fake.calls.length, 2); assert.equal(fake.calls[1].options.maxBudgetUsd, 2.9);
  fake.emit(result(0.2)); await until(() => session.snapshot().state === 'idle');
});

test('N3 owner and dispatch environments override inherited scrub settings and preserve owner integrations', () => {
  const inherited = { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1', SSH_AUTH_SOCK: '/fake/agent', GH_TOKEN: 'synthetic-gh',
    NODE_AUTH_TOKEN: 'synthetic-npm', NPM_CONFIG_PREFIX: '/fake/npm', XDG_CONFIG_HOME: '/fake/config' };
  const owner = apiEnvironment(inherited, fakeKey, 'gui');
  assert.equal(owner.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '0');
  for (const name of Object.keys(inherited).filter(name => name !== 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB')) assert.equal(owner[name], inherited[name]);
  assert.equal(apiEnvironment({ ...inherited, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0' }, fakeKey, 'dispatch').CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
  assert.equal(owner.ANTHROPIC_API_KEY, fakeKey); assert.equal(inherited.ANTHROPIC_API_KEY, undefined);
});

test('N4 two mid-turn stops collect interrupt usage and do not consume two full five-dollar leases', async t => {
  const { fake, factory, create, ledger } = setup(t, { uniqueSessions: true });
  for (let index = 1; index <= 2; index++) {
    const { session } = create(); await session.start(); await send(session);
    await until(() => fake.inputs.length === index); await session.close();
  }
  assert.equal(fake.interrupts.length, 2); assert.deepEqual(ledger().reservations, {});
  assert.equal(Object.keys(ledger().sessions).length, 2);
  assert.deepEqual(ledger().estimates, {}); assert.equal(factory.usage.available(10), 10000000);
  const { session } = create(); await session.start(); await send(session);
  await until(() => fake.inputs.length === 3); assert.equal(fake.calls.length, 3);
});

test('N4 stop before init releases its reservation without creating an unresolvable estimate', async t => {
  const { fake, factory, create, ledger } = setup(t, { init: false }), { session } = create();
  await session.start(); await send(session); await until(() => fake.inputs.length === 1);
  await session.close();
  assert.equal(fake.interrupts.length, 0); assert.equal(factory.usage.available(10), 10000000);
  assert.deepEqual(ledger().reservations, {}); assert.deepEqual(ledger().estimates, {});
});

test('N4 the final interrupt result charges observed spend and releases the unused part of its cap', async t => {
  const { fake, factory, create, ledger } = setup(t, { interruptResult: { total_cost_usd: 0.15 } });
  const { session } = create(); await session.start(); await send(session); await until(() => fake.inputs.length === 1);
  await session.close();
  assert.equal(factory.usage.available(10), 9850000); assert.equal(factory.usage.summary().monthUsdMicros, 150000);
  assert.deepEqual(ledger().reservations, {}); assert.deepEqual(ledger().estimates, {});
});

test('N4 a timed-out interrupt closes within a bound and converts only the proved remaining cap to an estimate', async t => {
  const { fake, factory, create, ledger } = setup(t, { interruptResult: false }), { session } = create();
  await session.start(); await send(session); await until(() => fake.inputs.length === 1);
  fake.emit(result(0.1)); await until(() => session.snapshot().state === 'idle');
  await send(session); await until(() => fake.inputs.length === 2);
  const started = Date.now(); await session.close(); assert.ok(Date.now() - started < 2500);
  assert.deepEqual(ledger().reservations, {});
  assert.equal(fake.calls[1].options.maxBudgetUsd, 5);
  assert.equal(Object.values(ledger().estimates)[0].micros, 5000000);
  assert.equal(factory.apiState(10).status, 'ready');
  factory.usage.record(fake.sessionId, result(0.15), { resume: true });
  assert.equal(factory.usage.available(10), 9850000); assert.deepEqual(ledger().estimates, {});
});

test('N8 an installed old Claude produces an upgrade instruction instead of a missing-executable message', async t => {
  // The executable resolver retains native_cli_required so api-then-terminal can keep its existing fallback.
  const { createClaudeSession } = require('../electron/features/claude-sdk/session.cjs');
  const failing = createClaudeSession({ agent: 'claude', cwd: process.cwd(), runtimeSessionId: randomUUID() }, () => {}, {
    resolveExecutable: async () => { throw Object.assign(new Error('old fixture'), { code: 'native_cli_required', outdated: true }); },
  });
  await assert.rejects(failing.start(), { code: 'native_cli_required', message: 'Claude Code 版本过低，请升级到 2.1.317 或更高' });
});
