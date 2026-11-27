const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { CodexAccountUsage } = require('../electron/features/agents/codex-account-usage.cjs');
const { readClaudeAccountCache } = require('../electron/features/agents/agent-usage.cjs');
const { ClaudeAccountUsage, createClaudeReadSchedule } = require('../electron/features/agents/claude-account-usage.cjs');
const { createProjectAccounts } = require('../electron/features/native-session/project-accounts.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a loading account watcher and a hung reader cannot block the next read', async () => {
  const subscribed = Promise.withResolvers(), ready = { connection: { kind: 'subscription' }, resetQuery: { state: 'ready' } };
  let expire, watches = 0, disposed = 0;
  const codex = { entries: new Map([['scope', { readPromise: new Promise(() => {}) }]]), releaseCache() {},
    watch(_options, changed) {
      changed(++watches === 1 ? { resetQuery: { state: 'loading' } } : ready);
      subscribed.resolve();
      return { key: 'scope', dispose() { ++disposed; } };
    } };
  const accounts = createProjectAccounts({ codex, timers: { setTimeout(fn) { expire = fn; }, clearTimeout() {} } });
  const project = { id: 'project', path: os.tmpdir() }, options = { env: {}, cli: { claude: { status: 'missing' }, codex: { status: 'ok' } } };
  const first = accounts.read(project, options);
  await subscribed.promise;
  expire();
  assert.equal((await first).codex.connection.kind, 'none');
  codex.entries.clear();
  assert.equal((await accounts.read(project, options)).codex, ready);
  assert.equal(disposed, 2);
});

test('focused account reads share fresh cache, isolate projects, and never poll in the background', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const reads = [];
  const codex = new CodexAccountUsage({ scope: async () => null, read: async options => {
    reads.push(options.cwd);
    return { connection: { kind: 'subscription', active: false }, limits: [{ minutes: 300, percent: reads.length }], at: Date.now(), resetQuery: { state: 'unavailable' } };
  } });
  t.after(() => codex.dispose());
  const accounts = createProjectAccounts({ codex, readClaude: async () => ({ connection: { kind: 'unknown', active: false } }) });
  const p = { id: 'p', path: path.join(os.tmpdir(), 'fake-p') }, q = { id: 'q', path: path.join(os.tmpdir(), 'fake-q') };
  const options = { env: { CODEX_HOME: path.join(os.tmpdir(), 'fake-only-home') }, cli: { claude: { status: 'ok' }, codex: { status: 'ok' } } };
  assert.equal((await accounts.read(p, options)).codex.connection.kind, 'subscription');
  await accounts.read(q, options); await accounts.read(p, options);
  assert.deepEqual(reads, [p.path, q.path]);
  assert.equal(accounts.snapshot('q'), null);
  t.mock.timers.tick(60000); await flush();
  assert.equal(reads.length, 2, 'no account process without another focused usage request');
  await accounts.read(p, options); assert.equal(reads.length, 3);
  const remote = await accounts.read({ id: 'remote', kind: 'ssh' }, options);
  assert.equal(remote, null); assert.equal(reads.length, 3);
  accounts.close('p'); assert.equal(accounts.snapshot('p'), null);
});

test('Claude cache reports only explicit login evidence and cached numeric windows', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-fake-account-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { billingType: 'stripe_subscription', emailAddress: 'private@example.invalid' },
    cachedUsageUtilization: { fetchedAtMs: 123, utilization: { five_hour: { utilization: 25 }, seven_day: { utilization: 60 } } } }));
  const value = await readClaudeAccountCache({ CLAUDE_CONFIG_DIR: root });
  assert.equal(value.connection.kind, 'subscription'); assert.equal(value.connection.active, false);
  assert.deepEqual(value.limits.map(window => window.percent), [25, 60]);
  assert.doesNotMatch(JSON.stringify(value), /private@|oauthAccount/);
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { billingType: 'new-kind' } }));
  assert.equal((await readClaudeAccountCache({ CLAUDE_CONFIG_DIR: root })).connection.kind, 'unknown');
  fs.writeFileSync(file, '{}');
  assert.equal((await readClaudeAccountCache({ CLAUDE_CONFIG_DIR: root })).connection.kind, 'unknown');
});

