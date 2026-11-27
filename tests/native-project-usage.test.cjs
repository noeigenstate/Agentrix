const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { readAgyAccount, remoteAgyLimits } = require('../electron/features/agy-acp/usage.cjs');
const { readClaudeAccountCache } = require('../electron/features/agents/agent-usage.cjs');
const { readClaudeAccount } = require('../electron/features/agents/claude-account-usage.cjs');
const { CodexAccountUsage, readCodexAccount } = require('../electron/features/agents/codex-account-usage.cjs');
const { withFocusedAccountReaders } = require('../electron/features/agents/usage-host.cjs');
const { adapterOf } = require('../electron/features/cli-adapters/registry.cjs');
const { createHostInputs } = require('../electron/features/native-session/host-inputs.cjs');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const { createProjectAccounts } = require('../electron/features/native-session/project-accounts.cjs');

async function fixture(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agx-focused-usage-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return directory;
}

const gate = () => ({ started: Promise.withResolvers(), reply: Promise.withResolvers() });
const windowOf = (usage, agent, group = 'subscription') => usage.agents[agent].limits?.limitsById[group]?.primary;
const at = Date.UTC(2026, 10, 26), reset = at + 3600000;
const claudeWindows = (percent, resetsAt = reset) => ({ five_hour: { utilization: percent, resets_at: new Date(resetsAt).toISOString() } });
const forbidden = () => assert.fail('a focused usage read must not start or use a model session');

function nativeUsage(directory, options) {
  const native = createNativeSessions({ directory, claude: { facts: () => [], usage: { summary: () => ({}) }, create: forbidden },
    codex: { create: forbidden }, agy: { create: forbidden }, resolveSpec: forbidden, emit: forbidden, ...options });
  const handlers = new Map();
  native.register((name, handler) => handlers.set(name, handler));
  return { read: handlers.get('native:usage'), close: () => native.close() };
}

function codexPeer(requests, nextRead) {
  return options => readCodexAccount({ ...options, executable: 'fake-codex',
    launch(executable, args) {
      assert.deepEqual([executable, ...args], ['fake-codex', 'app-server', '--listen', 'stdio://']);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      const reply = (id, result) => child.stdout.write(JSON.stringify({ id, result }) + '\n');
      child.stdin = new Writable({ write(data, _encoding, done) {
        const { id, method, params } = JSON.parse(data);
        requests.push(method);
        if (method === 'initialize') queueMicrotask(() => reply(id, {}));
        else if (method === 'account/read') {
          assert.deepEqual(params, { refreshToken: false });
          queueMicrotask(() => reply(id, { account: { type: 'chatgpt', email: 'fixture-email' } }));
        } else if (method === 'account/rateLimits/read') {
          assert.deepEqual(params, { excludeResetCreditDetails: true });
          const read = nextRead();
          read.started.resolve();
          void read.reply.promise.then(usedPercent => reply(id, { rateLimitsByLimitId: { codex: {
            primary: { usedPercent, windowDurationMins: 300, resetsAt: reset / 1000 },
          } } }));
        } else assert.equal(method, 'initialized');
        done();
      } });
      return child;
    },
    stop: child => { child.stdin.destroy(); child.stdout.destroy(); },
  });
}

function agyPeer(launches, read) {
  return options => readAgyAccount({ ...options, locate: () => 'fake-agy',
    spawnProcess(file, args) {
      assert.equal(file, 'fake-agy');
      launches.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      const reply = output => { child.stdout.end(Buffer.from(output)); child.emit('close', 0); };
      if (args[0] === '--version') queueMicrotask(() => reply('agy 1.5.18'));
      else {
        read.started.resolve();
        void read.reply.promise.then(() => reply(JSON.stringify({
          status: 'SUCCESS', num_turns: 0, email: 'fixture-email', command: { name: 'usage', data: { groups: [{ buckets: [
            { id: 'gemini-5h', window: '5h', remaining_fraction: 0.75, reset_time: new Date(reset).toISOString() },
          ] }] } },
        })));
      }
      return child;
    },
    stopChild: async child => child.stdout.destroy(),
  });
}

