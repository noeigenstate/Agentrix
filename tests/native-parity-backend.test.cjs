const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const { createNormalizer } = require('../electron/features/claude-sdk/normalize.cjs');
const { createEvents } = require('../electron/features/codex-app-server/events.cjs');
const { validEvent } = require('../electron/features/native-session/validate.cjs');
const { createEventStream } = require('../electron/features/native-session/events.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-options-')), fake = fakeSdk({ uniqueSessions: true });
  const query = fake.sdk.query;
  fake.sdk.query = spec => {
    const model = spec.options.model || 'fake-model';
    return { ...query(spec), supportedModels: async () => [{ value: 'alias', resolvedModel: 'fake-model', displayName: 'Fixture', description: 'Offline', supportedEffortLevels: ['low', 'high'], supportsFastMode: true }],
      getContextUsage: async () => ({ model }) };
  };
  const runtime = createClaudeRuntime({ directory: path.join(root, 'state'), loadSdk: async () => fake.sdk, resolveExecutable: async () => 'synthetic-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  runtime.credentials.save('sk-ant-offline-parity-fixture-only');
  t.after(async () => { await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // Saving the fake key again renews the query on the next send.
  const resume = () => runtime.credentials.save('sk-ant-offline-parity-fixture-only');
  return { root, fake, runtime, resume };
}

test('Claude refuses model controls without creating a query and resumes with its launch seat', async t => {
  const f = fixture(t);
  const session = f.runtime.create({ owner: 'gui', cwd: f.root, env: { PATH: '' }, runtimeSessionId: randomUUID(),
    model: 'fake-next', effort: 'low', fast: true }, () => {});
  await session.start();
  assert.equal((await session.runOptions({})).fast, true);
  for (const patch of [{ model: 'fake-other' }, { effort: 'high' }, { fast: false }]) {
    await assert.rejects(session.runOptions(patch), error => error.code === 'routing-owned');
  }
  for (const [i, text] of ['/model fake-other', '/effort high', '/fast off'].entries()) {
    await assert.rejects(session.send({ clientMessageId: 'refused-' + i, text }), error => error.code === 'routing-owned');
  }
  assert.equal(f.fake.calls.length, 0);
  assert.equal((await session.models())[0].value, 'fake-model');
  await session.send({ clientMessageId: 'one', text: 'first' }); await tick();
  const queries = f.fake.calls.length;
  f.resume(); await session.send({ clientMessageId: 'two', text: 'second' }); await tick();
  assert.equal(f.fake.calls.length, queries + 1);
  assert.equal(f.fake.calls.at(-1).options.model, 'fake-next'); assert.equal(f.fake.calls.at(-1).options.effort, 'low');
  assert.equal(JSON.parse(fs.readFileSync(f.fake.calls.at(-1).options.settings)).fastMode, true);
  assert.ok(f.fake.calls.at(-1).options.resume);
});

test('new conversation migrates binding before old close and never resumes the previous provider', async t => {
  const f = fixture(t), events = [], migration = [];
  const native = createNativeSessions({ directory: path.join(f.root, 'native'), claude: f.runtime, codex: {}, emit: event => events.push(event),
    resolveSpec: id => ({ owner: 'gui', cwd: f.root, env: { PATH: '' }, terminalId: id, projectId: 'project', agent: 'claude' }),
    activateNative: spec => migration.push(spec), terminal: () => assert.fail('no terminal'), saveSession() {} });
  t.after(() => native.close());
  const first = await native.start('terminal', { agent: 'claude' });
  await native.send('terminal', first.runtimeSessionId, { clientMessageId: 'one', text: 'first' }); await tick();
  const oldProvider = native.snapshot('terminal').events.find(event => event.providerSessionId).providerSessionId, before = events.length;
  const next = await native.newConversation('terminal', first.runtimeSessionId);
  const ready = native.snapshot('terminal');
  assert.equal(ready.runtimeSessionId, next.runtimeSessionId);
  assert.equal(ready.events.findLast(event => event.type === 'session.state').payload.state, 'idle');
  assert.notEqual(next.runtimeSessionId, first.runtimeSessionId); assert.equal(migration[0].providerSessionId, null);
  assert.ok(!events.slice(before).some(event => event.payload.state === 'stopped'));
  assert.throws(() => native.interrupt('terminal', first.runtimeSessionId));
  await native.send('terminal', next.runtimeSessionId, { clientMessageId: 'two', text: 'second' }); await tick();
  assert.equal(f.fake.calls.at(-1).options.resume, undefined);
  assert.notEqual(native.snapshot('terminal').events.find(event => event.providerSessionId).providerSessionId, oldProvider);
});

test('new conversation activation failure keeps the old binding usable', async t => {
  const f = fixture(t);
  const native = createNativeSessions({ directory: path.join(f.root, 'native'), claude: f.runtime, codex: {}, emit() {},
    resolveSpec: id => ({ owner: 'gui', cwd: f.root, env: { PATH: '' }, terminalId: id, projectId: 'project', agent: 'claude' }),
    activateNative: () => { throw new Error('synthetic-activation-refusal'); }, terminal: () => assert.fail('no terminal'), saveSession() {} });
  t.after(() => native.close());
  const first = await native.start('terminal', { agent: 'claude' });
  await assert.rejects(native.newConversation('terminal', first.runtimeSessionId), /synthetic-activation-refusal/);
  await native.send('terminal', first.runtimeSessionId, { clientMessageId: 'still-old', text: 'still here' }); await tick();
  assert.equal(native.snapshot('terminal').runtimeSessionId, first.runtimeSessionId);
});

test('Claude terminal-to-API resume selects the current seat and preserves the terminal binding', async t => {
  const source = { identity: {}, path: 'terminal', spec: { owner: 'gui', agent: 'claude', projectId: 'project', terminalId: 't',
    runtimeSessionId: 'old-runtime', providerSessionId: 'provider', sessionId: 'pty', skillSessionId: 'old-snapshot', model: 'old-seat' } };
  const resumes = [], releases = [];
  const provider = { facts: () => [], create: spec => ({
    resume() { resumes.push(spec); return { providerSessionId: 'provider' }; },
    prepareResume: () => ({ providerSessionId: 'provider' }), snapshot: () => ({ state: 'idle', events: [] }), close() {},
  }) };
  const router = createRouter({ claude: provider, codex: {}, settings: { get: () => ({ claudePath: 'api-only' }) },
    resolveSpec() {}, emit() {}, terminalSessions: () => [source],
    observeTerminal: () => ({ state: 'idle', background: { known: true, count: 0 } }),
    prepareConversation: spec => {
      Object.assign(spec, { model: 'current-seat', effort: 'max', fast: true, skillSessionId: 'new-snapshot' });
      return committed => releases.push(committed);
    },
    activateNative: spec => assert.equal(spec.sessionId, source.spec.sessionId),
  });
  t.after(() => router.close());
  await router.reconcile();
  const changeId = router.switchState('t').changeId;
  assert.equal(router.answer('t', 'old-runtime', 'handoff', { handoff: { changeId, draft: { version: 1, text: '', images: [], undelivered: [] } } }).accepted, true);
  await router.settled();
  assert.equal(resumes.length, 1);
  assert.deepEqual([resumes[0].model, resumes[0].effort, resumes[0].fast, resumes[0].providerSessionId, resumes[0].skillSessionId],
    ['current-seat', 'max', true, 'provider', 'new-snapshot']);
  assert.equal(source.spec.model, 'old-seat'); assert.deepEqual(releases, [true]);
});

test('native controls refuse routing patches with the shared code and forward permissions only', () => {
  const handlers = new Map(), calls = [];
  const router = Object.fromEntries(['runOptions', 'newConversation', 'shell'].map(name => [name, (...args) => calls.push([name, ...args])]));
  require('../electron/features/native-session/ipc.cjs').registerIpc({ handle: (name, fn) => handlers.set(name, fn), router, settings: {}, claude: {} });
  const options = handlers.get('native:run-options');
  for (const patch of [{ env: {} }, { cwd: '/other' }, { permissions: 'unsafe' }, []]) assert.throws(() => options('t', 'r', patch));
  for (const patch of [{ model: null }, { effort: 'high' }, { fast: false }, { fast: true, permissions: 'ask' }]) {
    assert.deepEqual(options('t', 'r', patch), { ok: false, code: 'routing-owned', error: '模型由模型路由决定，请在模型路由中更改。' });
  }
  assert.equal(calls.length, 0);
  assert.equal(handlers.has('native:models'), false);
  options('t', 'r', {}); options('t', 'r', { permissions: 'ask' });
  assert.deepEqual(calls, [['runOptions', 't', 'r', {}], ['runOptions', 't', 'r', { permissions: 'ask' }]]);
  const shell = handlers.get('native:shell');
  assert.throws(() => shell('t', 'r', 'id', { command: 'echo', env: {} }));
  shell('t', 'r', 'id', 'echo'); assert.deepEqual(calls.at(-1), ['shell', 't', 'r', 'id', 'echo']);
});

test('both compaction lifecycles publish bounded events; every notice survives snapshot replay', () => {
  const seen = [], normalize = createNormalizer((type, payload) => seen.push({ type, payload }));
  normalize({ type: 'system', subtype: 'status', status: 'compacting' });
  normalize({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 180000 } });
  assert.deepEqual(seen.map(event => event.type), ['context.compacting', 'context.compacting', 'context.compacted']);
  assert.deepEqual(seen.at(-1).payload, { trigger: 'manual', preTokens: 180000, postTokens: null });
  const spec = { agent: 'codex', projectId: 'project', terminalId: 'terminal', runtimeSessionId: 'runtime' };
  const stream = createEventStream(spec, () => {}), codex = createEvents(spec, event => {
    assert.equal(validEvent(event), true); stream.publish(event.type, event.payload);
  }, Date.now);
  codex.notification('item/started', { item: { id: 'c', type: 'contextCompaction' } });
  codex.notification('item/completed', { item: { id: 'c', type: 'contextCompaction' } });
  stream.publish('item.dropped', { reason: 'too_large', bytes: 70 * 1024 * 1024 });
  stream.publish('item.dropped', { reason: 'too_large', bytes: 71 * 1024 * 1024 });
  assert.equal(stream.snapshot().events.filter(event => event.type === 'item.dropped').length, 2);
  assert.equal(stream.snapshot().events.find(event => event.type === 'context.compacting').payload.active, false);
});
