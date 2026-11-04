const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createConnectionTest, listModels, probeBillingIdentity } = require('../electron/features/claude-sdk/connection.cjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const { fixtureProcesses } = require('./fixtures/claude-sdk-processes.cjs');
const key = 'sk-ant-api03-offline-connection-only';
function http(statusCode, body = { data: [{ id: 'claude-test-model' }] }) {
  const calls = [];
  return { calls, request(url, options, callback) {
    calls.push({ url, options });
    const request = new EventEmitter(); request.destroy = () => {}; request.end = () => queueMicrotask(() => {
      const response = new PassThrough(); response.statusCode = statusCode; callback(response); response.end(JSON.stringify(body));
    }); return request;
  } };
}
for (const [code, expected] of [[200, 'ok'], [401, 'invalid'], [403, 'forbidden'], [429, 'rate_limited'], [500, 'error']]) {
  test(`connection test maps HTTP ${code} to ${expected} without returning error content`, { timeout: 1000 }, async () => {
    const fake = http(code, code === 200 ? undefined : { error: { message: key, headers: { authorization: key } } });
    const check = createConnectionTest({ credentials: { read: () => key }, inspectCli: async () => ({ status: 'ok', version: '2.1.317', required: '2.1.317' }), request: fake.request });
    assert.equal(fake.calls.length, 0);
    const value = await check(); assert.equal(value.key.status, expected);
    assert.ok(value.key.latencyMs >= 0); assert.ok(!JSON.stringify(value).includes(key));
    assert.equal(fake.calls[0].url, 'https://api.anthropic.com/v1/models?limit=100');
    assert.equal(fake.calls[0].options.method, 'GET'); assert.equal(fake.calls[0].options.headers['x-api-key'], key);
    assert.deepEqual(value.models, code === 200 ? ['claude-test-model'] : null);
  });
}
test('missing keys never issue a request, and CLI status still gets checked', async () => {
  const check = createConnectionTest({ credentials: { read: () => null, status: () => ({ saved: false }) },
    request: () => assert.fail('unexpected HTTP'), inspectCli: async () => ({ status: 'too_old', version: '2.1.316', required: '2.1.317' }) });
  const value = await check(); assert.equal(value.key.status, 'missing'); assert.equal(value.key.latencyMs, null); assert.equal(value.cli.status, 'too_old');
});
test('network errors and a silent peer settle without exposing exception messages', { timeout: 1000 }, async () => {
  for (const fail of [true, false]) {
    let destroyed = false;
    const result = await listModels(key, { timeoutMs: 20, request() {
      const req = new EventEmitter(); req.destroy = () => { destroyed = true; };
      req.end = () => { if (fail) queueMicrotask(() => req.emit('error', new Error(key))); }; return req;
    } });
    assert.deepEqual(result, { status: 'unreachable', models: null }); assert.equal(destroyed, true);
  }
});
test('malformed and oversized model lists never return reflected credentials', { timeout: 1000 }, async () => {
  for (const body of [{ data: [{ id: key }] }, { data: [{ id: 'x'.repeat(300000) }] }, { arbitrary: key }]) {
    const value = await listModels(key, { request: http(200, body).request });
    assert.equal(value.status, 'error'); assert.ok(!JSON.stringify(value).includes(key));
  }
});
test('concurrent clicks coalesce and the reported latency excludes CLI inspection', async () => {
  let time = 10, inspections = 0;
  const fake = http(200), request = (...args) => { time = 25; return fake.request(...args); };
  const check = createConnectionTest({ credentials: { read: () => key }, request, now: () => time,
    inspectCli: async () => { inspections++; time = 100; return { status: 'ok', version: '2.1.317', required: '2.1.317' }; } });
  const [first, second] = await Promise.all([check(), check()]);
  assert.equal(fake.calls.length, 1); assert.equal(inspections, 1); assert.deepEqual(first, second);
  assert.equal(first.key.latencyMs, 15);
});

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-billing-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).reverse(), decryptString: value => Buffer.from(value).reverse().toString() };
const specOf = root => ({ agent: 'claude', owner: 'gui', cwd: root, effort: 'high', fast: true,
  env: { PATH: '', HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'owner-config') } });
const cli = async () => ({ status: 'ok', version: '2.1.318', required: '2.1.317' });

