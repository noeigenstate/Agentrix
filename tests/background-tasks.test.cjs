const { loadWithStubs } = require('./helpers/load-with-stubs.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const capture = require('./fixtures/claude-user-round-background.json');
const modulePath = '../electron/features/agents/background-tasks.cjs';

function hostFeed(t, { kind = 'local', noteClaudeFastMode } = {}) {
  const path = require('node:path');
  const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
  const { createClaudeActivity } = require('../electron/features/terminal-events/claude-activity.cjs');
  const calls = new AgentCalls({ terminalId: 'terminal-1', local: false, now: () => 10000 }); t.after(() => calls.dispose());
  const root = path.resolve('synthetic-claude-home'), project = { id: 'project', path: root, kind };
  let tail, read, armed = 0, remoteRecords = [];
  const s = { terminalId: 'terminal-1', agent: 'claude', cliActive: true, promptQueue: { finishedAt: 0 },
    conversation: { beginHistory() {}, endHistory() {}, reset() {} }, actions: { reset() {} }, usage: { reset() {} },
    completionWork: { record() {}, reset: () => false }, terminal: { request: async () => ({ records: remoteRecords.splice(0), historyDone: true }) } };
  const deps = { sessions: new Map([['terminal-1', s]]), store: { expectCompletion() { armed++; } },
    callsOf: () => calls, claudeConfigDir: () => root, prepareReading: async () => {}, usageHistory() {}, noteClaudeFastMode,
    TranscriptTail: class {
      constructor(filename, options) { this.filename = filename; this.options = options; tail = this; this.records = []; this.buffer = ''; this.offset = 0; this.fileSize = 0; }
      async read(deliver) { for (const record of this.records.splice(0)) deliver(record); }
    },
    monitorActivity: reader => { read = reader; return { poll: reader, stop() {} }; }, readEvery: () => 250,
    claudeConversation() {}, describeActions() {}, claudeRecord() {}, noteSettings() {}, applyActivity() {} };
  const activity = createClaudeActivity(deps);
  const follow = id => activity.followClaude(project, s, { sessionId: id, transcriptPath: kind === 'ssh' ? '/project/' + id + '.jsonl' : path.join(root, id + '.jsonl') });
  follow('provider');
  return { calls, s, follow, tail: () => tail, historical: record => tail.options.onWorkRecord(record),
    live: async record => { (kind === 'ssh' ? remoteRecords : tail.records).push(record); await read(); }, armed: () => armed,
    shown: () => calls.usage?.(null)?.background || [] };
}

test('the host feeds historical workOnly and live Claude records into background usage without rearming completion', async t => {
  const host = hostFeed(t);
  host.historical(tool('Bash', 'launch', { command: 'node background.cjs', run_in_background: true }));
  assert.equal(host.shown().length, 1); assert.equal(host.shown()[0].terminalId, 'terminal-1');
  await host.live(result('launch', { backgroundTaskId: 'shell', stdout: 'inline output', stderr: '' }));
  assert.deepEqual(host.shown()[0].tail, ['inline output'], 'main publishes the contract\'s tail?: string[]');
  await host.live(notice('shell'));
  assert.equal(host.shown()[0].state, 'done'); assert.equal(host.shown()[0].endedAt, 2000);
  assert.equal(host.armed(), 0); assert.equal(host.s.cliActive, true);
});

test('a new transcript binding resets background usage and ignores the previous reader while preserving live delivery', async t => {
  const host = hostFeed(t);
  host.historical(tool('Bash', 'launch', { command: 'node old.cjs', run_in_background: true }));
  assert.equal(host.shown().length, 1);
  const previous = host.tail(); host.follow('other-provider');
  assert.deepEqual(host.shown(), []);
  previous.options.onWorkRecord(tool('Bash', 'stale', { command: 'node stale.cjs', run_in_background: true }));
  assert.deepEqual(host.shown(), []);
  host.historical(tool('Bash', 'launch', { command: 'node new.cjs', run_in_background: true }, 3000));
  assert.equal(host.shown()[0].command, 'node new.cjs');
  await host.live(result('launch', { backgroundTaskId: 'new-shell' }, 3100));
  await host.live(notice('new-shell', 3200));
  assert.equal(host.shown()[0].endedAt, 3200); assert.equal(host.armed(), 0);
});
const stamp = at => new Date(at).toISOString();

test('local fast-mode refusals survive restart and ON clears them even across older replays', async t => {
  const os = require('node:os'), path = require('node:path');
  const { WorkspaceStore } = require('../electron/state.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-fast-refusal-')), file = path.join(dir, 'workspace.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let store = new WorkspaceStore(file);
  const noteClaudeFastMode = echo => store.recordClaudeFastMode(echo);
  const local = hostFeed(t, { noteClaudeFastMode }), ssh = hostFeed(t, { kind: 'ssh', noteClaudeFastMode });
  const output = (words, at) => ({ type: 'user', timestamp: stamp(at), message: { content: '<local-command-stdout>' + words + '</local-command-stdout>' } });
  const reason = 'Fast mode requires usage credits · /usage-credits to turn them on';
  const refusal = output('Fast mode unavailable: ' + reason, 1000);
  await ssh.live(refusal);
  assert.equal(store.claudeFastMode, null);
  await local.live(refusal);
  store = new WorkspaceStore(file);
  assert.deepEqual(store.claudeFastMode, { at: 1000, reason });
  await ssh.live(output('Fast mode ON', 2000));
  assert.equal(store.claudeFastMode.reason, reason);
  await local.live(output('Fast mode OFF', 2000));
  assert.equal(store.claudeFastMode.reason, reason);
  await local.live(output('Fast mode unavailable: Disabled by your organization', 2500));
  assert.equal(store.claudeFastMode.reason, 'Disabled by your organization');
  await local.live(output('Fast mode ON', 3000));
  store = new WorkspaceStore(file);
  local.historical(refusal);
  assert.deepEqual(store.claudeFastMode, { at: 3000, reason: null });
  assert.equal(local.armed(), 0);
});
const tool = (name, id, input, at = 1000) => ({ type: 'assistant', timestamp: stamp(at), message: { content: [{ type: 'tool_use', name, id, input }] } });
const result = (id, toolUseResult, at = 1100, { error = false, content = '' } = {}) => ({ type: 'user', timestamp: stamp(at), toolUseResult,
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content }] } });
function notice(id, at = 2000, { toolId = '', status = 'completed', type = 'queue-operation', operation = 'enqueue' } = {}) {
  const content = `<task-notification><task-id>${id}</task-id>${toolId ? `<tool-use-id>${toolId}</tool-use-id>` : ''}<status>${status}</status><output-file><home>/tasks/output.txt</output-file></task-notification>`;
  return { type, timestamp: stamp(at), ...(type === 'queue-operation' ? { content, operation } : { isMeta: true, message: { content } }) };
}
function fixture(terminalId = 'terminal-1') {
  // Load inside each case so the baseline reports every missing behavior, rather than one file-load failure.
  const { BackgroundTasks } = require(modulePath);
  let now = 10000;
  const tasks = new BackgroundTasks(terminalId, { now: () => now });
  return { tasks, clock: at => { now = at; } };
}
function launch(tasks, id = 'launch', taskId = 'shell', at = 1000) {
  tasks.apply(tool('Bash', id, { command: `node ${id}.cjs`, run_in_background: true }, at));
  tasks.apply(result(id, { backgroundTaskId: taskId, stdout: '', stderr: '' }, at + 1));
}

