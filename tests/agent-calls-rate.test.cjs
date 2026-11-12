const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { UsageMeter } = require('../electron/features/agents/agent-usage.cjs');
const { emptyRate } = require('../electron/features/agents/token-rate.cjs');
const { HISTORY_WINDOW } = require('../electron/transcript-window.cjs');

const at = seconds => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const lines = records => records.map(record => JSON.stringify(record) + '\n').join('');
const fixture = name => fs.readFile(path.join(__dirname, 'fixtures', name), 'utf8');
const jsonFixture = async name => (await fixture(name)).trim().split('\n').map(JSON.parse);
const use = (id, name, input, cwd) => ({ type: 'assistant', timestamp: at(0), cwd, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, toolUseResult) => ({ type: 'user', timestamp: at(8), toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Placeholder receipt.' }] } });
const notice = (id, status = 'completed') => ({ type: 'user', timestamp: at(9), message: { content: `<task-notification><tool-use-id>${id}</tool-use-id><status>${status}</status></task-notification>` } });
const expected = (outputTokens, activeMs, samples, seconds, partial = false) => ({ outputTokens, activeMs, samples, updatedAt: Date.parse(at(seconds)), partial });

async function workspace(t, options) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-worker-rate-'));
  const folder = path.join(home, 'subagents');
  await fs.mkdir(folder);
  const calls = new AgentCalls(options); calls.setFolder(folder);
  t.after(async () => { calls.reset(); await fs.rm(home, { recursive: true, force: true }); });
  return { home, folder, calls };
}
async function claudeFile(folder, id, records, toolUseId = id) {
  const filename = path.join(folder, `agent-${id}.jsonl`);
  await fs.writeFile(filename, lines(records));
  if (toolUseId) await fs.writeFile(path.join(folder, `agent-${id}.meta.json`), JSON.stringify({ toolUseId, model: 'sonnet' }));
  return filename;
}
test('main Opus and a running Opus child keep separate rates, resolved grouping and exact tasks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { folder, home, calls } = await workspace(t);
  const meter = new UsageMeter('claude', { codexHome: home }); meter.calls = calls;
  const main = await jsonFixture('claude-token-rate.jsonl'), child = await jsonFixture('claude-subagent-token-rate.jsonl');
  for (const record of main) meter.apply(record);
  const mainRate = meter.snapshot().rate;
  const filename = await claudeFile(folder, 'child', child.slice(0, 1), 'worker');
  const open = fs.open, positions = [];
  t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args), read = file.read.bind(file);
    file.read = (...readArgs) => { if (args[0] === filename) positions.push(readArgs[3]); return read(...readArgs); };
    return file;
  });
  meter.apply(use('worker', 'Agent', { model: 'sonnet', description: 'Exact parser inspection', run_in_background: true }));
  await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, emptyRate(false));
  await fs.appendFile(filename, lines(child.slice(1, 3)));
  t.mock.timers.tick(2500); await calls.work;
  const group = calls.snapshot()[0];
  assert.equal(group.model, 'claude-opus-5-5', 'the actual child model replaces its requested alias');
  assert.deepEqual(group.rate, expected(80, 3000, 1, 4));
  assert.deepEqual(group.items, [{ id: 'agent:worker', state: 'running', role: '通用', title: 'Exact parser inspection', startedAt: Date.parse(at(0)), endedAt: null, viewable: true, hidden: false }]);
  assert.deepEqual(group.tasks, ['Exact parser inspection']);
  assert.ok(positions[1] > 0, 'the next child read starts at its retained byte offset');
  assert.deepEqual(meter.snapshot().rate, mainRate);
  assert.equal(meter.snapshot().model, 'claude-opus-5-5');
  await fs.appendFile(filename, lines(child.slice(3)));
  meter.apply(notice('worker', 'killed')); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, expected(120, 5000, 2, 7), 'cancellation drains final records');
  assert.equal(calls.snapshot()[0].items[0].state, 'reviewing');
  assert.equal(calls.timer, null);
});

