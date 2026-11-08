const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEvents } = require('../electron/features/codex-app-server/events.cjs');

test('Codex compaction retains its working state during CLI retries and reports a safe failure reason', () => {
  const rows = [], stream = createEvents({ projectId: 'p', terminalId: 't', runtimeSessionId: 'r' }, row => rows.push(row), () => 1000, undefined, text => text);
  stream.notification('item/started', { item: { id: 'compact', type: 'contextCompaction' } });
  const error = { message: JSON.stringify({ error: { type: 'invalid_request_error', message: 'private-endpoint-and-key' } }), codexErrorInfo: 'other' };
  stream.notification('error', { error, willRetry: true });
  assert.equal(rows.filter(row => row.type === 'context.compacting' && !row.payload.active).length, 0);
  assert.match(rows.at(-1).payload.message, /上下文压缩失败。请求无效/);
  assert.doesNotMatch(JSON.stringify(rows), /private-endpoint|key|invalid_request_error/);
  stream.notification('error', { error, willRetry: false });
  assert.equal(rows.filter(row => row.type === 'context.compacting' && !row.payload.active).length, 1);
  assert.equal(rows.filter(row => row.type === 'context.compacted').length, 0);
  stream.finishTurn('failed'); stream.notification('error', { error, willRetry: false });
  assert.equal(rows.at(-1).payload.message, 'Codex 报告了错误', 'a later ordinary error is not a compaction error');
});

test('successful CLI compaction publishes one automatic boundary and no host command', () => {
  const rows = [], stream = createEvents({}, row => rows.push(row), () => 1000, undefined, text => text);
  for (const method of ['item/started', 'item/completed', 'item/completed']) stream.notification(method, { item: { id: 'compact', type: 'contextCompaction' } });
  const boundaries = rows.filter(row => row.type === 'context.compacted');
  assert.equal(boundaries.length, 1); assert.equal(boundaries[0].payload.trigger, 'auto');
});

test('unknown compaction errors never expose raw provider text or inherited object properties', () => {
  for (const code of ['constructor', '__proto__', 'unrecognized']) {
    const rows = [], stream = createEvents({}, row => rows.push(row), () => 1000);
    stream.notification('item/started', { item: { id: 'compact', type: 'contextCompaction' } });
    stream.notification('error', { error: { codexErrorInfo: code, message: 'private server response' }, willRetry: true });
    assert.equal(rows.at(-1).payload.message, '上下文压缩失败。服务未能完成压缩。');
    stream.beginTurn(); stream.notification('error', { error: {}, willRetry: false });
    assert.equal(rows.at(-1).payload.message, 'Codex 报告了错误');
  }
});
