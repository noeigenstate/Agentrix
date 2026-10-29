const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { WorkspaceStore } = require('../electron/state.cjs');
const { SubmissionTracker } = require('../electron/terminal-input.cjs');
const { registerTerminalIpc } = require('../electron/features/terminal/ipc.cjs');
const { ConversationLog, claudeConversation, codexConversation } = require('../electron/conversation.cjs');
const { PromptQueue, promptText } = require('../electron/prompt-queue.cjs');
const { resumeCommand, claudeResumeCommand } = require('../electron/session-restore.cjs');
const { isLocalAgentCommand } = require('../electron/agent-commands.cjs');
const { CompletionWork, LOST_WORK_TIMEOUT } = require('../electron/completion-work.cjs');
const { CodexActivityReader, monitorActivity } = require('../electron/codex-activity.cjs');
const { TranscriptTail } = require('../electron/agent-actions.cjs');

const main = syncFs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
async function harness(t, kind = 'local', agent = 'codex') {
  const scratch = path.resolve(__dirname, '../.test-output/bug-fixes-work/backend/unit-tmp');
  await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratch, 'lifecycle-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(path.join(directory, 'workspace.json'));
  const project = store.add(directory).project; project.kind = kind;
  const s = { terminalId: project.id, projectId: project.id, agent, codexActive: true, status: 'running',
    activitySince: 1000, activityInputAt: 0, submissions: new SubmissionTracker(),
    actions: { settle() {} }, gate: { input() {} } };
  const sessions = new Map([[s.terminalId, s]]);
  let now = 2000, alerts = 0, armings = 0;
  const expectCompletion = store.expectCompletion.bind(store);
  store.expectCompletion = (id, expected = true) => {
    const armed = project.completionArmed;
    expectCompletion(id, expected);
    if (!armed && project.completionArmed) armings++;
  };
  const context = vm.createContext({ sessions, store, summarizeTask: () => '', isLocalAgentCommand, promptText,
    notifyCompletion: () => alerts++, broadcast() {}, publishConversation() {}, refreshClaudeAccounts() {}, describeActions() {}, nativeSkillActions() {},
    memoryFolder: () => directory, memoryDir: () => directory, roundsOf: () => [], remember: async () => {},
    setTimeout: () => ({ unref() {} }), scrubProjectSkills: async () => {},
    followClaude() {}, followClaudeSession: async () => {}, resumeCommand, claudeResumeCommand,
    restorePlans: new Map(), Date: class extends Date { static now() { return now; } },
  });
  vm.runInContext(main.slice(main.indexOf('function applyActivity('), main.indexOf('function onEvent(')), context);
  Object.assign(context, { findProject: () => project, scheduleState() {}, randomUUID: require('node:crypto').randomUUID,
    s, project, id: s.terminalId, PromptQueue, CompletionWork, queueMicrotask });
  vm.runInContext(main.slice(main.indexOf('function nativeSessionEvent('), main.indexOf('function startTerminal(')), context);
  const setup = main.indexOf('  const refreshCompletion = () => {');
  vm.runInContext(main.slice(setup, main.indexOf('  // A prompt the agent', setup)), context);
  s.completionWork.now = s.promptQueue.now = () => now;
  t.after(() => { s.codexActive = false; s.promptQueue.reset(); s.completionWork.reset(); });
  vm.runInContext(main.slice(main.indexOf('async function resumeAfterPrompt('), main.indexOf('function remoteFor(')), context);
  // Use the actual terminal's conversation callback, including its input/history filter.
  context.ConversationLog = ConversationLog;
  const start = main.indexOf('  s.conversation = new ConversationLog(');
  vm.runInContext(main.slice(start, main.indexOf('\n  sessions.set(id, s);', start)), context);
  const listeners = {};
  registerTerminalIpc({ handle() {}, listen: (name, fn) => { listeners[name] = fn; },
    getSession: id => sessions.get(id), getProjectById: () => project,
    acknowledgeProject: id => store.acknowledge(id), expectCompletion: id => store.expectCompletion(id),
    scheduleState() {}, pollAfterSubmission() {}, applyActivity: context.applyActivity, now: () => now,
  });
  return { project, s, store, sessions, context, alerts: () => alerts, armings: () => armings, now: value => { now = value; },
    write: text => listeners['terminal:write'](s.terminalId, text),
    apply: (state, turnId, updatedAt = now) => context.applyActivity(project, s, { state, turnId, threadId: 'thread', updatedAt }),
    user: (text, at = now) => agent === 'claude'
      ? claudeConversation(s.conversation, { type: 'user', uuid: `user-${at}`, timestamp: new Date(at).toISOString(), message: { content: text } })
      : codexConversation(s.conversation, { type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type: 'user_message', message: text } }),
  };
}

const stamp = at => new Date(at).toISOString();
const background = (name, id, at) => ({ type: 'assistant', timestamp: stamp(at), message: { content: [
  { type: 'tool_use', name, id, input: { run_in_background: 'true' } },
] } });
const taskNotice = (id, at, type = 'queue-operation') => ({ type, operation: 'enqueue', timestamp: stamp(at),
  ...(type === 'user' ? { message: { content: `<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>` } }
    : { content: `<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>` }),
});

