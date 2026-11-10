const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

function fixture({ wrongIdentity = false } = {}) {
  const agent = 'claude';
  const call = { id: 'dispatch:worker', dispatch: true, title: 'Worker', cwd: '/synthetic' }, saves = [], signals = [];
  const old = { nativeStructured: true, sessionId: 'old-pty', sessionKey: 'same-key', controlCapability: 'same-capability',
    bootstrapFile: '/synthetic/old-bootstrap', nativeSpec: {}, terminalId: 't', projectId: 'p', agent, codexActive: true,
    claudeSessionId: 'same-conversation', promptQueue: { items: [], changed() {} }, completionWork: { changed() {} }, calls: { byId: () => call } };
  const project = { id: 'p', kind: 'local', path: '/synthetic' };
  const sessions = new Map([['t', old]]);
  const context = { sessions, nativeSpecs: new Map(), launchPlans: new Map(), store: { findTerminal: () => ({ project }), setRestore: (_id, value) => saves.push(value) },
    launchCommand: (_agent, history) => { assert.equal(history.id, 'same-conversation'); return 'synthetic-resume'; }, broadcast() {},
    startTerminal(id, _mode, _starting, previous) {
      sessions.set(id, { sessionId: 'new-pty', terminalId: id, projectId: 'p', agent, codexActive: true,
        sessionKey: 'same-key', controlCapability: 'same-capability', bootstrapFile: '/synthetic/new-bootstrap', switchPreviousHost: previous,
        native: null, reportedThreadId: null,
        claudeSessionId: wrongIdentity ? 'wrong-conversation' : 'same-conversation', status: wrongIdentity ? 'exited' : 'codex',
        cliState: { sessionId: 'new-pty', state: 'idle' }, completionWork: { changed() {} }, promptQueue: { changed() {} } });
    }, disposeTerminal(id, options) { assert.equal(options.preserveSwitch, true); sessions.delete(id); },
    findProject: () => project, applyActivity: () => signals.push('activity'), scheduleState: () => signals.push('state'), setTimeout,
    publishCliState(host, state) { host.cliState = { sessionId: host.sessionId, state }; },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function localSwitchSessions('), source.indexOf('async function initializeNativeSessions(')), context);
  vm.runInContext(source.slice(source.indexOf('function resolveIntervention('), source.indexOf('const interventions =')), context);
  return { context, old, saves, signals, sessions };
}
test('I3/I5: staged terminal keeps the native surface until commit and preserves dispatch/intervention identity without a completion signal', async () => {
  const f = fixture(), before = f.context.resolveIntervention('t', 'dispatch:worker').parentSessionId;
  const prepared = await f.context.prepareSwitchTerminal({ terminalId: 't', providerSessionId: 'same-conversation', agent: 'claude', runtimeSessionId: 'new' }, {}, () => true);
  const staged = f.sessions.get('t');
  assert.equal(staged.switchPreviousHost, f.old); assert.equal(f.saves.length, 0);
  prepared.commit();
  assert.equal(staged.switchPreviousHost, undefined); assert.equal(staged.calls, f.old.calls);
  assert.equal(staged.completionWork, f.old.completionWork); assert.equal(staged.promptQueue, f.old.promptQueue);
  assert.equal(f.context.resolveIntervention('t', 'dispatch:worker').parentSessionId, before);
  assert.equal(f.saves[0].nativeTransport, null); assert.equal(f.saves[0].threadId, 'same-conversation');
  assert.equal(f.signals.length, 0, 'no completion or activity callback is fired by the handoff');
});

test('I4: a wrong terminal resume identity restores the original native surface and its control binding', async () => {
  const f = fixture({ wrongIdentity: true });
  await assert.rejects(f.context.prepareSwitchTerminal({ terminalId: 't', providerSessionId: 'same-conversation', agent: 'claude', runtimeSessionId: 'new' }, {}, () => true), /session_changed/);
  assert.equal(f.sessions.get('t'), f.old); assert.equal(f.saves.length, 0); assert.equal(f.signals.length, 0);
});

test('a live terminal cold start can pass fifteen seconds and still resume the exact provider', async () => {
  const f = fixture(), start = f.context.startTerminal;
  let elapsed = 0, waits = 0;
  f.context.Date = { now: () => elapsed };
  f.context.startTerminal = (...args) => {
    start(...args);
    Object.assign(f.sessions.get('t'), { status: 'starting', claudeSessionId: null, cliState: null });
  };
  f.context.setTimeout = callback => setImmediate(() => {
    elapsed += 16000; waits++;
    if (waits === 2) Object.assign(f.sessions.get('t'), {
      status: 'codex', claudeSessionId: 'same-conversation', cliState: { sessionId: 'new-pty', state: 'idle' },
    });
    callback();
  });
  const prepared = await f.context.prepareSwitchTerminal({ terminalId: 't', providerSessionId: 'same-conversation', agent: 'claude', runtimeSessionId: 'new' }, {}, () => true);
  assert.equal(elapsed, 32000);
  assert.equal(f.sessions.get('t').switchPreviousHost, f.old, 'keep the API view until actual readiness');
  assert.equal(f.saves.length, 0, 'elapsed time cannot commit or abandon the source');
  prepared.commit();
  assert.equal(f.saves[0].threadId, 'same-conversation');
});

test('an owner cancellation during terminal startup reaps the staged host and preserves the source', async () => {
  const f = fixture(), start = f.context.startTerminal;
  let current = true;
  f.context.startTerminal = (...args) => { start(...args); Object.assign(f.sessions.get('t'), { status: 'starting', claudeSessionId: null, cliState: null }); };
  f.context.setTimeout = callback => setImmediate(() => { current = false; callback(); });
  await assert.rejects(f.context.prepareSwitchTerminal({ terminalId: 't', providerSessionId: 'same-conversation', agent: 'claude', runtimeSessionId: 'new' }, {}, () => current), /session_changed/);
  assert.equal(f.sessions.get('t'), f.old);
  assert.equal(f.saves.length, 0);
});

for (const failure of ['error', 'identity']) test(`terminal startup fails on confirmed ${failure}, rather than waiting indefinitely`, async () => {
  const f = fixture(), start = f.context.startTerminal;
  f.context.startTerminal = (...args) => {
    start(...args);
    Object.assign(f.sessions.get('t'), failure === 'error' ? { error: 'missing executable' } : { claudeSessionId: 'wrong-conversation' });
  };
  await assert.rejects(f.context.prepareSwitchTerminal({ terminalId: 't', providerSessionId: 'same-conversation', agent: 'claude', runtimeSessionId: 'new' }, {}, () => true),
    failure === 'error' ? /terminal_start_failed/ : /terminal_resume_identity_mismatch/);
  assert.equal(f.sessions.get('t'), f.old);
  assert.equal(f.saves.length, 0);
});

test('quota handoff uses tracked paste and Enter once; CLI drafts and concurrent edits never get cleared or submitted', async () => {
  for (const draft of [false, true, 'concurrent']) {
    const f = fixture(), writes = [];
    const { SubmissionTracker } = require('../electron/terminal-input.cjs');
    f.context.terminalInput = { write(_id, data) { writes.push(data); f.sessions.get('t').submissions.write(data); } };
    const prepared = await f.context.prepareSwitchTerminal({ terminalId: 't', providerSessionId: 'same-conversation', agent: 'claude', runtimeSessionId: 'new' }, {}, () => true);
    const tracker = f.sessions.get('t').submissions = new SubmissionTracker();
    if (draft === true) tracker.write('Owner CLI draft');
    prepared.commit();
    const sending = prepared.send({ text: 'Rejected input' });
    if (draft === 'concurrent') tracker.write(' new owner text');
    const result = await sending;
    assert.equal(result.status, draft === false ? 'delivered' : draft === true ? 'rejected' : 'unknown');
    assert.equal(writes.filter(data => data === '\r').length, draft === false ? 1 : 0);
    assert.ok(writes.every(data => !data.includes('\x15')), 'no Ctrl+U on any path');
    if (draft === true) assert.equal(tracker.text, 'Owner CLI draft');
  }
});

test('a confirmed shell prompt after the launched CLI exits fails immediately instead of waiting for the resume timeout', async () => {
  const f = fixture(), start = f.context.startTerminal;
  f.context.startTerminal = (...args) => {
    start(...args); f.context.launchPlans.clear();
    Object.assign(f.sessions.get('t'), { ready: true, status: 'shell', agentStarting: false, codexActive: false, cliState: null });
  };
  await assert.rejects(f.context.prepareSwitchTerminal({ terminalId: 't', providerSessionId: 'same-conversation', agent: 'claude', runtimeSessionId: 'new' }, {}, () => true), /terminal_agent_exited/);
  assert.equal(f.sessions.get('t'), f.old); assert.equal(f.saves.length, 0);
});
test('after a failed switch the late exit and prompt reports of the staged terminal leave the restored native host as it was', async () => {
  const f = fixture(), start = f.context.startTerminal;
  f.context.startTerminal = (...args) => { start(...args); f.sessions.get('t').error = 'the CLI exited'; };
  await assert.rejects(f.context.prepareSwitchTerminal({ terminalId: 't', providerSessionId: 'same-conversation', agent: 'claude', runtimeSessionId: 'new' }, {}, () => true), /terminal_start_failed/);
  const main = { sessions: f.sessions, store: { projects: [{ id: 'p' }] }, acceptShellEvent: require('../electron/terminal-input.cjs').acceptShellEvent };
  vm.createContext(main);
  vm.runInContext(source.slice(source.indexOf('function onEvent('), source.indexOf('const launchPlans = new Map();')), main);
  f.old.status = 'codex';
  // The staged shell reports under the key the host keeps: its CLI's exit, then its next prompt.
  main.onEvent({ projectId: 't', sessionKey: 'same-key', type: 'codex-exited', agent: 'claude', sequence: 4, exitCode: 2 });
  main.onEvent({ projectId: 't', sessionKey: 'same-key', type: 'shell-prompt', sequence: 5 });
  assert.equal(f.sessions.get('t'), f.old); assert.equal(f.old.status, 'codex'); assert.equal(f.old.codexActive, true); assert.equal(f.old.error, undefined);
});
test('terminal text blocks switching, but an arrow/history key alone is not proof of a draft', () => {
  const f = fixture();
  const host = { sessionId: 'pty', cliState: { sessionId: 'pty', state: 'idle' }, submissions: { hasText: true, history: false }, promptQueue: { list: () => [] } };
  assert.equal(f.context.observeSwitchTerminal({ identity: host }).draftBlocked, true);
  host.submissions = { hasText: false, history: true };
  assert.equal(f.context.observeSwitchTerminal({ identity: host }).draftBlocked, false);
  assert.equal(f.context.observeSwitchTerminal({ identity: host }).background.known, false);
});

test('a fresh idle Claude with no transcript has an empty observation; unavailable and resumed history remain unknown', () => {
  const f = fixture();
  const host = { agent: 'claude', sessionId: 'pty', cliState: { sessionId: 'pty', state: 'idle' },
    claudeSessionSource: 'startup', claudeTranscript: { missing: true }, completionWork: { reading: true, tasks: new Map(), services: new Set() } };
  const session = { identity: host, spec: { hasHistory: false } };
  const background = () => JSON.parse(JSON.stringify(f.context.observeSwitchTerminal(session).background));
  assert.deepEqual(background(), { known: true, count: 0 });
  host.completionWork.tasks.set('job', { id: 'job' });
  assert.deepEqual(background(), { known: true, count: 1 }, 'other observations are still counted');
  for (const patch of [{ claudeResumeId: 'old' }, { activityInputAt: 1 }, { claudeTranscript: { missing: false } }]) {
    Object.assign(host, patch); assert.equal(background().known, false);
    delete host.claudeResumeId; delete host.activityInputAt; host.claudeTranscript = { missing: true };
  }
  host.claudeSessionSource = 'resume'; assert.equal(background().known, false); host.claudeSessionSource = 'startup';
  host.completionWork.uncertain = true; assert.equal(background().known, false);
});
