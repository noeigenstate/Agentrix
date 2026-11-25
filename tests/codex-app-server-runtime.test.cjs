const { test, resources, removeTree } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createCodexRuntime, replaceContextCwd, releaseTurnInputs } = require('../electron/features/codex-app-server/index.cjs');
const { createRpc, MAX_FRAME } = require('../electron/features/codex-app-server/rpc.cjs');
const { mergeLimits, tokenUsage } = require('../electron/features/codex-app-server/account.cjs');
const { createEvents } = require('../electron/features/codex-app-server/events.cjs');

function memoryServer(reply) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const { id, method, params } = JSON.parse(chunk.toString());
    if (id != null) queueMicrotask(() => reply({ id, method, params }, send));
    callback();
  } });
  return child;
}

test('a stop timeout preserves both the original startup error and the failed session state', async () => {
  const events = [];
  const child = memoryServer(({ id }, send) => send({ id, result: { userAgent: 'codex/0.165.0' } }));
  const factory = createCodexRuntime({ resolveExecutable: async () => 'fake-only', spawnProcess: () => child,
    stopChild: async () => { throw new Error('process_stop_timeout'); } });
  const session = factory.create({ cwd: os.tmpdir(), env: {} }, event => events.push(event));
  await assert.rejects(session.start(), { code: 'unsupported_codex_version' });
  assert.equal(session.snapshot().state, 'failed');
  assert.deepEqual(events.findLast(event => event.type === 'session.state').payload, { state: 'failed', reason: 'unsupported_codex_version' });
});

test('a stop timeout preserves the history result and disposes the transport', async () => {
  const cwd = os.tmpdir(); let disposed = false;
  const child = memoryServer(({ id, method }, send) => send({ id, result: method === 'initialize'
    ? { userAgent: 'codex/0.166.0' } : { data: [{ id: 'history-thread', cwd, name: 'Prior thread', updatedAt: 5 }] } }));
  child.dispose = () => { disposed = true; };
  const factory = createCodexRuntime({ resolveExecutable: async () => 'fake-only', spawnProcess: () => child,
    stopChild: async () => { throw new Error('process_stop_timeout'); } });
  assert.deepEqual(await factory.history({ cwd, env: {} }), { id: 'history-thread', title: 'Prior thread', at: 5000 });
  assert.equal(disposed, true);
});

test('changing the Codex working directory rewrites both slash forms at path boundaries', () => {
  const cwd = 'C:\\proj', wireCwd = 'C:\\expanded';
  const context = 'Use "C:\\proj\\README" and C:/proj/skills (C:\\proj), keep C:\\proj2\\README and C:/project.';
  assert.equal(replaceContextCwd(context, cwd, wireCwd),
    'Use "C:\\expanded\\README" and C:/expanded/skills (C:\\expanded), keep C:\\proj2\\README and C:/project.');
});

test('finishing a Codex turn discards input payloads except the candidate for one safe retry', () => {
  const image = { type: 'image', url: 'data:image/png;base64,c3ludGhldGlj' };
  const done = { status: 'consumed', input: [image] }, retry = { status: 'delivered', input: [image] };
  const entries = new Set([done, retry]);
  releaseTurnInputs(entries, retry);
  assert.deepEqual(done, { status: 'consumed' });
  assert.deepEqual(retry, { status: 'delivered', input: [image] });
  assert.equal(entries.size, 0);
});

test('Codex keeps accepting inputs after its receipt cap, while recent inputs still deduplicate', async t => {
  const cwd = os.tmpdir(), idle = new EventEmitter();
  let turns = 0;
  const child = memoryServer(({ id, method, params }, send) => {
    if (method === 'initialize') send({ id, result: { userAgent: 'codex/0.166.0' } });
    else if (method === 'thread/start') send({ id, result: { thread: { id: 'receipt-cap-thread' }, sandbox: { type: 'workspaceWrite' } } });
    else if (!params.threadId) send({ id, error: { code: -32602, message: 'Required threadId' } });
    else if (method === 'turn/start') {
      const turn = { id: String(++turns), status: 'inProgress' };
      send({ id, result: { turn } });
      send({ method: 'turn/started', params: { turn } });
      send({ method: 'turn/completed', params: { turn: { ...turn, status: 'completed' } } });
    }
  });
  const factory = createCodexRuntime({ resolveExecutable: async () => 'fake-only', spawnProcess: () => child, stopChild: async () => {} });
  const session = factory.create({ cwd, env: {} }, event => { if (event.type === 'session.state' && event.payload.state === 'idle') idle.emit('idle'); });
  t.after(() => session.close());
  await session.start();
  for (let number = 0; number <= 2000; number++) {
    const settled = once(idle, 'idle');
    assert.equal((await session.send({ clientMessageId: String(number), text: 'synthetic input' })).status, 'delivered');
    await settled;
  }
  assert.equal((await session.send({ clientMessageId: '2000', text: 'synthetic input' })).status, 'delivered');
  assert.equal(turns, 2001);
});

