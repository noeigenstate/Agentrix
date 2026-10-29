const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const vm = require('node:vm');
const { UsageMeter } = require('../electron/features/agents/agent-usage.cjs');
const { accountLaunch, accountEnvironment } = require('../integration/codex-account-scope.cjs');
const { CodexAccountUsage, readCodexAccount, usageScope, accountResult, configScope, accountConfigScope } = require('../electron/features/agents/codex-account-usage.cjs');

const flush = () => new Promise(resolve => setImmediate(resolve));
const options = { cwd: os.tmpdir(), codexHome: path.join(os.tmpdir(), 'fake-codex-home'), env: {}, provider: 'openai', accountLaunch: 'model-only-v1' };
const ready = left => accountResult({ rateLimitResetCredits: { availableCount: left }, rateLimits: {
  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1792149600 }, secondary: null,
} }, 1234);

// A real owned child with no account configuration or credentials. It only
// implements the two allowed reads, deliberately splitting JSON over chunks.
const FAKE = String.raw`
const rl = require('node:readline').createInterface({ input: process.stdin });
const mode = process.env.FAKE_MODE;
rl.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialized') return;
  if (request.method === 'initialize') {
    process.stdout.write('{"id":1,"result":{}}\n'); return;
  }
  if (request.method !== 'account/rateLimits/read') process.exit(90);
  if (mode === 'hang') return;
  if (mode === 'exit') process.exit(1);
  if (mode === 'overflow') { process.stdout.write('x'.repeat(300000)); return; }
  if (mode === 'invalid') { process.stdout.write('not json\n'); return; }
  if (mode === 'null-message') { process.stdout.write('null\n'); return; }
  if (mode === 'error' || mode === 'old') {
    process.stdout.write(JSON.stringify({ id: 2, error: { code: mode === 'old' ? -32601 : -32000, message: 'private diagnostic' } }) + '\n'); return;
  }
  process.stdout.write('{"method":"account/rateLimits/updated","params":{}}\n{"id":99,"result":{}}\n');
  const response = JSON.stringify({ id: 2, result: { accountId: 'must-not-escape',
    rateLimits: mode === 'limits' ? { primary: { usedPercent: 80, windowDurationMins: 300 } } : {},
    rateLimitResetCredits: mode === 'null' || mode === 'limits' ? null : { availableCount: Number(mode), credits: null } } }) + '\n';
  process.stdout.write(response.slice(0, 17));
  setTimeout(() => process.stdout.write(response.slice(17)), 5);
});
setInterval(() => {}, 1000);
`;

async function fakeRead(t, mode, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-child-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'fake.cjs'); fs.writeFileSync(file, FAKE);
  const sent = []; let child, exited, stops = 0;
  const result = await readCodexAccount({ ...options, executable: 'fake-codex', timeout: 3000, ...extra,
    launch(executable, args, opts) {
      assert.equal(executable, 'fake-codex');
      assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
      assert.equal(opts.env.CODEX_HOME, options.codexHome);
      assert.equal(opts.shell, false); assert.equal(opts.windowsHide, true);
      child = spawn(process.execPath, [file], { ...opts, env: { FAKE_MODE: mode, SystemRoot: process.env.SystemRoot || '' } });
      exited = once(child, 'exit');
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = data => {
        const request = JSON.parse(data); sent.push(request);
        if (request.method === 'account/rateLimits/read') extra.onUsage?.();
        return write(data);
      };
      return child;
    },
    stop: extra.defaultStop ? undefined : owned => { assert.equal(owned, child); ++stops; child?.kill('SIGKILL'); },
  });
  if (exited) await exited;
  assert.equal(stops, extra.defaultStop ? 0 : 1, 'every outcome disposes its child exactly once');
  assert.deepEqual(sent.map(value => value.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.deepEqual(sent.at(-1).params, { excludeResetCreditDetails: true });
  assert.equal(sent[0].params.capabilities.explicitGatewayOauth, true);
  assert.doesNotMatch(JSON.stringify(result), /must-not-escape|private diagnostic/);
  return result;
}

test('official background protocol: count 0 and 2, split JSON, notifications, sanitization and process cleanup', async t => {
  for (const left of [0, 2]) {
    const value = await fakeRead(t, String(left));
    assert.deepEqual(value.resets, { left, total: null });
    assert.equal(value.resetQuery.state, 'ready');
  }
});

test('valid account limits survive missing reset credits without inventing a reset count', () => {
  for (const rateLimitResetCredits of [undefined, null, {}, { availableCount: null }, { availableCount: 0 }]) {
    const account = accountResult({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 123 } }, rateLimitResetCredits }, 2000);
    assert.deepEqual(account.limits, [{ minutes: 300, percent: 5, resetsAt: 123000 }]);
    assert.equal(account.at, 2000);
    const known = rateLimitResetCredits?.availableCount === 0;
    assert.deepEqual(account.resets, known ? { left: 0, total: null } : null);
    assert.equal(account.resetQuery.state, known ? 'ready' : 'unavailable');
    const meter = new UsageMeter('codex');
    meter.apply({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 80 } } } });
    assert.equal(meter.codexAccount(account), true);
    assert.equal(meter.snapshot().limits[0].percent, 5);
    assert.equal(meter.snapshot().limitsAt, 2000);
  }
  assert.equal(accountResult(null).resets, null);
  assert.equal(accountResult({ rateLimits: { primary: { usedPercent: 'bad' } } }).limits, undefined);
});

