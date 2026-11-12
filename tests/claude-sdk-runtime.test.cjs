const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createCredentials, apiEnvironment } = require('../electron/features/claude-sdk/credentials.cjs');
const { createUsage } = require('../electron/features/claude-sdk/usage.cjs');
const { createNormalizer } = require('../electron/features/claude-sdk/normalize.cjs');
const { createRequests } = require('../electron/features/claude-sdk/requests.cjs');
const { createPolicy } = require('../electron/features/claude-sdk/policy.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const key = 'sk-ant-api03-fake-test-value-never-real';
const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from([...value].reverse().join('')), decryptString: value => [...value.toString()].reverse().join('') };
function directory(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-sdk-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
async function until(fn) { for (let i = 0; i < 1000; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('fake runtime did not settle'); }
function setup(t, fakeOptions) {
  const dir = directory(t), fake = fakeSdk(fakeOptions), events = [];
  const runtime = createClaudeRuntime({ directory: dir, safeStorage, loadSdk: async () => fake.sdk, resolveExecutable: async () => process.execPath });
  runtime.credentials.save(key);
  const spec = { cwd: dir, worktree: dir, agent: 'claude', owner: 'gui', terminalId: 'terminal', projectId: 'project', runtimeSessionId: randomUUID(), env: { PATH: '' }, monthlyBudgetUsd: 10 };
  const session = runtime.create(spec, event => events.push(event)); t.after(() => session.close());
  return { dir, fake, events, runtime, spec, session };
}
test('owner queries remain alive at idle and reuse the same process on the next send', async t => {
  const { session, fake, events, runtime, spec } = setup(t); spec.monthlyBudgetUsd = null; await session.start();
  assert.equal(session.connection().kind, 'none');
  const first = randomUUID(), second = randomUUID();
  session.send({ clientMessageId: first, text: 'one' });
  await until(() => events.some(event => event.type === 'turn.completed'));
  session.send({ clientMessageId: second, text: 'two' });
  await until(() => events.filter(event => event.type === 'turn.completed').length === 2);
  assert.equal(fake.calls.length, 1); assert.equal(fake.closes.length, 0); assert.equal(session.snapshot().state, 'idle');
  assert.equal(session.connection().kind, 'api');
  assert.equal(runtime.connection(session.snapshot().runtimeSessionId).kind, 'api');
  assert.equal(runtime.usage.summary().monthUsdMicros, 200000);
  assert.equal(fake.calls[0].options.pathToClaudeCodeExecutable, process.execPath);
  assert.equal(fake.calls[0].options.env.ANTHROPIC_API_KEY, key);
  assert.ok(!JSON.stringify(events).includes(key));
  assert.equal((await session.send({ clientMessageId: first, text: 'duplicate' })).status, 'consumed');
  assert.equal(fake.inputs.length, 2);
});
test('a worker loads normal setting sources while blocking failed policy hooks', async t => {
  const { runtime, spec, fake } = setup(t, { auto: false });
  const session = runtime.create({ ...spec, owner: 'dispatch', readOnly: false, allow: ['**'] }, () => {}); t.after(() => session.close());
  await session.start();
  await session.send({ clientMessageId: randomUUID(), text: 'worker' });
  assert.deepEqual(fake.calls[0].options.settingSources, ['user', 'project', 'local']);
  assert.equal(fake.calls[0].options.hooks.PreToolUse[0].onFailure, 'block');
  assert.equal((await fake.calls[0].options.canUseTool('Bash', { command: 'node --version' }, {})).behavior, 'allow');
});
test('billing identity mismatch fails without trusting a subscription init', async t => {
  const { session, events } = setup(t, { source: 'user' }); await session.start(); session.send({ clientMessageId: randomUUID(), text: 'test' });
  await until(() => session.snapshot().state === 'failed');
  assert.ok(events.some(event => event.type === 'error' && event.payload.code === 'billing_identity_mismatch'));
  assert.equal(events.filter(event => event.type === 'usage.updated').length, 0);
});
test('stop rejects queued input and stale permission answers', async t => {
  const { session, fake, events } = setup(t, { auto: false }); await session.start(); session.send({ clientMessageId: randomUUID(), text: 'pending' });
  await until(() => fake.inputs.length === 1);
  const pending = fake.calls[0].options.canUseTool('Bash', { command: 'echo test' }, {});
  const request = events.find(event => event.type === 'request.opened'); assert.ok(request);
  await session.close(); assert.equal((await pending).behavior, 'deny');
  assert.throws(() => session.answer(request.payload.requestId, { decision: 'allow' }));
  assert.ok(events.some(event => event.type === 'input.receipt' && event.payload.status === 'unknown'));
});
test('snapshots replay completed items without counting cost twice', async t => {
  const { session, runtime } = setup(t); await session.start(); session.send({ clientMessageId: randomUUID(), text: 'hello' });
  await until(() => session.snapshot().state === 'idle' && session.snapshot().lastSequence > 3);
  const snapshot = session.snapshot(); assert.ok(snapshot.events.every(event => event.replay));
  assert.ok(snapshot.events.some(event => event.type === 'item.upsert' && event.payload.content.text === 'fake answer'));
  assert.equal(runtime.usage.summary().monthUsdMicros, 100000);
});
test('credential status returns only saved and ciphertext never contains the test key', t => {
  const file = path.join(directory(t), 'credentials.json'), credentials = createCredentials({ file, safeStorage });
  assert.deepEqual(credentials.status(), { saved: false }); credentials.save(key);
  assert.deepEqual(credentials.status(), { saved: true }); assert.equal(credentials.read(), key);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(key)); credentials.clear(); assert.equal(credentials.read(), null);
});
test('unsafe storage and admin credentials are refused', t => {
  const file = path.join(directory(t), 'credentials.json');
  assert.throws(() => createCredentials({ file, safeStorage: { isEncryptionAvailable: () => false } }).save(key));
  assert.throws(() => createCredentials({ file, platform: 'linux', safeStorage: { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' } }).save(key));
  assert.throws(() => createCredentials({ file, safeStorage }).save('sk-ant-admin-fake-test-value-never-real'));
  assert.ok(!fs.existsSync(file));
});
test('selected API environment removes conflicting authentication without mutating the parent', () => {
  const env = { PATH: 'fake', ANTHROPIC_BASE_URL: 'https://invalid.test', CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth', AGENTRIX_CONTROL_TOKEN: 'fake-capability' };
  const result = apiEnvironment(env, key); assert.equal(result.PATH, 'fake'); assert.equal(result.ANTHROPIC_API_KEY, key);
  assert.equal(result.ANTHROPIC_BASE_URL, undefined); assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, undefined); assert.equal(result.AGENTRIX_CONTROL_TOKEN, undefined); assert.equal(env.ANTHROPIC_API_KEY, undefined);
});
test('GUI SDK authentication is marked for descendant helpers without scrubbing the owner', async t => {
  const { workerEnvironment } = require('../electron/features/codex-app-server/index.cjs');
  const { session, fake, spec } = setup(t);
  await session.start(); await session.send({ clientMessageId: randomUUID(), text: 'owner task' });
  const env = fake.calls[0].options.env;
  assert.equal(env.AGENTRIX_SDK_PARENT, '1');
  assert.equal(env.ANTHROPIC_API_KEY, key);
  assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '0');
  const helper = workerEnvironment(env);
  assert.equal(helper.ANTHROPIC_API_KEY, undefined);
  assert.equal(helper.AGENTRIX_SDK_PARENT, undefined);
  assert.equal(helper.PATH, spec.env.PATH);
  assert.equal(env.ANTHROPIC_API_KEY, key);
  assert.equal(spec.env.AGENTRIX_SDK_PARENT, undefined);
});

test('GUI API environments keep the dispatch bootstrap while worker API environments strip it', () => {
  const env = { PATH: 'synthetic', AGENTRIX_BOOTSTRAP: 'synthetic-bootstrap', AGENTRIX_CONTROL_CAPABILITY: 'synthetic-capability' };
  assert.equal(apiEnvironment(env, key, 'gui').AGENTRIX_BOOTSTRAP, env.AGENTRIX_BOOTSTRAP);
  assert.equal(apiEnvironment(env, key, 'dispatch').AGENTRIX_BOOTSTRAP, undefined);
  assert.equal(apiEnvironment(env, key, 'gui').AGENTRIX_CONTROL_CAPABILITY, undefined);
  assert.equal(env.AGENTRIX_BOOTSTRAP, 'synthetic-bootstrap');
});
test('usage deltas persist across resume, deduplicate, and ignore zeroed failures', t => {
  const file = path.join(directory(t), 'usage.json'); let usage = createUsage({ file, now: () => Date.UTC(2026, 10, 3) });
  const result = { uuid: 'first', total_cost_usd: 1, modelUsage: {} };
  assert.equal(usage.record('session', result).deltaUsdMicros, 1000000);
  assert.equal(usage.record('session', result).deltaUsdMicros, 0);
  usage = createUsage({ file, now: () => Date.UTC(2026, 10, 3) });
  assert.equal(usage.record('session', { ...result, uuid: 'second', total_cost_usd: 1.2 }, { resume: true }).deltaUsdMicros, 200000);
  assert.equal(usage.record('session', { uuid: 'error', total_cost_usd: 0, is_error: true }).deltaUsdMicros, null);
  assert.equal(usage.baseline('session'), 1200000); assert.equal(usage.summary().monthUsdMicros, 1200000);
});
test('unknown resume baselines never charge historical totals', t => {
  const usage = createUsage({ file: path.join(directory(t), 'usage.json') });
  assert.equal(usage.record('old', { uuid: 'one', total_cost_usd: 20 }, { resume: true }).deltaUsdMicros, null);
  assert.equal(usage.summary().monthUsdMicros, null);
});
test('concurrent reservations and crash leftovers cannot spend the budget twice', t => {
  const file = path.join(directory(t), 'usage.json'), usage = createUsage({ file });
  const one = usage.reserve(6);
  assert.equal(one.maxBudgetUsd, 6); assert.throws(() => usage.reserve(6));
  assert.equal(usage.available(6, one.id), 6000000, 'only the owning query may count its own held allowance');
  assert.equal(createUsage({ file }).available(6), 0);
  usage.release(one.id); assert.equal(usage.available(6), 6000000);
  const partial = usage.reserve(6, { maxBudgetUsd: 2 }), remainder = usage.reserve(6);
  assert.equal(partial.maxBudgetUsd, 2); assert.equal(remainder.maxBudgetUsd, 4);
  assert.throws(() => usage.reserve(6));
});
test('an explicitly capped reservation leaves the rest of the month available to another query', t => {
  const file = path.join(directory(t), 'usage.json'), usage = createUsage({ file });
  const one = usage.reserve(12, { maxBudgetUsd: 7 }), two = usage.reserve(12);
  assert.equal(one.maxBudgetUsd, 7); assert.equal(two.maxBudgetUsd, 5); assert.throws(() => usage.reserve(12));
  assert.equal(createUsage({ file }).available(12), 0);
  usage.release(one.id); assert.equal(usage.available(12), 7000000);
});
test('UTC month rollover keeps key-independent prior spend and a zero budget blocks API', t => {
  let now = Date.UTC(2026, 10, 30, 23, 59); const usage = createUsage({ file: path.join(directory(t), 'usage.json'), now: () => now });
  usage.record('s', { uuid: 'r', total_cost_usd: 1 }); assert.equal(usage.summary().month, '2026-11');
  now = Date.UTC(2026, 11, 1); assert.equal(usage.summary().monthUsdMicros, 0); assert.equal(usage.available(0), 0); assert.throws(() => usage.reserve(0));
});
test('normalizer merges delta and final snapshots and associates tool results', () => {
  const events = [], normalize = createNormalizer((type, payload, extra) => events.push({ type, payload, ...extra }));
  normalize({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } } });
  normalize({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } });
  const final = { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'hi there' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'test' } }] } };
  normalize(final); normalize(final); normalize({ type: 'user', uuid: 'u', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
  assert.equal(events.filter(event => event.itemId === 'm:0' && event.type === 'item.upsert').length, 1);
  assert.equal(events.at(-1).itemId, 't'); assert.equal(events.at(-1).payload.status, 'completed');
});
test('permission tickets are consumed once and invalid question answers remain correctable', async () => {
  const events = [], requests = createRequests({ publish: (type, payload) => events.push({ type, payload }), state() {} });
  const result = requests.open('AskUserQuestion', { questions: [{ question: 'Choose?', options: [{ label: 'A' }] }] });
  const id = events[0].payload.requestId;
  assert.throws(() => requests.answer(id, { answers: {} }));
  requests.answer(id, { answers: { 0: 'A' } }); assert.equal((await result).updatedInput.answers['Choose?'], 'A');
  assert.throws(() => requests.answer(id, { answers: { 0: 'A' } }));
});
test('worker policy permits general commands, rejects explicit Git and scoped path escapes', t => {
  const dir = directory(t), audit = [], policy = createPolicy({ owner: 'dispatch', cwd: dir, allow: ['src/**'] }, event => audit.push(event));
  assert.equal(policy('Bash', { command: 'python -m pytest' }).behavior, 'allow');
  assert.equal(policy('Bash', { command: 'git -C . reset --hard HEAD' }).behavior, 'deny');
  assert.equal(policy('Write', { file_path: path.join(dir, 'src/file.cjs') }).behavior, 'allow');
  assert.equal(policy('Write', { file_path: path.join(dir, '../outside') }).behavior, 'deny');
  assert.equal(policy('WebFetch', {}).behavior, 'deny'); assert.equal(policy('Agent', {}).behavior, 'deny');
  assert.equal(audit.length, 6);
});
test('read-only workers deny edits and shell and require exact SKILL authorization', t => {
  const dir = directory(t), policy = createPolicy({ owner: 'dispatch', cwd: dir, readOnly: true, allow: ['**'] });
  assert.equal(policy('Read', { file_path: path.join(dir, 'file') }).behavior, 'allow');
  assert.equal(policy('Bash', { command: 'echo test' }).behavior, 'deny');
  assert.equal(policy('Write', { file_path: path.join(dir, 'file') }).behavior, 'deny');
  assert.equal(createPolicy({ owner: 'dispatch', cwd: dir, allow: ['**'] })('Edit', { file_path: path.join(dir, 'SKILL.md') }).reasonCode, 'skill_not_authorized');
});

