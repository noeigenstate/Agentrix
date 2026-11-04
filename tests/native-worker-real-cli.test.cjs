const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const correction = 'OWNER_LATE_CORRECTION_READ_ME';
test('real app-server consumes a late steer before completing the worker turn', { skip: !process.env.AGENTRIX_REAL_CODEX && 'set AGENTRIX_REAL_CODEX', timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-b9-codex-')), cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT)$/i.test(name)));
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CODEX_HOME']) { env[name] = path.join(directory, name); fs.mkdirSync(env[name]); }
  env.STANDIN_API_KEY = 'offline-key'; env.CI = '1';
  const bodies = [], events = [];
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      bodies.push(body);
      const id = 'resp_' + bodies.length, item = { type: 'message', role: 'assistant', id: 'msg_' + id, content: [{ type: 'output_text', text: body.includes(correction) ? 'CORRECTION ANSWER' : 'INITIAL ANSWER' }] };
      const frames = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(frames.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "local"\n[model_providers.local]\nname = "Local"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nenv_key = "STANDIN_API_KEY"\n`);
  let sent = false, delivery, runtime;
  runtime = require('../electron/features/codex-app-server/index.cjs').createCodexRuntime({ resolveExecutable: async () => process.env.AGENTRIX_REAL_CODEX }).create({
    owner: 'dispatch', readOnly: true, cwd, env, projectId: 'p', terminalId: 't', runtimeSessionId: randomUUID(), model: 'gpt-6.1-sol', fast: true, effort: 'high' }, event => {
    events.push(event);
    if (!sent && event.type === 'item.upsert' && event.payload.kind === 'agent-message') { sent = true; delivery = runtime.send({ clientMessageId: 'correction', text: correction }); }
  });
  try {
    await runtime.start(); await runtime.send({ clientMessageId: 'initial', text: 'INITIAL PROMPT' });
    for (let i = 0; i < 400 && !events.some(event => event.type === 'turn.completed'); i++) await pause(25);
    await delivery;
    assert.equal(bodies.some(body => body.includes(correction)), true);
    assert.ok(events.some(event => event.type === 'input.receipt' && event.payload.clientMessageId === 'correction' && event.payload.status === 'consumed'));
    assert.ok(events.some(event => event.type === 'item.upsert' && event.payload.content?.text === 'CORRECTION ANSWER'));
  } finally { await runtime.close(); server.closeAllConnections(); server.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