test('the real 2.1.312 transcript keeps Bash task identities and finishes at notification enqueue with unknown exit codes', () => {
  const { tasks, clock } = fixture();
  clock(Date.parse(capture.records.at(-1).timestamp));
  for (const record of capture.records) tasks.apply(record);
  assert.deepEqual(tasks.snapshot(), [
    { id: 'id-005', command: 'node check.cjs', terminalId: 'terminal-1', startedAt: Date.parse('2026-10-28T12:27:34.343Z'), state: 'done', exitCode: null, endedAt: Date.parse('2026-10-28T12:45:42.837Z') },
    { id: 'id-016', command: 'node check.cjs', terminalId: 'terminal-1', startedAt: Date.parse('2026-10-28T12:32:49.985Z'), state: 'done', exitCode: null, endedAt: Date.parse('2026-10-28T12:40:38.387Z') },
  ]);
  for (const record of capture.records) assert.equal(tasks.apply(record), false, 'the same capture is idempotent');
});

test('background launch acknowledgments create one stable row and never count as output or completion', () => {
  for (const structured of [true, false]) {
    const { tasks } = fixture();
    const start = tool('Bash', 'launch', { command: 'node replay.cjs --all', run_in_background: true });
    assert.equal(tasks.apply(start), true);
    assert.equal(tasks.apply(start), false);
    assert.equal(tasks.apply(result('launch', structured ? { backgroundTaskId: 'shell', stdout: '', stderr: '' } : {}, 1100,
      { content: 'Command running in background with ID: shell. Output is being written to: <home>/tasks/output.txt' })), false);
    assert.deepEqual(tasks.snapshot(), [{ id: 'launch', command: 'node replay.cjs --all', terminalId: 'terminal-1', startedAt: 1000, state: 'running', exitCode: null }]);
    tasks.apply(notice('shell'));
    assert.equal(tasks.snapshot()[0].state, 'done');
  }
});

