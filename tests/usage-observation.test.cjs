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
  assert.equal(next.limitsById.subscription.primary.usedPercent, 0); assert.equal(next.limitsById.subscription.primary.windowDurationMins, 300);
  assert.equal(next.limitsById.subscription.primary.resetsAtMs, null, 'the reading’s own unknown reset time, not the earlier one');
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

const codexOnly = { cli: { claude: { status: 'missing' }, codex: { status: 'ok' } }, env: { CODEX_HOME: path.join(os.tmpdir(), 'fake-refresh-home') } };
const failedRead = { resets: null, resetQuery: { state: 'error', reason: 'timeout' }, connection: { kind: 'unknown', observedAt: null } };

test('a focused Codex read past the interval returns its own refresh: each read is a new reading, none is aborted, a failed one keeps the last', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const signals = []; let fail = false;
  const codex = new CodexAccountUsage({ scope: async () => null, read: async ({ signal }) => {
    signals.push(signal); return fail ? failedRead : account(Date.now(), signals.length * 10);
  } });
  t.after(() => codex.dispose());
  const accounts = createProjectAccounts({ codex, readClaude: async () => ({}) });
  const p = { id: 'p', path: path.join(os.tmpdir(), 'fake-refresh-project') }, shown = [];
  for (let read = 0; read < 6; read++) {
    shown.push((await accounts.read(p, codexOnly)).codex.limits[0].percent); t.mock.timers.tick(codex.interval + 1);
  }
  assert.deepEqual(shown, [10, 20, 30, 40, 50, 60], 'a read past the interval is the refresh it started, not the value before it');
  assert.equal(signals.length, 6); assert.ok(signals.every(signal => !signal.aborted), 'no refresh is aborted by its own read');
  fail = true;
  const held = (await accounts.read(p, codexOnly)).codex;
  assert.equal(signals.length, 7); assert.equal(held.limits[0].percent, 60); assert.equal(held.connection.kind, 'subscription');
  assert.equal(held.resetQuery.state, 'error', 'the failed read is said, the last reading stays');
});

test('a session watching a scope the pane also reads keeps only what it was given, never the pane’s retained reading', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const pending = [];
  const codex = new CodexAccountUsage({ scope: async () => null, read: () => new Promise(resolve => pending.push(resolve)) });
  t.after(() => codex.dispose());
  const accounts = createProjectAccounts({ codex, readClaude: async () => ({}) });
  const p = { id: 'p', path: path.join(os.tmpdir(), 'fake-shared-project') };
  const first = accounts.read(p, codexOnly); await flush(); pending.shift()(account(Date.now(), 42));
  assert.equal((await first).codex.limits[0].percent, 42);
  t.mock.timers.tick(codex.interval + 1);
  const values = [], session = codex.watch({ cwd: p.path, env: codexOnly.env, accountLaunch: 'project-open-v1' }, value => values.push(value));
  await flush();
  assert.deepEqual(values.map(value => [value.resetQuery.state, value.limits]), [['loading', undefined]], 'an expired reading does not flash in the session');
  const focused = accounts.read(p, codexOnly); await flush();
  pending.shift()(failedRead);
  assert.equal((await focused).codex.limits[0].percent, 42, 'the pane keeps its last reading through the failed read');
  assert.equal(values.at(-1).limits, undefined); assert.equal(values.at(-1).resetQuery.state, 'error');
  // What the session itself was given stays through its own loading and failed reads.
  t.mock.timers.tick(60001); await flush(); pending.shift()(account(Date.now(), 55)); await flush();
  assert.equal(values.at(-1).limits[0].percent, 55);
  t.mock.timers.tick(codex.interval + 1); await flush();
  assert.equal(values.at(-1).resetQuery.state, 'loading'); assert.equal(values.at(-1).limits[0].percent, 55); assert.equal(values.at(-1).resets.left, 2);
  pending.shift()(failedRead); await flush();
  assert.equal(values.at(-1).resetQuery.state, 'error'); assert.equal(values.at(-1).resets.left, 2);
  session.dispose();
});

