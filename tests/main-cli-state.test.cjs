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
  h.advance(); h.hook('attention', { message: 'Approve', requestId: 'tool' }); assert.equal(h.frames.at(-1).state, 'waiting');
  h.advance(); h.hook('progress', { requestId: 'tool' }); assert.equal(h.frames.at(-1).state, 'working'); assert.equal(h.s.needsInput, null);
  h.s.activityMonitor = { poll: () => new Promise(() => {}) };
  h.advance(); h.hook('complete'); assert.equal(h.frames.at(-1).state, 'idle'); assert.equal(h.s.needsInput, null);
  assert.equal(h.beginnings(), 1); assert.equal(h.notifications(), 0);
  assert.ok(h.frames.every((frame, index) => !index || frame.revision >= h.frames[index - 1].revision));
  assert.ok(h.frames.at(-1).revision >= 4);
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
