const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { encodeClaudeCwd, findClaudeSession, listClaudeSessions, promptTitle, READ_BUDGET } = require('../electron/claude-sessions.cjs');
const { TranscriptTail, ActionLog, claudeRecord } = require('../electron/agent-actions.cjs');
const { ConversationLog, claudeConversation } = require('../electron/conversation.cjs');
const { monitorActivity } = require('../electron/codex-activity.cjs');
const { claudeResumeCommand } = require('../electron/session-restore.cjs');
const { HISTORY_WINDOW } = require('../electron/transcript-window.cjs');
const { agentCommand } = require('../electron/features/agents/agent-command.cjs');
const { agentSettings } = require('../electron/features/agents/agent-settings.cjs');

const user = content => ({ type: 'user', uuid: 'prompt', message: { content } });
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-claude-sessions-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const cwd = 'E:\\不负芳华\\project', folder = path.join(home, 'projects', encodeClaudeCwd(cwd));
  await fs.mkdir(folder, { recursive: true });
  const write = async (id, records, when = 1000000) => {
    const file = path.join(folder, `${id}.jsonl`);
    await fs.writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    await fs.utimes(file, when / 1000, when / 1000);
    return file;
  };
  return { home, cwd, folder, write };
}

test('Claude cwd encoding replaces every separator, punctuation and Unicode character separately', () => {
  assert.equal(encodeClaudeCwd('E:\\不负芳华\\pg-worktrees\\bisect\\.test-output\\narrow-claude-1791451017450\\one'),
    'E-------pg-worktrees-bisect--test-output-narrow-claude-1791451017450-one');
  assert.equal(encodeClaudeCwd('/tmp/a_b.c +é😀'), '-tmp-a-b-c----');
});

test('session lookup prefers the encoded project and scans folders only when it is absent', async t => {
  const f = await fixture(t), known = await f.write('known', [user('hello')]);
  const other = path.join(f.home, 'projects', 'edge-encoding'); await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'other.jsonl'), '{}\n');
  assert.equal(await findClaudeSession(f.cwd, 'known', f.home), known);
  assert.equal(await findClaudeSession(f.cwd, 'other', f.home), null);
  await fs.rename(f.folder, path.join(f.home, 'projects', 'legacy-encoding'));
  assert.equal(await findClaudeSession(f.cwd, 'known', f.home), path.join(f.home, 'projects', 'legacy-encoding', 'known.jsonl'));
  assert.equal(await findClaudeSession(f.cwd, 'missing', f.home), null);
  for (const id of ['../other', 'bad\rcommand', '', null]) assert.equal(await findClaudeSession(f.cwd, id, f.home), null);
});

test('titles accept text blocks, trim whitespace and skip metadata, tool results, commands and caveats', () => {
  assert.equal(promptTitle(user('  Fix\n this   project  ')), 'Fix this project');
  assert.equal(promptTitle(user([{ type: 'image' }, { type: 'text', text: 'A prompt' }])), 'A prompt');
  assert.equal(promptTitle(user('好'.repeat(130))).length, 120);
  for (const record of [
    { ...user('meta'), isMeta: true }, { ...user('child'), isSidechain: true },
    { type: 'assistant', message: { content: 'answer' } },
    user([{ type: 'text', text: 'hidden' }, { type: 'tool_result' }]),
    user('<command-name>/resume</command-name>'), user('<command-message>help</command-message>'),
    user('<local-command-stdout>done</local-command-stdout>'), user('<local-command-caveat>hidden</local-command-caveat>'),
    user('[Caveat: The messages below were generated while running local commands.]'), user('Caveat: local commands'), user([]),
  ]) assert.equal(promptTitle(record), '');
});

test('session list extracts the first real prompt, counts records and excludes the current id', async t => {
  const f = await fixture(t);
  await f.write('current', [user('current')], 3000000);
  await f.write('older', [user('old')], 1000000);
  await f.write('newer', [{ ...user('meta'), isMeta: true }, user('<command-name>/model</command-name>'),
    user([{ type: 'tool_result' }]), user('First real prompt'), user('Later prompt'), { type: 'assistant' }], 2000000);
  await fs.writeFile(path.join(f.folder, 'ignore.txt'), 'nothing');
  await fs.mkdir(path.join(f.folder, 'child.jsonl'));
  const list = await listClaudeSessions(f.cwd, 'current', f.home);
  assert.deepEqual(list, [
    { id: 'newer', title: 'First real prompt', updatedAt: 2000000, messages: 6 },
    { id: 'older', title: 'old', updatedAt: 1000000, messages: 1 },
  ]);
});

