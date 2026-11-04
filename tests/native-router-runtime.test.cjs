const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { choosePath } = require('../electron/features/native-session/routing.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { createSettings } = require('../electron/features/native-session/settings.cjs');
const { registerIpc } = require('../electron/features/native-session/ipc.cjs');
const { createEventStream } = require('../electron/features/native-session/events.cjs');
const { validEvent } = require('../electron/features/native-session/validate.cjs');
const { createIpcAdapter } = require('../electron/shared/ipc.cjs');
const { terminalPreparation, completeSwitch } = require('./fixtures/native-switch.cjs');

for (const setting of ['api-then-terminal', 'api-only', 'terminal-only']) test(`Claude routing obeys ${setting} for available and unavailable API`, () => {
  for (const status of ['ready', 'no_key', 'budget_exhausted', 'rate_limited', 'credits_exhausted', 'native_cli_required']) {
    const expected = setting === 'terminal-only' ? 'terminal' : status === 'ready' ? 'api' : setting === 'api-only' ? null : 'terminal';
    assert.equal(choosePath({ agent: 'claude', claudePath: setting, apiState: { status } }).path, expected);
  }
});
test('Codex native is default and terminal remains an explicit choice', () => {
  assert.equal(choosePath({ agent: 'codex' }).path, 'native'); assert.equal(choosePath({ agent: 'codex', codexView: 'terminal' }).path, 'terminal');
});
function fixture(config = {}) {
  const events = [], terminals = [], created = [], settings = { get: () => ({ claudePath: 'api-then-terminal', codexView: 'native', monthlyBudgetUsd: null, ...config }) };
  const claude = { apiState: () => ({ status: 'ready' }), usage: { summary: () => ({ month: '2026-11', todayUsdMicros: 0, monthUsdMicros: 0, estimated: true }) },
    credentials: { clear: () => ({ saved: false }) }, create(spec, emit) {
      let state = 'stopped';
      const stream = createEventStream(spec, event => { events.push(event); emit(event); }, () => 100);
      const runtime = { async start() { if (claude.fail) throw Object.assign(new Error(), { code: claude.fail }); state = 'idle'; stream.publish('session.state', { state, reason: null }); },
        resume() { return this.start(); }, send(input) { return input; }, interrupt() { return 'interrupted'; }, answer(id, answer) { return { id, answer }; },
        snapshot() { return { ...stream.snapshot(), state }; }, async close() { state = 'stopped'; } };
      created.push({ spec, runtime }); return runtime;
    } };
  const router = createRouter({ claude, codex: claude, settings, resolveSpec: (id, agent) => ({ projectId: 'p', terminalId: id, cwd: '/fake', agent }),
    prepareTerminal: terminalPreparation(spec => terminals.push([spec])), terminal: async (...args) => terminals.push(args), emit() {} });
  return { router, claude, terminals, created, settings, events };
}
test('native router owns session identity and rejects old runtime answers', async () => {
  const { router, created } = fixture(); const first = await router.start('t', { agent: 'codex' });
  await router.stop('t', first.runtimeSessionId); const second = await router.start('t', { agent: 'codex' });
  assert.notEqual(first.runtimeSessionId, second.runtimeSessionId); assert.throws(() => router.answer('t', first.runtimeSessionId, 'r', {}));
  assert.equal(created.length, 2); assert.equal(router.snapshot('t').runtimeSessionId, second.runtimeSessionId);
});
test('api-only does not fall back when native Claude is missing', async () => {
  const { router, claude, terminals } = fixture({ claudePath: 'api-only' }); claude.fail = 'native_cli_required';
  await assert.rejects(router.start('t', { agent: 'claude' })); assert.equal(terminals.length, 0);
});
test('missing native Claude falls back only under api-then-terminal', async () => {
  const { router, claude, terminals } = fixture(); claude.fail = 'native_cli_required';
  await router.start('t', { agent: 'claude' }); assert.equal(terminals.length, 1); assert.equal(terminals[0][1], 'native_cli_required');
  assert.equal(router.usage().agents.claude.path, 'terminal');
});
test('fallback at a message boundary never replays the submitted text', async () => {
  const { router, claude, terminals, created } = fixture(); const first = await router.start('t', { agent: 'claude' });
  claude.apiState = () => ({ status: 'budget_exhausted' });
  const receipt = await router.send('t', first.runtimeSessionId, { clientMessageId: 'message', text: 'must not replay' });
  assert.equal(receipt.status, 'rejected'); assert.equal(terminals.length, 0); assert.ok(!JSON.stringify(terminals).includes('must not replay'));
  assert.equal(created[0].runtime.snapshot().state, 'idle', 'the old path remains alive until handoff and readiness');
  await completeSwitch(router, 't'); assert.equal(terminals.length, 1); assert.equal(created[0].runtime.snapshot().state, 'stopped');
  assert.ok(router.snapshot('t').events.some(event => event.type === 'item.upsert' && event.payload.content.unsent === true && event.payload.content.text === 'must not replay'));
});
test('an active runtime cannot be replaced by a concurrent start', async () => {
  const { router } = fixture(); await router.start('t', { agent: 'claude' }); await assert.rejects(router.start('t', { agent: 'codex' }));
});
test('settings validate exact fields and persist independently of workspace settings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-native-settings-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json'), settings = createSettings(file);
  assert.equal(settings.get().claudePath, 'api-then-terminal');
  settings.set({ monthlyBudgetUsd: 0, claudePath: 'api-only' }); assert.equal(createSettings(file).get().monthlyBudgetUsd, 0);
  for (const patch of [{ env: {} }, { claudePath: 'subscription-first' }, { monthlyBudgetUsd: NaN }, { monthlyBudgetUsd: -1 }, { key: 'not-allowed' }]) assert.throws(() => settings.set(patch));
});
test('native IPC denies extra options and accepts only bound structured answers', () => {
  const handles = new Map(), { router, settings, claude } = fixture();
  registerIpc({ handle: (name, fn) => handles.set(name, fn), router, settings, claude });
  assert.throws(() => handles.get('native:start')('t', { agent: 'claude', cwd: '/untrusted' }));
  assert.throws(() => handles.get('native:send')('t', 's', 'm', '', []));
  assert.throws(() => handles.get('native:send')('t', 's', 'm', 'text', ['/untrusted.png']));
  assert.throws(() => handles.get('native:answer')('t', 's', 'r', { decision: 'allow', env: {} }));
  assert.throws(() => handles.get('native:answer')('t', 's', 'r', { answers: { q: { secret: true } } }));
});
test('native IPC uses the existing main-frame and origin checks', async () => {
  const handles = new Map(), mainFrame = { url: 'agentrix://app/index.html' }, webContents = { mainFrame };
  const { handle } = createIpcAdapter({ ipcMain: { handle: (name, fn) => handles.set(name, fn) }, getWindow: () => ({ webContents }), t: value => value, report() {} });
  handle('native:test', () => true);
  await assert.rejects(handles.get('native:test')({ sender: {}, senderFrame: mainFrame }));
  await assert.rejects(handles.get('native:test')({ sender: webContents, senderFrame: { url: mainFrame.url } }));
  assert.deepEqual(await handles.get('native:test')({ sender: webContents, senderFrame: mainFrame }), { ok: true, value: true });
});
test('event snapshots replace deltas and replay without advancing sequence', () => {
  const live = [], stream = createEventStream({ agent: 'claude', projectId: 'p', terminalId: 't', runtimeSessionId: 'r' }, event => live.push(event), () => 1);
  stream.publish('item.delta', { channel: 'text', text: 'par' }, { itemId: 'i' });
  stream.publish('item.delta', { channel: 'text', text: 'tial' }, { itemId: 'i' });
  stream.publish('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'final' } }, { itemId: 'i' });
  const snapshot = stream.snapshot(); assert.equal(snapshot.events.length, 1); assert.equal(snapshot.events[0].payload.content.text, 'final');
  assert.equal(snapshot.lastSequence, 3); assert.equal(snapshot.events[0].replay, true); assert.equal(live.length, 3);
  assert.ok(live.every(validEvent)); assert.equal(validEvent({ ...live[0], schemaVersion: 2 }), false);
});
test('unknown usage fields must be null rather than fabricated zeroes', () => {
  const stream = createEventStream({ agent: 'claude', projectId: 'p', terminalId: 't', runtimeSessionId: 'r' }, () => {}, () => 1);
  const event = stream.publish('usage.updated', { input: null, cachedInput: null, cacheWrite: null, output: null, reasoning: null, contextWindow: null, costUsdMicros: null, costEstimated: true });
  assert.ok(validEvent(event)); assert.equal(validEvent({ ...event, payload: { ...event.payload, input: undefined } }), false);
});