test('groups sum worker tokens and durations, including overlap, while preserving each task and state', async t => {
  const { folder, calls } = await workspace(t);
  const records = await jsonFixture('claude-subagent-token-rate.jsonl');
  await claudeFile(folder, 'a', records);
  const second = structuredClone(records.slice(0, 2));
  second[0].timestamp = at(2); second[1].timestamp = at(3); second[1].message.usage.output_tokens = 20;
  await claudeFile(folder, 'b', second);
  for (const id of ['a', 'b']) calls.apply(use(id, 'Agent', { model: 'sonnet', description: `Exact ${id}`, run_in_background: true }));
  await calls.work; calls.apply(notice('a')); await calls.work;
  assert.equal(calls.snapshot().length, 1);
  assert.deepEqual(calls.snapshot()[0].rate, expected(140, 6000, 3, 7));
  assert.deepEqual(calls.snapshot()[0].items, [
    { id: 'agent:b', state: 'running', role: '通用', title: 'Exact b', startedAt: Date.parse(at(0)), endedAt: null, viewable: true, hidden: false },
    { id: 'agent:a', state: 'reviewing', role: '通用', title: 'Exact a', startedAt: Date.parse(at(0)), endedAt: Date.parse(at(9)), viewable: true, hidden: false },
  ]);
  calls.apply(use('unreadable', 'Agent', { model: 'claude-opus-5-5', description: 'Exact unreadable' })); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, expected(140, 6000, 3, 7, true), 'the readable members still sum; the unreadable one marks the sum partial');
  assert.deepEqual(calls.snapshot()[0].items.map(item => item.id), ['agent:unreadable', 'agent:b', 'agent:a']);
  assert.equal(calls.calls.get('unreadable').rate, null, 'the unreadable member itself keeps no rate');
});

test('a group with no readable member has no rate, and one with only waiting members waits', async t => {
  const { folder, calls } = await workspace(t);
  calls.apply(use('first', 'Agent', { model: 'sonnet', description: 'Exact first' }));
  calls.apply(use('second', 'Agent', { model: 'sonnet', description: 'Exact second' })); await calls.work;
  assert.equal(calls.snapshot()[0].rate, null);
  const records = await jsonFixture('claude-subagent-token-rate.jsonl');
  await claudeFile(folder, 'third', records.slice(0, 1));
  calls.apply(use('third', 'Agent', { model: 'sonnet', description: 'Exact third' })); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, emptyRate(true), 'a member without a finished reply contributes no figure');
});

// main.cjs from followClaude to the end of startUsage, with stand-ins for what lies outside it.
function mainSlice(names) {
  const source = syncFs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const context = vm.createContext({ path, os, fs: syncFs, AgentCalls, UsageMeter, scheduleState() {}, scheduleUsageRollover() {}, send() {},
    createInterventions: () => ({}), prepareReading: async () => {}, TranscriptTail: class { constructor(filename) { this.filename = filename; } },
    monitorActivity: read => ({ poll: read, stop() {} }), stopUsageAccount() {}, claudeProvider: async () => null, refreshClaudeAccounts() {}, bindRemoteClaudeAccount() {}, ...names });
  vm.runInContext(source.slice(source.indexOf('function followClaude('), source.indexOf('async function resetTerminalCodex(')), context);
  return context;
}

test('a transcript bound before the meter exists keeps its sub-agents folder through startUsage', t => {
  // Synthetic absolute paths on every platform; nothing is read from them.
  const home = path.resolve('/synthetic-claude'), file = path.join(home, 'projects', 'project', 'session.jsonl');
  const s = { terminalId: 't', agent: 'claude', codexActive: true, recordRun() {} }, project = { id: 'p', kind: 'local', path: path.resolve('/synthetic-project') };
  const context = mainSlice({ sessions: new Map([['t', s]]), claudeConfigDir: () => home });
  context.followClaude(project, s, { sessionId: 'session', transcriptPath: file });
  const folder = path.join(home, 'projects', 'project', 'session', 'subagents');
  assert.equal(s.calls?.folder, folder, 'the hook binds the folder although no meter exists yet');
  context.startUsage(project, s, { cwd: project.path });
  t.after(() => s.calls.dispose());
  assert.equal(s.usage.calls, s.calls); assert.equal(s.calls.folder, folder);
});

// The id and the result as Claude Code 2.1.3xx's Agent tool reports a background launch, with placeholder values.
const REMOTE_ID = 'a0123456789abcdef';
const launched = id => result(id, { status: 'async_launched', isAsync: true, agentId: REMOTE_ID, description: 'Exact remote', resolvedModel: 'claude-opus-5-5', prompt: 'Placeholder prompt.', outputFile: '/tmp/placeholder.output' });

