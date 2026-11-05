require('./fixtures/team-isolation.cjs');
const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { registerClaudeWorker } = require('../electron/features/native-session/worker.cjs');
const { createDispatchControl } = require('../electron/features/agents/dispatch-control.cjs');
const { run } = require('../integration/dispatch.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const { terminalPreparation, completeSwitch } = require('./fixtures/native-switch.cjs');

const key = 'sk-ant-api03-offline-startup-never-real';
const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).reverse(), decryptString: value => Buffer.from(value).reverse().toString() };
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-sdk-startup-')), fake = fakeSdk(options);
  const env = { PATH: '', HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, 'owner-config'), CODEX_HOME: path.join(root, 'codex') };
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
  const ownerFile = path.join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  fs.writeFileSync(ownerFile, JSON.stringify({ primaryApiKey: 'synthetic-managed', customApiKeyResponses: { rejected: ['synthetic-rejected'] } }));
  const factory = createClaudeRuntime({ directory: path.join(root, 'data'), safeStorage, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'synthetic-only',
    inspectCli: async () => ({ status: 'ok', version: '2.1.318' }), initializationTimeoutMs: options.initializationTimeoutMs });
  factory.credentials.save(key);
  t.after(async () => { await factory.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const events = [], spec = { agent: 'claude', owner: 'gui', projectId: 'p', terminalId: 't', runtimeSessionId: 'r', cwd: root, env };
  const session = factory.create(spec, event => events.push(event));
  return { root, env, fake, factory, events, spec, session, ownerFile };
}
async function until(check) {
  for (let n = 0; n < 500; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('offline startup did not settle');
}

test('SDK checks account identity with no input, preserves inherited config and releases rejected reservations', async t => {
  const f = fixture(t, { preflightSource: '/login managed key' });
  const original = fs.readFileSync(f.ownerFile, 'utf8');
  await f.session.start();
  await assert.rejects(f.session.send({ clientMessageId: 'm', text: 'must remain unsent' }), error =>
    error.beforeInput === true && /apiKeySource=\/login managed key/.test(error.message));
  assert.equal(f.fake.inputs.length, 0); assert.equal(f.fake.closes.length, 1);
  assert.equal(f.factory.usage.available(10), 10000000);
  assert.equal(f.fake.calls[0].options.env.CLAUDE_CONFIG_DIR, f.env.CLAUDE_CONFIG_DIR);
  assert.equal('configDirectory' in f.fake.calls[0].options, false);
  assert.equal(fs.existsSync(path.join(f.root, 'data/sdk-config')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'data/sdk-session-configs.json')), false);
  assert.equal(f.env.CLAUDE_CONFIG_DIR, path.join(f.root, 'owner-config'));
  assert.equal(fs.readFileSync(f.ownerFile, 'utf8'), original);
  assert.equal(f.events.some(event => event.type === 'turn.started'), false);
  assert.match(f.events.find(event => event.type === 'error').payload.message, /apiKeySource=\/login managed key/);
});

test('stop cancels a silent identity preflight before input without waiting for its startup timeout', async t => {
  const f = fixture(t);
  const query = f.fake.sdk.query;
  f.fake.sdk.query = spec => ({ ...query(spec), initializationResult: () => new Promise(() => {}) });
  await f.session.start();
  const sending = f.session.send({ clientMessageId: 'm', text: 'never sent' });
  const rejection = assert.rejects(sending, /会话已停止/);
  await until(() => f.fake.calls.length === 1);
  await f.session.close(); await rejection;
  assert.equal(f.fake.inputs.length, 0); assert.equal(f.fake.closes.length, 1);
  assert.equal(f.factory.usage.available(10), 10000000);
});

test('identity diagnostics do not reflect unexpected source strings', async t => {
  const f = fixture(t, { preflightSource: key }); await f.session.start();
  await assert.rejects(f.session.send({ clientMessageId: 'm', text: 'never sent' }), /apiKeySource=unknown/);
  assert.equal(JSON.stringify(f.events).includes(key), false);
});

test('resumed sessions retain their original config and still reject a different billing identity before input', async t => {
  const f = fixture(t, { preflightSource: 'apiKeyHelper' });
  const legacy = f.factory.create({ ...f.spec, providerSessionId: 'legacy-beta-session' }, () => {});
  await legacy.resume();
  await assert.rejects(legacy.send({ clientMessageId: 'm', text: 'legacy work' }), /apiKeySource=apiKeyHelper/);
  assert.equal(f.fake.calls[0].options.env.CLAUDE_CONFIG_DIR, f.env.CLAUDE_CONFIG_DIR);
  assert.equal(f.fake.inputs.length, 0);
});

test('new sessions with no config override keep default configuration on resume after a host restart', async t => {
  const f = fixture(t); delete f.env.CLAUDE_CONFIG_DIR;
  await f.session.start(); await f.session.send({ clientMessageId: 'm', text: 'work' });
  await until(() => f.events.some(event => event.type === 'turn.completed')); await f.factory.close();
  const next = createClaudeRuntime({ directory: path.join(f.root, 'data'), safeStorage, loadSdk: async () => f.fake.sdk, resolveExecutable: async () => 'synthetic-only' });
  t.after(() => next.close());
  const resumed = next.create({ ...f.spec, providerSessionId: f.fake.sessionId }, () => {});
  await resumed.resume(); await resumed.send({ clientMessageId: 'm2', text: 'continue' });
  assert.equal(f.fake.calls[1].options.env.CLAUDE_CONFIG_DIR, f.fake.calls[0].options.env.CLAUDE_CONFIG_DIR);
  for (const call of f.fake.calls) {
    assert.equal(Object.hasOwn(call.options, 'CLAUDE_CONFIG_DIR'), false);
    assert.equal(Object.hasOwn(call.options.env, 'CLAUDE_CONFIG_DIR'), false);
    assert.deepEqual(call.options.settingSources, ['user', 'project', 'local']);
  }
  assert.equal(f.fake.calls[1].options.resume, f.fake.sessionId);
  await until(() => next.usage.summary().monthUsdMicros === 200000); await next.close();
});

test('real command_lifecycle queued and started precede init without failing billing identity', async t => {
  const f = fixture(t, { auto: false, init: false }); await f.session.start();
  await f.session.send({ clientMessageId: 'm', text: 'work' });
  // Claude Code 2.1.318 streaming frames, recorded by the offline Opus probe.
  for (const state of ['queued', 'started']) f.fake.emit({ type: 'command_lifecycle', command_uuid: 'm', state, uuid: randomUUID(), session_id: 's' });
  for (const type of ['rate_limit_event', 'auth_status', 'tool_progress', 'stream_event']) f.fake.emit({ type, error: 'rate_limit' });
  f.fake.emit({ type: 'system', subtype: 'status', status: 'starting' });
  f.fake.emit({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', session_id: 's' });
  f.fake.emit({ type: 'result', uuid: 'r', total_cost_usd: 0, modelUsage: {}, queued_turn_count: 0 });
  await until(() => f.events.some(event => event.type === 'turn.completed'));
  assert.equal(f.events.some(event => event.type === 'error' || event.type === 'limits.updated'), false);
});

for (const type of ['assistant', 'result']) test(`${type} before stream init fails with its type and cannot replay`, async t => {
  const f = fixture(t, { auto: false, init: false }); await f.session.start();
  await f.session.send({ clientMessageId: 'm', text: 'work' }); f.fake.emit({ type });
  await until(() => f.events.some(event => event.type === 'error'));
  assert.match(f.events.find(event => event.type === 'error').payload.message, new RegExp(`message before init=${type}`));
  assert.equal(f.events.some(event => event.type === 'usage.updated'), false);
});

for (const claudePath of ['api-only', 'api-then-terminal']) test(`GUI identity mismatch obeys ${claudePath} before input`, async t => {
  const f = fixture(t, { preflightSource: 'apiKeyHelper' }), terminals = [], events = [];
  const router = createRouter({ claude: f.factory, settings: { get: () => ({ claudePath, monthlyBudgetUsd: null }) },
    prepareTerminal: terminalPreparation(spec => terminals.push({ spec })),
    resolveSpec: () => f.spec, terminal: async (spec, reason) => terminals.push({ spec, reason }), emit: event => events.push(event) });
  t.after(() => router.close());
  const { runtimeSessionId } = await router.start('t', { agent: 'claude' });
  const send = router.send('t', runtimeSessionId, { clientMessageId: 'm', text: 'unsent work' });
  if (claudePath === 'api-only') { await assert.rejects(send, /apiKeySource=apiKeyHelper/); assert.equal(terminals.length, 0); }
  else {
    assert.deepEqual(await send, { status: 'rejected', reason: 'path_changed' });
    assert.equal(terminals.length, 0, 'fallback still waits for draft handoff'); await completeSwitch(router, 't');
    assert.equal(terminals.length, 1); assert.equal(JSON.stringify(terminals).includes('unsent work'), false);
    assert.match(events.findLast(event => event.type === 'path.changed').payload.reason, /apiKeySource=apiKeyHelper/);
    assert.equal(router.snapshot('t').events.findLast(event => event.type === 'path.changed').payload.selected, 'terminal');
  }
  assert.equal(f.fake.inputs.length, 0);
});

for (const failure of ['identity', 'timeout', 'query_refused']) for (const claudePath of ['api-only', 'api-then-terminal']) test(`real helper ${failure} obeys ${claudePath} with a fake SDK and CLI`, async t => {
  const f = fixture(t, { preflightSource: failure === 'identity' ? '/login managed key' : 'ANTHROPIC_API_KEY', initializationTimeoutMs: 20 }), lifetime = resources(t);
  if (failure !== 'identity') {
    const query = f.fake.sdk.query;
    f.fake.sdk.query = input => {
      if (failure === 'query_refused') throw new Error(key);
      return { ...query(input), initializationResult: () => new Promise(() => {}) };
    };
  }
  const control = createDispatchControl({ resolveRun: auth => auth.sessionKey === 'synthetic-session' && auth.capability === 'synthetic-capability'
    ? { runId: auth.runId, agent: 'claude', projectId: 'p', cwd: f.root, allow: [], readOnly: true } : null });
  const { address } = await control.listen(); lifetime.defer('close control', () => control.close());
  registerClaudeWorker({ control, claude: f.factory, settings: () => ({ claudePath, monthlyBudgetUsd: null }), env: () => f.env });
  const bootstrap = path.join(f.root, 'bootstrap.json'), brief = path.join(f.root, 'brief.md'), out = path.join(f.root, 'out.md');
  fs.writeFileSync(bootstrap, JSON.stringify({ controlAddress: address, controlCapability: 'synthetic-capability', sessionKey: 'synthetic-session', projectId: 'p' }));
  fs.writeFileSync(brief, 'Synthetic unsent task');
  let stdout = '', launches = 0;
  const code = await run(['claude', '--role', 'review', '--title', 'Synthetic identity', '--model', 'synthetic-model', '--effort', 'high',
    '--permission', 'plan', '--cwd', f.root, '--brief', brief, '--out', out], {
    env: { ...f.env, AGENTRIX_BOOTSTRAP: bootstrap }, stdout: { write: value => { stdout += value; } },
    resolveExecutable: (_agent, args) => ({ file: process.execPath, args: [path.join(__dirname, 'fixtures/codex-app-server-env.cjs'), ...args] }),
    launch: (file, args, options) => {
      launches++; assert.equal(options.env.CLAUDE_CONFIG_DIR, f.env.CLAUDE_CONFIG_DIR);
      return lifetime.child(spawn(file, args, options));
    },
  });
  assert.equal(f.fake.inputs.length, 0);
  assert.match(stdout, failure === 'identity' ? /apiKeySource=\/login managed key/ : failure === 'timeout' ? /初始化超时，尚未发送消息/ : /启动失败，尚未发送消息/);
  assert.equal(stdout.includes(key), false);
  assert.equal(launches, claudePath === 'api-only' ? 0 : 1);
  assert.equal(code, claudePath === 'api-only' ? 1 : 0);
  if (claudePath === 'api-only') assert.doesNotMatch(stdout, /claude-cli fallback/);
  else { assert.match(stdout, /claude-cli fallback/); assert.doesNotMatch(stdout, /control unavailable|failed to start/); }
});
