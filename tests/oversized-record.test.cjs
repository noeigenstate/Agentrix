const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { records } = require('../electron/session-files.cjs');
const { readTranscriptChunk } = require('../electron/oversized-record.cjs');

test('a generated picture record over 1 MB comes through without its pixels; other oversized records are skipped', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oversized-')), 'rollout.jsonl');
  const saved = 'C:\\Users\\me\\.codex\\generated_images\\t1\\exec-1.png';
  const picture = { timestamp: '2026-10-10T05:38:45.627Z', type: 'event_msg', payload: { type: 'item_completed', thread_id: 't1', turn_id: 'r1', item: {
    type: 'Extension', kind: 'image_gen.generation', id: 'exec-1', status: 'completed', revisedPrompt: '一只柯基 "小狗"', result: 'A'.repeat(2_500_000), transparentBackground: false, failure: null, savedPath: saved } } };
  const other = { type: 'response_item', payload: { type: 'function_call_output', output: 'B'.repeat(1_500_000) } };
  const after = { type: 'event_msg', payload: { type: 'agent_message', message: 'done' } };
  fs.writeFileSync(file, [picture, other, after].map(item => JSON.stringify(item)).join('\n') + '\n');
  const read = [];
  for await (const record of records(file)) read.push(record);
  assert.equal(read.length, 2, 'the picture and the record after the skipped one');
  assert.deepEqual(read[0], { timestamp: picture.timestamp, type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'Extension', kind: 'image_gen.generation', id: 'exec-1', status: 'completed', revisedPrompt: '一只柯基 "小狗"', savedPath: saved } } });
  assert.deepEqual(read[1], after);
  const oneRead = [], reader = { buffer: Buffer.alloc(0) };
  readTranscriptChunk(reader, Buffer.from(JSON.stringify(picture) + '\n'), record => oneRead.push(record));
  assert.deepEqual(oneRead, [read[0]], 'generated pictures survive a complete oversized line in a single read too');
});
