const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');

for (const [mode, expected, confirmed = true] of [['reset-unread', 2], ['reset-mid', 1], ['reset-consumed', 1], ['reset-unknown', 1], ['reset-repeat', 2], ['reset-notification', 2], ['reset-notification-delayed', 2], ['reset-unconfirmed', 1, false], ['reset-retry-disconnect', 2]]) {
  test(`${mode}: ${confirmed ? 'confirmed' : 'unconfirmed'} reset replays only a proved empty unconsumed turn, at most once`, async t => {
    const lifetime = resources(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-reset-runtime-')), log = path.join(root, 'wire');
    lifetime.defer('remove fake profile', () => fs.rmSync(root, { recursive: true, force: true }));
    const events = []; let resets = 0;
    const runtime = createCodexRuntime({ resolveExecutable: async () => 'fake-only',
      spawnProcess: (_file, _args, options) => lifetime.child(spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], options)),
      resetAtLimit: async () => { resets++; if (mode.endsWith('-delayed')) await new Promise(resolve => setTimeout(resolve, 40)); return { status: 'redeemed', outcome: 'reset', remaining: 1, confirmed }; },
      translate: (text, values) => text.replace('{n}', values?.n),
    }).create({ owner: 'gui', cwd: root, env: { PATH: '', CODEX_HOME: root, SYNTHETIC_CODEX_MODE: mode, SYNTHETIC_CODEX_LOG: log } }, event => events.push(event));
    lifetime.defer('close runtime', () => runtime.close());
    const image = 'data:image/png;base64,c3ludGhldGlj';
    await runtime.start(); await runtime.send({ clientMessageId: 'one-input', text: 'Do this exactly once', images: [image] });
    const settled = () => mode === 'reset-retry-disconnect' ? events.some(event => event.type === 'input.receipt' && event.payload.status === 'unknown')
      : events.filter(event => event.type === 'turn.completed').length >= expected;
    for (let i = 0; i < 200 && !settled(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(settled());
    await new Promise(resolve => setTimeout(resolve, 100));
    const requests = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const turns = requests.filter(row => row.method === 'turn/start' && row.params.threadId);
    assert.equal(turns.length, expected);
    assert.ok(turns.every(row => row.params.input[1]?.type === 'image' && row.params.input[1].url === image));
    assert.equal(resets, 1);
    const notice = events.filter(event => event.type === 'item.upsert' && event.payload.content.resetCredit);
    assert.equal(notice.filter(event => /还剩 1 次/.test(event.payload.content.text)).length, 1);
    if (mode === 'reset-retry-disconnect') assert.equal(events.findLast(event => event.type === 'input.receipt').payload.status, 'unknown');
  });
}

for (const failure of ['rejected', 'null']) test(`reset service returning ${failure} never reports a continuation failure without a replay`, async t => {
  const lifetime = resources(t), reset = Promise.withResolvers(), events = [];
  const runtime = createCodexRuntime({ resolveExecutable: async () => 'fake-only',
    spawnProcess: (_file, _args, options) => lifetime.child(spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], options)),
    resetAtLimit: async () => { reset.resolve(); if (failure === 'rejected') throw new Error('reset service unavailable'); return null; },
  }).create({ owner: 'gui', cwd: os.tmpdir(), env: { PATH: '', SYNTHETIC_CODEX_MODE: 'reset-mid' } }, event => events.push(event));
  lifetime.defer('close runtime', () => runtime.close());
  await runtime.start();
  await runtime.send({ clientMessageId: 'first', text: 'one' });
  await reset.promise;
  assert.equal((await runtime.send({ clientMessageId: 'second', text: 'two' })).status, 'delivered');
  assert.equal(events.some(event => event.type === 'error' && event.payload.code === 'reset_continue_failed'), false);
  assert.equal(events.filter(event => event.type === 'turn.started' && event.payload.clientMessageId === 'first').length, 1);
});

for (const options of [{ owner: 'dispatch' }, { owner: 'gui', kind: 'ssh' }]) test(`reset never runs for ${JSON.stringify(options)}`, async t => {
  const lifetime = resources(t); let resets = 0;
  const runtime = createCodexRuntime({ resolveExecutable: async () => 'fake-only',
    launchRemote: async spec => ({ cwd: spec.cwd, child: lifetime.child(spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], {
      env: spec.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })) }),
    spawnProcess: (_file, _args, options) => lifetime.child(spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], options)),
    resetAtLimit: async () => { resets++; return { status: 'redeemed', confirmed: true }; },
  }).create({ ...options, cwd: os.tmpdir(), env: { PATH: '', CODEX_HOME: path.join(os.tmpdir(), 'fake-unused'), SYNTHETIC_CODEX_MODE: 'reset-unread' } }, () => {});
  lifetime.defer('close runtime', () => runtime.close());
  await runtime.start(); await runtime.send({ clientMessageId: 'input', text: 'one' });
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(resets, 0);
});
