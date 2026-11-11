require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');

for (const mode of ['configured', 'default', 'below-limit', 'post-turn-on', 'post-turn-off', 'failure']) test(`real Codex 0.166 auto compact ${mode}`, {
  skip: !process.env.AGENTRIX_REAL_CODEX && 'set AGENTRIX_REAL_CODEX to locked 0.166', timeout: 45000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-auto-compact-')), cwd = path.join(root, 'project'), home = path.join(root, 'home');
  fs.mkdirSync(cwd); fs.mkdirSync(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT)$/i.test(key)));
  Object.assign(env, { CODEX_HOME: home, HOME: home, USERPROFILE: home, TEMP: root, TMP: root, GIT_CEILING_DIRECTORIES: root, STANDIN_API_KEY: 'offline-compact-key', CI: '1' });
  const version = spawnSync(process.env.AGENTRIX_REAL_CODEX, ['--version'], { env, encoding: 'utf8' });
  assert.equal(version.status, 0); assert.match(version.stdout, /^codex-cli 0\.166\.0\s*$/);
  const requests = [], events = [], wireErrors = []; let compact = 0;
  const server = http.createServer((req, res) => {
    let text = ''; req.on('data', bytes => text += bytes); req.on('end', () => {
      assert.equal(req.headers.authorization, 'Bearer offline-compact-key');
      const data = JSON.parse(text), last = JSON.stringify(data.input.at(-1));
      const summary = /CONTEXT CHECKPOINT|handoff summary|Summarize the conversation/i.test(last);
      requests.push({ summary, url: req.url, last: last.slice(0, 240) }); if (summary) compact++;
      if (summary && mode === 'failure') return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'offline compact refused', type: 'invalid_request_error' } }));
      const id = 'resp_' + requests.length, item = { type: 'message', role: 'assistant', id: 'msg_' + id, content: [{ type: 'output_text', text: summary ? 'OFFLINE_HANDOFF_SUMMARY' : 'OFFLINE_MAIN_REPLY' }] };
      const input = compact ? 100 : mode === 'default' ? 91000 : 7000;
      const rows = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id, output: [item], usage: { input_tokens: input, output_tokens: 20, total_tokens: input + 20 } } }];
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(rows.map(row => `event: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`).join(''));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const limit = mode === 'default' ? '' : `model_auto_compact_token_limit=${['below-limit', 'post-turn-on', 'post-turn-off'].includes(mode) ? 90000 : 5000}\n`;
  const postTurn = mode.startsWith('post-turn') ? `model_post_turn_compact_threshold_percent=${mode === 'post-turn-on' ? 1 : 0}\n` : '';
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-6.1-sol"\nmodel_provider="local"\nmodel_context_window=100000\n${limit}${postTurn}[model_providers.local]\nname="Local"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nenv_key="STANDIN_API_KEY"\nstream_max_retries=0\n[windows]\nsandbox="unelevated"\n`);
  const runtime = createCodexRuntime({ resolveExecutable: async () => process.env.AGENTRIX_REAL_CODEX, spawnProcess(file, args, options) {
    const child = spawn(file, args, options); let buffer = '';
    child.stdout.on('data', bytes => { buffer += bytes; let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { const row = JSON.parse(line); if (row.method === 'error') wireErrors.push(row.params); } catch { } } });
    return child;
  } });
  const session = runtime.create({ owner: 'gui', cwd, env, projectId: 'p', terminalId: 't', runtimeSessionId: randomUUID(), readOnly: true, policy: { approvalPolicy: 'never' } }, event => events.push(event));
  t.after(async () => { await session.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const wait = async count => { for (let i = 0; i < 1500; i++) { if (events.filter(row => row.type === 'turn.completed').length >= count) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(JSON.stringify({ requests, events: events.slice(-4) })); };
  await session.start();
  for (const [index, text] of ['Offline input one', 'Offline input two'].entries()) { await session.send({ clientMessageId: 'input-' + index, text }); await wait(index + 1); }
  const boundaries = events.filter(row => row.type === 'context.compacted');
  t.diagnostic(JSON.stringify({ mode, compact, requests, boundaries, wireErrors, errors: events.filter(row => row.type === 'error') }));
  if (mode === 'failure') { assert.equal(compact, 1); assert.equal(boundaries.length, 0); assert.ok(events.some(row => row.type === 'error' && /上下文压缩失败。请求无效/.test(row.payload.message)));
    const calls = requests.length; await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(requests.length, calls, 'no host retry loop after CLI failure'); }
  else { assert.equal(compact, ['below-limit', 'post-turn-off'].includes(mode) ? 0 : 1); assert.equal(boundaries.length, compact); if (compact) assert.equal(boundaries[0].payload.trigger, 'auto');
    await session.send({ clientMessageId: 'third', text: 'Offline input three' }); await wait(3); assert.equal(events.filter(row => row.type === 'context.compacted').length, compact); }
  // The run's events are too large for a diagnostic line: kept in the OS temp directory, never in the checkout (a clean one has no folder for them).
  const evidence = path.join(os.tmpdir(), `agx-autocompact-codex-${mode}.json`);
  fs.writeFileSync(evidence, JSON.stringify({ mode, requests, events: events.filter(row => !['item.upsert', 'item.delta'].includes(row.type)) }, null, 2));
  t.diagnostic(`evidence: ${evidence}`);
});
