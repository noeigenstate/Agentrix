const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { writeHandoff, startupNote } = require('../electron/features/agents/handoff.cjs');
const { encodeClaudeCwd } = require('../electron/claude-sessions.cjs');

const line = value => JSON.stringify(value) + '\n';

test('a CLI starting in a folder gets the latest rounds of both CLIs there, newest first, kept for good', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-handoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), claudeHome = path.join(root, 'claude'), codexHome = path.join(root, 'codex'), file = path.join(root, 'out', 'handoff.md'), memoryDir = path.join(root, 'memory');
  await fs.mkdir(cwd);
  // Claude Code worked here yesterday: one round that changed a file and ran the tests.
  const claudeId = randomUUID(), claudeFolder = path.join(claudeHome, 'projects', encodeClaudeCwd(cwd));
  await fs.mkdir(claudeFolder, { recursive: true });
  const claudeFile = path.join(claudeFolder, `${claudeId}.jsonl`), at = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  await fs.writeFile(claudeFile, [
    { type: 'user', uuid: 'u1', timestamp: at, cwd, sessionId: claudeId, message: { role: 'user', content: '给登录页加上验证码' } },
    { type: 'assistant', uuid: 'a1', timestamp: at, sessionId: claudeId, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: path.join(cwd, 'login.ts'), old_string: 'a', new_string: 'b' } }] } },
    { type: 'assistant', uuid: 'a2', timestamp: at, sessionId: claudeId, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] } },
    { type: 'user', uuid: 'n1', timestamp: at, sessionId: claudeId, message: { role: 'user', content: '<task-notification><status>completed</status></task-notification>' } },
    { type: 'assistant', uuid: 'a3', timestamp: at, sessionId: claudeId, message: { role: 'assistant', content: [{ type: 'text', text: '验证码加好了，测试通过。' }] } },
  ].map(line).join(''));
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000); await fs.utimes(claudeFile, yesterday, yesterday);
  // Codex worked here an hour ago.
  const codexId = randomUUID(), day = path.join(codexHome, 'sessions', '2026', '10', '12');
  await fs.mkdir(day, { recursive: true });
  const message = (type, text) => ({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'item_completed', item: { type, id: randomUUID(), content: [{ type: 'text', text }] } } });
  await fs.writeFile(path.join(day, `rollout-2026-10-12T10-00-00-${codexId}.jsonl`), [
    { type: 'session_meta', payload: { id: codexId, cwd, source: 'cli' } }, message('UserMessage', '把验证码的过期时间改成 5 分钟'), message('AgentMessage', '改成 5 分钟了。'),
  ].map(line).join(''));

  assert.equal(await writeHandoff(file, cwd, { memoryDir, codexHome, claudeHome }), true);
  const text = await fs.readFile(file, 'utf8');
  // On Windows the agents read it through PowerShell 5.1, which takes a file without a byte-order mark for the system
  // code page and garbles every Chinese word (Codex did, and knew nothing of the work).
  assert.equal(text.startsWith('﻿'), process.platform === 'win32', 'a byte-order mark on Windows, none elsewhere');
  assert.ok(text.indexOf('· Codex') < text.indexOf('· Claude Code'), 'newest first');
  assert.match(text, /The whole history is kept in .+\.md/);
  for (const part of ['**User:** 把验证码的过期时间改成 5 分钟', '**Codex:** 改成 5 分钟了。', '**User:** 给登录页加上验证码', '**Claude Code:** 验证码加好了，测试通过。', `Changed: ${path.join(cwd, 'login.ts')}`, 'Checks: 运行测试'])
    assert.ok(text.includes(part), part);
  assert.ok(!text.includes('task-notification'), 'notices the CLI put in the user\'s place are not asks');

  // The memory outlives the CLIs' own records: with both gone (Claude Code clears transcripts after a month), the next
  // start still hands on every round, and the full memory book holds them.
  await fs.rm(claudeHome, { recursive: true, force: true }); await fs.rm(codexHome, { recursive: true, force: true });
  assert.equal(await writeHandoff(file, cwd, { memoryDir, codexHome, claudeHome }), true);
  const again = await fs.readFile(file, 'utf8');
  for (const part of ['把验证码的过期时间改成 5 分钟', '给登录页加上验证码', 'Checks: 运行测试']) assert.ok(again.includes(part), part);
  const book = (await fs.readdir(memoryDir)).find(name => name.endsWith('.md'));
  const whole = await fs.readFile(path.join(memoryDir, book), 'utf8');
  assert.ok(whole.includes('验证码加好了'));
  assert.equal(whole.startsWith('﻿'), process.platform === 'win32', 'the whole memory is read the same way');
  // A folder where nothing was ever done gets no handoff.
  const empty = path.join(root, 'empty'); await fs.mkdir(empty);
  assert.equal(await writeHandoff(path.join(root, 'out', 'empty.md'), empty, { memoryDir, codexHome, claudeHome }), false);
});