test('quota read for one account is never merged into or kept for another, and another reader’s reading replaces the last whole', () => {
  const { mergeLimits } = require('../electron/features/codex-app-server/account.cjs');
  const a = subscriptionLimits(account(1000, 42, 'account-a'), 'codex-account', 120000, 1001);
  const weekly = { ...account(2000, 7, 'account-b'), limits: [{ minutes: 10080, percent: 7, resetsAt: null }], resets: null, resetQuery: { state: 'unavailable' } };
  const b = retainLimits(a, subscriptionLimits(weekly, 'codex-account', 120000, 2001));
  assert.deepEqual(Object.keys(b.limitsById.subscription), ['secondary'], 'account A’s 5-hour window is not account B’s');
  assert.equal(b.resetCredits, null, 'nor are its reset credits');
  const unread = subscriptionLimits({ ...failedRead, connection: connection(2000, 'account-b') }, 'codex-account', 120000, 2001);
  assert.deepEqual(retainLimits(a, unread).limitsById, {}, 'a failed first read of account B does not show account A’s quota');
  const sameAccount = subscriptionLimits({ ...failedRead, connection: connection(2000, 'account-a') }, 'codex-account', 120000, 2001);
  assert.equal(retainLimits(a, sameAccount).limitsById.subscription.primary.usedPercent, 42, 'the same account’s failed read keeps it');
  const update = (percent, at, previous) => mergeLimits(previous, { rateLimits: { primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: 5 } } }, 'session-1', at);
  const first = update(10, 3000), second = update(20, 4000, first);
  assert.equal(retainLimits(a, first).limitsById.codex.primary.usedPercent, 10, 'a newer session reading replaces the account read');
  assert.equal(retainLimits(first, second).limitsById.codex.primary.usedPercent, 20, 'a session’s later reading replaces its first');
  assert.equal(retainLimits(first, second).state, 'ready');
  const restarted = retainLimits(second, mergeLimits(undefined, { rateLimits: { secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 9 } } }, 'session-2', 5000));
  assert.deepEqual(Object.keys(restarted.limitsById.codex), ['secondary'], 'another session’s reading is not completed from this one’s');
  // Codex account/updated: the app-server's own word that the account changed.
  const invalidated = { scopeId: 'session-1', billingRoute: 'unknown', observedAtMs: 6000, state: 'unavailable', limitsById: {}, resetCredits: null, ordinaryUsageAllowed: null, source: 'codex-app-server' };
  assert.deepEqual(retainLimits(second, invalidated).limitsById, {}, 'an account change drops the quota read before it');
  assert.deepEqual(retainLimits(a, invalidated).limitsById, {});
  assert.equal(retainLimits(second, { ...invalidated, observedAtMs: null, state: 'error' }).limitsById.codex.primary.usedPercent, 20, 'an undated failure is no such signal');
  const after = retainLimits(retainLimits(second, invalidated), update(1, 7000));
  assert.deepEqual(after.limitsById.codex.primary, { usedPercent: 1, windowDurationMins: 300, resetsAtMs: 5000 }); assert.equal(after.state, 'ready');
});

test('a held session reading is not shown under another account: sign-out and sign-in without identity, and an identity lost to a session', async t => {
  const session = (at, percent) => ({ scopeId: 'session-1', billingRoute: 'unknown', observedAtMs: at, state: 'ready', resetCredits: null, ordinaryUsageAllowed: null, source: 'codex-app-server',
    limitsById: { codex: { primary: { usedPercent: percent, windowDurationMins: 300, resetsAtMs: 9000 } } } });
  const unnamed = (at, kind = 'subscription') => ({ kind, observedAt: at, source: 'codex-app-server account/read', active: false });
  const f = facade(t);
  // Account A, signed out, account B: the router still holds A's last session reading.
  f.set({ codex: unnamed(1000) }, { codex: session(1500, 42) });
  assert.equal((await f.native.usage('p')).agents.codex.limits.limitsById.codex.primary.usedPercent, 42);
  f.set({ codex: unnamed(2000, 'none') }, { codex: session(1500, 42) });
  assert.equal((await f.native.usage('p')).agents.codex.limits, null);
  f.set({ codex: unnamed(3000) }, { codex: session(1500, 42) });
  assert.equal((await f.native.usage('p')).agents.codex.limits, null, 'the reading from before the sign-out is not the new account’s');
  assert.equal((await f.native.usage('p')).agents.codex.limits, null, 'nor on any later read');
  f.set({ codex: unnamed(3000) }, { codex: session(3500, 5) });
  assert.equal((await f.native.usage('p')).agents.codex.limits.limitsById.codex.primary.usedPercent, 5, 'a reading after the sign-in is');
  // Account A named by the account read, then a running session that cannot name it, then account B named.
  f.set({ codex: connection(1000, 'account-a') }, { codex: session(1500, 42) });
  assert.equal((await f.native.usage('q')).agents.codex.limits.limitsById.codex.primary.usedPercent, 42);
  f.set({ codex: unnamed(2000) }, { codex: session(1500, 42) });
  assert.equal((await f.native.usage('q')).agents.codex.limits.limitsById.codex.primary.usedPercent, 42, 'the same login kind without a name is no change');
  f.set({ codex: connection(3000, 'account-b') }, { codex: session(1500, 42) });
  assert.equal((await f.native.usage('q')).agents.codex.limits, null, 'the name last established is compared with the new one');
  const own = subscriptionLimits(account(3000, 8, 'account-b'), 'codex-account', 120000, 3001);
  f.set({ codex: connection(3000, 'account-b') }, { codex: own });
  assert.equal((await f.native.usage('q')).agents.codex.limits.limitsById.subscription.primary.usedPercent, 8, 'the new account’s own read shows at once');
});

