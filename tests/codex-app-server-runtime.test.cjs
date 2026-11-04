const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { createRpc, MAX_FRAME } = require('../electron/features/codex-app-server/rpc.cjs');
const { mergeLimits, tokenUsage } = require('../electron/features/codex-app-server/account.cjs');
const { createEvents } = require('../electron/features/codex-app-server/events.cjs');

async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Synthetic runtime timeout');
}
function fixture(t, mode = 'normal') {
  const events = [], lifetime = resources(t), calls = [];
  const factory = createCodexRuntime({ resolveExecutable: async () => 'synthetic-only', now: () => 1000,
    spawnProcess: (_file, args, options) => {
      calls.push({ args, options });
      const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], {
        ...options, env: { ...options.env, SYNTHETIC_CODEX_MODE: mode } }); return lifetime.child(child);
    } });
  const spec = { projectId: 'project', terminalId: 'terminal', runtimeSessionId: 'runtime', cwd: os.tmpdir(),
    model: 'synthetic-model', effort: 'high', fast: true, env: { PATH: '', CODEX_HOME: path.join(os.tmpdir(), 'synthetic-codex-home') } };
  const runtime = factory.create(spec, event => events.push(event));
  lifetime.defer('close runtime', () => runtime.close());
  return { events, factory, runtime, spec, calls };
}

for (const allowFreshResume of [false, true]) test(`F14 a missing empty thread starts fresh only when the host proves no history (${allowFreshResume})`, async t => {
  const f = fixture(t, 'empty-thread');
  const spec = { ...f.spec, providerSessionId: '11111111-1111-4111-8111-111111111111', allowFreshResume };
  if (!allowFreshResume) await assert.rejects(f.runtime.resume(spec), error => error.missingThread === true);
  else {
    await f.runtime.resume(spec); assert.equal(f.runtime.threadResponse.thread.id, 'synthetic-thread');
    assert.equal(f.events.some(event => event.type === 'turn.started' || event.type === 'input.receipt'), false);
  }
});

test('native start, final snapshot replacement, completion dedup and limits are provider snapshots', async t => {
  const f = fixture(t); await f.runtime.start();
  assert.equal((await f.runtime.send({ clientMessageId: 'one', text: 'hello' })).status, 'delivered');
  await until(() => f.events.some(x => x.type === 'turn.completed'));
  assert.equal(f.events.filter(x => x.type === 'turn.started').length, 1);
  assert.equal(f.runtime.snapshot().state, 'idle');
  assert.equal(f.runtime.snapshot().items[0].content.text, 'final answer');
  assert.deepEqual(f.events.find(x => x.type === 'routing.updated').payload.observed, { model: null, effort: null, fast: null });
  assert.deepEqual(f.calls[0].args, ['app-server', '--listen', 'stdio://']);
  const limits = await f.runtime.readLimits();
  assert.equal(limits.resetCredits.availableCount, 2);
  assert.equal(limits.limitsById.codex.primary.resetsAtMs, 100000);
  assert.deepEqual(f.factory.limits('runtime'), limits);
  assert.ok(f.runtime.snapshot().events.every(x => x.replay));
});

test('busy input steers the same turn, duplicate IDs are idempotent and conflicts fail', async t => {
  const f = fixture(t, 'hold'); await f.runtime.start();
  await f.runtime.send({ clientMessageId: 'first', text: 'hello' });
  const [a, b] = await Promise.all([f.runtime.send({ clientMessageId: 'second', text: 'change' }), f.runtime.send({ clientMessageId: 'second', text: 'change' })]);
  assert.deepEqual(a, b); assert.equal(a.status, 'delivered');
  assert.equal(f.events.filter(x => x.type === 'turn.started').length, 1);
  await assert.rejects(f.runtime.send({ clientMessageId: 'second', text: 'conflict' }), /conflict/);
  await f.runtime.interrupt(); await until(() => f.runtime.snapshot().state === 'idle');
  assert.equal(f.events.find(x => x.type === 'turn.completed').payload.status, 'interrupted');
});

test('steer written before process loss becomes unknown, and duplicates never restart it', async t => {
  const f = fixture(t, 'disconnect'); await f.runtime.start();
  await f.runtime.send({ clientMessageId: 'first', text: 'hello' });
  const input = { clientMessageId: 'second', text: 'change' };
  assert.equal((await f.runtime.send(input)).status, 'unknown');
  assert.equal((await f.runtime.send(input)).status, 'unknown'); assert.equal(f.calls.length, 1);
});

test('explicit rejected steer verifies thread idle before starting a following turn', async t => {
  const f = fixture(t, 'race'); await f.runtime.start();
  await f.runtime.send({ clientMessageId: 'first', text: 'hello' });
  assert.equal((await f.runtime.send({ clientMessageId: 'second', text: 'following' })).status, 'delivered');
  assert.equal(f.events.filter(x => x.type === 'turn.started').length, 2);
  assert.equal((await f.runtime.history()).nextCursor, 'next-page');
});

test('request tickets wait, are consumed once, and closing cancels them without auto allow', async t => {
  const f = fixture(t, 'approval'); await f.runtime.start(); await f.runtime.send({ clientMessageId: 'first', text: 'hello' });
  await until(() => f.runtime.snapshot().requests.length);
  assert.equal(f.runtime.snapshot().state, 'waiting');
  const request = f.runtime.snapshot().requests[0];
  assert.throws(() => f.runtime.answer(request.requestId, { decision: 'invalid' }), /invalid/);
  f.runtime.answer(request.requestId, { decision: 'deny' });
  assert.throws(() => f.runtime.answer(request.requestId, { decision: 'allow' }), /expired/);
  assert.equal(f.events.filter(x => x.type === 'request.resolved').length, 1);
});

