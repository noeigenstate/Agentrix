const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { DashboardRecords, quotaScope, FILE_LIMIT, LINE_LIMIT, READ_LIMIT, QUOTA_INTERVAL, QUIT_DRAIN_MS } = require('../electron/features/dashboard/records.cjs');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { acceptDispatch } = require('../electron/features/agents/dispatch-events.cjs');
const { registerAgentsIpc } = require('../electron/features/agents/ipc.cjs');
const { UsageMeter } = require('../electron/features/agents/agent-usage.cjs');

async function lab(t, options) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-dashboard-')));
  const records = new DashboardRecords(directory, options);
  t.after(async () => { await records.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, records };
}

test('append queues valid lines and rotates one generation', async t => {
  let now = 100;
  const { records } = await lab(t, { now: () => now++ });
  await Promise.all(Array.from({ length: 20 }, (_, index) => records.append('runs', { index })));
  assert.deepEqual((await records.read('runs')).map(record => record.index), Array.from({ length: 20 }, (_, i) => i));
  await fs.writeFile(records.file('runs'), ' '.repeat(FILE_LIMIT - 1));
  assert.equal(await records.append('runs', { marker: 'first rotation' }), true);
  assert.equal((await fs.stat(records.file('runs', true))).size, FILE_LIMIT - 1);
  assert.equal((await records.read('runs')).at(-1).marker, 'first rotation');
  await fs.writeFile(records.file('runs'), ' '.repeat(FILE_LIMIT + 1));
  await records.append('runs', { marker: 'second rotation' });
  assert.equal((await fs.stat(records.file('runs', true))).size, FILE_LIMIT + 1);
  assert.deepEqual((await fs.readdir(records.directory)).sort(), ['runs.1.jsonl', 'runs.jsonl']);
  const before = await fs.readFile(records.file('runs'), 'utf8');
  assert.equal(await records.append('runs', { oversized: '中'.repeat(LINE_LIMIT) }), false);
  assert.equal(await fs.readFile(records.file('runs'), 'utf8'), before);
  assert.equal((await records.read('runs', { since: 121 }))[0].marker, 'second rotation');
});