test('a focus change aborts and drains the old account client before starting another scope', async t => {
  const pending = [];
  const codex = new CodexAccountUsage({ scope: async () => null, read: options => new Promise(resolve => pending.push({ options, resolve })) });
  t.after(() => codex.dispose());
  const accounts = createProjectAccounts({ codex, readClaude: async () => ({}) });
  const options = { env: { CODEX_HOME: path.join(os.tmpdir(), 'isolated-fake') }, cli: { claude: { status: 'ok' }, codex: { status: 'ok' } } };
  const first = accounts.read({ id: 'p', path: os.tmpdir() }, options); await flush();
  const second = accounts.read({ id: 'q', path: path.join(os.tmpdir(), 'q') }, options); await flush();
  assert.equal(pending[0].options.signal.aborted, true); assert.equal(pending.length, 1);
  pending[0].resolve({ limits: [{ minutes: 300, percent: 99 }], resetQuery: { state: 'ready' } });
  assert.equal(await first, null); await flush();
  assert.equal(pending.length, 2);
  pending[1].resolve({ connection: { kind: 'api' }, resetQuery: { state: 'unavailable' } });
  assert.equal((await second).codex.connection.kind, 'api');
  assert.equal(accounts.snapshot('p'), null);
});

test('opening a project returns Claude’s saved windows before a zero-turn refresh and respects Retry-After across projects', async () => {
  let now = 100000, gets = 0;
  const project = { id: 'one', path: 'fixture-one' }, another = { id: 'two', path: 'fixture-two' };
  const options = { env: {}, cli: { claude: { status: 'ok' }, codex: { status: 'missing' } } };
  const saved = { at: now - 1000, source: 'Claude Code', limits: [{ minutes: 300, percent: 20, resetsAt: 115000 }],
    connection: { kind: 'subscription', scopeId: 'opaque-account', observedAt: now } };
  const started = Promise.withResolvers(), reply = Promise.withResolvers();
  const accounts = createProjectAccounts({ codex: { interval: 30000 }, now: () => now, readClaude: async () => saved,
    readClaudeUsage: async ({ cwd, beforeRequest }) => {
      if (!beforeRequest()) return { state: 'skipped', reason: 'throttled' };
      gets++;
      started.resolve(cwd);
      return reply.promise;
    } });
  let first;
  const pending = accounts.read(project, { ...options, onCached: () => { first ??= accounts.snapshot(project.id).claude; } });
  assert.equal(await started.promise, project.path);
  assert.equal(first, saved);
  reply.resolve({ state: 'error', status: 429, retryAfterMs: 180000 });
  assert.equal((await pending).claude, saved);
  now += 120000;
  assert.deepEqual((await accounts.read(another, options)).claude.limits, saved.limits);
  assert.equal(gets, 1, 'opening other projects must respect the provider’s cooldown');
  now += 60000;
  await accounts.read(another, options);
  assert.equal(gets, 2);
});

test('Claude can show current quotas without a cached login or starting a conversation', async () => {
  const now = 100000, project = { id: 'p', path: 'fixture' };
  const limits = [{ minutes: 300, percent: 0, resetsAt: 200000 }, { minutes: 10080, percent: 37, resetsAt: 300000 }];
  const accounts = createProjectAccounts({ now: () => now, codex: { interval: 30000 }, readClaude: async () => ({ connection: { kind: 'unknown' } }),
    readClaudeUsage: async ({ beforeRequest }) => {
      assert.equal(beforeRequest(), true);
      return { state: 'ready', account: { at: now, source: 'Claude', limits } };
    } });
  const result = await accounts.read(project, { env: {}, cli: { claude: { status: 'ok' }, codex: { status: 'missing' } } });
  assert.equal(result.claude.connection.kind, 'subscription');
  assert.deepEqual(result.claude.limits, limits);
});

