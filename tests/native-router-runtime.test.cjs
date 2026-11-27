const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { choosePath } = require('../electron/features/native-session/routing.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { createSettings } = require('../electron/features/native-session/settings.cjs');
const { readJson, recoveryWarnings } = require('../electron/features/native-session/storage.cjs');
const { registerIpc } = require('../electron/features/native-session/ipc.cjs');
const { createEventStream } = require('../electron/features/native-session/events.cjs');
const { validEvent } = require('../electron/features/native-session/validate.cjs');
const { createIpcAdapter } = require('../electron/shared/ipc.cjs');
const { terminalPreparation, completeSwitch } = require('./fixtures/native-switch.cjs');

test('native storage retries temporary reads, propagates persistent errors and only isolates invalid content', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-json-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json'), fallback = { version: 0 }, valid = value => value?.version === 1;
  assert.deepEqual(readJson(file, fallback), fallback);
  fs.writeFileSync(file, '\uFEFF{"version":1}');
  const open = fs.openSync; let attempts = 0, failures = ['EBUSY', 'EPERM', 'EMFILE'];
  t.mock.method(fs, 'openSync', (filename, ...args) => {
    if (filename === file) {
      ++attempts;
      const code = failures.shift();
      if (code) throw Object.assign(new Error(code), { code });
    }
    return open(filename, ...args);
  });
  assert.deepEqual(readJson(file, fallback, { validate: valid }), { version: 1 });
  assert.equal(attempts, 4);
  for (const code of ['EBUSY', 'EPERM', 'EMFILE', 'EACCES']) {
    attempts = 0; failures = Array(4).fill(code);
    assert.throws(() => readJson(file, fallback), { code });
    assert.equal(attempts, code === 'EACCES' ? 1 : 4);
    assert.deepEqual(fs.readdirSync(root), ['settings.json']);
    assert.deepEqual(recoveryWarnings(root), []);
  }
  failures = [];
  assert.equal(fs.readFileSync(file, 'utf8'), '\uFEFF{"version":1}');
  for (const content of ['{', '{"version":2}']) {
    fs.writeFileSync(file, content);
    assert.deepEqual(readJson(file, fallback, { validate: valid }), fallback);
    assert.equal(fs.existsSync(file), false);
  }
  assert.deepEqual(fs.readdirSync(root).map(name => fs.readFileSync(path.join(root, name), 'utf8')).sort(), ['{', '{"version":2}']);
  assert.ok(recoveryWarnings(root, true).length);
});

for (const setting of ['api-then-terminal', 'api-only', 'terminal-only']) test(`Claude routing obeys ${setting} for available and unavailable API`, () => {
  for (const status of ['ready', 'no_key', 'account_limit', 'rate_limited', 'credits_exhausted', 'native_cli_required']) {
    const expected = setting === 'terminal-only' ? 'terminal' : status === 'ready' ? 'api' : setting === 'api-only' ? null : 'terminal';
    assert.equal(choosePath({ agent: 'claude', claudePath: setting, apiState: { status } }).path, expected);
  }
});
test('Codex always selects app-server even with a legacy terminal preference', () => {
  assert.equal(choosePath({ agent: 'codex' }).path, 'native'); assert.equal(choosePath({ agent: 'codex', codexView: 'terminal' }).path, 'native');
});

test('an explicit shell resume with no matching history refuses instead of starting a different thread', async t => {
  const f = fixture(); t.after(() => f.router.close());
  await assert.rejects(f.router.start('t', { agent: 'codex', resume: true, launch: { resume: true, latest: true } }), /没有找到可恢复的 Codex 会话/);
  assert.equal(f.created.length, 0); assert.equal(f.terminals.length, 0);
});
function fixture(config = {}, resolveSpec = (id, agent) => ({ projectId: 'p', terminalId: id, cwd: '/fake', agent })) {
  const events = [], terminals = [], created = [], settings = { get: () => ({ claudePath: 'api-then-terminal', codexView: 'native', monthlyBudgetUsd: null, ...config }) };
  const claude = { facts: () => [], usage: { summary: () => ({ month: '2026-11', todayUsdMicros: 0, monthUsdMicros: 0, estimated: true }) },
    credentials: { clear: () => ({ saved: false }) }, create(spec, emit) {
      let state = 'stopped';
      const stream = createEventStream(spec, event => { events.push(event); emit(event); }, () => 100);
      const runtime = { async start() { if (claude.fail) throw Object.assign(new Error(), { code: claude.fail }); state = 'idle'; stream.publish('session.state', { state, reason: null }); },
        resume() { return this.start(); }, send(input) { return input; }, interrupt() { return 'interrupted'; }, answer(id, answer) { return { id, answer }; },
        snapshot() { return { ...stream.snapshot(), state }; }, async close() { state = 'stopped'; } };
      created.push({ spec, runtime }); return runtime;
    } };
  const router = createRouter({ claude, codex: claude, settings, resolveSpec,
    prepareTerminal: terminalPreparation(spec => terminals.push([spec])), terminal: async (...args) => terminals.push(args), emit() {} });
  return { router, claude, terminals, created, settings, events };
}
for (const action of ['stop', 'forget', 'replace']) test(`a failing runtime close releases the thread during ${action}`, async t => {
  const { router, created } = fixture({}, id => ({ projectId: 'p', terminalId: id, cwd: '/fake', providerSessionId: 'existing' }));
  t.after(() => router.close());
  const first = await router.start('t', { agent: 'codex', resume: true });
  const runtime = created[0].runtime, close = runtime.close;
  if (action === 'replace') await close();
  runtime.close = async () => { await close(); runtime.close = close; throw new Error('process_stop_timeout'); };
  const retiring = action === 'replace' ? router.start('t', { agent: 'codex', resume: true }) : router[action]('t', first.runtimeSessionId);
  await assert.rejects(retiring, { message: 'process_stop_timeout' });
  const next = await router.start('other', { agent: 'codex', resume: true });
  assert.equal(router.snapshot('other').runtimeSessionId, next.runtimeSessionId);
});

