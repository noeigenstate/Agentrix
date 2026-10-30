const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyConversationPacket, createConversationBuffer } = require('../src/features/reading/conversation-buffer.ts');
const entry = (id, text = id) => ({ id, text, role: 'assistant', at: 0 });

test('deltas replace entries in place, deduplicate IDs, and cap a rolling list', () => {
  const source = Array.from({ length: 400 }, (_, index) => entry(String(index)));
  const next = applyConversationPacket(source, { changes: [entry('399', 'changed'), entry('400'), entry('400', 'finished')] });
  assert.equal(next.length, 400);
  assert.equal(next[0].id, '1');
  assert.equal(next.at(-2).text, 'changed');
  assert.equal(next.at(-1).text, 'finished');
  assert.equal(source.at(-1).text, '399');
});

test('packets within 50 ms produce one update without extending the flush deadline', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updates = [], buffer = createConversationBuffer(list => updates.push(list));
  buffer.snapshot([entry('a')]);
  t.mock.timers.tick(20); buffer.push({ changes: [entry('b')] });
  t.mock.timers.tick(29); buffer.push({ changes: [entry('a', 'finished')] });
  assert.equal(updates.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(updates, [[entry('a', 'finished'), entry('b')]]);
  buffer.push({ changes: [entry('c')] }); t.mock.timers.tick(50);
  assert.equal(updates.length, 2, 'normal streaming keeps flushing during continuous traffic');
  buffer.dispose();
});

test('events received before a delayed snapshot remain ordered after the snapshot', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updates = [], buffer = createConversationBuffer(list => updates.push(list));
  buffer.push({ changes: [entry('a', 'new'), entry('b')] }); t.mock.timers.tick(100);
  assert.equal(updates.length, 0);
  buffer.snapshot([entry('a', 'old')]); t.mock.timers.tick(50);
  assert.deepEqual(updates, [[entry('a', 'new'), entry('b')]]);
});

test('a full list or reset replaces buffered deltas, and later deltas follow it', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updates = [], buffer = createConversationBuffer(list => updates.push(list));
  buffer.snapshot([entry('old')]);
  buffer.push({ changes: [entry('discard')] }); buffer.push({ list: [] });
  buffer.push({ list: [entry('new')] }); buffer.push({ changes: [entry('last')] });
  t.mock.timers.tick(50);
  assert.deepEqual(updates, [[entry('new'), entry('last')]]);
});

test('cleanup cancels queued updates and ignores late snapshots and packets', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updates = [], buffer = createConversationBuffer(list => updates.push(list));
  buffer.snapshot([entry('a')]); buffer.dispose();
  buffer.snapshot([entry('late')]); buffer.push({ list: [entry('late')] });
  t.mock.timers.tick(100);
  assert.deepEqual(updates, []);
});

test('paged buffers retain prepended history beyond 400 and merge only the new suffix of a live snapshot', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updates = [], buffer = createConversationBuffer(entries => updates.push(entries), true);
  const old = Array.from({ length: 500 }, (_, n) => ({ id: `old-${n}`, at: n, role: 'assistant', text: 'old' }));
  const current = { id: 'current', at: 501, role: 'assistant', text: 'initial', images: ['data:image/png;base64,eA=='] };
  buffer.snapshot([current]); t.mock.timers.tick(50);
  buffer.prepend(old);
  buffer.push({ list: [{ id: 'unloaded-prefix', at: 1, role: 'assistant' }, { ...current, text: 'updated' }, { id: 'live', at: 502, role: 'assistant' }] });
  t.mock.timers.tick(50);
  const result = updates.at(-1);
  assert.equal(result.length, 502); assert.equal(result[0].id, 'old-0');
  assert.equal(result.some(entry => entry.id === 'unloaded-prefix'), false);
  assert.equal(result.at(-2).text, 'updated'); assert.deepEqual(result.at(-2).images, current.images);
  buffer.prepend([{ ...current, text: 'older page must not overwrite live' }]);
  assert.equal(updates.at(-1).at(-2).text, 'updated'); buffer.dispose();
});
