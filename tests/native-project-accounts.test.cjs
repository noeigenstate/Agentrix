const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { CodexAccountUsage } = require('../electron/features/agents/codex-account-usage.cjs');
const { readClaudeAccountCache } = require('../electron/features/agents/agent-usage.cjs');
const { createProjectAccounts } = require('../electron/features/native-session/project-accounts.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));

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
