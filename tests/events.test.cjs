const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { createEventServer } = require('../electron/events.cjs');

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