async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Synthetic runtime timeout');
}
function fixture(t, mode = 'normal') {
  const events = [], lifetime = resources(t), calls = [], reported = new EventEmitter();
  const factory = createCodexRuntime({ resolveExecutable: async () => 'synthetic-only', now: () => 1000,
    spawnProcess: (_file, args, options) => {
      calls.push({ args, options });
      const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], {
        ...options, env: { ...options.env, SYNTHETIC_CODEX_MODE: mode } }); return lifetime.child(child);
    } });
  const spec = { projectId: 'project', terminalId: 'terminal', runtimeSessionId: 'runtime', cwd: os.tmpdir(),
    model: 'synthetic-model', effort: 'high', fast: true, env: { PATH: '', CODEX_HOME: path.join(os.tmpdir(), 'synthetic-codex-home') } };
  const runtime = factory.create(spec, event => { events.push(event); if (event.type === 'turn.completed') reported.emit(event.type, event.payload); });
  lifetime.defer('close runtime', () => runtime.close());
  return { events, factory, runtime, spec, calls, reported };
}
for (const mode of ['structured', 'spend-limit']) test(`G8 real app-server adapter forwards ${mode} structured turn data`, async t => {
  const f = fixture(t, mode); await f.runtime.start(); await f.runtime.send({ clientMessageId: 'structured-input', text: 'offline' });
  await until(() => f.events.some(event => event.type === 'turn.completed'));
  const result = f.events.find(event => event.type === 'turn.completed').payload;
  assert.equal(result.costUsdMicros, null);
  if (mode === 'structured') { assert.equal(result.durationMs, 123); assert.equal(result.tokens.input, 10); assert.equal(result.tokens.output, 3); }
  else { assert.equal(result.status, 'failed'); assert.equal(result.terminalReason, 'usageLimitExceeded'); assert.match(result.message, /用量/);
    assert.equal(f.events.find(event => event.type === 'limits.updated' && event.payload.notice)?.payload.notice.code, 'spend_limit'); assert.equal(JSON.stringify(f.events).includes('Never expose'), false); }
});

for (const allowFreshResume of [false, true]) test(`F14 a missing empty thread starts fresh only when the host proves no history (${allowFreshResume})`, async t => {
  const f = fixture(t, 'empty-thread');
  const spec = { ...f.spec, providerSessionId: '11111111-1111-4111-8111-111111111111', allowFreshResume };
  if (!allowFreshResume) await assert.rejects(f.runtime.resume(spec), error => error.missingThread === true);
  else {
    await f.runtime.resume(spec); assert.equal(f.runtime.threadResponse.thread.id, 'synthetic-thread');
    assert.equal(f.events.some(event => event.type === 'turn.started' || event.type === 'input.receipt'), false);
  }
});

