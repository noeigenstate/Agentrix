const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const ast = ts.createSourceFile('main.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['publishCliState', 'applyActivity', 'claudeActivity', 'onEvent']);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(ast)).join('\n');

function fixture(agent = 'claude') {
  let now = 2000, armed = false, notifications = 0, beginnings = 0;
  const frames = [], project = { id: 'p', kind: 'ssh' };
  const s = { terminalId: 't', projectId: 'p', sessionId: 'pty', sessionKey: 'cap', agent, codexActive: true, activitySince: 1000, activityInputAt: 0,
    claudeSessionId: agent === 'claude' ? 'provider' : null, reportedThreadId: agent === 'codex' ? 'provider' : null,
    promptQueue: { finish() {}, list: () => [] }, actions: { settle() {} }, conversation: { settle() {}, list: [] },
    completionWork: { begin() { beginnings++; }, end() {}, state: snapshot => snapshot.state } };
  const context = vm.createContext({ sessions: new Map([['t', s]]), Date: class extends Date { static now() { return now; } },
    broadcast() { frames.push(s.cliState && { ...s.cliState }); }, scheduleState: () => assert.fail('CLI transitions must not schedule delayed state'),
    store: { projects: [project], setRestore() {}, expectCompletion(_id, value = true) { armed = value; }, complete() { if (!armed) return false; armed = false; return true; } },
    notifyCompletion() { notifications++; }, summarizeTask: () => '', isLocalAgentCommand: require('../electron/agent-commands.cjs').isLocalAgentCommand,
    promptText: require('../electron/prompt-queue.cjs').promptText, followClaude() {}, memoryFolder: () => '', memoryDir: () => '', roundsOf: () => [],
    remember: async () => {}, setTimeout: () => ({ unref() {} }), refreshClaudeAccounts() {}, scrubProjectSkills: async () => {} });
  vm.runInContext(functions, context);
  let serial = 0;
  const hook = (state, extra = {}) => context.claudeActivity(project, s, { state, sessionId: 'provider', eventId: 'provider:hook-' + ++serial, sentAt: now, ...extra });
  return { s, frames, hook, context, project, advance(ms = 1) { now += ms; }, notifications: () => notifications, beginnings: () => beginnings,
    record(state, turnId, at = now) { context.applyActivity(project, s, { state, turnId, threadId: 'provider', updatedAt: at }); } };
}

test('host CLI transitions broadcast synchronously and Stop does not await a stalled transcript reader', () => {
  const h = fixture();
  h.hook('working', { prompt: 'Do the task' }); assert.equal(h.s.cliState.state, 'working'); assert.equal(h.beginnings(), 1);
  h.advance(); h.hook('attention', { hookEvent: 'PermissionRequest', message: 'Approve' }); assert.equal(h.frames.at(-1).state, 'waiting');
  h.advance(); h.hook('progress', { hookEvent: 'PostToolUse', requestId: 'sibling-tool' }); assert.equal(h.frames.at(-1).state, 'waiting'); assert.ok(h.s.needsInput);
  h.s.activityMonitor = { poll: () => new Promise(() => {}) };
  h.advance(); h.hook('complete'); assert.equal(h.frames.at(-1).state, 'idle'); assert.equal(h.s.needsInput, null);
  assert.equal(h.beginnings(), 1); assert.equal(h.notifications(), 0);
  assert.ok(h.frames.every((frame, index) => !index || frame.revision >= h.frames[index - 1].revision));
  assert.equal(h.frames.at(-1).revision, 4);
});

test('old session, old event time, duplicate events and another tool cannot clear newer attention', () => {
  const h = fixture(); h.hook('working', { prompt: 'Task' }); h.advance(10);
  h.hook('attention', { requestId: 'new-tool', eventId: 'new-attention' });
  const revision = h.s.cliState.revision;
  h.hook('complete', { sessionId: 'old-provider' });
  h.hook('complete', { sentAt: 2000 });
  h.hook('progress', { requestId: 'old-tool' });
  h.hook('working', { eventId: 'new-attention', prompt: 'duplicate' });
  h.record('complete', 'old-stop', 2000);
  assert.equal(h.s.cliState.revision, revision); assert.equal(h.s.cliState.state, 'waiting'); assert.equal(h.beginnings(), 1);
  assert.equal(h.context.publishCliState(h.s, 'idle', { expectedRevision: revision - 1 }), false);
});

test('a delayed Stop poll cannot overwrite an attention event with a newer revision', async () => {
  const h = fixture(); h.hook('working', { prompt: 'Task' }); h.advance();
  let finish;
  h.s.activityMonitor = { poll: () => new Promise(resolve => { finish = resolve; }) };
  h.hook('complete'); h.advance(); h.hook('attention', { message: 'New dialog' });
  const revision = h.s.cliState.revision;
  finish(); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.s.cliState.revision, revision); assert.equal(h.s.cliState.state, 'waiting'); assert.equal(h.notifications(), 0);
});