test('a runtime construction error leaves the restored thread free for another terminal', async t => {
  const { router, claude } = fixture({}, id => ({ projectId: 'p', terminalId: id, cwd: '/fake', providerSessionId: 'existing' }));
  t.after(() => router.close());
  const create = claude.create;
  claude.create = () => { throw new Error('synthetic_storage_failure'); };
  await assert.rejects(router.start('t', { agent: 'codex', resume: true }), { message: 'synthetic_storage_failure' });
  claude.create = create;
  assert.ok((await router.start('other', { agent: 'codex', resume: true })).runtimeSessionId);
});

test('the router retries the same seat after a rejected routing update', async t => {
  const { router, created } = fixture();
  t.after(() => router.close());
  await router.start('t', { agent: 'codex' });
  const { spec, runtime } = created[0], routing = { model: 'synthetic', effort: 'medium', fast: true };
  let calls = 0;
  runtime.applyRouting = async value => { if (++calls === 1) throw new Error('rpc_failed'); return value; };
  await assert.rejects(router.applyRouting('t', routing), { message: 'rpc_failed' });
  assert.equal(spec.model, undefined);
  assert.deepEqual(await router.applyRouting('t', routing), routing);
  assert.equal(spec.model, routing.model);
  assert.equal(await router.applyRouting('t', routing), null);
  assert.equal(calls, 2);
});

test('a rejected native input keeps its reason when the router records the unsent draft', async t => {
  const { router, created } = fixture();
  t.after(() => router.close());
  const { runtimeSessionId } = await router.start('t', { agent: 'claude' });
  const rejected = { status: 'rejected', reason: 'synthetic reason' };
  created[0].runtime.send = async () => rejected;
  const input = { clientMessageId: 'unsent', text: 'keep this' };
  assert.deepEqual(await router.send('t', runtimeSessionId, input), rejected);
  const item = router.snapshot('t').events.find(event => event.itemId === input.clientMessageId);
  assert.equal(item.payload.content.text, input.text);
  assert.equal(item.payload.content.unsent, true);
});
test('an owner Claude quota refusal under API-only cannot move a running Codex off app-server', async t => {
  const { router, claude } = fixture({ claudePath: 'api-only' }); t.after(() => router.close());
  claude.facts = () => [{ name: 'limit', reason: { code: 'claude.credits_exhausted' } }];
  await router.start('t', { agent: 'codex' }); router.reconcile();
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(router.switchState('t'), null);
});
test('native router owns session identity and rejects old runtime answers', async () => {
  const { router, created } = fixture(); const first = await router.start('t', { agent: 'codex' });
  await router.stop('t', first.runtimeSessionId); const second = await router.start('t', { agent: 'codex' });
  assert.notEqual(first.runtimeSessionId, second.runtimeSessionId); assert.throws(() => router.answer('t', first.runtimeSessionId, 'r', {}));
  assert.equal(created.length, 2); assert.equal(router.snapshot('t').runtimeSessionId, second.runtimeSessionId);
});
test('api-only does not fall back when native Claude is missing', async () => {
  const { router, claude, terminals } = fixture({ claudePath: 'api-only' }); claude.fail = 'native_cli_required';
  await assert.rejects(router.start('t', { agent: 'claude' })); assert.equal(terminals.length, 0);
});
test('missing native Claude falls back only under api-then-terminal', async () => {
  const { router, claude, terminals } = fixture(); claude.fail = 'native_cli_required';
  await router.start('t', { agent: 'claude' }); assert.equal(terminals.length, 1); assert.equal(terminals[0][1], 'native_cli_required');
  assert.equal(router.usage().agents.claude.path, 'terminal');
});
test('fallback at a message boundary never replays the submitted text', async () => {
  const { router, claude, terminals, created } = fixture(); const first = await router.start('t', { agent: 'claude' });
  claude.facts = () => [{ name: 'limit', reason: { code: 'claude.account_limit' } }];
  const receipt = await router.send('t', first.runtimeSessionId, { clientMessageId: 'message', text: 'must not replay' });
  assert.equal(receipt.status, 'rejected'); assert.equal(terminals.length, 0); assert.ok(!JSON.stringify(terminals).includes('must not replay'));
  assert.equal(created[0].runtime.snapshot().state, 'idle', 'the old path remains alive until handoff and readiness');
  await completeSwitch(router, 't'); assert.equal(terminals.length, 1); assert.equal(created[0].runtime.snapshot().state, 'stopped');
  assert.ok(router.snapshot('t').events.some(event => event.type === 'item.upsert' && event.payload.content.unsent === true && event.payload.content.text === 'must not replay'));
});
test('an active runtime cannot be replaced by a concurrent start', async () => {
  const { router } = fixture(); await router.start('t', { agent: 'claude' }); await assert.rejects(router.start('t', { agent: 'codex' }));
});

