const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const { createRpc } = require('../electron/features/codex-app-server/rpc.cjs');

test('real app-server resumes the same thread through a response above 4 MiB', {
  skip: !process.env.AGENTRIX_REAL_CODEX, timeout: 40000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-large-')), children = [], clients = [], closed = new Map();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC)$/i.test(key)));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'TEMP', 'TMP', 'AGENTRIX_DATA_DIR']) {
    env[key] = path.join(root, key); fs.mkdirSync(env[key]);
  }
  const server = http.createServer((_request, response) => response.writeHead(400).end('offline only'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  env.OFFLINE_KEY = 'offline-only';
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), `model = "fixture-model"\nmodel_provider = "local"\n[model_providers.local]\nname = "Local"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nenv_key = "OFFLINE_KEY"\n`);
  let stage = 'initialize';
  const open = async () => {
    const child = spawn(process.env.AGENTRIX_REAL_CODEX, ['app-server', '--listen', 'stdio://'], { env, cwd: root, windowsHide: true });
    children.push(child); closed.set(child, once(child, 'close'));
    const rpc = createRpc(child, { timeout: 15000 }); clients.push(rpc);
    await rpc.request('initialize', { clientInfo: { name: 'offline-contract', version: '1' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized'); return rpc;
  };
  try {
    const first = await open(); stage = 'thread/start';
    const started = await first.request('thread/start', { cwd: root, ephemeral: false });
    const id = started.thread.id, name = 'n'.repeat(5 * 1024 * 1024);
    stage = 'thread/name/set'; await first.request('thread/name/set', { threadId: id, name });
    first.close();
    await closed.get(children[0]);
    stage = 'second initialize'; const second = await open(); stage = 'thread/resume';
    const response = await second.request('thread/resume', { threadId: id, excludeTurns: true });
    assert.equal(response.thread.id, id);
    assert.equal(response.thread.name, name);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) > 4 * 1024 * 1024);
  } catch (error) { process.stderr.write(`offline probe failure (${stage}): ${error.code || error.message}\n`); throw error; }
  finally {
    for (const rpc of clients) rpc.close();
    for (const child of children) { if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
    server.closeAllConnections(); server.close();
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
