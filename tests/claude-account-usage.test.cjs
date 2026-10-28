const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { ClaudeAccountUsage, readClaudeAccount, claudeUsageResult, POLL_INTERVAL } = require('../electron/features/agents/claude-account-usage.cjs');
const { UsageMeter, selectClaudeAccount, claudeAccountFrom, codePulseLimits } = require('../electron/features/agents/agent-usage.cjs');

const home = path.join(__dirname, '../.test-output/claude-account-usage-20261028/fake-home');
const token = 'fake-oauth-must-never-escape';
const flush = () => new Promise(resolve => setImmediate(resolve));
const usage = (percent = 12) => ({ five_hour: { utilization: percent, resets_at: '2026-10-28T12:00:00Z' },
  seven_day: { utilization: 45, resets_at: '2026-11-02T12:00:00Z' } });
const credentials = (overrides = {}) => ({ claudeAiOauth: { accessToken: token, expiresAt: 9999999999999,
  scopes: ['user:inference', 'user:profile'], refreshToken: 'fake-refresh-never-used', ...overrides } });
const response = (body = usage(), status = 200, retryAfter = null) => ({ status,
  headers: { get: key => key === 'retry-after' ? retryAfter : null }, json: async () => body });

function clock(start = 100000) {
  let at = start, sequence = 0;
  const timers = new Map();
  return { now: () => at, timers, setTimeout(fn, delay) {
    const id = { n: ++sequence, unref() {} }; timers.set(id, { at: at + delay, fn }); return id;
  }, clearTimeout: id => timers.delete(id), async tick(ms) {
    const until = at + ms;
    for (;;) {
      const next = [...timers].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      at = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    at = until; await flush();
  } };
}

function fake(overrides = {}) {
  const time = clock(), reads = [], requests = [];
  const file = path.join(home, '.claude', '.credentials.json');
  const files = new Map([[file, JSON.stringify(credentials())]]);
  const options = { ...time, env: {}, home, platform: 'linux', async readFile(name) {
    reads.push(name);
    if (!files.has(name)) throw Object.assign(new Error(token), { code: 'ENOENT' });
    const value = files.get(name);
    if (value instanceof Error) throw value;
    return value;
  }, async execute() { assert.fail('unexpected credential-store process'); }, async fetch(url, init) {
    requests.push({ url, init, at: time.now() }); return response();
  }, ...overrides };
  return { time, reads, requests, file, files, options, read: extra => readClaudeAccount({ ...options, ...extra }) };
}

function vault(h, entries = new Map()) {
  const reads = [];
  h.options.nativeRead = async (targets, { signal }) => {
    assert.equal(signal.aborted, false); reads.push(targets);
    return targets.map(target => entries.get(target) ?? { state: 'missing' });
  };
  return { entries, reads, put(target, value) { entries.set(target, { state: 'present', value: typeof value === 'string' ? value : JSON.stringify(value) }); } };
}

test('GET mirrors the bundle contract, publishes only validated limits and timestamps body receipt', async () => {
  const h = fake(); let body;
  h.options.fetch = async (url, init) => {
    h.requests.push({ url, init });
    return { ...response(), json: () => new Promise(resolve => { body = resolve; }) };
  };
  const pending = h.read(); await flush();
  await h.time.tick(500);
  body({ ...usage(0), account: token, headers: { Authorization: token } });
  const result = await pending;
  assert.deepEqual(result, { state: 'ready', status: 200, account: {
    limits: [{ minutes: 300, percent: 0, resetsAt: Date.parse('2026-10-28T12:00:00Z') },
      { minutes: 10080, percent: 45, resetsAt: Date.parse('2026-11-02T12:00:00Z') }], at: 100500, source: 'Claude',
  } });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, 'https://api.anthropic.com/api/oauth/usage');
  const { init } = h.requests[0];
  assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
  assert.deepEqual(init.headers, { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': 'claude-cli/2.1.312 (external, cli)', 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*' });
  assert.equal(init.body, undefined);
  assert.equal(h.time.timers.size, 0);
  assert.doesNotMatch(JSON.stringify(result), /fake-oauth|fake-refresh|Authorization|headers|accountUuid/);
});

test('null, missing and invalid fields stay unknown; valid zero and reset dates survive', () => {
  for (const body of [undefined, null, {}, [], { error: token }, { five_hour: { utilization: '12' } },
    { five_hour: { utilization: Infinity } }, { seven_day: { utilization: -1 } }]) assert.equal(claudeUsageResult(body, 100), null);
  assert.deepEqual(claudeUsageResult({ five_hour: { utilization: 0, resets_at: token } }, 100), {
    limits: [{ minutes: 300, percent: 0, resetsAt: null }], at: 100, source: 'Claude',
  });
  assert.equal(claudeUsageResult(usage(), NaN), null);
  assert.equal(claudeUsageResult({ seven_day: { utilization: 100, resets_at: 1234 } }, 100).limits[0].resetsAt, null);
});

