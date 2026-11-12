const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const { terminalPreparation, completeSwitch } = require('./fixtures/native-switch.cjs');
const { createUsage } = require('../electron/features/claude-sdk/usage.cjs');

async function until(check) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('offline budget fixture did not settle');
}
function fixture(t, budget = 10) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-turn-budget-')), events = [];
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fake = fakeSdk({ auto: false, closeError: true, interruptResult: false });
  const runtime = createClaudeRuntime({ directory, loadSdk: async () => fake.sdk, resolveExecutable: async () => process.execPath,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).reverse(), decryptString: value => Buffer.from(value).reverse().toString() } });
  runtime.credentials.save('sk-ant-api03-budget-offline-test-only');
  const spec = { agent: 'claude', owner: 'gui', runtimeSessionId: randomUUID(), projectId: 'p', terminalId: 't', cwd: directory, monthlyBudgetUsd: budget };
  const session = runtime.create(spec, event => events.push(event));
  t.after(() => runtime.close());
  async function send(text = 'offline turn') { const id = randomUUID(); await session.send({ clientMessageId: id, text }); await until(() => fake.inputs.some(input => input.uuid === id)); return id; }
  async function result(total, extra = {}) {
    const count = events.filter(event => event.type === 'turn.completed').length;
    fake.emit({ type: 'result', uuid: randomUUID(), subtype: 'success', total_cost_usd: total, modelUsage: {}, ...extra });
    await until(() => session.snapshot().state === 'idle' && events.filter(event => event.type === 'turn.completed').length > count);
  }
  return { directory, runtime, session, spec, fake, events, send, result };
}

test('a CLI-confirmed raw model choice survives renewal before its next init observation', async t => {
  const f = fixture(t); f.spec.model = 'original-model'; await f.session.start();
  const id = await f.send('/model selected-model');
  await f.result(0, { local_command: 'model', is_error: false, user_message_uuid: id });
  assert.equal(f.spec.model, 'selected-model');
  assert.equal((await f.session.runOptions({})).model, 'fake-model', 'a choice does not invent an observation');
  f.spec.monthlyBudgetUsd = 11;
  await f.send();
  assert.equal(f.fake.calls[1].options.model, 'selected-model');
  assert.equal(f.fake.calls[1].options.resume, f.fake.sessionId);
  assert.equal(f.fake.inputs.length, 2, 'renewal never replays the slash input');
  await f.result(0, { terminal_reason: 'completed' });
});

test('a CLI-confirmed raw default reset is reapplied when the query renews', async t => {
  const f = fixture(t), resets = [], query = f.fake.sdk.query;
  f.fake.sdk.query = spec => ({ ...query(spec), async setModel(model) { resets.push(model); },
    async getContextUsage() { return { model: 'default-model' }; } });
  f.spec.model = 'original-model'; await f.session.start();
  const id = await f.send('/model default');
  await f.result(0, { local_command: 'model', is_error: false, user_message_uuid: id });
  assert.equal(f.spec.model, null);
  f.spec.monthlyBudgetUsd = 11; await f.send();
  assert.equal(f.fake.calls[1].options.model, undefined);
  assert.deepEqual(resets, [undefined]);
  assert.equal((await f.session.runOptions({})).model, 'default-model');
  await f.result(0, { terminal_reason: 'completed' });
});