async function claudeProfile(directory) {
  const config = path.join(directory, 'claude');
  await fs.promises.mkdir(config);
  await fs.promises.writeFile(path.join(config, '.claude.json'), JSON.stringify({
    oauthAccount: { billingType: 'stripe_subscription', accountUuid: 'fixture-account', emailAddress: 'fixture-email' },
    cachedUsageUtilization: { fetchedAtMs: at - 3000, utilization: claudeWindows(65, at) },
  }));
  await fs.promises.writeFile(path.join(config, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: 'fixture-token', expiresAt: reset, scopes: ['user:inference', 'user:profile'],
  } }));
  return { HOME: directory, CLAUDE_CONFIG_DIR: config, CODEX_HOME: path.join(directory, 'codex') };
}

function focusedUsage(t, directory, { env, codex, readClaudeUsage, agy }) {
  const project = { id: 'p', path: directory, quotaAgents: ['agy'] }, adapter = adapterOf('agy');
  const accounts = withFocusedAccountReaders(createProjectAccounts({ codex, readClaude: readClaudeAccountCache, readClaudeUsage }), {
    cwd: () => directory, registered: () => [{ ...adapter, usage: { ...adapter.usage, accountReader: agy } }],
  });
  const notifications = Array.from({ length: 4 }, () => Promise.withResolvers()), sent = [], recorded = Promise.withResolvers();
  const deps = { sessions: new Map(), store: { projects: [project] }, projectAccounts: accounts, codexAccounts: codex,
    checkClaude: async () => ({ status: 'ok' }), codexExecutable: async () => 'fake-codex',
    localClaudeMeters: () => [], dispatchReading: () => null, dashboard: { quota: (...args) => recorded.resolve(args) },
    quotaScope: () => 'fixture-scope', send: (...args) => { notifications[sent.push(args) - 1]?.resolve(args); },
  };
  Object.assign(deps, createHostInputs(deps), { nativeEnvironment: () => env });
  const native = nativeUsage(directory, { usageInputs: deps.readNativeUsageInputs, connections: deps.readNativeConnections, validateProject: () => project });
  t.after(async () => { await accounts.close(); codex.dispose(); await native.close(); });
  return { project, read: () => native.read('p'), notifications, sent, recorded };
}

test('opening a project delivers cached usage then publishes each provider independently without a model turn', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const directory = await fixture(t), env = await claudeProfile(directory);
  const firstCodex = gate(), nextCodex = gate(), claude = gate(), agy = gate();
  const requests = [], launches = [], reads = [firstCodex, nextCodex];
  const codex = new CodexAccountUsage({ scope: async () => null, read: codexPeer(requests, () => reads.shift()) });
  const readClaudeUsage = options => readClaudeAccount({ ...options, platform: 'linux', home: directory, fetch: async (url, request) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(request.method, 'GET');
    claude.started.resolve();
    await claude.reply.promise;
    return { status: 200, json: async () => claudeWindows(18) };
  } });
  const { project, read, notifications, sent, recorded } = focusedUsage(t, directory, { env, codex, readClaudeUsage, agy: agyPeer(launches, agy) });
  const cached = await read();
  await Promise.all([firstCodex.started.promise, claude.started.promise, agy.started.promise]);
  assert.deepEqual(windowOf(cached, 'claude'), { usedPercent: null, windowDurationMins: 300, resetsAtMs: at });
  assert.equal(windowOf(cached, 'codex'), undefined);
  assert.equal(windowOf(cached, 'agy', 'gemini'), undefined);
  assert.deepEqual(sent, []);

  const event = ['agents:usage-changed', { projectId: project.id }];
  firstCodex.reply.resolve(31);
  assert.deepEqual(await notifications[0].promise, event);
  const first = await read();
  assert.equal(windowOf(first, 'codex').usedPercent, 31);
  assert.equal(windowOf(first, 'claude').usedPercent, null);
  assert.equal(windowOf(first, 'agy', 'gemini'), undefined);
  claude.reply.resolve();
  assert.deepEqual(await notifications[1].promise, event);
  const second = await read();
  assert.equal(windowOf(second, 'claude').usedPercent, 18);
  assert.equal(windowOf(second, 'agy', 'gemini'), undefined);
  agy.reply.resolve();
  assert.deepEqual(await notifications[2].promise, event);
  const fresh = await read();
  assert.equal(windowOf(fresh, 'agy', 'gemini').usedPercent, 25);
  assert.doesNotMatch(JSON.stringify(fresh), /fixture-email|fixture-token|fixture-account/);
  const [provider, limits] = await recorded.promise;
  assert.equal(provider, 'agy');
  assert.equal(limits[0].percent, 25);

  t.mock.timers.tick(codex.interval + 1);
  const scope = { cwd: project.path, env, accountLaunch: 'project-open-v1' };
  assert.equal(codex.peek(scope).limits[0].percent, 31);
  assert.equal(codex.peek({ ...scope, cwd: path.join(directory, 'another') }), null);
  assert.equal(windowOf(await read(), 'codex').usedPercent, 31);
  await nextCodex.started.promise;
  assert.equal(sent.length, 3);
  nextCodex.reply.resolve(52);
  assert.deepEqual(await notifications[3].promise, event);
  assert.equal(windowOf(await read(), 'codex').usedPercent, 52);
  assert.deepEqual(requests, Array.from({ length: 2 }, () => ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']).flat());
  assert.deepEqual(launches, [['--version'], ['-p', '/usage', '--output-format', 'json']]);
});

