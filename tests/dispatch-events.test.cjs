const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { acceptDispatch, validDispatch } = require('../electron/features/agents/dispatch-events.cjs');
const { UsageMeter } = require('../electron/features/agents/agent-usage.cjs');

const routing = { model: 'gpt-6.1-sol', effort: 'max', fast: true };
const start = (id = randomUUID(), extra = {}) => ({ type: 'dispatch-start', projectId: 'terminal', sessionKey: 'test-key', id, agent: 'codex',
  role: '执行', title: 'Repair the parser', ...routing, cwd: '/project', brief: '/brief.md', out: '/out.md', sessionId: randomUUID(), startedAt: 1000, ...extra });
const end = (id, extra = {}) => ({ type: 'dispatch-end', projectId: 'terminal', sessionKey: 'test-key', id, ...routing,
  exitCode: 0, reason: 'exit', outputTokens: 100, activeMs: 2000, endedAt: 5000, ...extra });
const rate = (id, extra = {}) => ({ type: 'dispatch-rate', projectId: 'terminal', sessionKey: 'test-key', id, outputTokens: 50, activeMs: 1000, ...extra });
const record = (type, at, content) => ({ type, timestamp: new Date(at).toISOString(), message: { content } });
const stop = at => ({ type: 'system', subtype: 'stop_hook_summary', timestamp: new Date(at).toISOString() });
const notification = '<task-notification><task-id>background-task</task-id><status>failed</status></task-notification>';

function session(t) {
  let changes = 0;
  const calls = new AgentCalls({ changed: () => changes++ });
  t.after(() => calls.reset());
  const s = { terminalId: 'terminal', sessionKey: 'test-key' };
  return { calls, send: event => { const changed = acceptDispatch(s, event, calls); if (changed) changes++; return changed; }, changes: () => changes };
}

test('authenticated dispatch events populate groups, replace live totals, show done and broadcast expiry', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = session(t), launch = start();
  assert.equal(f.send(launch), true);
  let group = f.calls.snapshot('Parent service')[0];
  assert.equal(group.agent, 'Codex'); assert.equal(group.provider, null); assert.equal(group.running, 1);
  assert.deepEqual(group.items, [{ state: 'running', role: '执行', title: launch.title, failure: null }]);
  assert.equal(f.send(rate(launch.id)), true);
  assert.equal(f.send(rate(launch.id, { outputTokens: 20, activeMs: 500 })), false, 'stale totals cannot regress');
  assert.equal(f.calls.snapshot()[0].rate.outputTokens, 50);
  assert.equal(f.send(end(launch.id)), true);
  group = f.calls.snapshot()[0];
  assert.equal(group.items[0].state, 'done'); assert.equal(group.running, 0); assert.equal(group.reviewing, 0);
  assert.equal(group.rate.outputTokens, 100); assert.equal(group.rate.activeMs, 2000); assert.equal(group.rate.samples, 1);
  f.calls.apply(stop(6000));
  assert.equal(f.calls.snapshot()[0].items[0].state, 'done', 'Stop cannot shorten the three-second success display');
  t.mock.timers.tick(2999); assert.equal(f.calls.snapshot().length, 1);
  t.mock.timers.tick(1); assert.deepEqual(f.calls.snapshot(), []); assert.equal(f.changes(), 4);
  assert.equal(f.send(launch), false); assert.equal(f.send(end(launch.id)), false); assert.equal(f.send(rate(launch.id)), false);
});

