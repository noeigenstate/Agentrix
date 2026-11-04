const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createNormalizer } = require('../electron/features/claude-sdk/normalize.cjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createEventStream } = require('../electron/features/native-session/events.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
function normalize() { const events = []; return { events, emit: createNormalizer((type, payload, extra) => events.push({ type, payload, ...extra })) }; }

test('R6 real-shaped API errors are notices/results, never assistant prose; ordinary replies are preserved', () => {
  const { ConversationLog, claudeConversation } = require('../electron/conversation.cjs');
  const { rateLimits } = require('../electron/features/claude-sdk/limits.cjs');
  const f = normalize(), log = new ConversationLog();
  for (const [index, error, text] of [[1, 'rate_limit', 'API Error: Request rejected (429) · enforced_spend_limit_reached'],
    [2, 'unknown', 'API Error: 400 You have reached your specified API usage limits']]) {
    const record = { type: 'assistant', uuid: `error-${index}`, isApiErrorMessage: true, error,
      message: { id: `error-${index}`, model: '<synthetic>', content: [{ type: 'text', text }] } };
    f.emit(record); f.emit({ ...record, isReplay: true }); claudeConversation(log, record);
    assert.equal(rateLimits(record, null, 'scope', 1000).notice.message, 'API 用量已达上限。');
  }
  assert.deepEqual(f.events, []); assert.deepEqual(log.list.map(entry => entry.text), ['API 用量已达上限。', 'API 用量已达上限。']);
  const normal = { type: 'assistant', uuid: 'answer', message: { id: 'answer', content: [{ type: 'text', text: 'The API Error example uses 429 and enforced_spend_limit_reached.' }] } };
  f.emit(normal); claudeConversation(log, normal);
  assert.equal(f.events[0].payload.content.text, normal.message.content[0].text);
  assert.equal(log.list.at(-1).text, normal.message.content[0].text, 'text matching an error phrase is still a real answer');
});
test('A3 child prose and tools never enter the main feed, including replay and deltas', () => {
  const f = normalize();
  for (const message of [{ type: 'assistant', message: { id: 'child', content: [{ type: 'text', text: 'SUBAGENT' }, { type: 'tool_use', id: 'tool', name: 'Read', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'child output' }] } },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'child' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child delta' } } }]) f.emit({ ...message, parent_tool_use_id: 'agent-tool' });
  assert.deepEqual(f.events, []);
});
test('A5 replay uses the same conversation filtering and cleaning, including compact records', () => {
  const f = normalize();
  for (const record of [{ type: 'user', message: { content: '<task-notification>INTERNAL</task-notification>' } },
    { type: 'user', isCompactSummary: true, message: { content: 'COMPACT' } },
    { type: 'assistant', isCompactSummary: true, message: { content: 'COMPACT' } },
    { type: 'user', message: { content: '<local-command-stdout>INTERNAL</local-command-stdout>' } }]) f.emit({ uuid: require('node:crypto').randomUUID(), ...record, isReplay: true });
  assert.deepEqual(f.events, []);
});
test('A4 resume requests the entire verified chain and only displays the newest thousand records', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-history-tail-')), fake = fakeSdk(), events = [];
  fake.sdk.getSessionMessages = async (_id, options) => {
    const all = Array.from({ length: 2400 }, (_, i) => ({ type: 'user', uuid: `u-${i}`, session_id: fake.sessionId, message: { content: `Q${i}` } }));
    return options.limit === undefined ? all : all.slice(0, options.limit);
  };
  const runtime = createClaudeRuntime({ directory, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'offline-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  t.after(async () => { await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  runtime.credentials.save('sk-ant-offline-history-not-a-real-key');
  const session = runtime.create({ agent: 'claude', owner: 'gui', projectId: 'p', terminalId: 't', runtimeSessionId: 'r', providerSessionId: fake.sessionId,
    cwd: directory, env: { HOME: directory, CLAUDE_CONFIG_DIR: path.join(directory, '.claude') } }, event => events.push(event));
  await session.resume(); await session.prepareResume();
  const users = events.filter(event => event.type === 'item.upsert' && event.payload.kind === 'user-message');
  assert.equal(users.length, 1000); assert.equal(users[0].payload.content.text, 'Q1400'); assert.equal(users.at(-1).payload.content.text, 'Q2399');
});
test('A6 stream indexes survive omitted blank and duplicate text blocks', () => {
  const f = normalize(), stream = event => f.emit({ type: 'stream_event', event });
  stream({ type: 'message_start', message: { id: 'm' } });
  for (const [index, text] of ['\n\n', 'SAME', 'SAME', 'LAST'].entries()) {
    stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
    stream({ type: 'content_block_stop', index });
  }
  for (const [i, text] of ['SAME', 'SAME', 'LAST'].entries()) f.emit({ type: 'assistant', uuid: `record-${i}`, message: { id: 'm', content: [{ type: 'text', text }] } });
  const finals = f.events.filter(event => event.type === 'item.upsert');
  assert.deepEqual(finals.map(event => event.itemId), ['m:1', 'm:2', 'm:3']);
  assert.equal(f.events.some(event => event.type === 'item.delta' && !event.payload.text.trim()), false);
});
test('A7 requiring the real CLI fails closed instead of silently skipping every contract', () => {
  const env = { ...process.env, AGENTRIX_REQUIRE_REAL_CLI: '1' }; delete env.AGENTRIX_REAL_CLAUDE;
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', path.join(__dirname, 'claude-sdk-real-cli.test.cjs')], { env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.notEqual(result.status, 0);
});
test('A11 a user echo and replay keep one stable client id and bounded picture content', () => {
  const f = normalize(), image = 'data:image/png;base64,AA==';
  f.emit({ type: 'user', uuid: 'client-id', message: { content: [{ type: 'text', text: 'picture' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] } });
  assert.equal(f.events[0].itemId, 'client-id'); assert.deepEqual(f.events[0].payload.content.images, [image]);
});
test('A16 an oversized picture cannot evict the complete conversation snapshot', () => {
  const stream = createEventStream({ projectId: 'p', terminalId: 't', runtimeSessionId: 'r' }, () => {});
  stream.publish('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'Keep this answer' } }, { itemId: 'answer' });
  stream.publish('item.upsert', { kind: 'user-message', status: 'interrupted', content: { text: 'Keep this draft', images: ['data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024)], unsent: true } }, { itemId: 'draft' });
  assert.deepEqual(stream.snapshot().events.map(event => event.itemId), ['answer', 'draft']);
  assert.deepEqual(stream.snapshot().events.at(-1).payload.content.images, []);
});

test('A9 A10 A14 A15 keep original time, readable tool output and paths, and finish abandoned tools', () => {
  const f = normalize(), timestamp = '2025-01-02T03:04:05Z';
  f.emit({ type: 'assistant', timestamp, uuid: 'a', message: { content: [
    { type: 'tool_use', id: 'write', name: 'Write', input: { content: 'x'.repeat(70000), file_path: '/tmp/a.txt' } },
    { type: 'tool_use', id: 'todo', name: 'TodoWrite', input: { todos: [] } },
  ] } });
  assert.equal(f.events[0].occurredAtMs, Date.parse(timestamp)); assert.equal(f.events[0].payload.content.path, '/tmp/a.txt');
  assert.equal(f.events[0].payload.content.changes[0].path, '/tmp/a.txt'); assert.equal(f.events[1].payload.kind, 'tool');
  f.emit({ type: 'user', uuid: 'out', message: { content: [{ type: 'tool_result', tool_use_id: 'write', content: [{ type: 'text', text: 'clean output' }, { type: 'image', source: { data: 'NO-BASE64-IN-TEXT' } }] }] } });
  assert.equal(f.events.at(-1).payload.content.output, 'clean output\n[Image result]');
  f.emit({ type: 'result', terminal_reason: 'aborted_tools' });
  assert.equal(f.events.at(-1).itemId, 'todo'); assert.equal(f.events.at(-1).payload.status, 'interrupted');
});

test('A13 A17 Codex generated pictures use validated paths and shared command phrases; a new turn drops old plan/diff', () => {
  const { createEvents, itemPayload } = require('../electron/features/codex-app-server/events.cjs');
  let reads = 0;
  const image = itemPayload({ type: 'imageGeneration', id: 'g', status: 'completed', savedPath: 'C:\\tmp\\generated_images\\run\\image.png', revisedPrompt: 'picture' }, true, () => { reads++; return { images: ['data:image/png;base64,AA=='] }; });
  assert.equal(image.content.generated.prompt, 'picture'); assert.equal(image.content.images.length, 1);
  itemPayload({ type: 'imageGeneration', savedPath: '\\\\server\\share\\generated_images\\run\\image.png' }, true, () => { reads++; }); assert.equal(reads, 1);
  assert.equal(itemPayload({ type: 'commandExecution', command: 'node --test tests/a.test.cjs' }, true).content.phrase, require('../electron/command-phrase.cjs').commandPhrase('node --test tests/a.test.cjs').phrase);
  const events = createEvents({ agent: 'codex' }, () => {}, Date.now);
  events.notification('turn/plan/updated', { plan: [{ step: 'old', status: 'completed' }] }); events.notification('turn/diff/updated', { diff: 'old diff' });
  events.beginTurn(); assert.equal(events.snapshot().events.some(event => ['plan.updated', 'turn.diff'].includes(event.type)), false);
  events.binding.turnId = 'turn'; events.notification('item/started', { turnId: 'turn', item: { id: 'unfinished', type: 'commandExecution', status: 'inProgress', command: 'npm test' } });
  events.finishTurn(); assert.equal(events.snapshot().items.find(item => item.itemId === 'unfinished').status, 'interrupted');
  const usage = require('../electron/features/native-session/agent-usage.cjs').createNativeUsage('codex');
  usage.apply({ type: 'routing.updated', payload: { observed: { model: 'old' } } }); usage.apply({ type: 'routing.updated', payload: { observed: { model: null }, effective: { model: 'new' } } });
  assert.equal(usage.snapshot().model, 'new');
});

test('A18 a retry discards its incomplete previous stream rather than leaving two answers', () => {
  const f = normalize(), stream = event => f.emit({ type: 'stream_event', event });
  stream({ type: 'message_start', message: { id: 'old' } }); stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }); stream({ type: 'message_start', message: { id: 'new' } });
  assert.equal(f.events.at(-1).itemId, 'old:0'); assert.deepEqual(f.events.at(-1).payload.content, { text: '', discarded: true });
});

test('A8 the actual SDK session keeps background work and the query after a stopped result, then accepts another turn', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-interrupt-')), fake = fakeSdk(), events = [];
  const runtime = createClaudeRuntime({ directory, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'offline-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  t.after(async () => { await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  runtime.credentials.save('sk-ant-offline-interrupt-not-a-real-key');
  const session = runtime.create({ agent: 'claude', owner: 'gui', projectId: 'p', terminalId: 't', runtimeSessionId: 'r', cwd: directory,
    env: { HOME: directory, CLAUDE_CONFIG_DIR: path.join(directory, '.claude') } }, event => events.push(event));
  await session.start(); await session.send({ clientMessageId: 'first', text: 'work' });
  fake.emit({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', session_id: fake.sessionId });
  fake.emit({ type: 'system', subtype: 'task_started', task_id: 'background', is_backgrounded: true });
  await new Promise(resolve => setImmediate(resolve)); await session.interrupt();
  fake.emit({ type: 'result', uuid: 'stop', is_error: true, subtype: 'error_during_execution', terminal_reason: 'aborted_streaming', total_cost_usd: 0, modelUsage: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.snapshot().state, 'idle'); assert.equal(fake.closes.length, 0); assert.equal(session.activity().count, 1);
  await session.send({ clientMessageId: 'next', text: 'continue' }); assert.equal(fake.calls.length, 1);
});
