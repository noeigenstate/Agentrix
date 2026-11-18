const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { CompletionWork, LOST_WORK_TIMEOUT } = require('../electron/completion-work.cjs');
const { createClaudeActivity } = require('../electron/features/terminal-events/claude-activity.cjs');
const { createDispatchIntake } = require('../electron/features/agents/dispatch-intake.cjs');

function fixture(t, agent = 'claude', nativeStructured = false) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 2000 });
  let armed = true, notifications = 0, alive = true, serial = 0;
  const completed = new Set(), project = { id: 'project', kind: 'local', path: '/synthetic' };
  const calls = new AgentCalls({ terminalId: 'terminal', local: true, dispatchAlive: () => alive });
  const s = { terminalId: 'terminal', projectId: project.id, sessionId: 'pty', sessionKey: 'synthetic',
    agent, nativeStructured, calls, codexActive: true, activitySince: 1000, claudeSessionId: 'provider', reportedThreadId: 'provider',
    completionWork: new CompletionWork(), promptQueue: { finish() {}, list: () => [] },
    actions: { settle() {} }, conversation: { settle() {}, list: [] } };
  const deps = { sessions: new Map([[s.terminalId, s]]), callsOf: () => calls,
    store: { projects: [project], setRestore() {}, expectCompletion(_id, value = true) { armed = value; },
      complete(_id, key) { if (!armed || completed.has(key)) return false; completed.add(key); armed = false; return true; } },
    broadcast() {}, scheduleState() {}, summarizeTask: () => '', refreshClaudeAccounts() {}, notifyCompletion() { notifications++; },
    memoryFolder: () => '', memoryDir: () => '', remember: async () => {}, roundsOf: () => [], scrubProjectSkills: async () => {},
    promptText: require('../electron/prompt-queue.cjs').promptText,
    isLocalAgentCommand: require('../electron/agent-commands.cjs').isLocalAgentCommand, rememberClaudeSource() {} };
  Object.assign(deps, createClaudeActivity(deps), createDispatchIntake(deps));
  deps.followClaude = () => {};
  deps.bindDispatchInbox(s, project);
  t.after(() => { deps.disposeDispatchInbox(); calls.dispose(); s.completionWork?.reset(); });
  const event = value => deps.acceptDispatchEvent(s, project, { projectId: s.terminalId, sessionKey: s.sessionKey, ...value });
  function begin() {
    t.mock.timers.tick(1);
    if (agent === 'claude' && !nativeStructured) deps.claudeActivity(project, s, { state: 'working', sessionId: 'provider',
      eventId: `provider:begin-${++serial}`, sentAt: Date.now(), prompt: 'Synthetic owner task' });
    else { s.completionWork?.begin(); deps.store.expectCompletion(project.id); deps.applyActivity(project, s, { state: 'working', threadId: 'provider', turnId: `turn-${++serial}`, updatedAt: Date.now() }); }
  }
  function end() {
    t.mock.timers.tick(1);
    if (agent === 'claude' && !nativeStructured) deps.claudeActivity(project, s, { state: 'complete', sessionId: 'provider',
      eventId: `provider:end-${++serial}`, sentAt: Date.now() });
    else deps.applyActivity(project, s, { state: 'complete', threadId: 'provider', turnId: `turn-${serial}`, updatedAt: Date.now() });
  }
  function launch() {
    const id = randomUUID();
    event({ type: 'dispatch-declared', id, agent: 'claude', role: '\u6267\u884c', title: 'Synthetic worker', cwd: '/synthetic', worktree: '/synthetic',
      requested: { model: 'opus', effort: 'high', fast: true }, helperPid: 12345, source: 'dispatch', at: Date.now() });
    assert.equal(calls.openDispatch().count > 0, true);
    return id;
  }
  function finish(id) { event({ type: 'dispatch-end', id, reason: 'exit', exitCode: 0, model: 'opus', effort: 'high', fast: true,
    endedAt: Date.now(), outputTokens: null, activeMs: null }); }
  return { calls, s, project, deps, begin, end, launch, finish, notifications: () => notifications, armed: () => armed,
    die: () => { alive = false; }, replay: () => deps.replayCompletion(project, s) };
}