test('resumed threads have exclusive occupancy and release on close', async t => {
  const f = fixture(t), g = fixture(t);
  await f.runtime.resume({ providerSessionId: 'same-thread' });
  // Different runtime identity, same home and thread.
  g.spec.runtimeSessionId = 'second-runtime';
  const second = g.factory.create({ ...g.spec, runtimeSessionId: 'second-runtime' }, () => {});
  t.after(() => second.close());
  await assert.rejects(second.resume({ providerSessionId: 'same-thread' }), /thread_in_use/);
  await f.runtime.close();
});

test('sparse limits retain missing fields, never infer recovery, and reject unsafe integers', () => {
  const before = mergeLimits(null, { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1 } }, rateLimitResetCredits: { availableCount: 2 }, ordinaryUsageAllowed: false }, 'scope', 1);
  const after = mergeLimits(before, { rateLimits: { limitId: 'codex', secondary: { usedPercent: 1, resetsAt: 5 } } }, 'scope', 2);
  assert.equal(after.resetCredits.availableCount, 2); assert.equal(after.ordinaryUsageAllowed, false);
  assert.deepEqual(after.limitsById.codex.primary, before.limitsById.codex.primary);
  assert.equal(mergeLimits(after, { rateLimitResetCredits: { availableCount: 2 ** 60 } }, 'scope').resetCredits.availableCount, null);
  assert.equal(tokenUsage({ total: { outputTokens: 2 ** 60 } }).output, null);
});

function rpcFixture(onNotification = () => {}) {
  const child = new EventEmitter(), writes = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new Writable({ write(chunk, _encoding, callback) { writes.push(JSON.parse(chunk.toString())); callback(); } });
  return { child, writes, rpc: createRpc(child, { timeout: 30, onNotification }) };
}
test('JSONL handles split UTF-8, notifications, typed IDs and out-of-order responses', async () => {
  const notices = [], f = rpcFixture((method, params) => notices.push({ method, params }));
  const a = f.rpc.request('a', {}), b = f.rpc.request('b', {});
  const data = Buffer.from(JSON.stringify({ method: 'notice', params: { text: '汉字' } }) + '\n');
  const at = data.indexOf(Buffer.from('汉')) + 1; f.child.stdout.write(data.subarray(0, at)); f.child.stdout.write(data.subarray(at));
  f.child.stdout.write(JSON.stringify({ id: 1, result: 'wrong type' }) + '\n');
  f.child.stdout.write(JSON.stringify({ id: '2', result: 'b' }) + '\n' + JSON.stringify({ id: '1', result: 'a' }) + '\n');
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']); assert.equal(notices[0].params.text, '汉字'); f.rpc.close();
});
test('written timeouts, invalid JSON and overlarge frames settle pending RPC without replay', async () => {
  const f = rpcFixture(); await assert.rejects(f.rpc.request('turn/steer', {}), error => error.uncertain === true);
  assert.equal(f.writes.length, 1); f.rpc.close();
  for (const text of ['broken\n', 'x'.repeat(MAX_FRAME + 1)]) {
    const g = rpcFixture(), pending = assert.rejects(g.rpc.request('query', {})); g.child.stdout.write(text); await pending; g.rpc.close();
  }
});

test('final items replace deltas, duplicate finals and raw reasoning are ignored', () => {
  const seen = [], events = createEvents({ projectId: 'p', terminalId: 't', runtimeSessionId: 'r' }, x => seen.push(x), () => 1);
  events.notification('item/agentMessage/delta', { itemId: 'a', delta: 'partial' });
  events.notification('item/completed', { item: { id: 'a', type: 'agentMessage', text: 'final' } });
  events.notification('item/completed', { item: { id: 'a', type: 'agentMessage', text: 'duplicate' } });
  events.notification('item/reasoning/textDelta', { itemId: 'secret', delta: 'not displayed' });
  assert.equal(seen.length, 2); assert.equal(events.snapshot().items[0].content.text, 'final');
});

test('backpressure preserves one write per request and queued timeouts are not delivery unknown', async () => {
  const child = new EventEmitter(), writes = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new EventEmitter(); child.stdin.end = () => {};
  child.stdin.write = line => { writes.push(JSON.parse(line)); return false; };
  const rpc = createRpc(child, { timeout: 40 });
  const first = rpc.request('first', {}), second = rpc.request('second', {});
  const firstCheck = assert.rejects(first, error => error.uncertain === true);
  const secondCheck = assert.rejects(second, error => error.uncertain === false);
  await Promise.all([firstCheck, secondCheck]); assert.equal(writes.length, 1);
  child.stdin.emit('drain'); assert.equal(writes.length, 1, 'an expired queued input is not written after drain'); rpc.close();
});

test('EPIPE rejects written requests without rewriting them and truncated frames disconnect', async () => {
  const f = rpcFixture(), failed = assert.rejects(f.rpc.request('turn/start', {}), error => error.uncertain === true);
  f.child.stdin.emit('error', Object.assign(new Error('synthetic'), { code: 'EPIPE' })); await failed; assert.equal(f.writes.length, 1);
  const g = rpcFixture(), pending = assert.rejects(g.rpc.request('read', {}), /truncated_frame/);
  g.child.stdout.end('{'); await pending;
});

test('snapshot reconstructs an item after more than one event window of deltas', () => {
  const events = createEvents({ projectId: 'p', terminalId: 't', runtimeSessionId: 'r' }, () => {}, () => 1);
  for (let n = 0; n < 500; n++) events.notification('item/agentMessage/delta', { itemId: 'a', delta: 'x' });
  const snapshot = events.snapshot(); assert.equal(snapshot.lastSequence, 500);
  assert.equal(snapshot.events.length, 1); assert.equal(snapshot.events[0].payload.content.text.length, 500);
});
