const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const start = helperPid => ({ type: 'dispatch-start', id: '11111111-1111-4111-8111-111111111111', helperPid, agent: 'codex', model: 'gpt-test', effort: 'high', fast: true,
  role: '执行', title: 'Synthetic worker', sessionId: 'synthetic-thread', cwd: '/synthetic', startedAt: 100 });
function tracker(t, options = {}) {
  const ended = []; const calls = new AgentCalls({ ...options, finished: (call, event) => ended.push(event) });
  calls.feeds.readDispatch = async () => {}; t.after(() => calls.dispose());
  return { calls, ended, async poll() { calls.refresh(start().id); await calls.work; } };
}
test('N6: a forcibly terminated helper without dispatch-end becomes interrupted once, and late end packets cannot resurrect it', async t => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  const closed = once(child, 'close'); t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  const f = tracker(t); f.calls.dispatch(start(child.pid)); await f.poll(); assert.equal(f.calls.running().length, 1);
  child.kill('SIGKILL'); await closed; await f.poll();
  assert.equal(f.calls.running().length, 1, 'allow the final pipe packet to arrive before inferring a missing end');
  await new Promise(resolve => setTimeout(resolve, 1050)); await f.poll();
  assert.equal(f.calls.running().length, 0); assert.equal(f.calls.snapshot()[0].items[0].failure.reason, 'killed'); assert.equal(f.ended.length, 1);
  await f.poll(); assert.equal(f.ended.length, 1);
  assert.equal(f.calls.dispatch({ type: 'dispatch-end', id: start().id, reason: 'exit', exitCode: 0, model: 'gpt-test', endedAt: Date.now() }), false);
});
test('N6: a silent or temporarily disconnected helper that is still alive remains running; unknown evidence never means dead', async t => {
  const f = tracker(t); f.calls.dispatch(start(process.pid)); await f.poll(); await f.poll();
  assert.equal(f.calls.running().length, 1); assert.equal(f.ended.length, 0);
  const unknown = tracker(t, { dispatchAlive: async () => null }); unknown.calls.dispatch(start()); await unknown.poll(); assert.equal(unknown.calls.running().length, 1);
});
test('N6: main caches a verified team-board PID, so later board cleanup does not hide a dead helper', async t => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  let alive = true, reads = 0;
  const s = { terminalId: 't', recordRun() {} }, project = { kind: 'local', path: '/synthetic' };
  const context = { AgentCalls: class extends AgentCalls { static alive() { return alive; } }, path, os: { homedir: () => '/synthetic' }, sessions: new Map([['t', s]]), scheduleState() {}, send() {},
    require: () => ({ locateTeam: async () => ({ board: '/synthetic/board' }) }),
    fs: { statSync: () => ({ size: 100 }), readFileSync() { reads++; return JSON.stringify({ id: start().id, pid: 123, cwd: '/synthetic' }); } },
    process: { kill() { if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } },
  };
  vm.createContext(context); vm.runInContext(source.slice(source.indexOf('function callsOf('), source.indexOf('function resolveIntervention(')), context);
  const calls = context.callsOf(s, project); calls.feeds.readDispatch = async () => {}; t.after(() => calls.dispose());
  calls.dispatch(start()); calls.refresh(start().id); await calls.work;
  alive = false; calls.refresh(start().id); await calls.work;
  await new Promise(resolve => setTimeout(resolve, 1050)); calls.refresh(start().id); await calls.work;
  assert.equal(reads, 1); assert.equal(calls.running().length, 0); assert.equal(calls.snapshot()[0].items[0].failure.reason, 'killed');
});

test('F20 a normal end arriving after the first dead-PID observation wins over inferred interruption', async t => {
  let now = 100;
  const f = tracker(t, { dispatchAlive: () => false, now: () => now }); f.calls.dispatch(start(123)); await f.poll();
  assert.equal(f.calls.running().length, 1);
  f.calls.dispatch({ type: 'dispatch-end', id: start().id, reason: 'exit', exitCode: 0, model: 'gpt-test', endedAt: now, outputTokens: null, activeMs: null });
  now += 2000; await f.poll();
  assert.equal(f.calls.snapshot()[0].items[0].failure, null); assert.equal(f.ended.length, 1);
});

test('an ended helper with a reused live PID retires when its run board is gone', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = require('node:fs').readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const s = { terminalId: 't', projectId: 'p' }, project = { id: 'p', path: '/synthetic' };
  const context = { AgentCalls: class extends AgentCalls { static alive() { return true; } }, path, os: { homedir: () => '/synthetic' },
    sessions: new Map([['t', s]]), scheduleState() {}, send() {}, require: () => ({ locateTeam: async () => ({ board: '/gone' }) }),
    fs: { statSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } } };
  vm.createContext(context); vm.runInContext(source.slice(source.indexOf('function callsOf('), source.indexOf('function resolveIntervention(')), context);
  const calls = context.callsOf(s, project); calls.feeds.readDispatch = async () => {}; t.after(() => calls.dispose());
  const launch = start(123); calls.dispatch(launch);
  calls.dispatch({ type: 'dispatch-end', id: launch.id, reason: 'exit', exitCode: 0, model: 'gpt-test', outputTokens: null, activeMs: null });
  t.mock.timers.tick(3000); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls.snapshot(), []);
});
