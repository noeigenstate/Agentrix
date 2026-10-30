const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { gather, readArchive } = require('../electron/features/agents/project-memory.cjs');
const { setThumbnailer } = require('../electron/conversation.cjs');

test('project memory gathers text without statting or decoding attached and generated pictures', async t => {
  const prefix = path.join(os.tmpdir(), 'agentrix-memory-pictures-'), root = await fs.mkdtemp(prefix);
  t.after(async () => { setThumbnailer(() => null); assert.ok(path.resolve(root).startsWith(prefix)); await fs.rm(root, { recursive: true, force: true }); });
  const cwd = path.join(root, 'project'), codexHome = path.join(root, 'codex'), claudeHome = path.join(root, 'claude'), dir = path.join(codexHome, 'sessions');
  await fs.mkdir(cwd); await fs.mkdir(dir, { recursive: true });
  const file = path.join(root, 'must-not-be-read.png'), id = randomUUID(), at = new Date().toISOString();
  let stats = 0, decoded = 0;
  const stat = sync.statSync;
  t.mock.method(sync, 'statSync', (...args) => { if (args[0] === file) stats++; return stat(...args); });
  setThumbnailer(() => { decoded++; throw new Error('image decoding is forbidden'); }, () => { decoded++; throw new Error('image decoding is forbidden'); });
  const values = [
    { type: 'session_meta', payload: { id, cwd, source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<image name="[Image #1]" path="synthetic.png">' }, { type: 'input_image', image_url: 'data:image/png;base64,SYNTHETIC' }, { type: 'input_text', text: '</image>\nDescribe this' }] } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'ask', content: [{ type: 'local_image', path: file }, { type: 'text', text: 'Describe this' }] } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'reply', content: [{ type: 'text', text: 'A synthetic test image.' }] } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'imageGeneration', id: 'generated', status: 'completed', savedPath: path.join(root, 'generated_images', 'thread', 'generated.png'), result: 'AAAA' } } },
  ];
  await fs.writeFile(path.join(dir, `rollout-${id}.jsonl`), values.map(value => JSON.stringify({ timestamp: at, ...value })).join('\n') + '\n');
  const memory = path.join(root, 'memory'); await gather(memory, cwd, { codexHome, claudeHome });
  const rounds = await readArchive(memory, cwd);
  assert.equal(rounds.length, 1); assert.equal(rounds[0].ask, 'Describe this'); assert.equal(rounds[0].reply, 'A synthetic test image.');
  assert.equal(stats, 0); assert.equal(decoded, 0); assert.ok(!JSON.stringify(rounds).includes('base64'));
});