// Drive the real local/SSH reader callbacks and monitor deduplication without Electron.
async function activityFeed(t, h, { clockOffset = h.project.kind === 'ssh' ? 100000 : 0, initialTurn = true } = {}) {
  const { s, project, context } = h, remote = project.kind === 'ssh';
  const home = path.join(project.path, 'activity-home'), thread = '00000000-0000-4000-8000-000000000001';
  const file = s.agent === 'claude' ? path.join(home, 'session.jsonl') : path.join(home, 'sessions', `rollout-${thread}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '');
  s.activityClockOffset = clockOffset;
  // Local transcripts share the main clock; only SSH records come from another clock.
  const timestamp = at => stamp(at - (remote ? clockOffset : 0)), records = [];
  const reader = new CodexActivityReader(project.path, home, 1000);
  reader.snapshot = { threadId: thread, turnId: null, state: 'unknown', updatedAt: 0 };
  let changes = 0;
  const append = async record => {
    if (remote) { records.push(record); reader.record(record); }
    else await fs.appendFile(file, `${JSON.stringify(record)}\n`);
  };
  s.actions.reset = () => {};
  s.terminal = { request: async () => ({ records: records.splice(0), snapshot: reader.snapshot, historyDone: true }) };
  Object.assign(context, {
    path, TranscriptTail, CodexActivityReader, claudeConversation, codexConversation,
    claudeConfigDir: () => home, claudeRecord: () => [], codexRecord: () => [],
    describeActions() {}, noteSettings() {}, usageHistory() {}, readEvery: () => 1000,
    monitorActivity: (read, changed, options) => monitorActivity(read, snapshot => { changes++; changed(snapshot); }, { ...options, watch: null }),
  });
  if (s.agent === 'claude') {
    vm.runInContext(main.slice(main.indexOf('function followClaude('), main.indexOf('// Workspace broadcasts')), context);
    context.followClaude(project, s, { sessionId: 'session', transcriptPath: remote ? '/srv/claude/projects/session.jsonl' : file, sentAt: 1000 - s.activityClockOffset });
  } else {
    await append({ type: 'session_meta', timestamp: timestamp(1000), payload: { id: thread, cwd: project.path, source: 'cli' } });
    if (initialTurn) await append({ type: 'event_msg', timestamp: timestamp(1900), payload: { type: 'task_started', turn_id: 'parent' } });
    context.event = { cwd: project.path, codexHome: home, sentAt: 1000 - s.activityClockOffset };
    const start = main.indexOf('    const remoteSince =');
    vm.runInContext(main.slice(start, main.indexOf('    // Unread completion', start)), context);
  }
  t.after(() => s.activityMonitor.stop());
  await s.activityMonitor.poll();
  return {
    append,
    changes: () => changes,
    poll: () => s.activityMonitor.poll(),
    start: (at, turnId = 'parent') => append({ type: 'event_msg', timestamp: timestamp(at), payload: { type: 'task_started', turn_id: turnId } }),
    user: async (text, at) => {
      await append(s.agent === 'claude'
        ? { type: 'user', uuid: `user-${at}`, timestamp: timestamp(at), message: { content: text } }
        : { type: 'event_msg', timestamp: timestamp(at), payload: { type: 'user_message', message: text } });
      await s.activityMonitor.poll();
    },
    complete: async (at, turnId = 'parent') => {
      await append(s.agent === 'claude'
        ? { type: 'assistant', uuid: turnId, timestamp: timestamp(at), message: { stop_reason: 'end_turn', content: [] } }
        : { type: 'event_msg', timestamp: timestamp(at), payload: { type: 'task_complete', turn_id: turnId } });
      await s.activityMonitor.poll();
    },
  };
}

const userRoundFixture = require('./fixtures/claude-user-round-background.json');
const recordedLine = line => userRoundFixture.records[userRoundFixture.sourceLines.indexOf(line)];

for (const kind of ['local', 'ssh']) {
  test(`Claude ${kind} main rounds show delivered background sources without consuming queued human prompts`, async t => {
    const h = await harness(t, kind, 'claude'), { s } = h;
    const feed = await activityFeed(t, h, { clockOffset: 0 });
    const mainTurn = () => s.completionWork.mainTurn(s.activitySnapshot);
    const append = async record => { h.now(Date.parse(record.timestamp)); await feed.append(record); await feed.poll(); };
    const content = id => `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>launch-${id}</tool-use-id>\n<status>completed</status>\n<summary>${id} verification finished</summary>\n<result>Worker output is not a main-agent prompt.</result>\n</task-notification>`;
    const receipt = (id, at) => ({ type: 'user', uuid: `notice-${id}`, timestamp: stamp(at), message: { content: content(id) } });
    h.write('Verify the parser\r');
    await feed.user('Verify the parser', 2000);
    assert.equal(mainTurn().state, 'working'); assert.equal(s.promptQueue.list()[0].summary, 'Verify the parser');
    await append(background('Agent', 'launch-first', 2050));
    await append({ type: 'user', timestamp: stamp(2060), toolUseResult: { isAsync: true, agentId: 'first' }, message: { content: [{ type: 'tool_result', tool_use_id: 'launch-first' }] } });
    await feed.complete(2200);
    assert.equal(s.codexActivity, 'working', 'the project still has background work');
    assert.equal(mainTurn().state, 'complete', 'the main agent has ended its prompt round');
    assert.deepEqual(s.promptQueue.list(), []);
    await append({ type: 'queue-operation', operation: 'enqueue', timestamp: stamp(2300), content: content('first') });
    assert.equal(mainTurn().state, 'complete', 'enqueue alone never starts a main-agent round');
    await append({ type: 'queue-operation', operation: 'dequeue', timestamp: stamp(2310) });
    assert.equal(mainTurn().state, 'complete', 'an anonymous dequeue is not delivery');
    await append(receipt('first', 2320));
    assert.deepEqual(mainTurn().background, { text: 'first verification finished', summary: 'first verification finished', at: 2320, count: 1 });
    assert.equal(mainTurn().state, 'working'); assert.deepEqual(s.promptQueue.list(), []);
    await append({ type: 'queue-operation', operation: 'enqueue', timestamp: stamp(2330), content: 'Check the next change' });
    assert.deepEqual(s.promptQueue.list().map(item => item.state), ['queued']);
    await append(receipt('second', 2340));
    await append({ ...receipt('first', 2350), uuid: 'duplicate-first' });
    assert.equal(mainTurn().background.count, 2); assert.equal(mainTurn().background.at, 2320);
    assert.equal(mainTurn().background.summary, 'first verification finished');
    await append({ type: 'user', uuid: 'sidechain', isSidechain: true, timestamp: stamp(2360), message: { content: 'PRIVATE WORKER PROMPT' } });
    await append({ type: 'assistant', uuid: 'sidechain-end', isSidechain: true, timestamp: stamp(2370), message: { stop_reason: 'end_turn', content: [] } });
    assert.equal(mainTurn().state, 'working'); assert.equal(mainTurn().background.count, 2);
    await feed.complete(2500, 'review-end');
    assert.equal(mainTurn().state, 'complete');
    assert.equal(s.codexActivity, 'working', 'the queued human prompt still blocks project completion');
    assert.deepEqual(s.promptQueue.list().map(item => item.state), ['queued']);
    await feed.user('Check the next change', 2600);
    assert.equal(mainTurn().state, 'working'); assert.equal(mainTurn().background, null);
    assert.deepEqual(s.promptQueue.list().map(item => item.state), ['working']);
    await feed.complete(2700, 'next-end');
    assert.equal(mainTurn().state, 'complete'); assert.deepEqual(s.promptQueue.list(), []);
    assert.equal(s.codexActivity, 'complete'); assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1);
    h.store.acknowledge(h.project.id);
    await append(receipt('first', 2800));
    assert.equal(mainTurn().state, 'complete', 'a repeated receipt cannot reopen an ended review');
    assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1); assert.equal(h.project.unread, 0);
  });

  test(`Claude ${kind} interrupted rounds end promptly and compaction cannot invent or finish a round`, async t => {
    const h = await harness(t, kind, 'claude'), { s } = h;
    const feed = await activityFeed(t, h, { clockOffset: 0 });
    const mainTurn = () => s.completionWork.mainTurn(s.activitySnapshot);
    const append = async record => { h.now(Date.parse(record.timestamp)); await feed.append(record); await feed.poll(); };
    await feed.user('Test interruption', 2000);
    await append(background('Agent', 'pending-child', 2100));
    const compact = at => [
      { type: 'system', subtype: 'compact_boundary', timestamp: stamp(at) },
      { type: 'user', uuid: `compact-${at}`, isCompactSummary: true, timestamp: stamp(at + 1), message: { content: 'This session is being continued from a previous conversation. Synthetic summary.' } },
      { type: 'assistant', uuid: `synthetic-${at}`, timestamp: stamp(at + 2), message: { model: '<synthetic>', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Compacted context.' }] } },
    ];
    for (const record of compact(2200)) await append(record);
    assert.equal(mainTurn().state, 'working'); assert.equal(s.promptQueue.list().length, 1);
    await append({ type: 'user', uuid: 'interrupt', timestamp: stamp(2300), message: { content: '[Request interrupted by user for tool use]' } });
    assert.equal(mainTurn().state, 'interrupted'); assert.equal(s.codexActivity, 'interrupted');
    assert.deepEqual(s.promptQueue.list(), []); assert.equal(h.alerts(), 0);
    await append({ type: 'system', subtype: 'stop_hook_summary', uuid: 'stop', timestamp: stamp(2400) });
    assert.equal(mainTurn().state, 'interrupted', 'Stop after interruption cannot become success');
    for (const record of compact(2500)) await append(record);
    assert.equal(mainTurn().state, 'interrupted'); assert.deepEqual(s.promptQueue.list(), []);
    await feed.user('A fresh round', 2600);
    assert.equal(mainTurn().state, 'working'); assert.equal(mainTurn().background, null);
    await feed.complete(2700, 'fresh-end');
    assert.equal(mainTurn().state, 'complete'); assert.deepEqual(s.promptQueue.list(), []);
    for (const record of compact(2800)) await append(record);
    assert.equal(mainTurn().state, 'complete', 'compaction after completion cannot reopen work');
  });
}

test('Claude terminal API errors interrupt the main round; retry records and later Stop hooks cannot misreport it', async t => {
  const h = await harness(t, 'local', 'claude'), { s } = h;
  const feed = await activityFeed(t, h, { clockOffset: 0 });
  await feed.user('Verify error recovery', 2000);
  await feed.append({ type: 'system', subtype: 'api_error', timestamp: stamp(2100), retryInMs: 500, retryAttempt: 1 }); await feed.poll();
  assert.equal(s.completionWork.mainTurn(s.activitySnapshot).state, 'working');
  await feed.append({ type: 'assistant', uuid: 'api-error', timestamp: stamp(2200), isApiErrorMessage: true,
    message: { model: '<synthetic>', stop_reason: null, content: [{ type: 'text', text: 'API request failed.' }] } }); await feed.poll();
  assert.equal(s.completionWork.mainTurn(s.activitySnapshot).state, 'interrupted');
  assert.equal(s.codexActivity, 'interrupted'); assert.deepEqual(s.promptQueue.list(), []);
  h.now(2300);
  h.context.claudeActivity(h.project, s, { state: 'complete', sessionId: 'session', eventId: 'session:stop' });
  await s.activityMonitor.poll(); await Promise.resolve();
  assert.equal(s.completionWork.mainTurn(s.activitySnapshot).state, 'interrupted');
  assert.equal(s.codexActivity, 'interrupted'); assert.equal(h.alerts(), 0);
});

for (const kind of ['local', 'ssh']) for (const order of ['prefixes', 'batched-background', 'late-user']) {
  test(`Claude ${kind} real user round clears at its own end (${order}) while project completion waits for background work`, async t => {
    const h = await harness(t, kind, 'claude'), { s } = h, offset = kind === 'ssh' ? 100000 : 0;
    const prompt = recordedLine(16501), at = Date.parse(prompt.timestamp) + offset;
    const prefixEnd = order === 'batched-background' ? 16541 : 16532;
    s.activitySince = at - 1000; h.now(at);
    const feed = await activityFeed(t, h, { clockOffset: offset });
    h.write(`${prompt.message.content[0].text}\r`);
    let prefix = userRoundFixture.records.filter((_, index) => userRoundFixture.sourceLines[index] <= prefixEnd);
    if (order === 'late-user') prefix = [...prefix.filter(record => record !== prompt), prompt];
    for (const record of prefix) await feed.append(record);
    await feed.poll();
    assert.deepEqual(s.promptQueue.list(), [], 'the first end_turn retires the user prompt even if the same poll ends in background work');
    assert.equal(s.promptQueue.task.endedAt, Date.parse(recordedLine(16532).timestamp) + offset);
    assert.equal(s.completionWork.tasks.size, order === 'batched-background' ? 1 : 2);
    assert.equal(s.codexActivity, 'working', 'tracked background work still blocks the project alert');
    assert.equal(h.alerts(), 0); assert.equal(h.project.completionArmed, true);
    const rest = userRoundFixture.records.filter((_, index) => userRoundFixture.sourceLines[index] > prefixEnd && userRoundFixture.sourceLines[index] <= 16564);
    for (const record of rest) {
      h.now(Date.parse(record.timestamp) + offset);
      await feed.append(record); await feed.poll();
      assert.deepEqual(s.promptQueue.list(), [], 'notifications, their tools and system records cannot revive a completed user task');
    }
    assert.equal(s.codexActivity, 'complete'); assert.equal(s.completionWork.tasks.size, 0);
    assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1); assert.equal(h.project.unread, 1);
    h.store.acknowledge(h.project.id);
    const later = Date.parse(recordedLine(16564).timestamp) + 1000;
    for (const record of [
      { ...recordedLine(16550), timestamp: stamp(later), uuid: 'later-notice' },
      { type: 'user', timestamp: stamp(later + 1), uuid: 'later-reminder', isMeta: true, message: { content: '<system-reminder>Background context.</system-reminder>' } },
      { ...recordedLine(16562), timestamp: stamp(later + 2), uuid: 'later-background-end' },
    ]) {
      h.now(Date.parse(record.timestamp) + offset);
      await feed.append(record); await feed.poll();
      assert.deepEqual(s.promptQueue.list(), []);
    }
    s.promptQueue.changed(); s.completionWork.changed(); await Promise.resolve();
    assert.equal(s.codexActivity, 'complete'); assert.equal(h.project.unread, 0);
    assert.equal(h.project.completionArmed, false); assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1);
  });
}

for (const kind of ['local', 'ssh']) test(`Claude ${kind} real queued inputs survive round ends and anonymous dequeues, and named/actual receipts pair once`, async t => {
  const h = await harness(t, kind, 'claude'), { s } = h, offset = kind === 'ssh' ? 100000 : 0;
  const first = recordedLine(16608), second = recordedLine(16609), at = Date.parse(first.timestamp);
  h.now(at + offset); s.activitySince = at + offset - 1000;
  const feed = await activityFeed(t, h, { clockOffset: offset });
  h.write(`${first.content}\r`);
  for (const record of [first, second, { ...first, timestamp: stamp(at + 90000) }]) await feed.append(record);
  await feed.poll();
  assert.equal(s.promptQueue.list().length, 3, 'the transcript pairs its first enqueue with the terminal echo, leaving distinct sends');
  h.now(at + offset + 120000); h.apply('complete', 'previous', at + offset - 1);
  assert.deepEqual(s.promptQueue.list().map(item => item.state), ['queued', 'queued', 'queued']);
  const record = async (value, when) => {
    h.now(when + offset); await feed.append({ ...value, timestamp: stamp(when) }); await feed.poll();
  };
  await record({ type: 'queue-operation', operation: 'dequeue' }, at + 120001);
  assert.equal(s.promptQueue.list().length, 3, 'an anonymous dequeue cannot select an arbitrary real input');
  await record({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', content: first.content }, at + 120002);
  const accepted = s.promptQueue.list().find(item => item.state === 'working').id;
  await record({ type: 'user', uuid: 'accepted-first', promptSource: 'queued', origin: { kind: 'human' }, message: { content: first.content } }, at + 120003);
  assert.equal(s.promptQueue.list().find(item => item.state === 'working').id, accepted);
  assert.deepEqual(s.promptQueue.list().map(item => item.state), ['working', 'queued', 'queued'], 'the later transcript echo does not consume the next identical send');
  await feed.complete(at + offset + 120004, 'first');
  assert.deepEqual(s.promptQueue.list().map(item => item.text), [second.content, first.content]);
  assert.equal(h.alerts(), 0, 'the project still has recorded queued work');
  await record({ type: 'queue-operation', operation: 'dequeue', content: second.content }, at + 120005);
  await record({ type: 'user', uuid: 'accepted-second', promptSource: 'queued', message: { content: second.content } }, at + 120006);
  await feed.complete(at + offset + 120007, 'second');
  assert.deepEqual(s.promptQueue.list().map(item => item.text), [first.content]);
  await record({ type: 'user', uuid: 'accepted-third', promptSource: 'queued', message: { content: first.content } }, at + 120008);
  await feed.complete(at + offset + 120009, 'third');
  assert.deepEqual(s.promptQueue.list(), []); assert.equal(s.conversation.queue.length, 0);
  assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1);
  h.store.acknowledge(h.project.id);
  s.promptQueue.changed(); s.completionWork.changed(); await Promise.resolve();
  assert.equal(h.alerts(), 1); assert.equal(h.project.unread, 0); assert.equal(h.project.completionArmed, false);
});

test('a running Claude dev server lets its session card complete and cannot rearm it after acknowledgment', async t => {
  for (const native of [false, true]) {
    const h = await harness(t, 'local', 'claude'), { s } = h;
    if (native) Object.assign(s, { native: {}, nativeMode: 'claude-sdk', sessionId: 'generation', nativeMessages: [] });
    const record = { ...background('Bash', 'dev', 2050), message: { content: [
      { type: 'tool_use', name: 'Bash', id: 'dev', input: { command: 'cd /work/app && npm run dev', run_in_background: true } },
    ] } };
    if (native) h.context.nativeSessionEvent(s.terminalId, s.sessionId, { type: 'managed-prompt', text: 'Fix the app' });
    else { h.write('Fix the app\r'); h.user('Fix the app'); }
    s.completionWork.record(record, 'claude');
    s.completionWork.record({ type: 'user', timestamp: stamp(2070), toolUseResult: { backgroundTaskId: 'server' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'dev' }] } }, 'claude');
    if (native) {
      h.now(2080); h.context.nativeSessionEvent(s.terminalId, s.sessionId, { type: 'system', subtype: 'task_started', tool_use_id: 'dev', task_id: 'server' });
    }
    h.apply('complete', 'parent', 2100);
    assert.equal(s.codexActivity, 'complete'); assert.equal(h.project.unread, 1); assert.equal(h.alerts(), 1);
    h.store.acknowledge(h.project.id);
    h.now(2050 + 2 * LOST_WORK_TIMEOUT); h.apply('complete', 'parent', 2100);
    assert.equal(s.codexActivity, 'complete'); assert.equal(h.project.unread, 0); assert.equal(h.alerts(), 1);
    s.completionWork.record(taskNotice('server', 2200), 'claude'); h.apply('complete', 'background', 2300);
    assert.equal(s.codexActivity, 'complete'); assert.equal(h.project.unread, 0); assert.equal(h.alerts(), 1);
  }
});

test('Claude completion waits for every background agent and command and the notification review turn', async t => {
  for (const kind of ['local', 'ssh']) {
    const h = await harness(t, kind, 'claude'), work = h.s.completionWork;
    h.write('finish all work\r'); h.user('finish all work', 2000);
    for (const [name, id] of [['Agent', 'agent'], ['Bash', 'shell']]) work.record(background(name, id, 2050), 'claude');
    h.apply('complete', 'main-stop', 2100);
    assert.equal(h.s.codexActivity, 'working'); assert.equal(h.project.unread, 0); assert.equal(h.alerts(), 0);
    work.record(taskNotice('agent', 2200), 'claude'); h.apply('complete', 'main-stop', 2100);
    assert.equal(h.s.codexActivity, 'working'); assert.equal(h.alerts(), 0);
    work.record(taskNotice('shell', 2300), 'claude'); h.apply('complete', 'main-stop', 2100);
    assert.equal(h.s.codexActivity, 'working', 'completed tasks still have queued notification work');
    for (const id of ['agent', 'shell']) work.record(taskNotice(id, 2400, 'user'), 'claude');
    h.apply('complete', 'main-stop', 2100);
    assert.equal(h.s.codexActivity, 'working', 'delivery starts the parent review, not project completion');
    work.record({ type: 'assistant', uuid: 'review-stop', timestamp: stamp(2500), message: { stop_reason: 'end_turn', content: [] } }, 'claude');
    h.apply('complete', 'review-stop', 2500);
    assert.equal(h.s.codexActivity, 'complete'); assert.equal(h.project.unread, 1); assert.equal(h.alerts(), 1);
    h.store.acknowledge(h.project.id);
    work.record(taskNotice('shell', 2600), 'claude'); work.record(taskNotice('shell', 2700, 'user'), 'claude');
    work.end(2800); h.apply('complete', 'late-review', 2800);
    assert.equal(h.project.unread, 0); assert.equal(h.alerts(), 1, 'background callbacks never rearm completion');
  }
});

test('Claude orphan receipts and stopped services leave the badge state complete without rearming alerts', async t => {
  for (const kind of ['local', 'ssh']) {
    const h = await harness(t, kind, 'claude'), { s } = h, work = s.completionWork;
    const orphan = { ...taskNotice('old-shell', 1900), content: '<task-notification>\n<task-id>old-shell</task-id>\n<tool-use-id>old-launch</tool-use-id>\n<status>killed</status>\n<summary>Previous shell was stopped</summary>\n</task-notification>' };
    work.record({ type: 'system', subtype: 'compact_boundary', timestamp: stamp(1850) }, 'claude');
    work.record(orphan, 'claude');
    const service = { ...background('Bash', 'dev', 1920), message: { content: [
      { type: 'tool_use', name: 'Bash', id: 'dev', input: { command: 'cd /work/app && AGENTRIX_DATA_DIR=/scratch/profile AGENTRIX_TEST_HOME=1 npm run dev', run_in_background: true } },
    ] } };
    work.record(service, 'claude');
    work.record({ type: 'user', timestamp: stamp(1930), toolUseResult: { backgroundTaskId: 'server' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'dev' }] } }, 'claude');
    const stopped = { ...taskNotice('server', 1940), content: '<task-notification>\n<task-id>server</task-id>\n<tool-use-id>dev</tool-use-id>\n<status>stopped</status>\n<summary>Previous shell did not finish before the session ended</summary>\n</task-notification>' };
    work.record(stopped, 'claude');
    work.record({ type: 'queue-operation', operation: 'dequeue', timestamp: stamp(1950) }, 'claude');
    work.record({ type: 'user', timestamp: stamp(1960), message: { content: stopped.content } }, 'claude');
    h.write('Finish the task\r'); h.user('Finish the task');
    work.record({ type: 'assistant', uuid: 'done', timestamp: stamp(2100), message: { stop_reason: 'end_turn', content: [] } }, 'claude');
    h.apply('complete', 'done', 2100);
    assert.equal(work.tasks.size, 0); assert.equal(work.notifications.size, 0);
    assert.equal(s.codexActivity, 'complete'); assert.equal(h.project.unread, 1);
    assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1);
    h.store.acknowledge(h.project.id);
    work.record({ ...orphan, timestamp: stamp(2200) }, 'claude');
    work.changed(); h.apply('complete', 'idle', 2300);
    assert.equal(s.codexActivity, 'complete'); assert.equal(h.project.unread, 0);
    assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1);
  }
});

test('queued terminal submissions block the gap between turns without consuming the project alert', async t => {
  const h = await harness(t);
  h.write('first task\r'); h.user('first task', 2050);
  h.now(2100); h.write('queued task\r');
  h.apply('complete', 'first', 2200);
  assert.equal(h.s.codexActivity, 'working'); assert.equal(h.project.unread, 0); assert.equal(h.alerts(), 0);
  h.user('queued task', 2300); h.apply('complete', 'first', 2200);
  assert.equal(h.s.codexActivity, 'working'); assert.equal(h.project.unread, 0); assert.equal(h.alerts(), 0);
  h.apply('complete', 'second', 2400);
  assert.equal(h.s.codexActivity, 'complete'); assert.equal(h.project.unread, 1); assert.equal(h.alerts(), 1);
});

for (const kind of ['local', 'ssh']) for (const injectReset of [false, true]) {
  test(`Claude ${kind} named handoff completes accepted queued work once${injectReset ? ' alongside the real reset sequence' : ''}`, async t => {
    const h = await harness(t, kind, 'claude'), { s, project } = h;
    const fixture = require('./fixtures/claude-usage-reset.json');
    const offset = kind === 'ssh' ? 100000 : 0;
    s.activityClockOffset = offset;
    const record = (value, at) => {
      const row = { ...value, timestamp: stamp(at - offset) };
      s.completionWork.record(row, 'claude', offset);
      claudeConversation(s.conversation, row);
    };
    const automatic = at => fixture.records.slice(0, 3).forEach((row, index) => record(row, at + index));
    h.write('First task\r'); record({ type: 'user', uuid: 'first', message: { content: 'First task' } }, 2050);
    h.apply('working', null, 2050);
    h.now(2100); h.write('Real queued follow-up\r');
    record({ type: 'queue-operation', operation: 'enqueue', content: 'Real queued follow-up' }, 2101);
    if (injectReset) automatic(2120);
    h.apply('complete', 'first-stop', 2200);
    assert.equal(s.codexActivity, 'working'); assert.equal(h.alerts(), 0);
    assert.deepEqual(s.promptQueue.list().map(item => [item.text, item.state]), [['Real queued follow-up', 'queued']]);
    h.now(23000);
    assert.equal(s.promptQueue.list().length, 1, 'accepted queue entries survive the unrecorded submission grace');
    h.apply('complete', 'first-stop', 2200);
    assert.equal(h.alerts(), 0);
    record({ type: 'queue-operation', operation: 'remove', content: 'Real queued follow-up', reason: 'absorbed_mid_turn' }, 23100);
    assert.equal(s.conversation.queue.length, 0);
    assert.equal(s.conversation.list.find(entry => entry.text === 'Real queued follow-up').at, 2101 - offset, 'the reading entry retains its send time');
    assert.deepEqual(s.promptQueue.list().map(item => item.state), ['working']);
    assert.equal(s.activityConfirmedInputAt, 23100, 'the handoff guards its own round using the main clock');
    h.apply('complete', 'first-stop', 2200);
    assert.equal(s.promptQueue.list().length, 1, 'an older completed round cannot consume this handoff');
    record({ type: 'assistant', uuid: 'last', message: { content: [], stop_reason: 'end_turn' } }, 23200);
    h.apply('complete', 'last', 23200);
    assert.equal(s.codexActivity, 'complete'); assert.equal(s.promptQueue.list().length, 0);
    assert.equal(project.unread, 1); assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1);
    h.store.acknowledge(project.id);
    if (injectReset) automatic(23300);
    s.promptQueue.changed(); s.completionWork.changed();
    h.apply('working', 'background', 23400); h.apply('complete', 'background', 23500);
    await Promise.resolve();
    assert.equal(project.unread, 0); assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1);
  });
}

for (const kind of ['local', 'ssh']) for (const flags of [{ isMeta: true }, { isCompactSummary: true }, { isVisibleInTranscriptOnly: true }]) for (const markedRemoval of [false, true]) {
  test(`review: Claude ${kind} ${markedRemoval ? 'withdraws a marked removal' : 'retracts a promoted receipt'} with ${Object.keys(flags)[0]} without consuming a real identical send or rearming`, async t => {
    const h = await harness(t, kind, 'claude'), { s, project } = h, text = 'Automatic neutral message';
    const offset = kind === 'ssh' ? 100000 : 0;
    s.activityClockOffset = offset;
    const record = (row, at, queueOnly = false) => {
      const value = { ...row, timestamp: stamp(at - offset) };
      s.completionWork.record(value, 'claude', offset);
      claudeConversation(s.conversation, value, undefined, { queueOnly });
      return value;
    };
    h.write('First real request\r'); record({ type: 'user', uuid: 'first', message: { content: 'First real request' } }, 2050);
    h.apply('working', null, 2050);
    record({ type: 'queue-operation', operation: 'enqueue', content: text }, 2100);
    record({ type: 'queue-operation', operation: 'remove', content: text, ...(markedRemoval ? flags : {}) }, 2150);
    h.now(2160); h.write(`${text}\r`);
    record({ type: 'queue-operation', operation: 'enqueue', content: text }, 2161);
    const actualId = s.conversation.queue[0].id;
    record({ type: 'user', uuid: 'automatic', message: { content: text }, ...flags }, 2180);
    assert.deepEqual(s.conversation.list.filter(entry => !entry.queued).map(entry => entry.text), ['First real request']);
    assert.equal(s.conversation.queue[0].id, actualId);
    assert.deepEqual(s.promptQueue.list().map(entry => [entry.text, entry.state]), [['First real request', 'working'], [text, 'queued']]);
    assert.notEqual(s.promptQueue.task?.text, text, 'the automatic task title is also withdrawn');
    record({ type: 'assistant', uuid: 'first-end', message: { content: [], stop_reason: 'end_turn' } }, 2200);
    h.apply('complete', 'first-end', 2200);
    assert.equal(h.alerts(), 0); assert.equal(h.armings(), 1);
    record({ type: 'queue-operation', operation: 'remove', content: text }, 2300);
    const accepted = record({ type: 'user', uuid: 'real-queued', promptSource: 'queued', message: { content: text } }, 2250, true);
    claudeConversation(s.conversation, accepted);
    assert.equal(s.conversation.list.find(entry => entry.id === actualId).receivedAt, 2300 - offset);
    assert.equal(s.activityConfirmedInputAt, 2300);
    h.apply('complete', 'old-end', 2290);
    assert.deepEqual(s.promptQueue.list().map(entry => entry.state), ['working']);
    record({ type: 'assistant', uuid: 'real-end', message: { content: [], stop_reason: 'end_turn' } }, 2400);
    h.apply('complete', 'real-end', 2400);
    assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1); assert.equal(project.unread, 1);
    h.store.acknowledge(project.id);
    s.promptQueue.changed(); s.completionWork.changed(); h.apply('working', 'background', 2450); h.apply('complete', 'background', 2500);
    await Promise.resolve();
    assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1); assert.equal(project.unread, 0);
    h.now(2600); h.write('Another real request\r'); record({ type: 'user', uuid: 'next-real', message: { content: 'Another real request' } }, 2650);
    record({ type: 'assistant', uuid: 'next-end', message: { content: [], stop_reason: 'end_turn' } }, 2700);
    h.apply('complete', 'next-end', 2700);
    assert.equal(h.alerts(), 2); assert.equal(h.armings(), 2); assert.equal(project.unread, 1);
  });
}

for (const agent of ['claude', 'codex']) for (const kind of ['local', 'ssh']) for (const readAtExpiry of [false, true]) {
  test(`${agent} ${kind} drops an unrecorded typed answer after grace and grants the deferred completion once${readAtExpiry ? ' despite a state read at expiry' : ''}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = await harness(t, kind, agent), { s, project } = h;
    h.write('Finish the task\r'); h.user('Finish the task'); h.apply('working', 'parent', 2050);
    h.now(2100); h.write('Use the suggested option\r');
    assert.equal(s.promptQueue.items.at(-1).expires, Infinity, 'an answer waits while its round is running');
    h.now(2200); h.apply('complete', 'parent', 2200);
    await Promise.resolve();
    assert.equal(s.codexActivity, 'working'); assert.equal(project.unread, 0); assert.equal(h.alerts(), 0);
    assert.equal(project.completionArmed, true); assert.equal(h.armings(), 1);
    assert.equal(s.activitySnapshot.state, 'complete', 'the same parent completion is deferred');
    assert.deepEqual(s.promptQueue.list().map(item => item.text), ['Use the suggested option']);

    const grace = s.promptQueue.grace;
    h.now(2200 + grace - 1); t.mock.timers.tick(grace - 1);
    await Promise.resolve();
    assert.equal(s.codexActivity, 'working'); assert.equal(project.unread, 0); assert.equal(h.alerts(), 0);
    if (readAtExpiry) {
      h.now(2200 + grace); t.mock.timers.tick(1);
      assert.deepEqual(s.promptQueue.list(), [], 'a state read prunes the answer before the expiry timer fires');
    }
    // The queue timer has a 10 ms margin. No new lifecycle event grants this completion.
    h.now(2200 + grace + 10); t.mock.timers.tick(readAtExpiry ? 10 : 11);
    await Promise.resolve();
    assert.equal(s.codexActivity, 'complete'); assert.deepEqual(s.promptQueue.list(), []);
    assert.equal(project.unread, 1); assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1);
    assert.equal(project.lastCompletedAt, 2200); assert.equal(project.completionArmed, false);

    s.promptQueue.changed(); s.completionWork.changed(); h.apply('complete', 'parent', 2200);
    await Promise.resolve();
    assert.equal(project.unread, 1); assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1);
    h.store.acknowledge(project.id);
    s.promptQueue.changed(); s.completionWork.changed();
    h.apply('working', 'background', 2300); h.apply('complete', 'background', 2400);
    await Promise.resolve();
    assert.equal(s.codexActivity, 'complete'); assert.equal(project.unread, 0);
    assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1); assert.equal(project.completionArmed, false);
  });
}