test('an account response delayed past a newer rollout keeps the request observation time', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const meter = new UsageMeter('codex');
  const result = await fakeRead(t, 'limits', { onUsage() {
    t.mock.timers.tick(1000);
    meter.apply({ type: 'event_msg', timestamp: new Date().toISOString(), payload: {
      type: 'token_count', info: null, rate_limits: { primary: { used_percent: 24, window_minutes: 300 } },
    } });
  } });
  assert.equal(result.at, 100000);
  meter.codexAccount(result);
  assert.equal(meter.snapshot().limitsAt, 101000);
  assert.equal(meter.snapshot().limits[0].percent, 24, 'the late response cannot roll back live limits');
});

test('valid limits without reset credits keep the existing 30-second account cadence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let reads = 0;
  const meter = new UsageMeter('codex');
  const service = new CodexAccountUsage({ scope: async () => null, read: async () => accountResult({
    rateLimits: { primary: { usedPercent: ++reads, windowDurationMins: 300 } },
  }) });
  t.after(() => service.dispose());
  service.watch(options, value => meter.codexAccount(value));
  await flush();
  for (let i = 1; i <= 6; i++) {
    assert.equal(reads, i);
    assert.equal(meter.snapshot().limits[0].percent, i);
    assert.equal(meter.snapshot().resets, null);
    assert.equal(meter.snapshot().resetQuery.reason, 'unsupported');
    t.mock.timers.tick(29999); await flush(); assert.equal(reads, i);
    t.mock.timers.tick(1); await flush();
  }
  assert.equal(reads, 7);
});

test('null/old protocol is unsupported, never zero; errors, exits, malformed and oversized output are bounded', async t => {
  for (const mode of ['null', 'old']) {
    const value = await fakeRead(t, mode);
    assert.equal(value.resets, null); assert.equal(value.resetQuery.state, 'unavailable');
  }
  for (const mode of ['error', 'exit', 'invalid', 'null-message', 'overflow']) {
    const value = await fakeRead(t, mode);
    assert.equal(value.resets, null); assert.equal(value.resetQuery.state, 'error');
  }
  assert.throws(() => accountResult({ rateLimitResetCredits: { availableCount: Number.MAX_SAFE_INTEGER + 1 } }));
  assert.throws(() => accountResult({ rateLimitResetCredits: { availableCount: -1 } }));
});