test('session list takes the newest 30 and missing project folders return an empty list', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 35; index++) await f.write(`session-${index}`, [user(`prompt ${index}`)], 1000000 + index * 1000);
  const list = await listClaudeSessions(f.cwd, null, f.home);
  assert.equal(list.length, 30); assert.equal(list[0].id, 'session-34'); assert.equal(list.at(-1).id, 'session-5');
  assert.deepEqual(await listClaudeSessions('/missing', null, f.home), []);
});

test('large transcripts never read titles beyond 256 KiB and estimate message density', async t => {
  const f = await fixture(t);
  const line = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(500) } }) + '\n';
  const records = Math.ceil(READ_BUDGET / Buffer.byteLength(line)) + 30;
  await fs.writeFile(path.join(f.folder, 'large.jsonl'), line.repeat(records) + JSON.stringify(user('Too late to be read')) + '\n');
  await fs.writeFile(path.join(f.folder, 'broken.jsonl'), '{bad json}\n' + JSON.stringify(user('Valid prompt')) + '\n{"type":"user"');
  const list = await listClaudeSessions(f.cwd, null, f.home);
  assert.equal(list.find(item => item.id === 'large').title, '');
  assert.ok(Math.abs(list.find(item => item.id === 'large').messages - records) <= 2);
  assert.equal(list.find(item => item.id === 'broken').title, 'Valid prompt');
  assert.equal(list.find(item => item.id === 'broken').messages, 1);
});

const main = syncFs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
function mainHarness(t, f) {
  const project = { id: 'project', path: f.cwd, kind: 'local' };
  const restore = { cwd: f.cwd, agent: 'claude' };
  let resets = 0;
  const s = { terminalId: 'terminal', projectId: project.id, sessionKey: 'key', agent: 'claude', codexActive: true,
    actions: new ActionLog(), conversation: new ConversationLog(), promptQueue: { reset() {} }, submissions: { reset() {} } };
  const reset = s.conversation.reset.bind(s.conversation); s.conversation.reset = () => { resets++; reset(); };
  const sessions = new Map([[s.terminalId, s]]);
  const store = { projects: [project], findTerminal: () => ({ record: { restore } }),
    setRestore: (_id, value) => Object.assign(restore, value), expectCompletion() {} };
  // Reads here happen when the test asks: a write told by the file watch (codex-activity.test.cjs) would start one
  // while a large file is still being written.
  const context = vm.createContext({ path, sessions, store,
    readingHistory: { summary: () => null, close() {} }, prepareReading: async () => {}, TranscriptTail, AgentCalls: require('../electron/features/agents/agent-calls.cjs').AgentCalls, monitorActivity: (read, changed, options) => monitorActivity(read, changed, { ...options, watch: null }), claudeConversation, claudeRecord,
    claudeConfigDir: () => f.home, findClaudeSession: (cwd, id) => findClaudeSession(cwd, id, f.home),
    describeActions() {}, skills: null, findProject: () => project, broadcast() {}, scheduleState() {}, acceptShellEvent: () => true, noteSettings() {}, readEvery: () => 1000,
    startSkillSession() {}, endSkillSession() {},
    ...require('../electron/features/agents/agent-usage.cjs'), claudeAccount: async () => null, setInterval: (run, ms) => setInterval(run, ms).unref(), clearInterval, agentCommand: require('../electron/features/agents/agent-command.cjs').agentCommand,
    claudeAccounts: { account: null, setActive() {}, refresh() {} },
    quitting: false, Date, claudeResumeCommand, restorePlans: new Map(), agentCommand, sshHandoff: async () => false,
    // The handoff of earlier work is written on start (handoff.cjs, tested on its own).
    writeHandoff: async () => false, handoffFile: id => path.join(f.home, 'handoff', `${id}.md`), memoryDir: () => path.join(f.home, 'memory'), scrubProjectSkills: async () => [],
  });
  vm.runInContext(main.slice(main.indexOf('function followClaude('), main.indexOf('// One place turns an agent')), context);
  vm.runInContext(main.slice(main.indexOf('function onEvent('), main.indexOf('function remoteFor(')), context);
  t.after(() => s.activityMonitor?.stop());
  return { project, s, store, sessions, context, restore, resets: () => resets };
}

function activityHarness(t, f) {
  const h = mainHarness(t, f);
  h.project.seenEvents = [];
  h.s.promptQueue.finish = () => {};
  h.store.complete = () => false;
  Object.assign(h.context, {
    summarizeTask: () => '', isLocalAgentCommand: () => false, notifyCompletion() {},
    promptText: require('../electron/prompt-queue.cjs').promptText,
    memoryFolder: () => f.cwd, roundsOf: () => [], remember: async () => {},
    setTimeout: () => ({ unref() {} }),
  });
  vm.runInContext(main.slice(main.indexOf('function applyActivity('), main.indexOf('function onEvent(')), h.context);
  return h;
}

