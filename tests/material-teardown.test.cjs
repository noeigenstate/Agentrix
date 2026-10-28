const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { closeMaterialApp } = require('../scripts/material-teardown.mjs');
const { timeoutScale } = require('../scripts/wait.mjs');

async function idleChild(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  });
  await once(child, 'spawn');
  return child;
}

test('material teardown completes normally without killing another process', { timeout: 10000 * timeoutScale }, async t => {
  const child = await idleChild(t);
  await closeMaterialApp({ process: () => child, close: async () => {} }, 100);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});

test('a hung Electron close fails within its deadline and kills only its own test process', { timeout: 10000 * timeoutScale }, async t => {
  const child = await idleChild(t), unrelated = await idleChild(t);
  const exited = once(child, 'exit');
  await assert.rejects(closeMaterialApp({ process: () => child, close: () => new Promise(() => {}) }, 100), {
    message: `Material teardown timed out after 100ms (Electron PID ${child.pid})`,
  });
  await exited;
  assert.equal(unrelated.exitCode, null);
  assert.equal(unrelated.signalCode, null);
});

test('a close failure is preserved after terminating its isolated child', { timeout: 10000 * timeoutScale }, async t => {
  const child = await idleChild(t), failure = new Error('Electron close failed');
  const exited = once(child, 'exit');
  await assert.rejects(closeMaterialApp({ process: () => child, close: async () => { throw failure; } }), error => error === failure);
  await exited;
});
