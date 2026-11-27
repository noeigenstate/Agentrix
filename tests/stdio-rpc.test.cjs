const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createRpc } = require('../electron/shared/stdio-rpc.cjs');

function fixture(t, options) {
  const writes = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new Writable({
      write(chunk, _encoding, done) { writes.push(JSON.parse(chunk.toString())); done(); },
    }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const rpc = createRpc(child, options);
  t.after(() => {
    rpc.close();
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  });
  return { child, rpc, writes, receive: frame => child.stdout.write(JSON.stringify(frame) + '\n') };
}

test('writes a versionless request and notification by default', async t => {
  const { rpc, writes, receive } = fixture(t);
  const answer = rpc.request('initialize', { version: 1 });
  rpc.notify('initialized');
  assert.deepEqual(writes, [
    { id: '1', method: 'initialize', params: { version: 1 } },
    { method: 'initialized', params: {} },
  ]);
  receive({ id: 1, result: 'different request ID' });
  receive({ id: '1', result: 'ready' });
  assert.equal(await answer, 'ready');
});

test('JSON-RPC 2.0 tags each write and preserves the peer request ID in answers', async t => {
  const requests = [], notifications = [];
  const { rpc, writes, receive } = fixture(t, {
    jsonrpc: true,
    onRequest: request => requests.push(request),
    onNotification: (...args) => notifications.push(args),
  });
  const answer = rpc.request('initialize', {});
  rpc.notify('initialized', { ready: true });
  const incoming = { jsonrpc: '2.0', id: 'jetski-acp-front:2', method: 'peer/request', params: { title: 'Continue?' } };
  receive(incoming);
  receive({ jsonrpc: '2.0', method: 'peer/update', params: { state: 'ready' } });
  receive({ jsonrpc: '2.0', id: '1', result: { ready: true } });
  assert.deepEqual(requests, [incoming]);
  assert.deepEqual(notifications, [['peer/update', { state: 'ready' }]]);
  assert.deepEqual(await answer, { ready: true });
  rpc.respond(requests[0].id, { allowed: true });
  rpc.reject('jetski-acp-front:3');
  assert.deepEqual(writes, [
    { jsonrpc: '2.0', id: '1', method: 'initialize', params: {} },
    { jsonrpc: '2.0', method: 'initialized', params: { ready: true } },
    { jsonrpc: '2.0', id: 'jetski-acp-front:2', result: { allowed: true } },
    { jsonrpc: '2.0', id: 'jetski-acp-front:3', error: { code: -32601, message: 'Unsupported request' } },
  ]);
});

test('process exit rejects written and queued requests with their delivery status', async t => {
  const disconnects = [], written = [];
  const { child, rpc, writes } = fixture(t, { onDisconnect: code => disconnects.push(code) });
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = chunk => { write(chunk); return false; };
  const first = rpc.request('written', {}, undefined, { onWritten: () => written.push('written') });
  const second = rpc.request('queued', {}, undefined, { onWritten: () => written.push('queued') });
  child.emit('exit', 1);
  child.emit('close', 1);
  await Promise.all([
    assert.rejects(first, { code: 'process_exited', uncertain: true }),
    assert.rejects(second, { code: 'process_exited', uncertain: false }),
  ]);
  assert.deepEqual(writes, [{ id: '1', method: 'written', params: {} }]);
  assert.deepEqual(written, ['written']);
  assert.deepEqual(disconnects, ['process_exited']);
});
