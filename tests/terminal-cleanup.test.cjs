const { test } = require('node:test');
const assert = require('node:assert/strict');
const { timeoutScale } = require('../scripts/wait.mjs');
const { cleanupTerminal } = require('./helpers/terminal-cleanup.cjs');

function fixture() {
  let cleanup, exit, disposed = false;
  const signals = [];
  cleanupTerminal({ after: callback => { cleanup = callback; } }, {
    onExit: callback => { exit = callback; return { dispose: () => { disposed = true; } }; },
    kill: signal => signals.push(signal),
  });
  return { cleanup, exit, signals, disposed: () => disposed };
}

test('terminal cleanup forces termination and awaits the exit notification', { timeout: 15000 * timeoutScale }, async () => {
  const terminal = fixture();
  let settled = false;
  const cleanup = terminal.cleanup().then(() => { settled = true; });
  await new Promise(setImmediate);
  assert.deepEqual(terminal.signals, ['SIGKILL']);
  assert.equal(settled, false, 'sending a signal does not prove the shell exited');
  terminal.exit();
  await cleanup;
  assert.equal(terminal.disposed(), true);
});

test('terminal cleanup remembers an earlier exit without signalling the old PID', { timeout: 15000 * timeoutScale }, async () => {
  const terminal = fixture();
  terminal.exit();
  await terminal.cleanup();
  assert.deepEqual(terminal.signals, []);
  assert.equal(terminal.disposed(), true);
});

test('terminal cleanup fails within the scaled deadline when exit is never reported', { timeout: 15000 * timeoutScale }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const terminal = fixture();
  let settled = false;
  const failed = assert.rejects(terminal.cleanup().finally(() => { settled = true; }), /Timed out: isolated terminal exit/);
  await new Promise(setImmediate);
  t.mock.timers.tick(5000 * timeoutScale - 1);
  await new Promise(setImmediate);
  assert.equal(settled, false, 'cleanup retains the full scaled exit budget');
  t.mock.timers.tick(81);
  await failed;
  assert.equal(terminal.disposed(), true);
});