test('a foreground Bash becomes a background row only when its own receipt records a background task ID', () => {
  const { tasks } = fixture();
  tasks.apply(tool('Bash', 'foreground', { command: 'node quick.cjs' }));
  tasks.apply(result('foreground', { stdout: 'finished', stderr: '' }));
  tasks.apply(tool('Bash', 'timeout', { command: 'node slow.cjs' }, 1200));
  assert.deepEqual(tasks.snapshot(), []);
  tasks.apply(result('timeout', { backgroundTaskId: 'shell', stdout: 'first output', stderr: '' }, 1300));
  assert.deepEqual(tasks.snapshot(), [{ id: 'timeout', command: 'node slow.cjs', terminalId: 'terminal-1', startedAt: 1200,
    state: 'running', exitCode: null, tail: ['first output'], lastOutputAt: 1300 }]);
});

test('BashOutput and TaskOutput update only the matching shell and require a successful terminal receipt to finish it', () => {
  // Compatibility cases mirror AgentCalls' existing contract; these are not real-CLI captures.
  for (const name of ['BashOutput', 'TaskOutput']) {
    const { tasks } = fixture();
    launch(tasks); launch(tasks, 'other', 'other-shell');
    const poll = (id, target, status, at, error = false, returnedTarget = target) => {
      tasks.apply(tool(name, id, name === 'BashOutput' ? { bash_id: target } : { task_id: target }, at - 1));
      return tasks.apply(result(id, name === 'BashOutput' ? { status, stdout: 'line', stderr: '', task_id: returnedTarget }
        : { task: { task_id: returnedTarget, status }, stdout: 'line', stderr: '' }, at, { error }));
    };
    assert.equal(poll('unknown', 'missing', 'completed', 1200), false);
    assert.equal(poll('mismatch', 'shell', 'completed', 1250, false, 'other-shell'), false);
    assert.equal(poll('running', 'shell', 'running', 1300), true);
    assert.equal(poll('failed-read', 'shell', 'completed', 1400, true), false);
    assert.equal(tasks.snapshot()[0].state, 'running');
    assert.equal(poll('ended', 'shell', 'completed', 1500), true);
    assert.deepEqual(tasks.snapshot().map(({ id, state, exitCode, endedAt }) => ({ id, state, exitCode, endedAt })), [
      { id: 'launch', state: 'done', exitCode: null, endedAt: 1500 },
      { id: 'other', state: 'running', exitCode: null, endedAt: undefined },
    ]);
  }
});

test('KillShell and TaskStop requests leave a task running until a successful matching stop receipt arrives', () => {
  for (const name of ['KillShell', 'TaskStop']) {
    const { tasks } = fixture();
    launch(tasks); launch(tasks, 'other', 'other-shell');
    const input = name === 'KillShell' ? { shell_id: 'shell' } : { task_id: 'shell' };
    tasks.apply(tool(name, 'failed-stop', input, 1200));
    assert.equal(tasks.snapshot()[0].state, 'running');
    tasks.apply(result('failed-stop', {}, 1300, { error: true }));
    assert.equal(tasks.snapshot()[0].state, 'running');
    tasks.apply(tool(name, 'stop', input, 1400));
    tasks.apply(result('stop', { task_id: 'shell', task_type: 'local_bash', message: 'Task stopped.' }, 1500));
    assert.deepEqual(tasks.snapshot().map(entry => entry.state), ['done', 'running']);
    assert.equal(tasks.snapshot()[0].endedAt, 1500);
    assert.equal(tasks.snapshot()[0].exitCode, null, 'a successful stop does not prove an exit code');
    assert.equal(tasks.apply(result('stop', { task_id: 'shell' }, 1600)), false);
  }
});

