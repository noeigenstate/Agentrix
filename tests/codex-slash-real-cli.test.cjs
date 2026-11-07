require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');

test('real Codex 0.166 native slash controls affect requests, survive resume, and use provider command turns', {
  skip: !process.env.AGENTRIX_REAL_CODEX && 'set AGENTRIX_REAL_CODEX to locked 0.166', timeout: 45000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-codex-slash-')), cwd = path.join(root, 'project'), home = path.join(root, 'home');
  fs.mkdirSync(cwd); fs.mkdirSync(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT)$/i.test(key)));
  Object.assign(env, { CODEX_HOME: home, HOME: home, USERPROFILE: home, TEMP: root, TMP: root, GIT_CEILING_DIRECTORIES: root,
    STANDIN_API_KEY: 'offline-test-key', CI: '1' });
  const binary = process.env.AGENTRIX_REAL_CODEX;
  const version = spawnSync(binary, ['--version'], { env, encoding: 'utf8' });
  assert.equal(version.status, 0); assert.match(version.stdout, /^codex-cli 0\.166\.0\s*$/);
  const bodies = [], wire = [], events = [], children = [], routers = [];
  let hold = false;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', data => body += data); req.on('end', () => {
      bodies.push(JSON.parse(body)); const id = 'resp_' + bodies.length;
      if (hold) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id } })}\n\n`); return; }
      const item = { type: 'message', role: 'assistant', id: 'msg_' + id, content: [{ type: 'output_text', text: 'OFFLINE_SLASH_RESPONSE' }] };
      const frames = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id, output: [item], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } }];
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(frames.map(row => `event: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`).join(''));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-6.1-sol"\nmodel_provider="local"\n[model_providers.local]\nname="Local"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nenv_key="STANDIN_API_KEY"\n[windows]\nsandbox="unelevated"\n`);
  const codex = createCodexRuntime({ resolveExecutable: async () => binary, spawnProcess: (file, args, options) => {
    const child = spawn(file, args, options); children.push({ child, done: once(child, 'close') });
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (data, ...rest) => { for (const line of String(data).trim().split('\n')) { try { wire.push(JSON.parse(line)); } catch { } } return write(data, ...rest); };
    return child;
  } });
  const create = codex.create;
  codex.create = (...args) => {
    const runtime = create(...args);
    for (const name of ['start', 'resume']) {
      const action = runtime[name]; runtime[name] = async (...input) => { try { return await action(...input); } catch (error) { t.diagnostic(JSON.stringify({ stage: error.stage, code: error.code, message: error.message, wire: wire.map(row => row.method) })); throw error; } };
    }
    return runtime;
  };
  const saved = {};
  const make = () => {
    const router = createRouter({ codex, claude: { apiState: () => ({ status: 'ready' }) }, settings: { get: () => ({}) },
      resolveSpec: () => ({ owner: 'gui', cwd, env, projectId: 'p', terminalId: 't', readOnly: true, policy: { approvalPolicy: 'never' }, providerSessionId: saved.providerSessionId }),
      saveSession: (_id, value) => Object.assign(saved, value), emit: event => events.push(event), terminal() { assert.fail('no terminal fallback'); } });
    routers.push(router); return router;
  };
  t.after(async () => { for (const router of routers) await router.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const { child, done } of children) { if (child.exitCode === null && child.signalCode === null) child.kill(); await done; }
    fs.rmSync(root, { recursive: true, force: true }); });
  const wait = async check => { for (let i = 0; i < 800; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('real slash fixture did not settle'); };
  let router = make(), binding = await router.start('t', { agent: 'codex' }), count = 0;
  const send = async text => { const before = events.filter(row => row.type === 'turn.completed').length;
    const result = await router.send('t', binding.runtimeSessionId, { clientMessageId: 'input-' + ++count, text });
    if (!text.startsWith('/status')) await wait(() => events.filter(row => row.type === 'turn.completed').length > before && router.snapshot('t').state === 'idle');
    return result;
  };
  const models = await router.models('t', binding.runtimeSessionId); assert.ok(models.some(row => row.value === 'gpt-6-sol'));
  const commands = await router.commands('t', binding.runtimeSessionId);
  for (const name of ['/model', '/effort', '/fast', '/new', '/clear', '/compact', '/review', '/status']) assert.ok(commands.some(row => row.name === name), name);
  const original = saved.providerSessionId;
  await send('Offline warmup establishes durable thread history');
  const beforeOptions = bodies.length;
  // The choice is durable even when the app closes before the next model request.
  await router.runOptions('t', binding.runtimeSessionId, { model: 'gpt-6-sol', effort: 'medium', fast: true });
  assert.equal(bodies.length, beforeOptions); await router.close(); router = make(); binding = await router.start('t', { agent: 'codex', resume: true });
  assert.equal(saved.providerSessionId, original);
  assert.deepEqual(await router.runOptions('t', binding.runtimeSessionId, {}), { model: 'gpt-6-sol', effort: 'medium', fast: true });
  await send('Offline chosen settings');
  assert.equal(bodies.at(-1).model, 'gpt-6-sol'); assert.equal(bodies.at(-1).reasoning.effort, 'medium'); assert.equal(bodies.at(-1).service_tier, 'priority');
  const beforeShell = bodies.length;
  await send('!echo CODEX_NATIVE_SHELL_PROOF'); assert.equal(bodies.length, beforeShell, 'shell runs without a model request');
  assert.ok(events.some(row => row.type === 'item.upsert' && row.payload.content?.output?.includes('CODEX_NATIVE_SHELL_PROOF') && row.payload.content.exitCode === 0));
  await send('Observe previous shell output'); assert.match(JSON.stringify(bodies.at(-1).input), /CODEX_NATIVE_SHELL_PROOF/);
  await send('/compact'); assert.ok(events.some(row => row.type === 'context.compacted' && row.payload.trigger === 'manual'));
  await send('/review'); assert.ok(wire.some(row => row.method === 'review/start' && row.params.target.type === 'uncommittedChanges'));
  const beforeStatus = bodies.length; await send('/status'); assert.equal(bodies.length, beforeStatus);
  assert.ok(events.some(row => row.type === 'item.upsert' && row.payload.content?.text?.startsWith('Codex 状态：')));
  await assert.rejects(router.send('t', binding.runtimeSessionId, { clientMessageId: 'unsupported', text: '/fork' }), /原生模式暂不支持/);
  assert.equal(bodies.length, beforeStatus);
  const fresh = await router.newConversation('t', binding.runtimeSessionId); binding = fresh;
  assert.notEqual(saved.providerSessionId, original); assert.equal(router.snapshot('t').state, 'idle');
  await send('New conversation preserves selected settings'); assert.equal(bodies.at(-1).model, 'gpt-6-sol');
  assert.equal(bodies.at(-1).reasoning.effort, 'medium'); assert.equal(bodies.at(-1).service_tier, 'priority');
  await router.shell('t', binding.runtimeSessionId, 'interrupt-shell', 'Start-Sleep -Seconds 30');
  await wait(() => router.snapshot('t').state === 'running');
  await router.interrupt('t', binding.runtimeSessionId); await wait(() => router.snapshot('t').state === 'idle');
  assert.equal(events.findLast(row => row.type === 'turn.completed').payload.status, 'interrupted');
  hold = true; const before = bodies.length;
  await router.send('t', binding.runtimeSessionId, { clientMessageId: 'held', text: 'Held request' }); await wait(() => bodies.length > before);
  await assert.rejects(router.newConversation('t', binding.runtimeSessionId), /等待当前任务/);
  await router.interrupt('t', binding.runtimeSessionId); await wait(() => router.snapshot('t').state === 'idle');
});
