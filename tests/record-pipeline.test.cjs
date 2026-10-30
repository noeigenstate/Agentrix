const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TranscriptTail, ActionLog, claudeRecord, codexActions, codexRecord } = require('../electron/agent-actions.cjs');
const { ConversationLog, claudeConversation, codexConversation, brief } = require('../electron/conversation.cjs');
const { ClaudeImageLine, IMAGE_LIMIT, IMAGE_OMITTED } = require('../electron/oversized-record.cjs');

const image = data => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const user = (content, extra = {}) => ({ type: 'user', uuid: 'prompt', timestamp: '2026-10-12T08:00:00.000Z', message: { content }, ...extra });
const tool = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'a.txt' } }] } };
async function transcript(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-records-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'session.jsonl');
  await fs.writeFile(file, '');
  const tail = new TranscriptTail(file), log = new ConversationLog();
  const read = () => tail.read(record => claudeConversation(log, record, folder));
  await read();
  return { file, tail, log, read };
}

test('Claude prompts over 1 MiB retain text and screenshots up to IMAGE_LIMIT', async t => {
  const f = await transcript(t), pixels = 'A'.repeat(IMAGE_LIMIT);
  const record = user([{ type: 'text', text: 'What is in this screenshot?' }, image(pixels), { type: 'text', text: 'Please explain it.' }]);
  const line = JSON.stringify(record) + '\n';
  assert.ok(Buffer.byteLength(line) > 1024 * 1024);
  await fs.appendFile(f.file, line);
  await f.read();
  assert.equal(f.log.list.length, 1);
  assert.equal(f.log.list[0].role, 'user');
  assert.equal(f.log.list[0].text, 'What is in this screenshot?\nPlease explain it.');
  assert.deepEqual(f.log.list[0].images, [`data:image/png;base64,${pixels}`]);
  const history = new ConversationLog();
  await new TranscriptTail(f.file).read(record => claudeConversation(history, record));
  assert.deepEqual(history.list, f.log.list, 'history recovers the same prompt and image');
});

test('huge Claude images leave placeholders across live polls while text and other images survive', async t => {
  const f = await transcript(t), pixels = 'A'.repeat(24 * 1024 * 1024);
  const record = user([image('BEFORE'), { type: 'text', text: 'Look at these pictures.' }, image(pixels),
    { type: 'text', text: 'The last picture matters too.' }, image('AFTER')]);
  const line = JSON.stringify(record);
  await fs.appendFile(f.file, line.slice(0, 1_200_000));
  await f.read();
  assert.deepEqual(f.log.list, [], 'an unfinished record is private');
  await fs.appendFile(f.file, line.slice(1_200_000) + '\n' + JSON.stringify({ ...tool, uuid: 'next' }) + '\n');
  const size = (await fs.stat(f.file)).size;
  while (f.tail.offset < size) await f.read();
  assert.deepEqual(f.log.list.map(entry => entry.role), ['user', 'tool']);
  assert.equal(f.log.list[0].text, 'Look at these pictures.\nThe last picture matters too.');
  assert.deepEqual(f.log.list[0].images, ['data:image/png;base64,BEFORE', IMAGE_OMITTED, 'data:image/png;base64,AFTER']);
  assert.equal(f.tail.oversized, null);
});

test('oversized Claude recovery handles split keys and UTF-8 and caps retained non-image data', () => {
  const record = user([{ type: 'text', text: '图片 "data": 不应被误认' }, image('AAAA'), { type: 'text', text: 'After the image' }]);
  const line = new ClaudeImageLine(Buffer.alloc(0));
  for (const byte of Buffer.from(JSON.stringify(record))) line.add(Buffer.from([byte]));
  assert.deepEqual(line.record(), record);
  const oversized = new ClaudeImageLine(Buffer.from('{"data":"AAAA","text":"'));
  for (let index = 0; index < 20; index++) oversized.add(Buffer.alloc(1024 * 1024, 65));
  oversized.add(Buffer.from('"}'));
  assert.equal(oversized.record(), null);
  assert.equal(oversized.discarded, true);
  assert.equal(oversized.parts.length, 0);
  assert.equal(oversized.buffer.length, 0);
});