test('local command completion clears attention, while progress and repeated Stop never rearm completion', () => {
  const h = fixture();
  h.hook('working', { prompt: '/status' }); h.advance(); h.hook('attention'); h.advance(); h.hook('complete');
  assert.equal(h.s.cliState.state, 'idle'); assert.equal(h.s.needsInput, null); assert.equal(h.beginnings(), 0);
  h.advance(); h.hook('working', { prompt: 'Actual task' }); h.advance(); h.hook('complete');
  assert.equal(h.notifications(), 1);
  h.advance(); h.hook('progress'); h.advance(); h.hook('complete'); h.advance(); h.hook('complete');
  assert.equal(h.notifications(), 1); assert.equal(h.beginnings(), 1); assert.equal(h.s.cliState.state, 'idle');
});

test('a previous Codex turn cannot end a newer turn even when its callback arrives later', () => {
  const h = fixture('codex');
  h.record('working', 'one'); h.advance(); h.record('working', 'two');
  const revision = h.s.cliState.revision;
  h.advance(); h.record('complete', 'one'); assert.equal(h.s.cliState.revision, revision); assert.equal(h.s.codexActivity, 'working');
  h.advance(); h.record('complete', 'two'); assert.equal(h.s.cliState.state, 'idle');
  h.advance(); h.record('working', 'one'); assert.equal(h.s.cliState.state, 'idle');
});

test('a restarted CLI keeps PTY revisions monotonic and compact does not invent an idle round', () => {
  const h = fixture(); h.hook('working', { prompt: 'Task' }); const revision = h.s.cliState.revision;
  h.advance(); h.hook('session', { sessionSource: 'compact' }); assert.equal(h.s.cliState.state, 'working'); assert.equal(h.beginnings(), 1);
  h.s.cliState = h.s.cliStateMeta = h.s.cliProviderId = null;
  h.advance(); h.hook('session'); assert.ok(h.s.cliState.revision > revision);
});

test('authenticated Codex completion notify publishes idle immediately and rejects a previous turn', () => {
  const h = fixture('codex'); h.record('working', 'one'); h.advance();
  const notify = turnId => h.context.onEvent({ projectId: 't', sessionKey: 'cap', type: 'turn-complete', threadId: 'provider', turnId, eventId: 'provider:' + turnId });
  notify('one'); assert.equal(h.s.cliState.state, 'idle');
  h.advance(); h.record('working', 'two'); const revision = h.s.cliState.revision;
  h.advance(); notify('one'); assert.equal(h.s.cliState.revision, revision); assert.equal(h.s.cliState.state, 'working');
});