test('a fresh reservation resumes the same SDK session only on the next explicit send', async t => {
  const dir = directory(t), sessionId = randomUUID(), first = fakeSdk({ auto: false, sessionId });
  let loads = 0; const events = [];
  const runtime = createClaudeRuntime({ directory: dir, safeStorage, resolveExecutable: async () => process.execPath, loadSdk: async () => { loads++; return first.sdk; } });
  runtime.credentials.save(key);
  const session = runtime.create({ agent: 'claude', owner: 'gui', cwd: dir, projectId: 'p', terminalId: 't', runtimeSessionId: 'runtime', monthlyBudgetUsd: 10 }, event => events.push(event));
  t.after(() => session.close()); await session.start();
  const id = randomUUID(); session.send({ clientMessageId: id, text: 'first task' }); await until(() => first.inputs.length === 1);
  first.emit({ type: 'result', uuid: 'one', user_message_uuid: id, is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 5, modelUsage: {} });
  await until(() => events.some(event => event.type === 'turn.completed') && session.snapshot().state === 'idle');
  assert.equal(loads, 1);
  await session.send({ clientMessageId: randomUUID(), text: 'next explicit task' }); await until(() => first.inputs.length === 2);
  assert.equal(first.calls[1].options.resume, sessionId); assert.equal(first.inputs[1].message.content, 'next explicit task');
  first.emit({ type: 'result', uuid: 'two', total_cost_usd: 5.1, modelUsage: {}, subtype: 'success' });
  await until(() => runtime.usage.summary().monthUsdMicros === 5100000);
  assert.equal(session.snapshot().runtimeSessionId, 'runtime');
});
test('duplicate SDK results never publish a second completion or cost', async t => {
  const { session, fake, events, runtime } = setup(t, { auto: false }); await session.start(); session.send({ clientMessageId: randomUUID(), text: 'one' });
  await until(() => fake.inputs.length === 1);
  const result = { type: 'result', uuid: 'same-result', subtype: 'success', total_cost_usd: 0.1, modelUsage: {} };
  fake.emit(result); fake.emit(result); await until(() => events.some(event => event.type === 'turn.completed'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(events.filter(event => event.type === 'turn.completed').length, 1); assert.equal(runtime.usage.summary().monthUsdMicros, 100000);
});
test('G7 rate-limit events carry restrictions without inventing an API credit balance', async t => {
  const { session, fake, events } = setup(t, { auto: false }); await session.start(); session.send({ clientMessageId: randomUUID(), text: 'one' });
  await until(() => fake.inputs.length === 1); fake.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 123 } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(events.filter(event => event.type === 'limits.updated').length, 1);
  fake.emit({ type: 'assistant', error: 'rate_limit', uuid: 'error', message: { content: [] } });
  await until(() => events.some(event => event.type === 'limits.updated')); const limits = events.find(event => event.type === 'limits.updated').payload;
  assert.equal(limits.billingRoute, 'api'); assert.deepEqual(limits.limitsById, {}); assert.equal(limits.resetCredits, null);
  assert.equal(limits.ordinaryUsageAllowed, false); assert.equal(limits.notice.resetsAtMs, 123000);
});
// The executable checks run on a fake file system in Windows path rules (tests/helpers/claude-files.cjs): no real CLI
// or profile is touched, on any host. Where each install puts Claude Code is tests/claude-runtime-locator-core.test.cjs.
const W = path.win32, { fakeFiles, NATIVE } = require('./helpers/claude-files.cjs'), cliHome = 'D:\\Users\\u';
test('native executable discovery never searches relative directories or accepts wrappers', async () => {
  const { resolveClaudeExecutable } = require('../electron/features/claude-sdk/executable.cjs');
  const dir = 'D:\\agx', files = fakeFiles({ [W.join(dir, 'claude.cmd')]: { text: 'not executable' }, [W.resolve('relative', 'claude.exe')]: { size: NATIVE } });
  let probes = 0;
  // The probe keeps its own deadline: execFile's would kill a CLI that answered while main was busy.
  const probe = (_file, _args, options, callback) => { probes++; assert.equal(options.shell, false); assert.equal(options.timeout, undefined); callback(null, '2.1.317 (Claude Code)'); };
  const resolve = (answer = probe) => resolveClaudeExecutable({ env: { PATH: `relative;${dir}` }, platform: 'win32', home: cliHome, files, probe: answer, storedPath: async () => null });
  assert.equal(await resolve(), null);
  files.put(W.join(dir, 'claude.exe'), { size: NATIVE });
  for (const version of ['2.1.316', '2.0.999']) await assert.rejects(resolve((_file, _args, _options, callback) => callback(null, version)), /2\.1\.317/);
  assert.equal(await resolve(), W.join(dir, 'claude.exe'));
  assert.equal(probes, 1);
  for (const version of ['2.2.0', '3.0.0']) assert.equal(await resolve((_file, _args, _options, callback) => callback(null, version)), W.join(dir, 'claude.exe'));
});
test('a native executable whose version check fails is reported with the reason and file, never as not found', async t => {
  const { inspectClaudeExecutable } = require('../electron/features/claude-sdk/executable.cjs');
  const dir = 'D:\\agx', other = W.join(dir, 'other'), files = fakeFiles();
  const inspect = (probe, PATH = dir) => inspectClaudeExecutable({ env: { PATH }, platform: 'win32', home: cliHome, files, probe, storedPath: async () => null, timeoutMs: 20, graceMs: 20 });
  const missing = { status: 'missing', version: null, required: '2.1.317', file: null };
  assert.deepEqual(await inspect(() => assert.fail('nothing to run')), { ...missing, reason: 'not_found', pathFolders: 1, searched: ['~\\.local\\bin', '~\\.claude\\local'] });
  const found = W.join(dir, 'claude.exe'), ok = { status: 'ok', version: '2.1.322', required: '2.1.317', file: found, via: 'path', fileShown: found };
  files.put(found, { size: NATIVE });
  // A hung CLI is killed; its close then ends the check as a timeout that says how long it took.
  const child = (fields = {}) => {
    const value = { exitCode: null, signalCode: null, killed: 0, destroyed: 0, stderr: { destroy() {} },
      kill() { this.killed++; this.callback(Object.assign(new Error('killed'), { signal: 'SIGKILL' }), ''); }, ...fields };
    value.stdout = { destroy: () => { value.destroyed++; } };
    return value;
  };
  const run = value => (_file, _args, _options, callback) => { value.callback = callback; return value; };
  const hung = child(), timedOut = await inspect(run(hung));
  assert.deepEqual({ ...timedOut, elapsedMs: undefined }, { ...missing, reason: 'timeout', found, elapsedMs: undefined }); assert.ok(timedOut.elapsedMs >= 20);
  assert.equal(hung.killed, 1); assert.equal(hung.destroyed, 0);
  // One whose close never comes (a descendant holds its output open) still ends after a short grace, its streams let go:
  // killed, it timed out; already exited, its output was never read.
  const deaf = child({ kill() { this.killed++; } }), exited = child({ exitCode: 0, kill: () => assert.fail('an exited CLI is not killed') });
  assert.equal((await inspect(run(deaf))).reason, 'timeout'); assert.deepEqual([deaf.killed, deaf.destroyed], [1, 1]);
  assert.deepEqual(await inspect(run(exited)), { ...missing, reason: 'unreadable', found }); assert.equal(exited.destroyed, 1);
  // A version the CLI printed before the kill still counts.
  const late = child({ kill() { this.killed++; this.callback(Object.assign(new Error('killed'), { signal: 'SIGKILL' }), '2.1.322 (Claude Code)\n'); } });
  assert.deepEqual(await inspect(run(late)), ok); assert.equal(late.killed, 1);
  // The grace yields a turn as the deadline does: main is busy past it (from the moment the deadline finds the CLI
  // exited) and the close is already waiting when the grace comes due; the close wins.
  let busy = false;
  const slow = child({ kill: () => assert.fail('an exited CLI is not killed') });
  Object.defineProperty(slow, 'exitCode', { get() {
    if (!busy) {
      busy = true;
      setImmediate(() => { const end = Date.now() + 60; while (Date.now() < end); setImmediate(() => slow.callback(null, '2.1.322 (Claude Code)')); });
    }
    return 0;
  } });
  assert.equal((await inspect(run(slow))).status, 'ok'); assert.equal(slow.destroyed, 0);
  // The same file reached through other PATH spellings is checked once.
  let probes = 0;
  await inspect((_file, _args, _options, callback) => { probes++; callback(null, ''); }, [dir, `${dir}\\`, dir.toLowerCase()].join(';')); assert.equal(probes, 1);
  await assert.rejects(require('../electron/features/claude-sdk/executable.cjs').resolveClaudeExecutable({ env: { PATH: dir }, platform: 'win32', home: cliHome, files, storedPath: async () => null, timeoutMs: 20,
    probe: (_file, _args, _options, callback) => callback(null, '') }), error => error.code === 'native_cli_required' && error.unverified === true && /检查没有通过/.test(error.message));
  // A session that cannot start on such a CLI says so in the same words, before any input.
  const state = directory(t), fake = fakeSdk(), events = [], runtime = createClaudeRuntime({ directory: path.join(state, 'state'), safeStorage, loadSdk: async () => fake.sdk,
    resolveExecutable: async () => { throw Object.assign(new Error('x'), { code: 'native_cli_required', unverified: true }); } });
  runtime.credentials.save(key);
  const session = runtime.create({ cwd: state, worktree: state, agent: 'claude', owner: 'gui', terminalId: 't', projectId: 'p', runtimeSessionId: randomUUID(), env: { PATH: '' } }, event => events.push(event));
  t.after(() => session.close());
  await assert.rejects(session.start(), error => error.beforeInput === true && error.message === 'Claude Code 检查没有通过，无法通过 API 运行');
  assert.ok(events.some(event => event.type === 'error' && event.payload.message === 'Claude Code 检查没有通过，无法通过 API 运行'));
  // Main was busy past the deadline while the CLI had already exited: its answer, read late within the grace, still counts.
  assert.deepEqual(await inspect((_file, _args, _options, callback) => { setTimeout(() => callback(null, '2.1.322 (Claude Code)'), 25); return { exitCode: 0, signalCode: null, kill: () => assert.fail('an exited CLI is not killed') }; }), ok);
  for (const [error, code] of [[Object.assign(new Error(key), { code: 'EPERM' }), 'EPERM'], [Object.assign(new Error('x'), { code: 1 }), 'exit 1'], [new Error(key), undefined]]) {
    const value = await inspect((_file, _args, _options, callback) => callback(error, ''));
    assert.deepEqual(value, { ...missing, reason: 'failed', found, ...(code ? { error: code } : {}) }); assert.ok(!JSON.stringify(value).includes(key));
  }
  assert.deepEqual(await inspect(() => { throw new Error('spawn broke'); }), { ...missing, reason: 'failed', found });
  assert.deepEqual(await inspect((_file, _args, _options, callback) => callback(null, 'no version here')), { ...missing, reason: 'unreadable', found });
  // A failed candidate does not hide a working one later on the path, and an outdated one still reads as too old.
  files.put(W.join(other, 'claude.exe'), { size: NATIVE });
  const byFolder = answers => (file, _args, _options, callback) => callback(null, answers[W.dirname(file) === dir ? 0 : 1]);
  assert.equal((await inspect(byFolder(['', '2.1.317']), [dir, other].join(';'))).status, 'ok');
  assert.deepEqual(await inspect(byFolder(['', '2.1.300']), [dir, other].join(';')), { ...missing, status: 'too_old', version: '2.1.300' });
});
test('GUI and helper cannot resume the same Claude session concurrently', async t => {
  const { session, runtime, fake, spec } = setup(t, { auto: false }); await session.start(); session.send({ clientMessageId: randomUUID(), text: 'hold session' });
  await until(() => fake.inputs.length === 1);
  const worker = runtime.create({ ...spec, owner: 'dispatch', monthlyBudgetUsd: null, providerSessionId: fake.sessionId }, () => {}); t.after(() => worker.close());
  await assert.rejects(worker.start()); assert.equal(fake.calls.length, 1);
  await session.close(); await worker.start(); await worker.send({ clientMessageId: randomUUID(), text: 'resumed worker' }); assert.equal(fake.calls.length, 2);
});
test('unknown reported cost preserves uncertainty and never refunds its reservation', t => {
  const usage = createUsage({ file: path.join(directory(t), 'usage.json') }), lease = usage.reserve(5);
  usage.record('s', { uuid: 'unknown', modelUsage: {} }, { reservationId: lease.id }); usage.release(lease.id);
  assert.equal(usage.summary().monthUsdMicros, null); assert.equal(usage.available(5), 0);
});
test('worker paths resolve junctions before checking the authorized root', t => {
  const root = directory(t), outside = directory(t), link = path.join(root, 'link');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const decision = createPolicy({ owner: 'dispatch', cwd: root, allow: ['**'] })('Write', { file_path: path.join(link, 'file') });
  assert.equal(decision.behavior, 'deny');
});
test('worker search patterns and home-relative file paths cannot escape the worktree', t => {
  const root = directory(t), policy = createPolicy({ owner: 'dispatch', cwd: root, allow: ['**'] });
  assert.equal(policy('Glob', { pattern: '../outside/**' }).behavior, 'deny');
  assert.equal(policy('Read', { file_path: '~/.claude/settings.json' }).behavior, 'deny');
  assert.equal(policy('Edit', { file_path: path.join(root, 'skill.md') }).reasonCode, 'skill_not_authorized');
});
test('SDK replay messages remain history without receipts or turn completion', async t => {
  const { session, fake, events } = setup(t, { auto: false }); await session.start();
  await session.send({ clientMessageId: randomUUID(), text: 'current' }); await until(() => fake.inputs.length === 1);
  fake.emit({ type: 'user', uuid: 'historical', isReplay: true, user_message_uuid: 'old-input', message: { content: 'old text' } });
  await until(() => events.some(event => event.itemId === 'historical'));
  const item = events.find(event => event.itemId === 'historical'); assert.equal(item.replay, true);
  assert.equal(events.filter(event => event.type === 'input.receipt' && event.payload.clientMessageId === 'old-input' || event.type === 'turn.completed').length, 0);
});
test('an accounting write failure cannot prevent stopping the SDK child', async t => {
  const { createClaudeSession } = require('../electron/features/claude-sdk/session.cjs'), fake = fakeSdk({ auto: false }), dir = directory(t);
  const session = createClaudeSession({ agent: 'claude', owner: 'gui', cwd: dir, projectId: 'p', terminalId: 't', runtimeSessionId: 'r' }, () => {}, {
    loadSdk: async () => fake.sdk, resolveExecutable: async () => process.execPath, credentials: { read: () => key },
    usage: { reserve: () => ({ id: 'reservation' }), unverified() { throw new Error('offline fake disk failure'); }, release() {} },
  });
  await session.start(); session.send({ clientMessageId: randomUUID(), text: 'pending' }); await until(() => fake.inputs.length === 1);
  await session.close(); assert.equal(fake.calls[0].options.abortController.signal.aborted, true); assert.equal(session.snapshot().state, 'stopped');
});