test('hung read times out without blocking the event loop, kills its child, and abort/spawn errors settle', async t => {
  let responding = false;
  const timer = setTimeout(() => { responding = true; }, 20);
  const value = await fakeRead(t, 'hang', { timeout: 1000 }); clearTimeout(timer);
  assert.equal(responding, true);
  assert.equal(value.resetQuery.reason, 'timeout');
  const abort = new AbortController(); abort.abort();
  assert.equal((await readCodexAccount({ executable: 'fake', signal: abort.signal, launch: () => assert.fail('aborted') })).resetQuery.reason, 'cancelled');
  assert.equal((await readCodexAccount({ executable: 'fake', launch: () => { throw new Error('private'); } })).resetQuery.state, 'error');
  assert.equal((await readCodexAccount({ executable: path.join(os.tmpdir(), 'nonexistent-agentrix-codex-binary'), env: {} })).resetQuery.state, 'error');
  const running = new AbortController();
  const cancelled = await fakeRead(t, 'hang', { signal: running.signal, onUsage: () => setImmediate(() => running.abort()) });
  assert.equal(cancelled.resetQuery.reason, 'cancelled');
  assert.equal((await fakeRead(t, 'hang', { timeout: 1000, defaultStop: true })).resetQuery.reason, 'timeout', 'production cleanup also terminates the owned child');
});

test('cache deduplicates, isolates home/account environment and drops stale/disposed results', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const pending = [], values = [], other = [];
  const service = new CodexAccountUsage({ scope: async () => null, read: opts => new Promise(resolve => pending.push({ opts, resolve })) });
  const first = service.watch(options, value => values.push(value));
  const second = service.watch(options, value => other.push(value));
  await flush(); assert.equal(pending.length, 1);
  assert.equal(other[0].resetQuery.state, 'loading');
  pending[0].resolve(ready(2)); await flush();
  assert.equal(values.at(-1).resets.left, 2); assert.equal(other.at(-1).resets.left, 2);
  service.watch({ ...options, codexHome: options.codexHome + '-other' }, () => {});
  service.watch({ ...options, env: { HOME: 'another-account-environment' } }, () => {});
  await flush(); assert.equal(pending.length, 3);
  first.refresh(); t.mock.timers.tick(5000); await flush(); const beforeReset = pending.at(-1);
  // Split terminal output of an actual reset cancels the read begun before it.
  first.output('\x1b[32mUsage re'); first.output('set. You have 0 resets left.\x1b[0m');
  await flush(); assert.equal(beforeReset.opts.signal.aborted, true);
  const inFlight = pending.length;
  beforeReset.resolve(ready(2)); await flush();
  t.mock.timers.tick(4999); await flush(); assert.equal(pending.length, inFlight);
  t.mock.timers.tick(1); await flush(); pending.at(-1).resolve(ready(0)); await flush();
  assert.equal(values.at(-1).resets.left, 0);
  second.dispose(); first.refresh(); t.mock.timers.tick(5000); await flush();
  const stale = pending.at(-1), previousLength = values.length;
  first.dispose(); assert.equal(stale.opts.signal.aborted, true);
  stale.resolve(ready(2)); await flush(); assert.equal(values.length, previousLength);
  service.dispose(); assert.equal(service.entries.size, 0);
});