test('over SSH the running sub-agents the host named are asked for, and their compacted records give the local rate', async t => {
  const { folder, calls: local } = await workspace(t);
  await claudeFile(folder, REMOTE_ID, await jsonFixture('claude-subagent-ssh.jsonl'), 'toolu_launch');
  local.apply(use('toolu_launch', 'Agent', { model: 'opus', run_in_background: true })); await local.work;
  assert.deepEqual(local.snapshot()[0].rate, expected(75, 5000, 2, 8));
  assert.deepEqual(local.remoteSubagents(), [], 'a local terminal reads its own files');
  const calls = new AgentCalls({ local: false }), compact = await jsonFixture('claude-subagent-ssh.compact.jsonl');
  t.after(() => calls.dispose());
  calls.apply(use('toolu_launch', 'Agent', { model: 'opus', description: 'Exact remote', run_in_background: true }));
  assert.deepEqual(calls.remoteSubagents(), [], 'no id before the launch result names one');
  calls.apply(launched('toolu_launch'));
  assert.deepEqual(calls.remoteSubagents(), [REMOTE_ID]);
  assert.equal(calls.snapshot()[0].model, 'claude-opus-5-5'); assert.equal(calls.snapshot()[0].rate, null);
  calls.remoteRecords({ [REMOTE_ID]: { records: compact.slice(0, 3), reset: true, partial: false }, other: { records: compact, reset: true, partial: false } });
  assert.deepEqual(calls.snapshot()[0].rate, expected(45, 2000, 1, 3));
  calls.remoteRecords({ [REMOTE_ID]: { records: compact.slice(3), reset: false, partial: false } });
  assert.deepEqual(calls.snapshot()[0].rate, local.snapshot()[0].rate, 'the compacted records give the rate the full ones give');
  calls.remoteRecords({ [REMOTE_ID]: { records: compact.slice(3), reset: true, partial: true } });
  assert.deepEqual(calls.snapshot()[0].rate, emptyRate(true), 'a restart without the file start counts afresh, marked partial');
  calls.apply(notice('toolu_launch'));
  assert.deepEqual(calls.remoteSubagents(), [], 'an ended sub-agent is no longer asked for');
});

test('over SSH at most the newest 16 named sub-agents are asked for, and only ids the host can take', t => {
  const calls = new AgentCalls({ local: false }); t.after(() => calls.dispose());
  for (let index = 0; index < 20; index++) {
    calls.apply(use(`toolu_${index}`, 'Agent', { model: 'opus', run_in_background: true }));
    calls.apply(result(`toolu_${index}`, { status: 'async_launched', isAsync: true, agentId: `a${index}` }));
  }
  calls.apply(use('toolu_long', 'Agent', { model: 'opus', run_in_background: true }));
  calls.apply(result('toolu_long', { status: 'async_launched', isAsync: true, agentId: 'a'.repeat(101) }));
  assert.deepEqual(calls.remoteSubagents(), Array.from({ length: 16 }, (_, index) => `a${index + 4}`));
});

test('over SSH the poll asks for the running sub-agents and counts their records before a completion in the same answer', async t => {
  // Timestamps after the calls' own start, so the completion is a live one that is recorded.
  const shift = Date.now() + 60000 - Date.parse(at(0)), later = record => ({ ...record, timestamp: new Date(Date.parse(record.timestamp) + shift).toISOString() });
  const finished = [], requests = [], answers = [];
  const s = { terminalId: 't', agent: 'claude', codexActive: true, recordRun: (_call, event) => finished.push(event),
    conversation: { beginHistory() {}, endHistory() {}, reset() {} }, actions: { reset() {} },
    // A copy made here: what main builds belongs to the script context.
    terminal: { request: async (op, args) => { requests.push([op, JSON.parse(JSON.stringify(args))]); return answers.shift(); } } };
  const project = { id: 'p', kind: 'ssh', path: '/srv/project' }, file = '/srv/claude/projects/-srv-project/session.jsonl';
  const context = mainSlice({ sessions: new Map([['t', s]]), claudeConfigDir: () => assert.fail('SSH reads no local folder'),
    noteSettings: (session, _agent, record) => session.usage?.apply(record), claudeConversation() {}, describeActions() {}, claudeRecord: () => [] });
  context.startUsage(project, s, { cwd: project.path }); t.after(() => s.calls.dispose());
  context.followClaude(project, s, { sessionId: 'session', transcriptPath: file, sentAt: 900 });
  answers.push({ records: [use('toolu_launch', 'Agent', { model: 'opus', run_in_background: true }), launched('toolu_launch')].map(later), reset: true, historyDone: true });
  await s.activityMonitor.poll();
  assert.deepEqual(requests[0], ['claude-status', { path: file, since: 900 }], 'nothing is asked for before a sub-agent is named');
  const compact = await jsonFixture('claude-subagent-ssh.compact.jsonl');
  answers.push({ records: [later(notice('toolu_launch'))], reset: false, historyDone: true, subagents: { [REMOTE_ID]: { records: compact.map(later), reset: true, partial: false } } });
  await s.activityMonitor.poll();
  assert.deepEqual(requests[1][1].subagents, [REMOTE_ID]);
  assert.equal(finished.length, 1);
  const { model, outputTokens, activeMs } = finished[0];
  assert.deepEqual({ model, outputTokens, activeMs }, { model: 'claude-opus-5-5', outputTokens: 75, activeMs: 5000 });
});

