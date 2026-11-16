const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');

// 「最近完成 N 个」 keeps a terminal's last ten finished calls, none older than thirty minutes (owner, 2026-11-15). Main hides a
// call's live row 3 s after it ends; the call itself stays in the snapshot as a hidden `done` row within those bounds, so
// the renderer can list it. Nothing else moves: one completion callback, no rate from a retired call, no polling.
const MINUTE = 60000, T0 = Date.parse('2026-11-15T08:00:00Z');
const workerId = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
function tracker(t) {
  let now = T0;
  const ended = [], calls = new AgentCalls({ now: () => now, dispatchAlive: () => false, finished: (call, event) => ended.push(event.id) });
  calls.feeds.readDispatch = async () => {}; t.after(() => calls.dispose());
  return { calls, ended, at: () => now, advance(ms) { now += ms; t.mock.timers.tick(ms); } };
}
const start = (id, at) => ({ type: 'dispatch-start', id, agent: 'codex', model: 'gpt-6.1-sol', effort: 'max', fast: true, role: '执行', title: `Worker ${id.slice(-2)}`,
  sessionId: `thread-${id}`, cwd: '/synthetic', startedAt: at, helperPid: 123 });
const end = (id, at) => ({ type: 'dispatch-end', id, reason: 'exit', exitCode: 0, model: 'gpt-6.1-sol', effort: 'max', fast: true, endedAt: at, outputTokens: 900, activeMs: 3000 });
const rows = calls => calls.snapshot().flatMap(group => group.items.map(({ id, state, hidden }) => [id, state, hidden]));

test('a finished dispatch worker is still in the snapshot 10 s after it ends, as a hidden done row, and is gone after 30 min', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = tracker(t), id = workerId(1);
  f.calls.dispatch(start(id, f.at())); f.advance(MINUTE);
  f.calls.dispatch(end(id, f.at())); await f.calls.work;
  assert.deepEqual(rows(f.calls), [[`dispatch:${id}`, 'done', false]], 'the live row first, as before');
  f.advance(10000); await f.calls.work;
  assert.deepEqual(rows(f.calls), [[`dispatch:${id}`, 'done', true]], 'hidden from the live list, still sent for 最近完成');
  const [group] = f.calls.snapshot();
  assert.deepEqual([group.running, group.reviewing, group.rate], [0, 0, null], 'a retired call adds to no count and no rate');
  f.advance(30 * MINUTE - 10000); assert.equal(rows(f.calls).length, 1, 'thirty minutes after its end it is still kept');
  f.advance(1); assert.deepEqual(f.calls.snapshot(), [], 'older than thirty minutes: gone');
  assert.deepEqual(f.ended, [id], 'one completion, never repeated by a snapshot');
});

test('the eleventh finished worker drops the oldest finished one; a live worker is never counted', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = tracker(t);
  f.calls.dispatch(start(workerId(99), f.at()));
  for (let index = 1; index <= 11; index++) {
    f.calls.dispatch(start(workerId(index), f.at())); f.advance(1000);
    f.calls.dispatch(end(workerId(index), f.at())); f.advance(1000);
  }
  f.advance(5000); await f.calls.work;
  const finished = rows(f.calls).filter(([, state]) => state === 'done');
  assert.equal(finished.length, 10);
  assert.ok(finished.every(([, , hidden]) => hidden), 'all retired from the live list');
  assert.ok(!finished.some(([id]) => id === `dispatch:${workerId(1)}`), 'the oldest is dropped');
  assert.ok(finished.some(([id]) => id === `dispatch:${workerId(11)}`) && finished.some(([id]) => id === `dispatch:${workerId(2)}`));
  assert.deepEqual(rows(f.calls).filter(([, state]) => state !== 'done'), [[`dispatch:${workerId(99)}`, 'running', false]], 'the running worker stays live');
});

test('a finished sub-agent of the session reads 审核中 while live, then stays as a hidden done row, also after the lead reviews it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = tracker(t), stamp = () => new Date(f.at()).toISOString();
  f.calls.apply({ type: 'assistant', timestamp: stamp(), message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_child', name: 'Agent', input: { description: 'Inspect the parser', subagent_type: 'Explore' } }] } });
  f.advance(MINUTE);
  f.calls.apply({ type: 'user', timestamp: stamp(), toolUseResult: {}, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_child', content: 'done', is_error: false }] } });
  assert.deepEqual(rows(f.calls), [['agent:toolu_child', 'reviewing', false]], 'the live row is unchanged');
  f.advance(3000);
  assert.deepEqual(rows(f.calls), [['agent:toolu_child', 'done', true]], 'hidden 3 s after its end: sent as done for 最近完成');
  f.calls.apply({ type: 'system', subtype: 'stop_hook_summary', timestamp: stamp() });
  assert.deepEqual(rows(f.calls), [['agent:toolu_child', 'done', true]], 'the lead\'s review does not drop it');
  f.advance(30 * MINUTE); assert.deepEqual(f.calls.snapshot(), []);
});