for (const [source, expected] of [['ANTHROPIC_API_KEY', 'ok'], ['apiKeyHelper', 'mismatch'], ['/login managed key', 'mismatch'], ['none', 'mismatch'], [null, 'mismatch'], [key, 'mismatch']]) {
  test(`billing probe classifies ${expected} without queuing input or retaining private account fields (${source === key ? 'unexpected source' : source})`, async t => {
    const root = directory(t), fake = fakeSdk({ preflightSource: source });
    const query = fake.sdk.query;
    fake.sdk.query = spec => ({ ...query(spec), initializationResult: async () => ({ account: { apiKeySource: source, email: key, organization: key, token: key } }) });
    const result = await probeBillingIdentity({ key, spec: specOf(root), loadSdk: async () => fake.sdk,
      resolveExecutable: async () => 'synthetic-only' });
    assert.equal(result.status, expected); assert.equal(result.source, source === key ? null : source);
    assert.equal(fake.inputs.length, 0); assert.equal(fake.closes.length, 1);
    assert.equal(fake.calls[0].options.abortController.signal.aborted, true);
    assert.equal(JSON.stringify(result).includes(key), false);
  });
}

test('a silent or failed SDK identity probe returns unknown and always closes its query', async t => {
  const root = directory(t);
  for (const silent of [true, false]) {
    let closed = 0;
    const result = await probeBillingIdentity({ key, spec: specOf(root), timeoutMs: 10,
      resolveExecutable: async () => 'synthetic-only', loadSdk: async () => ({ query: () => ({
        initializationResult: () => silent ? new Promise(() => {}) : Promise.reject(new Error(key)), close: () => { closed++; },
      }) }) });
    assert.equal(result.status, 'unknown'); assert.equal(result.source, null); assert.equal(closed, 1);
    assert.equal(result.reason.includes(key), false);
  }
});

test('connection tests use the saved key and new-session options without changing usage or active sessions', async t => {
  const root = directory(t), fake = fakeSdk(), httpFake = http(200), spec = { ...specOf(root), context: 'Synthetic context', model: 'fake-selected' };
  const factory = createClaudeRuntime({ directory: path.join(root, 'data'), safeStorage, loadSdk: async () => fake.sdk, inspectCli: cli,
    request: httpFake.request, resolveExecutable: async () => 'synthetic-only', connectionSpec: () => spec });
  t.after(() => factory.close()); factory.credentials.save(key);
  const before = factory.usage.summary();
  const [first, second] = await Promise.all([factory.testConnection({ monthlyBudgetUsd: 10 }), factory.testConnection({ monthlyBudgetUsd: 10 })]);
  assert.deepEqual(first.billing, { status: 'ok', source: 'ANTHROPIC_API_KEY' }); assert.deepEqual(first, second);
  assert.equal(fake.calls.length, 1); assert.equal(httpFake.calls.length, 1); assert.equal(fake.inputs.length, 0);
  assert.deepEqual(factory.usage.summary(), before); assert.equal(fs.existsSync(path.join(root, 'data/usage.json')), false);
  const events = [], session = factory.create({ ...spec, projectId: 'p', terminalId: 't', runtimeSessionId: 'r', monthlyBudgetUsd: 10 }, event => events.push(event));
  await session.start(); await session.send({ clientMessageId: 'm', text: 'synthetic work' });
  for (let n = 0; n < 100 && !events.some(event => event.type === 'turn.completed'); n++) await new Promise(resolve => setTimeout(resolve, 2));
  const probe = fake.calls[0].options, actual = fake.calls[1].options;
  for (const field of ['cwd', 'model', 'effort', 'pathToClaudeCodeExecutable', 'settings', 'env', 'permissionMode', 'includePartialMessages', 'settingSources', 'systemPrompt', 'maxBudgetUsd']) {
    assert.deepEqual(probe[field], actual[field], field);
  }
  assert.equal(probe.hooks.PreToolUse[0].onFailure, actual.hooks.PreToolUse[0].onFailure);
  assert.equal(probe.env.CLAUDE_CONFIG_DIR, spec.env.CLAUDE_CONFIG_DIR);
  assert.equal(spec.env.CLAUDE_CONFIG_DIR, path.join(root, 'owner-config'));
  await session.close();
});

test('a missing key or unavailable CLI skips SDK launch and billing stays unknown', async () => {
  for (const status of ['missing', 'too_old']) {
    const check = createConnectionTest({ credentials: { read: () => key }, request: http(200).request,
      inspectCli: async () => ({ status, version: null }), probeBilling: () => assert.fail('SDK must not launch') });
    assert.deepEqual((await check()).billing, { status: 'unknown', source: null });
  }
  const check = createConnectionTest({ credentials: { read: () => null, status: () => ({ saved: false }) }, inspectCli: cli,
    request: () => assert.fail('no HTTP without a key'), probeBilling: () => assert.fail('no SDK without a key') });
  assert.deepEqual((await check()).billing, { status: 'unknown', source: null });
});