const pendingTool = id => ({ type: 'assistant', uuid: id, message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `${id}.txt` } }] } });

test('SSH Claude hooks poll remote records with history, tools and settings through the local consumers', async t => {
  const f = await fixture(t), h = activityHarness(t, f), requests = [], described = [];
  h.project.kind = 'ssh'; h.project.path = '/srv/project'; h.s.activitySince = 1000;
  h.context.claudeConfigDir = () => { throw new Error('SSH must use the server config directory'); };
  h.context.noteSettings = (s, agent, record) => { s.agentSettings = agentSettings(s.agentSettings || null, agent, record); };
  h.context.describeActions = (_s, cwd, actions) => { for (const action of actions || []) described.push([cwd, action.target]); };
  h.context.monitorActivity = (read, _changed, options) => ({ poll: read, stop() {}, options });
  const file = '/srv/claude/projects/-srv-project/session.jsonl';
  const records = [user('Remote prompt'), { ...pendingTool('read'), message: { model: 'claude-test', usage: { speed: 'fast' }, content: pendingTool('read').message.content }, effort: 'high' }];
  const responses = [
    { records, reset: true, historyDone: false },
    { records: [user([{ type: 'tool_result', tool_use_id: 'read', is_error: true }])], reset: false, historyDone: true },
    { records: [user('Replaced prompt')], reset: true, historyDone: true },
  ];
  h.s.terminal = { request: async (op, args) => { requests.push([op, { ...args }]); return responses.shift(); } };
  h.context.claudeActivity(h.project, h.s, { state: 'session', sessionId: 'session', eventId: 'session:1', transcriptPath: file, sentAt: 900 });
  await h.s.activityMonitor.poll();
  assert.deepEqual(requests[0], ['claude-status', { path: file, since: 900 }]);
  assert.equal(h.s.activityMonitor.options.watch(), null); assert.equal(h.s.activityMonitor.options.interval(), 1000);
  assert.equal(h.s.conversation.loading, true); assert.equal(h.s.conversation.list[0].text, 'Remote prompt');
  assert.deepEqual(h.s.agentSettings, { model: 'claude-test', effort: 'high', fast: true });
  assert.deepEqual(described, [['/srv/project', 'read.txt']]);
  const tail = h.s.claudeTranscript;
  h.context.followClaude(h.project, h.s, { sessionId: 'session', transcriptPath: file, sentAt: 1200 });
  await new Promise(setImmediate);
  assert.equal(h.s.claudeTranscript, tail); assert.equal(h.resets(), 1);
  assert.equal(requests[1][1].since, 900, 'later hooks keep the incremental reader');
  assert.equal(h.s.conversation.loading, false); assert.equal(h.s.actions.list[0].failed, true);
  assert.equal(h.s.conversation.list.find(entry => entry.role === 'tool').tool.failed, true);
  await h.s.activityMonitor.poll();
  assert.equal(h.resets(), 2); assert.deepEqual(h.s.conversation.list.map(entry => entry.text), ['Replaced prompt']);
});

test('SSH Claude ignores stale reads after a session change or terminal exit and rejects malformed paths', async t => {
  const f = await fixture(t), h = mainHarness(t, f), pending = [];
  h.project.kind = 'ssh'; h.s.activitySince = 1000;
  h.context.monitorActivity = read => ({ poll: read, stop() {} });
  h.s.terminal = { request: () => new Promise(resolve => pending.push(resolve)) };
  for (const transcriptPath of ['relative/session.jsonl', 'C:\\local\\session.jsonl', '/srv/claude/other.jsonl']) {
    h.context.followClaude(h.project, h.s, { sessionId: 'session', transcriptPath });
    assert.equal(h.s.activityMonitor, undefined);
  }
  h.context.followClaude(h.project, h.s, { sessionId: 'first', transcriptPath: '/srv/claude/projects/project/first.jsonl' });
  const old = h.s.activityMonitor.poll();
  h.context.followClaude(h.project, h.s, { sessionId: 'second', transcriptPath: '/srv/claude/projects/project/second.jsonl' });
  pending.shift()({ records: [user('Old answer')], reset: true, historyDone: true });
  await old; assert.equal(h.resets(), 0); assert.equal(h.s.conversation.list.length, 0);
  const exited = h.s.activityMonitor.poll();
  h.context.onEvent({ projectId: 'terminal', sessionKey: 'key', type: 'codex-exited', agent: 'claude' });
  pending.shift()({ records: [user('Late answer')], reset: true, historyDone: true });
  await exited; assert.equal(h.resets(), 0); assert.equal(h.s.conversation.list.length, 0);
});

