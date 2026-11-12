require('./fixtures/team-isolation.cjs');
// The owner's Codex permissions against the installed CLI: a throwaway profile, an offline key and a local stand-in model only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');

test('real app-server: each permissions choice starts as asked, and /permissions changes the running thread from its next turn', {
  skip: !process.env.AGENTRIX_REAL_CODEX && 'set AGENTRIX_REAL_CODEX', timeout: 90000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-perm-real-')), cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT)$/i.test(name)));
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CODEX_HOME']) { env[name] = path.join(root, name); fs.mkdirSync(env[name]); }
  env.STANDIN_API_KEY = 'offline-key'; env.CI = '1'; env.GIT_CEILING_DIRECTORIES = root;
  // The stand-in model asks for one harmless write inside the project when the message says so, then answers.
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      const data = JSON.parse(body), id = 'resp_' + Math.random().toString(36).slice(2);
      const done = !body.includes('WRITE_PROOF') || data.input?.some(item => ['function_call_output', 'custom_tool_call_output'].includes(item.type));
      // The CLI lists its tools directly or in an additional_tools item, a code-mode exec as a custom tool (as tests/codex-only-real-cli.test.cjs reads them).
      const catalog = data.tools || data.input?.find(entry => entry.type === 'additional_tools')?.tools || [];
      const tool = catalog.flatMap(entry => entry.type === 'namespace' ? entry.tools : [entry]).find(entry => ['exec_command', 'shell_command', 'exec'].includes(entry.name));
      const item = done ? { type: 'message', role: 'assistant', id: 'msg_' + id, content: [{ type: 'output_text', text: 'OFFLINE' }] }
        : tool.type === 'custom' ? { type: 'custom_tool_call', id: 'fc_' + id, call_id: 'call_' + id, name: tool.name,
          input: 'const result = await tools.exec_command({cmd:"echo W > proof.txt",yield_time_ms:2000});text(result);' }
          : { type: 'function_call', id: 'fc_' + id, call_id: 'call_' + id, name: tool.name,
            arguments: JSON.stringify(tool.name === 'exec_command' ? { cmd: 'echo W > proof.txt', yield_time_ms: 2000 } : { command: 'echo W > proof.txt', timeout_ms: 10000 }) };
      const frames = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  // No [windows] sandbox setting: a writable request on Windows comes back read-only unless it is retried unelevated.
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "local"\n[model_providers.local]\nname = "Local"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nenv_key = "STANDIN_API_KEY"\n`);
  const children = [];
  const factory = createCodexRuntime({ resolveExecutable: async () => process.env.AGENTRIX_REAL_CODEX, optionsHome: root,
    spawnProcess: (file, args, options) => { const child = spawn(file, args, options); children.push(child); return child; } });
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) await session.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    server.close(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const open = async permissions => {
    const events = [], session = factory.create({ owner: 'gui', projectId: 'p', terminalId: permissions, cwd, env, permissions }, event => events.push(event));
    sessions.push(session); await session.start(); return { session, events };
  };
  const turn = async ({ session, events }, text) => {
    const before = events.filter(event => event.type === 'turn.completed').length;
    await session.send({ clientMessageId: 'm' + Math.random().toString(36).slice(2), text });
    for (let n = 0; n < 1500 && events.filter(event => event.type === 'turn.completed').length === before; n++) {
      const request = session.snapshot().requests[0];
      if (request) await session.cancel(request.requestId); else await new Promise(resolve => setTimeout(resolve, 20));
    }
  };

  const full = await open('full');
  assert.deepEqual([full.session.threadResponse.sandbox.type, full.session.threadResponse.approvalPolicy], ['dangerFullAccess', 'never']);
  const configured = await open('config');
  t.diagnostic('config sandbox: ' + configured.session.threadResponse.sandbox.type);
  const ask = await open('ask');
  assert.deepEqual([ask.session.threadResponse.sandbox.type, ask.session.threadResponse.approvalPolicy], ['workspaceWrite', 'on-request']);

  // /permissions full on the "ask" session: the next turn writes without a request.
  assert.equal((await ask.session.runOptions({ permissions: 'full' })).permissions, 'full');
  assert.equal(ask.session.threadResponse.sandbox.type, 'dangerFullAccess');
  await turn(ask, 'WRITE_PROOF');
  // Windows PowerShell writes the file in UTF-16: its presence is the proof.
  assert.ok(fs.existsSync(path.join(cwd, 'proof.txt')), 'the command ran');
  assert.equal(ask.events.some(event => event.type === 'request.opened'), false, 'full access asks nothing');
  // Back to the CLI's configuration: what a new thread here gets.
  await ask.session.runOptions({ permissions: 'config' });
  assert.equal(ask.session.threadResponse.sandbox.type, configured.session.threadResponse.sandbox.type);
});