test('the focused pane and active local Claude poller share capped backoff and the server’s retry deadline', async t => {
  const project = { id: 'p', path: 'fixture' };
  const options = { env: {}, cli: { claude: { status: 'ok' }, codex: { status: 'missing' } } };
  let now = 100000, preflights = 0;
  const requested = [], held = Promise.withResolvers(), started = Promise.withResolvers();
  const busy = { state: 'error', status: 503 };
  const replies = [held.promise, { state: 'error', reason: 'query' }, busy, busy, busy,
    { ...busy, retryAfterMs: 0 }, { ...busy, retryAfterMs: 180000 }, { ...busy, retryAfterMs: 600000 },
    { state: 'ready', account: { at: 3000000, limits: [], source: 'Claude' } }, busy];
  const read = async ({ beforeRequest }, caller) => {
    preflights++;
    if (!beforeRequest()) return { state: 'skipped', reason: 'throttled' };
    requested.push(caller);
    started.resolve();
    return replies.shift();
  };
  const clock = () => now, schedule = createClaudeReadSchedule(clock);
  const accounts = createProjectAccounts({ now: clock, claudeSchedule: schedule, codex: { interval: 30000 },
    readClaude: async () => null, readClaudeUsage: request => read(request, 'pane') });
  const terminal = new ClaudeAccountUsage({ now: clock, schedule, read: request => read(request, 'terminal'),
    setTimeout() { return {}; }, clearTimeout() {} });
  t.after(() => { terminal.dispose(); accounts.close(); });
  const first = accounts.read(project, options);
  await started.promise;
  terminal.setActive(true);
  await terminal.poll();
  assert.deepEqual(requested, ['pane']);
  held.resolve(busy);
  await first;
  for (const [index, delay] of [60000, 120000, 240000, 300000, 300000, 60000, 180000, 600000].entries()) {
    now += delay - 1;
    const before = preflights;
    await Promise.all([accounts.read(project, options), terminal.poll()]);
    assert.equal(preflights, before, 'cooldown includes configuration and credential preflight');
    assert.equal(requested.length, index + 1);
    now++;
    if (index === 0 || index === 7) {
      await terminal.poll();
      await accounts.read(project, options);
      assert.equal(requested.at(-1), 'terminal');
    } else {
      await accounts.read(project, options);
      await terminal.poll();
      assert.equal(requested.at(-1), 'pane');
    }
    assert.equal(requested.length, index + 2);
  }
  assert.ok(terminal.account);
  now += 60000;
  await accounts.read(project, options);
  assert.equal(schedule.nextAt, now + 60000, 'a success resets the exponential backoff');
});

test('a null or thrown Claude result does not authorize reuse of a prior direct reading', async () => {
  let now = 100000;
  const saved = { at: now, limits: [{ minutes: 300, percent: 10 }] };
  const project = { id: 'p', path: 'fixture' };
  const options = { env: {}, cli: { claude: { status: 'ok' }, codex: { status: 'missing' } } };
  const accounts = createProjectAccounts({ now: () => now, codex: { interval: 30000 }, readClaude: async () => saved,
    readClaudeUsage: ({ beforeRequest }) => {
      if (now === 100000) {
        assert.equal(beforeRequest(), true);
        return { state: 'ready', account: { at: now + 1, source: 'Claude', limits: [{ minutes: 300, percent: 50 }] } };
      }
      if (now === 160000) return null;
      if (now === 280000) return { state: 'error', reason: 'timeout' };
      throw new Error('fixture read failure');
    } });
  assert.equal((await accounts.read(project, options)).claude.limits[0].percent, 50);
  for (const at of [160000, 160001, 220000, 280000]) {
    now = at;
    assert.equal((await accounts.read(project, options)).claude.limits[0].percent, 10);
  }
});