test('completion notifications finish one task once across queue, user and attachment receipts without inventing exit codes', () => {
  for (const status of ['completed', 'failed', 'killed', 'stopped']) {
    const { tasks } = fixture();
    launch(tasks); launch(tasks, 'other', 'other-shell');
    assert.equal(tasks.apply(notice('shell', 2000, { toolId: 'launch', status })), true);
    assert.equal(tasks.apply(notice('shell', 2100, { status, type: 'user' })), false);
    const delivered = notice('shell', 2200, { status });
    assert.equal(tasks.apply({ type: 'attachment', timestamp: delivered.timestamp, attachment: { type: 'queued_command', prompt: [{ type: 'text', text: delivered.content }] } }), false);
    assert.equal(tasks.snapshot()[0].endedAt, 2000);
    assert.equal(tasks.snapshot()[0].exitCode, null);
    assert.equal(tasks.snapshot()[1].state, 'running');
  }
});

test('a completion before launch acknowledgment is retained until the tool and task identities can be joined', () => {
  for (const beforeLaunch of [true, false]) {
    const { tasks } = fixture();
    const start = tool('Bash', 'launch', { command: 'node replay.cjs', run_in_background: true });
    if (!beforeLaunch) tasks.apply(start);
    tasks.apply(notice('shell', 2000));
    if (beforeLaunch) tasks.apply(start);
    tasks.apply(result('launch', { backgroundTaskId: 'shell', stdout: '', stderr: '' }, 1100));
    assert.deepEqual(tasks.snapshot().map(entry => [entry.id, entry.state, entry.startedAt, entry.endedAt]), [['launch', 'done', 1000, 2000]]);
  }
});

test('conflicting notification identities cannot finish another shell even after the named launch row retires', () => {
  const { tasks, clock } = fixture();
  launch(tasks); launch(tasks, 'other', 'other-shell');
  tasks.apply(notice('other-shell', 2000, { toolId: 'launch' }));
  assert.deepEqual(tasks.snapshot().map(entry => entry.state), ['running', 'running']);
  tasks.apply(notice('shell', 2100, { toolId: 'launch' }));
  clock(2100 + 30 * 60 * 1000 + 1);
  assert.deepEqual(tasks.snapshot().map(entry => entry.id), ['other']);
  tasks.apply(notice('other-shell', 2200, { toolId: 'launch' }));
  assert.equal(tasks.snapshot()[0].state, 'running');
});

test('a stale end before launch cannot conceal a later valid completion received before task-ID binding', () => {
  const { tasks } = fixture();
  tasks.apply(notice('shell', 900));
  tasks.apply(tool('Bash', 'launch', { command: 'node replay.cjs', run_in_background: true }, 1000));
  tasks.apply(notice('shell', 2000));
  tasks.apply(notice('shell', 2100, { type: 'user' }));
  tasks.apply(result('launch', { backgroundTaskId: 'shell', stdout: '', stderr: '' }, 1100));
  assert.equal(tasks.snapshot()[0].state, 'done');
  assert.equal(tasks.snapshot()[0].endedAt, 2000);
});

test('the same feed accepts workOnly historical launches and live overlap without dropping or reviving a task', () => {
  const { tasks, clock } = fixture();
  const records = capture.records;
  const ended = records.find(record => record.type === 'queue-operation' && record.content?.includes('<task-id>id-008</task-id>'));
  clock(Date.parse(ended.timestamp));
  for (const record of records.slice(0, 2)) tasks.apply({ ...record, workOnly: true });
  assert.equal(tasks.snapshot()[0].state, 'running', 'the launch can lie before the host display window');
  tasks.apply(ended);
  for (const record of records.slice(0, 2)) tasks.apply(record);
  assert.equal(tasks.snapshot().length, 1);
  assert.equal(tasks.snapshot()[0].endedAt, Date.parse(ended.timestamp));
  clock(Date.parse(ended.timestamp) + 30 * 60 * 1000 + 1);
  assert.deepEqual(tasks.snapshot(), []);
  for (const record of records.slice(0, 2)) tasks.apply({ ...record, workOnly: true });
  assert.deepEqual(tasks.snapshot(), [], 'retired completed identities cannot become running again');
});

