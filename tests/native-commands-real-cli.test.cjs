const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');

test('real Codex lists skills without a turn and sends a chosen slash skill as structured input', {
  skip: !process.env.AGENTRIX_REAL_CODEX && 'set AGENTRIX_REAL_CODEX', timeout: 30000,
}, async () => {
  const temporaryRoot = os.tmpdir(), root = fs.mkdtempSync(path.join(temporaryRoot, 'agx-real-skills-')), cwd = path.join(root, 'project');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT)$/i.test(name)));
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CODEX_HOME', 'AGENTRIX_DATA_DIR']) {
    env[name] = path.join(root, name); fs.mkdirSync(env[name]);
  }
  fs.mkdirSync(cwd);
  execFileSync('git', ['init', '-q'], { cwd, env, windowsHide: true, stdio: 'ignore' });
  const skill = path.join(cwd, '.agents/skills/offline-codex/SKILL.md'); fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\nname: offline-codex\ndescription: Offline Codex skill\n---\nOFFLINE_CODEX_SKILL_MARKER');
  env.STANDIN_API_KEY = 'offline-key'; env.CI = '1';
  const bodies = [], events = [];
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      bodies.push(body);
      const id = 'resp_' + bodies.length, item = { type: 'message', role: 'assistant', id: 'msg_' + id,
        content: [{ type: 'output_text', text: 'OFFLINE SKILL ANSWER' }] };
      const frames = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(frames.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "local"\n[model_providers.local]\nname = "Local"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nenv_key = "STANDIN_API_KEY"\n`);
  const runtime = createCodexRuntime({ resolveExecutable: async () => process.env.AGENTRIX_REAL_CODEX }).create({
    owner: 'dispatch', readOnly: true, cwd, env, projectId: 'p', terminalId: 't', model: 'gpt-6.1-sol',
  }, event => events.push(event));
  try {
    await runtime.start();
    const commands = await runtime.commands();
    assert.ok(commands.some(row => row.name === '/offline-codex' && row.view === 'reading'));
    assert.equal(bodies.length, 0); assert.equal(events.some(event => event.type === 'turn.started'), false);
    await runtime.send({ clientMessageId: 'slash', text: '/offline-codex ARG' });
    for (let n = 0; n < 500 && !events.some(event => event.type === 'turn.completed'); n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(bodies.some(body => body.includes('OFFLINE_CODEX_SKILL_MARKER')));
    assert.ok(events.some(event => event.type === 'item.upsert' && event.payload.content?.text === 'OFFLINE SKILL ANSWER'));
  } finally {
    await runtime.close(); server.closeAllConnections(); server.close();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(path.dirname(root), temporaryRoot);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});
