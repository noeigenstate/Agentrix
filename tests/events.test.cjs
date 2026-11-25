const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { createEventServer } = require('../electron/events.cjs');
const { send: report } = require('../integration/agent-event.cjs');

function send(address, chunks) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    socket.on('connect', () => { for (const chunk of chunks) socket.write(chunk); });
    socket.on('close', resolve);
    socket.on('error', reject);
  });
}
test('completion transport accepts fragmented UTF-8 JSON and isolates malformed clients', async t => {
  const events = [];
  const server = await createEventServer(event => events.push(event));
  t.after(() => server.close());
  await send(server.address, ['{invalid}\n']);
  await send(server.address, ['{}\n']);
  await send(server.address, ['{"projectId":"中文",', '"sessionKey":"test-key","type":"turn-complete","eventId":"one"}\n']);
  assert.equal(events.length, 1);
  assert.equal(events[0].projectId, '中文');
});

test('the local pipe drops unknown event versions before dispatch and accepts keyed and legacy shell producers', async t => {
  const seen = [];
  const server = await createEventServer(value => seen.push(value));
  t.after(() => server.close());
  const event = { type: 'codex-started', projectId: 'fixture', sessionKey: 'fixture-key', sequence: 1 };
  for (const frame of [{ ...event, v: 2 }, { ...event, v: 0 }, event]) {
    await send(server.address, [JSON.stringify(frame) + '\n']);
  }
  assert.deepEqual(seen, [event]);
  const helper = path.join(__dirname, '../integration/agent-event.cjs');
  const run = args => promisify(execFile)(process.execPath, [helper, 'shell-event', ...args], { windowsHide: true, timeout: 5000 });
  await run(['future_field=ignored', 'agent=claude', 'v=1', 'sequence=2', 'type=agent-started', `socket=${server.address}`,
    'projectId=fixture', 'sessionKey=fixture-key', 'cwd=/tmp/a=b']);
  await run([server.address, 'fixture', 'fixture-key', 'codex-started', '3', '0', 'codex', 'true', 'false', '/tmp/codex', '/tmp', '', '', '[]']);
  assert.deepEqual(seen.slice(1).map(({ v, type, agent, sequence, cwd }) => [v, type, agent, sequence, cwd]), [
    [1, 'agent-started', 'claude', 2, '/tmp/a=b'], [1, 'agent-started', 'codex', 3, '/tmp'],
  ]);
});

test('the local event pipe acknowledges a launch after writing its note', async t => {
  let launchNote = 'previous launch';
  const server = await createEventServer(event => { launchNote = event.cwd; });
  t.after(() => server.close());
  const event = { v: 1, type: 'agent-started', agent: 'claude', projectId: 'fixture', sessionKey: 'test-key', sequence: 7, cwd: 'new launch' };
  const reply = await new Promise((resolve, reject) => {
    const connection = net.connect(server.address), chunks = [];
    connection.on('connect', () => connection.end(JSON.stringify(event) + '\n'));
    connection.on('data', chunk => { assert.equal(launchNote, event.cwd); chunks.push(chunk); });
    connection.on('error', reject);
    connection.on('end', () => resolve(Buffer.concat(chunks)));
  });
  assert.deepEqual([...reply], [1]);
  assert.equal(await report(server.address, event), true);
});

test('the Node launch reporter accepts a byte on an open connection, old close-only replies, and silence until the deadline', { timeout: 5000 }, async t => {
  const event = { v: 1, type: 'agent-started', agent: 'claude', projectId: 'fixture', sessionKey: 'test-key', sequence: 8 };
  const events = [], sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let input = '';
    socket.on('data', chunk => { input += chunk; });
    socket.on('end', () => {
      events.push(JSON.parse(input));
      if (events.length === 1) socket.write('\x01');
      else if (events.length === 2) socket.end();
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(await report(address, event), true);
  assert.equal(await report(address, { ...event, sequence: 9 }), false);
  assert.equal(await report(address, { ...event, sequence: 10 }), false);
  assert.deepEqual(events.map(({ type, agent, sequence }) => [type, agent, sequence]), [8, 9, 10].map(sequence => ['agent-started', 'claude', sequence]));
});