test('only a successful identified parent model change becomes a renewed configuration', async t => {
  for (const kind of ['read', 'failed', 'interrupted', 'unmatched', 'unidentified', 'replay', 'child', 'reply']) {
    const f = fixture(t); f.spec.model = 'original-model'; await f.session.start();
    const id = await f.send(kind === 'read' ? '/model' : '/model selected-model');
    const result = { local_command: 'model', is_error: false, user_message_uuid: id };
    if (kind === 'failed') { result.subtype = 'error_during_execution'; result.is_error = true; }
    if (kind === 'interrupted') result.terminal_reason = 'interrupted';
    if (kind === 'unmatched') result.user_message_uuid = 'another-input';
    if (kind === 'unidentified') delete result.user_message_uuid;
    if (['replay', 'child', 'reply'].includes(kind)) {
      f.fake.emit(kind === 'reply' ? { type: 'assistant', message: { model: 'fallback-model', content: [{ type: 'text', text: 'reply' }] } }
        : { type: 'result', uuid: randomUUID(), subtype: 'success', ...result,
          ...(kind === 'replay' ? { isReplay: true } : { parent_tool_use_id: 'child' }) });
      await f.result(0, { terminal_reason: 'completed' });
    } else await f.result(0, result);
    assert.equal(f.spec.model, 'original-model', kind);
    f.spec.monthlyBudgetUsd = 11; await f.send();
    assert.equal(f.fake.calls[1].options.model, 'original-model', kind);
    await f.result(0, { terminal_reason: 'completed' });
  }
});

test('monthly allowance above five dollars stays available across idle turns without charging history', { timeout: 5000 }, async t => {
  const f = fixture(t); await f.session.start();
  for (const total of [2, 4, 6]) { await f.send(); await f.result(total); }
  assert.deepEqual(f.fake.calls.map(call => call.options.maxBudgetUsd), [10]);
  assert.equal(f.fake.closes.length, 0, 'spending within the same monthly allowance does not renew the retained query');
  assert.equal(f.runtime.usage.available(10), 4e6); assert.equal(f.runtime.usage.summary().monthUsdMicros, 6e6);
  await f.send(); assert.equal(f.fake.calls.length, 1);
  assert.equal(f.fake.inputs.length, 4, 'no input is automatically replayed');
});

test('a single turn can use more than five dollars and a session without a monthly budget has no cap', async t => {
  for (const budget of [20, null]) {
    const f = fixture(t, budget); await f.session.start(); await f.send();
    assert.equal(f.fake.calls[0].options.maxBudgetUsd, budget === null ? undefined : 20);
    await f.result(7, { terminal_reason: 'completed' });
    assert.equal(f.events.findLast(event => event.type === 'turn.completed').payload.status, 'completed');
    assert.equal(f.runtime.usage.summary().monthUsdMicros, 7e6);
    await f.send(); assert.equal(f.fake.calls.length, 1);
  }
});

test('M1 a query uses the remaining monthly budget across idle turns without charging resumed history', { timeout: 5000 }, async t => {
  const f = fixture(t); await f.session.start();
  for (const total of [2, 4, 7]) { await f.send(); await f.result(total); }
  assert.deepEqual(f.fake.calls.map(call => call.options.maxBudgetUsd), [10]);
  assert.equal(f.fake.closes.length, 0, 'spending alone does not restart the idle query');
  assert.equal(f.runtime.usage.available(10), 3e6); assert.equal(f.runtime.usage.summary().monthUsdMicros, 7e6);
  f.runtime.usage.record('other-session', { uuid: 'external-cost', total_cost_usd: 1, modelUsage: {} });
  await f.send();
  assert.equal(f.fake.calls[1].options.maxBudgetUsd, 2);
  assert.equal(f.fake.calls[1].options.resume, f.fake.sessionId);
  await f.result(7.5);
  assert.equal(f.runtime.usage.summary().monthUsdMicros, 8.5e6, 'resume charges only the new half dollar');
  assert.equal(f.fake.inputs.length, 4, 'no input is automatically replayed');
});

test('M1 automatic wake at an old query cap preserves a raised monthly allowance', { timeout: 5000 }, async t => {
  const f = fixture(t); await f.session.start(); await f.send(); await f.result(1);
  f.spec.monthlyBudgetUsd = 20;
  f.fake.emit({ type: 'assistant', uuid: randomUUID(), message: { content: [{ type: 'text', text: 'background work' }] } });
  await until(() => f.session.snapshot().state === 'running'); await f.result(10);
  f.fake.emit({ type: 'assistant', uuid: randomUUID(), message: { id: randomUUID(), content: [{ type: 'text', text: 'background wake' }] } });
  await until(() => f.fake.closes.length === 1 && f.session.snapshot().state === 'idle');
  const turn = f.events.findLast(event => event.type === 'turn.completed');
  assert.equal(turn.payload.status, 'interrupted'); assert.match(turn.payload.error, /API 预算上限/);
  assert.doesNotMatch(turn.payload.error, /本月.*已用完/);
  assert.equal(f.runtime.apiState(20).status, 'ready');
  assert.ok(!f.events.some(event => event.type === 'error' && event.payload.code === 'sdk_failed'));
  assert.ok(!f.events.some(event => event.type === 'session.state' && event.payload.state === 'failed'));
});

