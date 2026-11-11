const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createConnectionTest, listModels, netRequest, probeBillingIdentity } = require('../electron/features/claude-sdk/connection.cjs');
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
  t.after(async () => { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }); return root;
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
  const settings = [], query = fake.sdk.query;
  fake.sdk.query = value => { settings.push(JSON.parse(fs.readFileSync(value.options.settings, 'utf8'))); return query(value); };
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
  assert.equal(probe.maxBudgetUsd, 10, 'billing preflight uses the monthly allowance without a five-dollar ceiling');
  for (const field of ['cwd', 'model', 'effort', 'pathToClaudeCodeExecutable', 'env', 'permissionMode', 'includePartialMessages', 'settingSources', 'systemPrompt', 'maxBudgetUsd']) {
    assert.deepEqual(probe[field], actual[field], field);
  }
  assert.deepEqual(settings[0], settings[1]); assert.equal(fs.existsSync(probe.settings), false, 'preflight settings are removed on close');
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
// A fake API that answers each route with its own status and body, and records what was sent.
function api(routes) {
  const calls = [];
  return { calls, request(url, options, callback) {
    const call = { url, options, body: null }; calls.push(call);
    const [statusCode, body] = routes[new URL(url).pathname] || [500, {}];
    const request = new EventEmitter(); request.destroy = () => {}; request.end = payload => queueMicrotask(() => {
      call.body = payload === undefined ? null : JSON.parse(payload);
      const response = new PassThrough(); response.statusCode = statusCode; callback(response); response.end(typeof body === 'string' ? body : JSON.stringify(body));
    }); return request;
  } };
}
const refusal = message => ({ type: 'error', error: { type: 'permission_error', message } });
const keyCheck = (routes, inspectCli = cli, options = {}) => {
  const fake = api(routes);
  return { fake, check: createConnectionTest({ credentials: { read: () => key }, inspectCli, request: fake.request, ...options }) };
};

test('a key refused the model list is checked with a free token count, and its answer makes the key usable', async () => {
  const { fake, check } = keyCheck({ '/v1/models': [403, refusal('Your API key does not have permission to list models.')], '/v1/messages/count_tokens': [200, { input_tokens: 8 }] });
  const value = await check();
  assert.equal(value.key.status, 'ok'); assert.equal(value.key.error, null); assert.equal(value.models, null);
  assert.equal(value.modelsForbidden, true); assert.equal(value.modelsError, 'permission_error: Your API key does not have permission to list models.');
  assert.equal(fake.calls.length, 2); assert.equal(fake.calls[1].url, 'https://api.anthropic.com/v1/messages/count_tokens');
  assert.equal(fake.calls[1].options.method, 'POST'); assert.equal(fake.calls[1].options.headers['x-api-key'], key);
  assert.equal(fake.calls[1].options.headers['content-type'], 'application/json');
  assert.deepEqual(fake.calls[1].body, { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'ping' }] }, 'no model set: the stand-in default');
  assert.equal(value.cli.status, 'ok');
});

test('the token count asks about the model a new session sets, and a model the key may not use still leaves the key working', async () => {
  const routes = { '/v1/models': [403, refusal('list refused')], '/v1/messages/count_tokens': [404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-x-1' } }] };
  const configs = [];
  const { fake, check } = keyCheck(routes, cli, { sessionModel: config => { configs.push(config); return 'claude-x-1'; } });
  const value = await check({ projectId: 'p' });
  assert.deepEqual(configs, [{ projectId: 'p' }]); assert.equal(fake.calls[1].body.model, 'claude-x-1');
  assert.equal(value.key.status, 'ok'); assert.equal(value.modelsForbidden, true); assert.equal(value.unavailableModel, 'claude-x-1');
  for (const sessionModel of [() => 'opus', () => null, () => { throw new Error('ssh project'); }]) {
    const other = keyCheck(routes, cli, { sessionModel });
    await other.check(); assert.equal(other.fake.calls[1].body.model, 'claude-opus-5-5');
  }
  const unknown = await keyCheck({ ...routes, '/v1/messages/count_tokens': [404, { type: 'error', error: { type: 'other_error', message: 'gone' } }] }).check();
  assert.equal(unknown.key.status, 'error', 'only a model the API could not find means the key was accepted');
});

test('a model list that answers (ok, invalid or rate limited) is the verdict, with no token count', async () => {
  for (const [code, status] of [[200, 'ok'], [401, 'invalid'], [429, 'rate_limited']]) {
    const { fake, check } = keyCheck({ '/v1/models': [code, code === 200 ? { data: [{ id: 'claude-x' }] } : refusal('no')], '/v1/messages/count_tokens': [200, {}] });
    assert.equal((await check()).key.status, status); assert.equal(fake.calls.length, 1);
  }
});

test('the latency of a key checked twice is that of the request that decided', async () => {
  let time = 0;
  const fake = api({ '/v1/models': [403, refusal('list refused')], '/v1/messages/count_tokens': [200, {}] });
  const check = createConnectionTest({ credentials: { read: () => key }, inspectCli: cli, now: () => time,
    request: (url, ...rest) => { time += url.includes('count_tokens') ? 30 : 400; return fake.request(url, ...rest); } });
  assert.equal((await check()).key.latencyMs, 30);
});

test('requests through Electron net keep the https.request shape and let net set the body length', async () => {
  const made = [];
  const net = { request(options) {
    const request = new EventEmitter(); made.push({ options, request, aborted: 0, ended: [] });
    request.end = (...args) => { made.at(-1).ended.push(args); queueMicrotask(() => {
      const response = new PassThrough(); response.statusCode = 200; request.emit('response', response); response.end(JSON.stringify({ input_tokens: 1 }));
    }); };
    request.abort = () => { made.at(-1).aborted++; }; return request;
  } };
  const value = await keyCheck({}, cli, { request: netRequest(net) }).check();
  assert.equal(value.key.status, 'error', 'a token count body is not a model list');
  assert.equal(made[0].options.url, 'https://api.anthropic.com/v1/models?limit=100'); assert.equal(made[0].options.method, 'GET');
  assert.equal(made[0].options.headers['x-api-key'], key); assert.deepEqual(made[0].ended, [[]]); assert.equal(made[0].aborted, 1);
  const post = netRequest(net)('https://api.anthropic.com/v1/messages/count_tokens', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 2 } }, () => {});
  assert.equal(post.on('error', () => {}), post); post.end('{}');
  assert.deepEqual(made[1].options.headers, { 'content-type': 'application/json' }); assert.deepEqual(made[1].ended, [['{}']]);
});

