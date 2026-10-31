const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { RemoteConnection } = require('../electron/remote-connection.cjs');
const { UsageMeter } = require('../electron/features/agents/agent-usage.cjs');
const { quotaScope } = require('../electron/features/dashboard/records.cjs');
const { remoteClaudeResult, watchRemoteClaudeAccount } = require('../electron/features/ssh/claude-account.cjs');

const ready = (percent = 42, at = 100000) => ({ state: 'ready', account: { at, source: 'remote-private-diagnostic', token: 'secret',
  limits: [{ minutes: 300, percent, resetsAt: at + 300000, private: 'secret' }, { minutes: 10080, percent: 9, resetsAt: null }] } });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function clock() {
  let now = 100000;
  const timers = new Set();
  return { now: () => now, setTimeout: (fn, ms) => { const timer = { fn, at: now + ms }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer), async tick(ms) { now += ms; for (const timer of [...timers]) if (timer.at <= now) { timers.delete(timer); timer.fn(); } await flush(); } };
}

test('remote account boundary copies only validated numeric limits and fixed status words', () => {
  const safe = remoteClaudeResult(ready());
  assert.deepEqual(safe.account, { at: 100000, source: 'Claude', limits: [
    { minutes: 300, percent: 42, resetsAt: 400000 }, { minutes: 10080, percent: 9, resetsAt: null }] });
  for (const value of [null, { state: 'ready' }, ready(NaN), ready(-1), ready(Infinity), ready(1, -1),
    { ...ready(), account: { at: 1, limits: [{ minutes: 300, percent: '4', resetsAt: null }] } },
    { ...ready(), account: { at: 1, limits: [{ minutes: 5, percent: 4, resetsAt: null }] } },
    { ...ready(), account: { at: 1, limits: [{ minutes: 300, percent: 4, resetsAt: 'secret' }] } }]) {
    assert.equal(remoteClaudeResult(value).state, 'error');
  }
  const duplicate = ready(); duplicate.account.limits.push(duplicate.account.limits[0]);
  assert.equal(remoteClaudeResult(duplicate).state, 'error');
  assert.equal(remoteClaudeResult(ready(0)).account.limits[0].percent, 0);
  const error = remoteClaudeResult({ state: 'error', reason: 'http', status: 429, retryAfterMs: 90000000, message: 'secret' });
  assert.deepEqual(error, { state: 'error', reason: 'http', status: 429, retryAfterMs: 900000 });
  for (const value of [safe, error, remoteClaudeResult({ state: 'skipped', reason: 'secret', body: 'secret' })]) assert.ok(!JSON.stringify(value).includes('secret'));
});

test('remote polling is read-only, rate limited, aborted on disposal and rejects late or rebound results', async () => {
  const time = clock(), requests = [], received = [];
  let resolve, current = true;
  const remote = { request(op, data, options) { requests.push({ op, data, options }); return new Promise(done => { resolve = done; }); } };
  const poller = watchRemoteClaudeAccount(remote, account => received.push(account), { ...time, current: () => current });
  await time.tick(250);
  assert.equal(requests.length, 1); assert.equal(requests[0].op, 'claude-account'); assert.deepEqual(requests[0].data, {});
  assert.equal(requests[0].options.timeout, 7000);
  resolve(ready()); await flush();
  assert.equal(received.length, 1);
  poller.refresh(); await time.tick(59000); assert.equal(requests.length, 1);
  await time.tick(1000); assert.equal(requests.length, 2);
  current = false; resolve(ready(12)); await flush(); assert.equal(received.length, 1);
  current = true; await time.tick(60000); assert.equal(requests.length, 3);
  poller.dispose(); assert.equal(requests[2].options.signal.aborted, true);
  resolve(ready(88)); await flush(); await time.tick(300000);
  assert.equal(received.length, 1); assert.equal(requests.length, 3);
});

test('remote query errors and account skips expose neither diagnostics nor fabricated zero limits', async () => {
  const time = clock(), received = [];
  let response = { state: 'skipped', reason: 'expired' }, calls = 0;
  const poller = watchRemoteClaudeAccount({ async request() { calls++; if (response instanceof Error) throw response; return response; } },
    account => received.push(account), time);
  await time.tick(250); assert.equal(poller.account, null);
  response = new Error('Bearer fake-secret-token'); await time.tick(60000);
  assert.equal(poller.account, null); assert.deepEqual(received, []);
  response = ready(); await time.tick(60000);
  assert.equal(calls, 3); assert.equal(poller.account.limits[0].percent, 42);
  assert.ok(!JSON.stringify(poller.account).includes('secret')); poller.dispose();
});

function connection() {
  const messages = [];
  const remote = Object.assign(Object.create(RemoteConnection.prototype), { ready: Promise.resolve(), pending: new Map(), nextId: 0, closed: false,
    send: message => messages.push(message) });
  return { remote, messages };
}

test('remote request cancellation, timeout and close release pending slots and ignore late responses', async () => {
  const { remote, messages } = connection(), controller = new AbortController();
  const request = remote.request('claude-account', {}, { signal: controller.signal, timeout: 5000 });
  await flush(); assert.equal(remote.pending.size, 1);
  controller.abort(); await assert.rejects(request, /cancelled/);
  assert.equal(remote.pending.size, 0);
  remote.receive({ type: 'response', id: messages[0].id, ok: true, value: ready() });
  const alive = setTimeout(() => {}, 1000);
  try { await assert.rejects(remote.request('claude-account', {}, { timeout: 5 }), /超时/); }
  finally { clearTimeout(alive); }
  assert.equal(remote.pending.size, 0);
  const value = remote.request('claude-account'); await flush();
  remote.receive({ type: 'response', id: messages.at(-1).id, ok: true, value: ready() });
  assert.equal((await value).state, 'ready'); assert.equal(remote.pending.size, 0);
  const closing = remote.request('claude-account', {}, { signal: new AbortController().signal }); await flush();
  Object.assign(remote, { rejectReady() {}, link: { detach() {} }, channel: 1 }); remote.close();
  await assert.rejects(closing, /关闭/); assert.equal(remote.pending.size, 0);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(connection().remote.request('claude-account', {}, { signal: aborted.signal }), /cancelled/);
});

