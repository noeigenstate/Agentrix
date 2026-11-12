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
const { en } = require('../electron/i18n.cjs');
const { startupFailure } = require('../electron/features/claude-sdk/identity.cjs');
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

// A check that skipped the billing probe says why on its line: a retry changes nothing there, so only a probe that went wrong says "请重试".
const skippedBilling = async (inspectCli, credentials = { read: () => key }) => (await createConnectionTest({ credentials, inspectCli,
  request: credentials.status ? () => assert.fail('no HTTP without a key') : http(200).request, probeBilling: () => assert.fail('SDK must not launch') })()).billing;
const unknownBecause = (text, values = {}) => ({ status: 'unknown', source: null, detail: { text, values } });
const noKey = { read: () => null, status: () => ({ saved: false }) };
test('no Claude Code: billing was not checked, and the line says so rather than asking for a retry', async () => {
  assert.deepEqual(await skippedBilling(async () => ({ status: 'missing', version: null })), unknownBecause('没有找到能用的 Claude Code，无法确认计费来源。'));
});
test('an npm install without its native program: billing says the install is incomplete', async () => {
  const incomplete = 'D:\\nodejs22\\node_modules\\@anthropic-ai\\claude-code';
  assert.deepEqual(await skippedBilling(async () => ({ status: 'missing', version: null, reason: 'not_found', incomplete })),
    unknownBecause('Claude Code 安装不完整：npm 装了，但里面没有原生程序，无法确认计费来源。'));
});
test('a Claude Code that is too old: billing names the version it needs', async () => {
  assert.deepEqual(await skippedBilling(async () => ({ status: 'too_old', version: '2.1.316' })),
    unknownBecause('Claude Code 版本过低（需要 ≥ {required}），无法确认计费来源。', { required: '2.1.317' }));
});
test('no saved key: billing says it was not checked for want of one; an unreadable saved key is not called missing', async () => {
  assert.deepEqual(await skippedBilling(cli, noKey), unknownBecause('没有保存 API 密钥，所以没有检查计费来源。'));
  assert.deepEqual(await skippedBilling(cli, { read: () => { throw new Error('locked'); }, status: () => ({ saved: true }) }),
    unknownBecause('读不到已保存的 API 密钥，所以没有检查计费来源。'));
});
test('with no key and no Claude Code both, billing names the Claude Code (the key row already asks for the key)', async () => {
  assert.deepEqual(await skippedBilling(async () => ({ status: 'missing', version: null }), noKey), unknownBecause('没有找到能用的 Claude Code，无法确认计费来源。'));
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
  assert.deepEqual({ status: result.billing.status, source: result.billing.source, reported: result.billing.reported },
    { status: 'mismatch', source: 'apiKeyHelper', reported: { apiKeySource: 'apiKeyHelper', tokenSource: 'none' } });
  // The billing line says why (a helper the native channel cannot clear comes from a managed policy); the path names the consequence.
  assert.match(result.billing.detail.text, /托管策略配置了 apiKeyHelper/); assert.equal(result.reason, 'billing_identity_mismatch');
  assert.equal(result.path, mode === 'api-only' ? null : 'terminal');
  factory.resetAvailability();
  const session = factory.create({ ...specOf(root), projectId: 'p', terminalId: 't', runtimeSessionId: 'r', monthlyBudgetUsd: 10 }, () => {});
  await session.start();
  await assert.rejects(session.send({ clientMessageId: 'm', text: 'must remain unsent' }), error => error.beforeInput === true && error.message === result.billing.detail.text.replace('{detail}', result.billing.detail.values.detail));
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
    assert.deepEqual({ status: result.billing.status, source: result.billing.source }, { status, source });
    // A mismatch names what the CLI reported; one that reported nothing says so instead of showing an unknown source.
    if (status === 'mismatch') assert.equal(result.billing.reported.apiKeySource, source);
    if (!source) assert.match(result.billing.detail.text, /没有报告计费来源/);
    if (status === 'mismatch') assert.equal(result.reason, 'billing_identity_mismatch');
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
  // None found says where it looked and which npm package lacks its native program; a field of another shape is dropped.
  const searched = ['~\\.local\\bin', '~\\.claude\\local'], incomplete = 'D:\\nodejs22\\node_modules\\@anthropic-ai\\claude-code';
  assert.deepEqual(await cliOf({ status: 'missing', reason: 'not_found', pathFolders: 12, searched, incomplete, found }), { ...missing, reason: 'not_found', pathFolders: 12, searched, incomplete });
  assert.deepEqual(await cliOf({ status: 'missing', reason: 'not_found', pathFolders: -1, searched: [1], incomplete: 'x'.repeat(1025) }), { ...missing, reason: 'not_found' });
  assert.deepEqual(await cliOf({ status: 'missing', reason: 'timeout', found, pathFolders: 3, searched, incomplete }), { ...missing, reason: 'timeout', found });
  assert.deepEqual(await cliOf({ status: 'ok', version: '2.1.320', reason: 'timeout', found }), { status: 'ok', version: '2.1.320', required: '2.1.317' });
  // One found says where; two different ones for the terminal and the native path say both, still ok.
  const npm = 'D:\\nodejs22\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', ok = { status: 'ok', version: '2.1.322', required: '2.1.317', via: 'npm', fileShown: npm };
  assert.deepEqual(await cliOf({ ...ok, file: npm }), ok);
  const split = { notice: 'cli_split_versions', split: { terminal: { version: '2.1.300', via: 'local-bin', fileShown: '~\\.local\\bin\\claude.exe' } } };
  assert.deepEqual(await cliOf({ ...ok, ...split }), { ...ok, ...split });
  assert.deepEqual(await cliOf({ ...ok, via: 'elsewhere', notice: 'cli_split_versions', split: { terminal: { version: 'x', via: 'npm', fileShown: npm } } }),
    { status: 'ok', version: '2.1.322', required: '2.1.317' }, 'an unknown via or version is dropped');
  assert.deepEqual(await cliOf({ status: 'too_old', version: '2.1.300', via: 'npm', fileShown: npm }), { status: 'too_old', version: '2.1.300', required: '2.1.317' });
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
// The billing probe against an injected SDK: what it answers the initialize with, or how it fails.
const probeWith = (root, initializationResult, options = {}) => probeBillingIdentity({ key, spec: specOf(root),
  resolveExecutable: async () => 'synthetic-only', loadSdk: async () => ({ query: () => ({ initializationResult, close() {} }) }), ...options });

test('a billing mismatch names what Claude Code reported and what to check, unknown names included', async t => {
  const root = directory(t);
  for (const [account, words, shown] of [
    [{ apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'apiKeyHelper' }, /^Claude Code 的托管策略配置了 apiKeyHelper[^]*（apiKeySource=ANTHROPIC_API_KEY; tokenSource=apiKeyHelper）$/, 'ANTHROPIC_API_KEY'],
    [{ apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'ANTHROPIC_AUTH_TOKEN' }, /^Claude Code 的托管策略设置了 ANTHROPIC_AUTH_TOKEN/, 'ANTHROPIC_API_KEY'],
    [{ apiKeySource: '/login managed key', tokenSource: 'none' }, /\/login 登录 Anthropic 控制台时保存的密钥/, '/login managed key'],
    [{ apiKeySource: 'none', tokenSource: 'claude.ai' }, /没有使用 API 密钥，可能在用 claude\.ai 登录/, 'none'],
    [{ tokenSource: 'none' }, /没有报告计费来源[^]*（apiKeySource=missing）$/, null],
    // A value Claude Code is not known to report is never echoed, a key-shaped one least of all.
    [{ apiKeySource: 'weird-source', tokenSource: 'none' }, /^Claude Code 报告的计费来源不是 ANTHROPIC_API_KEY[^]*（apiKeySource=unknown）$/, 'unknown'],
    [{ apiKeySource: key, tokenSource: 'odd-token' }, /^Claude Code 报告的计费来源不是 ANTHROPIC_API_KEY[^]*（apiKeySource=unknown）$/, 'unknown'],
  ]) {
    const result = await probeWith(root, async () => ({ account }));
    assert.equal(result.status, 'mismatch'); assert.match(result.reason, words); assert.equal(result.reported.apiKeySource, shown);
    assert.equal(result.reason, result.why.text.replace(/\{(\w+)\}/g, (_, name) => result.why.values[name]));
    assert.ok(Object.hasOwn(en, result.why.text), `an English entry for ${result.why.text}`);
    assert.ok(!JSON.stringify(result).includes(key)); assert.doesNotMatch(JSON.stringify(result), /weird-source|odd-token/);
  }
  assert.deepEqual(await probeWith(root, async () => ({ account: { apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'claude.ai' } })),
    { status: 'ok', source: 'ANTHROPIC_API_KEY' }, 'a claude.ai login beside the key still bills the key (real 2.1.322 sends only x-api-key)');
});

test('an unread billing source says why: a slow initialize with its wait, a failed start with its exit and redacted stderr, no CLI', async t => {
  const root = directory(t);
  const slow = await probeWith(root, () => new Promise(() => {}), { timeoutMs: 20 });
  assert.equal(slow.status, 'unknown'); assert.equal(slow.why.text, 'Claude Code 初始化 {seconds} 秒仍未完成，尚未发送消息。请稍后重试。');
  assert.equal(slow.reason, 'Claude Code 初始化 1 秒仍未完成，尚未发送消息。请稍后重试。');
  // The SDK's own error fields say how the process ended; the stderr is what the probe collected, redacted.
  const failing = (error, stderr = '') => probeWith(root, null, { loadSdk: async () => ({ query: ({ options }) => {
    if (stderr) options.stderr(stderr);
    return { initializationResult: async () => { throw error; }, close() {} };
  } }) });
  const exited = await failing(Object.assign(new Error('Claude Code process exited with code 2. stderr: hidden'), { errorClass: 'process_exited_nonzero', exitCode: 2 }),
    `settings broken\nAuthorization: Bearer abc123secretvalue ${key}`);
  assert.deepEqual(Object.keys(exited.why.values).sort(), ['code', 'stderr']); assert.equal(exited.why.values.code, 2);
  assert.match(exited.reason, /^Claude Code 启动后退出（退出码 2），尚未发送消息。错误输出：settings broken \/ Authorization: Bearer <secret>/);
  assert.doesNotMatch(exited.reason, /abc123secretvalue|exited with code|hidden/); assert.ok(!JSON.stringify(exited).includes(key));
  const quiet = await failing(Object.assign(new Error('x'), { errorClass: 'process_exited_nonzero', exitCode: 1 }));
  assert.equal(quiet.reason, 'Claude Code 启动后退出（退出码 1），尚未发送消息，也没有错误输出。');
  const killed = await failing(Object.assign(new Error('x'), { errorClass: 'process_killed_by_signal', signal: 'SIGKILL' }));
  assert.equal(killed.reason, 'Claude Code 启动后被终止（信号 SIGKILL），尚未发送消息，也没有错误输出。');
  const spawned = await failing(Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }));
  assert.equal(spawned.reason, 'Claude Code 没能启动（EPERM），尚未发送消息，也没有错误输出。');
  const unverified = await probeWith(root, null, { resolveExecutable: async () => { throw Object.assign(new Error('Claude Code 检查没有通过，无法通过 API 运行'), { code: 'native_cli_required', unverified: true }); } });
  assert.equal(unverified.reason, 'Claude Code 检查没有通过，无法通过 API 运行');
  const absent = await probeWith(root, null, { resolveExecutable: async () => null });
  assert.equal(absent.reason, '没有找到能用的 Claude Code，无法确认计费来源。');
  for (const { why } of [slow, exited, quiet, killed, spawned, unverified, absent]) assert.ok(Object.hasOwn(en, why.text), `an English entry for ${why.text}`);
});