test('missing/expired tokens, malformed credentials and missing inference/profile scopes silently skip', async () => {
  for (const stored of [{}, { anthropicApiKey: token }, credentials({ accessToken: '' }), credentials({ accessToken: `${token}\n` }),
    credentials({ expiresAt: 99999 }), credentials({ expiresAt: 100000 }), credentials({ expiresAt: '999999999' }),
    credentials({ scopes: undefined }), credentials({ scopes: 'user:inference user:profile' }),
    credentials({ scopes: ['user:profile', 'org:create_api_key'] }), credentials({ scopes: ['user:inference'] })]) {
    const h = fake(); h.files.set(h.file, JSON.stringify(stored));
    const result = await h.read();
    assert.equal(result.state, 'skipped'); assert.equal(h.requests.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /fake-oauth|fake-refresh/);
  }
  for (const value of [null, '{bad json', new Error(token)]) {
    const h = fake(); if (value == null) h.files.delete(h.file); else h.files.set(h.file, value);
    assert.equal((await h.read()).state, 'skipped'); assert.equal(h.requests.length, 0);
  }
});

test('credentials are reread on every attempt, including after Claude renews an expired token', async () => {
  const h = fake();
  h.files.set(h.file, JSON.stringify(credentials({ expiresAt: 100000 })));
  assert.equal((await h.read()).reason, 'expired');
  h.files.set(h.file, JSON.stringify(credentials())); await h.read();
  h.files.set(h.file, JSON.stringify(credentials({ accessToken: 'fresh-fake-token' }))); await h.read();
  assert.equal(h.reads.filter(file => file === h.file).length, 3);
  assert.deepEqual(h.requests.map(({ init }) => init.headers.Authorization), [`Bearer ${token}`, 'Bearer fresh-fake-token']);
});

test('the default fs reader reads changing fake credentials from an on-disk custom config directory', async t => {
  const scratch = path.resolve(__dirname, '../.test-output/claude-account-usage-20261028');
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, 'disk-credentials-'));
  const relative = path.relative(scratch, root);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(resolved, root);
    assert.equal(path.dirname(resolved), scratch);
    await fs.rm(resolved, { recursive: true, force: true });
    await assert.rejects(fs.stat(resolved), { code: 'ENOENT' });
  });
  const custom = path.join(root, 'custom'), fakeHome = path.join(root, 'home'), secure = path.join(root, 'secure');
  await fs.mkdir(custom); await fs.mkdir(path.join(fakeHome, '.claude'), { recursive: true }); await fs.mkdir(secure);
  const file = path.join(custom, '.credentials.json'), sent = [];
  await fs.writeFile(path.join(fakeHome, '.claude', '.credentials.json'), JSON.stringify(credentials({ accessToken: 'wrong-fake-home-token' })));
  const options = { env: { CLAUDE_CONFIG_DIR: custom }, home: fakeHome, platform: 'linux',
    execute() { assert.fail('on-disk fixture must never execute a vault reader'); },
    nativeRead() { assert.fail('on-disk fixture must never read a vault'); },
    async fetch(_url, init) { sent.push(init.headers.Authorization); return response(); },
  };
  const first = await readClaudeAccount(options); assert.equal(first.reason, 'credentials');
  await fs.writeFile(file, JSON.stringify(credentials({ accessToken: 'first-on-disk-fake-token' })));
  assert.equal((await readClaudeAccount(options)).state, 'ready');
  await fs.writeFile(file, JSON.stringify(credentials({ accessToken: 'renewed-on-disk-fake-token' })));
  assert.equal((await readClaudeAccount(options)).state, 'ready');
  await fs.writeFile(path.join(secure, '.credentials.json'), JSON.stringify(credentials({ accessToken: 'secure-on-disk-fake-token' })));
  assert.equal((await readClaudeAccount({ ...options, env: { ...options.env, CLAUDE_SECURESTORAGE_CONFIG_DIR: secure } })).state, 'ready');
  assert.deepEqual(sent, ['Bearer first-on-disk-fake-token', 'Bearer renewed-on-disk-fake-token', 'Bearer secure-on-disk-fake-token']);
});

