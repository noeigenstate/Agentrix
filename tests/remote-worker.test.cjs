const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('SSH open carries the switch and later changes use the remote control message', async t => {
  const filename = path.join(__dirname, '../electron/remote-connection.cjs'), native = createRequire(filename);
  for (const allow of [false, true]) {
    const module = { exports: {} }, sent = [];
    let remote;
    const link = { attach: () => 1, detach() {}, open: message => sent.push(message), send: message => {
      sent.push(message); remote.receive({ type: 'response', id: message.id, ok: true, value: true });
    } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nlinkFor = () => testLink;', {
      module, testLink: link, require: name => name.endsWith('dispatch.cjs') ? { runtimeFiles: () => ({}) } : native(name),
      process, Buffer, setInterval, clearInterval, setTimeout, clearTimeout,
    });
    remote = new module.exports.RemoteConnection({ path: '/fixture', id: 'fixture', ssh: {} }, {
      auth: {}, integrationDir: path.join(__dirname, '../integration'), allowBackgroundTasks: allow });
    t.after(() => remote.close());
    assert.equal(sent[0].allowBackgroundTasks, allow);
    remote.receive({ type: 'ready', info: { root: '/fixture', cwd: '/fixture' } });
    await remote.setBackgroundTasks(!allow);
    assert.equal(sent[1].op, 'claude-background');
    assert.equal(sent[1].allow, !allow);
  }
});