test('SSH Claude Stop reads the final tool results before settling the reading view', async t => {
  const f = await fixture(t), h = activityHarness(t, f);
  h.project.kind = 'ssh'; h.project.path = '/srv/project'; h.s.activitySince = 1000;
  h.context.monitorActivity = read => ({ poll: read, stop() {} });
  let response = { records: [user('Remote work'), pendingTool('failed'), pendingTool('last')], reset: true, historyDone: true };
  h.s.terminal = { request: async () => response };
  const transcriptPath = '/srv/claude/projects/project/session.jsonl';
  h.context.followClaude(h.project, h.s, { sessionId: 'session', transcriptPath });
  await h.s.activityMonitor.poll();
  response = { records: [user([{ type: 'tool_result', tool_use_id: 'failed', is_error: true }])], reset: false, historyDone: true };
  h.context.claudeActivity(h.project, h.s, { state: 'complete', sessionId: 'session', transcriptPath, eventId: 'session:stop' });
  await new Promise(setImmediate);
  assert.equal(h.s.codexActivity, 'complete');
  assert.ok(h.s.actions.list.every(action => action.done)); assert.equal(h.s.actions.list[0].failed, true);
  assert.ok(h.s.conversation.list.filter(entry => entry.role === 'tool').every(entry => entry.tool.done));
});

test('Claude Stop polls the last transcript records before settling both action and conversation tools', async t => {
  const f = await fixture(t), file = await f.write('session', [user('Question'), pendingTool('failed'), pendingTool('unanswered')]);
  const h = activityHarness(t, f);
  await h.context.followClaudeSession(h.project, h.s, 'session');
  h.s.codexActivity = 'working';
  await fs.appendFile(file, [
    user([{ type: 'tool_result', tool_use_id: 'failed', is_error: true }]), pendingTool('last'),
  ].map(record => JSON.stringify(record) + '\n').join(''));
  h.context.claudeActivity(h.project, h.s, { state: 'complete', sessionId: 'session', eventId: 'session:round', transcriptPath: file });
  await h.s.activityMonitor.poll();
  await new Promise(setImmediate);
  assert.equal(h.s.codexActivity, 'complete');
  assert.deepEqual(h.s.actions.list.map(action => [action.id, action.done, action.failed]), [['failed', true, true], ['unanswered', true, false], ['last', true, false]]);
  assert.deepEqual(h.s.conversation.list.filter(entry => entry.role === 'tool').map(entry => [entry.id, entry.tool.done, entry.tool.failed]), [['failed', true, true], ['unanswered', true, false], ['last', true, false]]);
});

test('Escape interruption settles both Claude views through the existing terminal IPC activity flow', async t => {
  const f = await fixture(t);
  await f.write('session', [user('Question'), pendingTool('pending')]);
  const h = activityHarness(t, f);
  await h.context.followClaudeSession(h.project, h.s, 'session');
  const listeners = {}, keys = [];
  Object.assign(h.s, { codexActivity: 'working', status: 'running', needsInput: null,
    submissions: { write: () => false, sent: [] }, gate: { input: key => keys.push(key) } });
  require('../electron/features/terminal/ipc.cjs').registerTerminalIpc({ handle() {}, listen: (name, callback) => { listeners[name] = callback; },
    getSession: id => h.sessions.get(id), getProjectById: () => h.project, applyActivity: h.context.applyActivity });
  listeners['terminal:write']('terminal', '\x1b');
  await h.s.activityMonitor.poll();
  await new Promise(setImmediate);
  assert.deepEqual(keys, ['\x1b']);
  assert.equal(h.s.codexActivity, 'interrupted');
  assert.equal(h.s.actions.list[0].done, true);
  assert.equal(h.s.conversation.list.at(-1).tool.done, true);
});