test('config directory and secure-storage directory are explicit; no home/account remapping', async () => {
  const config = path.join(home, 'custom'), secure = path.join(home, 'secure');
  const h = fake({ env: { CLAUDE_CONFIG_DIR: config } });
  const custom = path.join(config, '.credentials.json');
  assert.equal((await h.read()).reason, 'credentials'); assert.equal(h.reads.includes(h.file), false);
  h.files.set(custom, JSON.stringify(credentials())); assert.equal((await h.read()).state, 'ready');
  assert.ok(h.reads.includes(path.join(config, 'settings.json')));
  h.options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = secure;
  assert.equal((await h.read()).reason, 'credentials');
  h.files.set(path.join(secure, '.credentials.json'), JSON.stringify(credentials()));
  assert.equal((await h.read()).state, 'ready');
  for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']) {
    const relative = fake({ env: { [key]: 'relative-to-another-terminal' } });
    assert.equal((await relative.read()).reason, 'route'); assert.equal(relative.reads.length, 0);
  }
});

test('inherited credential/provider route overrides skip by presence without reading their values', async () => {
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_OAUTH_TOKEN', 'CCR_OAUTH_TOKEN_FILE',
    'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_CUSTOM_OAUTH_URL', 'CLAUDE_CODE_OAUTH_CLIENT_ID', 'anthropic_api_key']) {
    const env = {}; Object.defineProperty(env, key, { enumerable: true, get() { assert.fail('read routing credential value'); } });
    const h = fake({ env });
    assert.equal((await h.read()).reason, 'route'); assert.equal(h.reads.length, 0); assert.equal(h.requests.length, 0);
  }
  const h = fake({ routes: [{ env: { ANTHROPIC_API_KEY: '' } }] });
  assert.equal((await h.read()).reason, 'route'); assert.equal(h.requests.length, 0);
});

