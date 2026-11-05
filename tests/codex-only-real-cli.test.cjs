const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');

test('real app-server starts and resumes the same thread despite legacy terminal settings; missing CLI never falls back', {
  skip: !process.env.AGENTRIX_REAL_CODEX && 'set AGENTRIX_REAL_CODEX', timeout: 45000,
}, async () => {
  const temporary = os.tmpdir(), root = fs.mkdtempSync(path.join(temporary, 'agx-codex-only-')), cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT)$/i.test(name)));
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CODEX_HOME', 'AGENTRIX_DATA_DIR']) {
    env[name] = path.join(root, name); fs.mkdirSync(env[name]);
  }
  env.STANDIN_API_KEY = 'offline-key'; env.CI = '1';
  env.AGENTRIX_BOOTSTRAP = path.join(cwd, 'bootstrap.json'); fs.writeFileSync(env.AGENTRIX_BOOTSTRAP, '{}');
  const requests = [], launches = [], events = [], sessions = [];
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      requests.push(body); const id = 'resp_' + requests.length;
      const frames = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item: {
        type: 'message', role: 'assistant', id: 'msg_' + id, content: [{ type: 'output_text', text: 'OFFLINE CODEX ONLY' }] } },
      { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(frames.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "local"\n[model_providers.local]\nname = "Local"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nenv_key = "STANDIN_API_KEY"\n`);
  const codex = createCodexRuntime({ resolveExecutable: async () => process.env.AGENTRIX_REAL_CODEX,
    spawnProcess: (file, args, options) => { assert.equal(options.env.AGENTRIX_BOOTSTRAP, env.AGENTRIX_BOOTSTRAP); launches.push(args); return spawn(file, args, options); } });
  let threadId;
  const spec = id => ({ owner: 'gui', projectId: 'p', terminalId: id, cwd, env, model: 'gpt-6.1-sol', providerSessionId: threadId });
  try {
    const direct = codex.create(spec('initial'), event => events.push(event)); sessions.push(direct);
    threadId = (await direct.start()).providerSessionId;
    await direct.send({ clientMessageId: 'initial', text: 'Offline new thread' });
    for (let n = 0; n < 600 && !events.some(event => event.type === 'turn.completed'); n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(events.some(event => event.type === 'item.upsert' && event.payload.content?.text === 'OFFLINE CODEX ONLY'));
    await direct.close();
    const directory = path.join(root, 'native'); fs.mkdirSync(directory);
    const settingsFile = path.join(directory, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ claudePath: 'terminal-only', codexView: 'terminal', monthlyBudgetUsd: null, codexAutoReset: false }));
    const facade = createNativeSessions({ directory, codex, claude: { apiState: () => ({ status: 'no_key' }), usage: { summary: () => ({}) } },
      resolveSpec: id => spec(id), terminal: () => assert.fail('Codex must never start a TUI'), emit: event => events.push(event) }); sessions.push(facade);
    assert.equal(facade.getSettings().codexView, undefined);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile)).codexView, 'terminal', 'reading a legacy setting does not rewrite the file');
    await facade.start('restored', { agent: 'codex', resume: true });
    assert.equal(facade.snapshot('restored').events.findLast(event => event.providerSessionId)?.providerSessionId, threadId);
    assert.ok(facade.snapshot('restored').events.some(event => event.replay && event.payload.content?.text === 'OFFLINE CODEX ONLY'));
    await facade.stop('restored', facade.snapshot('restored').runtimeSessionId);
    threadId = null; await facade.start('new', { agent: 'codex' });
    assert.equal(facade.snapshot('new').events.findLast(event => event.type === 'path.changed').payload.selected, 'subscription');
    assert.ok(launches.length >= 3 && launches.every(args => args[0] === 'app-server'));
    let available = false;
    const missing = createNativeSessions({ directory: path.join(root, 'missing'), codex: createCodexRuntime({ resolveExecutable: async () => available ? process.env.AGENTRIX_REAL_CODEX : null }),
      claude: { apiState: () => ({ status: 'no_key' }) }, resolveSpec: id => spec(id), terminal: () => assert.fail('missing Codex cannot fall back'), emit() {} }); sessions.push(missing);
    await assert.rejects(missing.start('missing', { agent: 'codex' }), /未找到 Codex/);
    assert.equal(missing.snapshot('missing').state, 'failed');
    const failedId = missing.snapshot('missing').runtimeSessionId; available = true;
    await missing.start('missing', { agent: 'codex' });
    assert.equal(missing.snapshot('missing').state, 'idle'); assert.notEqual(missing.snapshot('missing').runtimeSessionId, failedId);
  } finally {
    for (const session of sessions.reverse()) await session.close();
    server.closeAllConnections(); server.close();
    assert.equal(path.dirname(root), temporary);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});