test('Codex file cards and workdirs retain POSIX paths on every host platform', () => {
  const cwd = '/home/u/proj', cmd = 'apply_patch\n*** Add File: out.html\n';
  const log = new ConversationLog();
  const payloads = [
    { type: 'function_call', name: 'exec_command', call_id: 'function', arguments: JSON.stringify({ cmd, workdir: 'docs' }) },
    { type: 'local_shell_call', call_id: 'shell', action: { command: cmd, workdir: '/home/u/proj/other' } },
    { type: 'custom_tool_call', call_id: 'script', input: `tools.exec_command({cmd: ${JSON.stringify(cmd)}, workdir: "docs"})` },
  ];
  for (const payload of payloads) codexConversation(log, { type: 'response_item', payload }, cwd);
  assert.deepEqual(log.list.map(entry => entry.tool.written), [['/home/u/proj/docs/out.html'], ['/home/u/proj/other/out.html'], ['/home/u/proj/docs/out.html']]);
  const edit = { kind: 'edit', files: [{ path: 'out.html', change: 'write' }] };
  assert.deepEqual(brief(edit, cwd).written, ['/home/u/proj/out.html']);
  const local = path.join(os.tmpdir(), 'project');
  assert.deepEqual(brief(edit, local).written, [path.resolve(local, 'out.html')]);
  assert.equal(codexActions(payloads[0], 0, local)[0].cwd, path.resolve(local, 'docs'));
});

test('all Codex output types report exit failures in both activity and reading logs', () => {
  const cases = [
    [JSON.stringify({ output: 'failure', metadata: { exit_code: 2 } }), true],
    [JSON.stringify({ exit_code: 1 }), true],
    [{ metadata: { exit_code: -1 } }, true],
    [{ exit_code: '3' }, true],
    ['Exit code: 7\nOutput:\nfailed', true],
    ['Chunk ID: x\nWall time: 1 seconds\nProcess exited with code 9\nFinal output:\nfailed', true],
    [[{ type: 'text', text: JSON.stringify({ exit_code: 1 }) }], true],
    [{ content: [{ type: 'text', text: 'Process exited with code 4' }] }, true],
    [JSON.stringify({ metadata: { exit_code: 0 } }), false],
    [{ metadata: { exit_code: 0 }, output: 'Exit code: 1\nThis was printed by the program.' }, false],
    [{ exit_code: 0 }, false],
    ['Exit code: 0\nOutput:\nok', false],
    ['Process exited with code 0', false],
    ['Exit code: unknown', false],
    ['Tool returned an unfamiliar shape', false],
    [[], false], [null, false],
  ];
  for (const type of ['function_call_output', 'custom_tool_call_output', 'local_shell_call_output']) {
    for (const [output, failed] of cases) {
      const actions = new ActionLog(), conversation = new ConversationLog();
      const feed = payload => {
        const record = { type: 'response_item', payload };
        codexRecord(actions, record, '/home/u/proj'); codexConversation(conversation, record, '/home/u/proj');
      };
      feed({ type: 'custom_tool_call', call_id: 'call', input: 'tools.exec_command({cmd: "npm test"}); tools.exec_command({cmd: "git status"})' });
      feed({ type, call_id: 'call', output });
      assert.deepEqual(actions.list.map(action => [action.done, action.failed]), [[true, failed], [true, failed]], `${type}: ${JSON.stringify(output)}`);
      assert.deepEqual(conversation.list.map(entry => [entry.tool.done, entry.tool.failed]), [[true, failed], [true, failed]]);
    }
  }
});

test('Claude bookkeeping records neither create user messages nor reset current actions', () => {
  const actions = new ActionLog(), conversation = new ConversationLog();
  const feed = record => { claudeRecord(actions, record); claudeConversation(conversation, record); };
  feed(user('Real question'));
  feed(tool);
  for (const content of ['[Request interrupted by user]', '[Request interrupted by user for tool use]',
    'This session is being continued from a previous conversation that ran out of context.']) {
    feed(user(content));
    feed(user([{ type: 'text', text: content }]));
  }
  feed(user('Summary', { isCompactSummary: true }));
  feed(user('Hidden prompt', { isVisibleInTranscriptOnly: true }));
  feed({ type: 'attachment', isVisibleInTranscriptOnly: true, attachment: { type: 'queued_command', prompt: 'Hidden queued prompt' } });
  assert.deepEqual(conversation.list.map(entry => entry.role), ['user', 'tool']);
  assert.deepEqual(conversation.list.filter(entry => entry.role === 'user').map(entry => entry.text), ['Real question']);
  assert.deepEqual(actions.list.map(action => action.id), ['read']);
  feed(user('[Request interrupted by user] is the error I see', { uuid: 'real' }));
  assert.equal(conversation.list.at(-1).role, 'user', 'a real prompt mentioning the marker is still a prompt');
});