test('M1 live background tasks preserve their process until a safe explicit message boundary', { timeout: 5000 }, async t => {
  const f = fixture(t); await f.session.start(); await f.send();
  f.fake.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'monitor', run_id: '2' }] });
  await f.result(1);
  f.runtime.usage.record('other-offline-session', { uuid: 'other-cost', total_cost_usd: 1, modelUsage: {} });
  await f.send(); assert.equal(f.fake.calls.length, 1);
  f.fake.emit({ type: 'system', subtype: 'task_notification', task_id: 'monitor', run_id: '1', status: 'completed' });
  await f.result(2); await f.send(); assert.equal(f.fake.calls.length, 1, 'a late task completion cannot permit a restart');
  f.fake.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  await f.result(3); await f.send(); assert.equal(f.fake.calls.length, 2);
  assert.equal(f.fake.calls[1].options.maxBudgetUsd, 6, 'renewal also receives the remaining monthly allowance above five dollars');
});

test('an older query cap interruption leaves remaining monthly funds available for the next explicit turn', { timeout: 5000 }, async t => {
  const f = fixture(t, 5); await f.session.start(); await f.send();
  f.spec.monthlyBudgetUsd = 10;
  await f.result(5, { subtype: 'error_max_budget_usd', is_error: true });
  const turn = f.events.findLast(event => event.type === 'turn.completed');
  assert.equal(turn.payload.status, 'interrupted'); assert.match(turn.payload.error, /API 预算上限/); assert.doesNotMatch(turn.payload.error, /本月.*已用完/);
  assert.equal(f.runtime.apiState(10).status, 'ready');
  await f.send(); assert.equal(f.fake.calls[1].options.maxBudgetUsd, 5);
  assert.ok(!f.events.some(event => event.type === 'session.state' && event.payload.state === 'failed'));
});

for (const limit of ['month', 'query']) test(`M1 automatic wake with no ${limit} allowance stops cleanly instead of failing the session`, { timeout: 5000 }, async t => {
  const f = fixture(t); await f.session.start(); await f.send(); await f.result(1);
  if (limit === 'month') f.runtime.usage.record('other-offline-session', { uuid: 'other-cost', total_cost_usd: 9, modelUsage: {} });
  else { await f.send(); await f.result(10); }
  f.fake.emit({ type: 'assistant', uuid: randomUUID(), message: { id: randomUUID(), content: [{ type: 'text', text: 'background wake' }] } });
  await until(() => f.fake.closes.length === 1 && f.session.snapshot().state === 'idle');
  const turn = f.events.findLast(event => event.type === 'turn.completed');
  assert.equal(turn.payload.status, 'interrupted'); assert.match(turn.payload.error, /本月 API 预算/);
  assert.equal(f.runtime.apiState(10).status, 'budget_exhausted');
  assert.ok(!f.events.some(event => event.type === 'error' && event.payload.code === 'sdk_failed'));
  assert.ok(!f.events.some(event => event.type === 'session.state' && event.payload.state === 'failed'));
});