test('the initialize deadline yields to an answer already waiting while main was busy', async t => {
  const root = directory(t);
  // Main is busy from the first turn until both the answer (due at 30 ms) and the 60 ms deadline are overdue; the
  // answer comes due first, as a CLI's reply read in the same turn would, and wins.
  const answer = () => new Promise(resolve => {
    setTimeout(() => setImmediate(() => resolve({ account: { apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'none' } })), 30);
    setImmediate(() => { const end = Date.now() + 120; while (Date.now() < end); });
  });
  assert.deepEqual(await probeWith(root, answer, { timeoutMs: 60 }), { status: 'ok', source: 'ANTHROPIC_API_KEY' });
});

test('the connection result carries the billing reason and what was reported; the path names only the consequence', async t => {
  const root = directory(t);
  const check = createConnectionTest({ credentials: { read: () => key }, inspectCli: cli, request: http(200).request,
    probeBilling: () => probeWith(root, async () => ({ account: { apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'apiKeyHelper' } })) });
  const value = await check();
  assert.deepEqual(value.billing.reported, { apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'apiKeyHelper' });
  assert.equal(value.billing.status, 'mismatch'); assert.match(value.billing.detail.text, /托管策略配置了 apiKeyHelper/);
  assert.equal(value.reason, 'billing_identity_mismatch');
  // A probe that throws gets a fixed sentence: nothing of its message reaches the owner.
  const broken = await createConnectionTest({ credentials: { read: () => key }, inspectCli: cli, request: http(200).request,
    probeBilling: async () => { throw new Error(`C:\\Users\\someone\\secret ${key}`); } })();
  assert.deepEqual(broken.billing.detail, { text: '检查 Claude Code 的计费来源时出错，请重试。', values: {} });
  assert.equal(broken.reason, 'billing_unconfirmed'); assert.ok(!JSON.stringify(broken).includes('someone'));
});
test('a stderr window cut mid-line drops that line, so no half of a key opens it', () => {
  const { stderrCollector } = require('../electron/features/agents/start-failure.cjs');
  const stderr = stderrCollector(40);
  stderr.push(`starting\n${key}\n`); stderr.push('settings.json is broken\n');
  assert.equal(stderr.text(), 'settings.json is broken\n', 'the window began inside the key line, which is dropped whole');
  const whole = stderrCollector(40); whole.push('first\nsecond\n'); assert.equal(whole.text(), 'first\nsecond\n', 'a window that fits keeps everything');
  const long = stderrCollector(10); long.push('x'.repeat(30)); assert.equal(long.text(), '', 'a window inside one long line keeps nothing of it');
});

