const { test } = require('node:test'), assert = require('node:assert/strict');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { createEventStream } = require('../electron/features/native-session/events.cjs');
const { createNativeHost } = require('../electron/features/native-session/host.cjs');
const { createShellEvents } = require('../electron/features/terminal-events/shell-events.cjs');
const { createTerminalLifecycle } = require('../electron/app/terminal-lifecycle.cjs');

test('R5 restoreTerminal continues crashes once, but never an owner stop, including late provider events', async () => {
  for (const kind of ['local', 'ssh']) for (const cause of ['crash', 'owner']) for (const status of ['inProgress', 'interrupted', 'completed']) {
    const saved = { agent: 'codex', threadId: 'thread', codex: true }, calls = [];
    let stream, runtimeId;
    const host = { nativeStructured: true, nativeMessages: new Map(), completionWork: { begin() {} } };
    const context = { sessions: new Map([['t', host]]), nativeSpecs: new Map(), quitting: false,
      ...require('../electron/features/cli-adapters/registry.cjs'),
      createNativeUsage: () => ({ apply() {} }), scheduleState() {}, applyActivity() {}, restorePlans: new Map(), startupErrors: new Map(), broadcast() {},
      store: { findTerminal: () => ({ project: { id: 'p', kind }, record: { restore: saved } }), expectCompletion() {}, setRestore(_id, patch) { Object.assign(saved, patch); } } };
    context.structuredEvent = createShellEvents(context).structuredEvent;
    const { saveInterrupted } = createNativeHost(context).nativeRouterOptions();
    const make = () => createRouter({ settings: { get: () => ({}) }, claude: { facts: () => [{ name: 'key', reason: { code: 'claude.no_key' } }] },
      resolveSpec: () => ({ kind, projectId: 'p', terminalId: 't', providerSessionId: saved.threadId }), emit() {},
      changed(id, event) { if (event) context.structuredEvent(id, event); },
      saveInterrupted,
      codex: { create(spec, receive) {
        host.nativeRuntimeSessionId = spec.runtimeSessionId; context.nativeSpecs.set('t', spec);
        runtimeId = spec.runtimeSessionId; stream = createEventStream(spec, receive); stream.provider('thread'); stream.turn('turn');
        return { async start() {}, async resume() {}, snapshot: () => ({ state: 'idle' }), async close() {},
          async canContinueInterrupted() { calls.push('verify:' + status); return status !== 'completed'; },
          async send() { assert.equal(saved.interrupted, false, 'clear persisted before delivery'); calls.push('continue'); return { status: 'delivered' }; },
          async interrupt() {
            assert.equal(saved.interrupted, false, 'owner intent persists before the provider RPC');
            stream.publish('turn.started', { origin: 'user', clientMessageId: null });
            stream.publish('turn.completed', { status: 'interrupted', terminalReason: null });
          } };
      } } });
    let router = make(); await router.start('t', { agent: 'codex', resume: true });
    stream.publish('turn.started', { origin: 'user', clientMessageId: null });
    assert.equal(saved.interrupted, true, 'the live Codex event creates the marker');
    if (cause === 'owner') { await router.interrupt('t', runtimeId); assert.equal(saved.interrupted, false); }
    await router.close(); router = make();
    context.nativeSessions = router;
    await createTerminalLifecycle(context).restoreTerminal('t');
    assert.deepEqual(calls, cause === 'owner' ? [] : status === 'completed' ? ['verify:completed'] : ['verify:' + status, 'continue']);
    calls.length = 0; await createTerminalLifecycle(context).restoreTerminal('t');
    assert.ok(!calls.includes('continue'), 'a second open cannot repeat the continuation'); await router.close();
  }
});