test('terminal trackers isolate identical tool and task IDs and snapshots cannot mutate their entries', () => {
  const left = fixture('terminal-1').tasks, right = fixture('terminal-2').tasks;
  launch(left); launch(right);
  left.apply(notice('shell'));
  assert.equal(left.snapshot()[0].state, 'done');
  assert.equal(right.snapshot()[0].state, 'running');
  const copy = right.snapshot();
  copy[0].state = 'done'; copy[0].command = 'changed'; copy.pop();
  assert.equal(right.snapshot()[0].command, 'node launch.cjs');
  assert.equal(right.snapshot()[0].terminalId, 'terminal-2');
  assert.equal(right.snapshot()[0].state, 'running');
});

test('inline output is published as an array of its last 200 lines and only a changed output observation advances lastOutputAt', () => {
  const { tasks } = fixture();
  const output = Array.from({ length: 250 }, (_, index) => `line ${index + 1}`).join('\r\n');
  tasks.apply(tool('Bash', 'launch', { command: 'node replay.cjs', run_in_background: true }));
  tasks.apply(result('launch', { backgroundTaskId: 'shell', stdout: output, stderr: '' }, 1100));
  const entry = tasks.snapshot()[0];
  assert.ok(Array.isArray(entry.tail), 'tail?: string[], one line each');
  assert.equal(entry.tail.length, 200);
  assert.equal(entry.tail[0], 'line 51');
  assert.equal(entry.tail.at(-1), 'line 250');
  entry.tail.pop();
  assert.equal(tasks.snapshot()[0].tail.length, 200, 'a snapshot is a copy');
  assert.equal(entry.lastOutputAt, 1100);
  for (const [id, at, stdout, stderr] of [['same', 1200, output, ''], ['empty', 1300, '', ''], ['new', 1400, 'new output', 'a warning']]) {
    tasks.apply(tool('BashOutput', id, { bash_id: 'shell' }, at - 1));
    tasks.apply(result(id, { status: 'running', stdout, stderr }, at));
    assert.equal(tasks.snapshot()[0].lastOutputAt, id === 'new' ? 1400 : 1100);
  }
  assert.deepEqual(tasks.snapshot()[0].tail, ['new output', 'a warning']);
  tasks.apply(tool('BashOutput', 'older', { bash_id: 'shell' }, 1049));
  tasks.apply(result('older', { status: 'running', stdout: 'stale output' }, 1050));
  assert.deepEqual(tasks.snapshot()[0].tail, ['new output', 'a warning']);
});