test('remote, custom provider and ambiguous override scopes never query the local account', async () => {
  const service = new CodexAccountUsage({ scope: async () => null, read: () => assert.fail('must not query') });
  for (const [overrides, reason] of [[{ remote: true }, 'remote'], [{ provider: 'relay' }, 'provider'], [{ provider: null }, 'scope'], [{ command: '-c', accountLaunch: undefined }, 'scope'], [{ accountLaunch: 'unavailable' }, 'scope']]) {
    let value;
    service.watch({ ...options, ...overrides }, result => { value = result; });
    assert.equal(value.resets, null); assert.equal(value.resetQuery.reason, reason);
  }
  assert.notEqual(usageScope(options).key, usageScope({ ...options, cwd: options.cwd + '-project' }).key);
  assert.notEqual(usageScope(options).key, usageScope({ ...options, env: {} }).key, 'independent account environments never share cached counts');
  assert.equal(usageScope({ ...options, codexHome: '.codex-local' }).home, path.join(options.cwd, '.codex-local'), 'relative homes follow the actual agent cwd');
  assert.equal(usageScope({ ...options, recordedCwd: path.join(options.cwd, 'different') }).reason, 'scope');
  assert.equal(usageScope({ ...options, recordedCwd: null }).reason, 'scope', 'missing recorded cwd cannot prove the project-config scope');
  const homeEnv = process.platform === 'win32' ? { USERPROFILE: options.codexHome } : { HOME: options.codexHome };
  assert.equal(usageScope({ ...options, codexHome: undefined, env: homeEnv }).home, path.join(options.codexHome, '.codex'));
  for (const command of ['-m', '--model', '-c', '--config', '-p', '--profile', '-C', '--cd', '--oss', '--local-provider']) {
    assert.equal(usageScope({ ...options, command, accountLaunch: undefined }).reason, 'scope', 'a first-word-only event cannot prove the remaining arguments safe');
  }
  await flush(); service.dispose();
});

test('config boundary accepts explicit official config and refuses provider redefinitions, selected profiles and account routes', () => {
  for (const config of ['', 'model = "gpt-test"\nmodel_reasoning_effort = "high"',
    'model_provider = "openai" # actual provider\n', "'model_provider' = 'openai'",
    '[model_providers.relay]\nbase_url = "https://example.invalid"',
    'developer_instructions = """\nmodel_provider = "relay"\n"""\nmodel_provider = "openai"']) assert.equal(configScope(config), null, config);
  for (const config of ['model_provider = "relay"', '[model_providers.openai]\nbase_url = "https://example.invalid"',
    'model_providers."openai".base_url = "https://example.invalid"', 'model_providers = { openai = {} }',
    '"model_providers"."op\\u0065nai".base_url = "https://example.invalid"']) assert.equal(configScope(config), 'provider', config);
  for (const config of ['profile = "work"', "profile = 'work'\n[profiles.work]\nmodel_provider = 'openai'",
    'chatgpt_base_url = "https://example.invalid"', '[auth]\nmode = "external"',
    '"model_provider" junk = "relay"', 'developer_instructions = "unterminated',
    'developer_instructions = """\nunterminated']) assert.equal(configScope(config), 'scope', config);
});

test('home and ancestor project config checks stay read-only, bounded, and stop custom routes before an account read', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scope-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'account'), cwd = path.join(root, 'project', 'nested');
  fs.mkdirSync(home); fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), 'model_provider = "openai"');
  const opts = { ...options, codexHome: home, cwd };
  assert.equal(await accountConfigScope(opts), null);
  const projectConfig = path.join(root, 'project', '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(projectConfig)); fs.writeFileSync(projectConfig, 'model_provider = "relay"');
  assert.equal(await accountConfigScope(opts), 'provider');
  const values = [], service = new CodexAccountUsage({ read: () => assert.fail('custom project config must not query an official account') });
  const finished = new Promise(resolve => service.watch(opts, value => { values.push(value); if (value.resetQuery.state !== 'loading') resolve(); }));
  await finished; service.dispose();
  assert.equal(values.at(-1).resets, null); assert.equal(values.at(-1).resetQuery.reason, 'provider');
  fs.writeFileSync(projectConfig, 'x'.repeat(256 * 1024 + 1));
  assert.equal(await accountConfigScope(opts), 'scope');
  fs.writeFileSync(projectConfig, 'model_provider = "openai"');
  assert.equal(await accountConfigScope({ ...opts, env: { OPENAI_BASE_URL: 'https://example.invalid' } }), 'scope');
  fs.writeFileSync(path.join(home, 'managed_config.toml'), 'do not read');
  assert.equal(await accountConfigScope(opts), 'scope', 'managed credential routing is declined from presence alone');
});