test('unwritable stores never reject and log once', async t => {
  const warnings = [], { records } = await lab(t, { log: message => warnings.push(message) });
  await fs.writeFile(records.directory, 'This file prevents directory creation on every platform.');
  assert.deepEqual(await Promise.all([records.append('runs', {}), records.append('grades', {}), records.append('runs', {})]), [false, false, false]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(await records.read('runs'), []);
  await fs.rm(records.directory);
  assert.equal(await records.append('runs', { recovered: true }), true);
  assert.equal((await records.read('runs'))[0].recovered, true);
});

test('reads bound history and skip malformed oversized and torn records', async t => {
  const { records } = await lab(t);
  await fs.mkdir(records.directory);
  const lines = Array.from({ length: READ_LIMIT + 5 }, (_, index) => JSON.stringify({ v: 1, at: index, index }) + '\n').join('');
  await fs.writeFile(records.file('runs', true), JSON.stringify({ v: 1, at: 0, previous: true }) + '\n');
  await fs.writeFile(records.file('runs'), lines + '{bad json}\n' + JSON.stringify({ v: 2, at: 100 }) + '\n' +
    JSON.stringify({ v: 1, at: 100, oversized: 'x'.repeat(LINE_LIMIT) }) + '\n' + JSON.stringify({ v: 1, at: 99999 }));
  const read = await records.read('runs');
  assert.equal(read.length, READ_LIMIT); assert.equal(read[0].index, 5); assert.equal(read.at(-1).index, READ_LIMIT + 4);
  assert.deepEqual((await records.read('runs', { since: READ_LIMIT + 4 })).map(record => record.index), [READ_LIMIT + 4]);
  assert.deepEqual(await records.read('runs', { since: NaN }), []);
});

test('run and grade hooks retain only local evaluation metadata', async t => {
  const { records } = await lab(t, { now: () => 10000 });
  const project = { id: 'owner', kind: 'ssh', path: '/remote/private/project' };
  const session = { terminalId: 'terminal', projectId: project.id, sessionKey: 'secret', sessionId: 'terminal-session', agent: 'codex',
    reportedThreadId: 'actual-thread', agentSettings: { model: 'gpt-6.1-sol', effort: 'max', prompt: 'never recorded' } };
  const calls = new AgentCalls({ local: false, finished: (call, event) => records.run(project, call, event) });
  t.after(() => calls.reset());
  const id = randomUUID();
  const start = { type: 'dispatch-start', id, projectId: session.terminalId, sessionKey: session.sessionKey, agent: 'codex', model: 'gpt-6.1-sol', effort: 'max', fast: true,
    role: '执行', kind: 'core', title: 't'.repeat(400), meeting: 'dash-r1', skipMeeting: null, cwd: '/secret/cwd', brief: '/secret/brief', out: '/secret/out', sessionId: randomUUID(), startedAt: 1 };
  const end = { type: 'dispatch-end', id, projectId: session.terminalId, sessionKey: session.sessionKey, model: 'gpt-6.1-sol', effort: 'max', fast: true,
    endedAt: 9999, outputTokens: 20, totalOutputTokens: 30, inputTokens: 40, cachedTokens: 60, reportedCostUsd: 0.02, activeMs: 500, reason: 'exit', exitCode: 0,
    verdict: 'ok', outOfScope: ['/secret/file'], outOfScopeCount: 75, answer: 'never recorded' };
  assert.equal(acceptDispatch(session, start, calls), true);
  const usage = new UsageMeter('codex', { calls, rates: false });
  usage.apply({ type: 'session_meta', payload: { id: 'new-parent-conversation', source: 'cli' } });
  assert.equal(acceptDispatch(session, end, calls), true);
  assert.equal(acceptDispatch(session, end, calls), false);
  const run = (await records.read('runs'))[0];
  assert.equal(run.projectId, 'owner'); assert.equal(run.project, 'project'); assert.equal(run.agent, 'codex');
  assert.equal(run.title.length, 240); assert.equal(run.kind, 'core'); assert.equal(run.outOfScope, 75); assert.equal(run.inputTokens, 40);
  assert.equal(run.outputTokens, 20); assert.equal(run.totalOutputTokens, 30);
  for (const secret of ['secret', 'never recorded', '/remote']) assert.ok(!JSON.stringify(run).includes(secret));
  const handlers = {};
  registerAgentsIpc({ handle: (name, fn) => { handlers[name] = fn; }, findProject: id => { assert.equal(id, 'terminal'); return project; },
    getSession: () => session, gradeDelivery: (...args) => records.grade(...args) });
  const grade = { projectId: 'owner', terminalId: 'terminal', outcome: 'sent-back', submission: 2, note: 'n'.repeat(3000) };
  assert.equal(handlers['dashboard:grade'](grade), undefined);
  handlers['dashboard:grade']({ ...grade, outcome: 'passed', submission: 3 });
  for (const bad of [{ ...grade, projectId: 'other' }, { ...grade, model: 'forged' }, { ...grade, submission: 0 }, { ...grade, submission: 1.2 },
    { ...grade, outcome: 'unknown' }, { ...grade, note: {} }]) assert.throws(() => handlers['dashboard:grade'](bad));
  const grades = await records.read('grades');
  assert.equal(grades.length, 2); assert.equal(grades[0].model, session.agentSettings.model); assert.equal(grades[0].sessionId, 'actual-thread');
  assert.equal(grades[0].note.length, 2000); assert.equal(grades[1].note, undefined); assert.equal(grades[1].submission, 3);
});

test('unconfirmed runs retain declarations without inventing an actual route', async t => {
  const { records } = await lab(t);
  records.run({ id: 'p', path: path.join(os.tmpdir(), 'project') }, { sourceAgent: 'codex', role: '执行', unconfirmed: true,
    declared: { model: 'gpt-6.1-sol', effort: 'max', fast: true }, startedAt: 10 },
  { id: randomUUID(), model: 'gpt-6.1-sol', effort: 'max', fast: true, reason: 'unconfirmed', exitCode: 1, endedAt: 20 });
  const run = (await records.read('runs'))[0];
  assert.equal(run.model, 'unreported'); assert.equal(run.effort, null); assert.equal(run.fast, null); assert.equal(run.verdict, 'unverified');
  assert.equal(run.declared.model, 'gpt-6.1-sol'); assert.equal(run.inputTokens, null); assert.equal(run.activeMs, null);
  records.run({ id: 'p', path: path.join(os.tmpdir(), 'project') }, { sourceAgent: 'codex', role: '执行', unconfirmed: true,
    model: 'legacy-model', effort: 'high', fast: false, startedAt: 10 },
  { id: randomUUID(), model: 'legacy-model', reason: 'unconfirmed', exitCode: 1, endedAt: 20 });
  const legacy = (await records.read('runs'))[1];
  assert.equal(legacy.model, 'unreported'); assert.equal(legacy.declared.model, 'legacy-model'); assert.equal(legacy.verdict, 'unverified');
});

test('quota snapshots throttle each provider and preserve zero', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000;
  const { records } = await lab(t, { now: () => now });
  const limits = [{ minutes: 300, percent: 0, resetsAt: null, accountId: 'never recorded' }];
  records.quota('codex', limits); records.quota('claude', limits); records.quota('codex', limits);
  now += QUOTA_INTERVAL - 1; records.quota('codex', [{ ...limits[0], percent: 1 }]);
  assert.equal((await records.read('quota')).length, 2);
  now++; records.quota('codex', [{ ...limits[0], percent: 1 }]);
  now += QUOTA_INTERVAL; records.quota('codex', [{ ...limits[0], percent: 1 }]);
  records.quota('other', limits); records.quota('claude', []); records.quota('claude', [{ percent: NaN }]);
  const quota = await records.read('quota');
  assert.equal(quota.length, 3); assert.equal(quota[0].windows[0].percent, 0);
  assert.equal(quota.at(-1).windows[0].percent, 1); assert.ok(!JSON.stringify(quota).includes('accountId'));
});

