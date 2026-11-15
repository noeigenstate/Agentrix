const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { timeoutScale } = require('../scripts/wait.mjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-provider-')), bus = new EventEmitter(), events = [];
  const fake = fakeSdk({ uniqueSessions: true, ...options });
  const original = fake.sdk.query;
  fake.sdk.query = spec => ({ ...original(spec), getContextUsage: async () => ({ model: 'fake-model', totalTokens: 1 }) });
  const runtime = createClaudeRuntime({ directory, safeStorage, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'offline-only' });
  runtime.credentials.save('sk-ant-offline-provider-fixture');
  t.after(async () => { await runtime.close(); await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const wait = predicate => new Promise(resolve => {
    const listener = event => { if (predicate(event)) { bus.off('event', listener); resolve(event); } };
    bus.on('event', listener);
  });
  const create = (owner = 'gui', extra = {}) => runtime.create({ owner, agent: 'claude', cwd: directory, env: { PATH: '' }, projectId: 'p',
    terminalId: randomUUID(), runtimeSessionId: randomUUID(), ...extra }, event => { events.push(event); bus.emit('event', event); });
  const send = async (session, id = randomUUID()) => {
    const completed = wait(event => event.runtimeSessionId === session.snapshot().runtimeSessionId && event.type === 'turn.completed');
    await session.send({ clientMessageId: id, text: 'offline input' }); await completed;
  };
  return { directory, runtime, fake, create, events, wait, send };
}

test('credits exhausted, a final rate limit and an account spend limit each stop the affected request before more input, show their reason, and follow API-then-terminal; API-only stops with the reason', { timeout: 20000 * timeoutScale }, async t => {
  for (const [error, text, code, reason] of [
    ['billing_error', 'Credit balance is too low', 'credits_required', 'credits_exhausted'],
    ['rate_limit', 'Too many requests', 'rate_limited', 'rate_limited'],
    ['spend_limit', 'enforced_spend_limit_reached', 'spend_limit', 'account_limit'],
  ]) {
    const f = fixture(t, { auto: false }), session = f.create(); await session.start();
    const completed = f.wait(event => event.type === 'turn.completed');
    const consumed = f.wait(event => event.type === 'routing.updated');
    await session.send({ clientMessageId: 'refused', text: 'offline input' }); await consumed;
    f.fake.emit({ type: 'assistant', error, user_message_uuid: 'refused', message: { model: '<synthetic>', content: [{ type: 'text', text }] } });
    f.fake.emit({ type: 'result', uuid: randomUUID(), user_message_uuid: 'refused', subtype: 'error_during_execution', is_error: true,
      result: text, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    const result = await completed;
    assert.equal(f.runtime.apiState('p').status, reason);
    assert.doesNotMatch(result.payload.message, /Credit balance|Too many requests|enforced_spend/);
    assert.equal(f.events.filter(event => event.type === 'error' && event.payload.code === code).length, 1);
    assert.equal(session.fallbackInput().safe, true);
    await assert.rejects(session.send({ clientMessageId: 'later', text: 'must not reach CLI' }), { code: reason });
    assert.equal(f.fake.inputs.length, 1);
  }
});

test('rate telemetry and a recovered CLI retry do not refuse a later input', { timeout: 15000 * timeoutScale }, async t => {
  const f = fixture(t, { auto: false }), session = f.create(); await session.start();
  const delivered = f.wait(event => event.type === 'routing.updated');
  await session.send({ clientMessageId: 'first', text: 'offline' }); await delivered;
  f.fake.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 100 } });
  f.fake.emit({ type: 'assistant', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: 'retrying' }] } });
  const completed = f.wait(event => event.type === 'turn.completed');
  f.fake.emit({ type: 'result', uuid: randomUUID(), terminal_reason: 'completed', subtype: 'success', is_error: false, total_cost_usd: 0.1 });
  await completed; assert.equal(f.runtime.apiState('p').status, 'ready');
  assert.equal(f.events.some(event => event.type === 'error' && event.payload.code === 'rate_limited'), false);
  await session.send({ clientMessageId: 'second', text: 'continue' });
});

for (const model of ['fixture-next', 'default']) test(`a CLI-confirmed raw model choice ${model} survives credential renewal`, { timeout: 15000 * timeoutScale }, async t => {
  const f = fixture(t, { auto: false }), selected = [], original = f.fake.sdk.query;
  f.fake.sdk.query = spec => ({ ...original(spec), setModel: async value => { selected.push(value); } });
  const session = f.create(); await session.start();
  const initialized = f.wait(event => event.type === 'routing.updated');
  await session.send({ clientMessageId: 'model', text: '/model ' + model }); await initialized;
  const done = f.wait(event => event.type === 'turn.completed');
  f.fake.emit({ type: 'result', uuid: 'model-result', user_message_uuid: 'model', local_command: 'model', subtype: 'success', is_error: false, total_cost_usd: 0 });
  await done;
  f.runtime.credentials.save('sk-ant-offline-rotated-fixture');
  await session.send({ clientMessageId: 'next', text: 'continue' });
  assert.equal(f.fake.calls.at(-1).options.model, model === 'default' ? undefined : model);
  assert.equal(f.fake.calls.at(-1).options.resume, f.events.find(event => event.providerSessionId)?.providerSessionId);
  if (model === 'default') assert.deepEqual(selected, [undefined]);
});

test('only a successful identified parent model command becomes a resumed configuration', { timeout: 15000 * timeoutScale }, async t => {
  const f = fixture(t, { auto: false }), session = f.create('gui', { model: 'explicit-model' }); await session.start();
  const initialized = f.wait(event => event.type === 'routing.updated');
  await session.send({ clientMessageId: 'model', text: '/model unconfirmed' }); await initialized;
  const done = f.wait(event => event.type === 'turn.completed');
  f.fake.emit({ type: 'result', uuid: 'failed-model', user_message_uuid: 'model', local_command: 'model', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0 });
  await done; f.runtime.credentials.save('sk-ant-offline-new-fixture');
  await session.send({ clientMessageId: 'next', text: 'continue' });
  assert.equal(f.fake.calls.at(-1).options.model, 'explicit-model');
});

test('an owner stop during provider retries does not become a provider refusal', { timeout: 15000 * timeoutScale }, async t => {
  const f = fixture(t, { auto: false }), session = f.create(); await session.start();
  const initialized = f.wait(event => event.type === 'routing.updated');
  await session.send({ clientMessageId: 'first', text: 'offline' }); await initialized;
  f.fake.emit({ type: 'assistant', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: 'retrying' }] } });
  const done = f.wait(event => event.type === 'turn.completed');
  await session.interrupt(); const result = await done;
  assert.equal(result.payload.status, 'interrupted'); assert.equal(f.runtime.apiState('p').status, 'ready');
  assert.equal(f.events.some(event => event.type === 'error' && event.payload.code === 'rate_limited'), false);
});

test('startup provider codes select their safe message independently of provider text', () => {
  const { startupFailure, LIMIT_MESSAGES } = require('../electron/features/claude-sdk/identity.cjs');
  for (const code of ['credits_exhausted', 'rate_limited', 'account_limit']) {
    const failure = startupFailure({ code, message: 'untrusted provider words' });
    assert.equal(failure.code, code); assert.equal(failure.message, LIMIT_MESSAGES[code]); assert.equal(failure.beforeInput, true);
  }
});
