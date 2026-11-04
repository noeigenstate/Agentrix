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
async function until(check) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('long-thread switch did not settle');
}
for (const mode of ['long-large', 'resume-frame-limit']) test(`I4 Codex terminal switch ${mode} preserves a working path, draft and unsent input`, async t => {
  const f = fixture(t, mode, true); f.router.reconcile();
  await until(() => f.router.switchState('t')?.phase === 'preparing');
  const draft = { version: 1, text: 'Retained draft', images: [], undelivered: [{ clientMessageId: 'not-yet-sent', text: 'Retained unsent input' }] };
  assert.equal(f.router.answer('t', 'old-terminal', 'handoff', { handoff: { changeId: f.router.switchState('t').changeId, draft } }).accepted, true);
  await until(() => f.router.switchState('t')?.phase === 'stable');
  const state = f.router.switchState('t');
  if (mode === 'long-large') {
    assert.equal(state.current, 'native'); assert.equal(f.activated.length, 1); assert.equal(f.activated[0].providerSessionId, 'same-thread');
    assert.deepEqual(f.router.snapshot('t').handoff.draft, draft);
    assert.ok(Buffer.byteLength(JSON.stringify(f.router.snapshot('t'))) < 4 * 1024 * 1024);
  } else {
    assert.equal(state.current, 'terminal'); assert.match(state.reason, /已保留原会话/); assert.equal(state.outcome, 'failed');
    assert.equal(f.live()[0], f.source); assert.equal(f.activated.length, 0);
  }
  assert.equal(f.events.some(e => e.type === 'turn.started' || e.type === 'turn.completed' || e.type === 'input.receipt'), false);
  f.router.observe('t'); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.activated.length, mode === 'long-large' ? 1 : 0);
});
test('ordinary Codex resume falls back to the same terminal thread on a non-history frame limit', async t => {
  const f = fixture(t, 'resume-frame-limit', false); await f.router.start('t', { agent: 'codex', resume: true });
  assert.equal(f.fallback.length, 1); assert.equal(f.fallback[0].spec.providerSessionId, 'same-thread');
  assert.equal(f.fallback[0].reason, 'Codex 原生连接不可用，已切换到终端。');
  assert.equal(f.router.has('t'), false);
  assert.equal(f.events.some(e => e.type === 'turn.started' || e.type === 'input.receipt'), false);
});