for (const notifyFirst of [false, true]) test(`Codex ${notifyFirst ? 'notify-first' : 'record-first'} completion settles its own turn once`, () => {
  const h = fixture('codex'), ended = [], finished = [];
  h.s.completionWork.end = at => ended.push(at); h.s.promptQueue.finish = at => finished.push(at);
  h.context.store.expectCompletion('p'); h.record('working', 'one');
  const record = () => h.record('complete', 'one', 2010);
  const notify = () => h.context.onEvent({ projectId: 't', sessionKey: 'cap', type: 'turn-complete', threadId: 'provider', turnId: 'one', eventId: 'provider:one' });
  h.advance(260);
  if (notifyFirst) { notify(); record(); } else { record(); notify(); }
  assert.ok(ended.includes(2010)); assert.ok(finished.includes(2010));
  assert.equal(h.s.codexActivity, 'complete'); assert.equal(h.notifications(), 1);
  notify(); record(); assert.equal(h.notifications(), 1); assert.equal(h.beginnings(), 0);
});

test('SSH notify before the next 250 ms poll does not hide its earlier remote completion record', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture('codex'); h.context.store.expectCompletion('p'); h.record('working', 'one');
  h.s.activityClockOffset = 60000;
  let endedAt = null; h.s.completionWork.end = at => { endedAt = at; };
  h.s.activityMonitor = { poll: () => new Promise(resolve => setTimeout(() => {
    h.record('complete', 'one', -57990 + h.s.activityClockOffset); resolve();
  }, 250)) };
  h.advance(50);
  h.context.onEvent({ projectId: 't', sessionKey: 'cap', type: 'turn-complete', threadId: 'provider', turnId: 'one', eventId: 'provider:one' });
  assert.equal(h.s.cliState.state, 'idle'); assert.equal(endedAt, null);
  h.advance(250); t.mock.timers.tick(250); await Promise.resolve();
  assert.equal(endedAt, 2010); assert.equal(h.s.codexActivity, 'complete'); assert.equal(h.notifications(), 1);
});

test('an uncorrelated PermissionRequest survives sibling progress and asynchronously reordered progress', () => {
  const h = fixture(); h.hook('working', { prompt: 'Task' }); h.advance(10);
  h.hook('attention', { hookEvent: 'PermissionRequest', message: 'Bash' });
  const revision = h.s.cliState.revision;
  for (const hookEvent of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'ElicitationResult']) {
    h.advance(); h.hook('progress', { hookEvent, requestId: 'sibling-tool' });
    h.hook('progress', { hookEvent, sentAt: 2000 });
  }
  assert.equal(h.s.cliState.revision, revision); assert.equal(h.s.cliState.state, 'waiting'); assert.equal(h.s.needsInput.message, 'Bash');
  h.advance(); h.hook('complete'); h.advance(); h.hook('progress', { hookEvent: 'PostToolUse', requestId: 'late-tool' });
  assert.equal(h.s.cliState.state, 'idle'); assert.equal(h.beginnings(), 1); assert.equal(h.notifications(), 1);
});

test('a late async tool observation cannot raise the working watermark above an earlier Stop', () => {
  const h = fixture(); h.hook('working', { prompt: 'Task' });
  const revision = h.s.cliState.revision;
  h.advance(100); h.hook('progress', { hookEvent: 'PostToolUse', requestId: 'delayed-child' });
  assert.equal(h.s.cliState.revision, revision);
  h.hook('complete', { sentAt: 2050 });
  assert.equal(h.s.cliState.state, 'idle'); assert.equal(h.notifications(), 1); assert.equal(h.beginnings(), 1);
});

test('progress releases a correlated host wait only with its exact request identity', () => {
  const h = fixture(); h.hook('working', { prompt: 'Task' }); h.advance();
  h.context.publishCliState(h.s, 'waiting', { requestId: 'root-request', message: 'Known request' });
  const revision = h.s.cliState.revision;
  h.advance(); h.hook('progress'); h.hook('progress', { requestId: 'other-request' });
  assert.equal(h.s.cliState.revision, revision);
  h.hook('progress', { requestId: 'root-request' });
  assert.equal(h.s.cliState.state, 'working'); assert.equal(h.s.needsInput, null); assert.equal(h.beginnings(), 1);
});