test('user/project routing, console sign-in, credential helpers, mixed scopes and unreadable settings fail closed', async () => {
  const cwd = path.join(home, 'project');
  for (const settings of [{ env: { CLAUDE_CODE_USE_VERTEX: '0' } }, { env: { ANTHROPIC_BASE_URL: 'https://other.invalid' } },
    { apiKeyHelper: 'private-helper' }, { inferenceCredentialHelper: 'private-helper' }, { forceLoginMethod: 'console' }, { forceLoginMethod: 'gateway' }]) {
    for (const file of [path.join(home, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')]) {
      const h = fake({ cwd }); h.files.set(file, JSON.stringify(settings));
      assert.equal((await h.read()).reason, 'route'); assert.equal(h.requests.length, 0);
    }
  }
  const h = fake({ cwd }); h.files.set(path.join(cwd, '.claude', 'settings.json'), new Error(token));
  assert.equal((await h.read()).reason, 'route');
  assert.equal((await h.read({ routes: [{ cwd, env: { CLAUDE_CONFIG_DIR: 'another-account' } }] })).reason, 'route');
  assert.equal((await h.read({ routes: [] })).reason, 'route');
});

test('macOS Keychain uses the exact account/service and config suffix; only a missing item permits plaintext fallback', async () => {
  for (const env of [{}, { CLAUDE_CONFIG_DIR: path.join(home, 'cafe\u0301') }, { CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(home, 'secure') }]) {
    const h = fake({ platform: 'darwin', env }); let args;
    h.options.execute = (executable, argv, options, done) => {
      assert.equal(executable, '/usr/bin/security'); args = argv;
      assert.equal(options.timeout, 2000); assert.equal(options.windowsHide, true);
      done(null, JSON.stringify(credentials()));
    };
    assert.equal((await h.read()).state, 'ready');
    const folder = env.CLAUDE_SECURESTORAGE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR;
    const suffix = folder ? '-' + createHash('sha256').update(folder.normalize('NFC')).digest('hex').slice(0, 8) : '';
    assert.deepEqual(args, ['find-generic-password', '-a', 'claude-code-user', '-w', '-s', `Claude Code-credentials${suffix}`]);
    assert.equal(h.reads.some(file => file.endsWith('.credentials.json')), false);
  }
  const h = fake({ platform: 'darwin' });
  h.options.execute = (_exe, _args, _options, done) => done({ code: 44, message: token }, token);
  assert.equal((await h.read()).state, 'ready');
  for (const code of [36, 128, 1]) {
    h.options.execute = (_exe, _args, _options, done) => done({ code, message: token }, token);
    assert.equal((await h.read()).reason, 'credentials');
  }
});

test('Windows gate reads the exact named secure primary with fresh credentials; legacy state and forced selection match Claude', async () => {
  const h = fake({ platform: 'win32' });
  const v = vault(h), target = 'Claude Code-credentials/claude-code-user';
  assert.equal((await h.read()).state, 'ready');
  const count = h.reads.filter(file => file === h.file).length;
  h.files.set(path.join(home, '.claude.json'), JSON.stringify({ cachedGrowthBookFeatures: { tengu_windows_credman: true } }));
  v.put(target, credentials({ accessToken: 'first-vault-fake-token' }));
  assert.equal((await h.read()).state, 'ready');
  assert.deepEqual(v.reads, [[target + '#m'], [target]]);
  assert.equal(h.reads.filter(file => file === h.file).length, count);
  v.put(target, credentials({ accessToken: 'renewed-vault-fake-token' }));
  assert.equal((await h.read()).state, 'ready');
  assert.equal(h.requests.at(-1).init.headers.Authorization, 'Bearer renewed-vault-fake-token');
  h.files.delete(path.join(home, '.claude.json'));
  h.files.set(path.join(home, '.claude', '.config.json'), '{}');
  h.files.set(path.join(home, '.claude.json'), JSON.stringify({ cachedGrowthBookFeatures: { tengu_windows_credman: true } }));
  assert.equal((await h.read()).state, 'ready', 'an existing nonempty legacy state selects the gate instead of the newer path');
  assert.equal(h.requests.at(-1).init.headers.Authorization, `Bearer ${token}`);
  h.files.set(path.join(home, '.claude', '.config.json'), '');
  assert.equal((await h.read()).state, 'ready', 'an empty legacy state falls back to the current gate file');
  assert.equal(h.requests.at(-1).init.headers.Authorization, 'Bearer renewed-vault-fake-token');
  h.options.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN = '1';
  h.files.set(path.join(home, '.claude', '.config.json'), '{corrupt');
  assert.equal((await h.read()).state, 'ready', 'forced selection does not consult the cached gate');
});

test('Windows secure service suffixes follow config and secure-storage overrides exactly', async () => {
  for (const env of [{}, { CLAUDE_CONFIG_DIR: path.join(home, 'cafe\u0301') },
    { CLAUDE_CONFIG_DIR: path.join(home, 'config'), CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(home, 'secure') },
    { CLAUDE_CONFIG_DIR: path.join(home, 'config'), CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }]) {
    const h = fake({ platform: 'win32', env: { ...env, CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: '1' } }), v = vault(h);
    const folder = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR;
    const suffix = folder ? '-' + createHash('sha256').update(folder.normalize('NFC')).digest('hex').slice(0, 8) : '';
    const target = `Claude Code-credentials${suffix}/claude-code-user`;
    v.put(target, credentials());
    assert.equal((await h.read()).state, 'ready');
    assert.deepEqual(v.reads, [[target + '#m'], [target]]);
    assert.equal(h.reads.some(file => file.endsWith('.credentials.json')), false);
  }
});

test('Windows reads valid manifest chunks as exact-length base64 UTF-8 and never falls back from a corrupt secure item', async () => {
  const target = 'Claude Code-credentials/claude-code-user';
  const text = JSON.stringify({ ...credentials(), nonsecret: '中文' }), encoded = Buffer.from(text).toString('base64');
  for (const n of [1, 2, 256]) {
    const h = fake({ platform: 'win32', env: { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: '1' } }), v = vault(h);
    v.put(target + '#m', { n, l: encoded.length });
    for (let i = 0; i < n; ++i) v.put(target + '#' + i, n === 1 ? encoded : i === 0 ? encoded.slice(0, 8) : i === n - 1 ? encoded.slice(8) : '');
    assert.equal((await h.read()).state, 'ready');
    assert.equal(v.reads.length, 2); assert.equal(v.reads[1].length, n);
    assert.equal(h.reads.some(file => file.endsWith('.credentials.json')), false);
  }
  for (const failure of ['missing-chunk', 'denied-chunk', 'length', 'base64', 'utf8', 'json', 'oversized-chunk']) {
    const h = fake({ platform: 'win32', env: { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: '1' } }), v = vault(h);
    const value = failure === 'base64' ? '!!!!' : failure === 'utf8' ? '/w==' : failure === 'json' ? Buffer.from(token).toString('base64')
      : failure === 'oversized-chunk' ? 'a'.repeat(2401) : encoded;
    v.put(target + '#m', { n: failure === 'oversized-chunk' ? 2 : 1, l: value.length + (failure === 'length' ? 4 : 0) });
    if (failure !== 'missing-chunk') v.put(target + '#0', value);
    if (failure === 'oversized-chunk') v.put(target + '#1', '');
    if (failure === 'denied-chunk') v.entries.set(target + '#0', { state: 'unavailable' });
    assert.equal((await h.read()).reason, 'credentials', failure);
    assert.equal(h.requests.length, 0); assert.equal(h.reads.some(file => file.endsWith('.credentials.json')), false);
  }
});

test('invalid Windows manifests use the secure raw primary; only a missing primary permits plaintext fallback', async () => {
  const target = 'Claude Code-credentials/claude-code-user';
  for (const manifest of ['bad-json', {}, null, { n: 0, l: 4 }, { n: 257, l: 4 }, { n: 1.5, l: 4 },
    { n: 1, l: 0 }, { n: 1, l: 2401 }, { n: 1, l: 3.5 }, { n: '1', l: 4 }]) {
    const h = fake({ platform: 'win32', env: { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: '1' } }), v = vault(h);
    v.put(target + '#m', manifest); v.put(target, credentials());
    assert.equal((await h.read()).state, 'ready');
    assert.deepEqual(v.reads[1], [target]);
  }
  const missing = fake({ platform: 'win32', env: { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: '1' } }); vault(missing);
  assert.equal((await missing.read()).state, 'ready'); assert.ok(missing.reads.includes(missing.file));
  for (const [name, item] of [[target + '#m', { state: 'unavailable' }], [target, { state: 'unavailable' }],
    [target, { state: 'present', value: '' }], [target, { state: 'present', value: token }]]) {
    const h = fake({ platform: 'win32', env: { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: '1' } }), v = vault(h);
    v.entries.set(name, item);
    assert.equal((await h.read()).reason, 'credentials'); assert.equal(h.requests.length, 0);
    assert.equal(h.reads.some(file => file.endsWith('.credentials.json')), false);
  }
});

test('the owned Windows helper receives only named targets and captures UTF-8 credential bytes without exposing its output', async () => {
  const target = 'Claude Code-credentials/claude-code-user', executions = [];
  const h = fake({ platform: 'win32', env: { SystemRoot: 'C:\\FakeWindows', CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: '1' } });
  h.options.execute = (executable, args, options, done) => {
    assert.equal(executable, 'C:\\FakeWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand']);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.doesNotMatch(script, /fake-oauth|fake-refresh/);
    assert.deepEqual([...script.matchAll(/static extern \w+ (\w+)\(/g)].map(match => match[1]), ['CredReadW', 'CredFree']);
    assert.equal(options.windowsHide, true); assert.equal(options.timeout, 2000); assert.equal(options.maxBuffer, 1024 * 1024);
    assert.equal(options.signal.aborted, false);
    return { stdin: { on() {}, end(input) {
      const { targets } = JSON.parse(input); executions.push(targets);
      assert.doesNotMatch(input, /fake-oauth|fake-refresh/);
      done(null, JSON.stringify(targets.map(name => name === target + '#m' ? 'missing'
        : 'present:' + Buffer.from(JSON.stringify({ ...credentials(), nonsecret: '中文' }), 'utf8').toString('base64'))));
    } } };
  };
  const result = await h.read();
  assert.equal(result.state, 'ready'); assert.deepEqual(executions, [[target + '#m'], [target]]);
  assert.doesNotMatch(JSON.stringify(result), /fake-oauth|fake-refresh|Authorization|present:/);
  assert.equal(h.reads.some(file => file.endsWith('.credentials.json')), false);
});

test('Windows child failures, denied items, malformed/oversized output and invalid UTF-8 fail closed and sanitize secret-bearing errors', async t => {
  const logs = [];
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => logs.push(args));
  for (const output of [null, token, '[]', '["unavailable"]', '["present:!!!!"]', '["present:/w=="]', 'x'.repeat(1024 * 1024 + 1)]) {
    const h = fake({ platform: 'win32', env: { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: '1' } });
    h.options.execute = (_exe, _args, _options, done) => ({ stdin: { on() {}, end() {
      done(output === null ? Object.assign(new Error(token), { stdout: token, stderr: token, code: 5 }) : null, output);
    } } });
    const result = await h.read();
    assert.equal(result.reason, 'credentials'); assert.equal(h.requests.length, 0);
    assert.equal(h.reads.some(file => file.endsWith('.credentials.json')), false);
    assert.doesNotMatch(JSON.stringify(result), /fake-oauth|stdout|stderr/);
  }
  const h = fake({ platform: 'win32', env: { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: '1' } });
  h.options.execute = () => { throw new Error(token); };
  assert.equal((await h.read()).reason, 'credentials');
  h.options.nativeRead = () => { throw new Error(token); };
  assert.deepEqual(await h.read(), { state: 'error', reason: 'query' });
  assert.deepEqual(logs, []);
});

test('Windows helper cancellation/timeout aborts the owned child signal and ignores late secret-bearing output', async () => {
  for (const stop of ['cancel', 'timeout']) {
    const h = fake({ platform: 'win32', env: { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: '1' } });
    const controller = new AbortController(); let signal, finish, executions = 0;
    h.options.execute = (_exe, _args, options, done) => {
      ++executions; signal = options.signal; finish = done;
      return { stdin: { on() {}, end() {} } };
    };
    const pending = h.read({ signal: controller.signal }); await flush();
    if (stop === 'cancel') controller.abort(); else await h.time.tick(5000);
    const result = await pending;
    assert.equal(result.reason, stop === 'cancel' ? 'cancelled' : 'timeout');
    assert.equal(signal.aborted, true);
    finish(null, JSON.stringify(['present:' + Buffer.from(token).toString('base64')])); await flush();
    assert.equal(executions, 1); assert.equal(h.requests.length, 0); assert.equal(h.time.timers.size, 0);
    assert.doesNotMatch(JSON.stringify(result), /fake-oauth/);
  }
});

test('429 Retry-After seconds/dates and 5xx metadata are sanitized; error bodies are never read', async () => {
  for (const [value, delay] of [['120', 120000], ['Thu, 01 Jan 1970 00:04:00 GMT', 140000], ['Thu, 01 Jan 1970 00:00:00 GMT', 0], [token, 0]]) {
    const h = fake({ fetch: async () => ({ ...response(null, 429, value), json: () => assert.fail('read error body') }) });
    assert.deepEqual(await h.read(), { state: 'error', reason: 'http', status: 429, retryAfterMs: delay });
  }
  for (const status of [401, 403, 500, 503]) {
    const h = fake({ fetch: async () => ({ ...response(null, status, '90'), json: () => assert.fail('read error body') }) });
    const result = await h.read();
    assert.equal(result.status, status); assert.equal(result.retryAfterMs, status >= 500 ? 90000 : 0);
    assert.doesNotMatch(JSON.stringify(result), /fake-oauth/);
  }
});

test('network/body/file exceptions and in-band error bodies cannot publish tokens, headers or diagnostics', async t => {
  const logs = [];
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => logs.push(args));
  for (const fetch of [async () => { throw new Error(`Authorization: Bearer ${token}`); },
    async () => ({ ...response(), json: async () => { throw new Error(token); } }),
    async () => response({ error: { message: token } })]) {
    const h = fake({ fetch }); const result = await h.read();
    assert.equal(result.state, 'error'); assert.doesNotMatch(JSON.stringify(result), /fake-oauth|Authorization/);
  }
  assert.deepEqual(logs, []);
});