for (const agent of ['claude', 'codex']) for (const kind of ['local', 'ssh']) for (const clockOffset of [kind === 'ssh' ? 100000 : 0, 2000, -2000]) {
  test(`${agent} ${kind} publishes working and completes each round once with clock offset ${clockOffset} ms`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = await harness(t, kind, agent), { s, project } = h, feed = await activityFeed(t, h, { clockOffset, initialTurn: false });
    for (const [at, turnId] of [[1000000, 'first'], [1001000, 'next']]) {
      if (agent === 'codex') await feed.start(at, turnId);
      h.now(at); await feed.user(`Finish the ${turnId} task`, at);
      assert.equal(s.codexActivity, 'working', `snapshot ${s.activityRawSnapshot?.updatedAt}, input guard ${s.activityInputAt}`);
      assert.equal(s.activitySnapshot.state, 'working'); assert.equal(s.activitySnapshot.updatedAt, at);
      assert.equal(s.activityInputAt, at); assert.equal(s.activityConfirmedInputAt, at);
      assert.deepEqual(s.promptQueue.list().map(item => [item.state, item.at]), [['working', at]]);
      // Claude's prompt hook can arrive after the transcript; only it arms a CLI round without typed input.
      if (agent === 'claude') h.context.claudeActivity(project, s, { state: 'working', sessionId: 'session', eventId: `session:${turnId}`, prompt: `Finish the ${turnId} task` });
      h.now(at + 100); await feed.complete(at + 100, turnId);
      const count = turnId === 'first' ? 1 : 2;
      assert.equal(s.codexActivity, 'complete'); assert.deepEqual(s.promptQueue.list(), []);
      assert.equal(s.promptQueue.finishedAt, at + 100); assert.equal(project.lastCompletedAt, at + 100);
      assert.equal(project.unread, 1); assert.equal(h.alerts(), count); assert.equal(h.armings(), count);
      h.store.acknowledge(project.id);
      await feed.poll(); s.promptQueue.changed(); s.completionWork.changed(); await Promise.resolve();
      assert.equal(project.unread, 0); assert.equal(project.completionArmed, false);
      assert.equal(h.alerts(), count); assert.equal(h.armings(), count);
    }
  });
}