function sshCodex(t, { savedId = null, startGate, resumeError } = {}) {
  let stream;
  const saves = [], invalidated = [], calls = [];
  const codex = { create(spec, emit) {
    const events = createEventStream(spec, emit);
    stream = events;
    let state = 'starting';
    const open = async resume => {
      calls.push(resume ? 'resume' : 'start');
      events.publish('session.state', { state, reason: null });
      if (resume && resumeError) throw resumeError;
      if (startGate) await startGate;
      const providerSessionId = spec.providerSessionId || 'fresh';
      events.provider(providerSessionId);
      state = 'idle'; events.publish('session.state', { state, reason: null });
      return { providerSessionId };
    };
    return { start: () => open(false), resume: () => open(true), snapshot: () => ({ state }),
      async close() { state = 'stopped'; }, send: () => assert.fail('send reached the provider') };
  } };
  const router = createRouter({ claude: {}, codex, emit() {}, settings: { get: () => ({}) },
    resolveSpec: (terminalId, _agent, resume) => ({ projectId: 'p', terminalId, kind: 'ssh', cwd: '/remote', providerSessionId: resume ? savedId : null }),
    saveSession: (_id, saved) => saves.push(saved.providerSessionId),
    invalidateSession: (_id, threadId) => invalidated.push(threadId) });
  t.after(() => router.close());
  return { router, saves, invalidated, calls, startTurn(replay = false) {
    stream.turn('turn');
    stream.publish('turn.started', { origin: 'user', clientMessageId: null }, { replay });
  } };
}

test('an SSH Codex thread becomes history only after a live turn starts', async t => {
  const f = sshCodex(t);
  await f.router.start('t', { agent: 'codex' });
  assert.deepEqual(f.saves, []);
  f.startTurn(true);
  assert.deepEqual(f.saves, []);
  f.startTurn();
  f.startTurn();
  assert.deepEqual(f.saves, ['fresh']);
});

test('a confirmed SSH Codex resume retains history before another turn, and other failures leave the saved ID intact', async t => {
  const resumed = sshCodex(t, { savedId: 'existing' });
  await resumed.router.start('t', { agent: 'codex', resume: true });
  assert.deepEqual(resumed.saves, ['existing']);
  const failed = sshCodex(t, { savedId: 'existing', resumeError: Object.assign(new Error('timeout'), { stage: 'thread_resume' }) });
  await assert.rejects(failed.router.start('t', { agent: 'codex', resume: true }));
  assert.deepEqual(failed.invalidated, []);
  assert.deepEqual(failed.saves, []);
});

test('SSH Codex discards a missing rollout and starts a fresh conversation directly from the failed session', async t => {
  const resumeError = Object.assign(new Error('rpc_rejected'), { code: -32600, stage: 'thread_resume', missingThread: true });
  const f = sshCodex(t, { savedId: 'stale', resumeError });
  await assert.rejects(f.router.start('t', { agent: 'codex', resume: true }));
  assert.deepEqual(f.invalidated, ['stale']);
  assert.deepEqual(f.saves, []);
  const next = await f.router.newConversation('t', f.router.snapshot('t').runtimeSessionId);
  assert.equal(f.router.snapshot('t').runtimeSessionId, next.runtimeSessionId);
  assert.deepEqual(f.calls, ['resume', 'start']);
  assert.deepEqual(f.saves, []);
});