test('SSH Claude startUsage binds only the remote channel and quota scopes separate hosts from local accounts', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const body = source.slice(source.indexOf('function startUsage('), source.indexOf('\nfunction stopUsageAccount('));
  const project = { id: 'p', kind: 'ssh', path: '/srv/project', ssh: { host: 'one', configFile: '/fixture/ssh' } };
  const session = { agent: 'claude', terminalId: 't', codexActive: true, activityClockOffset: 60000, terminal: {}, quotas: [], recordQuota(provider, limits) { this.quotas.push({ provider, limits }); } };
  let binding;
  const context = { UsageMeter, sessions: new Map([['t', session]]), stopUsageAccount() {}, callsOf: () => null,
    scheduleState() {}, scheduleUsageRollover() {}, watchRemoteClaudeAccount(remote, changed, options) { binding = { remote, changed, options }; return { dispose() {} }; },
    claudeProvider() { assert.fail('remote Claude cannot inspect local provider settings'); }, refreshClaudeAccounts() { assert.fail('remote Claude cannot inspect local credentials'); } };
  vm.runInNewContext(body + '\nstartUsage(project, session, {});', { ...context, project, session });
  assert.equal(binding.remote, session.terminal); assert.ok(binding.options.current());
  const localAt = Date.now(), account = remoteClaudeResult(ready(41, localAt - 60000)).account;
  binding.changed(account);
  assert.equal(session.usage.snapshot().limits[0].percent, 41); assert.equal(session.quotas.length, 1);
  assert.equal(session.usage.limitsAt, localAt);
  assert.equal(session.usage.limits[0].resetsAt, account.limits[0].resetsAt, 'server reset timestamps must not acquire the host clock offset');
  session.codexActive = false; assert.equal(binding.options.current(), false);
  session.codexActive = true; context.sessions.delete('t'); assert.equal(binding.options.current(), false);
  const first = quotaScope('claude', project, session);
  assert.notEqual(first, quotaScope('claude', { ...project, ssh: { ...project.ssh, host: 'two' } }, session));
  assert.notEqual(first, quotaScope('claude', { ...project, kind: 'local' }, { usageEnv: { CLAUDE_CONFIG_DIR: '/fixture/local-claude' } }));
});

test('SSH Claude attention events show the waiting notice without rearming completion or sending any input', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const body = source.slice(source.indexOf('function claudeActivity('), source.indexOf('\nfunction onEvent('));
  const session = { codexActive: true, agent: 'claude', needsInput: null, codexActivity: 'complete' };
  const event = { state: 'attention', sessionId: 'fixture-session', eventId: 'fixture-session:notify:1', message: 'Claude needs your answer' };
  let broadcasts = 0;
  vm.runInNewContext(body + '\nclaudeActivity(project, session, event);', { project: { kind: 'ssh' }, session, event,
    broadcast() { broadcasts++; }, store: { expectCompletion() { assert.fail('attention cannot rearm completion'); } },
    applyActivity() { assert.fail('attention cannot change round state'); }, followClaude() { assert.fail('attention cannot rebind the transcript'); } });
  assert.equal(session.needsInput.message, event.message); assert.equal(session.codexActivity, 'complete'); assert.equal(broadcasts, 1);
});

test('resuming SSH Claude rebinds its quota poller while preserving the existing conversation meter', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const project = { id: 'p', kind: 'ssh', path: '/srv/project' }, usage = new UsageMeter('claude');
  usage.round = { input: 15, cached: 3, output: 9 };
  const session = { terminalId: 't', projectId: project.id, sessionKey: 'fixture', agent: 'claude', usage,
    claudeResumeId: 'same-session', claudeSessionId: 'same-session', claudeTranscript: {}, submissions: { reset() {} }, promptQueue: { reset() {} } };
  let rebound = 0;
  const context = vm.createContext({ sessions: new Map([[project.id, session], ['t', session]]), project, session,
    store: { projects: [project], findTerminal: () => ({ record: { restore: { codex: true, agent: 'claude', cwd: project.path } } }), setRestore() {} },
    acceptShellEvent: () => true, agentCommand: () => null, sshHandoff: async () => {}, prepareReading: async () => {}, startSkillSession() {}, broadcast() {},
    startUsage() { assert.fail('resume must retain its conversation totals'); }, followClaudeSession: async () => {},
    bindRemoteClaudeAccount(value) { assert.equal(value, session); rebound++; } });
  // Extract the real event handler, ending before unrelated launcher declarations.
  vm.runInContext(source.slice(source.indexOf('function onEvent('), source.indexOf('// The agent chosen on a new project')), context);
  context.onEvent({ type: 'codex-started', projectId: project.id, sessionKey: 'fixture', agent: 'claude', cwd: project.path, sequence: 2 });
  assert.equal(rebound, 1); assert.equal(session.usage, usage);
  assert.deepEqual(session.usage.round, { input: 15, cached: 3, output: 9 });
});
