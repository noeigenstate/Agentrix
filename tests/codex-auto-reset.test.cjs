const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { CodexAccountUsage, consumeCodexResetCredit, usageAtLimit } = require('../electron/features/agents/codex-account-usage.cjs');
const { createSettings } = require('../electron/features/native-session/settings.cjs');

function fixture(t, mode = 'ready') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-reset-')), wire = path.join(root, 'wire.jsonl'), children = [];
  const env = { SystemRoot: process.env.SystemRoot, PATH: '', HOME: root, USERPROFILE: root, PROGRAMDATA: path.join(root, 'programdata'),
    CODEX_HOME: root, FAKE_RESET_WIRE: wire, FAKE_RESET_STATE: path.join(root, 'state.json'), FAKE_RESET_MODE: mode };
  const options = { cwd: root, codexHome: root, env, provider: 'openai', accountLaunch: 'model-only-v1', owner: 'gui' };
  const consume = options => consumeCodexResetCredit({ ...options, rpcFactory: require('../electron/features/codex-app-server/rpc.cjs').createRpc,
    scopeCheck: async () => null, executable: 'offline-only', launch: (_file, _args, spec) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-reset-client.cjs')], spec); children.push(child); return child;
  }, stop: child => { child?.stdin.end(); } });
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const rows = () => { try { return fs.readFileSync(wire, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  const service = options => new CodexAccountUsage({ scope: async () => null, consume, ...options });
  return { root, options, consume, rows, service };
}

test('owner reset at a limit consumes one earliest-expiring credit, confirms recovery and audits without account identity', async t => {
  const f = fixture(t), audit = [], service = f.service({ audit: value => audit.push(value) }); t.after(() => service.dispose());
  const result = await service.resetAtLimit(f.options, { atLimit: true });
  assert.equal(result.status, 'redeemed'); assert.equal(result.confirmed, true); assert.equal(result.remaining, 1);
  const consume = f.rows().filter(row => row.method.endsWith('/consume'));
  assert.equal(f.rows().find(row => row.method === 'initialize').params.clientInfo.name, 'agentrix_usage');
  assert.equal(consume.length, 1); assert.equal(consume[0].params.creditId, 'soon');
  assert.match(consume[0].params.idempotencyKey, /^[\da-f-]{36}$/);
  assert.equal(audit.length, 1); assert.doesNotMatch(JSON.stringify(audit), /offline-shared-account/);
  assert.equal((await service.resetAtLimit(f.options, { atLimit: true })).status, 'unavailable');
  assert.equal(f.rows().filter(row => row.method.endsWith('/consume')).length, 1);
});

for (const mode of ['empty', 'unknown', 'allowed', 'api', 'signed-out']) test(`reset never consumes when the fresh account says ${mode}`, async t => {
  const f = fixture(t, mode), service = f.service(); t.after(() => service.dispose());
  await service.resetAtLimit(f.options, { atLimit: true });
  assert.equal(f.rows().filter(row => row.method.endsWith('/consume')).length, 0);
});

test('disabled, worker, SSH and custom-provider paths launch no reset client', async t => {
  const f = fixture(t); let calls = 0;
  const service = f.service({ consume: async () => { calls++; return {}; } }); t.after(() => service.dispose());
  for (const [options, evidence] of [[f.options, { atLimit: false }], [f.options, { atLimit: true, enabled: false }],
    [{ ...f.options, owner: 'dispatch' }, { atLimit: true }], [{ ...f.options, remote: true }, { atLimit: true }],
    [{ ...f.options, provider: 'custom' }, { atLimit: true }]]) await service.resetAtLimit(options, evidence);
  assert.equal(calls, 0);
});

for (const mode of ['still-limited', 'error', 'declined']) test(`after ${mode}, the same account cannot consume a second reset within cooldown`, async t => {
  const f = fixture(t, mode), service = f.service(); t.after(() => service.dispose());
  const result = await service.resetAtLimit(f.options, { atLimit: true });
  if (mode === 'still-limited') { assert.equal(result.status, 'redeemed'); assert.equal(result.confirmed, false); }
  await service.resetAtLimit(f.options, { atLimit: true });
  assert.equal(f.rows().filter(row => row.method.endsWith('/consume')).length, 1);
});

test('two concurrent projects on the same backend account consume only once', async t => {
  const f = fixture(t, 'still-limited'), service = f.service(); t.after(() => service.dispose());
  const cwd = path.join(f.root, 'second'); fs.mkdirSync(cwd);
  const results = await Promise.all([service.resetAtLimit(f.options, { atLimit: true }), service.resetAtLimit({ ...f.options, cwd }, { atLimit: true })]);
  assert.equal(results.filter(result => result.status === 'redeemed').length, 1);
  assert.equal(f.rows().filter(row => row.method.endsWith('/consume')).length, 1);
});

test('a retried logical reset preserves its idempotency key and the fake backend applies it once', async t => {
  const f = fixture(t, 'still-limited'), claim = () => 'offline-one-logical-attempt';
  assert.equal((await f.consume({ ...f.options, claim })).outcome, 'reset');
  assert.equal((await f.consume({ ...f.options, claim })).outcome, 'alreadyRedeemed');
  assert.equal(JSON.parse(fs.readFileSync(f.options.env.FAKE_RESET_STATE, 'utf8')).uses, 1);
  assert.deepEqual(f.rows().filter(row => row.method.endsWith('/consume')).map(row => row.params.idempotencyKey), [claim(), claim()]);
});

test('persisted cooldown survives an app restart and contains no account identity', async t => {
  const f = fixture(t, 'still-limited'); let stored;
  const resetStorage = { read: () => stored, write: value => { stored = structuredClone(value); } };
  const first = f.service({ resetStorage }); await first.resetAtLimit(f.options, { atLimit: true }); first.dispose();
  const second = f.service({ resetStorage }); t.after(() => second.dispose());
  assert.equal((await second.resetAtLimit(f.options, { atLimit: true })).status, 'cooldown');
  assert.equal(f.rows().filter(row => row.method.endsWith('/consume')).length, 1);
  assert.doesNotMatch(JSON.stringify(stored), /offline-shared-account/);
});

test('an unconfirmed reset stays frozen for the limited period even after the minimum cooldown', async t => {
  const f = fixture(t, 'still-limited'); let now = Date.now();
  const service = f.service({ now: () => now }); t.after(() => service.dispose());
  await service.resetAtLimit(f.options, { atLimit: true }); now += 31 * 60000;
  assert.equal((await service.resetAtLimit(f.options, { atLimit: true })).status, 'cooldown');
  assert.equal(f.rows().filter(row => row.method.endsWith('/consume')).length, 1);
});

test('disposing the service aborts only its pending reset client without consuming', { timeout: 5000 }, async t => {
  const f = fixture(t, 'hang'), service = f.service();
  const task = service.resetAtLimit(f.options, { atLimit: true });
  for (let i = 0; i < 100 && !f.rows().some(row => row.method === 'account/read'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(f.rows().some(row => row.method === 'account/read'));
  service.dispose(); assert.equal((await task).status, 'unavailable');
  assert.equal(f.rows().filter(row => row.method.endsWith('/consume')).length, 0);
});

test('legacy settings retain existing routes and budget while auto-reset defaults on and persists off', t => {
  const f = fixture(t), file = path.join(f.root, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ claudePath: 'terminal-only', codexView: 'terminal', monthlyBudgetUsd: 12 }));
  const settings = createSettings(file); assert.equal(settings.get().codexAutoReset, false, 'the owner turns this on; a reset cannot be undone'); assert.equal(settings.get().monthlyBudgetUsd, 12);
  settings.set({ codexAutoReset: false }); assert.equal(createSettings(file).get().codexAutoReset, false);
  assert.throws(() => settings.set({ codexAutoReset: 1 }));
});

test('throughput and depleted-credit errors are not included-usage limit evidence', () => {
  assert.equal(usageAtLimit({ rateLimits: { rateLimitReachedType: 'workspace_owner_credits_depleted' } }), false);
  assert.equal(usageAtLimit({ ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: 'rate_limit_reached' } }), false);
  assert.equal(usageAtLimit({ rateLimits: { rateLimitReachedType: 'workspace_member_usage_limit_reached' } }), true);
});
