require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createRpc } = require('../electron/features/codex-app-server/rpc.cjs');
const { createEvents } = require('../electron/features/codex-app-server/events.cjs');
const { createNormalizer } = require('../electron/features/claude-sdk/normalize.cjs');
const { turnResult } = require('../electron/features/claude-sdk/result.cjs');

test('an exited local app-server releases inherited pipes without reporting a process stop timeout', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../electron/features/codex-app-server/index.cjs'), 'utf8');
  const stop = vm.runInNewContext(source.slice(source.indexOf('function stopProcess('), source.indexOf('function createCodexRuntime(')) + '\nstopProcess;', {
    setTimeout, clearTimeout, path, process: { platform: 'win32', env: { SystemRoot: 'C:/Windows' } }, execFile() {},
  });
  const child = new EventEmitter(); Object.assign(child, { pid: 12345, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const stopping = stop(child); child.exitCode = 0; child.emit('exit', 0);
  let timer;
  try {
    const ended = await Promise.race([stopping.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 80); })]);
    assert.equal(ended, true, 'the parent has exited even when a metadata child still holds stdout');
    assert.ok(child.stdout.destroyed && child.stderr.destroyed);
    const previous = new EventEmitter(); Object.assign(previous, { exitCode: 0, stdout: new PassThrough(), stderr: new PassThrough() });
    await stop(previous); assert.ok(previous.stdout.destroyed && previous.stderr.destroyed, 'an exit observed before close also releases the pipes');
  } finally { clearTimeout(timer); child.emit('close', 0); await stopping; }
});

test('D6 oversized command results settle neutrally without changing true interruption', () => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    const published = [], events = createEvents({ runtimeSessionId: 'r' }, event => published.push(event), Date.now);
    Object.assign(events.binding, { providerSessionId: 'thread', turnId: 'turn' }); events.beginTurn();
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const rpc = createRpc(child, { onNotification: events.notification, onDropped: bytes => events.publish('item.dropped', { reason: 'too_large', bytes }) });
    const send = value => child.stdout.write(JSON.stringify(value) + '\n');
    try {
      for (const id of ['dropped', 'known']) send({ method: 'item/started', params: { turnId: 'turn', item: { id, type: 'commandExecution', command: 'echo result', status: 'inProgress' } } });
      child.stdout.write('{"method":"item/completed","params":{"turnId":"turn","item":{"id":"dropped","type":"commandExecution","status":"completed","exitCode":0,"aggregatedOutput":"');
      const chunk = Buffer.alloc(1024 * 1024, 120);
      for (let index = 0; index < 65; index++) child.stdout.write(chunk);
      child.stdout.write('"}}}\n');
      send({ method: 'item/completed', params: { turnId: 'turn', item: { id: 'known', type: 'commandExecution', status: 'completed', exitCode: 0 } } });
      events.finishTurn(status);
      const items = events.snapshot().items;
      assert.equal(items.find(item => item.itemId === 'known').status, 'completed');
      assert.equal(items.find(item => item.itemId === 'dropped').status, status === 'interrupted' ? 'interrupted' : 'unknown');
      assert.equal(published.filter(event => event.type === 'item.dropped').length, 1);
      // A later turn has no loss: an unfinished command still means interruption.
      events.binding.turnId = 'next'; events.beginTurn();
      send({ method: 'item/started', params: { turnId: 'next', item: { id: 'unfinished', type: 'commandExecution' } } });
      events.finishTurn('completed');
      assert.equal(events.snapshot().items.find(item => item.itemId === 'unfinished').status, 'interrupted');
    } finally { rpc.close(); }
  }
});

test('D3 local success requires CLI identity and explicit success, and never overrides an interruption or error', () => {
  const local = { local_command: 'compact', subtype: 'success', is_error: false, stop_reason: null };
  assert.equal(turnResult(local, { compacted: true }).status, 'completed');
  for (const terminal_reason of ['aborted_streaming', 'stop_hook_prevented', 'max_turns']) assert.equal(turnResult({ ...local, terminal_reason }).status, 'interrupted');
  assert.equal(turnResult(local, { interrupted: true }).status, 'interrupted');
  assert.equal(turnResult({ ...local, is_error: true }).status, 'failed');
  assert.equal(turnResult({ subtype: 'success', stop_reason: null }).status, 'unknown');
  assert.equal(turnResult({ ...local, terminal_reason: 'future_reason' }).status, 'unknown');
});

test('D5 command metadata suppresses mutations without matching text or hiding read-only and unclassified feedback', () => {
  const visible = [], normalize = createNormalizer((type, payload) => { if (type === 'item.upsert') visible.push(payload.content.text); });
  const assistant = (id, command, args, text) => normalize({ type: 'assistant', uuid: id, local_command_run: { command, args }, message: { id, content: [{ type: 'text', text }] } });
  assistant('a', 'model', 'sonnet', '任意语言的模型设置回执');
  normalize({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } });
  assistant('b', 'compact', '', '任意语言的压缩回执');
  assistant('c', 'model', '', 'Current model');
  assistant('d', 'context', '', 'Context usage');
  normalize({ type: 'system', subtype: 'local_command_output', uuid: 'e', content: 'Set model to Compacted' });
  assert.deepEqual(visible, ['Current model', 'Context usage', 'Set model to Compacted']);
});