test('grades use only agent conversation ids and keep unknown identities null', async t => {
  const { records } = await lab(t), project = { id: 'p', path: path.join(os.tmpdir(), 'project') };
  const grade = { projectId: 'p', terminalId: 'terminal', outcome: 'passed', submission: 1 };
  const base = { terminalId: 'terminal', projectId: 'p', sessionId: 'agentrix-internal-session' };
  for (const [session, expected] of [
    [{ agent: 'codex', rootThreadId: 'root', reportedThreadId: 'reported' }, 'root'],
    [{ agent: 'codex', reportedThreadId: 'reported' }, 'reported'], [{ agent: 'codex' }, null],
    [{ agent: 'claude', claudeSessionId: 'conversation', claudeResumeId: 'resumed' }, 'conversation'],
    [{ agent: 'claude', claudeResumeId: 'resumed' }, 'resumed'], [{ agent: 'claude' }, null], [{ agent: 'other' }, null],
  ]) {
    records.grade(grade, project, { ...base, ...session });
    assert.equal((await records.read('grades')).at(-1).sessionId, expected);
  }
  assert.ok(!JSON.stringify(await records.read('grades')).includes(base.sessionId));
});

test('quota series isolate providers, SSH hosts and CLI homes without recording their names', async t => {
  const { records } = await lab(t);
  const local = { kind: 'local' }, remote = host => ({ kind: 'ssh', ssh: { host, configFile: '/private/ssh/config' } });
  const session = { codexHome: path.join(os.tmpdir(), 'private-codex-home'), usageEnv: { CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'private-claude-home') } };
  const inputs = [['codex', local, session], ['claude', local, session],
    ['codex', remote('private-host-one'), session], ['codex', remote('private-host-two'), session],
    ['codex', local, { ...session, codexHome: session.codexHome + '-two' }]];
  const scopes = inputs.map(args => quotaScope(...args));
  assert.equal(new Set(scopes).size, inputs.length);
  assert.equal(quotaScope('codex', remote('private-host-one'), { ...session, terminalId: 'different-terminal' }), scopes[2]);
  assert.equal(quotaScope('codex', { ...local, path: 'another-project' }, session), scopes[0]);
  assert.equal(quotaScope('codex', local, { usageEnv: { CODEX_HOME: session.codexHome } }), scopes[0]);
  assert.equal(quotaScope('codex', remote('private-host-one'), { ...session, usageEnv: { CODEX_HOME: 'ignored-local-home' } }), scopes[2]);
  for (const [index, [provider]] of inputs.entries()) {
    assert.match(scopes[index], /^[a-f0-9]{24}$/);
    records.quota(provider, [{ minutes: 300, percent: index }], scopes[index]);
    records.quota(provider, [{ minutes: 300, percent: index }], scopes[index]);
  }
  const quota = await records.read('quota');
  assert.equal(quota.length, 5);
  assert.equal(new Set(quota.map(record => record.scope)).size, 5);
  assert.doesNotMatch(JSON.stringify(quota), /private|host-one|host-two|config|CODEX_HOME|terminal/);
});