test('child truncation, file rotation, partial lines and agentId rebinding reset only that worker', async t => {
  const { folder, calls } = await workspace(t);
  const records = await jsonFixture('claude-subagent-token-rate.jsonl');
  const filename = await claudeFile(folder, 'first', records, null);
  calls.apply(use('worker', 'Agent', { model: 'sonnet', run_in_background: true }));
  calls.apply(result('worker', { isAsync: true, agentId: 'first' })); await calls.work;
  assert.equal(calls.snapshot()[0].rate.samples, 2);
  await fs.writeFile(filename, lines(records.slice(0, 1)));
  calls.refresh('worker'); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, emptyRate(false));
  const body = lines(records.slice(1, 3)), split = body.length - 10;
  await fs.appendFile(filename, body.slice(0, split)); calls.refresh('worker'); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, expected(60, 2000, 1, 3));
  await fs.appendFile(filename, body.slice(split)); calls.refresh('worker'); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, expected(80, 3000, 1, 4));
  await fs.rename(filename, filename + '.old');
  const rotated = structuredClone(records); rotated[1].message.model = rotated[2].message.model = rotated[4].message.model = 'claude-haiku-5-5';
  await fs.writeFile(filename, lines(rotated)); calls.refresh('worker'); await calls.work;
  assert.equal(calls.snapshot()[0].model, 'claude-haiku-5-5');
  assert.deepEqual(calls.snapshot()[0].rate, expected(120, 5000, 2, 7));
  await claudeFile(folder, 'second', records.slice(0, 1), null);
  calls.apply(result('worker', { isAsync: true, agentId: 'second' })); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, emptyRate(false));
  assert.equal(calls.calls.get('worker').reader.filename, path.join(folder, 'agent-second.jsonl'));
});

test('bounded child history marks partial and ambiguous toolUseId metadata stays unbound', async t => {
  const { folder, calls } = await workspace(t);
  const records = await jsonFixture('claude-subagent-token-rate.jsonl');
  const filename = await claudeFile(folder, 'partial', records);
  await fs.writeFile(filename, 'x'.repeat(HISTORY_WINDOW + 1) + '\n' + lines(records));
  calls.apply(use('partial', 'Agent', { model: 'sonnet' })); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, expected(120, 5000, 2, 7, true));
  await claudeFile(folder, 'ambiguous-a', records, 'ambiguous');
  await claudeFile(folder, 'ambiguous-b', records, 'ambiguous');
  calls.apply(use('ambiguous', 'Agent', { model: 'haiku', description: 'Exact ambiguous' })); await calls.work;
  const group = calls.snapshot().find(group => group.model === 'haiku');
  assert.equal(group.rate, null); assert.equal(calls.calls.get('ambiguous').reader, null);
});

test('unreadable workers publish null and completed missing transcripts stop polling', async t => {
  const { folder, calls } = await workspace(t);
  const filename = await claudeFile(folder, 'worker', await jsonFixture('claude-subagent-token-rate.jsonl'));
  calls.apply(use('worker', 'Agent', { model: 'sonnet', run_in_background: true })); await calls.work;
  assert.equal(calls.snapshot()[0].rate.samples, 2);
  const open = fs.open;
  const mocked = t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args);
    if (args[0] === filename) file.stat = async () => { throw new Error('Placeholder read failure'); };
    return file;
  });
  calls.refresh('worker'); await calls.work;
  assert.equal(calls.snapshot()[0].rate, null);
  mocked.mock.restore();
  calls.apply(notice('worker')); await calls.work;
  calls.apply(use('missing', 'Agent', { model: 'haiku', run_in_background: true }));
  calls.apply(result('missing', { isAsync: true, agentId: 'missing-file' })); await calls.work;
  calls.apply(notice('missing', 'killed')); await calls.work;
  assert.equal(calls.timer, null);
  assert.equal(calls.snapshot().find(group => group.model === 'haiku').rate, null);
});

test('SSH calls never read local child, prompt, log or rollout files', async t => {
  const { folder, calls } = await workspace(t, { local: false });
  await claudeFile(folder, 'worker', await jsonFixture('claude-subagent-token-rate.jsonl'));
  const open = t.mock.method(fs, 'open');
  calls.apply(use('worker', 'Agent', { model: 'sonnet' }));
  await calls.work;
  assert.equal(open.mock.callCount(), 0);
  assert.ok(calls.snapshot().every(group => group.rate === null)); assert.equal(calls.timer, null);
  assert.ok(calls.snapshot().every(group => group.preparing === 0 && group.running === 1));
});
