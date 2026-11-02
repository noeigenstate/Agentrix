const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAaSource } = require('../electron/features/lab-aa/index.cjs');
const { conformance } = require('./helpers/lab-provider-conformance.cjs');

test('the aa provider meets the source contract', async () => {
  const { info, tasks } = await conformance(createAaSource(), {
    query: { source: 'aa', benchmark: 'terminal-bench-4', size: 10 }, selection: { source: 'aa', benchmark: 'terminal-bench-4' },
  });
  assert.deepEqual([info.available, info.reason, tasks], [false, '等待任务清单', []]);
});
