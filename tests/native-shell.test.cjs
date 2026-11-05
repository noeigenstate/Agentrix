const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runShell } = require('../electron/features/claude-sdk/shell.cjs');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC)$/i.test(key)));

test('host shell bounds combined output to 30000 characters while draining both pipes', { timeout: 10000 }, async () => {
  const result = await runShell({ cwd: __dirname, env,
    command: `node -e "process.stdout.write('x'.repeat(40000));process.stderr.write('e'.repeat(10000))"`, signal: new AbortController().signal, output() {} });
  assert.equal(result.exitCode, 0); assert.equal(result.stdout.length + result.stderr.length, 30000);
});

test('host shell timeout ends its owned process tree and reports interruption', { timeout: 10000 }, async () => {
  const result = await runShell({ cwd: __dirname, env, command: 'sleep 10', timeout: 100,
    signal: new AbortController().signal, output() {} });
  assert.equal(result.exitCode, null);
});
