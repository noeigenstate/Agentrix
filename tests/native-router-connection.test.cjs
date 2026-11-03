const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const { accountConnection } = require('../electron/features/codex-app-server/account.cjs');

for (const [mode, status, cli, expected] of [
  ['api-only', 'invalid', 'ok', null], ['api-then-terminal', 'invalid', 'ok', 'terminal'],
  ['terminal-only', 'ok', 'ok', 'terminal'], ['api-only', 'ok', 'missing', null],
  ['api-then-terminal', 'ok', 'too_old', 'terminal'], ['api-then-terminal', 'ok', 'ok', 'api'],
]) test(`connection routing follows ${mode}, key ${status}, CLI ${cli}`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-conn-route-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ claudePath: mode, codexView: 'native', monthlyBudgetUsd: null }));
  let tests = 0; const handlers = new Map();
  const native = createNativeSessions({ directory, claude: { testConnection: async () => { tests++; return { checkedAt: 1, key: { status, detail: null, latencyMs: 1 }, models: null, cli: { status: cli, version: null, required: '2.1.317' } }; },
    apiState: () => ({ status: 'ready' }), usage: { summary: () => ({}) } },
    connections: async () => ({ claude: { kind: 'api', source: 'init', observedAt: 1 } }) });
  native.register((name, handler) => handlers.set(name, handler)); assert.equal(tests, 0);
  assert.throws(() => handlers.get('native:test-connection')({ key: 'renderer-injection' }));
  const result = await handlers.get('native:test-connection')(); assert.equal(result.path, expected); assert.equal(tests, 1);
  const usage = await native.usage(); assert.equal(usage.agents.claude.connection.kind, 'api'); assert.equal(usage.agents.codex.connection.kind, 'none');
});
test('account/read sanitizes API and ChatGPT modes without retaining personal fields', () => {
  for (const [type, kind] of [['apiKey', 'api'], ['chatgpt', 'subscription'], ['unexpected', 'unknown']]) {
    const value = accountConnection({ account: { type, email: 'private-fixture', token: 'private-fixture' } }, 123);
    assert.equal(value.kind, kind); assert.ok(!JSON.stringify(value).includes('private-fixture'));
  }
});
test('main connections use init and account evidence and discard a late result after terminal exit', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  let finish;
  const claude = { terminalId: 'c', agent: 'claude', codexActive: true, status: 'codex', nativeStructured: true, nativeRuntimeSessionId: 'r' };
  const codex = { terminalId: 'x', agent: 'codex', codexActive: true, status: 'codex', nativeStructured: true,
    nativeReadConnection: () => new Promise(resolve => { finish = resolve; }) };
  const context = { sessions: new Map([['c', claude], ['x', codex]]), claudeRuntime: { connection: () => ({ kind: 'api', source: 'init', observedAt: 1 }) } };
  vm.createContext(context); vm.runInContext(source.slice(source.indexOf('async function readNativeConnections('), source.indexOf('async function initializeNativeSessions(')), context);
  const pending = context.readNativeConnections(); codex.codexActive = false; finish({ kind: 'subscription', source: 'account/read', observedAt: 2 });
  const result = await pending; assert.equal(result.claude.kind, 'api'); assert.equal(result.codex.kind, 'none');
  codex.codexActive = true;
  const delayed = context.readNativeConnections(); claude.codexActive = false;
  finish({ kind: 'subscription', source: 'account/read', observedAt: 2 });
  assert.equal((await delayed).claude.kind, 'none'); claude.codexActive = true;
  codex.nativeStructured = false; codex.codexActive = true;
  assert.equal((await context.readNativeConnections()).codex.kind, 'unknown');
  for (const kind of ['api', 'subscription']) {
    codex.terminalAccount = { connection: { kind }, at: 3 };
    assert.equal((await context.readNativeConnections()).codex.kind, kind);
  }
  claude.nativeStructured = false; assert.equal((await context.readNativeConnections()).claude.kind, 'subscription');
  claude.codexActive = false; assert.equal((await context.readNativeConnections()).claude.kind, 'none');
});

test('unavailable native usage still reports actual terminal connections', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8'), handlers = new Map();
  const context = { readNativeConnections: async () => ({ claude: { kind: 'subscription', source: 'terminal', observedAt: 1 }, codex: { kind: 'none', source: null, observedAt: null } }) };
  vm.createContext(context); vm.runInContext(source.slice(source.indexOf('function registerUnavailableNative('), source.indexOf('function registerIpc()')), context);
  context.registerUnavailableNative((name, handler) => handlers.set(name, handler));
  const usage = await handlers.get('native:usage')();
  assert.equal(usage.agents.claude.connection.kind, 'subscription'); assert.equal(usage.agents.codex.connection.kind, 'none');
  assert.throws(() => handlers.get('native:test-connection')({}), /无效/);
});