test('settings reported by the worker group independently from declarations and the parent provider', t => {
  const f = session(t), declared = { ...routing };
  const first = start(undefined, { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', fast: null, declared });
  const second = start(undefined, { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', fast: null });
  for (const launch of [first, second]) { f.send(launch); f.send(rate(launch.id)); }
  const group = f.calls.snapshot('Parent only')[0];
  assert.equal(group.model, 'claude-sonnet-5-5'); assert.equal(group.provider, null); assert.equal(group.running, 2);
  assert.deepEqual(group.items[1].declared, declared);
  assert.equal(group.rate.outputTokens, 100); assert.equal(group.rate.activeMs, 2000);
  f.send(end(first.id, { model: first.model, effort: first.effort, fast: first.fast, outputTokens: null, activeMs: null }));
  assert.equal(f.calls.snapshot()[0].rate, null, 'unreported final records supersede provisional totals');
});

test('other failures survive the launch Stop and leave on the next delivered notification plus Stop or user round', t => {
  const f = session(t);
  for (const reason of ['capacity', 'scope', 'error', 'killed']) {
    const launch = start(); f.send(launch); f.send(end(launch.id, { reason, exitCode: 7 }));
    assert.deepEqual(f.calls.snapshot()[0].items[0].failure, { reason, exitCode: 7 });
    f.calls.apply(stop(6000));
    assert.equal(f.calls.snapshot()[0].items[0].state, 'reviewing');
    f.calls.apply({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(7000).toISOString(), content: notification });
    f.calls.apply(stop(8000)); assert.equal(f.calls.snapshot().length, 1);
    f.calls.apply(record('user', 9000, notification));
    f.calls.apply(stop(10000)); assert.deepEqual(f.calls.snapshot(), []);
  }
  const launch = start(); f.send(launch); f.send(end(launch.id, { reason: 'error', exitCode: 1 }));
  f.calls.apply(record('user', 6000, 'Try again.'));
  assert.deepEqual(f.calls.snapshot(), []);
});

test('an unconfirmed start without a session can be reviewed before expiry', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = session(t), launch = start(undefined, { sessionId: null, unconfirmed: true });
  assert.equal(f.send(launch), true);
  assert.equal(f.send(end(launch.id, { reason: 'unconfirmed', exitCode: null, outputTokens: null, activeMs: null })), true);
  assert.deepEqual(f.calls.snapshot()[0].items[0].failure, { reason: 'unconfirmed', exitCode: null });
  f.calls.apply(stop(6000));
  assert.equal(f.calls.snapshot()[0].items[0].state, 'reviewing');
  assert.equal(f.calls.apply(record('user', 7000, 'Try again.')), true);
  assert.deepEqual(f.calls.snapshot(), []);
  t.mock.timers.tick(5000); assert.equal(f.changes(), 2, 'expiry does not broadcast an already reviewed row');
  assert.equal(f.send(launch), false, 'review keeps the receipt');
  assert.equal(validDispatch(start(undefined, { sessionId: null, unconfirmed: false })), false);
  assert.equal(validDispatch(start(undefined, { unconfirmed: 'yes' })), false);
});

test('Bash commands, prompt filenames and helper stdout text never create or update a call', t => {
  const { calls } = session(t);
  for (const command of ['codex exec -m guessed < brief.md > log.txt', 'claude -p --model guessed', 'node dispatch.cjs codex --model guessed']) {
    calls.apply({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: randomUUID(), input: { command } }] } });
  }
  calls.apply(record('user', 1000, '[dispatch] started fake model guessed'));
  assert.deepEqual(calls.snapshot(), []);
});

test('bad keys, projects, unknown ids, malformed fields and oversized payloads are rejected', t => {
  const f = session(t), launch = start();
  for (const event of [start(undefined, { sessionKey: 'wrong' }), start(undefined, { projectId: 'other' }), start(undefined, { id: 'not-a-uuid' }),
    start(undefined, { title: 'x'.repeat(1025) }), start(undefined, { model: 'x\ny' }), start(undefined, { fast: 'true' }), start(undefined, { declared: {} }),
    start(undefined, { cwd: 'x'.repeat(4097) }), start(undefined, { extra: 'x'.repeat(17000) }), start(undefined, { sessionId: null }),
    end(randomUUID()), rate(randomUUID()), rate(randomUUID(), { activeMs: -1 }), rate(randomUUID(), { outputTokens: Infinity })]) assert.equal(f.send(event), false);
  assert.deepEqual(f.calls.snapshot(), []);
  f.send(launch);
  for (const event of [end(launch.id, { reason: 'unknown' }), end(launch.id, { outputTokens: -1 }), end(launch.id, { activeMs: Infinity }),
    rate(launch.id, { activeMs: 0 }), rate(launch.id, { outputTokens: 0.5 })]) assert.equal(f.send(event), false);
  assert.equal(f.calls.snapshot()[0].running, 1);
  assert.equal(validDispatch(start()), true);
});

