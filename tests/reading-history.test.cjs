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
    while (page.beforeCursor) {
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
  const { ConversationLog, codexConversation, setThumbnailer } = require('../electron/conversation.cjs');
  const { readTranscriptChunk } = require('../electron/oversized-record.cjs');
  const f = await fixture(t, 'codex', 1), timestamp = new Date().toISOString();
  setThumbnailer(() => null, () => 'data:image/png;base64,eA==');
  t.after(() => setThumbnailer(() => null));
  const records = [
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '<image name="picture">' },
      { type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(1200000) },
      { type: 'input_text', text: '</image>\nDescribe this' },
    ] } },
    { type: 'event_msg', timestamp, payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'human-picture', content: [
      { type: 'local_image', path: path.join(f.directory, 'missing.png') }, { type: 'text', text: 'Describe this' },
    ] } } },
  ];
  const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n');
  await fs.appendFile(f.filename, bytes);
  const live = new ConversationLog(), reader = { buffer: Buffer.alloc(0) };
  for (let at = 0; at < bytes.length; at += 65536) readTranscriptChunk(reader, bytes.subarray(at, at + 65536), record => codexConversation(live, record, f.source.cwd));
  const page = await f.history.page('terminal', f.key), image = page.entries.find(entry => entry.id === 'u:human-picture');
  assert.equal(live.list.length, 1);
  assert.deepEqual(image.images, ['data:image/png;base64,' + 'A'.repeat(1200000)]);
  assert.deepEqual(image, live.list[0]);
});

test('paged generated pictures retain the bounded saved-file thumbnail', async t => {
  const { setThumbnailer } = require('../electron/conversation.cjs');
  const f = await fixture(t, 'codex', 1), savedPath = path.join(f.directory, 'generated_images', 'thread', 'picture.png');
  const header = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header); header.writeUInt32BE(8, 16); header.writeUInt32BE(8, 20);
  await fs.mkdir(path.dirname(savedPath), { recursive: true }); await fs.writeFile(savedPath, header);
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

test('realpath aliases of the same home, cwd and transcript keep one binding without broadcasts', async t => {
  const f = await fixture(t), alias = path.join(f.directory, 'home-alias'), cwdAlias = path.join(f.directory, 'cwd-alias');
  try {
    await fs.symlink(f.source.home, alias, 'junction'); await fs.symlink(f.source.cwd, cwdAlias, 'junction');
    let changes = 0; f.history.changed = () => changes++;
    const initial = f.history.bindings.get('terminal').initial;
    for (let n = 0; n < 5; n++) await f.history.bind('terminal', { ...f.source, home: alias, cwd: cwdAlias,
      filename: path.join(alias, path.relative(f.source.home, f.filename)) });
    assert.equal(f.history.summary('terminal').key, f.key);
    assert.equal(f.history.bindings.get('terminal').initial, initial); assert.equal(changes, 0);
  } finally { await Promise.all([alias, cwdAlias].map(link => fs.rm(link, { force: true }))); }
});

test('initial page refreshes are single-flight and giant final records leave one placeholder with a usable earlier cursor', async t => {
  const f = await fixture(t, 'codex', 1);
  await fs.appendFile(f.filename, JSON.stringify({ type: 'irrelevant', text: 'x'.repeat(20 * 1024 * 1024) }) + '\n');
  const first = f.history.page('terminal', f.key), second = f.history.page('terminal', f.key);
  assert.equal(first, second, 'one conversion serves concurrent first-page requests');
  const page = await first;
  assert.equal(page.entries.length, 1); assert.equal(page.entries[0].omitted, true); assert.ok(page.beforeCursor);
  const older = await f.history.page('terminal', f.key, page.beforeCursor);
  assert.deepEqual(older.entries.map(entry => entry.text), ['question 0', 'answer 0']);
  assert.equal(older.beforeCursor, null);
});

test('historical tool pages settle tools whose turn end lies beyond the cut', async t => {
  const f = await fixture(t, 'codex', 1), timestamp = new Date().toISOString();
  const records = [{ type: 'response_item', timestamp, payload: { type: 'function_call', name: 'exec_command', call_id: 'old-call', arguments: '{"cmd":"echo old"}' } }];
  for (let n = 0; n < 100; n++) records.push({ type: 'event_msg', timestamp: new Date(Date.parse(timestamp) + n + 1).toISOString(), payload: { type: 'agent_message', message: `reply ${n}` } });
  records.push({ type: 'event_msg', timestamp, payload: { type: 'task_complete' } });
  await fs.appendFile(f.filename, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  let page = await f.history.page('terminal', f.key), tool;
  while (page.beforeCursor && !tool) { page = await f.history.page('terminal', f.key, page.beforeCursor); tool = page.entries.find(entry => entry.role === 'tool'); }
  assert.ok(tool); assert.equal(tool.tool.done, true);
});

test('queue IDs agree between a full live log and a page that omits earlier enqueues', async t => {
  const { ConversationLog, claudeConversation } = require('../electron/conversation.cjs');
  const f = await fixture(t, 'claude', 0), live = new ConversationLog(), records = [];
  for (let n = 0; n < 130; n++) records.push({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(1700000000000 + n).toISOString(), content: `queued ${n} ${'x'.repeat(9000)}` });
  for (const record of records) claudeConversation(live, record, f.source.cwd);
  await fs.appendFile(f.filename, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const page = await f.history.page('terminal', f.key), older = await f.history.page('terminal', f.key, page.beforeCursor);
  assert.deepEqual(page.entries.map(entry => entry.id), live.list.slice(-80).map(entry => entry.id));
  assert.equal(new Set([...older.entries, ...page.entries].map(entry => entry.id)).size, 120);
});

test('all main-process binding requests derive the same launched cwd and account home', async () => {
  const vm = require('node:vm'), main = await fs.readFile(path.join(__dirname, '../electron/main.cjs'), 'utf8'), calls = [];
  const session = { agentCwd: 'C:\\project\\subfolder', codexHome: 'C:\\isolated-codex' };
  const context = vm.createContext({ sessions: new Map([['terminal', session]]), store: { findTerminal: () => ({ record: { restore: { cwd: 'C:\\project\\old-subfolder' } } }) },
    findProject: () => ({ kind: 'local', path: 'C:\\project' }), readingHistory: { bind: (_id, source) => calls.push(source) },
    claudeConfigDir: () => 'C:\\isolated-claude', path, process, os });
  vm.runInContext(main.slice(main.indexOf('function prepareReading('), main.indexOf('const { handoffFile', main.indexOf('function prepareReading('))), context);
  context.prepareReading('terminal', { agent: 'claude', threadId: 'thread' });
  context.prepareReading('terminal', { agent: 'claude', threadId: 'thread', cwd: 'C:\\project' });
  context.prepareReading('terminal', { agent: 'codex', threadId: 'thread' });
  assert.ok(calls.every(source => source.cwd === session.agentCwd));
  assert.deepEqual(calls.map(source => source.home), ['C:\\isolated-claude', 'C:\\isolated-claude', session.codexHome]);
});