for (const [agent, native] of [['claude', false], ['codex', false], ['claude', true]]) {
  test(`${agent} ${native ? 'native' : 'terminal'} waits for a declared dispatch and completes once on its end`, t => {
    const h = fixture(t, agent, native); h.begin(); const id = h.launch(); h.end();
    assert.equal(h.notifications(), 0); assert.equal(h.s.codexActivity, 'working');
    if (agent === 'claude' && !native) assert.equal(h.s.cliState.background, true);
    h.finish(id); assert.equal(h.notifications(), 1); assert.equal(h.s.codexActivity, 'complete');
    h.replay(); h.finish(id); assert.equal(h.notifications(), 1);
    if (agent === 'claude' && !native) assert.equal(h.s.cliState.background, false);
  });
}

test('two dispatches hold until both end, and a newer owner turn must end too', t => {
  const h = fixture(t); h.begin(); const first = h.launch(), second = h.launch(); h.end();
  h.finish(first); assert.equal(h.s.codexActivity, 'working'); assert.equal(h.notifications(), 0);
  h.begin(); h.finish(second); assert.equal(h.s.codexActivity, 'working'); assert.equal(h.notifications(), 0);
  h.end(); assert.equal(h.notifications(), 1);
});

test('the liveness sweep releases a killed helper once', async t => {
  const h = fixture(t); h.begin(); const id = h.launch(); h.end(); h.die();
  h.calls.refresh(id); await h.calls.work;
  t.mock.timers.tick(1001); h.calls.refresh(id); await h.calls.work;
  assert.equal(h.calls.calls.get(id).failure.reason, 'killed');
  assert.equal(h.notifications(), 1); h.replay(); assert.equal(h.notifications(), 1);
});

for (const [agent, native] of [['claude', false], ['codex', false], ['claude', true]]) {
test(`the dispatch deadline interrupts ${agent} ${native ? 'native' : 'terminal'} without notifying, including after late end`, t => {
  const h = fixture(t, agent, native); h.begin(); const id = h.launch();
  // The deadline timer is independent of the native CompletionWork changed callback.
  h.calls.local = false; clearTimeout(h.calls.timer); h.calls.timer = null;
  h.end(); t.mock.timers.tick(LOST_WORK_TIMEOUT);
  assert.equal(h.s.codexActivity, 'interrupted'); assert.equal(h.armed(), false); assert.equal(h.notifications(), 0);
  h.finish(id); assert.equal(h.notifications(), 0);
});
}

test('without dispatch runs completion is unchanged, and acknowledged holds never rearm', t => {
  const h = fixture(t); h.begin(); h.end(); assert.equal(h.notifications(), 1);
  const id = h.launch(); h.replay(); h.finish(id); h.replay(); assert.equal(h.notifications(), 1);
});

test('a fresh run board inherits no hold, and done or reviewed rows do not count', t => {
  const h = fixture(t), id = h.launch();
  const fresh = new AgentCalls({ local: false }); t.after(() => fresh.dispose());
  assert.deepEqual(fresh.openDispatch(), { count: 0, deadline: null });
  h.calls.calls.get(id).reviewed = true;
  assert.equal(h.calls.openDispatch().count, 0);
});