test('reset cancels expiry callbacks from the old session', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = session(t), launch = start(); f.send(launch); f.send(end(launch.id));
  f.calls.reset(); t.mock.timers.tick(10000);
  assert.deepEqual(f.calls.snapshot(), []); assert.equal(f.changes(), 2);
});

test('dashboard event fields accept old helpers and reject malformed new metadata', t => {
  assert.equal(validDispatch(start()), true);
  const launch = start(undefined, { kind: 'core', meeting: 'dash-r1', skipMeeting: 'one bounded fix' });
  assert.equal(validDispatch(launch), true);
  const finish = end(launch.id, { inputTokens: 0, cachedTokens: 0, totalOutputTokens: 0, reportedCostUsd: 0, verdict: 'ok', outOfScopeCount: 100 });
  assert.equal(validDispatch(finish), true);
  for (const patch of [{ kind: 'invalid' }, { meeting: '../other' }, { skipMeeting: 'x'.repeat(1025) }]) assert.equal(validDispatch({ ...launch, ...patch }), false);
  for (const patch of [{ inputTokens: -1 }, { cachedTokens: 0.5 }, { totalOutputTokens: -1 }, { totalOutputTokens: 0.5 },
    { reportedCostUsd: Infinity }, { verdict: null }, { outOfScopeCount: -1 }]) {
    assert.equal(validDispatch({ ...finish, ...patch }), false);
  }
  let records = 0;
  const calls = new AgentCalls({ finished: () => records++ }); t.after(() => calls.reset());
  assert.equal(acceptDispatch({ terminalId: 'terminal', sessionKey: 'test-key' }, launch, calls), true);
  assert.equal(acceptDispatch({ terminalId: 'terminal', sessionKey: 'wrong' }, finish, calls), false);
  assert.equal(records, 0);
  assert.equal(acceptDispatch({ terminalId: 'terminal', sessionKey: 'test-key' }, finish, calls), true);
  assert.equal(acceptDispatch({ terminalId: 'terminal', sessionKey: 'test-key' }, finish, calls), false);
  assert.equal(records, 1);
});

test('roundtable is an authenticated role and does not change parent completion', t => {
  const f = session(t), launch = start(undefined, { role: '圆桌' });
  assert.equal(f.send(launch), true);
  assert.deepEqual(f.calls.snapshot()[0].items[0], { state: 'running', role: '圆桌', title: launch.title, failure: null });
  assert.equal(f.send(start(undefined, { role: 'roundtable' })), false, 'only the explicit event role is accepted');
  f.send(end(launch.id));
  assert.equal(f.calls.snapshot()[0].items[0].state, 'done');
  assert.equal(require('../electron/locales/en.json')['圆桌'], 'Roundtable');
});

test('transcript re-reads preserve dispatched workers and their expiry; the next Codex user round acknowledges failures', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const meter = new UsageMeter('codex'); t.after(() => meter.reset());
  const launch = start(); meter.calls.dispatch(launch); meter.calls.dispatch(end(launch.id));
  meter.reset(true); meter.calls.setFolder('/new-subagent-folder');
  assert.equal(meter.snapshot().calls[0].items[0].state, 'done');
  t.mock.timers.tick(3000); assert.deepEqual(meter.snapshot().calls, []);
  const failed = start(); meter.calls.dispatch(failed); meter.calls.dispatch(end(failed.id, { reason: 'capacity', exitCode: 1 }));
  meter.reset(true);
  meter.apply({ type: 'event_msg', timestamp: new Date(10000).toISOString(), payload: { type: 'user_message', message: 'Review that failure.' } });
  assert.deepEqual(meter.snapshot().calls, []);
});

