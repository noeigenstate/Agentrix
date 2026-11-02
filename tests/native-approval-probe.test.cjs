const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { main, isolatedEnvironment } = require('../scripts/native-approval-probe.cjs');
const { createStandin } = require('../scripts/native-approval-model.cjs');

test('probe defaults to no execution even with a provider, empty PATH and no account environment', async () => {
  assert.equal((await main([])).executed, false);
  assert.equal((await main(['codex'])).installedCliProof, false);
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/native-approval-probe.cjs'), 'claude'], { env: { PATH: '' }, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).executed, false);
  await assert.rejects(main(['unknown', '--run-installed']), /Usage/);
});

test('probe environment isolates homes and drops auth, proxies, provider overrides and injected runtime flags', () => {
  const env = isolatedEnvironment('/isolated/home', { Path: '/bin', SystemRoot: '/system', HOME: '/private', USERPROFILE: '/private', CODEX_HOME: '/private', CLAUDE_CONFIG_DIR: '/private',
    OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'https://upstream.invalid', HTTPS_PROXY: 'secret', NODE_OPTIONS: '--require injected', ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(env.Path, '/bin'); assert.equal(env.HOME, '/isolated/home'); assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.CODEX_HOME, path.join(env.HOME, 'codex')); assert.equal(env.CLAUDE_CONFIG_DIR, path.join(env.HOME, 'claude'));
  assert.ok(!JSON.stringify(env).includes('secret')); assert.ok(!JSON.stringify(env).includes('/private'));
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'HTTPS_PROXY', 'ANTHROPIC_BASE_URL']) assert.equal(env[key], undefined);
});

test('managed Claude is no longer a launchable probe mode', async () => {
  await assert.rejects(main(['claude', '--run-installed']), /Usage/);
});

function post(port, route, data) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let body = ''; res.on('data', bytes => body += bytes); res.on('end', () => resolve(body));
    });
    req.on('error', reject); req.end(JSON.stringify(data));
  });
}
const events = body => body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));

test('local model emits permission-requiring isolated Claude write and harmless Codex escalation, then stops after results', async t => {
  const model = createStandin(); await new Promise(resolve => model.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { model.server.closeAllConnections(); model.server.close(); });
  const port = model.server.address().port;
  const claude = events(await post(port, '/v1/messages', { stream: true, tools: [{ name: 'Bash' }], messages: [] }));
  const input = JSON.parse(claude.find(e => e.delta?.type === 'input_json_delta').delta.partial_json);
  assert.equal(input.command, 'printf controlled > native-proof.txt');
  const codex = events(await post(port, '/v1/responses', { input: [{ type: 'message', content: 'NATIVE_REQUEST_PROBE' }] }));
  const tool = codex.find(e => e.type === 'response.output_item.done').item;
  assert.equal(tool.type, 'custom_tool_call'); assert.ok(tool.input.includes('require_escalated')); assert.ok(tool.input.includes('echo native-request-probe'));
  const done = events(await post(port, '/v1/messages', { stream: true, tools: [{ name: 'Bash' }], messages: [{ content: [{ type: 'tool_result' }] }] }));
  assert.equal(done.find(e => e.type === 'message_delta').delta.stop_reason, 'end_turn');
  const codexDone = events(await post(port, '/v1/responses', { input: [{ type: 'custom_tool_call_output', call_id: tool.call_id }] }));
  assert.equal(codexDone.find(e => e.type === 'response.output_item.done').item.type, 'message');
});