test('short timeout and cancellation bound file/fetch/body hangs and discard late success', async () => {
  for (const stage of ['file', 'fetch', 'body']) {
    const h = fake(); let release, signal;
    const hang = () => new Promise(resolve => { release = resolve; });
    if (stage === 'file') h.options.readFile = hang;
    else h.options.fetch = async (_url, init) => { signal = init.signal; return stage === 'fetch' ? hang() : { ...response(), json: hang }; };
    const pending = h.read(); await flush(); await h.time.tick(4999);
    await h.time.tick(1); assert.deepEqual(await pending, { state: 'error', reason: 'timeout' });
    if (signal) assert.equal(signal.aborted, true);
    release(stage === 'fetch' ? response() : stage === 'body' ? usage() : '{}'); await flush();
    assert.equal(h.time.timers.size, 0);
  }
  const h = fake(); const controller = new AbortController(); let signal;
  h.options.fetch = async (_url, init) => { signal = init.signal; return new Promise(() => {}); };
  const pending = h.read({ signal: controller.signal }); await flush(); controller.abort();
  assert.equal((await pending).reason, 'cancelled'); assert.equal(signal.aborted, true); assert.equal(h.time.timers.size, 0);
  assert.equal((await h.read({ signal: controller.signal })).reason, 'cancelled');
});