test('Claude does not give a custom project the direct reading from an official project', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const directory = await fixture(t), env = await claudeProfile(directory);
  const official = { id: 'a', path: directory }, custom = { id: 'b', path: path.join(directory, 'custom') };
  await fs.promises.mkdir(path.join(custom.path, '.claude'), { recursive: true });
  await fs.promises.writeFile(path.join(custom.path, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://fixture.invalid' } }));
  let requests = 0;
  const accounts = createProjectAccounts({ codex: { interval: 30000 }, readClaude: readClaudeAccountCache,
    readClaudeUsage: options => readClaudeAccount({ ...options, home: directory, platform: 'linux', fetch: async () => {
      requests++;
      return { status: 200, json: async () => claudeWindows(18) };
    } }) });
  t.after(() => accounts.close());
  const options = { env, cli: { claude: { status: 'ok' }, codex: { status: 'missing' } } };
  const percent = answer => answer.claude.limits[0].percent;
  assert.equal(percent(await accounts.read(official, options)), 18);
  const seen = [];
  assert.equal(percent(await accounts.read(custom, { ...options, onCached: () => seen.push(percent(accounts.snapshot(custom.id))) })), 65);
  assert.deepEqual(seen, [65, 65], 'custom route sees only the disk cache, before and after its route check');
  assert.equal(percent(await accounts.read(official, options)), 18);
  assert.equal(requests, 1);
});

test('SSH agy keeps the original reading on a failed refresh, masks its passed window and isolates replacement channels', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const directory = await fixture(t);
  let requests = 0;
  const original = { async request(method) {
    assert.equal(method, 'agy-usage');
    if (++requests === 1) return [{ id: 'gemini', percent: 45, minutes: 300, resetsAt: at + 300000 }];
    if (requests === 3) return [];
    throw new Error('fixture timeout');
  } };
  let channel = original;
  const native = nativeUsage(directory, { validateProject: id => ({ kind: id === 'ssh' ? 'ssh' : 'local' }),
    usageInputs: id => { assert.equal(id, 'other'); }, remoteLimits: (_projectId, _agent, read) => read(channel) });
  t.after(() => native.close());
  assert.equal(windowOf(await native.read('ssh'), 'agy', 'gemini').usedPercent, 45);
  t.mock.timers.tick(300000);
  await native.read('other');
  assert.deepEqual(windowOf(await native.read('ssh'), 'agy', 'gemini'), { usedPercent: null, windowDurationMins: 300, resetsAtMs: at + 300000 });
  assert.equal((await remoteAgyLimits(original)).limitsById.gemini.primary.usedPercent, 45);
  assert.equal(requests, 2);
  channel = { request: async () => null };
  assert.equal(windowOf(await native.read('ssh'), 'agy', 'gemini'), undefined);
  channel = original;
  t.mock.timers.tick(300000);
  assert.equal(windowOf(await native.read('ssh'), 'agy', 'gemini'), undefined, 'an empty reply clears the channel’s previous observation');
});