for (const [agent, native] of [['claude', false], ['codex', false], ['claude', true]]) {
  for (const fallback of [false, true]) {
    test(`an expired dispatch releases later ${agent} ${native ? 'native' : 'terminal'} rounds${fallback ? ' without CompletionWork' : ''}`, t => {
      const h = fixture(t, agent, native);
      if (fallback) h.s.completionWork = null;
      h.calls.local = false; // An SSH or hung helper has no local death proof.
      h.begin(); const old = h.launch(); h.end();
      t.mock.timers.tick(LOST_WORK_TIMEOUT);
      assert.equal(h.s.codexActivity, 'interrupted'); assert.equal(h.armed(), false); assert.equal(h.notifications(), 0);
      assert.deepEqual(h.calls.openDispatch(), { count: 0, deadline: null });
      assert.equal(h.calls.calls.get(old).done, false, 'expiry changes the hold, never invents a worker end');
      h.replay(); assert.equal(h.s.codexActivity, 'interrupted');
      if (fallback) {
        h.deps.applyActivity(h.project, h.s, { ...h.s.activityRawSnapshot, updatedAt: Date.now() });
        assert.equal(h.s.codexActivity, 'interrupted', 'a later snapshot of the same expired round stays interrupted');
      }
      h.begin(); assert.equal(h.s.codexActivity, 'working'); assert.equal(h.armed(), true);
      const fresh = h.launch(); h.end();
      assert.equal(h.s.codexActivity, 'working'); assert.equal(h.notifications(), 0);
      h.finish(fresh); assert.equal(h.s.codexActivity, 'complete'); assert.equal(h.notifications(), 1);
      h.finish(old); h.replay(); assert.equal(h.notifications(), 1);
    });
  }
  test(`a newer working ${agent} ${native ? 'native' : 'terminal'} turn is not interrupted by the predecessor hold deadline`, t => {
    const h = fixture(t, agent, native); h.calls.local = false;
    h.begin(); h.launch(); h.end(); h.begin();
    t.mock.timers.tick(LOST_WORK_TIMEOUT);
    assert.equal(h.s.codexActivity, 'working'); assert.equal(h.armed(), true);
    h.end(); assert.equal(h.s.codexActivity, 'complete'); assert.equal(h.notifications(), 1);
  });
}

test('activity publication never creates a run board and reads a retained board through host switches', t => {
  const h = fixture(t);
  const intakeLookup = h.deps.callsOf;
  delete h.s.calls;
  h.deps.callsOf = () => assert.fail('publication must only look up an existing tracker');
  assert.equal(AgentCalls.forTerminal(h.deps.sessions, h.s.terminalId), null);
  h.begin(); h.end(); assert.equal(h.notifications(), 1);
  assert.equal(AgentCalls.forTerminal(h.deps.sessions, h.s.terminalId), null);
  AgentCalls.forTerminal(h.deps.sessions, h.s.terminalId, () => h.calls);
  h.begin(); h.deps.callsOf = intakeLookup;
  const id = h.launch();
  h.deps.callsOf = () => assert.fail('publication must only look up an existing tracker');
  h.end(); assert.equal(h.notifications(), 1);
  h.s.switchPreviousHost = { terminalId: h.s.terminalId, calls: h.calls };
  h.s.calls = { openDispatch: () => assert.fail('the staged host does not own the live tracker') };
  h.replay(); assert.equal(h.s.codexActivity, 'working');
  h.calls.dispatch({ type: 'dispatch-end', id, reason: 'exit', exitCode: 0, model: 'opus', effort: 'high', fast: true,
    endedAt: Date.now(), outputTokens: null, activeMs: null });
  assert.equal(h.notifications(), 2);
});

test('without CompletionWork an already overdue hold interrupts the ended round', t => {
  const h = fixture(t); h.s.completionWork = null;
  h.s.calls = { openDispatch: () => ({ count: 1, deadline: Date.now() - 1 }) };
  h.begin(); h.end();
  assert.equal(h.s.codexActivity, 'interrupted'); assert.equal(h.armed(), false); assert.equal(h.notifications(), 0);
});

test('after the oldest dispatch lapses the timer still wakes for a newer held run', t => {
  const h = fixture(t, 'claude', true); h.calls.local = false;
  h.begin(); h.launch(); t.mock.timers.tick(10); h.launch(); h.end();
  t.mock.timers.tick(LOST_WORK_TIMEOUT - 11);
  assert.equal(h.s.codexActivity, 'interrupted'); assert.equal(h.calls.openDispatch().count, 1);
  h.begin(); h.end(); assert.equal(h.s.codexActivity, 'working');
  t.mock.timers.tick(8);
  assert.equal(h.s.codexActivity, 'interrupted'); assert.equal(h.calls.openDispatch().count, 0); assert.equal(h.notifications(), 0);
  h.begin(); h.end(); assert.equal(h.notifications(), 1);
});