for (const mode of ['api-only', 'api-then-terminal']) test(`M1 monthly exhaustion follows ${mode} without failing or replaying input`, { timeout: 5000 }, async t => {
  const f = fixture(t), terminals = [];
  fs.writeFileSync(path.join(f.directory, 'settings.json'), JSON.stringify({ claudePath: mode, codexView: 'native', monthlyBudgetUsd: 1 }));
  const native = createNativeSessions({ directory: f.directory, claude: f.runtime,
    prepareTerminal: terminalPreparation(spec => terminals.push(spec)),
    resolveSpec: id => ({ agent: 'claude', owner: 'gui', projectId: 'p', terminalId: id, cwd: f.directory }),
    terminal: async (...args) => terminals.push(args), emit: event => f.events.push(event) });
  t.after(() => native.close());
  const { runtimeSessionId } = await native.start('t', { agent: 'claude' });
  await native.send('t', runtimeSessionId, { clientMessageId: randomUUID(), text: 'first' });
  await until(() => f.fake.inputs.length === 1);
  f.fake.emit({ type: 'result', uuid: randomUUID(), subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 1, modelUsage: {} });
  await until(() => native.snapshot('t').state === (mode === 'api-only' ? 'stopped' : 'idle'));
  const turn = f.events.findLast(event => event.type === 'turn.completed');
  assert.equal(turn.payload.status, 'interrupted'); assert.match(turn.payload.error, /本月 API 预算/);
  const next = () => native.send('t', runtimeSessionId, { clientMessageId: randomUUID(), text: 'keep this draft' });
  assert.equal((await next()).status, 'rejected'); assert.equal(terminals.length, 0, 'unsent input cannot bypass the switch coordinator');
  if (mode === 'api-then-terminal') { await completeSwitch(native, 't'); assert.equal(terminals.length, 1); }
  assert.equal(f.fake.inputs.length, 1, 'neither mode automatically resends a pending draft');
});

// Claude Code exits before initialize for a --max-budget-usd that is not a positive number (real 2.1.317: exit 1 for 0 and -1, with
// "--max-budget-usd must be a positive number greater than 0" on stderr). This SDK stand-in refuses the same way.
function strictSdk(fake) {
  const query = fake.sdk.query;
  fake.sdk.query = spec => {
    const cap = spec.options.maxBudgetUsd;
    if (cap === undefined || Number.isFinite(cap) && cap > 0) return query(spec);
    fake.calls.push(spec);
    spec.options.stderr?.(`error: option '--max-budget-usd <amount>' argument '${cap}' is invalid. --max-budget-usd must be a positive number greater than 0\n`);
    return { initializationResult: async () => { throw Object.assign(new Error('Claude Code process exited with code 1'), { errorClass: 'process_exited_nonzero', exitCode: 1 }); },
      close() {}, async *[Symbol.asyncIterator]() {} };
  };
  return fake;
}
const modelList = (url, options, callback) => {
  const request = new EventEmitter(); request.destroy = () => {};
  request.end = () => queueMicrotask(() => { const response = new PassThrough(); response.statusCode = 200; callback(response); response.end(JSON.stringify({ data: [{ id: 'claude-test-model' }] })); });
  return request;
};
const reversed = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).reverse(), decryptString: value => Buffer.from(value).reverse().toString() };
function owner(t, budget, directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-budget-guard-'))) {
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const fake = strictSdk(fakeSdk({ auto: false }));
  const runtime = createClaudeRuntime({ directory, loadSdk: async () => fake.sdk, resolveExecutable: async () => process.execPath, request: modelList, safeStorage: reversed,
    inspectCli: async () => ({ status: 'ok', version: '2.1.317', required: '2.1.317' }), connectionSpec: () => ({ agent: 'claude', owner: 'gui', cwd: directory, env: {} }) });
  t.after(() => runtime.close());
  runtime.credentials.save('sk-ant-api03-budget-offline-test-only');
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ claudePath: 'api-then-terminal', codexView: 'native', monthlyBudgetUsd: budget }));
  const events = [];
  const session = () => runtime.create({ agent: 'claude', owner: 'gui', runtimeSessionId: randomUUID(), projectId: '', terminalId: 't', cwd: directory, monthlyBudgetUsd: budget, env: {} },
    event => events.push(event));
  return { directory, fake, runtime, events, session };
}
// A process that no longer runs, by injection: a real exited pid can be reused at once on Windows by a concurrent test.
// The stand-in is the test runner, which does run, so a ledger read without the injection keeps its entries held.
const ENDED = process.ppid, ended = pid => pid !== ENDED;
const zero = 'API 月预算设为 0，原生会话不使用 API。', held = '本月剩余的 API 预算被其他会话占用，或有会话的花费还未确认。';