test('proven benign complete flags reach watch preflight and a ready count; later account flags never query', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-benign-flags-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.toml'), 'model_provider = "openai"');
  const env = {}, baseline = accountEnvironment(env); let reads = 0;
  const service = new CodexAccountUsage({ read: async () => { ++reads; return ready(2); } });
  t.after(() => service.dispose());
  const watch = args => new Promise(resolve => {
    service.watch({ ...options, env, cwd: root, recordedCwd: root, codexHome: root,
      command: args[0], accountLaunch: accountLaunch(args, env, baseline) }, value => {
      if (value.resetQuery.state !== 'loading') resolve(value);
    });
  });
  assert.equal((await watch(['-m', 'gpt-test', '-c', 'model_reasoning_effort=high', '-c', 'service_tier="fast"'])).resets.left, 2);
  assert.equal(reads, 1);
  const unsafe = await watch(['-m', 'gpt-test', '-c', 'model_reasoning_effort=high', '--profile', 'work']);
  assert.equal(unsafe.resetQuery.reason, 'scope'); assert.equal(unsafe.resets, null); assert.equal(reads, 1);
});

test('failed refreshes back off, retry automatically and recover without an endless loading status', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let calls = 0; const values = [];
  const service = new CodexAccountUsage({ scope: async () => null, read: async () => ++calls < 5
    ? { resets: null, resetQuery: { state: 'error', reason: 'query' } } : ready(2) });
  const watch = service.watch(options, value => values.push(value)); await flush();
  assert.equal(values.at(-1).resetQuery.state, 'error');
  for (const delay of [60000, 120000, 240000, 300000]) {
    const before = calls;
    watch.refresh();
    t.mock.timers.tick(delay - 1); await flush(); assert.equal(calls, before, 'active requests preserve failure back-off');
    t.mock.timers.tick(1); await flush(); assert.equal(calls, before + 1);
  }
  assert.equal(values.at(-1).resets.left, 2);
  t.mock.timers.tick(29999); await flush(); assert.equal(calls, 5);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 6, 'a successful read restores the normal cadence');
  service.dispose();
});

test('active reads share the scope throttle, coalesce in flight and read aged token counts only after 30 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const pending = [];
  const service = new CodexAccountUsage({ scope: async () => null, interval: 120000, read: opts => new Promise(resolve => pending.push({ opts, resolve, at: Date.now() })) });
  t.after(() => service.dispose());
  const first = service.watch(options, () => {}), second = service.watch(options, () => {});
  await flush(); pending[0].resolve(ready(2)); await flush();
  t.mock.timers.tick(30000); first.refresh(30000); second.refresh(30000); await flush();
  assert.equal(pending.length, 1);
  t.mock.timers.tick(1); first.refresh(30000); second.refresh(30000); await flush();
  assert.equal(pending.length, 2);
  for (let i = 0; i < 10; i++) { first.refresh(); second.refresh(); }
  t.mock.timers.tick(6000); await flush();
  assert.equal(pending.length, 2, 'forced refreshes never overlap the running read');
  assert.equal(pending[1].opts.signal.aborted, false, 'turn notifications coalesce without cancelling the read');
  pending[1].resolve(ready(1)); await flush(); assert.equal(pending.length, 3);
  pending[2].resolve(ready(0)); await flush();
  first.refresh(); second.refresh();
  t.mock.timers.tick(4999); await flush(); assert.equal(pending.length, 3);
  t.mock.timers.tick(1); await flush(); assert.equal(pending.length, 4);
  assert.ok(pending.slice(1).every((read, i) => read.at - pending[i].at >= 5000));
  first.dispose(); second.dispose();
  assert.equal(pending[3].opts.signal.aborted, true);
  pending[3].resolve(ready(0)); await flush();
  t.mock.timers.tick(120000); await flush(); assert.equal(pending.length, 4);
});

