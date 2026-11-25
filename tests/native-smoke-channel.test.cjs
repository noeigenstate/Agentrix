const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerAppProtocols } = require('../electron/app/protocols.cjs');
const { createConnectionTest, netRequest } = require('../electron/features/claude-sdk/connection.cjs');
const { stubModelListNet } = require('./fixtures/connection-net-stub.cjs');
const { createNativeHost } = require('../electron/features/native-session/host.cjs');
const key = 'sk-ant-api03-offline-smoke-channel-only';
const cli = async () => ({ status: 'ok', version: '2.1.318', required: '2.1.317' });

test('the packaged smoke stubs the channel the connection test goes through: Electron net, as main wires it', async () => {
  const { installModelListStub } = await import('../scripts/native-session-smoke.mjs');
  const electron = { net: { request: () => assert.fail('the stub must answer before the real net') } };
  await installModelListStub({ evaluate: async run => run(electron) });
  const host = createNativeHost({ app: { isPackaged: true }, createSdkLoader() {}, electronNet: electron.net, netRequest });
  const request = host.createClaudeProvider('fixture', options => options.request);
  const value = await createConnectionTest({ credentials: { read: () => key }, inspectCli: cli, request })();
  assert.equal(value.key.status, 'ok'); assert.deepEqual(value.models, ['fake-claude']);
});

test('the offline stub preserves packaged asset fetches and still rejects unexpected network requests', () => {
  const root = path.join(__dirname, 'fixtures');
  const handlers = new Map();
  const net = {
    fetch(url) { return this.request({ url, method: 'GET' }); },
    request(options) { assert.equal(this, net); return options; },
  };
  registerAppProtocols({ protocol: { handle: (scheme, handler) => handlers.set(scheme, handler) }, root, electronNet: net });
  stubModelListNet({ net });
  const asset = 'assets/SeatsDialog.js';
  const fileUrl = pathToFileURL(path.join(root, 'dist', asset)).href;
  assert.deepEqual(handlers.get('agentrix')({ url: 'agentrix://app/' + asset }), { url: fileUrl, method: 'GET' });
  assert.equal(net.request(fileUrl), fileUrl);
  assert.throws(() => net.request({ url: 'https://example.invalid/' }), /Unexpected offline connection request/);
});