test('a delayed Claude final poll cannot settle a newer round, submission or replacement session', async t => {
  const f = await fixture(t);
  for (const change of ['round', 'submission', 'replacement']) {
    const h = activityHarness(t, f);
    claudeRecord(h.s.actions, pendingTool('pending'), f.cwd);
    claudeConversation(h.s.conversation, pendingTool('pending'), f.cwd);
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    h.s.activityMonitor = { poll: () => pending, stop() {} };
    h.context.claudeActivity(h.project, h.s, { state: 'complete', sessionId: 'session', eventId: 'session:old' });
    assert.equal(h.s.conversation.list[0].tool.done, false, 'settlement waits for the poll');
    if (change === 'round') h.context.claudeActivity(h.project, h.s, { state: 'working', sessionId: 'session', eventId: 'session:new', prompt: 'Next question' });
    else if (change === 'submission') { h.s.codexActivity = 'working'; h.s.activityInputAt = Date.now() + 1; }
    else h.sessions.delete('terminal');
    finish(); await pending; await new Promise(setImmediate);
    assert.equal(h.s.actions.list[0].done, false, change);
    assert.equal(h.s.conversation.list[0].tool.done, false, change);
  }
});

test('Claude interruption without a transcript monitor still settles, while stale activity is ignored', async t => {
  const h = activityHarness(t, await fixture(t));
  claudeRecord(h.s.actions, pendingTool('pending'));
  claudeConversation(h.s.conversation, pendingTool('pending'));
  h.s.activitySince = 20; h.s.activityInputAt = 30; h.s.codexActivity = 'working';
  h.context.applyActivity(h.project, h.s, { state: 'interrupted', updatedAt: 25 });
  await Promise.resolve();
  assert.equal(h.s.conversation.list[0].tool.done, false);
  h.context.applyActivity(h.project, h.s, { state: 'interrupted', updatedAt: 31 });
  await Promise.resolve();
  assert.equal(h.s.actions.list[0].done, true);
  assert.equal(h.s.conversation.list[0].tool.done, true);
});

test('following a known id loads history immediately, and same-session hooks preserve the tail and log', async t => {
  const f = await fixture(t), file = await f.write('session', [user('Before resume'), { type: 'assistant', uuid: 'reply', message: { content: [{ type: 'text', text: 'Previous answer' }] } }]);
  const h = mainHarness(t, f);
  assert.equal(await h.context.followClaudeSession(h.project, h.s, 'session'), true);
  assert.deepEqual(h.s.conversation.list.map(entry => entry.text), ['Before resume', 'Previous answer']);
  assert.equal(h.restore.threadId, 'session');
  const tail = h.s.claudeTranscript;
  h.context.followClaude(h.project, h.s, { sessionId: 'session', transcriptPath: file });
  await h.s.activityMonitor.poll();
  assert.equal(h.s.claudeTranscript, tail); assert.equal(h.resets(), 1); assert.equal(h.s.conversation.list.length, 2);
});

test('both Claude followers load a large session window and clear old consumers when it is replaced', async t => {
  const f = await fixture(t), file = await f.write('large', [user('excluded'),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'excluded', name: 'Skill', input: { skill: 'excluded-skill' } }] } },
    { padding: 'x'.repeat(HISTORY_WINDOW + 1000) },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'excluded' }] } },
    { type: 'assistant', uuid: 'recent', message: { content: [{ type: 'text', text: 'Recent answer' },
      { type: 'tool_use', id: 'recent-skill', name: 'Skill', input: { skill: 'recent-skill' } }] } }]);
  const h = mainHarness(t, f), described = [];
  h.context.skillDescription = async name => { described.push(name); return 'Recent skill description'; };
  vm.runInContext(main.slice(main.indexOf('function describeActions('), main.indexOf('// Claude Code writes each tool call')), h.context);
  assert.equal(await h.context.followClaudeSession(h.project, h.s, 'large'), true);
  for (let count = 0; h.s.claudeTranscript.historyPending && count < 8; count++) await h.s.activityMonitor.poll();
  assert.equal(h.s.claudeTranscript.historyPending, false);
  assert.deepEqual(h.s.conversation.snapshot().filter(entry => entry.text).map(entry => entry.text), ['Recent answer']);
  assert.deepEqual(described, ['recent-skill'], 'only in-window skill calls reach describeActions');
  assert.deepEqual(h.s.actions.list.map(action => action.id), ['recent-skill']);
  assert.equal(h.s.actions.list[0].description, 'Recent skill description');
  const tail = h.s.claudeTranscript;
  h.context.followClaude(h.project, h.s, { sessionId: 'large', transcriptPath: file });
  await h.s.activityMonitor.poll();
  assert.equal(h.s.claudeTranscript, tail); assert.equal(h.resets(), 1);
  await fs.rename(file, `${file}.old`);
  h.s.lastTask = 'Previous task';
  await fs.writeFile(file, JSON.stringify({ padding: 'x'.repeat(HISTORY_WINDOW + 2000) }) + '\n'
    + JSON.stringify({ type: 'assistant', uuid: 'new', message: { content: [{ type: 'tool_use', id: 'new-tool', name: 'Read', input: { file_path: 'new.txt' } }] } }) + '\n');
  await h.s.activityMonitor.poll();
  assert.equal(h.resets(), 2);
  for (let count = 0; h.s.claudeTranscript.historyPending && count < 8; count++) await h.s.activityMonitor.poll();
  assert.equal(h.s.lastTask, 'Previous task', 'history callbacks preserve the task remembered from live hooks, including continue prompts');
  assert.deepEqual(h.s.conversation.snapshot().map(entry => entry.role), ['tool']);
  assert.deepEqual(h.s.actions.list.map(action => action.id), ['new-tool']);
});

