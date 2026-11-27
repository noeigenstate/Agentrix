const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { PassThrough } = require('node:stream');

require('node:child_process').spawn = (file, args) => {
  assert.equal(path.dirname(file), process.env.PATH);
  assert.equal(path.basename(file), process.platform === 'win32' ? 'agy.exe' : 'agy');
  const version = args[0] === '--version';
  assert.deepEqual(args, version ? ['--version'] : ['-p', '/usage', '--output-format', 'json']);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  queueMicrotask(() => {
    child.stdout.end(version ? 'agy 1.5.18' : JSON.stringify({
      status: 'SUCCESS', num_turns: 0, account_id: 'fixture-account',
      command: { name: 'usage', data: { groups: [{ name: 'fixture-group', buckets: [
        { id: 'gemini-5h', window: '5h', remaining_fraction: 0.75, reset_time: '2026-01-01T00:00:00Z' },
        { id: '3p-weekly', window: 'weekly', remaining_fraction: 0.5 },
        { id: 'invalid', window: '5h', remaining_fraction: 'fixture-secret' },
      ] }] } },
    }));
    child.exitCode = 0;
    child.emit('close', 0);
  });
  return child;
};