test('a newer percent takes its own reset time: an unknown one replaces the passed one', () => {
  const first = subscriptionLimits(account(), 'offline', 120000, 1001);
  const zero = { ...first, observedAtMs: 2000, resetCredits: null, limitsById: { subscription: { primary: { usedPercent: 0, resetsAtMs: null, windowDurationMins: null }, secondary: { usedPercent: null, resetsAtMs: 7000, windowDurationMins: 10080 } } } };
  const next = retainLimits(first, zero);
  assert.deepEqual(next.limitsById.subscription.primary, { usedPercent: 0, resetsAtMs: null, windowDurationMins: 300 }, 'the old reset time is not this reading’s');
  assert.equal(next.limitsById.subscription.secondary, undefined, 'a reset time without a percent is not a reading');
  assert.equal(next.resetCredits.availableCount, 2);
});

test('a Claude account removed from a whole config ends the old subscription; an empty or unreadable config says nothing', async t => {
  const { readClaudeAccountCache } = require('../electron/features/agents/agent-usage.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-fake-signout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.claude.json'), state = { numStartups: 3, cachedUsageUtilization: { fetchedAtMs: 123, utilization: { five_hour: { utilization: 25 } } } };
  const accounts = createProjectAccounts({ codex: { interval: 0 }, readClaude: readClaudeAccountCache });
  const read = async text => { fs.writeFileSync(file, text); return (await accounts.read({ id: 'p', path: 'fake' }, { cli, env: { CLAUDE_CONFIG_DIR: root } })).claude; };
  const signedIn = JSON.stringify({ ...state, oauthAccount: { accountUuid: 'fake-identity', billingType: 'stripe_subscription' } });
  assert.equal((await read(signedIn)).limits[0].percent, 25);
  for (const unreadable of [signedIn.slice(0, 40), '', '{}', '[]', 'null']) {
    const held = await read(unreadable);
    assert.equal(held.connection.kind, 'subscription', `${JSON.stringify(unreadable)} is no sign-out`); assert.equal(held.limits[0].percent, 25);
  }
  const removed = await read(JSON.stringify(state));
  assert.equal(removed.connection.kind, 'unknown', 'the account whose key was removed is no longer shown'); assert.equal(removed.limits, undefined);
  assert.ok(Number.isFinite(removed.connection.observedAt));
  assert.equal((await read(JSON.stringify({ ...state, oauthAccount: null }))).connection.kind, 'none', 'a nulled account is the explicit sign-out');
  // A CLI that never signed in reads the same as one whose key was removed: it does not end an API connection.
  const { retainConnection, accountChanged } = require('../electron/features/agents/usage-observation.cjs');
  const api = { kind: 'api', active: true, source: 'session', observedAt: 1 };
  assert.equal(retainConnection(api, removed.connection).kind, 'api');
  assert.equal(accountChanged(connection(1, 'another-name'), removed.connection), true, 'but it is a change from a named account');
});

test('retained observations are bounded: a removed project releases its Codex cache and the facade keeps only recent projects', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const codex = new CodexAccountUsage({ scope: async () => null, read: async () => account(Date.now()) });
  t.after(() => codex.dispose());
  const accounts = createProjectAccounts({ codex, readClaude: async () => ({}) });
  const project = id => ({ id, path: path.join(os.tmpdir(), `fake-bound-${id}`) });
  for (const id of ['a', 'b', 'c']) await accounts.read(project(id), codexOnly);
  await accounts.read({ ...project('twin'), path: project('a').path }, codexOnly);
  assert.equal(codex.entries.size, 3);
  accounts.close('b'); accounts.close('a'); t.mock.timers.tick(5001);
  await accounts.read(project('c'), codexOnly);
  assert.equal(codex.entries.size, 2, 'the removed project’s scope is released; one another open project reads is kept');
  accounts.close('twin'); accounts.close('c'); t.mock.timers.tick(5001);
  await accounts.read(project('d'), codexOnly);
  assert.equal(codex.entries.size, 1);
  const f = facade(t); await f.native.usage('first');
  f.set(new Error('offline timeout'));
  assert.equal((await f.native.usage('first')).agents.codex.limits.observedAtMs, 1000);
  for (let other = 0; other < 80; other++) await f.native.usage(`other-${other}`);
  assert.equal((await f.native.usage('first')).agents.codex.limits, null, 'a project not read for many others is no longer held');
});