test('restored sessions follow before a hook and keep history when the agent-started event arrives', async t => {
  const f = await fixture(t), id = '12345678-1234-1234-1234-123456789abc';
  await f.write(id, [user('Restored prompt')]);
  const h = mainHarness(t, f);
  Object.assign(h.restore, { threadId: id });
  const written = [];
  Object.assign(h.s, { ready: true, inputDirty: false, claudeAvailable: true, codexActive: false, gate: { afterPrompt: text => written.push(text) } });
  h.context.restorePlans.set('terminal', { codex: true });
  await h.context.resumeAfterPrompt(h.project, h.s);
  assert.deepEqual(written, [`claude --resume ${id}\r`]);
  assert.equal(h.s.conversation.list[0].text, 'Restored prompt');
  const tail = h.s.claudeTranscript;
  h.context.onEvent({ projectId: 'terminal', sessionKey: 'key', type: 'codex-started', agent: 'claude', cwd: f.cwd });
  await h.s.activityMonitor.poll();
  assert.equal(h.s.claudeTranscript, tail); assert.equal(h.resets(), 1); assert.equal(h.s.conversation.list[0].text, 'Restored prompt');
});

test('Claude restore keeps the same read-only preview in broadcasts until its CLI starts', async t => {
  const f = await fixture(t), id = '12345678-1234-1234-1234-123456789abc';
  await f.write(id, [user('Restored prompt')]);
  const h = mainHarness(t, f), scope = { key: 'saved-preview', agent: 'claude', threadId: id }, snapshots = [];
  Object.assign(h.restore, { threadId: id, codex: true });
  Object.assign(h.s, { ready: true, status: 'shell', codexActive: false, claudeAvailable: true, gate: { afterPrompt() {} } });
  h.s.promptQueue.list = () => [];
  h.context.readingHistory.summary = () => scope;
  h.context.readingHistory.close = () => assert.fail('a launched restore retains its preview binding');
  Object.assign(h.context, {
    terminalIds: () => ['terminal'], shownTerminalIds: () => ['terminal'], startupErrors: new Map(),
    dispatchedOnly: () => null, getBranch: () => '', t: text => text, localShell: () => ({ kind: 'powershell' }),
    process: { platform: 'win32', env: { AGENTRIX_DATA_DIR: f.home } }, app: { getVersion: () => 'test' },
    desktopGlassBackend: null, desktopGlassWindow: false, desktopGlassActive: false, windowZoom: null,
  });
  h.store.settings = {};
  vm.runInContext(main.slice(main.indexOf('function publicState('), main.indexOf('function terminalIds(')), h.context);
  const shown = () => h.context.publicState().projects[0].terminals[0];
  h.context.broadcast = () => snapshots.push(shown());
  const follow = h.context.followClaudeSession;
  let resumeFollow;
  h.context.followClaudeSession = async (...args) => {
    await new Promise(resolve => { resumeFollow = resolve; });
    return follow(...args);
  };
  h.context.restorePlans.set('terminal', { codex: true });
  assert.equal(shown().readingHistory, scope);
  const restoring = h.context.resumeAfterPrompt(h.project, h.s);
  assert.equal(h.context.restorePlans.has('terminal'), false);
  h.context.broadcast();
  assert.equal(shown().readingHistory, scope); assert.equal(shown().agentStarting, true); assert.equal(shown().shellReady, false);
  resumeFollow(); await restoring;
  assert.equal(shown().readingHistory, scope); assert.equal(shown().agentStarting, true);
  h.context.onEvent({ projectId: 'terminal', sessionKey: 'key', type: 'codex-started', agent: 'claude', cwd: f.cwd });
  assert.equal(h.s.agentStarting, false); assert.equal(shown().agentStarting, false); assert.equal(shown().readingHistory, scope);
  assert.ok(snapshots.length >= 3); assert.ok(snapshots.every(value => value.readingHistory === scope));
});

