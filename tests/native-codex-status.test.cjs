require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');

// JSON-RPC envelopes and response fields follow the archived 0.166 schemas.
// No executable, account directory, network request or credential store is used.
function server(cwd, tier = 'fast') {
  const child = new EventEmitter(), wire = [];
  const failures = new Set();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  child.stdin = new Writable({ write(bytes, _encoding, done) {
    for (const line of bytes.toString().trim().split('\n')) {
      const request = JSON.parse(line); wire.push(request); if (request.id == null) continue;
      queueMicrotask(() => {
        const p = request.params || {};
        if (failures.has(request.method)) return send({ id: request.id, error: { code: -32603, message: 'private server message' } });
        if (['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(request.method) && !p.threadId) return send({ id: request.id, error: { code: -32602, message: 'missing threadId' } });
        let result;
        if (request.method === 'initialize') result = { userAgent: 'codex/0.166.0' };
        else if (request.method === 'thread/start') result = { thread: { id: 'offline-thread', sessionId: 'offline-session', turns: [], cliVersion: '0.166.0', cwd, modelProvider: 'openai', source: 'vscode',
          preview: '', projectId: null, ephemeral: true, status: { type: 'idle' }, createdAt: 2000000000, updatedAt: 2000000000 },
        cwd, model: 'gpt-6.1-sol', modelProvider: 'openai', reasoningEffort: 'high', serviceTier: tier, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly' } };
        else if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: 'private@example.invalid', planType: 'pro' }, requiresOpenaiAuth: true };
        else if (request.method === 'account/rateLimits/read') result = { rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: 2000500000 } }, rateLimitsByLimitId: {} };
        else result = {};
        send({ id: request.id, result });
      });
    }
    done();
  } });
  return { child, wire, failures, notify: (method, params) => send({ method, params: { threadId: 'offline-thread', ...params } }) };
}
async function fixture(t, tier = 'fast') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-status-offline-')), fake = server(root, tier), events = [];
  const provider = createCodexRuntime({ resolveExecutable: async () => 'fake-only', spawnProcess: () => fake.child });
  const create = provider.create.bind(provider); let session;
  provider.create = (...args) => session = create(...args);
  const router = createRouter({ codex: provider, claude: { apiState: () => ({ status: 'no_key' }) }, emit: row => events.push(row),
    settings: { get: () => ({}) }, resolveSpec: () => ({ terminalId: 't', projectId: 'p', owner: 'gui', cwd: root, preserveRunOptions: true, env: { CODEX_HOME: root, PATH: '' } }) });
  t.after(async () => { await router.close(); fs.rmSync(root, { force: true, recursive: true }); });
  const started = await router.start('t', { agent: 'codex' });
  return { ...fake, root, events, router, providerSnapshot: () => session.snapshot(), id: started.runtimeSessionId };
}
test('Codex /status twice publishes visible local output in the router and provider snapshots, without a turn', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 2; n++) await f.router.send('t', f.id, { clientMessageId: 'status-' + n, text: '/status' });
  const outputs = f.router.snapshot('t').events.filter(row => row.type === 'item.upsert' && row.payload.kind === 'agent-message');
  assert.equal(outputs.length, 2);
  assert.ok(outputs.every(row => /Codex/.test(row.payload.content.text)));
  assert.equal(f.wire.filter(row => row.method === 'turn/start' && row.params.threadId).length, 0);
  assert.equal(f.events.filter(row => row.type.startsWith('turn.')).length, 0);
  assert.equal(f.providerSnapshot().events.filter(row => row.type === 'item.upsert' && row.payload.content.localCommand === 'status').length, 4);
  const model = ui('native-model.ts').fromSnapshot(f.router.snapshot('t'));
  const { nativeEntries, nativePending } = ui('native-entries.ts');
  assert.equal(nativeEntries(model).filter(row => row.role === 'assistant').length, 2);
  assert.equal(nativePending(model, [{ id: 'status-0', text: '/status', at: 1 }, { id: 'status-1', text: '/status', at: 2 }]).prompts.length, 0);
});

