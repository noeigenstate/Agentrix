const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { ReadingHistory } = require('../electron/reading-history.cjs');
const { encodeClaudeCwd } = require('../electron/claude-sessions.cjs');

async function fixture(t, agent = 'codex', turns = 150) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-reading-pages-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const cwd = path.join(directory, 'project'), home = path.join(directory, agent), threadId = randomUUID();
  await fs.mkdir(cwd);
  const folder = agent === 'codex' ? path.join(home, 'sessions') : path.join(home, 'projects', encodeClaudeCwd(cwd));
  await fs.mkdir(folder, { recursive: true });
  const filename = path.join(folder, agent === 'codex' ? `rollout-${threadId}.jsonl` : `${threadId}.jsonl`);
  const records = agent === 'codex' ? [{ type: 'session_meta', payload: { id: threadId, cwd, source: 'cli' } }] : [];
  for (let n = 0; n < turns; n++) {
    const timestamp = new Date(1700000000000 + n * 1000).toISOString();
    if (agent === 'codex') records.push({ type: 'event_msg', timestamp, payload: { type: 'user_message', message: `question ${n}` } },
      { type: 'event_msg', timestamp, payload: { type: 'agent_message', message: `answer ${n}` } });
    else records.push({ type: 'user', uuid: `u${n}`, sessionId: threadId, timestamp, message: { content: `question ${n}` } },
      { type: 'assistant', uuid: `a${n}`, sessionId: threadId, timestamp, message: { content: [{ type: 'text', text: `answer ${n}` }] } });
  }
  const text = records.map(record => JSON.stringify(record)).join('\n') + '\n';
  await fs.writeFile(filename, text);
  const history = new ReadingHistory();
  const source = { agent, cwd, home, threadId, filename };
  await history.bind('terminal', source);
  return { directory, filename, history, source, text, records, key: history.summary('terminal')?.key };
}

for (const agent of ['codex', 'claude']) {
  test(`${agent}: first 80 blocks and older pages of 40 reach the start without gaps or duplicate IDs`, async t => {
    const { history, key } = await fixture(t, agent);
    let page = await history.page('terminal', key), seen = [...page.entries];
    assert.equal(page.entries.length, 80); assert.equal(page.entries.at(-1).text, 'answer 149');
    while (page.hasEarlier) {
      page = await history.page('terminal', key, page.beforeCursor);
      assert.ok(page.entries.length <= 40);
      seen = [...page.entries, ...seen];
    }
    assert.equal(seen.length, 300); assert.equal(new Set(seen.map(entry => entry.id)).size, 300);
    assert.equal(seen[0].text, 'question 0');
  });
  test(`${agent}: a cursor cannot cross terminals or a binding generation (including A to B to A)`, async t => {
    const f = await fixture(t, agent), first = await f.history.page('terminal', f.key);
    await f.history.bind('other', f.source);
    await assert.rejects(f.history.page('other', f.key, first.beforeCursor));
    const otherKey = f.history.summary('other').key;
    await assert.rejects(f.history.page('other', otherKey, first.beforeCursor));
    f.history.close('terminal'); await f.history.bind('terminal', f.source);
    assert.notEqual(f.history.summary('terminal').key, f.key);
    await assert.rejects(f.history.page('terminal', f.key));
  });
  test(`${agent}: live growth preserves a cursor, rotation and truncation invalidate it`, async t => {
    const f = await fixture(t, agent), page = await f.history.page('terminal', f.key);
    await fs.appendFile(f.filename, JSON.stringify({ type: 'system', padding: 'growth' }) + '\n');
    assert.equal((await f.history.page('terminal', f.key, page.beforeCursor)).entries.length, 40);
    await fs.rename(f.filename, f.filename + '.old'); await fs.writeFile(f.filename, f.text);
    await assert.rejects(f.history.page('terminal', f.key, page.beforeCursor));
    await f.history.bind('terminal', f.source); const key = f.history.summary('terminal').key;
    await fs.truncate(f.filename, 0); await assert.rejects(f.history.page('terminal', key));
  });
}

test('a rewritten cursor boundary is rejected even when the same inode is regrown beyond its original size', async t => {
  const f = await fixture(t), page = await f.history.page('terminal', f.key);
  await fs.writeFile(f.filename, f.text.replaceAll('question', 'different-question'));
  await assert.rejects(f.history.page('terminal', f.key, page.beforeCursor));
});

test('a forged metadata scope and a file outside the configured home never become previews', async t => {
  const f = await fixture(t);
  await f.history.bind('wrong', { ...f.source, threadId: randomUUID() });
  assert.equal(f.history.summary('wrong'), null);
  const outside = path.join(f.directory, `rollout-${f.source.threadId}.jsonl`);
  await fs.writeFile(outside, f.text);
  await f.history.bind('outside', { ...f.source, filename: outside });
  assert.equal(f.history.summary('outside'), null);
});

test('conversion preserves image fields and ignores an incomplete final JSONL record', async t => {
  const f = await fixture(t, 'claude', 1), timestamp = new Date().toISOString();
  const image = { type: 'user', uuid: 'image', sessionId: f.source.threadId, timestamp, message: { content: [
    { type: 'text', text: 'with picture' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'eA==' } },
  ] } };
  await fs.appendFile(f.filename, JSON.stringify(image) + '\n{"type":"assistant"');
  const page = await f.history.page('terminal', f.key);
  assert.equal(page.entries.at(-1).text, 'with picture');
  assert.deepEqual(page.entries.at(-1).images, ['data:image/png;base64,eA==']);
});

test('paged Codex history streams an oversized image record through the same decoder as the live reader', async t => {
  const { setThumbnailer } = require('../electron/conversation.cjs');
  const f = await fixture(t, 'codex', 1), savedPath = path.join(f.directory, 'generated_images', 'thread', 'picture.png');
  setThumbnailer(file => { assert.equal(file, savedPath); return 'data:image/png;base64,eA=='; });
  t.after(() => setThumbnailer(() => null));
  await fs.appendFile(f.filename, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: {
    type: 'item_completed', item: { type: 'Extension', kind: 'image_gen.generation', id: 'large-image', status: 'completed',
      revisedPrompt: 'Synthetic picture', result: 'x'.repeat(1200000), savedPath },
  } }) + '\n');
  const page = await f.history.page('terminal', f.key), image = page.entries.find(entry => entry.id === 'g:large-image');
  assert.deepEqual(image.images, ['data:image/png;base64,eA==']);
  assert.deepEqual(image.generated, { path: savedPath, prompt: 'Synthetic picture' });
});

test('an empty cursor is invalid and a removed transcript immediately drops its preview', async t => {
  const f = await fixture(t);
  await assert.rejects(f.history.page('terminal', f.key, ''));
  await fs.unlink(f.filename);
  await assert.rejects(f.history.page('terminal', f.key));
  assert.equal(f.history.summary('terminal'), null);
});

test('consecutive tools count as a block and carry parent metadata across the initial cut', async t => {
  const f = await fixture(t, 'claude', 1), timestamp = new Date().toISOString();
  const records = [];
  for (let n = 0; n < 100; n++) records.push({ type: 'assistant', uuid: `tool${n}`, timestamp, message: { content: [
    { type: 'tool_use', id: `tool${n}`, name: 'Read', input: { file_path: 'sample.txt' } },
  ] } });
  await fs.appendFile(f.filename, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const page = await f.history.page('terminal', f.key);
  assert.equal(page.entries.length, 102);
  assert.equal(page.entries.at(-1).timeline.turn.id, page.entries[1].id);
  assert.equal(page.entries.at(-1).timeline.tools.id, 'tool0');
});
