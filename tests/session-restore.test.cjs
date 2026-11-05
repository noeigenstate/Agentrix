const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { claudeResumeCommand } = require('../electron/session-restore.cjs');
test('N3 Codex writes its crash marker and restoreTerminal verifies the thread before one continuation', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  for (const kind of ['local', 'ssh']) for (const lastStatus of ['inProgress', 'interrupted', 'completed']) {
    const saved = { agent: 'codex', threadId: 'thread', codex: true, nativeTransport: 'codex-app-server' }, calls = [];
    const host = { nativeStructured: true, nativeRuntimeSessionId: 'before-crash', nativeMessages: new Map(), completionWork: { begin() {} } };
    const context = vm.createContext({ sessions: new Map([['t', host]]), nativeSpecs: new Map([['t', { agent: 'codex' }]]), quitting: false,
      createNativeUsage: () => ({ apply() {} }), scheduleState() {}, applyActivity() {},
      store: { findTerminal: () => ({ project: { id: 'p', kind }, record: { restore: saved } }), expectCompletion() {}, setRestore(_id, patch) { Object.assign(saved, patch); } },
      restorePlans: new Map(), startupErrors: new Map(), broadcast() {}, startTerminal() { assert.fail('Codex restore cannot create a TUI'); },
      nativeSessions: { start: async (_id, options) => { assert.equal(options.resume, true); calls.push('resume'); return { runtimeSessionId: 'new' }; },
        async continueInterrupted(_id, runtime, beforeSend) { assert.equal(runtime, 'new'); calls.push('verify:' + lastStatus); if (lastStatus === 'completed') return;
          beforeSend(); assert.equal(saved.interrupted, false, 'marker persisted before delivery'); calls.push('continue'); } } });
    vm.runInContext(main.slice(main.indexOf('function structuredEvent('), main.indexOf('async function readNativeConnections(')), context);
    context.structuredEvent('t', { type: 'turn.started', runtimeSessionId: 'before-crash', providerSessionId: 'thread', turnId: 'turn', receivedAtMs: 1, payload: { origin: 'user' } });
    assert.equal(saved.interrupted, true, 'the product Codex event writes the marker, the test never sets it');
    context.structuredEvent('t', { type: 'turn.completed', runtimeSessionId: 'before-crash', providerSessionId: 'thread', turnId: 'turn', receivedAtMs: 2, payload: { status: 'interrupted' } });
    assert.equal(saved.interrupted, true, 'an explicit interrupted turn also remains resumable');
    vm.runInContext(main.slice(main.indexOf('function restoreTerminal('), main.indexOf('function startTerminal(')), context);
    await context.restoreTerminal('t');
    assert.deepEqual(calls, lastStatus === 'completed' ? ['resume', 'verify:completed'] : ['resume', 'verify:' + lastStatus, 'continue']);
    calls.length = 0; await context.restoreTerminal('t');
    assert.deepEqual(calls, lastStatus === 'completed' ? ['resume', 'verify:completed'] : ['resume'], 'a consumed marker never submits twice');
  }
});
test('Claude Code resumes its recorded conversation and continues only an unfinished turn', () => {
  const id = randomUUID();
  assert.equal(claudeResumeCommand({ agent: 'claude', threadId: id, interrupted: true }), `claude --resume ${id} "继续"\r`);
  assert.equal(claudeResumeCommand({ agent: 'claude', threadId: id }), `claude --resume ${id}\r`);
  assert.equal(claudeResumeCommand({ agent: 'claude' }), 'claude --continue\r', 'no recorded session continues the newest one in the folder');
  assert.throws(() => claudeResumeCommand({ agent: 'claude', threadId: 'x; rm -rf' }), /无效/);
});

test('a fast automatic continuation completing before restoreTerminal resolves is never rearmed', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const saved = { agent: 'codex', threadId: 'thread', codex: true, interrupted: true };
  let armed = false, armings = 0;
  const context = vm.createContext({ restorePlans: new Map(), startupErrors: new Map(), broadcast() {},
    store: { findTerminal: () => ({ record: { restore: saved } }), setRestore(_id, patch) { Object.assign(saved, patch); },
      expectCompletion() { armed = true; armings++; } },
    nativeSessions: { start: async () => ({ runtimeSessionId: 'runtime' }), async continueInterrupted(_id, _runtime, beforeSend) {
      beforeSend(); assert.equal(saved.interrupted, false);
      context.store.expectCompletion(); armed = false;
    } } });
  vm.runInContext(main.slice(main.indexOf('function restoreTerminal('), main.indexOf('function startTerminal(')), context);
  await context.restoreTerminal('t'); assert.equal(armed, false); assert.equal(armings, 1);
});