for (const [month, reason] of [['set to zero', zero], ['spent', 'budget_exhausted'], ['held by a running session', held]]) {
  test(`a month budget ${month}: the connection test reads billing without a cap and the path says why`, async t => {
    const f = owner(t, month === 'set to zero' ? 0 : 10);
    if (month === 'spent') f.runtime.usage.record('other-offline-session', { uuid: 'spent', total_cost_usd: 10, modelUsage: {} });
    if (month === 'held by a running session') f.runtime.usage.reserve(10, { sessionId: 'other-offline-session' });
    const result = await createNativeSessions({ directory: f.directory, claude: f.runtime }).testConnection();
    assert.deepEqual(result.billing, { status: 'ok', source: 'ANTHROPIC_API_KEY' });
    assert.equal(f.fake.calls.length, 1); assert.equal(Object.hasOwn(f.fake.calls[0].options, 'maxBudgetUsd'), false, 'initialize spends nothing and takes no cap');
    assert.equal(result.path, 'terminal'); assert.equal(result.reason, reason);
    assert.doesNotMatch(JSON.stringify(result), /max-budget-usd|退出码/);
  });
}

test('a session with no allowance left starts no Claude Code and says why before any input', async t => {
  const f = owner(t, 0), session = f.session(); await session.start();
  await assert.rejects(session.models(), error => error.code === 'budget_exhausted' && error.message === zero);
  await assert.rejects(session.send({ clientMessageId: randomUUID(), text: 'must stay unsent' }),
    error => error.code === 'budget_exhausted' && error.beforeInput === true && error.message === zero);
  assert.equal(f.fake.calls.length, 0); assert.equal(f.fake.inputs.length, 0);
  assert.ok(!f.events.some(event => event.type === 'session.state' && event.payload.state === 'failed'));
  await session.close();
});

test('every SDK query starts through openQuery, which passes only a positive finite cap', () => {
  const { openQuery } = require('../electron/features/claude-sdk/query.cjs');
  const started = [], sdk = { query: value => { started.push(value); return value; } };
  for (const cap of [0, -1, NaN, Infinity, '1', null]) {
    assert.throws(() => openQuery(sdk, [], { maxBudgetUsd: cap }), error => error.code === 'invalid_budget' && error.beforeInput === true, String(cap));
  }
  for (const cap of [undefined, 0.000001, 10]) openQuery(sdk, [], { maxBudgetUsd: cap });
  assert.deepEqual(started.map(value => value.options.maxBudgetUsd), [undefined, 0.000001, 10]);
  // A mechanical guard: no other module starts a query, so no cap reaches the CLI unchecked.
  const root = path.join(__dirname, '../electron'), files = fs.readdirSync(root, { recursive: true }).filter(file => file.endsWith('.cjs'));
  const callers = files.filter(file => /\.query\(\s*\{/.test(fs.readFileSync(path.join(root, file), 'utf8')));
  assert.deepEqual(callers.map(file => file.replaceAll('\\', '/')), ['features/claude-sdk/query.cjs']);
});

test('a reservation or estimate left by a process that no longer runs holds nothing after a restart, and its session still settles it', async t => {
  const f = owner(t, 10), file = path.join(f.directory, 'usage.json');
  await f.runtime.close();
  const before = createUsage({ file, pid: ENDED });
  before.record('earlier-session', { uuid: 'earlier', total_cost_usd: 1, modelUsage: {} });
  const closed = before.reserve(10, { maxBudgetUsd: 1 });
  before.unverified(closed.id); before.finish(closed.id);
  const left = before.reserve(10, { sessionId: 'crashed-session' });
  assert.equal(before.available(10), 0, 'while its process runs, nothing is left');
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  ledger.reservations.lastMonth = { month: '2000-01', micros: 5000000, sessionId: null, baseline: 0, day: '2000-01-31' };
  fs.writeFileSync(file, JSON.stringify(ledger));
  const after = createClaudeRuntime({ directory: f.directory, safeStorage: reversed, alive: ended });
  t.after(() => after.close());
  assert.equal(after.usage.available(10), 9000000);
  assert.equal(after.usage.summary().monthUsdMicros, null, 'the crashed turn spent an unknown amount');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.reservations, {}); assert.equal(Object.hasOwn(saved.estimates, 'lastMonth'), false);
  assert.deepEqual(Object.values(saved.estimates).map(entry => entry.micros), [0, 0]);
  assert.equal(saved.estimates[left.id].sessionId, 'crashed-session');
  // That session's next cumulative result charges against the baseline the leftover kept and clears its marker.
  after.usage.record('crashed-session', { uuid: 'resumed', total_cost_usd: 0.5, modelUsage: {} }, { resume: true });
  assert.equal(after.usage.available(10), 8500000);
  assert.equal(Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).estimates).some(entry => entry.sessionId === 'crashed-session'), false);
});

