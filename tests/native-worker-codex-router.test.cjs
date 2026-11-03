const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');

function fixture(t, mode) {
  const children = [], events = [], terminals = [];
  const codex = createCodexRuntime({ resolveExecutable: async () => mode === 'absent' ? null : 'synthetic-only', spawnProcess: (_file, _args, options) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], options); children.push(child); return child;
  } });
  const claude = { apiState: () => ({ status: 'no_key' }), usage: { summary: () => ({}) } };
  const router = createRouter({ codex, claude, settings: { get: () => ({ codexView: 'native', claudePath: 'api-only', monthlyBudgetUsd: null }) },
    resolveSpec: id => ({ projectId: 'p', terminalId: id, cwd: os.tmpdir(), env: { PATH: '', SYNTHETIC_CODEX_MODE: mode } }),
    terminal: async (spec, reason) => { terminals.push({ spec, reason }); await router.forget(spec.terminalId); }, emit: event => events.push(event) });
  t.after(async () => { await router.close(); await Promise.all(children.map(child => child.exitCode != null ? null : new Promise(resolve => child.once('exit', resolve)))); });
  return { router, events, terminals };
}

test('M11: an unknown Codex version with the required methods remains native with a visible notice', async t => {
  const f = fixture(t, 'unknown-version'); await f.router.start('t', { agent: 'codex' });
  assert.equal(f.terminals.length, 0); assert.equal(f.router.usage().agents.codex.path, 'native');
  assert.match(f.events.findLast(event => event.type === 'path.changed').payload.reason, /Codex 版本未经验证/);
});

for (const mode of ['missing-steer', 'absent']) test(`M11: ${mode} falls back before input and retains the reason after terminal disposal`, async t => {
  const f = fixture(t, mode); await f.router.start('t', { agent: 'codex' });
  assert.equal(f.terminals.length, 1); assert.equal(f.router.usage().agents.codex.path, 'terminal');
  const event = f.router.snapshot('t').events.findLast(event => event.type === 'path.changed');
  assert.equal(event.payload.selected, 'terminal'); assert.equal(event.payload.reason, mode === 'absent' ? '未找到 Codex 原生运行器，已切换到终端。' : 'Codex 原生连接不可用，已切换到终端。');
  assert.equal(f.events.some(event => event.type === 'turn.started'), false);
});