test('polling requires active terminals, debounces starts/events and preserves the HTTP rate limit across stop/rebind', async () => {
  const h = fake(), observations = [];
  const service = new ClaudeAccountUsage({ ...h.time, read: h.read, changed: value => observations.push(value) });
  service.refresh(); await h.time.tick(120000); assert.equal(h.requests.length, 0);
  service.setActive(true); service.refresh(); service.refresh();
  await h.time.tick(249); assert.equal(h.requests.length, 0);
  await h.time.tick(1); assert.equal(h.requests.length, 1); assert.equal(observations.length, 1);
  for (let i = 0; i < 5; ++i) { service.refresh(); service.setActive(false); service.setActive(true); }
  await h.time.tick(59999); assert.equal(h.requests.length, 1);
  await h.time.tick(1); assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].at - h.requests[0].at, POLL_INTERVAL);
  service.setActive(false); await h.time.tick(120000); assert.equal(h.requests.length, 2); assert.equal(h.time.timers.size, 0);
  service.dispose(); service.setActive(true); service.refresh(); await h.time.tick(120000); assert.equal(h.requests.length, 2);
  assert.doesNotMatch(JSON.stringify({ service, observations }), /fake-oauth|fake-refresh|Authorization/);
});

test('active polling retries missing/expired credentials later and observes renewal without refreshing or writing', async () => {
  const h = fake(); h.files.delete(h.file);
  const service = new ClaudeAccountUsage({ ...h.time, read: h.read });
  service.setActive(true); await h.time.tick(250);
  assert.equal(h.requests.length, 0); assert.equal(service.account, null);
  h.files.set(h.file, JSON.stringify(credentials({ expiresAt: h.time.now() })));
  await h.time.tick(POLL_INTERVAL); assert.equal(h.requests.length, 0);
  h.files.set(h.file, JSON.stringify(credentials({ accessToken: 'renewed-fake-token' })));
  await h.time.tick(POLL_INTERVAL); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].init.headers.Authorization, 'Bearer renewed-fake-token');
  assert.equal(service.account.source, 'Claude');
  assert.equal(h.reads.filter(file => file === h.file).length, 3);
  service.dispose();
});