test('a reservation of a process that still runs stays held after another reads the ledger', async t => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agx-budget-live-')), 'usage.json');
  t.after(() => fs.promises.rm(path.dirname(file), { recursive: true, force: true }));
  const running = createUsage({ file, pid: 4242 }); running.reserve(10);
  assert.equal(createUsage({ file, alive: pid => pid === 4242 }).available(10), 0);
  assert.equal(createUsage({ file, alive: () => false }).available(10), 10000000);
});

// The default liveness check against a real process. Windows reuses a freed pid at once, so a concurrent test may own it
// by the time the ledger is read; Linux and macOS hand out pids in sequence, so there the exited child's pid stays free.
test('by default a reservation of a child that has exited holds nothing for the next reader', { skip: process.platform === 'win32' && 'Windows reuses pids at once' }, async t => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agx-budget-pid-')), 'usage.json');
  t.after(() => fs.promises.rm(path.dirname(file), { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  createUsage({ file, pid: child.pid }).reserve(10);
  assert.equal(createUsage({ file }).available(10), 10000000);
});

test('a ledger that cannot be written at startup leaves the runtime usable and is saved with the next change', async t => {
  const f = owner(t, 10), file = path.join(f.directory, 'usage.json');
  await f.runtime.close();
  createUsage({ file, pid: ENDED }).reserve(10, { sessionId: 'crashed-session' });
  const warnings = t.mock.method(console, 'warn', () => {});
  const rename = t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(to) === 'usage.json') throw Object.assign(new Error('held by a scanner'), { code: 'EPERM' });
    return rename.mock.original(from, to);
  });
  const after = createClaudeRuntime({ directory: f.directory, safeStorage: reversed, alive: ended });
  t.after(() => after.close());
  rename.mock.restore();
  assert.equal(after.usage.available(10), 10000000, 'the leftover holds nothing although the disk still has it');
  assert.equal(warnings.mock.callCount(), 1); assert.match(warnings.mock.calls[0].arguments[0], /EPERM/);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).reservations).length, 1);
  after.usage.record('other-session', { uuid: 'next', total_cost_usd: 1, modelUsage: {} });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.reservations, {}); assert.equal(Object.values(saved.estimates)[0].micros, 0);
});

test('a background wake refused for allowance held by another session names that cause, not a spent month', { timeout: 5000 }, async t => {
  const f = fixture(t); await f.session.start(); await f.send(); await f.result(1);
  f.runtime.usage.reserve(10, { sessionId: 'other-offline-session' });
  f.fake.emit({ type: 'assistant', uuid: randomUUID(), message: { id: randomUUID(), content: [{ type: 'text', text: 'background wake' }] } });
  await until(() => f.fake.closes.length === 1 && f.session.snapshot().state === 'idle');
  assert.equal(f.events.findLast(event => event.type === 'turn.completed').payload.error, held);
  assert.equal(f.events.findLast(event => event.type === 'error' && event.payload.code === 'budget_exhausted').payload.message, held);
});