test('quota bursts persist the trailing value when the ten-minute window ends', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { records } = await lab(t), limits = percent => [{ minutes: 300, percent }];
  records.quota('codex', limits(0));
  t.mock.timers.tick(100); records.quota('codex', limits(10));
  t.mock.timers.tick(100); records.quota('codex', limits(20));
  t.mock.timers.tick(QUOTA_INTERVAL - 201);
  assert.deepEqual((await records.read('quota')).map(record => record.windows[0].percent), [0]);
  t.mock.timers.tick(1);
  assert.deepEqual((await records.read('quota')).map(record => record.windows[0].percent), [0, 20]);
  records.quota('codex', limits(30)); records.quota('codex', limits(20));
  t.mock.timers.tick(QUOTA_INTERVAL);
  assert.equal((await records.read('quota')).length, 2, 'a return to the recorded value cancels the trailing write');
});

test('quit drains once within the cap even with a stalled write and a late append', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const records = new DashboardRecords(os.tmpdir());
  let finish;
  records.pending.set('runs', new Promise(resolve => { finish = resolve; }));
  assert.equal(records.busy, true);
  const wait = records.waitForQuit();
  assert.ok(wait instanceof Promise); assert.equal(records.waitForQuit(), null);
  t.mock.timers.tick(QUIT_DRAIN_MS);
  await wait;
  assert.equal(records.quitDrain, null); assert.equal(records.busy, true);
  records.pending.set('grades', Promise.resolve());
  assert.equal(records.waitForQuit(), null, 'late work cannot prevent a second quit');
  finish(); await records.flush();
});

test('quit returns promptly for flushed and empty stores and preserves trailing quota changes', async t => {
  const { records } = await lab(t);
  records.quota('codex', [{ percent: 10 }]); records.quota('codex', [{ percent: 20 }]);
  const wait = records.waitForQuit();
  assert.ok(wait instanceof Promise); await wait;
  assert.equal(records.quitDrain, null); assert.equal(records.busy, false); assert.equal(records.waitForQuit(), null);
  assert.deepEqual((await records.read('quota')).map(record => record.windows[0].percent), [10, 20]);
  const empty = new DashboardRecords(os.tmpdir());
  assert.equal(empty.waitForQuit(), null);
});

test('main quit cleanup runs once and a late dashboard append cannot prevent the next quit', async t => {
  const vm = require('node:vm'), { records } = await lab(t);
  const source = await fs.readFile(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  let handler, cleanups = 0, quits = 0, prevented = 0;
  vm.runInNewContext('let quitting = false, quitCleaned = false;\n' + source.slice(source.indexOf("app.on('before-quit',"), source.indexOf("app.on('window-all-closed',")), {
    app: { on: (_, listener) => { handler = listener; }, quit: () => quits++ }, process: { platform: 'win32' }, dashboard: records,
    clearTimeout, attentionTimer: null, voiceManager: null, fileOperations: null, skills: { close: () => cleanups++ },
    updateManager: null, codexAccounts: { dispose() {} }, claudeAccounts: { dispose() {} }, disposeClaudeAccounts() {},
    usageRolloverTimer: null, stateTimer: null, sessions: new Map(), sshAuth: null, eventServer: null, tray: null, cleanupAskpass() {}, runtimeDir: null,
  });
  const first = records.append('runs', { index: 1 });
  handler({ preventDefault: () => prevented++ });
  const drain = records.quitDrain;
  assert.equal(prevented, 1); assert.equal(cleanups, 1);
  await drain; await first;
  assert.equal(quits, 1);
  const late = records.append('grades', { index: 2 });
  handler({ preventDefault: () => prevented++ });
  assert.equal(prevented, 1); assert.equal(cleanups, 1);
  await late;
});