for (const kind of ['local', 'ssh']) {
  test(`Codex ${kind} publishes working when the prompt is recorded a millisecond after task_started`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = await harness(t, kind), { s } = h, feed = await activityFeed(t, h, { initialTurn: false });
    await feed.start(1000000);
    h.now(1000001); await feed.user('Finish the task', 1000001);
    assert.equal(s.codexActivity, 'working', `snapshot ${s.activityRawSnapshot?.updatedAt}, input guard ${s.activityInputAt}`);
    assert.equal(s.activitySnapshot.updatedAt, 1000001); assert.equal(s.activityInputAt, 1000001);
    await feed.complete(1000000);
    assert.equal(s.codexActivity, 'working'); assert.equal(s.activitySnapshot.state, 'working');
    assert.equal(h.project.unread, 0); assert.equal(h.alerts(), 0);
    h.now(1000100); await feed.complete(1000100);
    assert.equal(s.codexActivity, 'complete'); assert.equal(h.alerts(), 1);
  });
}

for (const agent of ['claude', 'codex']) for (const kind of ['local', 'ssh']) for (const clockOffset of [kind === 'ssh' ? 100000 : 0, 2500, -2500]) for (const completionAt of [2099, 2200]) for (const readAtExpiry of [false, true]) {
  test(`${agent} ${kind} replays a deduplicated completion ${completionAt < 2100 ? 'before' : 'after'} the handled answer only when it expires${readAtExpiry ? ' in a state read' : ''} with clock offset ${clockOffset} ms`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = await harness(t, kind, agent), { s, project } = h, feed = await activityFeed(t, h, { clockOffset });
    h.write('Finish the task\r'); await feed.user('Finish the task', 2000);
    h.now(2100); h.write('Use the suggested option\r');
    h.now(2200); await feed.complete(completionAt);
    assert.equal(s.activityRawSnapshot.state, 'complete'); assert.equal(s.activityRawSnapshot.updatedAt, completionAt);
    assert.equal(s.activityInputAt, 2100); assert.equal(s.codexActivity, 'working');
    assert.equal(project.unread, 0); assert.equal(h.alerts(), 0); assert.equal(h.armings(), 1);
    assert.deepEqual(s.promptQueue.list().map(item => item.text), ['Use the suggested option']);
    const changes = feed.changes();
    await feed.poll();
    assert.equal(feed.changes(), changes, 'an identical poll cannot rescue the rejected completion');

    const grace = s.promptQueue.grace;
    h.now(2200 + grace - 1); t.mock.timers.tick(grace - 1); await Promise.resolve();
    assert.equal(s.codexActivity, 'working'); assert.equal(project.unread, 0); assert.equal(h.alerts(), 0);
    if (readAtExpiry) {
      h.now(2200 + grace); t.mock.timers.tick(1);
      assert.deepEqual(s.promptQueue.list(), []);
    }
    h.now(2200 + grace + 10); t.mock.timers.tick(readAtExpiry ? 10 : 11); await Promise.resolve();
    assert.equal(s.activityInputAt, 2000, 'only the unrecorded answer loses its input guard');
    assert.equal(s.codexActivity, 'complete'); assert.deepEqual(s.promptQueue.list(), []);
    assert.equal(project.unread, 1); assert.equal(project.lastCompletedAt, completionAt);
    assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1); assert.equal(project.completionArmed, false);
    await feed.poll(); s.promptQueue.changed(); s.completionWork.changed(); await Promise.resolve();
    assert.equal(feed.changes(), changes); assert.equal(project.unread, 1); assert.equal(h.alerts(), 1);
    h.store.acknowledge(project.id);
    t.mock.timers.tick(grace + 10); await feed.poll(); await Promise.resolve();
    assert.equal(project.unread, 0); assert.equal(h.alerts(), 1); assert.equal(h.armings(), 1);
  });
}