for (const mode of ['api-only', 'api-then-terminal']) test(`the real connection facade and a real session agree on billing mismatch under ${mode}`, async t => {
  const root = directory(t), fake = fakeSdk({ preflightSource: 'apiKeyHelper' }), directoryPath = path.join(root, 'data');
  const factory = createClaudeRuntime({ directory: directoryPath, safeStorage, inspectCli: cli, request: http(200).request,
    loadSdk: async () => fake.sdk, resolveExecutable: async () => 'synthetic-only', connectionSpec: () => specOf(root) });
  t.after(() => factory.close()); factory.credentials.save(key);
  fs.writeFileSync(path.join(directoryPath, 'settings.json'), JSON.stringify({ claudePath: mode, codexView: 'native', monthlyBudgetUsd: 10 }));
  const native = createNativeSessions({ directory: directoryPath, claude: factory });
  const result = await native.testConnection();
  assert.equal(result.key.status, 'ok'); assert.equal(result.cli.status, 'ok');
  assert.deepEqual(result.billing, { status: 'mismatch', source: 'apiKeyHelper' });
  assert.equal(result.path, mode === 'api-only' ? null : 'terminal');
  factory.resetAvailability();
  const session = factory.create({ ...specOf(root), projectId: 'p', terminalId: 't', runtimeSessionId: 'r', monthlyBudgetUsd: 10 }, () => {});
  await session.start();
  await assert.rejects(session.send({ clientMessageId: 'm', text: 'must remain unsent' }), error => error.beforeInput === true && error.message === result.reason);
  assert.equal(fake.inputs.length, 0); assert.equal(fake.closes.length, 2); await session.close();
});

let sdkModule = process.env.AGENTRIX_TEST_SDK_MODULE;
try { sdkModule ||= require.resolve('@anthropic-ai/claude-agent-sdk'); } catch { }
for (const [source, status] of [['ANTHROPIC_API_KEY', 'ok'], ['apiKeyHelper', 'mismatch'], [null, 'mismatch']]) {
  test(`real SDK connection check uses only initialize control with an offline CLI (${status})`, { skip: !sdkModule && 'SDK dependency is not installed', timeout: 15000 }, async t => {
    const scope = fixtureProcesses(t, 'agx-connection-wire-'), root = scope.directory, children = [], calls = [];
    const spec = specOf(root);
    Object.assign(spec.env, { AGENTRIX_FAKE_OUTPUT: root, AGENTRIX_FAKE_API_SOURCE: source || '', AGENTRIX_FAKE_OMIT_BILLING: source ? '0' : '1',
      HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) });
    const factory = createClaudeRuntime({ directory: path.join(root, 'data'), safeStorage, inspectCli: cli, request: http(200).request,
      connectionSpec: () => spec, resolveExecutable: async () => process.execPath, loadSdk: async () => {
        const sdk = await import(pathToFileURL(sdkModule).href);
        return { query(input) {
          calls.push(input);
          return sdk.query({ ...input, options: { ...input.options, spawnClaudeCodeProcess: options => {
            const child = scope.spawn(process.execPath, [path.join(__dirname, 'fixtures/claude-sdk-cli.cjs'), 'claude', ...options.args],
              { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] });
            children.push(child); return child;
          } } });
        } };
      } });
    scope.defer(() => factory.close()); factory.credentials.save(key);
    const result = await factory.testConnection();
    assert.deepEqual(result.billing, { status, source });
    for (const child of children) await scope.wait(new Promise(resolve => {
      if (child.fixtureClosed) resolve(); else child.once('close', resolve);
    }), 'connection probe exit');
    const wire = fs.readFileSync(path.join(root, 'claude-wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(wire.filter(row => row.control).map(row => row.control), ['initialize']);
    assert.equal(wire.some(row => row.user || row.rpc), false);
    assert.equal(fs.existsSync(path.join(root, 'fake-costs.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'data/usage.json')), false);
    assert.equal(calls.length, 1); assert.equal(calls[0].options.abortController.signal.aborted, true);
    assert.equal(JSON.stringify(result).includes(key), false);
  });
}