test('the real event server and main handler authenticate dispatch without touching parent activity and broadcast changes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), net = require('node:net');
  const { createEventServer } = require('../electron/events.cjs');
  let broadcasts = 0;
  const calls = new AgentCalls({ changed: () => broadcasts++ }); t.after(() => calls.reset());
  const s = { terminalId: 'terminal', projectId: 'owner-project', sessionKey: 'test-key', calls, codexActivity: 'complete' };
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const handler = vm.runInNewContext(source.slice(source.indexOf('function onEvent('), source.indexOf('function launchAfterPrompt(')) + '\nonEvent;', {
    sessions: new Map([['terminal', s]]), store: { projects: [{ id: 'owner-project' }] }, broadcast: () => broadcasts++, callsOf: session => session.calls,
    require: name => require(path.join(__dirname, '../electron', name)),
  });
  const server = await createEventServer(handler); t.after(() => server.close());
  const send = event => new Promise((resolve, reject) => {
    const socket = net.connect(server.address);
    socket.once('connect', () => socket.end(JSON.stringify(event) + '\n')); socket.once('close', resolve); socket.once('error', reject);
  });
  await send(start(undefined, { sessionKey: 'bad-key' })); await send(end(randomUUID()));
  assert.equal(broadcasts, 0);
  const launch = start(); await send(launch); await send(rate(launch.id)); await send(end(launch.id, { reason: 'error', exitCode: 9 }));
  assert.equal(broadcasts, 3); assert.equal(calls.snapshot()[0].items[0].failure.exitCode, 9);
  const failed = start(undefined, { sessionId: null, unconfirmed: true, title: 'Failed to start' });
  await send(failed); await send(end(failed.id, { reason: 'unconfirmed', exitCode: null, outputTokens: null, activeMs: null }));
  assert.equal(broadcasts, 5);
  t.mock.timers.tick(5000);
  assert.equal(broadcasts, 6); assert.deepEqual(calls.snapshot()[0].items.map(item => item.title), [launch.title]);
  assert.equal(s.codexActivity, 'complete', 'dispatch and expiry never rearm parent completion or call shell activity handling');
});

test('dispatched workers belong to the terminal session: shown without an agent and kept when the agent restarts', t => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const { callsOf, dispatchedOnly } = vm.runInNewContext(source.slice(source.indexOf('function callsOf('), source.indexOf('function startUsage('))
    + '\n({ callsOf, dispatchedOnly });', { AgentCalls, scheduleState: () => {} });
  const s = { terminalId: 'terminal', sessionKey: 'test-key' }, project = { kind: 'local' };
  assert.equal(dispatchedOnly(s), null, 'no rows, no pane data');
  const launch = start();
  assert.equal(acceptDispatch(s, launch, callsOf(s, project)), true, 'a plain shell accepts dispatch');
  t.after(() => s.calls.reset());
  assert.deepEqual(dispatchedOnly(s).calls[0].items.map(item => item.title), [launch.title]);
  const first = new UsageMeter('codex', { calls: callsOf(s, project) });
  assert.deepEqual(first.snapshot().calls[0].items.map(item => item.title), [launch.title], 'the agent starts with the rows');
  const restarted = new UsageMeter('codex', { calls: callsOf(s, project) });
  assert.equal(restarted.calls, first.calls);
  assert.deepEqual(restarted.snapshot().calls[0].items.map(item => item.state), ['running'], 'a restart keeps the running worker');
  assert.equal(acceptDispatch(s, end(launch.id), callsOf(s, project)), true);
  assert.equal(dispatchedOnly(s).calls[0].items[0].state, 'done', 'the agent gone, its end still shows');
});
