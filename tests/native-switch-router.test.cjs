const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { createEventStream } = require('../electron/features/native-session/events.cjs');

const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const empty = { version: 1, text: '', images: [], undelivered: [] };
function fixture(t, agent = 'claude') {
  let config = { claudePath: 'api-then-terminal', codexView: 'native', monthlyBudgetUsd: 10 }, terminals = [], saved = true, fail = false;
  const created = [], events = [], paths = [];
  const provider = { usage: { summary: () => ({}) }, credentials: { clear() { saved = false; return { saved }; } },
    apiState: () => ({ status: saved ? 'ready' : 'no_key' }), create(spec, emit) {
      const stream = createEventStream(spec, emit); stream.provider('same-conversation');
      let state = 'idle';
      const value = { spec, stream, closed: false, prepared: false,
        start() { stream.publish('session.state', { state: 'starting', reason: null }); stream.publish('session.state', { state, reason: null }); },
        resume() { return this.start(); },
        prepareResume() { if (fail) throw new Error('Synthetic missing transcript'); value.prepared = true; },
        activity: () => ({ known: true, count: 0 }), snapshot: () => ({ ...stream.snapshot(), state }),
        send() { assert.fail('switching never submits an inference turn'); }, answer() {},
        working() { state = 'running'; stream.publish('session.state', { state, reason: null }); },
        disconnect() { state = 'disconnected'; stream.publish('session.state', { state, reason: 'synthetic_disconnect' }); },
        interrupt() { state = 'idle'; stream.publish('turn.completed', { status: 'interrupted', error: null }); stream.publish('session.state', { state, reason: null }); },
        close() { value.closed = true; state = 'stopped'; stream.publish('session.state', { state, reason: null }); } };
      created.push(value); return value;
    } };
  const router = createRouter({ claude: provider, codex: provider, settings: { get: () => config }, resolveSpec: id => ({ agent, owner: 'gui', projectId: 'p', terminalId: id }),
    terminalSessions: () => terminals, observeTerminal: () => ({ state: 'idle', background: { known: true, count: 0 } }),
    async prepareTerminal(spec) {
      const session = { identity: {}, spec, path: 'terminal' };
      return { session, commit() { terminals = [session]; paths.push('terminal'); }, cancel() {} };
    }, activateNative() { terminals = []; paths.push(agent === 'claude' ? 'api' : 'native'); }, emit: event => events.push(event), terminal() {} });
  t.after(() => router.close());
  const handoff = () => {
    const snapshot = router.snapshot('t');
    return router.answer('t', snapshot.runtimeSessionId, 'handoff', { handoff: { changeId: snapshot.switchState.changeId, draft: empty } });
  };
  return { router, created, events, paths, handoff, config: patch => { config = { ...config, ...patch }; router.reconcile(); }, fail: (value = true) => { fail = value; } };
}
const until = async check => { for (let i = 0; i < 200; i++) { if (check()) return; await tick(); } throw new Error('switch did not settle'); };
for (const agent of ['claude', 'codex']) test(`router restores ${agent} both ways using one provider id, carries receipts and never submits history`, async t => {
  const f = fixture(t, agent); await f.router.start('t', { agent });
  f.created[0].stream.publish('input.receipt', { clientMessageId: 'executed', status: 'consumed' });
  f.created[0].stream.publish('input.receipt', { clientMessageId: 'uncertain', status: 'unknown' });
  f.config({ claudePath: 'terminal-only', codexView: 'terminal' }); await tick();
  f.handoff(); await tick();
  assert.equal(f.created[0].closed, true); assert.equal(f.router.snapshot('t').switchState.current, 'terminal');
  f.config({ claudePath: 'api-only', codexView: 'native' }); await tick(); f.handoff(); await tick();
  assert.deepEqual(f.paths, ['terminal', agent === 'claude' ? 'api' : 'native']);
  assert.equal(f.created[1].spec.providerSessionId, 'same-conversation');
  if (agent === 'claude') assert.equal(f.created[1].prepared, true, 'idle alone is insufficient for SDK resume');
  const snapshot = f.router.snapshot('t');
  for (const clientMessageId of ['executed', 'uncertain']) {
    assert.ok(snapshot.events.some(event => event.type === 'input.receipt' && event.payload.clientMessageId === clientMessageId));
    assert.equal((await f.router.send('t', snapshot.runtimeSessionId, { clientMessageId, text: 'never replay' })).status, clientMessageId === 'executed' ? 'consumed' : 'unknown');
  }
  assert.equal(f.events.some(event => event.type === 'turn.started'), false);
});
test('clear key waits for the current turn and switches only after stop has produced idle and draft acknowledgment', async t => {
  const f = fixture(t); const started = await f.router.start('t', { agent: 'claude' });
  f.created[0].working(); assert.deepEqual(f.router.keyClear(), { saved: false }); await tick();
  assert.equal(f.router.switchState('t').phase, 'waiting-turn'); assert.equal(f.created[0].closed, false);
  await f.router.interrupt('t', started.runtimeSessionId); await tick(); assert.equal(f.router.switchState('t').phase, 'preparing');
  assert.equal(f.created[0].closed, false); f.handoff(); await tick(); assert.equal(f.created[0].closed, true);
});
test('an SDK resume failure before input retains the working terminal and the handoff snapshot', async t => {
  const f = fixture(t); await f.router.start('t', { agent: 'claude' });
  f.config({ claudePath: 'terminal-only' }); await tick(); f.handoff(); await tick();
  f.fail(); f.config({ claudePath: 'api-only' }); await tick(); f.handoff(); await tick();
  assert.deepEqual(f.paths, ['terminal']); assert.equal(f.created[1].closed, true);
  assert.equal(f.router.snapshot('t').switchState.current, 'terminal'); assert.match(f.router.snapshot('t').switchState.reason, /已保留原会话/);
  assert.deepEqual(f.router.snapshot('t').handoff.draft, empty);
});
test('a late native disconnect before the first input automatically restores its previous terminal without replay', async t => {
  const f = fixture(t); await f.router.start('t', { agent: 'claude' });
  f.config({ claudePath: 'terminal-only' }); await tick(); f.handoff(); await until(() => f.router.switchState('t').phase === 'stable');
  f.config({ claudePath: 'api-only' }); await tick(); f.handoff(); await until(() => f.router.switchState('t').phase === 'stable');
  f.created.at(-1).disconnect(); await tick();
  assert.equal(f.router.switchState('t').phase, 'preparing'); assert.equal(f.router.switchState('t').target, 'terminal');
  f.handoff(); await until(() => f.router.switchState('t').phase === 'stable');
  assert.equal(f.router.switchState('t').current, 'terminal'); assert.match(f.router.switchState('t').reason, /已恢复原会话/);
  assert.equal(f.events.some(event => event.type === 'turn.started'), false);
});
test('a terminal dying before input restores the previous native path and keeps the acknowledged draft', async t => {
  const f = fixture(t, 'codex'); await f.router.start('t', { agent: 'codex' });
  f.config({ codexView: 'terminal' }); await tick(); f.handoff(); await until(() => f.router.switchState('t').phase === 'stable');
  assert.equal(f.router.failed('t', f.router.snapshot('t').runtimeSessionId), true); f.handoff();
  await until(() => f.router.switchState('t').phase === 'stable');
  assert.equal(f.router.switchState('t').current, 'native'); assert.equal(f.created.at(-1).spec.providerSessionId, 'same-conversation');
  assert.deepEqual(f.router.snapshot('t').handoff.draft, empty);
});
test('once new input may have executed, a disconnect cannot trigger an automatic replay or transport rollback', async t => {
  const f = fixture(t); await f.router.start('t', { agent: 'claude' });
  f.config({ claudePath: 'terminal-only' }); await tick(); f.handoff(); await until(() => f.router.switchState('t').phase === 'stable');
  f.config({ claudePath: 'api-only' }); await tick(); f.handoff(); await until(() => f.router.switchState('t').phase === 'stable');
  f.router.input('t', f.router.snapshot('t').runtimeSessionId); f.created.at(-1).disconnect(); await tick();
  assert.equal(f.router.snapshot('t').state, 'disconnected'); assert.equal(f.router.switchState('t').phase, 'stable');
});