test('the startup note names the handoff and skills with forward slashes and no quotes, for the TOML string Codex gets', () => {
  const note = startupNote('Reading view note.', 'C:\\Users\\me\\AppData\\Roaming\\Agentrix\\handoff\\t1.md', 'D:\\work\\app\\skills');
  assert.ok(note.startsWith('Reading view note. '));
  assert.ok(note.includes('D:/work/app/skills') && note.includes('never write personal or private data'));
  assert.ok(startupNote('Reading view note.', null, '/srv/app/skills').length < 2000, 'an SSH worker takes a note of up to 2000 characters');
  assert.ok(note.includes('C:/Users/me/AppData/Roaming/Agentrix/handoff/t1.md'));
  assert.ok(!/["\\\n]/.test(note));
  // Every note asks for the delivery summary the homework card reads (src/features/home/delivery.ts), with its labels.
  const plain = startupNote('Reading view note.', null);
  assert.ok(plain.startsWith('Reading view note. When you finish a task'));
  for (const label of ['【交付】', '问题：', '原因：', '结果：', '优化：', '解决：', '对比：']) assert.ok(plain.includes(label), label);
  assert.ok(!plain.includes('skills') && !plain.includes('read the file'));
});

test('the dispatch helper note uses an unquoted path for the quote-free startup envelope', () => {
  const note = startupNote('Read.', null, null, null, 'C:\\Program Files\\Agentrix\\integration\\dispatch.cjs');
  assert.ok(note.includes('Dispatch helper: node C:/Program Files/Agentrix/integration/dispatch.cjs — start every command-line Codex or Claude worker through it (see the agent-dispatch rules).'));
  assert.ok(!/["\\\n]/.test(note));
  const remote = startupNote('Read.', null, null, null, '{AGENTRIX_DISPATCH}');
  assert.ok(remote.includes('{AGENTRIX_DISPATCH_NOTE}'));
  assert.ok(!remote.includes('C:/Program Files'));
});

test('a round joins the memory once and later only grows; notices are not asks', async t => {
  const { roundsOf, remember, readArchive } = require('../electron/features/agents/project-memory.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-memory-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const entries = [
    { role: 'user', at: 1000, text: '加上限流' },
    { role: 'tool', at: 1001, tool: { phrase: '修改文件', written: ['/srv/app/limit.py'] } },
    { role: 'user', at: 1002, text: '<task-notification>done</task-notification>' },
  ];
  const first = roundsOf(entries, 'codex', 's1');
  assert.equal(first.length, 1); assert.deepEqual(first[0].files, ['/srv/app/limit.py']);
  assert.equal(await remember(dir, 'ssh://lab/srv/app', first), 1);
  assert.equal(await remember(dir, 'ssh://lab/srv/app', first), 0, 'the same round is not added twice');
  const later = roundsOf([...entries, { role: 'assistant', at: 1003, text: '限流加好了。' }], 'codex', 's1');
  assert.equal(await remember(dir, 'ssh://lab/srv/app', later), 1);
  const kept = await readArchive(dir, 'ssh://lab/srv/app');
  assert.equal(kept.length, 1); assert.equal(kept[0].reply, '限流加好了。');
});
