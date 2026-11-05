require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

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
  env.GIT_CEILING_DIRECTORIES = root;
  env.AGENTRIX_BOOTSTRAP = path.join(cwd, 'bootstrap.json'); fs.writeFileSync(env.AGENTRIX_BOOTSTRAP, '{}');
  const requests = [], launches = [], events = [], sessions = []; let hold = false;
  const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
  const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
  const { deadline } = require('./fixtures/codex-app-server-lifecycle.cjs');
  const children = [];
  const launch = (file, args, options) => {
    const child = spawn(file, args, options);
    children.push(new Promise(resolve => child.once('close', resolve)));
    return child;
  };
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      requests.push(body); const id = 'resp_' + requests.length;
      const data = JSON.parse(body);
      if (hold) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('event: response.created\ndata: '+JSON.stringify({type:'response.created',response:{id}})+'\n\n'); return; }
      const proof = body.includes('REVIEW_WRITE_PROOF') && !data.input?.some(item => ['function_call_output', 'custom_tool_call_output'].includes(item.type));
      const catalog = data.tools || data.input?.find(item => item.type === 'additional_tools')?.tools || [];
      const tools = catalog.flatMap(tool => tool.type === 'namespace' ? tool.tools.map(value => ({ ...value, namespace: tool.name })) : [tool]);
      const tool = tools.find(tool => ['exec_command', 'shell_command', 'exec'].includes(tool.name));
      if (proof) assert.ok(tool, 'real CLI advertised an execution tool');
      const item = proof ? tool.type === 'custom' ? { type: 'custom_tool_call', id: 'fc_write', call_id: 'call_write',
        name: tool.name,
        input: 'const result = await tools.exec_command({cmd:"echo REVIEW_WRITTEN > proof.txt",yield_time_ms:1000});text(result);' }
        : { type: 'function_call', id: 'fc_write', call_id: 'call_write', name: tool.name,
          arguments: JSON.stringify(tool.name === 'exec_command' ? { cmd: 'echo REVIEW_WRITTEN > proof.txt', yield_time_ms: 1000 }
            : { command: 'echo REVIEW_WRITTEN > proof.txt', timeout_ms: 10000 }) } : {
        type: 'message', role: 'assistant', id: 'msg_' + id, content: [{ type: 'output_text', text: 'OFFLINE CODEX ONLY' }] };
      const frames = [{ type: 'response.created', response: { id } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(frames.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "local"\n[model_providers.local]\nname = "Local"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nenv_key = "STANDIN_API_KEY"\n[windows]\nsandbox = "unelevated"\n`);
  const codex = createCodexRuntime({ resolveExecutable: async () => process.env.AGENTRIX_REAL_CODEX,
    spawnProcess: (file, args, options) => { assert.equal(options.env.AGENTRIX_BOOTSTRAP, historyLookup ? undefined : env.AGENTRIX_BOOTSTRAP); launches.push(args); return launch(file, args, options); } });
  let threadId, historyLookup = false;
  const spec = id => ({ owner: 'gui', projectId: 'p', terminalId: id, cwd, env, context: 'REVIEW_LOCAL_DEVELOPER_INSTRUCTIONS', model: 'gpt-6.1-sol', providerSessionId: threadId });
  try {
    const direct = codex.create(spec('initial'), event => events.push(event)); sessions.push(direct);
    threadId = (await direct.start()).providerSessionId;
    await direct.send({ clientMessageId: 'initial', text: 'Offline new thread' });
    for (let n = 0; n < 600 && !events.some(event => event.type === 'turn.completed'); n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(events.some(event => event.type === 'item.upsert' && event.payload.content?.text === 'OFFLINE CODEX ONLY'));
    assert.match(requests.at(-1), /REVIEW_LOCAL_DEVELOPER_INSTRUCTIONS/);
    await direct.close();
    const beforeHistory = requests.length;
    historyLookup = true;
    assert.equal((await codex.history(spec('history'))).id, threadId, 'real thread/list finds the same thread');
    historyLookup = false;
    assert.equal(requests.length, beforeHistory, 'history lookup never sends a model request');
    const unfinished = codex.create(spec('interrupted'), () => {}); sessions.push(unfinished);
    await unfinished.resume(); assert.equal(await unfinished.canContinueInterrupted(), false);
    hold = true; const beforeInterrupt = requests.length;
    await unfinished.send({ clientMessageId: 'interrupt-proof', text: 'INTERRUPT_PROOF' });
    for (let n = 0; n < 500 && requests.length === beforeInterrupt; n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(requests.length > beforeInterrupt); await unfinished.interrupt();
    for (let n = 0; n < 500 && unfinished.snapshot().state !== 'idle'; n++) await new Promise(resolve => setTimeout(resolve, 20));
    await unfinished.close(); hold = false;
    const interrupted = codex.create(spec('verified-interruption'), () => {}); sessions.push(interrupted);
    await interrupted.resume(); assert.equal(await interrupted.canContinueInterrupted(), true, 'real resumed last turn reports interruption');
    await interrupted.close();

    if (process.platform === 'win32') {
      const config = path.join(env.CODEX_HOME, 'config.toml');
      const blankWindows = fs.readFileSync(config, 'utf8').replace('[windows]\nsandbox = "unelevated"\n', '');
      fs.writeFileSync(config, blankWindows);
      const workerEvents = [], worker = createCodexRuntime({ resolveExecutable: async () => process.env.AGENTRIX_REAL_CODEX, spawnProcess: launch })
        .create({ ...spec('write-proof'), owner: 'dispatch', providerSessionId: null }, event => workerEvents.push(event));
      sessions.push(worker);
      await worker.start(); assert.equal(worker.threadResponse.sandbox.type, 'workspaceWrite');
      await worker.send({ clientMessageId: 'write-proof', text: 'REVIEW_WRITE_PROOF' });
      for (let n = 0; n < 1000 && !workerEvents.some(event => event.type === 'turn.completed'); n++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(workerEvents.some(event => event.type === 'turn.completed'), 'real tool round completed');
      const written = fs.readFileSync(path.join(cwd, 'proof.txt'));
      assert.match(written.toString(written[0] === 0xff && written[1] === 0xfe ? 'utf16le' : 'utf8'), /REVIEW_WRITTEN/);
      assert.equal(fs.readFileSync(config, 'utf8'), blankWindows, 'retry did not write user configuration');
      await worker.close();
    }
    // External helpers and the Lab have no GUI control socket. Both fresh and
    // resumed invocations must use the same real app-server transport.
    const { run } = require('../integration/dispatch.cjs');
    const brief = path.join(root, 'helper-brief.md'); fs.writeFileSync(brief, 'OFFLINE_HELPER');
    const helperEnv = { ...env }; delete helperEnv.AGENTRIX_BOOTSTRAP;
    const helperLaunches = [];
    for (const resume of [[], ['--resume', threadId]]) {
      const out = path.join(root, resume.length ? 'resumed.md' : 'fresh.md'); let stdout = '';
      const code = await run(['codex', '--role', 'exec', '--title', 'Offline helper', '--model', 'gpt-6.1-sol',
        '--effort', 'high', '--cwd', cwd, '--brief', brief, '--out', out, ...resume], {
        env: helperEnv, launch, stdout: { write: value => { stdout += value; } },
        resolveExecutable: (_agent, args) => { helperLaunches.push(args); return { file: process.env.AGENTRIX_REAL_CODEX, args }; },
      });
      assert.equal(code, 0, stdout); assert.equal(fs.readFileSync(out, 'utf8'), 'OFFLINE CODEX ONLY');
      if (resume.length) assert.ok(stdout.includes('session ' + threadId));
      assert.doesNotMatch(stdout, /fallback/);
    }
    assert.equal(helperLaunches.length, process.platform === 'win32' ? 3 : 2); assert.ok(helperLaunches.every(args => args[0] === 'app-server'));
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
    const before = requests.length;
    await facade.send('restored', facade.snapshot('restored').runtimeSessionId, { clientMessageId: 'resume-note', text: 'RESUME_NOTE' });
    for (let n = 0; n < 600 && (requests.length === before || facade.snapshot('restored').state !== 'idle'); n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(requests.at(-1), /REVIEW_LOCAL_DEVELOPER_INSTRUCTIONS/);
    await facade.stop('restored', facade.snapshot('restored').runtimeSessionId);
    threadId = null; await facade.start('new', { agent: 'codex' });
    assert.equal(facade.snapshot('new').events.findLast(event => event.type === 'path.changed').payload.selected, 'subscription');
    assert.ok(launches.length >= 3 && launches.every(args => args[0] === 'app-server'));
    let available = false;
    const missing = createNativeSessions({ directory: path.join(root, 'missing'), codex: createCodexRuntime({ resolveExecutable: async () => available ? process.env.AGENTRIX_REAL_CODEX : null, spawnProcess: launch }),
      claude: { apiState: () => ({ status: 'no_key' }) }, resolveSpec: id => spec(id), terminal: () => assert.fail('missing Codex cannot fall back'), emit() {} }); sessions.push(missing);
    await assert.rejects(missing.start('missing', { agent: 'codex' }), /未找到 Codex/);
    assert.equal(missing.snapshot('missing').state, 'failed');
    const failedId = missing.snapshot('missing').runtimeSessionId; available = true;
    await missing.start('missing', { agent: 'codex' });
    assert.equal(missing.snapshot('missing').state, 'idle'); assert.notEqual(missing.snapshot('missing').runtimeSessionId, failedId);
  } finally {
    for (const session of sessions.reverse()) await session.close();
    await deadline(Promise.all(children), 'real Codex stdio close');
    server.closeAllConnections(); server.close();
    assert.equal(path.dirname(root), temporary);
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
});