test('Claude restore failures clear startup and close the consumed preview binding', async t => {
  const f = await fixture(t);
  for (const failure of ['dirty', 'missing', 'terminal-only', 'invalid-id', 'active']) {
    const h = mainHarness(t, f), closed = [];
    Object.assign(h.s, { ready: true, codexActive: failure === 'active', claudeAvailable: failure !== 'missing',
      agentStarting: true, inputDirty: failure === 'dirty', gate: { afterPrompt: () => assert.fail(failure) } });
    if (failure === 'invalid-id') h.restore.threadId = 'invalid';
    h.context.readingHistory.close = id => closed.push(id);
    h.context.restorePlans.set('terminal', { codex: failure !== 'terminal-only' });
    await h.context.resumeAfterPrompt(h.project, h.s);
    assert.equal(h.s.agentStarting, false, failure); assert.deepEqual(closed, ['terminal'], failure);
    assert.equal(h.context.restorePlans.size, 0, failure);
    if (failure === 'invalid-id') assert.match(h.s.error, /恢复会话失败/);
  }
});

for (const catchingUp of [false, true]) test(`Claude CLI start preserves recovered workers and catching-up=${catchingUp} without arming completion`, async t => {
  const { CompletionWork } = require('../electron/completion-work.cjs');
  const f = await fixture(t), id = '12345678-1234-1234-1234-123456789abc';
  const timestamp = new Date(Date.now() - 30000).toISOString();
  await f.write(id, [
    { ...pendingTool('prefix-worker'), timestamp, message: { content: [{ type: 'tool_use', id: 'prefix-worker', name: 'Agent', input: { run_in_background: true } }] } },
    { padding: 'x'.repeat(HISTORY_WINDOW + 1000) },
    { type: 'assistant', uuid: 'ended', timestamp, message: { stop_reason: 'end_turn', content: [] } },
  ]);
  const h = activityHarness(t, f), changes = [];
  h.s.completionWork = new CompletionWork(); t.after(() => h.s.completionWork.reset());
  h.store.expectCompletion = (_id, value = true) => changes.push(value);
  h.store.complete = () => assert.fail('historical replay cannot grant completion');
  h.context.notifyCompletion = () => assert.fail('historical replay cannot notify');
  Object.assign(h.s, { codexActive: false, claudeResumeId: id });
  await h.context.followClaudeSession(h.project, h.s, id);
  assert.ok(h.s.completionWork.find('prefix-worker'), 'the launch before the display window was recovered');
  assert.equal(h.s.completionWork.reading, false);
  h.s.completionWork.reading = catchingUp;
  const tail = h.s.claudeTranscript, workVersion = h.s.completionWork.version;
  h.context.onEvent({ projectId: 'terminal', sessionKey: 'key', type: 'codex-started', agent: 'claude', cwd: f.cwd });
  assert.equal(h.s.claudeTranscript, tail);
  assert.ok(h.s.completionWork.find('prefix-worker'));
  assert.equal(h.s.completionWork.reading, catchingUp);
  assert.equal(h.s.completionWork.version, workVersion);
  assert.deepEqual(changes, []);
  await h.s.activityMonitor.poll();
  assert.ok(h.s.completionWork.find('prefix-worker'));
  assert.equal(h.s.completionWork.state({ state: 'complete' }), 'working');
  assert.deepEqual(changes, []);
});

test('following a different session replaces history, and invalid ids or closed terminals cannot bind', async t => {
  const f = await fixture(t); await f.write('first', [user('first')]); await f.write('second', [user('second')]);
  const h = mainHarness(t, f);
  await h.context.followClaudeSession(h.project, h.s, 'first');
  await h.context.followClaudeSession(h.project, h.s, 'second');
  assert.deepEqual(h.s.conversation.list.map(entry => entry.text), ['second']); assert.equal(h.resets(), 2);
  assert.equal(await h.context.followClaudeSession(h.project, h.s, '../bad'), false);
  h.s.codexActive = false;
  assert.equal(await h.context.followClaudeSession(h.project, h.s, 'first'), false);
  h.sessions.delete('terminal');
  assert.equal(await h.context.followClaudeSession(h.project, h.s, 'first'), false);
});