// A connection main reads from a running session or terminal that cannot name its account.
const unnamedSession = (at, active = true) => ({ kind: 'subscription', source: 'codex-account-usage', observedAt: at, active });
// The account reader's answer: the account named at one time, its quota read just after.
const read = (scopeId, at, percent) => subscriptionLimits({ ...account(at, percent, scopeId), connection: connection(at - 1, scopeId) }, 'codex-account', 120000, at);
const shown = async (f, project) => { const codex = (await f.native.usage(project)).agents.codex; return [codex.connection.scopeId, codex.limits?.limitsById.subscription?.primary.usedPercent]; };

test('a connection that cannot name its account never outranks one that does: a sign-in to another account shows that account’s quota', async t => {
  const f = facade(t);
  // The reader names account A; then the owner signs into B while a terminal Codex runs, whose connection is dated at or after the reader’s.
  f.set({ codex: connection(999, 'account-a') }, { codex: read('account-a', 1000, 80) });
  assert.deepEqual(await shown(f, 'p'), ['account-a', 80]);
  f.set({ codex: unnamedSession(2000) }, { codex: read('account-b', 2000, 10) });
  assert.deepEqual(await shown(f, 'p'), ['account-b', 10], 'account B is named and its own quota shows, not account A’s 80%');
  assert.equal((await f.native.usage('p')).agents.codex.connection.active, true, 'the running session still says it is in use');
  // The unnamed connection was already seen under A, dated after the reader’s later naming of B.
  f.set({ codex: unnamedSession(1700) }, { codex: read('account-a', 1000, 80) });
  assert.deepEqual(await shown(f, 'q'), ['account-a', 80]);
  f.set({ codex: unnamedSession(1800) }, { codex: read('account-b', 1600, 10) });
  assert.deepEqual(await shown(f, 'q'), ['account-b', 10], 'an unnamed connection’s later date does not make the name it was shown under newer');
  // With no reader to name the account, the unnamed connection changes nothing that was named.
  f.set({ codex: unnamedSession(5000) }, { codex: read('account-b', 1600, 10) });
  assert.deepEqual(await shown(f, 'q'), ['account-b', 10]);
  f.set({ codex: unnamedSession(6000, false) });
  const idle = (await f.native.usage('q')).agents.codex;
  assert.equal(idle.connection.scopeId, 'account-b'); assert.equal(idle.connection.active, false); assert.equal(idle.limits.limitsById.subscription.primary.usedPercent, 10);
});

test('after Codex says the account changed, the reader’s newer reading replaces the session’s empty placeholder', async t => {
  const { createEventStream } = require('../electron/features/native-session/events.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-usage-placeholder-'));
  let stream, limits = {}, codex = connection(999, 'account-a');
  const runtime = { apiState: () => ({ status: 'no_key' }), usage: { summary: () => ({}) }, create(spec, emit) {
    stream = createEventStream(spec, emit); return { start: async () => {}, close: async () => {}, snapshot: () => ({ state: 'idle' }) };
  } };
  const native = createNativeSessions({ directory, claude: runtime, codex: runtime, resolveSpec: () => ({ projectId: 'p', terminalId: 't' }), emit() {},
    connections: async () => ({ codex }), usageInputs: async () => ({ cli, limits }) });
  t.after(async () => { await native.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await native.start('t', { agent: 'codex' });
  const session = (at, percent) => ({ scopeId: 'session-1', billingRoute: 'unknown', observedAtMs: at, state: 'ready', resetCredits: null, ordinaryUsageAllowed: null, source: 'codex-app-server',
    limitsById: { codex: { primary: { usedPercent: percent, windowDurationMins: 300, resetsAtMs: 9000 } } } });
  const percent = async () => { const value = (await native.usage('p')).agents.codex.limits; return [value?.state, Object.values(value?.limitsById || {})[0]?.primary.usedPercent]; };
  stream.publish('limits.updated', session(1000, 42));
  assert.deepEqual(await percent(), ['ready', 42]);
  // account/updated: the session’s dated placeholder with neither a billing route nor a quota.
  stream.publish('limits.updated', { ...session(2000), state: 'unavailable', limitsById: {} });
  limits = { codex: read('account-a', 1500, 40) };
  assert.deepEqual(await percent(), ['unavailable', undefined], 'a reading from before the change is not put back');
  limits = { codex: read('account-a', 3000, 10) };
  assert.deepEqual(await percent(), ['ready', 10], 'the reader’s reading after the change shows without waiting for the session’s next turn');
  assert.deepEqual(await percent(), ['ready', 10]);
  // The session’s own reading leads again once it has one, and a reader’s newer one on another route does not displace it.
  stream.publish('limits.updated', session(4000, 12));
  assert.deepEqual(await percent(), ['ready', 12]);
  limits = { codex: read('account-a', 5000, 11) };
  assert.deepEqual(await percent(), ['ready', 12]);
});