test('a key refused both the list and the token count is not usable, with Anthropic\'s reason and never the key', async () => {
  for (const [code, status] of [[403, 'forbidden'], [401, 'invalid']]) {
    const { check } = keyCheck({ '/v1/models': [403, refusal('list refused')],
      '/v1/messages/count_tokens': [code, refusal(`Key ${key} cannot use this organization.`)] });
    const value = await check();
    assert.equal(value.key.status, status); assert.equal(value.models, null); assert.equal(value.modelsForbidden, undefined);
    assert.equal(value.key.error, 'permission_error: Key … cannot use this organization.');
    assert.ok(!JSON.stringify(value).includes(key));
  }
  const { fake, check } = keyCheck({ '/v1/models': [403, refusal('list refused')] });
  const unanswered = await check();
  assert.equal(fake.calls.length, 2); assert.equal(unanswered.key.status, 'error'); assert.equal(unanswered.key.error, 'permission_error: list refused');
});

test('the reason in a refusal is kept short, without control characters or anything shaped like a key', async () => {
  const { check } = keyCheck({ '/v1/models': [401, refusal(`bad\u0000 sk-ant-api03-other-key\n${'x'.repeat(500)}`)] });
  const value = await check();
  assert.equal(value.key.status, 'invalid'); assert.equal(value.key.error.length, 300);
  assert.match(value.key.error, /^permission_error: bad … x+$/); assert.doesNotMatch(value.key.error, /sk-ant/);
  for (const body of [{}, 'not json', { error: { message: key } }]) {
    const { check: other } = keyCheck({ '/v1/models': [401, body] });
    assert.equal((await other()).key.error, null);
  }
});

test('the new-session path follows the token count: a refused list alone keeps the API, a refused key moves to the terminal', async t => {
  for (const [count, route, reason] of [[200, 'api', null], [403, 'terminal', 'API 密钥没有调用权限。']]) {
    const root = directory(t), fake = fakeSdk(), directoryPath = path.join(root, 'data');
    const factory = createClaudeRuntime({ directory: directoryPath, safeStorage, inspectCli: cli, loadSdk: async () => fake.sdk,
      request: api({ '/v1/models': [403, refusal('list refused')], '/v1/messages/count_tokens': [count, refusal('use refused')] }).request,
      resolveExecutable: async () => 'synthetic-only', connectionSpec: () => specOf(root) });
    t.after(() => factory.close()); factory.credentials.save(key);
    fs.writeFileSync(path.join(directoryPath, 'settings.json'), JSON.stringify({ claudePath: 'api-then-terminal', codexView: 'native', monthlyBudgetUsd: 10 }));
    const result = await createNativeSessions({ directory: directoryPath, claude: factory }).testConnection();
    assert.equal(result.path, route); assert.equal(result.reason, reason);
    assert.equal(result.key.status, count === 200 ? 'ok' : 'forbidden'); assert.equal(result.models, null);
    assert.deepEqual(result.billing, { status: 'ok', source: 'ANTHROPIC_API_KEY' }, 'the CLI still reports its billing source');
  }
});

