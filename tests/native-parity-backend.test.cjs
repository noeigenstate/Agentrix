const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const { createNormalizer } = require('../electron/features/claude-sdk/normalize.cjs');
const { createEvents } = require('../electron/features/codex-app-server/events.cjs');
const { validEvent } = require('../electron/features/native-session/validate.cjs');
const { createEventStream } = require('../electron/features/native-session/events.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-options-')), fake = fakeSdk({ uniqueSessions: true });
  const flags = [];
  const query = fake.sdk.query;
  fake.sdk.query = spec => {
    let model = spec.options.model || 'fake-model';
    return { ...query(spec), supportedModels: async () => [{ value: 'alias', resolvedModel: 'fake-model', displayName: 'Fixture', description: 'Offline', supportedEffortLevels: ['low', 'high'], supportsFastMode: true }],
      setModel: async value => { model = value || 'fake-model'; }, applyFlagSettings: async patch => { flags.push(patch); }, getContextUsage: async () => ({ model }) };
  };
  const runtime = createClaudeRuntime({ directory: path.join(root, 'state'), loadSdk: async () => fake.sdk, resolveExecutable: async () => 'synthetic-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  runtime.credentials.save('sk-ant-offline-parity-fixture-only');
  t.after(async () => { await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // An owner query stays open at idle and no spend renews it. A key saved again retires it at the next send, which
  // resumes the conversation in a new query: that query must carry the acknowledged choices.
  const resume = () => runtime.credentials.save('sk-ant-offline-parity-fixture-only');
  return { root, fake, runtime, resume, flags };
}

test('run options read is lazy; acknowledged choices survive a resumed query', async t => {
  const f = fixture(t), session = f.runtime.create({ owner: 'gui', cwd: f.root, env: { PATH: '' }, runtimeSessionId: randomUUID() }, () => {});
  await session.start(); assert.equal((await session.runOptions({})).model, null); assert.equal(f.fake.calls.length, 0);
  const models = await session.models();
  assert.deepEqual(models[0].efforts, ['low', 'high']); assert.equal(models[0].fast, true);
  await session.send({ clientMessageId: 'one', text: 'first' }); await tick();
  assert.equal((await session.runOptions({})).model, 'fake-model');
  assert.equal((await session.models())[0].value, 'fake-model');
  assert.equal((await session.runOptions({ fast: true })).fast, true);
  assert.deepEqual(f.flags.at(-1), { fastMode: true });
  assert.equal((await session.runOptions({})).fast, true);
  await session.runOptions({ model: 'fake-next', effort: 'low', fast: true });
  const queries = f.fake.calls.length;
  f.resume(); await session.send({ clientMessageId: 'two', text: 'second' }); await tick();
  assert.equal(f.fake.calls.length, queries + 1, 'the second message runs in a resumed query');
  assert.equal(f.fake.calls.at(-1).options.model, 'fake-next'); assert.equal(f.fake.calls.at(-1).options.effort, 'low');
  assert.equal(JSON.parse(fs.readFileSync(f.fake.calls.at(-1).options.settings)).fastMode, true);
  assert.equal(f.fake.calls.at(-1).options.resume, f.fake.inputs[0].session_id || session.snapshot().events.find(event => event.providerSessionId)?.providerSessionId);
  assert.equal((await session.runOptions({ model: null })).model, 'fake-model');
  f.resume(); await session.send({ clientMessageId: 'default', text: 'default model' }); await tick();
  assert.equal(f.fake.calls.at(-1).options.model, undefined);
});

test('rapid option updates serialize and a following send sees the last acknowledged choice', async t => {
  const f = fixture(t), session = f.runtime.create({ owner: 'gui', cwd: f.root, env: { PATH: '' }, runtimeSessionId: randomUUID() }, () => {});
  await session.start();
  const values = await Promise.all(['first', 'second', 'last'].map(model => session.runOptions({ model })));
  assert.deepEqual(values.map(value => value.model), ['first', 'second', 'last']);
  await session.send({ clientMessageId: 'after-options', text: 'go' }); await tick();
  const queries = f.fake.calls.length;
  f.resume(); await session.send({ clientMessageId: 'resume-options', text: 'continue' }); await tick();
  assert.equal(f.fake.calls.length, queries + 1, 'the next message runs in a resumed query');
  assert.equal(f.fake.calls.at(-1).options.model, 'last');
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

test('native controls validate exact patches and cannot accept execution options', async t => {
  const handlers = new Map(), calls = [];
  const router = Object.fromEntries(['runOptions', 'models', 'newConversation', 'shell'].map(name => [name, (...args) => calls.push([name, ...args])]));
  require('../electron/features/native-session/ipc.cjs').registerIpc({ handle: (name, fn) => handlers.set(name, fn), router, settings: {}, claude: {} });
  const options = handlers.get('native:run-options');
  for (const patch of [{ env: {} }, { fast: true, env: {} }, { model: 1 }, { effort: 'not a level' }, { effort: 1 }, { fast: 'yes' }, { cwd: '/other' }, []]) assert.throws(() => options('t', 'r', patch));
  assert.equal(calls.length, 0, 'execution options and malformed patches never reach the router');
  options('t', 'r', {}); assert.deepEqual(calls.at(-1), ['runOptions', 't', 'r', {}]);
  options('t', 'r', { model: null, effort: null, fast: false });
  options('t', 'r', { fast: true }); assert.deepEqual(calls.at(-1), ['runOptions', 't', 'r', { fast: true }]);
  const shell = handlers.get('native:shell');
  assert.throws(() => shell('t', 'r', 'id', { command: 'echo', env: {} }));
  shell('t', 'r', 'id', 'echo'); assert.deepEqual(calls.at(-1), ['shell', 't', 'r', 'id', 'echo']);
  // Effort names are the provider's. Native controls reject malformed syntax before a query;
  // the provider decides which bounded names it supports. Fast remains a boolean run option.
  const f = fixture(t), bound = new Map();
  const native = createNativeSessions({ directory: path.join(f.root, 'native'), claude: f.runtime, codex: {}, emit() {},
    resolveSpec: id => ({ owner: 'gui', cwd: f.root, env: { PATH: '' }, terminalId: id, projectId: 'project', agent: 'claude' }),
    activateNative() {}, terminal: () => assert.fail('no terminal'), saveSession() {} });
  t.after(() => native.close());
  native.register((name, fn) => bound.set(name, fn));
  const started = await native.start('terminal', { agent: 'claude' });
  await assert.rejects(async () => bound.get('native:run-options')('terminal', started.runtimeSessionId, { effort: 'not a level' }));
  assert.equal(f.fake.calls.length, 0, 'malformed effort syntax reaches no query');
  assert.equal((await bound.get('native:run-options')('terminal', started.runtimeSessionId, { effort: 'low' })).effort, 'low');
  assert.equal((await bound.get('native:run-options')('terminal', started.runtimeSessionId, { fast: true })).fast, true);
  assert.deepEqual(f.flags.at(-1), { fastMode: true });
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