test('Codex reports weekly quota without a rejection, shows a failed request and clears it after success', async t => {
  const { events, runtime, reported } = fixture(t, 'weekly-limit');
  await runtime.start();
  const turn = async (id, status) => {
    const done = once(reported, 'turn.completed');
    assert.equal((await runtime.send({ clientMessageId: id, text: id })).status, 'delivered');
    assert.equal((await done)[0].status, status);
  };
  const limits = () => events.findLast(event => event.type === 'limits.updated').payload;
  await turn('allowed', 'completed');
  assert.equal(limits().limitsById.codex.secondary.usedPercent, 100);
  assert.equal(events.some(event => event.type === 'limits.updated' && event.payload.notice), false);
  await turn('refused', 'failed');
  assert.deepEqual(limits().notice, { code: 'rate_limited', message: 'Codex 请求受到限流。', resetsAtMs: 200000 });
  const refusal = events.length;
  await turn('recovered', 'completed');
  assert.equal(limits().notice, null);
  assert.equal(limits().limitsById.codex.secondary.usedPercent, 100);
  assert.equal(events.slice(refusal).some(event => event.type === 'limits.updated' && event.payload.notice && event.payload.providerStatus !== 'rejected'), false);
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

test('closing a local session stops every process its app-server started, and the folder they ran in can be removed', async t => {
  const fs = require('node:fs'), lifetime = resources(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-codex-tree-'));
  const cwd = path.join(root, 'project'), pidFile = path.join(root, 'helper.pid'); fs.mkdirSync(cwd);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
  let helper = null;
  lifetime.defer('stop a surviving helper and remove the folder', async () => {
    if (helper && alive(helper)) process.kill(helper, 'SIGKILL');
    await removeTree(root);
  });
  const factory = createCodexRuntime({ resolveExecutable: async () => 'synthetic-only', spawnProcess: (_file, args, options) => lifetime.child(spawn(process.execPath,
    [path.join(__dirname, 'fixtures/codex-app-server.cjs'), ...args], { ...options, env: { ...options.env, SYNTHETIC_CODEX_MODE: 'grandchild', SYNTHETIC_GRANDCHILD_PID: pidFile } })) });
  const session = factory.create({ projectId: 'project', terminalId: 'tree', cwd, env: { PATH: '', CODEX_HOME: path.join(root, 'home') } }, () => {});
  lifetime.defer('close runtime', () => session.close());
  await session.start();
  helper = Number(fs.readFileSync(pidFile, 'utf8')); assert.ok(alive(helper));
  // The stand-in leaves on end of input as Codex does: a tree stop that comes after that finds no tree to stop.
  await session.close();
  await until(() => !alive(helper));
  await removeTree(cwd);
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

test('RPC write receipts follow the actual write, including backpressure, and never fire for an expired queued request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new EventEmitter(), writes = [], received = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new EventEmitter(); child.stdin.end = () => {};
  child.stdin.write = line => { writes.push(JSON.parse(line)); return false; };
  const rpc = createRpc(child, { timeout: 100 }); t.after(() => rpc.close());
  const first = rpc.request('first', {}, 100, { onWritten: () => received.push(writes.at(-1).method) });
  const second = rpc.request('second', {}, 100, { onWritten: () => received.push(writes.at(-1).method) });
  assert.deepEqual(received, ['first']);
  child.stdin.emit('drain'); assert.deepEqual(received, ['first', 'second']);
  const expired = assert.rejects(rpc.request('expired', {}, 100, { onWritten: () => received.push('expired') }), error => error.uncertain === false);
  const firstCheck = assert.rejects(first, error => error.uncertain === true), secondCheck = assert.rejects(second, error => error.uncertain === true);
  t.mock.timers.tick(100); await Promise.all([firstCheck, secondCheck, expired]);
  child.stdin.emit('drain'); assert.deepEqual(received, ['first', 'second']);
});

test('a permissions RPC gets its full response deadline after a queued write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new EventEmitter(); child.stdin.end = () => {}; child.stdin.write = () => false;
  const rpc = createRpc(child, { timeout: 100 }); t.after(() => rpc.close());
  const first = assert.rejects(rpc.request('first', {}), error => error.uncertain === true);
  const changed = rpc.request('thread/settings/update', {}, 100, { timeoutFromWrite: true }); changed.catch(() => {});
  t.mock.timers.tick(90); child.stdin.emit('drain');
  t.mock.timers.tick(10); await first;
  child.stdout.write(JSON.stringify({ id: '2', result: {} }) + '\n');
  assert.deepEqual(await changed, {}, 'queueing did not consume the written request response interval');
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

test('a failed start reaps an exited child whose inherited pipes keep close open', async t => {
  const lifetime = resources(t), child = new EventEmitter(), initialized = Promise.withResolvers(), armed = Promise.withResolvers();
  const timers = { setTimeout(fn, delay) { const task = { fn, delay }; armed.resolve(task); return task; }, clearTimeout() {} };
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.stdin = new Writable({ write(_bytes, _encoding, done) { initialized.resolve(); done(); } });
  let closed = false;
  for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.on('close', () => {
    if (!closed && [child.stdin, child.stdout, child.stderr].every(stream => stream.destroyed)) { closed = true; child.emit('close', 127); }
  });
  const factory = createCodexRuntime({ timers, resolveExecutable: async () => 'synthetic-only', spawnProcess: () => lifetime.child(child) });
  const session = factory.create({ projectId: 'p', terminalId: 't', cwd: os.tmpdir(), env: { PATH: '' } }, () => {});
  lifetime.defer('close runtime', () => session.close());
  const failure = assert.rejects(session.start(), error => /exit 127/.test(error.detail));
  await initialized.promise; child.exitCode = 127; child.emit('exit', 127);
  const timer = await armed.promise; assert.equal(timer.delay, 3000); timer.fn(); await failure;
  assert.equal(closed, true, 'the host released the inherited pipes and received close before reporting the detail');
});

test('startup diagnostics end when the bounded stop settles, even when the exited child never reports close', async () => {
  const child = new EventEmitter(), armed = Promise.withResolvers(), stopped = Promise.withResolvers();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.exitCode = null;
  const timers = { setTimeout(fn, delay) { const task = { fn, delay }; armed.resolve(task); return task; }, clearTimeout() {} };
  const rpc = createRpc(child);
  child.stderr.emit('data', 'last words before exit'); child.exitCode = 1; child.emit('exit', 1);
  const diagnostics = rpc.diagnostics({ stop: () => stopped.promise, timers });
  const timer = await armed.promise; assert.equal(timer.delay, 3000);
  timer.fn(); stopped.resolve();
  // The settle point is the stop itself: an inherited pipe holder may keep close from ever arriving.
  assert.deepEqual(await diagnostics, { stderr: 'last words before exit', processError: null, exitCode: 1, signal: null });
});

for (const exits of [true, false]) test(`startup write failure ${exits ? 'uses a late exit code' : 'falls back at the diagnostic deadline'}`, async t => {
  const child = new EventEmitter(), armed = Promise.withResolvers();
  child.exitCode = null; child.signalCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_bytes, _encoding, done) { done(new Error('EPIPE')); } });
  const exit = (code, signal = null) => {
    child.exitCode = code; child.signalCode = signal;
    child.emit('exit', code, signal); child.emit('close', code, signal);
  };
  child.kill = () => exit(null, 'SIGKILL');
  const timers = { setTimeout(fn, delay) { armed.resolve({ fn, delay }); }, clearTimeout() {} };
  const factory = createCodexRuntime({ resolveExecutable: async () => 'synthetic-only', spawnProcess: () => child, timers });
  const runtime = factory.create({ cwd: os.tmpdir(), env: { PATH: '' } }, () => {});
  t.after(() => runtime.close());
  const failure = runtime.start().then(() => assert.fail('the start must fail'), error => error);
  const timer = await Promise.race([armed.promise, failure.then(error => assert.fail(error.detail))]);
  assert.equal(timer.delay, 250);
  if (exits) {
    child.stderr.write('codex: invalid config\n');
    exit(3);
  } else timer.fn();
  assert.equal((await failure).detail, exits ? 'initialize: process_exited (exit 3) · stderr: codex: invalid config' : 'initialize: write_failed');
});

test('a failed start carries its stage, exit code and redacted stderr tail, and a protocol error its code and message', async t => {
  const lifetime = resources(t);
  const stderr = 'early line one\nearly line two\n\x1b[31mERROR\x1b[0m config: token=abcdefsecret123 Authorization: Bearer sk-proj-abcdefghijklmn\n'
    + "/usr/bin/env: 'node': No such file or directory\n";
  const orders = [['stderr', 'stdout', 'exit'], ['stderr', 'exit', 'stdout'], ['stdout', 'stderr', 'exit'],
    ['stdout', 'exit', 'stderr'], ['exit', 'stderr', 'stdout'], ['exit', 'stdout', 'stderr']];
  for (const order of orders) {
    const child = new EventEmitter(), initialized = Promise.withResolvers(), events = [];
    let closed = false;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    child.stdin = new Writable({ write(_bytes, _encoding, done) { initialized.resolve(); done(); } });
    child.kill = () => { child.exitCode = 127; child.emit('exit', 127); child.emit('close', 127); };
    const factory = createCodexRuntime({ resolveExecutable: async () => 'synthetic-only', spawnProcess: () => lifetime.child(child) });
    const runtime = factory.create({ projectId: 'project', terminalId: 'terminal', cwd: os.tmpdir(), env: { PATH: '' } }, event => events.push(event));
    lifetime.defer('close runtime', () => runtime.close());
    const failed = runtime.start().then(() => assert.fail('the start must fail'), error => {
      assert.equal(closed, true, 'failure detail is finalized only after child close'); return error;
    });
    await initialized.promise;
    for (const event of order) {
      if (event === 'stderr') child.stderr.emit('data', stderr);
      else if (event === 'stdout') child.stdout.emit('end');
      else { child.exitCode = 127; child.emit('exit', 127); }
    }
    closed = true; child.emit('close', 127);
    const error = await failed;
    assert.match(error.detail, /^initialize: (?:disconnected|process_exited) \(exit 127\) · stderr: /, 'stdout may end before the exit is seen');
    assert.match(error.detail, /No such file or directory$/, 'the last stderr line, the one that names the cause, is kept');
    assert.doesNotMatch(error.detail, /early line one|abcdefsecret123|sk-proj-abcdefghijklmn|\x1b/, 'three lines at most, secrets and colours removed');
    assert.ok(!events.some(event => JSON.stringify(event).includes('No such file')), 'stderr is never published as an event');
  }
  const { startupDetail } = require('../electron/features/agents/start-failure.cjs');
  assert.equal(startupDetail(Object.assign(new Error('rpc_rejected'), { code: -32600, serverMessage: 'Invalid request: unknown variant `fast`', stage: 'thread_start' })),
    'thread_start: rpc -32600, Invalid request: unknown variant `fast`');
  // A newer server words a missing field differently: the probe's refusal keeps what the server said.
  const { probeCapabilities } = require('../electron/features/codex-app-server/compatibility.cjs');
  const reworded = await probeCapabilities({ request: async () => { throw Object.assign(new Error('rpc_rejected'), { code: -32600, serverMessage: 'Invalid request: missing field `threadId` at line 1 column 2' }); } })
    .then(() => assert.fail('the probe must refuse'), error => Object.assign(error, { stage: 'capability_probe' }));
  assert.equal(startupDetail(reworded), 'capability_probe: unsupported_codex_capabilities, thread/resume rpc_-32600, Invalid request: missing field `threadId` at line 1 column 2');
  const long = startupDetail(Object.assign(new Error('process_exited'), { stage: 'initialize' }), { stderr: 'x'.repeat(2000) + ' the end', exitCode: 1 });
  assert.ok(long.length <= 300 && long.endsWith(' the end'), 'a long tail is cut from its start');
  const { username, homedir } = os.userInfo();
  const secrets = startupDetail(Object.assign(new Error('process_exited'), { stage: 'initialize' }), { stderr: [
    'GET https://api.example.invalid/v1?model=x&key=AIzaQUERYSECRET1 failed; Authorization: Basic dXNlcjpCQVNJQ1NFQ1JFVA==', 'x-api-key: HEADERSECRET123',
    `\x1b]8;;https://link.example.invalid/?token=LINKSECRET\x1b\\open\x1b]8;;\x1b\\ \x1b]0;title\x07ssh test_ssh failed for ${username} in ${homedir}`].join('\n') },
    { hosts: ['test_ssh', 'vm.example.invalid'] });
  for (const hidden of ['AIzaQUERYSECRET1', 'dXNlcjpCQVNJQ1NFQ1JFVA', 'HEADERSECRET123', 'LINKSECRET', 'link.example.invalid', 'title', '\x1b', 'test_ssh', username, homedir])
    assert.ok(!secrets.includes(hidden), `${hidden} is redacted: ${secrets}`);
  assert.match(secrets, /&key=<secret> failed; Authorization: Basic <secret> \/ x-api-key: <secret> \//);
  assert.match(secrets, /open ssh <host> failed for <user> in <home>$/, 'a hyperlink keeps its text; host, user and home are named only by kind');
});