test('main lifecycle follows recorded provider, replaces sessions safely and never uses local queries for SSH/Claude', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  // Exercise the real lifecycle functions without loading Electron or a PTY.
  const functions = main.slice(main.indexOf('function startUsage('), main.indexOf('let claudeAccountTimer ='));
  const notes = main.slice(main.indexOf('function noteSettings('), main.indexOf('// A skill step names the skill;'));
  const pending = [], sessions = new Map();
  const service = new CodexAccountUsage({ scope: async () => null, read: opts => new Promise(resolve => pending.push({ opts, resolve })) });
  const { startUsage, stopUsageAccount, noteSettings } = vm.runInNewContext(`${functions}\n${notes}\n({ startUsage, stopUsageAccount, noteSettings })`, {
    UsageMeter, callsOf: () => null, codexAccounts: service, sessions, process, scheduleState() {}, scheduleUsageRollover() {},
    localClaudeMeters: () => [], disposeClaudeAccounts() {},
    codexProvider: async () => id => id, claudeProvider: async () => 'Anthropic', claudeConfigDir: () => '', refreshClaudeAccounts() {},
    agentSettings: previous => previous,
  });
  const s = { terminalId: 'test', codexActive: true, agent: 'codex', usageEnv: {} };
  sessions.set(s.terminalId, s);
  const project = { path: os.tmpdir(), kind: 'local' };
  const event = { codexHome: options.codexHome, accountLaunch: 'model-only-v1', command: '-m' };
  const meta = model_provider => ({ type: 'session_meta', payload: { model_provider, cwd: project.path } });
  startUsage(project, s, event); await flush();
  assert.equal(pending.length, 0, 'wait for the actual recorded provider, without querying the wrong account');
  noteSettings(s, 'codex', meta('relay')); await flush();
  assert.equal(pending.length, 0); assert.equal(s.usage.snapshot().resetQuery.reason, 'provider');
  noteSettings(s, 'codex', meta('openai')); await flush();
  assert.equal(pending.length, 1);
  const previous = pending[0];
  startUsage(project, s, event); noteSettings(s, 'codex', meta('openai')); await flush();
  assert.equal(previous.opts.signal.aborted, true);
  assert.equal(pending.length, 1, 'rebinding a scope waits for its cancelled read to settle');
  previous.resolve(ready(2)); await flush(); t.mock.timers.tick(5000); await flush();
  pending[1].resolve(ready(0)); await flush();
  assert.equal(s.usage.snapshot().resets.left, 0);
  s.usageAccount.refresh(); t.mock.timers.tick(5000); await flush(); const exiting = pending[2];
  stopUsageAccount(s); assert.equal(exiting.opts.signal.aborted, true);
  exiting.resolve(ready(2)); await flush(); assert.equal(s.usage.snapshot().resetQuery.state, 'loading');
  startUsage({ ...project, kind: 'ssh' }, s, event); noteSettings(s, 'codex', meta('openai')); await flush();
  assert.equal(s.usage.snapshot().resetQuery.reason, 'remote');
  s.agent = 'claude'; startUsage(project, s, event); await flush();
  assert.equal(pending.length, 3); assert.equal(s.usage.agent, 'claude');
  s.agent = 'codex'; const proofEvent = { ...event };
  startUsage(project, s, proofEvent); noteSettings(s, 'codex', meta('openai')); await flush();
  t.mock.timers.tick(5000); await flush();
  pending.at(-1).resolve(ready(2)); await flush();
  assert.equal(s.usage.snapshot().resets.left, 2);
  proofEvent.accountLaunch = 'unavailable'; s.bindUsageAccount(); await flush();
  assert.equal(s.usage.snapshot().resets, null); assert.equal(s.usage.snapshot().resetQuery.reason, 'scope');
  assert.equal(pending.length, 4, 'a scope-proof change invalidates the cached count without querying');
  proofEvent.accountLaunch = 'model-only-v1'; s.bindUsageAccount(); await flush();
  t.mock.timers.tick(5000); await flush();
  const untrustedLate = pending.at(-1);
  noteSettings(s, 'codex', meta('relay')); assert.equal(untrustedLate.opts.signal.aborted, true);
  untrustedLate.resolve(ready(2)); await flush();
  assert.equal(s.usage.snapshot().resets, null); assert.equal(s.usage.snapshot().resetQuery.reason, 'provider');
  stopUsageAccount(s); service.dispose();
});
