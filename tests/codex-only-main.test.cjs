const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createSettings, validSettings } = require('../electron/features/native-session/settings.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { createEventStream } = require('../electron/features/native-session/events.cjs');
const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

test('legacy codexView is ignored without rewriting preferences; later saves omit it and new patches reject it', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-codex-setting-')), file = path.join(directory, 'settings.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const old = JSON.stringify({ claudePath: 'api-only', codexView: 'terminal', monthlyBudgetUsd: 13 }); fs.writeFileSync(file, old);
  const settings = createSettings(file);
  assert.deepEqual(settings.get(), { claudePath: 'api-only', monthlyBudgetUsd: 13, codexAutoReset: false });
  assert.equal(fs.readFileSync(file, 'utf8'), old); assert.equal(fs.readdirSync(directory).length, 1, 'legacy preferences are not corrupt');
  assert.equal(validSettings({ codexView: 'terminal' }, true), false);
  settings.set({ monthlyBudgetUsd: 14 }); assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file)), 'codexView'), false);
  const retiredOnly = JSON.stringify({ codexView: 'terminal' }); fs.writeFileSync(file, retiredOnly);
  assert.deepEqual(createSettings(file).get(), { claudePath: 'api-then-terminal', monthlyBudgetUsd: null, codexAutoReset: false });
  assert.equal(fs.readFileSync(file, 'utf8'), retiredOnly); assert.equal(fs.readdirSync(directory).length, 1);
});

test('startup restores a legacy local Codex terminal using its thread while SSH and normal shells stay terminals', async () => {
  for (const kind of ['local', 'ssh']) for (const agent of ['codex', 'claude']) for (const active of [true, false]) {
    const calls = [], saved = { agent, codex: active, threadId: 'same-thread', cwd: '/synthetic/subfolder' };
    const context = { store: { findTerminal: () => ({ project: { kind }, record: { restore: saved } }) },
      restorePlans: new Map([['t', {}]]), startupErrors: new Map(), broadcast() {}, startTerminal: id => calls.push(['terminal', id]),
      nativeSessions: { start: async (id, options) => calls.push(['app-server', id, options]) } };
    vm.createContext(context); vm.runInContext(main.slice(main.indexOf('function restoreTerminal('), main.indexOf('function startTerminal(')), context);
    context.restoreTerminal('t'); await new Promise(resolve => setImmediate(resolve));
    if (kind === 'local' && agent === 'codex' && active) {
      assert.equal(calls[0][0], 'app-server'); assert.equal(calls[0][2].resume, true); assert.equal(context.restorePlans.size, 0);
    } else assert.equal(calls[0][0], 'terminal');
  }
  let shell = false;
  const context = { store: { findTerminal: () => ({ project: { kind: 'local' }, record: { restore: { agent: 'claude', nativeTransport: 'claude-sdk' } } }) },
    nativeSessions: null, startTerminal: () => { shell = true; }, restorePlans: new Map() };
  vm.createContext(context); vm.runInContext(main.slice(main.indexOf('function restoreTerminal('), main.indexOf('function startTerminal(')), context);
  context.restoreTerminal('claude'); assert.equal(shell, true, 'an unavailable native composition keeps Claude terminal recovery');
});

test('the launcher sends every local Codex mode to app-server and keeps SSH refusal', async () => {
  const handlers = new Map(), calls = [], saved = {};
  let kind = 'local';
  const context = { handle: (name, value) => handlers.set(name, value), findProject: () => ({ kind }), launchPlans: new Map(), restorePlans: new Map(),
    nativeSessions: { start: async (id, options) => calls.push([id, options]) }, folderOf: () => '/synthetic', folderHistory: async () => ({ codex: { id: 'same-thread' } }),
    store: { setRestore: (_id, value) => Object.assign(saved, value) }, broadcast() {}, startTerminal: () => assert.fail('no local Codex TUI') };
  vm.createContext(context); vm.runInContext(main.slice(main.indexOf("  handle('agent:launch',"), main.indexOf('  registerNativeIpc({ handle });')), context);
  for (const mode of ['new', 'continue']) await handlers.get('agent:launch')('t', 'codex', mode);
  assert.equal(calls.length, 2); assert.equal(calls[1][1].resume, true); assert.equal(saved.threadId, 'same-thread');
  await assert.rejects(handlers.get('agent:launch')('t', 'codex', 'native'), /Unsupported agent session mode/);
  kind = 'ssh'; await assert.rejects(handlers.get('agent:launch')('t', 'codex', 'new'), /SSH/);
});

for (const [code, words] of [['codex_cli_required', '未找到 Codex'], ['unsupported_codex_version', '版本过低'], ['rpc_timeout', '连接失败']]) {
  test(`Codex ${code} gives a readable failure and the existing start action retries without a TUI`, async t => {
    let failed = true, closes = 0;
    const router = createRouter({ claude: { apiState: () => ({ status: 'no_key' }) }, settings: { get: () => ({}) },
      resolveSpec: id => ({ owner: 'gui', projectId: 'p', terminalId: id, agent: 'codex' }), terminal: () => assert.fail('no TUI fallback'), emit() {},
      codex: { create(spec, emit) { const stream = createEventStream(spec, emit); let state = 'stopped';
        return { snapshot: () => ({ ...stream.snapshot(), state }), async start() { if (failed) throw Object.assign(new Error(code), { code });
          state = 'idle'; stream.publish('session.state', { state, reason: null }); }, close() { closes++; state = 'stopped'; } }; } } });
    t.after(() => router.close()); await assert.rejects(router.start('t', { agent: 'codex' }), new RegExp(words));
    assert.equal(router.snapshot('t').state, 'failed'); assert.ok(closes > 0); assert.equal(router.switchState('t'), null);
    failed = false; await router.start('t', { agent: 'codex' }); assert.equal(router.snapshot('t').state, 'idle');
  });
}
