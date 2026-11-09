require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { subscriptionLimits } = require('../electron/features/native-session/usage.cjs');
const { retainLimits } = require('../electron/features/agents/usage-observation.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
const { createProjectAccounts } = require('../electron/features/native-session/project-accounts.cjs');
const { CodexAccountUsage } = require('../electron/features/agents/codex-account-usage.cjs');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const connection = (at = 1000, scopeId = 'account-a', kind = 'subscription') => ({ kind, observedAt: at, scopeId, source: 'offline', active: false });
const account = (at = 1000, percent = 42, scopeId = 'account-a') => ({ at, source: 'offline', connection: connection(at, scopeId), limits: [{ minutes: 300, percent, resetsAt: 1500 }], resets: { left: 2 }, resetQuery: { state: 'ready', at } });
const cli = { claude: { status: 'ok' }, codex: { status: 'missing' } };

test('Claude focused cache preserves its last observation across a partial write, focus changes and recovery', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let value = account();
  const accounts = createProjectAccounts({ codex: { interval: 100 }, readClaude: async () => value });
  const options = { cli, env: { HOME: 'fake-home-a' } }, p = { id: 'p', path: 'fake' };
  assert.equal((await accounts.read(p, options)).claude.limits[0].percent, 42);
  value = { connection: { kind: 'unknown', observedAt: null } }; t.mock.timers.tick(101);
  const held = (await accounts.read(p, options)).claude;
  assert.equal(held.connection.kind, 'subscription'); assert.equal(held.limits[0].percent, 42); assert.equal(held.at, 1000);
  await accounts.read({ id: 'q', path: 'other' }, options);
  assert.equal((await accounts.read(p, options)).claude.at, 1000);
  value = account(2000, 0); t.mock.timers.tick(101);
  assert.equal((await accounts.read(p, options)).claude.limits[0].percent, 0);
  value = { connection: connection(3000, 'account-b') }; t.mock.timers.tick(101);
  assert.equal((await accounts.read(p, options)).claude.limits, undefined, 'a real account change clears the old allowance');
  assert.equal((await accounts.read(p, { ...options, env: { HOME: 'fake-home-b' } })).claude.connection.scopeId, 'account-b');
  accounts.close();
});

test('Codex loading, timeout and 429 retain dated observations, including a later focused rebind', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const pending = [], values = [];
  const service = new CodexAccountUsage({ interval: 10000, scope: async () => null, read: () => new Promise(resolve => pending.push(resolve)) });
  t.after(() => service.dispose());
  const options = { env: {}, cwd: os.tmpdir(), codexHome: path.join(os.tmpdir(), 'fake-observation-home'), accountLaunch: 'project-open-v1', retainCache: true };
  const watch = service.watch(options, value => values.push(value)); await flush();
  assert.equal(values.at(-1).limits, undefined, 'the first unknown remains unknown');
  pending.shift()(account()); await flush();
  for (const reason of ['timeout', 'http-429']) {
    t.mock.timers.tick(300000); await flush();
    assert.equal(values.at(-1).limits[0].percent, 42, 'loading must not clear numeric usage');
    pending.shift()({ resetQuery: { state: 'error', reason }, connection: { kind: 'unknown', observedAt: null } }); await flush();
    assert.equal(values.at(-1).connection.kind, 'subscription'); assert.equal(values.at(-1).at, 1000);
    assert.equal(values.at(-1).resets.left, 2);
  }
  watch.dispose(); t.mock.timers.tick(600000); await flush();
  const rebound = service.watch(options, value => values.push(value)); await flush();
  assert.equal(values.at(-1).limits[0].percent, 42, 'expiry and focus changes do not erase the last observation');
  pending.shift()(account(3000, 0)); await flush();
  assert.equal(values.at(-1).limits[0].percent, 0); assert.equal(values.at(-1).at, 3000);
  rebound.dispose();
});

