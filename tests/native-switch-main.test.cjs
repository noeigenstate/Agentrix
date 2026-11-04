const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

function fixture({ wrongIdentity = false, agent = 'claude' } = {}) {
  const call = { id: 'dispatch:worker', dispatch: true, title: 'Worker', cwd: '/synthetic' }, saves = [], signals = [];
  const old = { nativeStructured: true, sessionId: 'old-pty', sessionKey: 'same-key', controlCapability: 'same-capability',
    bootstrapFile: '/synthetic/old-bootstrap', nativeSpec: {}, terminalId: 't', projectId: 'p', agent, codexActive: true,
    claudeSessionId: 'same-conversation', promptQueue: { items: [], changed() {} }, completionWork: { changed() {} }, calls: { byId: () => call } };
  const project = { id: 'p', kind: 'local', path: '/synthetic' };
  const sessions = new Map([['t', old]]);
  const context = { sessions, nativeSpecs: new Map(), launchPlans: new Map(), store: { findTerminal: () => ({ project }), setRestore: (_id, value) => saves.push(value) },
    launchCommand: (_agent, history) => { assert.equal(history.id, 'same-conversation'); return 'synthetic-resume'; }, broadcast() {},
    startTerminal(id, mode, _starting, previous, resumeThreadId) {
      if (agent === 'codex') { assert.equal(mode, 'codex-native'); assert.equal(resumeThreadId, 'same-conversation'); }
      sessions.set(id, { sessionId: 'new-pty', terminalId: id, projectId: 'p', agent, codexActive: true,
        sessionKey: 'same-key', controlCapability: 'same-capability', bootstrapFile: '/synthetic/new-bootstrap', switchPreviousHost: previous,
        native: agent === 'codex', switchResumeThreadId: resumeThreadId, reportedThreadId: agent === 'codex' ? 'same-conversation' : null,
        claudeSessionId: wrongIdentity ? 'wrong-conversation' : 'same-conversation', status: wrongIdentity ? 'exited' : 'codex',
        cliState: { sessionId: 'new-pty', state: 'idle' }, completionWork: { changed() {} }, promptQueue: { changed() {} } });
    }, disposeTerminal(id, options) { assert.equal(options.preserveSwitch, true); sessions.delete(id); },
    findProject: () => project, applyActivity: () => signals.push('activity'), scheduleState: () => signals.push('state'), setTimeout,
    publishCliState(host, state) { host.cliState = { sessionId: host.sessionId, state }; },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function localSwitchSessions('), source.indexOf('async function initializeNativeSessions(')), context);
  vm.runInContext(source.slice(source.indexOf('function resolveIntervention('), source.indexOf('const interventions =')), context);
  vm.runInContext(source.slice(source.indexOf('function nativeSessionEvent('), source.indexOf('function nativeSpec(')), context);
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

test('main waits for the correlated Codex resume acknowledgement, then carries the replacement host identity forward', async () => {
  const f = fixture({ agent: 'codex' });
  const spec = { terminalId: 't', providerSessionId: 'same-conversation', agent: 'codex', runtimeSessionId: 'new' };
  let committed = false;
  const pending = f.context.prepareSwitchTerminal(spec, {}, () => true).then(value => { committed = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(committed, false, 'a matching title and idle state do not prove TUI resume');
  const ack = threadId => ({ method: 'agentrix/threadResumed', params: { threadId, requestId: 'request' } });
  f.context.nativeSessionEvent('t', 'old-pty', ack('same-conversation'));
  f.context.nativeSessionEvent('t', 'new-pty', ack('wrong-conversation'));
  assert.equal(f.sessions.get('t').nativeResumeReady, undefined);
  f.context.nativeSessionEvent('t', 'new-pty', ack('same-conversation'));
  const prepared = await pending; prepared.commit();
  assert.equal(spec.sessionId, 'new-pty'); assert.equal(spec.bootstrapFile, '/synthetic/new-bootstrap');
  assert.equal(f.saves[0].threadId, 'same-conversation'); assert.equal(f.signals.length, 0);
});
test('I4: a wrong terminal resume identity restores the original native surface and its control binding', async () => {
  const f = fixture({ wrongIdentity: true });
  await assert.rejects(f.context.prepareSwitchTerminal({ terminalId: 't', providerSessionId: 'same-conversation', agent: 'claude', runtimeSessionId: 'new' }, {}, () => true), /session_changed/);
  assert.equal(f.sessions.get('t'), f.old); assert.equal(f.saves.length, 0); assert.equal(f.signals.length, 0);
});
test('terminal text blocks switching, but an arrow/history key alone is not proof of a draft', () => {
  const f = fixture();
  const host = { sessionId: 'pty', cliState: { sessionId: 'pty', state: 'idle' }, submissions: { hasText: true, history: false }, promptQueue: { list: () => [] } };
  assert.equal(f.context.observeSwitchTerminal({ identity: host }).draftBlocked, true);
  host.submissions = { hasText: false, history: true };
  assert.equal(f.context.observeSwitchTerminal({ identity: host }).draftBlocked, false);
  assert.equal(f.context.observeSwitchTerminal({ identity: host }).background.known, false);
});
