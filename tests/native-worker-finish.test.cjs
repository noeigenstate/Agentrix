const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerClaudeWorker } = require('../electron/features/native-session/worker.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let handler, answer, emit, turn = 0, finished = false;
  const events = [];
  const state = value => emit({ type: 'session.state', payload: { state: value } });
  const claude = { apiState: () => ({ status: 'ready' }), create(_spec, publish) {
    emit = publish;
    return { start() { state('idle'); }, close() { state('stopped'); },
      send() { emit({ type: 'turn.started', turnId: 'turn-' + ++turn, payload: { origin: 'user' } }); state('running'); return { status: 'queued' }; } };
  } };
  registerClaudeWorker({ control: { onRequest(_name, value) { handler = value; } }, claude,
    settings: () => ({ claudePath: 'api-only' }), env: () => ({ PATH: '' }) });
  const result = handler({ runId: 'worker', projectId: 'p', cwd: '/synthetic' }, { prompt: 'First turn' },
    { supportsFinish: true, emit: event => events.push(event), onControl(value) { answer = value; return () => {}; } }).then(value => { finished = true; return value; });
  return { result, state, events, control: value => answer(value), finished: () => finished,
    complete() { emit({ type: 'turn.completed', turnId: 'turn-' + turn, payload: { status: 'completed' } }); } };
}
test('N3: finish received 1.15 seconds before idle completes at that idle without another finish request', { timeout: 5000 }, async () => {
  const f = fixture(); await tick(); f.complete();
  assert.deepEqual(await f.control({ type: 'finish' }), { status: 'queued' });
  await new Promise(resolve => setTimeout(resolve, 1150)); assert.equal(f.finished(), false);
  f.state('idle'); assert.deepEqual(await f.result, { status: 'completed' });
});
test('N3: intervention starts another turn and consumes no stale finish request from the previous turn', { timeout: 5000 }, async () => {
  const f = fixture(); await tick(); f.complete();
  assert.deepEqual(await f.control({ type: 'finish' }), { status: 'queued' });
  assert.equal(await f.control({ type: 'intervene', messageId: 'correction', text: 'Continue in a new turn' }), 'queued');
  assert.deepEqual(await f.control({ type: 'finish' }), { status: 'queued' }, 'a late prior-turn finish cannot close the new turn');
  f.state('idle'); await tick(); assert.equal(f.finished(), false);
  f.complete(); f.state('idle'); await tick(); assert.equal(f.finished(), false);
  assert.deepEqual(await f.control({ type: 'finish' }), { status: 'delivered' });
  assert.deepEqual(await f.result, { status: 'completed' });
  assert.equal(f.events.filter(event => event.type === 'turn.started').length, 2);
});
