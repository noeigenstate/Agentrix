const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { registerIpc } = require('../electron/features/native-session/ipc.cjs');
const { createEventStream } = require('../electron/features/native-session/events.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async check => { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } throw new Error('switch did not settle'); };
async function fixture(t, delayedReceipt = false) {
  let release, bridge, preparing = false;
  const pending = new Promise(resolve => { release = resolve; });
  let releaseReceipt;
  const receipt = new Promise(resolve => { releaseReceipt = resolve; });
  const source = { identity: {}, path: 'terminal', spec: { owner: 'gui', projectId: 'p', terminalId: 't', runtimeSessionId: 'main-runtime', providerSessionId: 'same-provider', agent: 'claude' } };
  const claude = { apiState: () => ({ status: 'ready' }), usage: { summary: () => ({}) }, create(spec, emit) {
    const stream = createEventStream(spec, emit);
    return { resume() { stream.provider('same-provider'); stream.publish('session.state', { state: 'idle', reason: null }); },
      async prepareResume() { preparing = true; await pending; }, snapshot: () => ({ ...stream.snapshot(), state: 'idle' }), close() {} };
  } };
  const settings = { get: () => ({ claudePath: 'api-only' }) };
  const router = createRouter({ claude, settings, terminalSessions: () => [source], observeTerminal: () => ({ state: 'idle', background: { known: false, count: null } }),
    resolveSpec() {}, activateNative() {}, emit() {} }); t.after(() => { release(); return router.close(); });
  const handlers = new Map(); registerIpc({ handle: (name, fn) => handlers.set(name, fn), router, settings, claude });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), { require: () => ({
    contextBridge: { exposeInMainWorld(_name, value) { bridge = value.nativeSession; } }, ipcRenderer: { invoke: async (channel, ...args) => {
      try {
        const value = await handlers.get(channel)(...args);
        if (delayedReceipt && args[3]?.handoff?.draft.version === 1) await receipt;
        return { ok: true, value };
      } catch (error) { return { ok: false, error: error.message }; }
    } },
  }) });
  router.reconcile(); await tick();
  const choice = router.switchState('t');
  const answer = await bridge.answer('t', 't', choice.requestId, { switch: { changeId: choice.changeId, requestId: choice.requestId, action: 'now' } });
  assert.equal(answer.ok, true); assert.equal(answer.value.accepted, true); await tick();
  const offer = (version, text) => bridge.answer('t', 't', `handoff-${choice.changeId}`, { handoff: { changeId: choice.changeId,
    draft: { version, text, images: [], undelivered: [] } } });
  return { bridge, router, choice, offer, release, releaseReceipt, preparing: () => preparing };
}
test('the actual preload/IPC bridge accepts a terminal-id switch answer with change/request identity', async t => {
  const f = await fixture(t); assert.equal(f.router.switchState('t').phase, 'preparing');
  const old = await f.bridge.answer('t', 't', f.choice.requestId, { switch: { changeId: f.choice.changeId, requestId: f.choice.requestId, action: 'now' } });
  assert.equal(old.value.accepted, false);
});
test('the actual preload/IPC handoff accepts a higher version during preparation and commits that latest text', async t => {
  const f = await fixture(t, true);
  const pendingReceipt = f.offer(1, 'Earlier draft');
  await until(f.preparing);
  const second = await f.offer(2, 'Text typed before the first receipt returned'); assert.equal(second.ok, true); assert.equal(second.value.accepted, true); assert.equal(second.value.version, 2);
  f.releaseReceipt();
  const first = await pendingReceipt; assert.equal(first.ok, true); assert.equal(first.value.version, 1);
  const old = await f.offer(1, 'Earlier draft'); assert.equal(old.value.accepted, false);
  f.release(); await until(() => f.router.switchState('t').phase === 'stable');
  assert.equal(f.router.snapshot('t').handoff.draft.version, 2);
  assert.equal(f.router.snapshot('t').handoff.draft.text, 'Text typed before the first receipt returned');
});
