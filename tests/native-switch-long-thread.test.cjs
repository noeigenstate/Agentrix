const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');

function fixture(t, mode, existingTerminal) {
  const lifetime = resources(t), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-switch-long-'));
  const spec = { owner: 'gui', agent: 'codex', projectId: 'p', terminalId: 't', runtimeSessionId: 'old-terminal', providerSessionId: 'same-thread', hasHistory: true,
    cwd: directory, env: { PATH: '', CODEX_HOME: directory, SYNTHETIC_CODEX_MODE: mode } };
  const source = { identity: {}, spec, path: 'terminal' }, events = [], fallback = [], activated = [];
  let live = existingTerminal ? [source] : [];
  const codex = createCodexRuntime({ resolveExecutable: async () => 'synthetic-only', spawnProcess: (_file, _args, options) =>
    lifetime.child(spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], options)) });
  const router = createRouter({ codex, claude: { apiState: () => ({ status: 'no_key' }) }, settings: { get: () => ({ codexView: 'native' }) },
    resolveSpec: () => ({ ...spec }), terminalSessions: () => live,
    observeTerminal: () => ({ state: 'idle', background: { known: true, count: 0 } }),
    activateNative(value) { activated.push(value); live = []; }, terminal(value, reason) { fallback.push({ spec: value, reason }); }, emit: event => events.push(event) });
  lifetime.defer('remove synthetic profile', () => fs.rmSync(directory, { recursive: true, force: true }));
  lifetime.defer('close router', () => router.close());
  return { router, source, events, fallback, activated, live: () => live };
}
for (const mode of ['long-large', 'resume-frame-limit']) test(`Codex resume ${mode} stays on app-server or fails without a terminal`, async t => {
  const f = fixture(t, mode, false);
  if (mode === 'long-large') {
    await f.router.start('t', { agent: 'codex', resume: true });
    assert.equal(f.router.snapshot('t').state, 'idle');
    assert.ok(Buffer.byteLength(JSON.stringify(f.router.snapshot('t'))) < 4 * 1024 * 1024);
    assert.ok(f.router.snapshot('t').events.some(event => event.providerSessionId === 'same-thread'));
  } else {
    await assert.rejects(f.router.start('t', { agent: 'codex', resume: true }), /app-server/);
    assert.equal(f.router.snapshot('t').state, 'failed');
  }
  assert.equal(f.fallback.length, 0); assert.equal(f.router.switchState('t'), null);
  assert.equal(f.events.some(event => event.type === 'turn.started' || event.type === 'input.receipt'), false);
});
test('a manually running Codex terminal is outside the switch coordinator', async t => {
  const f = fixture(t, 'long-large', true); f.router.reconcile();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.router.switchState('t'), null); assert.equal(f.activated.length, 0); assert.equal(f.live()[0], f.source);
});