test("a session's first prompt, which Claude Code writes after its reply, still comes first and keeps its steps", () => {
  const changes = [], actions = new ActionLog(), conversation = new ConversationLog(change => changes.push(change));
  const feed = record => { claudeRecord(actions, record); claudeConversation(conversation, record); };
  const reply = (uuid, at, content) => ({ type: 'assistant', uuid, timestamp: at, message: { content } });
  // As Claude Code 2.1.300 writes a new session: the reply and its step, then the prompt stamped before them.
  feed(reply('r1', '2026-10-15T13:12:06.900Z', [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'a.txt' } }]));
  feed(reply('r2', '2026-10-15T13:12:06.934Z', [{ type: 'text', text: 'First answer.' }]));
  changes.length = 0;
  feed(user('First question', { uuid: 'p1', parentUuid: null, timestamp: '2026-10-15T13:12:06.230Z' }));
  assert.deepEqual(conversation.list.map(entry => entry.text || entry.role), ['First question', 'tool', 'First answer.']);
  assert.ok(changes.some(change => change.reset && change.entry?.text === 'First question'), 'the window gets the reordered list, and the prompt is still announced');
  assert.deepEqual(actions.list.map(action => action.id), ['read'], 'the step stamped after the prompt stays in its round');
  // A later prompt comes in order and starts a round without the earlier steps.
  feed(user('Second question', { uuid: 'p2', parentUuid: 'r2', timestamp: '2026-10-15T13:12:10.892Z' }));
  assert.equal(conversation.list.at(-1).text, 'Second question');
  assert.deepEqual(actions.list, []);
});

test("Claude Code's queue marks a message sent while it works until it takes it up, mid-turn or as the next turn", () => {
  const changes = [], log = new ConversationLog(change => changes.push(change));
  const queue = (operation, content, at) => claudeConversation(log, { type: 'queue-operation', operation, timestamp: at, sessionId: 's', ...(content === undefined ? {} : { content }) });
  queue('enqueue', '[Image #27]很多时候信息会显示发送中', '2026-10-16T06:22:32.210Z');
  queue('enqueue', 'second message', '2026-10-16T06:22:40.000Z');
  queue('enqueue', '/usage', '2026-10-16T06:22:41.000Z');
  assert.deepEqual(log.list.map(entry => [entry.role, entry.text, entry.queued]), [['user', '很多时候信息会显示发送中', true], ['user', 'second message', true]], 'a slash command is no message');
  // Taken up within the turn: the remove names it, and the record that follows is the message itself.
  changes.length = 0;
  queue('remove', '[Image #27]很多时候信息会显示发送中', '2026-10-16T06:22:45.424Z');
  assert.deepEqual(log.list.map(entry => [entry.text, entry.queued]), [['second message', true], ['很多时候信息会显示发送中', false]]);
  assert.ok(changes.some(change => change.entry && !change.entry.queued), 'the window receives its accepted user receipt');
  claudeConversation(log, { type: 'attachment', uuid: 'a1', timestamp: '2026-10-16T06:22:32.000Z', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '[Image #27]很多时候信息会显示发送中' } });
  // A priority-selected dequeue names nothing; the following user record identifies what was taken up.
  queue('dequeue', undefined, '2026-10-16T06:23:00.000Z');
  assert.equal(log.list.filter(entry => entry.queued).length, 1);
  claudeConversation(log, user('second message', { uuid: 'a2', timestamp: '2026-10-16T06:23:00.010Z' }));
  assert.deepEqual(log.list.map(entry => [entry.text, !!entry.queued]), [['很多时候信息会显示发送中', false], ['second message', false]]);
});

test('Codex script commands and workdirs stay with their own calls across literal quote styles', () => {
  const input = [
    "tools.exec_command({cmd: 'npm test', workdir: 'tests'});",
    'tools.exec_command({cmd: "git status", workdir: "docs"});',
    'tools.shell({cmd: `node task.js`, workdir: `scripts`});',
    'tools.exec_command({cmd: variable});',
    'tools.exec_command({cmd: "git diff", workdir: "other"});',
    'tools.exec_command({cmd: `echo ${value}`, workdir: `${directory}`});',
    `tools.exec_command(${JSON.stringify({ cmd: 'Get-Content ./SKILL.md', workdir: 'skills/with spaces' })});`,
    "tools.exec_command({'cmd': 'cat ./SKILL.md', 'workdir': 'skills/other'});",
  ].join('\n');
  const actions = codexActions({ type: 'custom_tool_call', call_id: 'call', input }, 0, '/home/u/proj');
  assert.deepEqual(actions.map(action => action.target), ['npm test', 'git status', 'node task.js', '', 'git diff', '', '.', '.']);
  assert.deepEqual(actions.map(action => action.cwd), ['/home/u/proj/tests', '/home/u/proj/docs', '/home/u/proj/scripts', '/home/u/proj', '/home/u/proj/other', '/home/u/proj', '/home/u/proj/skills/with spaces', '/home/u/proj/skills/other']);
  const escaped = codexActions({ type: 'custom_tool_call', call_id: 'escaped', input: `tools.exec_command({cmd: 'echo \\'hello\\' "world"', workdir: 'folder'});` }, 0, '/home/u/proj');
  assert.equal(escaped[0].target, 'echo \'hello\' "world"');
});