for (const agent of ['claude', 'codex']) for (const kind of ['local', 'ssh']) for (const clockOffset of [kind === 'ssh' ? 100000 : 0, 2500, -2500]) for (const completionAt of [2099, 2200]) {
  test(`${agent} ${kind} preserves a recorded new prompt's guard when an unrecorded answer after completion at ${completionAt} expires with clock offset ${clockOffset} ms`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = await harness(t, kind, agent), { s, project } = h, feed = await activityFeed(t, h, { clockOffset });
    h.write('Finish the task\r'); await feed.user('Finish the task', 2000);
    h.now(2100); h.write('Use the suggested option\r');
    h.now(2200); await feed.complete(completionAt);
    h.now(2300); h.write('A real new task\r'); await feed.user('A real new task', 2299);
    assert.equal(s.activityConfirmedInputAt, 2300, 'receipt preserves the handled input time even if the transcript timestamp is older');
    h.now(2200 + s.promptQueue.grace + 10); t.mock.timers.tick(s.promptQueue.grace + 10);
    await Promise.resolve();
    assert.equal(s.activityInputAt, 2300); assert.equal(s.codexActivity, 'working');
    assert.deepEqual(s.promptQueue.list().map(item => item.text), ['A real new task']);
    assert.equal(project.unread, 0); assert.equal(h.alerts(), 0); assert.equal(h.armings(), 1); assert.equal(project.completionArmed, true);
    h.apply('complete', 'parent', completionAt); s.promptQueue.changed(); s.completionWork.changed(); await Promise.resolve();
    assert.equal(s.codexActivity, 'working'); assert.equal(project.unread, 0); assert.equal(h.alerts(), 0);
    h.apply('complete', 'new-task', 2400);
    assert.equal(s.codexActivity, 'complete'); assert.equal(project.unread, 1); assert.equal(h.alerts(), 1);
  });
}

test('a terminal cannot consume unread or notify until all other project terminals complete', async t => {
  const h = await harness(t);
  const id = h.store.addTerminal(h.project.id);
  const other = { ...h.s, terminalId: id, codexActivity: 'working', promptQueue: new PromptQueue(), completionWork: new CompletionWork() };
  h.sessions.set(id, other); t.after(() => other.completionWork.reset());
  h.write('parallel work\r'); h.user('parallel work', 2050); h.apply('complete', 'first', 2200);
  assert.equal(h.s.codexActivity, 'complete'); assert.equal(h.project.unread, 0); assert.equal(h.project.lastCompletedAt, null);
  assert.equal(h.project.completionArmed, true); assert.equal(h.alerts(), 0);
  h.context.applyActivity(h.project, other, { state: 'complete', threadId: 'other', turnId: 'last', updatedAt: 2300 });
  assert.equal(h.project.unread, 1); assert.equal(h.project.lastCompletedAt, 2300); assert.equal(h.alerts(), 1);
});