test('idle, Stop, elapsed time and assistant claims cannot finish a shell or fabricate a last output time', () => {
  const { tasks, clock } = fixture();
  launch(tasks);
  tasks.apply({ type: 'assistant', timestamp: stamp(2000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The script completed with exit code 0.' }] } });
  tasks.apply({ type: 'system', timestamp: stamp(2100), subtype: 'stop_hook_summary' });
  tasks.apply(notice('shell', 2200, { status: 'running' }));
  clock(48 * 60 * 60 * 1000);
  assert.deepEqual(tasks.snapshot(), [{ id: 'launch', command: 'node launch.cjs', terminalId: 'terminal-1', startedAt: 1000, state: 'running', exitCode: null }]);
});

test('completed history keeps the newest ten by endedAt and expires after thirty minutes while running tasks stay', () => {
  const { tasks, clock } = fixture();
  launch(tasks, 'live', 'live-shell');
  for (let index = 0; index < 12; index++) launch(tasks, `job-${index}`, `shell-${index}`);
  // Delivery order differs from completion order; a replay must not push an older completion into the newest ten.
  for (let index = 11; index >= 0; index--) tasks.apply(notice(`shell-${index}`, 2000 + index));
  assert.equal(tasks.snapshot().length, 11);
  assert.deepEqual(tasks.snapshot().filter(entry => entry.state === 'done').map(entry => entry.id), Array.from({ length: 10 }, (_, index) => `job-${index + 2}`));
  clock(2011 + 30 * 60 * 1000);
  assert.deepEqual(tasks.snapshot().map(entry => entry.id), ['live', 'job-11']);
  tasks.apply(notice('shell-11', 2012, { type: 'user' }));
  clock(2011 + 30 * 60 * 1000 + 1);
  assert.deepEqual(tasks.snapshot().map(entry => entry.id), ['live']);
  launch(tasks, 'job-0', 'shell-0');
  assert.deepEqual(tasks.snapshot().map(entry => entry.id), ['live']);
});

test('foreground tools, child transcripts, synthetic summaries and malformed records create no background shell rows', () => {
  const { tasks } = fixture();
  const start = tool('Bash', 'ignored', { command: 'node replay.cjs', run_in_background: true });
  for (const record of [null, {}, { ...start, timestamp: 'invalid' }, { ...start, isSidechain: true }, { ...start, parent_tool_use_id: 'parent' },
    { ...start, isMeta: true }, { ...start, isCompactSummary: true }, { ...start, message: { ...start.message, model: '<synthetic>' } },
    tool('Agent', 'worker', { run_in_background: true }), tool('Bash', 'empty', { run_in_background: true }),
    tool('Bash', 'quick', { command: 'node quick.cjs' }), result('unknown', { backgroundTaskId: 'shell' }), notice('unknown')]) tasks.apply(record);
  assert.deepEqual(tasks.snapshot(), []);
  launch(tasks);
  tasks.apply(result('launch', { backgroundTaskId: 'shell', stdout: 'duplicate output' }, 3000));
  assert.equal(tasks.snapshot()[0].lastOutputAt, undefined);
  tasks.apply(notice('shell', 900));
  assert.equal(tasks.snapshot()[0].state, 'running', 'an end before the launch is not its receipt');
});

test('reset changes the transcript binding and clears aliases, receipts and retired identities', () => {
  const { tasks } = fixture();
  launch(tasks); tasks.apply(notice('shell')); tasks.reset();
  assert.deepEqual(tasks.snapshot(), []);
  launch(tasks, 'launch', 'new-shell', 3000);
  tasks.apply(notice('shell', 4000));
  assert.equal(tasks.snapshot()[0].state, 'running');
  tasks.apply(notice('new-shell', 4100));
  assert.equal(tasks.snapshot()[0].endedAt, 4100);
});

test('attach exposes background entries on an existing or null usage snapshot without mutating either input', () => {
  const { attach } = require(modulePath);
  const { tasks } = fixture();
  launch(tasks);
  const entries = tasks.snapshot();
  const usage = Object.freeze({ provider: 'Claude Code', calls: [{ id: 'worker' }], limits: [], context: null });
  const joined = attach(usage, entries);
  assert.deepEqual(joined, { ...usage, background: entries });
  assert.equal(joined.calls, usage.calls);
  joined.background[0].state = 'done';
  assert.equal(entries[0].state, 'running');
  assert.equal(tasks.snapshot()[0].state, 'running');
  assert.deepEqual(attach(null, []), { background: [] });
  assert.equal(Object.hasOwn(usage, 'background'), false);
});

test('transcript output paths are never opened and task observation has no filesystem or process dependencies', () => {
  const { BackgroundTasks: LoadedTasks } = loadWithStubs(require.resolve(modulePath), name => assert.fail(`unexpected dependency: ${name}`));
  const tasks = new LoadedTasks('terminal-1', { now: () => 10000 });
  tasks.apply(tool('Bash', 'launch', { command: 'node replay.cjs', run_in_background: true }));
  tasks.apply(result('launch', { backgroundTaskId: 'shell', stdout: '', stderr: '', rawOutputPath: '<home>/private.txt', persistedOutputPath: '<home>/another-private.txt' }));
  tasks.apply(notice('shell'));
  assert.equal(tasks.snapshot()[0].state, 'done');
  assert.equal(tasks.snapshot()[0].tail, undefined);
});
