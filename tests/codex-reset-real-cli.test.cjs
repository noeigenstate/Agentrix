const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { spawn, execFileSync } = require('node:child_process');
const { createRpc } = require('../electron/features/codex-app-server/rpc.cjs');

test('real Codex 0.166 validates reset params and rejects an isolated profile before any consume HTTP request', {
  skip: !process.env.AGENTRIX_REAL_CODEX && 'set AGENTRIX_REAL_CODEX', timeout: 30000,
}, async t => {
  const temporary = os.tmpdir(), root = fs.mkdtempSync(path.join(temporary, 'agx-reset-real-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC)$/i.test(name)));
  env.GIT_CEILING_DIRECTORIES = root;
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'TEMP', 'TMP', 'AGENTRIX_DATA_DIR']) {
    env[name] = path.join(root, name); fs.mkdirSync(env[name]);
  }
  execFileSync('git', ['init', '-q'], { cwd: root, env, windowsHide: true });
  const calls = [];
  const server = http.createServer((req, res) => { calls.push({ method: req.method, url: req.url }); res.writeHead(500).end('offline only'); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  fs.writeFileSync(path.join(env.CODEX_HOME, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'offline-not-a-real-key' }));
  const local = `http://127.0.0.1:${server.address().port}`; env.OPENAI_BASE_URL = local + '/v1'; env.OFFLINE_API_KEY = 'offline-key';
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), `chatgpt_base_url = "${local}"\nmodel_provider = "offline"\n[model_providers.offline]\nname = "Offline"\nbase_url = "${local}/v1"\nwire_api = "responses"\nenv_key = "OFFLINE_API_KEY"\n`);
  const child = spawn(process.env.AGENTRIX_REAL_CODEX, ['app-server', '--listen', 'stdio://'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close'); child.stderr.on('data', () => {});
  const replies = []; let pending = '';
  child.stdout.on('data', data => {
    pending += data; let end;
    while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line.trim()) replies.push(JSON.parse(line)); }
  });
  const rpc = createRpc(child, { timeout: 5000, onNotification() {}, onRequest() {}, onDisconnect() {} });
  try {
    const init = await rpc.request('initialize', { clientInfo: { name: 'offline_reset_probe', version: '1' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized');
    assert.match(init.userAgent, /0\.166/);
    const account = (await rpc.request('account/read', { refreshToken: false })).account;
    assert.ok(account === null || account.type === 'apiKey');
    for (const [method, params, expected] of [
      ['account/rateLimitResetCredit/consume', {}, /idempotencyKey/],
      ['account/rateLimitResetCredit/consume', { idempotencyKey: 'offline-only-never-a-real-account' }, /authentication|required|ChatGPT/i],
      ['account/rateLimits/read', { excludeResetCreditDetails: false }, /authentication|required|ChatGPT/i],
    ]) {
      await assert.rejects(rpc.request(method, params), error => {
        const message = replies.findLast(reply => reply.error)?.error.message || '';
        t.diagnostic(JSON.stringify({ method, code: error.code, message })); return expected.test(message);
      });
    }
    assert.equal(calls.filter(call => /consume/.test(call.url)).length, 0);
    t.diagnostic(JSON.stringify({ localRequests: calls }));
  } finally {
    rpc.close(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed;
    server.closeAllConnections(); server.close();
    assert.equal(path.dirname(root), temporary); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