function facade(t, remote = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-usage-observation-'));
  const forbidden = () => assert.fail('no API, credential read or provider process is allowed');
  let connections = { claude: connection(), codex: connection() }, limits = { claude: subscriptionLimits(account(), 'claude', 120000, 1001), codex: subscriptionLimits(account(), 'codex', 120000, 1001) };
  const native = createNativeSessions({ directory,
    validateProject: () => ({ kind: remote ? 'ssh' : 'local' }),
    claude: { apiState: () => ({ status: 'no_key' }), usage: { summary: () => ({}) }, credentials: { status: () => ({ saved: false }), get: forbidden }, create: forbidden },
    codex: { create: forbidden }, resolveSpec: forbidden, emit: forbidden,
    connections: async () => { if (connections instanceof Error) throw connections; return typeof connections === 'function' ? connections() : connections; },
    usageInputs: async () => { assert.equal(remote, false, 'SSH must not read local accounts'); return { cli, limits }; } });
  t.after(async () => { await native.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { native, set: (nextConnections, nextLimits = {}) => { connections = nextConnections; limits = nextLimits; } };
}
for (const agent of ['claude', 'codex']) test(`${agent} native usage retains observations through restart placeholders and read failures, but accepts logout and account change`, async t => {
  const f = facade(t); await f.native.usage('p');
  for (const value of [{ [agent]: { kind: 'none', observedAt: null, active: false } }, { [agent]: { kind: 'unknown', observedAt: null } }, new Error('offline timeout')]) {
    f.set(value); const held = (await f.native.usage('p')).agents[agent];
    assert.equal(held.connection.kind, 'subscription'); assert.equal(held.connection.observedAt, 1000);
    assert.equal(held.limits.limitsById.subscription.primary.usedPercent, 42); assert.equal(held.limits.observedAtMs, 1000);
  }
  assert.equal((await f.native.usage('another-project')).agents[agent].limits, null, 'projects never borrow each other\'s observations');
  f.set({ [agent]: { kind: 'none', observedAt: null } });
  assert.equal((await f.native.usage('never-observed')).agents[agent].connection.kind, 'unknown');
  f.set({ [agent]: connection(2000, 'account-b') });
  assert.equal((await f.native.usage('p')).agents[agent].limits, null, 'new account cannot show the old account\'s allowance');
  f.set({ [agent]: connection(3000, 'account-b', 'none') });
  assert.equal((await f.native.usage('p')).agents[agent].connection.kind, 'none', 'observed logout replaces login');
  f.set({ [agent]: connection(500, 'account-a') });
  assert.equal((await f.native.usage('p')).agents[agent].connection.kind, 'none', 'late observations cannot revive an old account');
});

test('sparse native limits retain numeric fields and their time through transient status, then accept observed zero', () => {
  const first = subscriptionLimits(account(), 'offline', 120000, 1001);
  const failed = { ...first, observedAtMs: null, limitsById: {}, resetCredits: null, state: 'error' };
  const held = retainLimits(first, failed);
  assert.equal(held.observedAtMs, 1000); assert.equal(held.resetCredits.availableCount, 2);
  assert.equal(retainLimits(held, { ...failed, billingRoute: 'unknown' }).limitsById.subscription.primary.usedPercent, 42);
  const sparse = { ...first, observedAtMs: 2000, limitsById: { subscription: { primary: { usedPercent: 0, resetsAtMs: null, windowDurationMins: null } } }, resetCredits: null };
  const next = retainLimits(held, sparse);
  assert.equal(next.limitsById.subscription.primary.usedPercent, 0); assert.equal(next.limitsById.subscription.primary.resetsAtMs, 1500);
});

test('Claude cache account identity is opaque and changes without reading any credential file', async t => {
  const { readClaudeAccountCache } = require('../electron/features/agents/agent-usage.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-fake-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.claude.json');
  const write = accountUuid => fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid, billingType: 'stripe_subscription' } }));
  write('fake-identity-a'); const first = await readClaudeAccountCache({ CLAUDE_CONFIG_DIR: root });
  assert.equal((await readClaudeAccountCache({ CLAUDE_CONFIG_DIR: root })).connection.scopeId, first.connection.scopeId);
  write('fake-identity-b'); assert.notEqual((await readClaudeAccountCache({ CLAUDE_CONFIG_DIR: root })).connection.scopeId, first.connection.scopeId);
  assert.doesNotMatch(JSON.stringify(first), /fake-identity|oauthAccount/);
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: null }));
  assert.equal((await readClaudeAccountCache({ CLAUDE_CONFIG_DIR: root })).connection.kind, 'none');
});