test('rate limiting measures actual HTTP dispatch, including slow credential reads and late stopped attempts', async () => {
  const h = fake(); let release;
  const read = h.options.readFile;
  h.options.readFile = async (file, encoding) => {
    if (file === h.file && !release) await new Promise(resolve => { release = resolve; });
    return read(file, encoding);
  };
  const service = new ClaudeAccountUsage({ ...h.time, read: h.read });
  service.setActive(true); await h.time.tick(250); await h.time.tick(1000); release(); await flush();
  assert.equal(h.requests.length, 1);
  service.setActive(false); service.setActive(true);
  await h.time.tick(59999); assert.equal(h.requests.length, 1);
  await h.time.tick(1); assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].at - h.requests[0].at, POLL_INTERVAL);
  service.dispose();
});

test('transient failures back off exponentially, honor Retry-After, survive quick reactivation and recover', async () => {
  const h = fake(); let requests = 0;
  h.options.fetch = async () => {
    ++requests;
    if (requests === 1) return response(null, 429, '180');
    if (requests === 2) throw new Error(token);
    if (requests === 3) return response(null, 503);
    return response();
  };
  const service = new ClaudeAccountUsage({ ...h.time, read: h.read });
  service.setActive(true); await h.time.tick(250); assert.equal(requests, 1);
  service.setActive(false); service.setActive(true); service.refresh();
  await h.time.tick(179999); assert.equal(requests, 1);
  await h.time.tick(1); assert.equal(requests, 2);
  await h.time.tick(119999); assert.equal(requests, 2);
  await h.time.tick(1); assert.equal(requests, 3);
  await h.time.tick(239999); assert.equal(requests, 3);
  await h.time.tick(1); assert.equal(requests, 4); assert.equal(service.account.source, 'Claude');
  await h.time.tick(60000); assert.equal(requests, 5); service.dispose();
});

test('stopping aborts in-flight requests; late results and reactivation never publish an old attempt', async () => {
  const h = fake(), published = [], pending = [];
  const service = new ClaudeAccountUsage({ ...h.time, changed: value => published.push(value), read: options => new Promise(resolve => pending.push({ ...options, resolve })) });
  service.setActive(true); await h.time.tick(250);
  assert.equal(pending[0].beforeRequest(), true);
  service.setActive(false); assert.equal(pending[0].signal.aborted, true);
  service.setActive(true); await h.time.tick(60000); assert.equal(pending.length, 2);
  pending[0].resolve({ state: 'ready', account: claudeUsageResult(usage(99), h.time.now()) }); await flush();
  assert.equal(pending[0].beforeRequest(), false); assert.deepEqual(published, []);
  assert.equal(pending[1].beforeRequest(), true);
  pending[1].resolve({ state: 'ready', account: claudeUsageResult(usage(20), h.time.now()) }); await flush();
  assert.equal(published[0].limits[0].percent, 20);
  service.dispose(); assert.equal(h.time.timers.size, 0);
});

