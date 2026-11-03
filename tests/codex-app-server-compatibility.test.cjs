const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRpc } = require('../electron/features/codex-app-server/rpc.cjs');
const { probeCapabilities } = require('../electron/features/codex-app-server/compatibility.cjs');

// Fixed 0.166 binding contract, independent of the adapter's method list. All four parameter
// types require threadId; turn/start and turn/steer also require input, steer expectedTurnId,
// and interrupt turnId. No empty-parameter probe may resolve or start work.
const methods0166 = ['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'];
test('N9: capability probes match the checked-in 0.166 protocol fixture and reject missing required identifiers', async t => {
  const lifetime = resources(t);
  const child = lifetime.child(spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')],
    { env: { SYNTHETIC_CODEX_MODE: 'normal' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
  const notifications = [], rpc = createRpc(child, { onNotification: method => notifications.push(method) });
  lifetime.defer('close RPC', () => rpc.close());
  assert.equal((await rpc.request('initialize', { clientInfo: { name: 'synthetic', version: '1' } })).userAgent, 'codex/0.166.0');
  rpc.notify('initialized');
  const calls = [];
  await probeCapabilities({ async request(method, params) {
    calls.push({ method, params });
    await assert.rejects(rpc.request(method, params), error => error.code === -32602);
    throw Object.assign(new Error('Missing required threadId'), { code: -32602 });
  } });
  assert.deepEqual(calls, methods0166.map(method => ({ method, params: {} })));
  assert.deepEqual(notifications, [], 'probes must not load a thread or start a turn');
});

for (const unsafeMethod of methods0166) test(`N9: a server defaulting missing identifiers in ${unsafeMethod} fails the probe`, async () => {
  const calls = [];
  await assert.rejects(probeCapabilities({ async request(method, params) {
    calls.push(method); assert.deepEqual(params, {});
    if (method === unsafeMethod) return {};
    throw Object.assign(new Error('Missing identifier'), { code: -32602 });
  } }), /unsupported_codex_capabilities/);
  assert.equal(calls.at(-1), unsafeMethod, 'stop probing immediately after unsafe success');
});
