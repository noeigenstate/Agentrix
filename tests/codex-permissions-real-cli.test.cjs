require('./fixtures/team-isolation.cjs');
// The owner's Codex permissions against the installed CLI: a throwaway profile, an offline key and a local stand-in model only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once, EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { resources, removeTree, CLEANUP_TIMEOUT } = require('./fixtures/codex-app-server-lifecycle.cjs');
const { timeoutScale } = require('../scripts/wait.mjs');

// A throwaway profile, an isolated PATH, an offline key and a local stand-in model; the sessions it opens close before the profile goes.
async function offlineCodex(t) {
  const lifetime = resources(t), childCloses = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-perm-real-')), cwd = path.join(root, 'project');
  // The sessions close first (each stops its app-server's whole tree); a folder still held after that is named with what is left in it.
  lifetime.defer('remove profile after CLI close', async () => {
    const until = Date.now() + CLEANUP_TIMEOUT - 500;
    await lifetime.wait(Promise.all(childCloses), 'CLI close receipts');
    await removeTree(root, until);
  });
  fs.mkdirSync(cwd);
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[name]) env[name] = process.env[name];
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'AGENTRIX_DATA_DIR']) { env[name] = path.join(root, name); fs.mkdirSync(env[name]); }
  const system = env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows';
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.copyFileSync(process.execPath, path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node'));
  env.PATH = (process.platform === 'win32' ? [bin, path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')]
    : [bin, '/usr/bin', '/bin']).join(path.delimiter);
  for (const name of ['codex', 'claude']) {
    const found = spawnSync(process.platform === 'win32' ? path.join(system, 'System32/where.exe') : '/usr/bin/which', [name],
      { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 10000 * timeoutScale });
    assert.ifError(found.error); assert.equal(found.status, 1, `${name} must be unreachable through the isolated PATH`);
  }
  env.STANDIN_API_KEY = 'offline-key'; env.CI = '1'; env.GIT_CEILING_DIRECTORIES = root;
  const version = spawnSync(process.env.AGENTRIX_REAL_CODEX, ['--version'], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 10000 * timeoutScale });
  assert.ifError(version.error); assert.equal(version.status, 0); assert.match(version.stdout, /\b0\.167\.0\b/);
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
  lifetime.defer('close local service', async () => {
    server.closeAllConnections(); if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const listening = once(server, 'listening', { signal: t.signal }); server.listen(0, '127.0.0.1'); await listening;
  // No [windows] sandbox setting: a writable request on Windows comes back read-only unless it is retried unelevated.
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "local"\n[model_providers.local]\nname = "Local"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nenv_key = "STANDIN_API_KEY"\n`);
  const factory = createCodexRuntime({ resolveExecutable: async () => process.env.AGENTRIX_REAL_CODEX, optionsHome: root,
    spawnProcess: (file, args, options) => {
      const child = lifetime.child(spawn(file, args, options)); childCloses.push(new Promise(resolve => child.once('close', resolve))); return child;
    } });
  const open = async (permissions, threadId) => {
    const events = [], signals = new EventEmitter();
    const session = factory.create({ owner: 'gui', projectId: 'p', terminalId: permissions + (threadId ? '-resumed' : ''), cwd, env, permissions }, event => { events.push(event); signals.emit(event.type, event); });
    // EventEmitter's error channel is used by once() below; a startup error must also be observed before turn() subscribes.
    signals.on('error', () => {});
    lifetime.defer('close ' + permissions + ' session', () => session.close());
    await (threadId ? session.resume({ providerSessionId: threadId }) : session.start()); return { session, events, signals };
  };
  const turn = async ({ session, signals }, text) => {
    const completed = once(signals, 'turn.completed', { signal: t.signal }); completed.catch(() => {});
    const cancel = event => { Promise.resolve(session.cancel(event.payload.requestId)).catch(error => signals.emit('error', error)); };
    signals.on('request.opened', cancel);
    try {
      await session.send({ clientMessageId: 'm' + Math.random().toString(36).slice(2), text });
      const [event] = await completed; assert.equal(event.payload.status, 'completed');
    } finally { signals.off('request.opened', cancel); }
  };
  return { open, turn, cwd, env };
}

test('real app-server: each permissions choice starts as asked, and /permissions changes the running thread from its next turn', {
  skip: !process.env.AGENTRIX_REAL_CODEX && 'set AGENTRIX_REAL_CODEX', timeout: 90000 * timeoutScale,
}, async t => {
  const { open, turn, cwd } = await offlineCodex(t);
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
  // Without a [windows] sandbox in this profile only a thread that started writable (through the unelevated retry) has a Windows sandbox:
  // it takes "ask" back, while the session that started with full access is refused it.
  if (process.platform === 'win32') {
    assert.equal((await ask.session.runOptions({ permissions: 'ask' })).permissions, 'ask');
    assert.equal(ask.session.threadResponse.sandbox.type, 'workspaceWrite');
    await assert.rejects(full.session.runOptions({ permissions: 'ask' }), /这个会话启动时没有 Windows 沙箱/);
    assert.equal((await full.session.runOptions({})).permissions, 'full');
  }
  // Back to the CLI's configuration: what a new thread here gets.
  await ask.session.runOptions({ permissions: 'config' });
  assert.equal(ask.session.threadResponse.sandbox.type, configured.session.threadResponse.sandbox.type);
});

// Close stops Codex at once (with its whole tree), never through its own exit at end of input: what it saved by then is all a resume has.
test('real app-server: a thread closed right after a turn resumes with that turn and its token count', {
  skip: !process.env.AGENTRIX_REAL_CODEX && 'set AGENTRIX_REAL_CODEX', timeout: 90000 * timeoutScale,
}, async t => {
  const { open, turn, env } = await offlineCodex(t);
  const first = await open('full');
  await turn(first, 'REMEMBER_ME');
  const threadId = first.session.threadResponse.thread.id;
  await first.session.close();
  const resumed = await open('full', threadId);
  const replayed = resumed.events.filter(event => event.type === 'item.upsert' && event.replay).map(event => [event.payload.kind, event.payload.content?.text]);
  assert.deepEqual(replayed.filter(([kind]) => ['user-message', 'agent-message'].includes(kind)), [['user-message', 'REMEMBER_ME'], ['agent-message', 'OFFLINE']]);
  // Codex keeps a thread's token count only in its rollout file; the stand-in model reports 2 tokens for the one response.
  const rollouts = fs.readdirSync(path.join(env.CODEX_HOME, 'sessions'), { recursive: true }).map(String).filter(file => file.endsWith(threadId + '.jsonl'));
  assert.equal(rollouts.length, 1, 'one rollout for the thread');
  const records = fs.readFileSync(path.join(env.CODEX_HOME, 'sessions', rollouts[0]), 'utf8').split('\n').filter(line => line.includes('"token_count"'));
  assert.ok(records.some(line => /"total_tokens":2\b/.test(line)), 'the turn’s token count was saved before the stop');
});
