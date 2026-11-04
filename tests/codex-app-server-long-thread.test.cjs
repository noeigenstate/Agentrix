const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { createRpc, MAX_FRAME, MAX_HISTORY_FRAME } = require('../electron/features/codex-app-server/rpc.cjs');
const { createEventStream } = require('../electron/features/native-session/events.cjs');

function runtimeFixture(t, mode, owner = 'gui') {
  const lifetime = resources(t), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-codex-long-'));
  const log = path.join(directory, 'rpc.jsonl'), emitted = [], spec = { owner, agent: 'codex', projectId: 'p', terminalId: 't',
    providerSessionId: 'same-thread', runtimeSessionId: path.basename(directory), cwd: directory,
    env: { PATH: '', CODEX_HOME: directory, SYNTHETIC_CODEX_MODE: mode, SYNTHETIC_CODEX_LOG: log } };
  const stream = createEventStream(spec, event => emitted.push(event));
  const runtime = createCodexRuntime({ resolveExecutable: async () => 'synthetic-only', spawnProcess: (_file, _args, options) =>
    lifetime.child(spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], options)) }).create(spec, event => {
    stream.provider(event.providerSessionId); stream.turn(event.turnId);
    stream.publish(event.type, event.payload, { replay: event.replay, itemId: event.itemId });
  });
  lifetime.defer('remove synthetic profile', () => fs.rmSync(directory, { recursive: true, force: true }));
  lifetime.defer('close runtime', () => runtime.close());
  return { runtime, stream, emitted, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) };
}

for (const mode of ['long-many', 'long-large', 'long-huge']) test(`long thread ${mode} resumes with bounded replay, no input and no completion`, async t => {
  const f = runtimeFixture(t, mode); await f.runtime.resume();
  assert.equal(f.runtime.snapshot().state, 'idle');
  assert.equal(f.runtime.threadResponse.thread.id, 'same-thread'); assert.deepEqual(f.runtime.threadResponse.thread.turns, []);
  assert.equal(f.calls().find(call => call.method === 'thread/resume' && call.params.threadId).params.excludeTurns, true);
  const replay = f.emitted.filter(event => event.type === 'item.upsert');
  assert.ok(replay.length > 0 && replay.length <= 1000); assert.ok(replay.every(event => event.replay));
  assert.ok(Buffer.byteLength(JSON.stringify(f.stream.snapshot())) <= MAX_FRAME);
  assert.ok(Buffer.byteLength(JSON.stringify(replay)) <= MAX_FRAME);
  assert.equal(f.emitted.some(event => event.type === 'turn.started' || event.type === 'turn.completed' || event.type === 'input.receipt'), false);
  const pages = f.calls().filter(call => call.method === 'thread/turns/list');
  if (mode === 'long-many') { assert.equal(replay.length, 1000); assert.equal(pages.length, 20); assert.equal(replay[0].itemId, 'item-201'); assert.equal(replay.at(-1).itemId, 'item-1200'); }
  if (mode === 'long-large') { assert.ok(pages.some(call => call.params.limit < 50)); assert.equal(replay.at(-1).itemId, 'item-60'); }
  if (mode === 'long-huge') { assert.ok(pages.some(call => call.params.itemsView === 'notLoaded')); assert.equal(replay[0].itemId, 'item-1'); }
  assert.equal((await f.runtime.send({ clientMessageId: 'new-message', text: 'Only this new input' })).status, 'delivered');
});

test('dispatch resumes context without requesting or retaining history', async t => {
  const f = runtimeFixture(t, 'long-large', 'dispatch'); await f.runtime.resume();
  assert.equal(f.calls().some(call => call.method === 'thread/turns/list' || call.method === 'thread/items/list'), false);
  assert.equal(f.emitted.some(event => event.type === 'item.upsert'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(f.runtime.threadResponse)) < 4096);
  assert.equal((await f.runtime.send({ clientMessageId: 'worker-new', text: 'Continue' })).status, 'delivered');
});

function rpcFixture() {
  const child = new EventEmitter(), writes = [], notices = [], failures = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) { writes.push(JSON.parse(chunk)); done(); } });
  return { child, writes, notices, failures, rpc: createRpc(child, { timeout: 2000, onNotification: (...args) => notices.push(args), onDisconnect: code => failures.push(code) }) };
}
test('history frames have a finite larger byte budget; UTF-8 is decoded once across chunk and line boundaries', async () => {
  const f = rpcFixture();
  try {
    const history = f.rpc.request('thread/turns/list', {});
    const text = '汉🙂'.repeat(700000), frame = Buffer.from(JSON.stringify({ id: '1', result: { text } }) + '\n');
    assert.ok(frame.length > MAX_FRAME && frame.length < MAX_HISTORY_FRAME);
    for (let offset = 0; offset < frame.length; offset += 65533) f.child.stdout.write(frame.subarray(offset, offset + 65533));
    assert.equal((await history).text, text); assert.deepEqual(f.failures, []);
  } finally { f.rpc.close(); }
});
test('oversized history is drained without disconnect, replay or losing another response', async () => {
  const f = rpcFixture();
  try {
    const history = assert.rejects(f.rpc.request('thread/turns/list', {}), error => error.code === 'history_frame_limit' && !error.uncertain);
    const read = f.rpc.request('account/read', {});
    const header = Buffer.from('{"id":"1","result":{"text":"');
    for (const byte of header) f.child.stdout.write(Buffer.from([byte]));
    for (let i = 0; i < 17; i++) f.child.stdout.write(Buffer.alloc(1024 * 1024, 120));
    f.child.stdout.write('"}}\n{"id":"2","result":{"ok":true}}\n{"method":"notice","params":{}}\n');
    await history; assert.deepEqual(await read, { ok: true }); assert.deepEqual(f.failures, []); assert.equal(f.notices.length, 1); assert.equal(f.writes.length, 2);
  } finally { f.rpc.close(); }
});
for (const envelope of ['{"id":"1","result":{"text":"', '{"id":"unknown","result":{"text":"', '{"method":"notice","params":{"text":"'])
  test(`ordinary or unbound oversized frames still disconnect (${envelope})`, async () => {
    const f = rpcFixture();
    try {
      const pending = assert.rejects(f.rpc.request('thread/resume', {}), error => error.code === 'frame_limit' && error.uncertain);
      f.child.stdout.write(envelope); f.child.stdout.write(Buffer.alloc(MAX_FRAME + 1, 120)); await pending;
      assert.deepEqual(f.failures, ['frame_limit']);
    } finally { f.rpc.close(); }
  });