test('Codex parent completion waits for child handbacks and review while leftover shell sessions remain open', async t => {
  const { CodexActivityReader } = require('../electron/codex-activity.cjs');
  const h = await harness(t), reader = new CodexActivityReader(h.project.path, undefined, 1000, {
    onRecord(record) { h.s.completionWork.record(record, 'codex'); codexConversation(h.s.conversation, record); },
  });
  reader.snapshot = { threadId: 'parent', turnId: null, state: 'unknown', updatedAt: 0 };
  const feed = (type, payload, at) => reader.record({ type, timestamp: stamp(at), payload });
  const apply = () => h.context.applyActivity(h.project, h.s, reader.snapshot);
  h.write('complete every subtask\r');
  feed('event_msg', { type: 'task_started', turn_id: 'first' }, 2050);
  feed('event_msg', { type: 'user_message', message: 'complete every subtask' }, 2050);
  feed('response_item', { type: 'function_call', name: 'spawn_agent', call_id: 'spawn', arguments: '{"task_name":"child"}' }, 2100);
  feed('response_item', { type: 'function_call_output', call_id: 'spawn', output: '{"task_name":"/root/child"}' }, 2150);
  feed('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'shell', input: 'text(await tools.exec_command({cmd:"check"}))' }, 2200);
  feed('response_item', { type: 'custom_tool_call_output', call_id: 'shell', output: [
    { type: 'input_text', text: 'Script completed\nOutput:\n' },
    { type: 'input_text', text: '{"session_id":77717,"wall_time_seconds":10,"output":"running"}' },
  ] }, 2250);
  feed('event_msg', { type: 'task_complete', turn_id: 'first' }, 2300); apply();
  assert.equal(h.s.codexActivity, 'working'); assert.equal(h.project.unread, 0); assert.equal(h.alerts(), 0);
  feed('response_item', { type: 'agent_message', author: '/root/child', content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/child\nPayload:\nDone' }] }, 2400); apply();
  assert.equal(h.s.codexActivity, 'working', 'the parent still owes its child-result review');
  feed('event_msg', { type: 'task_started', turn_id: 'review' }, 2450);
  feed('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'poll', input: 'text(await tools.write_stdin({session_id:77717}))' }, 2500);
  feed('response_item', { type: 'custom_tool_call_output', call_id: 'poll', output: [{ type: 'input_text', text: '{"session_id":77717,"wall_time_seconds":1,"output":"running"}' }] }, 2550);
  apply(); assert.equal(h.s.codexActivity, 'working'); assert.equal(h.alerts(), 0);
  feed('event_msg', { type: 'task_complete', turn_id: 'review' }, 2600); apply();
  assert.equal(h.s.codexActivity, 'complete'); assert.equal(h.project.unread, 1); assert.equal(h.alerts(), 1);
});

test('a lost background task times out to interrupted without unread, success notification or callback rearming', async t => {
  const h = await harness(t, 'local', 'claude');
  h.write('check background work\r'); h.user('check background work');
  h.s.completionWork.record(background('Agent', 'lost', 2050), 'claude');
  h.apply('complete', 'stop', 2100);
  assert.equal(h.s.codexActivity, 'working'); assert.equal(h.project.completionArmed, true);
  h.now(2050 + LOST_WORK_TIMEOUT - 1); h.apply('complete', 'stop', 2100);
  assert.equal(h.s.codexActivity, 'working'); assert.equal(h.alerts(), 0);
  h.now(2050 + LOST_WORK_TIMEOUT);
  h.apply('complete', 'stop', 2100);
  assert.equal(h.s.codexActivity, 'interrupted'); assert.equal(h.project.completionArmed, false);
  assert.equal(h.project.unread, 0); assert.equal(h.alerts(), 0);
  h.s.completionWork.record(taskNotice('lost', 2200), 'claude');
  h.apply('complete', 'late-stop', 2300);
  assert.equal(h.project.unread, 0); assert.equal(h.alerts(), 0);
});

test('native real prompts arm once, notify once, and reject older complete snapshots in both modes', async t => {
  for (const agent of ['claude', 'codex']) {
    const h = await harness(t, 'local', agent), { s } = h;
    Object.assign(s, { native: {}, nativeMode: agent === 'claude' ? 'claude-sdk' : 'codex-native', sessionId: 'generation', nativeMessages: [], reportedThreadId: 'parent' });
    const event = (message, at) => { h.now(at); h.context.nativeSessionEvent(s.terminalId, s.sessionId, message); };
    const prompt = (id, at) => {
      if (agent === 'claude') event({ type: 'managed-prompt', text: `Work on ${id}` }, at);
      else {
        // The app-server's received user item also covers recalled prompts invisible to the key tracker.
        event({ method: 'turn/started', params: { threadId: 'parent', turn: { id } } }, at);
        assert.equal(s.activityInputAt, at);
        event({ method: 'item/completed', params: { threadId: 'parent', item: { type: 'userMessage', id: `input-${id}`, content: [{ type: 'text', text: `Work on ${id}` }] } } }, at + 10);
      }
    };
    const end = (id, at) => event(agent === 'claude' ? { type: 'result', uuid: id }
      : { method: 'turn/completed', params: { threadId: 'parent', turn: { id, status: 'completed' } } }, at);
    prompt('first', 2000);
    assert.equal(h.armings(), 1); assert.equal(h.project.completionArmed, true);
    end('first', 2100); end('first', 2110);
    assert.equal(h.alerts(), 1); assert.equal(h.project.unread, 1);
    h.store.acknowledge(h.project.id);
    prompt('second', 2200);
    const snapshot = s.activitySnapshot;
    h.apply('complete', 'stale-first', 2150);
    assert.equal(s.activitySnapshot, snapshot); assert.equal(s.codexActivity, 'working');
    assert.equal(h.alerts(), 1); assert.equal(h.project.completionArmed, true); assert.equal(h.armings(), 2);
    if (agent === 'codex') {
      s.completionWork.start('child', 2220);
      event({ method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } }, 2230);
      event({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } } }, 2240);
      assert.equal(s.activityInputAt, 2200, 'child events cannot advance the parent watermark');
    }
    end('second', 2300);
    assert.equal(h.alerts(), 2); assert.equal(h.project.unread, 1); assert.equal(h.armings(), 2);
    h.store.acknowledge(h.project.id);
    if (agent === 'codex') {
      event({ method: 'item/completed', params: { threadId: 'parent', item: { type: 'userMessage', id: 'input-second', content: [{ type: 'text', text: 'Work on second' }] } } }, 2400);
      s.completionWork.start('callback-child', 2410);
      event({ method: 'turn/started', params: { threadId: 'callback-child', turn: { id: 'child-idle' } } }, 2420);
      event({ method: 'turn/completed', params: { threadId: 'callback-child', turn: { id: 'child-idle', status: 'completed' } } }, 2430);
      assert.equal(h.project.completionArmed, false, 'child callbacks after acknowledgment cannot arm an alert');
      event({ method: 'turn/started', params: { threadId: 'parent', turn: { id: 'idle' } } }, 2450);
    }
    end('background', 2500);
    assert.equal(h.armings(), 2); assert.equal(h.alerts(), 2); assert.equal(h.project.unread, 0);
  }
});

test('native Codex command executions alone cannot defer an ended parent or trigger the fallback', async t => {
  const h = await harness(t), { s } = h;
  Object.assign(s, { native: {}, nativeMode: 'codex-native', sessionId: 'generation', reportedThreadId: 'parent' });
  h.write('Run the check\r'); h.user('Run the check');
  const event = message => h.context.nativeSessionEvent(s.terminalId, s.sessionId, message);
  h.now(2050); event({ method: 'turn/started', params: { threadId: 'parent', turn: { id: 'turn' } } });
  h.now(2070); event({ method: 'item/started', params: { threadId: 'parent', item: { type: 'commandExecution', id: 'shell', status: 'inProgress', command: 'node' } } });
  h.now(2100); event({ method: 'turn/completed', params: { threadId: 'parent', turn: { id: 'turn', status: 'completed' } } });
  assert.equal(s.codexActivity, 'complete'); assert.equal(h.alerts(), 1); assert.equal(s.completionWork.timer, null);
  h.store.acknowledge(h.project.id);
  h.now(2070 + 2 * LOST_WORK_TIMEOUT); h.apply('complete', 'turn', 2100);
  assert.equal(s.codexActivity, 'complete'); assert.equal(h.alerts(), 1); assert.equal(h.project.unread, 0);
});

test('actual managed Claude handlers wait for SDK tasks and their review, without rearming on background results', async t => {
  const h = await harness(t, 'local', 'claude'), { s } = h;
  Object.assign(s, { native: {}, nativeMode: 'claude-sdk', sessionId: 'generation', nativeMessages: [] });
  const event = (message, at) => { h.now(at); h.context.nativeSessionEvent(s.terminalId, s.sessionId, message); };
  event({ type: 'managed-prompt', text: 'Finish all SDK work' }, 2000);
  event({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'tool', input: { run_in_background: true } }] } }, 2050);
  event({ type: 'system', subtype: 'task_started', tool_use_id: 'tool', task_id: 'child' }, 2060);
  assert.equal(s.completionWork.tasks.size, 1, 'SDK task and tool launch are the same worker');
  event({ type: 'result', session_id: 'claude-session', uuid: 'parent' }, 2100);
  assert.equal(s.codexActivity, 'working'); assert.equal(h.project.unread, 0); assert.equal(h.alerts(), 0);
  event({ type: 'system', subtype: 'task_notification', task_id: 'child', status: 'completed' }, 2200);
  assert.equal(s.completionWork.tasks.size, 0); assert.equal(s.codexActivity, 'working');
  event({ type: 'result', uuid: 'review' }, 2300);
  assert.equal(s.codexActivity, 'complete'); assert.equal(h.project.unread, 1); assert.equal(h.alerts(), 1);
  h.store.acknowledge(h.project.id);
  event({ type: 'system', subtype: 'task_started', task_id: 'callback' }, 2400);
  event({ type: 'result', uuid: 'background-parent' }, 2500);
  assert.equal(s.codexActivity, 'working');
  event({ type: 'system', subtype: 'task_notification', task_id: 'callback', status: 'stopped' }, 2600);
  event({ type: 'result', uuid: 'background-review' }, 2700);
  assert.equal(h.project.unread, 0); assert.equal(h.alerts(), 1); assert.equal(h.project.completionArmed, false);
  h.context.nativeSessionEvent(s.terminalId, 'old-generation', { type: 'managed-prompt', text: 'stale input' });
  assert.equal(h.project.completionArmed, false);
});

test('actual Codex native handlers wait for children but not leftover command items and keep idle turns disarmed', async t => {
  const h = await harness(t), { s } = h;
  Object.assign(s, { native: {}, nativeMode: 'codex-native', sessionId: 'generation' });
  const event = (method, params, at) => { h.now(at); h.context.nativeSessionEvent(s.terminalId, s.sessionId, { method, params }); };
  h.write('Finish all native work\r'); h.user('Finish all native work');
  event('thread/started', { thread: { id: 'parent' } }, 2020);
  event('turn/started', { threadId: 'parent', turn: { id: 'turn' } }, 2040);
  const child = { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } };
  event('item/started', { item: child }, 2050); event('item/completed', { item: child }, 2060);
  event('item/started', { item: { type: 'commandExecution', id: 'command', status: 'inProgress' } }, 2070);
  event('turn/completed', { threadId: 'parent', turn: { id: 'turn', status: 'completed' } }, 2100);
  assert.equal(s.codexActivity, 'working'); assert.equal(h.project.unread, 0); assert.equal(h.alerts(), 0);
  event('item/completed', { item: { ...child, id: 'wait', tool: 'wait', agentsStates: { child: { status: 'completed' } } } }, 2200);
  assert.equal(s.codexActivity, 'working');
  assert.equal(s.codexActivity, 'working', 'the parent still owes the child-result review');
  event('turn/completed', { threadId: 'parent', turn: { id: 'review', status: 'completed' } }, 2350);
  assert.equal(s.codexActivity, 'complete'); assert.equal(h.alerts(), 1);
  h.store.acknowledge(h.project.id);
  event('turn/started', { threadId: 'parent', turn: { id: 'idle' } }, 2400);
  event('turn/completed', { threadId: 'parent', turn: { id: 'idle', status: 'completed' } }, 2500);
  assert.equal(h.project.unread, 0); assert.equal(h.alerts(), 1); assert.equal(h.project.completionArmed, false);
});

test('native child turn completions cannot overwrite or finish the interactive parent turn', async t => {
  const h = await harness(t), { s } = h;
  Object.assign(s, { native: {}, nativeMode: 'codex-native', sessionId: 'generation', reportedThreadId: 'parent' });
  const event = (method, threadId, turn, at) => { h.now(at); h.context.nativeSessionEvent(s.terminalId, s.sessionId, { method, params: { threadId, turn } }); };
  h.write('Parent and child work\r'); h.user('Parent and child work');
  event('turn/started', 'parent', { id: 'parent-turn' }, 2050);
  s.completionWork.start('child', 2060);
  event('turn/completed', 'child', { id: 'child-turn', status: 'completed' }, 2100);
  assert.equal(s.rootThreadId, 'parent'); assert.equal(s.codexActivity, 'working'); assert.equal(h.alerts(), 0);
  assert.equal(s.completionWork.tasks.size, 0);
  event('turn/completed', 'parent', { id: 'parent-turn', status: 'completed' }, 2200);
  assert.equal(s.codexActivity, 'complete'); assert.equal(h.alerts(), 1);
});

test('native interruption without a repeated status field cancels completion, including while child work remains', async t => {
  for (const child of [false, true]) {
    const h = await harness(t), { s } = h;
    Object.assign(s, { native: {}, nativeMode: 'codex-native', sessionId: 'generation', reportedThreadId: 'parent' });
    h.write('Native work\r'); h.user('Native work');
    if (child) s.completionWork.start('child', 2050);
    h.context.nativeSessionEvent(s.terminalId, s.sessionId, { method: 'turn/interrupted', params: { threadId: 'parent', turn: { id: 'turn' } } });
    assert.equal(h.project.completionArmed, false); assert.equal(h.alerts(), 0);
    s.completionWork.finish('child'); h.apply('complete', 'late', 2200);
    assert.equal(h.project.unread, 0); assert.equal(h.alerts(), 0);
  }
});

