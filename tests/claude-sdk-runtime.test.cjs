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
test('a worker explicitly disables disk setting sources and blocks failed hooks', async t => {
  const { runtime, spec, fake } = setup(t, { auto: false });
  const session = runtime.create({ ...spec, owner: 'dispatch', readOnly: false, allow: ['**'] }, () => {}); t.after(() => session.close());
  await session.start();
  await session.send({ clientMessageId: randomUUID(), text: 'worker' });
  assert.deepEqual(fake.calls[0].options.settingSources, []);
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
  const one = usage.reserve(6), two = usage.reserve(6);
  assert.equal(one.maxBudgetUsd, 5); assert.equal(two.maxBudgetUsd, 1); assert.throws(() => usage.reserve(6));
  assert.equal(createUsage({ file }).available(6), 0);
  usage.release(one.id); assert.equal(usage.available(6), 5000000);
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
test('native executable discovery never searches relative directories or accepts wrappers', async t => {
  const { resolveClaudeExecutable } = require('../electron/features/claude-sdk/executable.cjs');
  const dir = directory(t); fs.writeFileSync(path.join(dir, 'claude.cmd'), 'not executable');
  let probes = 0;
  const probe = (_file, _args, options, callback) => { probes++; assert.equal(options.shell, false); assert.equal(options.killSignal, 'SIGKILL'); callback(null, '2.1.317 (Claude Code)'); };
  assert.equal(await resolveClaudeExecutable({ env: { PATH: dir }, platform: 'win32', home: dir, probe }), null);
  fs.writeFileSync(path.join(dir, 'claude.exe'), 'fake');
  for (const version of ['2.1.316', '2.0.999']) {
    await assert.rejects(resolveClaudeExecutable({ env: { PATH: dir }, platform: 'win32', home: dir,
      probe: (_file, _args, _options, callback) => callback(null, version) }), /2\.1\.317/);
  }
  const resolved = await resolveClaudeExecutable({ env: { PATH: dir }, platform: 'win32', home: dir, probe });
  assert.equal(resolved, await fs.promises.realpath(resolved));
  assert.equal(await fs.promises.realpath(resolved), await fs.promises.realpath(path.join(dir, 'claude.exe')));
  assert.equal(probes, 1);
  for (const version of ['2.2.0', '3.0.0']) assert.equal(await resolveClaudeExecutable({ env: { PATH: dir }, platform: 'win32', home: dir,
    probe: (_file, _args, _options, callback) => callback(null, version) }), resolved);
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
