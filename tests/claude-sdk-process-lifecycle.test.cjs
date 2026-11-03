const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixtureProcesses } = require('./fixtures/claude-sdk-processes.cjs');

test('an offline provider test timeout reports its name, kills the child and removes its fixture directory', { timeout: 10000 }, async t => {
  const scope = fixtureProcesses(t), output = [];
  const child = scope.spawn(process.execPath, ['--test', path.join(__dirname, 'fixtures/claude-sdk-hang.cjs')],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { HOME: scope.directory, USERPROFILE: scope.directory,
      TEMP: scope.directory, TMP: scope.directory, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) } });
  child.stdout.on('data', value => output.push(value.toString())); child.stderr.on('data', value => output.push(value.toString()));
  const code = await scope.wait(new Promise(resolve => child.once('close', resolve)), 'intentional timeout subprocess');
  const text = output.join('');
  assert.equal(code, 1, text);
  assert.match(text, /intentional silent fake provider/); assert.match(text, /timed out after 300ms/);
  const pid = Number(/FIXTURE_PID=(\d+)/.exec(text)?.[1]), directory = /FIXTURE_DIR=(.+)/.exec(text)?.[1].trim();
  assert.ok(pid > 0); assert.ok(directory);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  assert.equal(fs.existsSync(directory), false);
});
