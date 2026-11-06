const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runShell } = require('../electron/features/claude-sdk/shell.cjs');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC)$/i.test(key)));

test('host shell preserves raw stderr while retaining its merged arrival stream', { timeout: 10000 }, async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { bashEnvironment, missingTmpWarning } = require('./fixtures/bash-environment.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-shell-streams-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const warning = process.platform === 'win32' ? missingTmpWarning : '';
  fs.writeFileSync(path.join(root, 'streams.cjs'), "process.stdout.write('OUT'); setTimeout(() => process.stderr.write('ERR\\n'), 80);\n");
  const result = await runShell({ cwd: root, env: bashEnvironment(root, { missingTmp: true }), command: 'node streams.cjs', signal: new AbortController().signal, output() {} });
  await result.closed;
  assert.equal(result.stdout, 'OUT'); assert.equal(result.stderr, warning + 'ERR\n');
  assert.equal(result.combined, warning + 'OUTERR\n');
});

test('host shell bounds combined output to 30000 characters while draining both pipes', { timeout: 10000 }, async () => {
  const result = await runShell({ cwd: __dirname, env,
    command: `node -e "process.stdout.write('x'.repeat(40000));process.stderr.write('e'.repeat(10000))"`, signal: new AbortController().signal, output() {} });
  assert.equal(result.exitCode, 0); assert.equal(result.stdout.length + result.stderr.length, 30000); assert.match(result.stdout + result.stderr, /输出已截断/);
  assert.equal(result.combined.length, 30000); assert.match(result.combined, /输出已截断/);
});

test('host shell timeout ends its owned process tree and reports interruption', { timeout: 10000 }, async () => {
  const result = await runShell({ cwd: __dirname, env, command: 'sleep 10', timeout: 100,
    signal: new AbortController().signal, output() {} });
  assert.equal(result.exitCode, null);
});
