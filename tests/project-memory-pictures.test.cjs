const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { gather, readArchive, remember, writeMemoryBook } = require('../electron/features/agents/project-memory.cjs');
const { setThumbnailer } = require('../electron/conversation.cjs');

test('memory book publication is atomic and ordered with archive writes', async t => {
  const prefix = path.join(os.tmpdir(), 'agentrix-memory-book-'), root = await fs.mkdtemp(prefix);
  t.after(async () => { assert.ok(path.resolve(root).startsWith(prefix)); await fs.rm(root, { recursive: true, force: true }); });
  const folder = path.join(root, 'project'), round = { key: 'one', at: 1, agent: 'claude', ask: 'original round' };
  await remember(root, folder, [round]);
  const first = await writeMemoryBook(root, folder);
  const renaming = Promise.withResolvers(), publish = Promise.withResolvers(), rename = fs.rename;
  let bookWrites = 0;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target === first.file && ++bookWrites === 1) { renaming.resolve(source); await publish.promise; }
    return rename(source, target);
  });
  const unaffected = await writeMemoryBook(root, folder);
  assert.equal(unaffected.file, first.file);
  assert.equal(bookWrites, 0);
  await remember(root, folder, [{ ...round, key: 'two', ask: 'second round' }]);
  const second = writeMemoryBook(root, folder);
  const temporary = await renaming.promise;
  assert.notEqual(temporary, first.file + '.tmp');
  assert.match(await fs.readFile(temporary, 'utf8'), /second round/);
  assert.doesNotMatch(await fs.readFile(first.file, 'utf8'), /second round/);
  const added = remember(root, folder, [{ ...round, key: 'three', ask: 'third round' }]);
  assert.deepEqual((await readArchive(root, folder)).map(entry => entry.key), ['one', 'two']);
  publish.resolve();
  await second;
  await added;
  assert.deepEqual((await writeMemoryBook(root, folder)).rounds.map(entry => entry.key), ['one', 'two', 'three']);
});

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