test('overlapping usage reads cannot roll a newer account observation backward', async t => {
  const f = facade(t), pending = [];
  f.set(() => new Promise(resolve => pending.push(resolve)));
  const first = f.native.usage('p'); await flush();
  const second = f.native.usage('p'); await flush();
  pending[1]({ claude: connection(3000, 'account-b') }); await second;
  pending[0]({ claude: connection(1000, 'account-a') });
  assert.equal((await first).agents.claude.connection.scopeId, 'account-b');
  const slow = f.native.usage('p'); await flush();
  const fast = f.native.usage('p'); await flush();
  pending[3]({ claude: connection(5000, 'account-b') }); await fast;
  pending[2]({ claude: connection(6000, 'account-c') });
  assert.equal((await slow).agents.claude.connection.scopeId, 'account-c', 'actual observation time outranks request start order');
});

test('observed account logout supersedes a stale terminal login without exposing host-only metadata', async t => {
  const f = facade(t); await f.native.usage('p');
  const signedOut = { ...account(), connection: connection(3000, 'signed-out', 'none') };
  const limits = subscriptionLimits(signedOut, 'claude', 120000, 3000);
  assert.deepEqual(limits.limitsById, {}); assert.equal(limits.resetCredits, null);
  assert.doesNotMatch(JSON.stringify(structuredClone(limits)), /accountConnection/);
  f.set({ claude: { ...connection(1000), active: true } }, { claude: limits });
  const observed = (await f.native.usage('p')).agents.claude;
  assert.equal(observed.connection.kind, 'none'); assert.equal(observed.connection.observedAt, 3000); assert.equal(observed.limits, null);
});

test('router retains live limits across empty events and lets a newer account read replace older native data', async t => {
  const { createRouter } = require('../electron/features/native-session/router.cjs');
  const { createEventStream } = require('../electron/features/native-session/events.cjs');
  let stream;
  const runtime = { apiState: () => ({ status: 'ready' }), usage: { summary: () => ({}) }, create(spec, emit) {
    stream = createEventStream(spec, emit); return { start: async () => {}, close: async () => {}, snapshot: () => ({ state: 'idle' }) };
  } };
  const router = createRouter({ claude: runtime, codex: runtime, settings: { get: () => ({ claudePath: 'api-only' }) }, resolveSpec: () => ({ projectId: 'p', terminalId: 't' }), emit() {} });
  t.after(() => router.close()); await router.start('t', { agent: 'claude' });
  const first = subscriptionLimits(account(), 'fixture', 120000, 1000);
  stream.publish('limits.updated', first);
  stream.publish('limits.updated', { ...first, observedAtMs: null, state: 'error', limitsById: {}, resetCredits: null });
  const held = router.usage({}, 'p').agents.claude.limits;
  assert.equal(held.observedAtMs, 1000); assert.equal(held.limitsById.subscription.primary.usedPercent, 42);
  const newer = subscriptionLimits(account(3000, 0), 'fixture', 120000, 3000);
  assert.equal(router.usage({ limits: { claude: newer } }, 'p').agents.claude.limits.limitsById.subscription.primary.usedPercent, 0);
});

test('SSH Codex retains only its remote observations and never asks for local account inputs', async t => {
  const f = facade(t, true); await f.native.usage('remote');
  f.set(new Error('offline SSH read failed'));
  const usage = await f.native.usage('remote');
  assert.equal(usage.agents.codex.connection.kind, 'subscription'); assert.equal(usage.agents.codex.connection.observedAt, 1000);
  assert.equal(usage.agents.claude.connection.kind, 'none'); assert.equal(usage.agents.claude.limits, null);
});