test('a CLI check that failed says how, and only in fields of a known shape', async () => {
  const found = 'C:\\Users\\someone\\.local\\bin\\claude.exe', missing = { status: 'missing', version: null, required: '2.1.317' };
  const cliOf = async value => (await keyCheck({ '/v1/models': [200, { data: [] }] }, async () => value).check()).cli;
  assert.deepEqual(await cliOf({ status: 'missing', reason: 'timeout', found }), { ...missing, reason: 'timeout', found });
  assert.deepEqual(await cliOf({ status: 'missing', reason: 'timeout', found, elapsedMs: 11500 }), { ...missing, reason: 'timeout', found, elapsedMs: 11500 });
  assert.deepEqual(await cliOf({ status: 'missing', reason: 'timeout', found, elapsedMs: -1 }), { ...missing, reason: 'timeout', found });
  assert.deepEqual(await cliOf({ status: 'missing', reason: 'failed', found, error: 'EPERM' }), { ...missing, reason: 'failed', found, error: 'EPERM' });
  assert.deepEqual(await cliOf({ status: 'missing', reason: 'unreadable', found, error: '<script>' }), { ...missing, reason: 'unreadable', found });
  assert.deepEqual(await cliOf({ status: 'missing', reason: 'odd', found }), { ...missing, reason: 'not_found' });
  assert.deepEqual(await cliOf({ status: 'missing', version: null }), { ...missing, reason: 'not_found' });
  assert.deepEqual(await cliOf({ status: 'ok', version: '2.1.320', reason: 'timeout', found }), { status: 'ok', version: '2.1.320', required: '2.1.317' });
});

test('an inspection that throws, also inside the runtime\'s CLI observer, is a failed check that routes as unverified, not a missing CLI', async t => {
  const failed = { status: 'missing', version: null, required: '2.1.317', reason: 'failed' };
  const check = createConnectionTest({ credentials: { read: () => null, status: () => ({ saved: false }) },
    request: () => assert.fail('no HTTP without a key'), inspectCli: async () => { throw new Error('inspection broke'); } });
  assert.deepEqual((await check()).cli, failed);
  // The runtime observes every inspection before the test reads it; an inspection without a result makes the observer throw.
  const root = directory(t), directoryPath = path.join(root, 'data');
  const factory = createClaudeRuntime({ directory: directoryPath, safeStorage, inspectCli: async () => undefined,
    request: api({ '/v1/models': [200, { data: [] }] }).request, loadSdk: async () => assert.fail('no SDK without a CLI'), connectionSpec: () => specOf(root) });
  t.after(() => factory.close()); factory.credentials.save(key);
  const result = await createNativeSessions({ directory: directoryPath, claude: factory }).testConnection();
  assert.equal(result.key.status, 'ok'); assert.deepEqual(result.cli, failed);
  assert.equal(result.reason, 'native_cli_unverified'); assert.equal(result.path, 'terminal');
});
test('a CLI check that comes back after a later one was seen is stale: the later result stands and availability is not reset', async t => {
  const root = directory(t);
  const factory = createClaudeRuntime({ directory: path.join(root, 'data'), safeStorage, inspectCli: cli,
    request: () => assert.fail('no HTTP'), loadSdk: async () => assert.fail('no SDK'), connectionSpec: () => specOf(root) });
  t.after(() => factory.close());
  let resets = 0; factory.onAvailabilityChange(() => { resets++; });
  let finishOld; const first = factory.trackCli(new Promise(resolve => { finishOld = resolve; }));
  const newer = { status: 'ok', version: '2.1.322', required: '2.1.317', file: 'C:\\new\\claude.exe' };
  assert.deepEqual(await factory.trackCli(Promise.resolve(newer)), newer);
  finishOld({ status: 'missing', version: null, required: '2.1.317', file: null, reason: 'timeout', found: 'C:\\old\\claude.exe' });
  assert.deepEqual(await first, newer, 'the stale check answers with the newer result'); assert.equal(resets, 0);
  await factory.trackCli(Promise.resolve({ ...newer, version: '2.1.323' }));
  assert.equal(resets, 1, 'a newer check that differs still resets availability');
});

test('in the app the token count asks about the stand-in model: main\'s connection spec names none', async t => {
  const models = [];
  for (const spec of [{ agent: 'claude', owner: 'gui', cwd: '.', effort: 'high', fast: true }, { agent: 'claude', model: 'claude-sonnet-5-5' }]) {
    const root = directory(t), fake = api({ '/v1/models': [403, refusal('list refused')], '/v1/messages/count_tokens': [200, {}] });
    const factory = createClaudeRuntime({ directory: path.join(root, 'data'), safeStorage, inspectCli: async () => ({ status: 'missing', version: null }),
      request: fake.request, loadSdk: async () => assert.fail('no SDK without a CLI'), connectionSpec: () => spec });
    t.after(() => factory.close()); factory.credentials.save(key);
    assert.equal((await factory.testConnection()).key.status, 'ok'); models.push(fake.calls[1].body.model);
  }
  assert.deepEqual(models, ['claude-opus-5-5', 'claude-sonnet-5-5']);
});