test('native clear/resume to a different Claude or Codex session retires old tasks and cannot announce restored history', async t => {
  for (const agent of ['claude', 'codex']) {
    const h = await harness(t, 'local', agent), { s } = h;
    Object.assign(s, { native: {}, nativeMode: agent === 'claude' ? 'claude-sdk' : 'codex-native', sessionId: 'generation', nativeMessages: [],
      claudeSessionId: 'old', reportedThreadId: 'old' });
    h.write('Old work\r'); h.user('Old work'); s.completionWork.start('old-child', 2050); h.apply('complete', 'old-turn', 2100);
    const event = message => h.context.nativeSessionEvent(s.terminalId, s.sessionId, message);
    if (agent === 'claude') event({ type: 'system', subtype: 'init', session_id: 'new' });
    else event({ method: 'thread/started', params: { thread: { id: 'new' } } });
    assert.equal(s.completionWork.tasks.size, 0); assert.equal(s.activitySnapshot, null); assert.equal(h.project.completionArmed, false);
    h.now(2200);
    if (agent === 'claude') event({ type: 'result', session_id: 'new', uuid: 'restored' });
    else event({ method: 'turn/completed', params: { threadId: 'new', turn: { id: 'restored', status: 'completed' } } });
    assert.equal(h.alerts(), 0); assert.equal(h.project.unread, 0);
  }
});

test('native process exit cancels its pending work and alert without waiting for the fallback', async t => {
  const h = await harness(t, 'local', 'claude'), { s, context } = h;
  let exited;
  s.native = { registry: { close() {} } };
  h.write('background work\r'); h.user('background work');
  s.completionWork.start('pending-native-task', 2000); h.apply('complete', 'parent', 2100);
  Object.assign(context, { id: s.terminalId, s, project: h.project, terminal: { onExit: callback => { exited = callback; } }, flush() {},
    stopUsageAccount() {}, restorePlans: new Map(), quitting: false, bootstrapFile: null });
  const start = main.indexOf('  terminal.onExit(({ exitCode }) => {');
  vm.runInContext(main.slice(start, main.indexOf('  captureBranch(project);', start)), context);
  exited({ exitCode: 0 });
  assert.equal(s.completionWork.tasks.size, 0); assert.equal(s.completionWork.timer, null); assert.equal(s.activitySnapshot, null);
  assert.equal(s.codexActive, false); assert.equal(h.project.completionArmed, false); assert.equal(h.alerts(), 0);
});

test('actual activity + store alerts once per input, stays quiet after acknowledgment and automatically acknowledges next send', async t => {
  for (const kind of ['local', 'ssh']) for (const agent of ['codex', 'claude']) {
    const h = await harness(t, kind, agent);
    h.write('first task\r'); h.user('first task');
    h.apply('working', null, 2100); h.apply('complete', 'first', 2200);
    assert.equal(h.alerts(), 1); assert.equal(h.project.unread, 1);
    h.store.acknowledge(h.project.id);
    h.apply('complete', 'first', 2200); // duplicate callback
    h.apply('working', null, 2300); // idle/background work
    h.apply('complete', 'background', 2400); // distinct background completion
    assert.equal(h.alerts(), 1); assert.equal(h.project.unread, 0); assert.equal(h.project.completionArmed, false);
    assert.ok(h.project.seenEvents.includes('thread:background'));
    h.now(2500); h.write('second task\r'); h.user('second task'); h.apply('complete', 'second', 2600);
    assert.equal(h.alerts(), 2); assert.equal(h.project.unread, 1);
    h.now(2700); h.write('third task\r'); h.user('third task');
    assert.equal(h.project.unread, 0, 'real terminal IPC acknowledges the preceding result');
    h.apply('complete', 'second', 2600); // stale completion cannot consume third input
    assert.equal(h.project.completionArmed, true);
    h.apply('complete', 'third', 2800);
    assert.equal(h.alerts(), 3); assert.equal(h.project.unread, 1);
    h.now(2900); h.write('interrupted task\r'); h.user('interrupted task'); h.apply('interrupted', null, 3000);
    h.apply('complete', 'after-interruption', 3100);
    assert.equal(h.alerts(), 3); assert.equal(h.project.completionArmed, false);
    h.now(3200); h.write('fresh task after interruption\r'); h.user('fresh task after interruption'); h.apply('complete', 'recovery', 3300);
    assert.equal(h.alerts(), 4); assert.equal(h.project.unread, 1);
    const persisted = JSON.parse(await fs.readFile(h.store.filename, 'utf8')).projects[0];
    assert.equal(persisted.completionArmed, false); assert.equal(persisted.unread, 1);
  }
});

test('Codex received user records preserve command-line, recalled and custom-command rounds without rearming replayed history', async t => {
  for (const kind of ['local', 'ssh']) {
    const h = await harness(t, kind);
    h.s.activityClockOffset = kind === 'ssh' ? 100000 : 0;
    const remoteAt = at => at - h.s.activityClockOffset;
    // First command-line prompt is received after CLI startup; no active-terminal key event exists for it.
    h.user('initial command-line task', remoteAt(2000));
    h.apply('complete', 'initial', 2100); h.store.acknowledge(h.project.id);
    h.s.conversation.reset(); h.user('initial command-line task', remoteAt(2000));
    h.user('older history', remoteAt(900));
    h.apply('working', null, 2200); h.apply('complete', 'idle', 2300);
    assert.equal(h.alerts(), 1); assert.equal(h.project.completionArmed, false);
    for (const [keys, prompt, at] of [['\x1b[A\r', 'recalled task', 3000], ['/custom-task\r', 'expanded custom task', 4000]]) {
      h.now(at); h.write(keys);
      assert.equal(h.project.completionArmed, false, 'an unknown menu choice/slash command alone is not a round');
      h.user(prompt, remoteAt(at + 1)); h.apply('complete', `turn-${at}`, at + 100);
      h.store.acknowledge(h.project.id);
    }
    assert.equal(h.alerts(), 3);
    h.user('late prompt from already completed work', remoteAt(4050));
    h.apply('complete', 'late-background', 4300);
    assert.equal(h.alerts(), 3); assert.equal(h.project.unread, 0);
    codexConversation(h.s.conversation, { type: 'event_msg', timestamp: new Date(remoteAt(4500)).toISOString(),
      payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'modern-user', content: [{ type: 'input_text', text: 'modern prompt' }] } } });
    h.apply('complete', 'modern-turn', 4600);
    assert.equal(h.alerts(), 4);
    h.s.conversation.put({ id: 'answer', role: 'user', answer: true, at: remoteAt(5000), text: 'permission answer' });
    assert.equal(h.project.completionArmed, false);
  }
});

test('Claude UserPromptSubmit arms actual rounds, while local commands, duplicate hooks and generic working snapshots do not', async t => {
  for (const kind of ['local', 'ssh']) {
    const h = await harness(t, kind, 'claude');
    const hook = (state, id, prompt) => h.context.claudeActivity(h.project, h.s, { state, eventId: `session:${id}`, sessionId: 'session', prompt });
    hook('working', 'start', 'first actual prompt'); h.now(2100); hook('complete', 'stop');
    h.store.acknowledge(h.project.id);
    hook('working', 'start', 'first actual prompt'); hook('complete', 'background-stop');
    assert.equal(h.alerts(), 1); assert.equal(h.project.unread, 0);
    hook('working', 'local-command', '/context'); hook('complete', 'local-command-stop');
    assert.equal(h.project.completionArmed, false);
    h.now(2300); hook('working', 'custom-command', '/custom-task');
    h.now(2400); hook('complete', 'custom-stop');
    assert.equal(h.alerts(), 2);
  }
});

test('restore routes Claude to its own local/SSH gate and only interrupted work arms completion', async t => {
  const id = '00000000-0000-4000-8000-000000000001';
  for (const kind of ['local', 'ssh']) for (const interrupted of [false, true]) {
    const h = await harness(t, kind, 'claude'), writes = [], follows = [];
    h.store.setRestore(h.s.terminalId, { agent: 'claude', threadId: id, interrupted });
    Object.assign(h.s, { ready: true, codexActive: false, claudeAvailable: true, codexAvailable: false,
      gate: { input: text => writes.push(['input', text]), afterPrompt: text => writes.push(['afterPrompt', text]) },
      terminal: { request: () => assert.fail('Claude must never request Codex resume-info') } });
    h.context.followClaudeSession = async (...args) => follows.push(args);
    h.context.restorePlans.set(h.s.terminalId, { codex: true });
    await h.context.resumeAfterPrompt(h.project, h.s);
    assert.deepEqual(writes, [[kind === 'ssh' ? 'input' : 'afterPrompt', `claude --resume ${id}${interrupted ? ' "继续"' : ''}\r`]]);
    assert.equal(follows.length, kind === 'ssh' ? 0 : 1); assert.equal(h.s.claudeResumeId, id);
    assert.equal(h.project.completionArmed, interrupted);
    // Exercise the real activity/store boundary after restart, with no new manually typed prompt.
    h.s.codexActive = true; h.apply('complete', 'restored', 3000);
    assert.equal(h.alerts(), interrupted ? 1 : 0);
    h.store.acknowledge(h.project.id); h.apply('working', null, 3100); h.apply('complete', 'background', 3200);
    assert.equal(h.alerts(), interrupted ? 1 : 0);
  }
});

test('restore preserves plan/readiness/input safeguards and the recorded newest-Claude fallback', async t => {
  for (const change of ['no-plan', 'not-ready', 'dirty', 'active', 'not-installed', 'terminal-only']) {
    const h = await harness(t, 'ssh', 'claude'), writes = [];
    h.store.setRestore(h.s.terminalId, { agent: 'claude' });
    Object.assign(h.s, { ready: true, codexActive: false, claudeAvailable: true, gate: { input: text => writes.push(text) } });
    h.context.restorePlans.set(h.s.terminalId, { codex: true });
    if (change === 'no-plan') h.context.restorePlans.clear();
    if (change === 'not-ready') h.s.ready = false;
    if (change === 'dirty') h.s.inputDirty = true;
    if (change === 'active') h.s.codexActive = true;
    if (change === 'not-installed') h.s.claudeAvailable = false;
    if (change === 'terminal-only') h.context.restorePlans.set(h.s.terminalId, { codex: false });
    await h.context.resumeAfterPrompt(h.project, h.s);
    assert.deepEqual(writes, [], change);
  }
  const h = await harness(t, 'ssh', 'claude'), writes = [];
  h.store.setRestore(h.s.terminalId, { agent: 'claude' });
  Object.assign(h.s, { ready: true, codexActive: false, claudeAvailable: true, gate: { input: text => writes.push(text) } });
  h.context.restorePlans.set(h.s.terminalId, { codex: true });
  await h.context.resumeAfterPrompt(h.project, h.s);
  assert.deepEqual(writes, ['claude --continue\r']);
});

