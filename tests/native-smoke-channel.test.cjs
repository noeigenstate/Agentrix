const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createConnectionTest, netRequest } = require('../electron/features/claude-sdk/connection.cjs');
const key = 'sk-ant-api03-offline-smoke-channel-only';
const cli = async () => ({ status: 'ok', version: '2.1.318', required: '2.1.317' });

test('the packaged smoke stubs the channel the connection test goes through: Electron net, as main wires it', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  assert.match(main, /createClaudeRuntime\(\{[^]*?request: netRequest\(electronNet\)/, 'main sends the connection test through Electron net');
  const smoke = fs.readFileSync(path.join(__dirname, '../scripts/native-session-smoke.mjs'), 'utf8');
  assert.match(smoke, /app\.evaluate\(stubModelListNet\)/, 'the smoke installs the net stub inside main');
  assert.doesNotMatch(smoke, /https\.request\s*=/, 'a stub of node:https would no longer catch the request');
  const { stubModelListNet } = require('./fixtures/connection-net-stub.cjs');
  const electron = { net: { request: () => assert.fail('the stub must answer before the real net') } };
  stubModelListNet(electron);
  const value = await createConnectionTest({ credentials: { read: () => key }, inspectCli: cli, request: netRequest(electron.net) })();
  assert.equal(value.key.status, 'ok'); assert.deepEqual(value.models, ['fake-claude']);
});
