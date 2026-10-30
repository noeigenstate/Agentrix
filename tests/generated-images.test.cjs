const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConversationLog, codexConversation, generatedImage, isGeneratedImage, setThumbnailer } = require('../electron/conversation.cjs');
const { ActionLog } = require('../electron/agent-actions.cjs');

const saved = 'C:\\Users\\me\\.codex\\generated_images\\01a123e3-8a13-7942-bb51-447487989afc\\exec-f90e4bcb-0fdf-4441-aae9-03dfb167f4eb.png';
// The record Codex 0.162 writes when its image_gen tool finishes (result shortened).
const record = { timestamp: '2026-10-10T03:38:31.000Z', type: 'event_msg', payload: { type: 'item_completed', thread_id: 't', turn_id: 'r', item: {
  type: 'Extension', kind: 'image_gen.generation', id: 'exec-f90e4bcb-0fdf-4441-aae9-03dfb167f4eb', status: 'completed',
  revisedPrompt: 'A uniform deep navy background with one pink circular icon.', result: 'iVBORw0KGgo', transparentBackground: false, failure: null, savedPath: saved,
} } };

test('a picture Codex generated shows in its answer as a small copy of the saved file, with its prompt', t => {
  const asked = [];
  const prefix = path.join(os.tmpdir(), 'agentrix-generated-'), directory = fs.mkdtempSync(prefix);
  const file = path.join(directory, 'generated_images', 'thread', 'picture.png');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header); header.writeUInt32BE(8, 16); header.writeUInt32BE(8, 20); fs.writeFileSync(file, header);
  t.after(() => { assert.ok(path.resolve(directory).startsWith(prefix)); fs.rmSync(directory, { recursive: true, force: true }); });
  setThumbnailer(file => { asked.push(file); return 'data:image/jpeg;base64,THUMB'; });
  t.after(() => setThumbnailer(() => null));
  const log = new ConversationLog();
  codexConversation(log, { ...record, payload: { ...record.payload, item: { ...record.payload.item, savedPath: file } } }, 'C:\\work');
  assert.deepEqual(log.list, [{ id: 'g:exec-f90e4bcb-0fdf-4441-aae9-03dfb167f4eb', at: Date.parse(record.timestamp), role: 'assistant', text: '', images: ['data:image/jpeg;base64,THUMB'],
    generated: { path: file, prompt: 'A uniform deep navy background with one pink circular icon.' } }]);
  assert.deepEqual(asked, [file]);
});

test('without a thumbnail a small result is shown as is; failures and unfinished pictures show nothing', () => {
  assert.equal(generatedImage(record.payload.item, 1).images[0], 'data:image/png;base64,iVBORw0KGgo');
  assert.equal(generatedImage({ ...record.payload.item, status: 'failed' }, 1), null);
  assert.equal(generatedImage({ ...record.payload.item, result: 'x'.repeat(3_000_000) }, 1), null, 'a full-size image is never put inline');
});

test('only pictures under a generated_images folder can be shown or opened', () => {
  assert.equal(isGeneratedImage(saved), true);
  assert.equal(isGeneratedImage('/home/me/.codex/generated_images/thread/exec-1.webp'), true);
  assert.equal(isGeneratedImage('C:\\Windows\\System32\\calc.exe'), false);
  assert.equal(isGeneratedImage('C:\\Users\\me\\.codex\\generated_images\\thread\\run.bat'), false);
  assert.equal(isGeneratedImage('generated_images/thread/exec-1.png'), false, 'relative paths are refused');
});
