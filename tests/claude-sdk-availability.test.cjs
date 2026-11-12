const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const { registerClaudeWorker } = require('../electron/features/native-session/worker.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const { terminalPreparation, completeSwitch } = require('./fixtures/native-switch.cjs');

const key = 'sk-ant-api03-availability-offline-only';
const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).reverse(), decryptString: value => Buffer.from(value).reverse().toString() };
function fixture(t, { mode = 'api-then-terminal', sdkOptions, failure } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-availability-')), fake = fakeSdk(sdkOptions), events = [], terminals = [], handlers = new Map();
  let version = '2.1.318', time = 100;
  const spec = { agent: 'claude', owner: 'gui', projectId: 'p', terminalId: 't', runtimeSessionId: 'r', cwd: root,
    env: { PATH: '', HOME: root, USERPROFILE: root, APPDATA: root, CODEX_HOME: path.join(root, 'codex') } };
  if (failure) {
    const query = fake.sdk.query;
    fake.sdk.query = input => {
      if (failure === 'query_refused') throw Object.assign(new Error(key), { code: 'org_pin_api_key_conflict' });
      return { ...query(input), initializationResult: () => new Promise(() => {}) };
    };
  }
  const factory = createClaudeRuntime({ directory: path.join(root, 'data'), safeStorage, loadSdk: async () => fake.sdk, initializationTimeoutMs: failure === 'timeout' ? 10 : undefined,
    resolveExecutable: async () => { if (failure === 'cli_refused') throw Object.assign(new Error(key), { code: 'cwd_unavailable' }); return 'synthetic-only'; },
    inspectCli: async () => ({ status: 'ok', version }), now: () => time, connectionSpec: () => spec,
    request(_url, _options, callback) {
      const req = new EventEmitter(); req.destroy = () => {}; req.end = () => queueMicrotask(() => {
        const response = new PassThrough(); response.statusCode = 200; callback(response); response.end('{"data":[{"id":"synthetic"}]}');
      }); return req;
    } });
  factory.credentials.save(key); factory.observeCli({ status: 'ok', version });
  fs.writeFileSync(path.join(root, 'data/settings.json'), JSON.stringify({ claudePath: mode, codexView: 'native', monthlyBudgetUsd: 10 }));
  const native = createNativeSessions({ directory: path.join(root, 'data'), claude: factory,
    prepareTerminal: terminalPreparation(spec => terminals.push({ spec })),
    resolveSpec: id => ({ ...spec, terminalId: id }), terminal: async (value, reason) => terminals.push({ spec: value, reason }), emit: event => events.push(event) });
  native.register((name, handler) => handlers.set(name, handler));
  t.after(async () => { await native.close(); await factory.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, factory, native, fake, events, terminals, handlers, spec, version: value => { version = value; }, advance: () => { time += 864000000; } };
}

for (const tokenSource of ['apiKeyHelper', 'ANTHROPIC_AUTH_TOKEN', 'claude.ai', 'none']) test(`identity checks account.tokenSource=${tokenSource} with an env API key`, async t => {
  const f = fixture(t, { sdkOptions: { tokenSource } }), session = f.factory.create(f.spec, event => f.events.push(event));
  await session.start();
  const unsafe = ['apiKeyHelper', 'ANTHROPIC_AUTH_TOKEN'].includes(tokenSource);
  if (unsafe) {
    await assert.rejects(session.send({ clientMessageId: 'm', text: 'unsent' }), error => error.beforeInput === true && error.message.includes(`tokenSource=${tokenSource}`));
    assert.equal(f.fake.inputs.length, 0); assert.equal(f.factory.apiState(10, 'p').status, 'billing_identity_mismatch');
    f.factory.resetAvailability();
  } else {
    await session.send({ clientMessageId: 'm', text: 'synthetic work' });
    for (let n = 0; n < 100 && !f.events.some(event => event.type === 'turn.completed'); n++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(f.fake.inputs.length, 1);
  }
  const result = await f.native.testConnection('p');
  assert.equal(result.billing.status, unsafe ? 'mismatch' : 'ok'); assert.equal(result.billing.source, 'ANTHROPIC_API_KEY');
  assert.equal(result.path, unsafe ? 'terminal' : 'api');
  if (unsafe) { assert.equal(result.reason, 'billing_identity_mismatch'); assert.match(result.billing.detail.values.detail, new RegExp(`tokenSource=${tokenSource}`)); }
});

for (const failure of ['timeout', 'query_refused', 'cli_refused']) for (const mode of ['api-only', 'api-then-terminal']) {
  test(`pre-input ${failure} under ${mode} has a safe reason and never replays input`, async t => {
    const f = fixture(t, { failure, mode });
    const act = async () => {
      const started = await f.native.start('t', { agent: 'claude' });
      if (failure !== 'cli_refused') return f.native.send('t', started.runtimeSessionId, { clientMessageId: 'm', text: 'never execute' });
    };
    if (mode === 'api-only') {
      await assert.rejects(act(), error => error.beforeInput === true && /^Claude API (初始化超时|启动失败)，尚未发送消息。$/.test(error.message));
      assert.equal(f.terminals.length, 0); assert.ok(f.events.some(event => event.type === 'error'));
    } else {
      await act(); if (failure !== 'cli_refused') await completeSwitch(f.native, 't'); assert.equal(f.terminals.length, 1);
      assert.match(f.events.findLast(event => event.type === 'path.changed').payload.reason, /^Claude API (初始化超时|启动失败)，尚未发送消息。$/);
      assert.equal(f.events.some(event => event.type === 'error' || event.type === 'session.state' && event.payload.state === 'failed'), false);
      assert.equal(f.native.snapshot('t').events.findLast(event => event.type === 'path.changed').payload.selected, 'terminal');
    }
    assert.equal(f.fake.inputs.length, 0); assert.equal(f.factory.usage.available(10), 10000000);
    assert.equal(JSON.stringify(f.events).includes(key), false);
    assert.doesNotMatch(JSON.stringify(f.events), /org_pin_api_key_conflict|cwd_unavailable/);
  });
}

for (const reset of ['key_save', 'key_clear', 'settings', 'cli_version']) test(`billing mismatch remains cached until ${reset}`, async t => {
  const f = fixture(t, { sdkOptions: { tokenSource: 'apiKeyHelper' } });
  const first = await f.native.start('t', { agent: 'claude' });
  await f.native.send('t', first.runtimeSessionId, { clientMessageId: 'm', text: 'unsent' });
  f.advance();
  assert.equal(f.factory.apiState(10, 'p').status, 'billing_identity_mismatch');
  assert.equal((await f.native.usage('p')).agents.claude.next.path, 'terminal');
  await f.native.start('next', { agent: 'claude' });
  assert.equal(f.fake.calls.length, 1, 'a later session does not wait for and reject its first message again');
  const workerEvents = [], requests = new Map();
  registerClaudeWorker({ control: { onRequest: (name, handler) => requests.set(name, handler) }, claude: f.factory, settings: f.native.getSettings });
  await requests.get('claude-sdk.run')({ runId: 'worker', projectId: 'p', cwd: f.root, allow: [], agent: 'claude' }, { prompt: 'never sent' }, { emit: event => workerEvents.push(event) });
  assert.equal(workerEvents[0].payload.selected, 'terminal'); assert.equal(f.fake.calls.length, 1);
  if (reset === 'key_save') f.handlers.get('native:key-save')('sk-ant-api03-replacement-offline-only');
  else if (reset === 'key_clear') {
    await f.handlers.get('native:key-clear')(); assert.equal(f.factory.apiState(10, 'p').status, 'no_key'); f.factory.credentials.save(key);
  } else if (reset === 'settings') f.handlers.get('native:settings-set')({ claudePath: 'api-only' });
  else { f.version('2.1.319'); await f.factory.refreshAvailability(); }
  assert.equal(f.factory.apiState(10, 'p').status, 'ready');
});

test('late session identity failures cannot rearm an old-key availability result', async t => {
  const f = fixture(t); let resolve;
  const query = f.fake.sdk.query;
  f.fake.sdk.query = input => ({ ...query(input), initializationResult: () => new Promise(done => { resolve = done; }) });
  const session = f.factory.create(f.spec, () => {}); await session.start();
  const sending = session.send({ clientMessageId: 'm', text: 'unsent' });
  for (let n = 0; n < 100 && !resolve; n++) await new Promise(done => setTimeout(done, 1));
  f.factory.credentials.save('sk-ant-api03-newer-offline-key');
  resolve({ account: { apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'apiKeyHelper' } });
  await assert.rejects(sending, /tokenSource=apiKeyHelper/); assert.equal(f.factory.apiState(10, 'p').status, 'ready');
});

test('a connection result for the old saved key cannot rearm availability after a key change during HTTP validation', async t => {
  const f = fixture(t, { sdkOptions: { tokenSource: 'apiKeyHelper' } });
  const checking = f.factory.testConnection({ projectId: 'p' }); f.factory.credentials.save('sk-ant-api03-newer-offline-key');
  assert.equal((await checking).billing.status, 'mismatch'); assert.equal(f.factory.apiState(10, 'p').status, 'ready');
});

test('an SDK exception cannot expose raw text by naming a public billing error code', async t => {
  const f = fixture(t), query = f.fake.sdk.query;
  f.fake.sdk.query = input => ({ ...query(input), initializationResult: async () => { throw Object.assign(new Error(key), { code: 'billing_identity_mismatch' }); } });
  const session = f.factory.create(f.spec, event => f.events.push(event)); await session.start();
  await assert.rejects(session.send({ clientMessageId: 'm', text: 'unsent' }), error => error.code === 'sdk_startup_failed' && !error.message.includes(key));
  assert.equal(JSON.stringify(f.events).includes(key), false);
});

test('a cached identity denial closes a newly created runtime without starting another SDK query', async t => {
  const f = fixture(t, { sdkOptions: { tokenSource: 'apiKeyHelper' } });
  await f.factory.testConnection({ projectId: 'p' });
  const session = f.factory.create(f.spec, () => {});
  await assert.rejects(session.start(), error => error.beforeInput === true && /tokenSource=apiKeyHelper/.test(error.message));
  assert.equal(session.snapshot().state, 'stopped'); assert.equal(f.fake.calls.length, 1); assert.equal(f.fake.inputs.length, 0);
});

test('rejected key and settings changes do not clear a cached billing mismatch', async t => {
  const f = fixture(t, { sdkOptions: { tokenSource: 'apiKeyHelper' } }); await f.factory.testConnection({ projectId: 'p' });
  assert.throws(() => f.factory.credentials.save('invalid'));
  assert.throws(() => f.handlers.get('native:settings-set')({ monthlyBudgetUsd: -1 }));
  assert.equal(f.factory.apiState(10, 'p').status, 'billing_identity_mismatch');
});

test('N1/N2: a successful scoped connection probe clears only that project and subsequent usage follows it immediately', async t => {
  const f = fixture(t, { sdkOptions: { tokenSource: 'apiKeyHelper' } });
  await f.factory.testConnection({ projectId: 'p' }); await f.factory.testConnection({ projectId: 'other' });
  assert.equal(f.factory.apiState(10, 'p').status, 'billing_identity_mismatch');
  assert.equal(f.factory.apiState(10, 'other').status, 'billing_identity_mismatch');
  assert.equal(f.factory.apiState(10, 'third').status, 'ready');
  const query = f.fake.sdk.query;
  f.fake.sdk.query = input => ({ ...query(input), initializationResult: async () => ({ account: { apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'none' } }) });
  assert.equal((await f.native.testConnection('p')).billing.status, 'ok');
  assert.equal((await f.native.usage('p')).agents.claude.next.path, 'api');
  assert.equal((await f.native.usage('other')).agents.claude.next.path, 'terminal');
  assert.equal(f.fake.inputs.length, 0, 'identity checks never submit user input');
});

test('N2: concurrent connection tests for different projects never share a pending identity result', async t => {
  const f = fixture(t); let queries = 0;
  const query = f.fake.sdk.query;
  f.fake.sdk.query = input => { const current = ++queries; return { ...query(input), initializationResult: async () => ({ account: {
    apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: current === 1 ? 'apiKeyHelper' : 'none',
  } }) }; };
  const [a, b] = await Promise.all([f.factory.testConnection({ projectId: 'p' }), f.factory.testConnection({ projectId: 'other' })]);
  assert.equal(a.billing.status, 'mismatch'); assert.equal(b.billing.status, 'ok'); assert.equal(queries, 2);
  assert.equal(f.factory.apiState(10, 'p').status, 'billing_identity_mismatch'); assert.equal(f.factory.apiState(10, 'other').status, 'ready');
});

test('N1: a late successful pre-check cannot erase a newer failure, while a fresh successful pre-check clears it', async t => {
  const f = fixture(t, { sdkOptions: { uniqueSessions: true } }); const first = f.factory.create(f.spec, () => {}), second = f.factory.create({ ...f.spec, terminalId: 'second', runtimeSessionId: 'second' }, () => {});
  await first.start(); await second.start();
  let release, count = 0; const query = f.fake.sdk.query;
  f.fake.sdk.query = input => {
    const current = ++count;
    return { ...query(input), initializationResult: () => current === 1 ? new Promise(resolve => { release = resolve; })
      : Promise.resolve({ account: { apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: current === 2 ? 'apiKeyHelper' : 'none' } }) };
  };
  const pending = first.send({ clientMessageId: 'old', text: 'Synthetic input' });
  for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(second.send({ clientMessageId: 'denied', text: 'Unsent' }), /tokenSource=apiKeyHelper/);
  release({ account: { apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'none' } }); await pending;
  assert.equal(f.factory.apiState(10, 'p').status, 'billing_identity_mismatch');
  const third = f.factory.create({ ...f.spec, terminalId: 'third', runtimeSessionId: 'third' }, () => {});
  f.factory.resetAvailability(); await third.start();
  // Keep this lazy session open while another, newer observation records the failure.
  const original = f.fake.sdk.query;
  f.fake.sdk.query = input => ({ ...original(input), initializationResult: async () => ({ account: { apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'apiKeyHelper' } }) });
  await f.factory.testConnection({ projectId: 'p' }); f.fake.sdk.query = original;
  await third.send({ clientMessageId: 'fresh', text: 'Fresh pre-check' });
  assert.equal(f.factory.apiState(10, 'p').status, 'ready');
});
