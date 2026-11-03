const { test, resources, deadline } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('cleanup observes a signal-terminated peer that exited before the after hook', async t => {
  const lifetime = resources(t);
  const child = lifetime.child(spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')],
    { env: { PATH: '' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
  const closed = once(child, 'close'); child.kill('SIGKILL');
  await lifetime.wait(closed, 'signal exit');
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, 'SIGKILL');
  // The old exitCode-only cleanup would now subscribe to an exit event that already fired.
});

test('a stalled cleanup wait has a bounded diagnostic instead of an unending promise', async () => {
  await assert.rejects(deadline(new Promise(() => {}), 'synthetic peer cleanup', 25), /Timed out: synthetic peer cleanup \(25 ms\)/);
});

test('test cancellation kills the tracked peer and its cleanup still completes', async t => {
  const controller = new AbortController(), hooks = [];
  const lifetime = resources({ name: 'synthetic cancellation', signal: controller.signal, after: hook => hooks.push(hook) });
  const child = lifetime.child(spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')],
    { env: { PATH: '' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const closed = once(child, 'close'); controller.abort();
  await lifetime.wait(closed, 'cancelled peer close'); await hooks[0]();
  assert.equal(child.signalCode, 'SIGKILL');
});
