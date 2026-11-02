const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOssSource } = require('../electron/features/lab-oss/index.cjs');
const { conformance } = require('./helpers/lab-provider-conformance.cjs');

test('the oss provider meets the source contract', async () => {
  const { info, tasks } = await conformance(createOssSource(), {
    query: { source: 'oss', repos: [], size: 5 }, selection: { source: 'oss', repos: [] },
  });
  assert.deepEqual([info.available, info.reason, tasks], [false, '等待任务清单', []]);
});