test('local and remote Codex restoration retain routing, interrupted continuation and in-flight input guards', async t => {
  const id = '00000000-0000-4000-8000-000000000002';
  for (const kind of ['local', 'ssh']) for (const state of ['complete', 'interrupted']) {
    const h = await harness(t, kind), writes = [], requests = [];
    h.store.setRestore(h.s.terminalId, { agent: 'codex', threadId: id });
    const info = { id, state };
    h.context.recentSession = async () => info;
    Object.assign(h.s, { ready: true, codexActive: false, codexAvailable: true,
      gate: { input: text => writes.push(['input', text]), afterPrompt: text => writes.push(['afterPrompt', text]) },
      terminal: { request: async (op, args) => { requests.push([op, args.threadId]); return info; } } });
    h.context.restorePlans.set(h.s.terminalId, { codex: true });
    await h.context.resumeAfterPrompt(h.project, h.s);
    assert.deepEqual(writes, [[kind === 'ssh' ? 'input' : 'afterPrompt', `codex resume ${id}${state === 'interrupted' ? ' "继续"' : ''}\r`]]);
    assert.deepEqual(requests, kind === 'ssh' ? [['resume-info', id]] : []);
    assert.equal(h.project.completionArmed, state === 'interrupted');
    h.s.codexActive = true; h.apply('complete', 'codex-restored', 3000);
    assert.equal(h.alerts(), state === 'interrupted' ? 1 : 0);
  }
  const h = await harness(t, 'ssh');
  Object.assign(h.s, { ready: true, codexActive: false, codexAvailable: true,
    gate: { input: () => assert.fail('typed input must cancel in-flight restore') },
    terminal: { request: async () => { h.s.inputDirty = true; return { id, state: 'interrupted' }; } } });
  h.context.restorePlans.set(h.s.terminalId, { codex: true });
  await h.context.resumeAfterPrompt(h.project, h.s);
  assert.equal(h.project.completionArmed, false);
});

test('the local-only Claude session follower rejects SSH before accessing any local transcript', async t => {
  const h = await harness(t, 'ssh', 'claude');
  h.context.findClaudeSession = () => assert.fail('must not look for remote Claude sessions locally');
  vm.runInContext(main.slice(main.indexOf('async function followClaudeSession('), main.indexOf('// One place turns an agent')), h.context);
  assert.equal(await h.context.followClaudeSession(h.project, h.s, 'remote-session'), false);
});

test('two SSH Claude terminals restore their own recorded conversations through their own gates', async t => {
  const h = await harness(t, 'ssh', 'claude'), writes = [];
  const secondId = h.store.addTerminal(h.project.id);
  const second = { terminalId: secondId };
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  [h.s, second].forEach((s, index) => {
    Object.assign(s, { ready: true, inputDirty: false, codexActive: false, claudeAvailable: true, codexAvailable: false,
      gate: { input: command => writes.push([s.terminalId, command]) },
      terminal: { request: () => assert.fail('no extra remote query or login is needed') } });
    h.sessions.set(s.terminalId, s);
    h.store.setRestore(s.terminalId, { agent: 'claude', threadId: ids[index] });
    h.context.restorePlans.set(s.terminalId, { codex: true });
  });
  await Promise.all([h.context.resumeAfterPrompt(h.project, h.s), h.context.resumeAfterPrompt(h.project, second)]);
  assert.deepEqual(writes, [[h.s.terminalId, `claude --resume ${ids[0]}\r`], [secondId, `claude --resume ${ids[1]}\r`]]);
  assert.equal(h.s.claudeResumeId, ids[0]); assert.equal(second.claudeResumeId, ids[1]);
});

test('desktop task fixture emits a fresh received prompt that completes through the real reader and store, and releases its shell', async t => {
  const { runDesktopTask } = await import('./helpers/desktop-task-fixture.mjs');
  const { CodexActivityReader } = require('../electron/codex-activity.cjs');
  for (const observationFails of [false, true]) {
    const h = await harness(t), home = path.join(h.project.path, 'codex-home'), records = [], waits = [];
    h.s.codexActive = false;
    const page = { evaluate: async (_callback, args) => {
      if (args) {
        assert.equal(args.id, h.project.id);
        assert.ok(args.command.includes("Send-AgentrixEvent 'codex-started'"));
        assert.ok(args.command.includes("Send-AgentrixEvent 'codex-exited'"));
        assert.ok(args.command.includes('Test-Path -LiteralPath'));
        // Simulate only shell startup, leaving notification arming to the real rollout/input path below.
        h.s.codexActive = true; h.s.activitySince = Date.now(); h.now(h.s.activitySince);
        return;
      }
      return { value: { projects: [{ ...h.project, codexActive: h.s.codexActive, shellReady: !h.s.codexActive }] } };
    } };
    const waitFor = async (predicate, label) => {
      waits.push(label);
      if (label === 'interactive parent task completion') {
        const reader = new CodexActivityReader(h.project.path, home, h.s.activitySince, {
          onRecord: record => { records.push(record); codexConversation(h.s.conversation, record, h.project.path); },
        });
        const snapshot = await reader.read();
        assert.equal(snapshot.state, 'complete');
        h.context.applyActivity(h.project, h.s, snapshot);
        if (observationFails) throw new Error('completion observation failed');
      }
      if (label === 'offline task returns to shell') {
        const release = (await fs.readdir(h.project.path)).find(name => name.startsWith('.task-'));
        assert.equal(await fs.readFile(path.join(h.project.path, release), 'utf8'), 'done');
        h.s.codexActive = false;
      }
      assert.equal(await predicate(), true, label);
    };
    const running = runDesktopTask(page, h.project, home, 'fixture-input-turn', waitFor);
    if (observationFails) await assert.rejects(running, /completion observation failed/);
    else await running;
    assert.deepEqual(records.map(record => record.type === 'event_msg' ? record.payload.type : record.type),
      ['session_meta', 'task_started', 'user_message', 'task_complete']);
    const [meta, started, prompt, completed] = records;
    assert.match(meta.payload.id, /^[a-f\d-]{36}$/i);
    assert.equal(meta.payload.source, 'cli'); assert.equal(meta.payload.cwd, h.project.path);
    assert.equal(started.payload.turn_id, 'fixture-input-turn'); assert.equal(completed.payload.turn_id, started.payload.turn_id);
    assert.equal(prompt.payload.message, 'Run desktop test task fixture-input-turn.');
    assert.ok(Date.parse(prompt.timestamp) >= h.s.activitySince, 'received input is newer than shell startup');
    assert.ok(Date.parse(started.timestamp) <= Date.parse(prompt.timestamp) && Date.parse(prompt.timestamp) <= Date.parse(completed.timestamp));
    assert.equal(h.project.unread, 1); assert.equal(h.project.completionArmed, false); assert.equal(h.alerts(), 1);
    assert.equal(h.project.lastCompletedAt, Date.parse(completed.timestamp));
    assert.equal(await fs.readFile(path.join(h.project.path, `.task-${meta.payload.id}.done`), 'utf8'), 'done', 'finally releases the occupied shell on success or failure');
    assert.deepEqual(waits, ['offline task starts', 'interactive parent task completion', ...(observationFails ? [] : ['offline task returns to shell'])]);
  }
});

test('visual smoke fixture records arm only its two fresh submissions, while duplicate completion and reopened history stay quiet', async t => {
  const { CodexActivityReader } = require('../electron/codex-activity.cjs');
  const h = await harness(t), home = path.join(h.project.path, 'visual-home');
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  const thread = '00000000-0000-4000-8000-000000000003';
  const transcript = path.join(home, 'sessions', `rollout-${thread}.jsonl`);
  // Execute just the real fixture's record builders and file writes, without importing its GUI runner.
  const source = await fs.readFile(path.join(__dirname, '../scripts/visual-smoke.mjs'), 'utf8');
  const lines = source.split(/\r?\n/);
  const builders = lines.filter(line => /^\s*const (record|submitted) =/.test(line));
  const writes = lines.filter(line => /^\s*await fs\.(writeFile|appendFile)\(transcript,/.test(line));
  assert.equal(builders.length, 2); assert.equal(writes.length, 5);
  Object.assign(h.context, { fs, thread, transcript, projects: [h.project] });
  const Clock = h.context.Date;
  h.context.Date = class extends Clock { constructor(...args) { super(...(args.length ? args : [Clock.now()])); } };
  vm.runInContext(builders.join('\n'), h.context);
  const records = [];
  const reader = new CodexActivityReader(h.project.path, home, h.s.activitySince, {
    onRecord: record => { records.push(record); codexConversation(h.s.conversation, record, h.project.path); },
  });
  for (let index = 0; index < writes.length; index++) {
    h.now(2000 + index * 100);
    await vm.runInContext(`(async () => { ${writes[index]} })()`, h.context);
    h.context.applyActivity(h.project, h.s, await reader.read());
    if (index === 0 || index === 3) {
      assert.equal(h.s.codexActivity, 'working'); assert.equal(h.project.completionArmed, true);
    } else {
      assert.equal(h.s.codexActivity, 'complete'); assert.equal(h.project.completionArmed, false);
    }
    assert.equal(h.alerts(), index === 0 ? 0 : index < 4 ? 1 : 2);
    if (index === 1) h.store.acknowledge(h.project.id);
    if (index === 2 || index === 3) assert.equal(h.project.unread, 0, 'duplicate completion cannot rearm the acknowledged result');
  }
  assert.equal(records[0].payload.id, thread); assert.equal(records[0].payload.cwd, h.project.path);
  const prompts = records.filter(record => record.payload.type === 'user_message');
  assert.deepEqual(prompts.map(record => record.payload.message), ['验证独立项目的任务状态', '继续验证下一轮任务完成后的提醒']);
  assert.deepEqual(prompts.map(record => Date.parse(record.timestamp)), [2000, 2300]);
  assert.equal(h.project.unread, 1); assert.equal(h.project.lastCompletedAt, 2400);
  h.store.acknowledge(h.project.id);
  h.s.activitySince = 2500; h.s.activityPromptAt = 0;
  const reopened = new CodexActivityReader(h.project.path, home, h.s.activitySince, {
    onRecord: record => codexConversation(h.s.conversation, record, h.project.path),
  });
  h.context.applyActivity(h.project, h.s, await reopened.read());
  assert.equal(h.alerts(), 2); assert.equal(h.project.unread, 0); assert.equal(h.project.completionArmed, false);
});
