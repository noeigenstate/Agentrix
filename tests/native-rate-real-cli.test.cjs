require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { harness, opening, textBlock, stream } = require('./fixtures/claude-real.cjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createNativeUsage } = require('../electron/features/native-session/agent-usage.cjs');
const os = require('node:os'), http = require('node:http');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { TokenRates } = require('../electron/features/agents/token-rate.cjs');
const { LOOKUP_AGENT_NAME, LOOKUP_AGENT } = require('../electron/features/claude-sdk/lookup-agent.cjs');
const { inputQueue } = require('../electron/features/claude-sdk/query.cjs');

test('real Claude streaming usage reaches the main native rate before the turn result', {
  skip: !process.env.AGENTRIX_REAL_CLAUDE && 'set AGENTRIX_REAL_CLAUDE to locked CLI', timeout: 45000,
}, async t => {
  let release;
  const f = await harness(t, (data, response) => {
    const start = opening(data); start.message.usage.output_tokens = 1;
    setTimeout(() => response.write(stream([...textBlock(0, 'OFFLINE_RATE'),
      { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 8 } }])), 250);
    release = () => response.end(stream([{ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }, { type: 'message_stop' }]));
    return { hold: true, events: [start] };
  });
  f.env.AGENTRIX_DATA_DIR = path.join(f.cwd, 'profile');
  const version = spawnSync(process.env.AGENTRIX_REAL_CLAUDE, ['--version'], { env: f.env, encoding: 'utf8' });
  assert.equal(version.status, 0); assert.match(version.stdout, /^2\.1\.317\b/);
  const raw = [], events = [], usage = createNativeUsage('claude');
  const runtime = createClaudeRuntime({ directory: path.join(f.cwd, 'state'), resolveExecutable: async () => process.env.AGENTRIX_REAL_CLAUDE,
    loadSdk: async () => ({ ...f.sdk, query(options) {
      const query = f.sdk.query(options), iterate = query[Symbol.asyncIterator].bind(query);
      query[Symbol.asyncIterator] = async function* () { for await (const message of { [Symbol.asyncIterator]: iterate }) { raw.push(message); yield message; } };
      return query;
    } }), safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  f.cleanup(() => runtime.close()); runtime.credentials.save(f.env.ANTHROPIC_API_KEY);
  const session = runtime.create({ owner: 'gui', cwd: f.cwd, env: f.env, model: 'claude-sonnet-4-5', runtimeSessionId: randomUUID() }, event => { events.push(event); usage.apply(event, event.type === 'usage.updated' ? session.tokenRate() : null); });
  await session.start(); await session.send({ clientMessageId: 'rate-input', text: 'Offline streaming rate proof' });
  const wait = async check => { for (let i = 0; i < 1200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('real stream did not settle'); };
  await wait(() => raw.some(row => row.event?.type === 'message_delta'));
  const partial = raw.filter(row => row.type === 'stream_event').map(row => ({ type: row.event.type, parent: row.parent_tool_use_id, usage: row.event.usage || row.event.message?.usage, model: row.event.message?.model }));
  t.diagnostic(JSON.stringify(partial));
  assert.equal(events.some(row => row.type === 'turn.completed'), false);
  assert.equal(usage.snapshot().rate.outputTokens, 8);
  assert.ok(usage.snapshot().rate.activeMs > 0);
  assert.equal(usage.snapshot().rate.samples, 1);
  release(); await wait(() => events.some(row => row.type === 'turn.completed'));
  assert.equal(usage.snapshot().rate.outputTokens, 12);
  assert.equal(usage.snapshot().rate.samples, 1, 'stream blocks and assistant snapshots replace one response');
  const final = usage.snapshot().rate;
  await new Promise(resolve => setTimeout(resolve, 40)); assert.deepEqual(usage.snapshot().rate, final, 'idle preserves completed-response rate');
  t.diagnostic(JSON.stringify({ final: raw.filter(row => ['assistant', 'result'].includes(row.type)).map(row => ({ type: row.type, usage: row.message?.usage || row.usage, model: row.message?.model })) }));
});

test('real Claude child usage and Agent tool wait never enter the main rate', {
  skip: !process.env.AGENTRIX_REAL_CLAUDE && 'set AGENTRIX_REAL_CLAUDE to locked CLI', timeout: 45000,
}, async t => {
  let childRequests = 0;
  const finish = output => [{ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: output } }, { type: 'message_stop' }];
  const f = await harness(t, (data, response) => {
    if (JSON.stringify(data.system).includes(LOOKUP_AGENT.prompt)) {
      childRequests++;
      setTimeout(() => response.end(stream([...textBlock(0, 'CHILD_RATE_PROOF'), ...finish(777)])), 300);
      return { hold: true, events: [opening(data)] };
    }
    if (JSON.stringify(data.messages).includes('toolu_rate_child')) return [opening(data), ...textBlock(0, 'ROOT_RATE_PROOF'), ...finish(20)];
    return [opening(data), { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_rate_child', name: 'Agent', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ subagent_type: LOOKUP_AGENT_NAME, prompt: 'Return the offline lookup result.', description: 'Offline rate child', run_in_background: false }) } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } }, { type: 'message_stop' }];
  });
  const meter = new TokenRates('claude'), began = Date.now(), marks = [], shapes = [];
  meter.nativeBegin(began);
  const queue = inputQueue(); queue.push({ type: 'user', uuid: randomUUID(), session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'Run the offline lookup.' } });
  let result;
  try { result = await f.run({}, message => {
    const at = Date.now(); meter.nativeClaude(message, at);
    if (message.type === 'stream_event' && message.event.type === 'message_delta' && !message.parent_tool_use_id) marks.push({ output: message.event.usage?.output_tokens, at });
    if (message.type === 'user' && message.message?.content?.some?.(block => block.type === 'tool_result')) marks.push({ tool: true, at });
    if (message.parent_tool_use_id) shapes.push({ type: message.type, parent: message.parent_tool_use_id, event: message.event?.type, usage: message.event?.usage || message.message?.usage });
  }, {}, queue); } finally { queue.close(); }
  t.diagnostic(JSON.stringify({ childRequests, marks, shapes, total: result.usage, rate: meter.snapshot() }));
  assert.equal(childRequests, 1); assert.ok(shapes.some(row => row.parent === 'toolu_rate_child'));
  assert.equal(meter.snapshot().outputTokens, 30); assert.equal(meter.snapshot().samples, 2);
  const first = marks.find(row => row.output === 10), last = marks.find(row => row.output === 20), tool = marks.find(row => row.tool);
  assert.ok(tool.at - first.at >= 300);
  assert.equal(meter.snapshot().activeMs, first.at - began + last.at - tool.at);
});

test('real Codex 0.166 streaming notifications feed the native main rate without estimating text tokens', {
  skip: !process.env.AGENTRIX_REAL_CODEX && 'set AGENTRIX_REAL_CODEX to locked 0.166', timeout: 45000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-native-rate-')), cwd = path.join(root, 'project'), home = path.join(root, 'home');
  fs.mkdirSync(cwd); fs.mkdirSync(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT)$/i.test(key)));
  Object.assign(env, { CODEX_HOME: home, HOME: home, USERPROFILE: home, TEMP: root, TMP: root, GIT_CEILING_DIRECTORIES: root, STANDIN_API_KEY: 'offline-test-key', CI: '1' });
  const version = spawnSync(process.env.AGENTRIX_REAL_CODEX, ['--version'], { env, encoding: 'utf8' });
  assert.equal(version.status, 0); assert.match(version.stdout, /^codex-cli 0\.166\.0\s*$/);
  let release; const wire = [], events = [], usage = createNativeUsage('codex');
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      assert.equal(req.headers.authorization, 'Bearer offline-test-key');
      const data = JSON.parse(body), id = 'rate_response', item = { type: 'message', role: 'assistant', id: 'rate_message', content: [{ type: 'output_text', text: 'OFFLINE_RATE' }] };
      assert.equal(data.model, 'gpt-6.1-sol');
      const write = row => res.write(`event: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      write({ type: 'response.created', response: { id } });
      write({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
      setTimeout(() => write({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'OFFLINE_RATE' }), 200);
      release = () => { write({ type: 'response.output_item.done', output_index: 0, item }); write({ type: 'response.completed', response: { id, output: [item], usage: { input_tokens: 12, output_tokens: 20, total_tokens: 32 } } }); res.end(); };
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-6.1-sol"\nmodel_provider="local"\n[model_providers.local]\nname="Local"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nenv_key="STANDIN_API_KEY"\n[windows]\nsandbox="unelevated"\n`);
  const runtime = createCodexRuntime({ resolveExecutable: async () => process.env.AGENTRIX_REAL_CODEX, spawnProcess(file, args, options) {
    const child = spawn(file, args, options); let pending = '';
    child.stdout.on('data', chunk => { pending += chunk; let end; while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); try { const value = JSON.parse(line); if (value.method) wire.push(value); } catch { } } });
    return child;
  } });
  const session = runtime.create({ owner: 'gui', cwd, env, projectId: 'p', terminalId: 't', runtimeSessionId: randomUUID(), readOnly: true, policy: { approvalPolicy: 'never' } }, event => { events.push(event); usage.apply(event, event.type === 'usage.updated' ? session.tokenRate() : null); });
  t.after(async () => { await session.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const wait = async check => { for (let i = 0; i < 1200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('real Codex rate did not settle'); };
  await session.start(); await session.send({ clientMessageId: 'rate-input', text: 'Offline rate proof' });
  await wait(() => wire.some(row => row.method === 'item/agentMessage/delta'));
  assert.equal(usage.snapshot().rate, null, 'text alone has no token count');
  release(); await wait(() => events.some(row => row.type === 'turn.completed'));
  const rate = usage.snapshot().rate;
  assert.equal(rate.outputTokens, 20); assert.equal(rate.samples, 1); assert.ok(rate.activeMs >= 200);
  assert.equal(usage.snapshot().model, 'gpt-6.1-sol');
  const observed = wire.filter(row => ['thread/tokenUsage/updated', 'item/agentMessage/delta'].includes(row.method));
  assert.ok(observed.some(row => row.params.tokenUsage?.last?.outputTokens === 20));
  t.diagnostic(JSON.stringify({ observed, rate }));
});