test('sending to a starting or failed Codex session reports its connection state', async t => {
  const gate = Promise.withResolvers(), f = sshCodex(t, { startGate: gate.promise });
  const startup = f.router.start('t', { agent: 'codex' });
  const failed = assert.rejects(startup);
  const send = () => f.router.send('t', f.router.snapshot('t').runtimeSessionId, { clientMessageId: 'm', text: 'keep this' });
  const starting = send().catch(error => error);
  gate.reject(new Error('startup failure'));
  await failed;
  await assert.rejects(send(), { message: '会话未能连接，请点击「开始新的对话」重试。' });
  assert.equal((await starting).message, '会话正在启动，请稍后重试。');
});
test('settings validate exact fields and persist independently of workspace settings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-native-settings-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json'), settings = createSettings(file);
  assert.equal(settings.get().claudePath, 'api-then-terminal');
  settings.set({ claudePath: 'api-only' }); assert.equal(createSettings(file).get().claudePath, 'api-only');
  for (const patch of [{ env: {} }, { claudePath: 'subscription-first' }, { monthlyBudgetUsd: NaN }, { monthlyBudgetUsd: -1 }, { key: 'not-allowed' }]) assert.throws(() => settings.set(patch));
});
test('native IPC denies extra options and accepts only bound structured answers', () => {
  const handles = new Map(), { router, settings, claude } = fixture();
  registerIpc({ handle: (name, fn) => handles.set(name, fn), router, settings, claude });
  assert.throws(() => handles.get('native:start')('t', { agent: 'claude', cwd: '/untrusted' }));
  assert.throws(() => handles.get('native:send')('t', 's', 'm', '', []));
  assert.throws(() => handles.get('native:send')('t', 's', 'm', 'text', ['/untrusted.png']));
  assert.throws(() => handles.get('native:answer')('t', 's', 'r', { decision: 'allow', env: {} }));
  assert.throws(() => handles.get('native:answer')('t', 's', 'r', { answers: { q: { secret: true } } }));
});
test('native owner start and resume admit agy through the provider registry', () => {
  const handles = new Map(), router = { start: (id, options) => ({ id, ...options }) };
  registerIpc({ handle: (name, fn) => handles.set(name, fn), router });
  assert.deepEqual(handles.get('native:start')('t', { agent: 'agy' }), { id: 't', agent: 'agy' });
  const sessionId = '670f1895-da18-4940-b596-4e80e0c3c387';
  assert.deepEqual(handles.get('native:resume')('t', { agent: 'agy', sessionId }), { id: 't', agent: 'agy', sessionId, resume: true });
  assert.throws(() => handles.get('native:resume')('t', { agent: 'codex', sessionId }));
  for (const name of ['native:start', 'native:resume']) assert.throws(() => handles.get(name)('t', { agent: 'unknown' }));
});
test('native IPC uses the existing main-frame and origin checks', async () => {
  const handles = new Map(), mainFrame = { url: 'agentrix://app/index.html' }, webContents = { mainFrame };
  const { handle } = createIpcAdapter({ ipcMain: { handle: (name, fn) => handles.set(name, fn) }, getWindow: () => ({ webContents }), t: value => value, report() {} });
  handle('native:test', () => true);
  await assert.rejects(handles.get('native:test')({ sender: {}, senderFrame: mainFrame }));
  await assert.rejects(handles.get('native:test')({ sender: webContents, senderFrame: { url: mainFrame.url } }));
  assert.deepEqual(await handles.get('native:test')({ sender: webContents, senderFrame: mainFrame }), { ok: true, value: true });
});
test('event snapshots replace deltas and replay without advancing sequence', () => {
  const live = [], stream = createEventStream({ agent: 'claude', projectId: 'p', terminalId: 't', runtimeSessionId: 'r' }, event => live.push(event), () => 1);
  stream.publish('item.delta', { channel: 'text', text: 'par' }, { itemId: 'i' });
  stream.publish('item.delta', { channel: 'text', text: 'tial' }, { itemId: 'i' });
  stream.publish('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'final' } }, { itemId: 'i' });
  const snapshot = stream.snapshot(); assert.equal(snapshot.events.length, 1); assert.equal(snapshot.events[0].payload.content.text, 'final');
  assert.equal(snapshot.lastSequence, 3); assert.equal(snapshot.events[0].replay, true); assert.equal(live.length, 3);
  assert.ok(live.every(validEvent)); assert.equal(validEvent({ ...live[0], schemaVersion: 2 }), false);
});
test('unknown usage fields must be null rather than fabricated zeroes', () => {
  const stream = createEventStream({ agent: 'claude', projectId: 'p', terminalId: 't', runtimeSessionId: 'r' }, () => {}, () => 1);
  const event = stream.publish('usage.updated', { input: null, cachedInput: null, cacheWrite: null, output: null, reasoning: null, contextWindow: null, costUsdMicros: null, costEstimated: true });
  assert.ok(validEvent(event)); assert.equal(validEvent({ ...event, payload: { ...event.payload, input: undefined } }), false);
});