test('a delayed Claude A read cannot clear catching-up state after A to B to A rebinding', async t => {
  const f = await fixture(t), h = mainHarness(t, f), tails = [];
  h.s.completionWork = new (require('../electron/completion-work.cjs').CompletionWork)();
  t.after(() => h.s.completionWork.reset());
  h.context.TranscriptTail = class {
    constructor(filename, options) { this.filename = filename; this.options = options; tails.push(this); options.onHistory(false); }
    read() { return new Promise(resolve => { this.resolve = resolve; }); }
  };
  h.context.monitorActivity = read => ({ poll: read, stop() {} });
  const follow = sessionId => h.context.followClaude(h.project, h.s, { sessionId, transcriptPath: path.join(f.folder, `${sessionId}.jsonl`) });
  follow('a'); const old = h.s.activityMonitor.poll();
  follow('b'); follow('a');
  h.s.completionWork.start('current-worker', Date.now());
  const version = h.s.completionWork.version;
  tails[0].options.onHistory(true);
  tails[0].options.onWorkRecord(user('stale prompt'));
  tails[0].resolve(true); assert.equal(await old, null);
  assert.equal(tails[0].options.isCurrent(), false); assert.equal(tails[2].options.isCurrent(), true);
  assert.equal(h.s.completionWork.reading, true); assert.equal(h.s.completionWork.version, version);
  assert.ok(h.s.completionWork.find('current-worker')); assert.equal(h.s.conversation.list.length, 0);
});

test('SessionStart after clear/resume and process exit retire old background work without success or rearming', async t => {
  const { CompletionWork } = require('../electron/completion-work.cjs');
  const f = await fixture(t), h = activityHarness(t, f), changes = [];
  for (const id of ['first', 'cleared', 'resumed']) await f.write(id, []);
  h.s.completionWork = new CompletionWork(); t.after(() => h.s.completionWork.reset());
  h.store.expectCompletion = (_id, value = true) => changes.push(value);
  h.store.complete = () => assert.fail('switching a session cannot grant completion');
  const bind = async id => {
    h.context.claudeActivity(h.project, h.s, { state: 'session', sessionId: id, eventId: `${id}:start`, transcriptPath: path.join(f.folder, `${id}.jsonl`) });
    await h.s.activityMonitor.poll();
  };
  await bind('first'); h.s.completionWork.start('old', Date.now());
  await bind('first'); assert.equal(h.s.completionWork.tasks.size, 1, 'same-session hooks keep outstanding tasks');
  await bind('cleared'); assert.equal(h.s.completionWork.tasks.size, 0);
  h.s.completionWork.start('cleared-worker', Date.now());
  await bind('resumed'); assert.equal(h.s.completionWork.tasks.size, 0);
  h.s.completionWork.start('resumed-worker', Date.now());
  h.context.onEvent({ projectId: h.s.terminalId, sessionKey: h.s.sessionKey, type: 'codex-exited', exitCode: 0 });
  assert.equal(h.s.completionWork.tasks.size, 0); assert.equal(h.s.codexActive, false); assert.equal(h.s.activitySnapshot, null);
  assert.deepEqual(changes, [false, false, false]);
});

test('session IPC lists Codex conversations its own way and only follows active local Claude terminals', async t => {
  const f = await fixture(t); await f.write('current', [user('current')]); await f.write('other', [user('other')]);
  const h = mainHarness(t, f), handlers = {};
  h.s.claudeSessionId = 'current';
  require('../electron/features/agents/ipc.cjs').registerAgentsIpc({ handle: (name, handler) => { handlers[name] = handler; },
    findProject: () => h.project, getSession: id => h.sessions.get(id), getRestoreCwd: id => h.context.store.findTerminal(id)?.record.restore?.cwd,
    followClaudeSession: (...args) => h.context.followClaudeSession(...args), listClaudeSessions: (cwd, id) => listClaudeSessions(cwd, id, f.home),
    listCodexSessions: async (cwd, id) => [{ id: 'codex-other', cwd, current: id }] });
  assert.deepEqual((await handlers['terminal:agentSessions']('terminal')).map(item => item.id), ['other']);
  h.s.claudeSessionId = null; h.restore.threadId = 'current';
  assert.equal((await handlers['terminal:agentSessions']('terminal')).length, 2, 'an old restore id is not the current fresh session');
  assert.equal(await handlers['terminal:followAgentSession']('terminal', 'other'), true);
  h.s.agent = 'codex'; h.s.rootThreadId = 'codex-current';
  assert.deepEqual((await handlers['terminal:agentSessions']('terminal')).map(item => [item.id, item.current]), [['codex-other', 'codex-current']], 'Codex lists its own, leaving out the one it is in');
  assert.equal(await handlers['terminal:followAgentSession']('terminal', 'other'), false);
  h.s.agent = 'claude'; h.project.kind = 'ssh';
  assert.equal((await handlers['terminal:agentSessions']('terminal')).length, 0);
  assert.equal(await handlers['terminal:followAgentSession']('terminal', 'other'), false);
});