test('fresh direct observations outrank stale CodePulse writes, newer Claude cache observations win, and fallback resumes after two intervals', t => {
  const at = 1000000;
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const direct = claudeUsageResult(usage(24), at);
  const own = stamp => claudeAccountFrom({ cachedUsageUtilization: { fetchedAtMs: stamp, utilization: usage(16) } });
  const pulse = stamp => codePulseLimits({ updatedAt: stamp, rate_limits: {
    five_hour: { used_percent: 3, resets_at: Date.parse('2026-10-28T12:00:00Z') / 1000 },
  } });
  const meter = new UsageMeter('claude');
  meter.account(pulse(at + 10000));
  assert.equal(meter.account(selectClaudeAccount(own(at - 1), pulse(at + 10000), direct)), true,
    'write timestamps cannot block a fresh GET in the meter either');
  assert.deepEqual([meter.limitsAt, meter.limitsFrom, meter.limits[0].percent], [at, 'Claude', 24]);
  assert.equal(selectClaudeAccount(own(at - 1), pulse(at + 100000), direct, at + 119999), direct);
  assert.equal(selectClaudeAccount(own(at + 1), pulse(at + 100000), direct, at + 1000).source, 'Claude Code');
  meter.account(own(at + 1));
  assert.equal(meter.account(direct), false, 'a real newer cache observation remains newer');
  const fallback = selectClaudeAccount(own(at - 1), pulse(at + 100000), direct, at + 120000);
  assert.equal(fallback.source, 'CodePulse');
  t.mock.timers.tick(120000);
  assert.equal(meter.account(fallback), true);
  assert.equal(selectClaudeAccount(own(at - 1), pulse(at - 1), direct, at + 120000), direct,
    'a failed poll does not erase the last dated observation or fabricate zero');
  assert.equal(selectClaudeAccount(null, pulse(at - 1), null, at).source, 'CodePulse');
  assert.equal(selectClaudeAccount(own(at), null, null, at).source, 'Claude Code');
  assert.equal(selectClaudeAccount(claudeAccountFrom({ cachedUsageUtilization: { fetchedAtMs: at + 1, utilization: {} } }), null, direct, at), direct);
  assert.equal(selectClaudeAccount(null, null, null, at), null);
});

test('a newer Claude cache observation displaces a larger CodePulse write timestamp when the selector carries a fresh direct comparison', t => {
  const at = 1000000;
  t.mock.timers.enable({ apis: ['Date'], now: at + 1000 });
  const direct = claudeUsageResult(usage(24), at);
  const own = claudeAccountFrom({ cachedUsageUtilization: { fetchedAtMs: at + 1, utilization: usage(25) } });
  const pulse = codePulseLimits({ updatedAt: at + 100000, rate_limits: { five_hour: { used_percent: 2 } } });
  const meter = new UsageMeter('claude'); meter.account(pulse);
  const selected = selectClaudeAccount(own, pulse, direct);
  assert.equal(selected, own);
  assert.equal(meter.account(selected, direct), true);
  assert.deepEqual([meter.limitsAt, meter.limitsFrom, meter.limits[0].percent], [at + 1, 'Claude Code', 25]);
  assert.equal(meter.account(pulse), false, 'a late async fallback cannot replace a true observation while the direct comparison is fresh');
  assert.equal(meter.account(claudeAccountFrom({ cachedUsageUtilization: { fetchedAtMs: at - 1, utilization: usage(1) } })), false);
  t.mock.timers.tick(119000);
  assert.equal(meter.account(pulse), true, 'CodePulse resumes as a fallback after two query intervals');
  assert.equal(meter.limitsAt, at + 100000);
});

test('a fresh direct observation rejects late async fallback reads without changing Codex monotonic observation dates', t => {
  const at = 1000000;
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const meter = new UsageMeter('claude'), direct = claudeUsageResult(usage(24), at);
  meter.account(direct);
  const stale = codePulseLimits({ updatedAt: at + 100000, rate_limits: { five_hour: { used_percent: 1 } } });
  assert.equal(meter.account(stale), false);
  assert.equal(meter.account(null, direct), false);
  assert.deepEqual([meter.limitsAt, meter.limitsFrom, meter.limits[0].percent], [at, 'Claude', 24]);
  const codex = new UsageMeter('codex');
  assert.equal(codex.observeLimits(direct.limits, at + 100000, 'Codex'), true);
  assert.equal(codex.observeLimits(direct.limits, at, 'Claude'), false);
  assert.equal(codex.observeLimits(direct.limits, at + 1, 'Claude Code'), false);
  assert.equal(codex.snapshot().limitsAt, at + 100000);
});

test('new observations retain rollover dates; expired windows stay dated and unknown fields never turn into zero', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const meter = new UsageMeter('claude');
  const value = claudeUsageResult({ five_hour: { utilization: 92, resets_at: '1970-01-01T00:01:50Z' }, seven_day: null }, 100000);
  meter.account(value);
  t.mock.timers.tick(10000);
  assert.deepEqual(meter.snapshot().limits, [{ minutes: 300, percent: 92, resetsAt: 110000 }]);
  meter.account(null); meter.account(claudeUsageResult({}, 110000));
  assert.equal(meter.snapshot().limitsAt, 100000);
  assert.equal(meter.snapshot().limits.length, 1);
  meter.account(claudeUsageResult({ five_hour: { utilization: 0, resets_at: '1970-01-01T05:01:50Z' } }, 110000));
  assert.equal(meter.snapshot().limits[0].percent, 0);
  assert.equal(meter.snapshot().limits[0].resetsAt, 18110000);
});