test('terminal escapes are stripped before the key is masked, so an escape inside the key cannot hide it', () => {
  const split = `${key.slice(0, 12)}\x1b[31m${key.slice(12)}\x1b[0m`, other = 'sk-ant-api03-another-key-value';
  const failure = startupFailure(Object.assign(new Error('x'), { errorClass: 'process_exited_nonzero', exitCode: 1 }),
    { stderr: `bad key ${split}\nalso ${other.slice(0, 9)}\x1b]8;;https://example.invalid\x07${other.slice(9)}\n`, key });
  assert.equal(failure.message, 'Claude Code 启动后退出（退出码 1），尚未发送消息。错误输出：bad key <key> / also <key>');
  assert.ok(!failure.message.includes(key.slice(12))); assert.ok(!failure.message.includes('another-key'));
});

test('a session started with no saved key says so, before any input', async t => {
  const root = directory(t), events = [], fake = fakeSdk();
  const factory = createClaudeRuntime({ directory: path.join(root, 'data'), safeStorage, inspectCli: cli, loadSdk: async () => fake.sdk,
    resolveExecutable: async () => 'synthetic-only', connectionSpec: () => specOf(root) });
  t.after(() => factory.close());
  const session = factory.create({ ...specOf(root), projectId: 'p', terminalId: 't', runtimeSessionId: 'r' }, event => events.push(event));
  t.after(() => session.close());
  const expected = '还没有保存 API 密钥，尚未发送消息。请在设置里保存密钥后重试。';
  await assert.rejects(session.start(), error => error.beforeInput === true && error.code === 'sdk_startup_failed' && error.message === expected);
  assert.equal(events.find(event => event.type === 'error').payload.message, expected); assert.equal(fake.inputs.length, 0);
  assert.ok(Object.hasOwn(en, expected));
});