const loaded = new Map();
function ui(file) {
  if (loaded.has(file)) return loaded.get(file).exports;
  const filename = path.join(__dirname, '../src/features/native-session', file), mod = new Module(filename, module);
  loaded.set(file, mod); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => name === '../../shared/i18n' ? { t: key => key, currentLanguage: () => 'zh' }
    : name === '../reading/feed-parts' ? { splitQuote: text => ({ rest: text }) }
      : name.startsWith('./') ? ui(name.slice(2).replace(/\.ts$/, '') + '.ts') : original(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, filename);
  return mod.exports;
}

test('Codex /status reports provider data, both quota windows and safe failures, never a model request', async t => {
  const f = await fixture(t);
  f.notify('thread/tokenUsage/updated', { turnId: 'offline-turn', tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 130 }, last: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 60 }, modelContextWindow: 200000 } });
  await f.router.send('t', f.id, { clientMessageId: 'known', text: '/status' });
  const text = f.router.snapshot('t').events.findLast(row => row.payload.content?.localCommand === 'status').payload.content.text;
  for (const value of ['gpt-6.1-sol', 'high', 'readOnly', 'never', '25%', '70%', '2033-', '本会话 token：130', '上下文：60 / 200000']) assert.ok(text.includes(value), value);
  assert.doesNotMatch(text, /private@|planType|email/);
  fs.writeFileSync(path.join(__dirname, '../.notes/codex-status-output.txt'), text);
  f.failures.add('account/read'); f.failures.add('account/rateLimits/read');
  await f.router.send('t', f.id, { clientMessageId: 'failure', text: '/status' });
  const error = f.router.snapshot('t').events.findLast(row => row.payload.content?.localCommand === 'status').payload.content.text;
  assert.match(error, /account\/read：读取失败（RPC -32603）/); assert.match(error, /account\/rateLimits\/read：读取失败/);
  assert.doesNotMatch(error, /private server message/);
  assert.match(error, /5 小时额度：未知/);
});

test('a refused local command cannot poison the queue for the next /status', async t => {
  const f = await fixture(t);
  await assert.rejects(f.router.send('t', f.id, { clientMessageId: 'bad', text: '/status unexpected' }));
  assert.equal((await f.router.send('t', f.id, { clientMessageId: 'good', text: '/status' })).status, 'consumed');
});

test('unknown /status values stay unknown, including Fast and tokens', () => {
  const { statusText } = require('../electron/features/codex-app-server/status.cjs');
  const text = statusText({ options: { model: null, effort: null, fast: null }, thread: {}, cwd: null, usage: null, account: null, limits: null, errors: [] });
  for (const line of ['快速模式：未知', '本会话 token：未知', '上下文：未知 / 未知', '审批：未知', '沙箱：未知']) assert.ok(text.includes(line));
  assert.doesNotMatch(text, /：0|快速模式：关/);
});

test('/status does not turn an unreported service tier into Fast off', async t => {
  const f = await fixture(t, null);
  await f.router.send('t', f.id, { clientMessageId: 'unknown-fast', text: '/status' });
  assert.match(f.router.snapshot('t').events.findLast(row => row.payload.content?.localCommand === 'status').payload.content.text, /快速模式：未知/);
});

test('read-only /status does not clear an owner stop when a late interrupted turn arrives', async t => {
  const { createEventStream } = require('../electron/features/native-session/events.cjs');
  let stream; const markers = [];
  const provider = { create(spec, emit) {
    stream = createEventStream(spec, emit);
    return { start: async () => ({}), close: async () => {}, interrupt: async () => {}, snapshot: () => ({ state: 'idle' }), send: async () => ({ status: 'consumed' }) };
  } };
  const router = createRouter({ codex: provider, claude: { apiState: () => ({ status: 'ready' }) }, resolveSpec: () => ({ projectId: 'p', terminalId: 't' }), settings: { get: () => ({}) }, emit() {}, saveInterrupted: (_id, value) => markers.push(value) });
  t.after(() => router.close());
  const { runtimeSessionId } = await router.start('t', { agent: 'codex' });
  await router.interrupt('t', runtimeSessionId);
  await router.send('t', runtimeSessionId, { clientMessageId: 'status', text: '/status' });
  stream.publish('turn.completed', { status: 'interrupted', durationMs: null, apiDurationMs: null, costUsdMicros: null, tokens: null });
  assert.equal(markers.at(-1), false);
});
