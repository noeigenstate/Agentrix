require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const disposers = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-review-'));
  disposers.set(root, []);
  t.after(async () => { for (const close of disposers.get(root)) await close(); fs.rmSync(root, { recursive: true, force: true }); disposers.delete(root); }); return root;
}
function codex(t, root, extra = {}) {
  const log = path.join(root, 'wire');
  const factory = createCodexRuntime({ resolveExecutable: async () => 'fake-only', spawnProcess: (_file, _args, options) =>
    spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], options), ...extra });
  const runtime = factory.create({ cwd: root, owner: 'gui', context: 'LOCAL_STARTUP_NOTE', env: { ...process.env, GIT_CEILING_DIRECTORIES: root, CODEX_HOME: root, SYNTHETIC_CODEX_LOG: log }, ...extra.spec }, () => {});
  disposers.get(root).push(() => runtime.close()); return { runtime, log, wire: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) };
}
test('B1 local Codex start and resume transmit developer instructions', async t => {
  const root = directory(t), first = codex(t, root); const opened = await first.runtime.start();
  assert.equal(first.wire().find(row => row.method === 'thread/start').params.config.developer_instructions, 'LOCAL_STARTUP_NOTE');
  await first.runtime.close();
  const next = codex(t, root, { spec: { providerSessionId: opened.providerSessionId } }); await next.runtime.resume();
  assert.equal(next.wire().findLast(row => row.method === 'thread/resume' && row.params.threadId).params.config.developer_instructions, 'LOCAL_STARTUP_NOTE');
});
test('B2 Windows dispatch retries read-only once with request-scoped unelevated sandbox', async t => {
  const root = directory(t), f = codex(t, root, { platform: 'win32', spec: { owner: 'dispatch', env: { ...process.env,
    GIT_CEILING_DIRECTORIES: root, CODEX_HOME: root, SYNTHETIC_CODEX_LOG: path.join(root, 'wire'), SYNTHETIC_CODEX_MODE: 'windows-sandbox' } } });
  await f.runtime.start(); const starts = f.wire().filter(row => ['thread/start', 'thread/resume'].includes(row.method) && row.params.cwd);
  assert.equal(starts.length, 2); assert.equal(starts[0].params.config['windows.sandbox'], undefined);
  assert.equal(starts[1].params.config['windows.sandbox'], 'unelevated');
  assert.equal(f.runtime.threadResponse.sandbox.type, 'workspaceWrite');
});
test('S4 ordinary Claude resume preserves its transcript model instead of resetting it', async t => {
  const root = directory(t), fake = fakeSdk(); let resets = 0;
  const query = fake.sdk.query; fake.sdk.query = input => ({ ...query(input), setModel: async () => resets++, getContextUsage: async () => ({ model: 'default' }) });
  const runtime = createClaudeRuntime({ directory: root, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'fake-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  runtime.credentials.save('sk-ant-offline-review-not-a-real-key'); t.after(() => runtime.close());
  const session = runtime.create({ owner: 'gui', cwd: root, model: null, providerSessionId: 'old-session', env: { HOME: root, USERPROFILE: root } }, () => {});
  await session.resume(); await session.send({ clientMessageId: 'resume', text: 'hi' }); await pause(10);
  assert.equal(resets, 0);
});
test('S5 user settings cannot silently substitute the saved API key', t => {
  const root = directory(t), cwd = path.join(root, 'project'), home = path.join(root, 'home');
  fs.mkdirSync(cwd); fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'different-key' } }));
  assert.throws(() => require('../electron/features/claude-sdk/routing.cjs').routeSettings({ cwd, env: { HOME: home, USERPROFILE: home } }), /API.*密钥|Key/);
});
test('S6 hidden failure does not poison grouped rate or task text; successful dispatch retires', async t => {
  const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
  const calls = new AgentCalls({ local: false }); t.after(() => calls.dispose());
  const start = id => calls.dispatch({ type: 'dispatch-start', id, agent: 'codex', model: 'fixture', effort: 'high', fast: false, title: id, startedAt: 1 });
  start('failed'); calls.dispatch({ type: 'dispatch-end', id: 'failed', model: 'fixture', effort: 'high', fast: false, endedAt: 2, reason: 'error', exitCode: 1, outputTokens: null, activeMs: null });
  calls.byId('dispatch:failed').hidden = true;
  start('live'); calls.dispatch({ type: 'dispatch-rate', id: 'live', outputTokens: 20, activeMs: 1000 });
  assert.equal(calls.snapshot()[0].rate.outputTokens, 20); assert.deepEqual(calls.snapshot()[0].tasks, ['live']);
  start('success'); calls.dispatch({ type: 'dispatch-end', id: 'success', model: 'fixture', effort: 'high', fast: false, endedAt: 2, reason: 'exit', exitCode: 0, outputTokens: null, activeMs: null });
  calls.byId('dispatch:success').hidden = true;
  assert.ok(!calls.snapshot().flatMap(group => group.items).some(item => item.id === 'dispatch:success'));
  assert.ok(calls.byId('dispatch:success'), 'the feed and receipt remain retained');
});
test('S8 ordinary RPC JSON avoids a reviver; image result is stripped before publication', () => {
  const { jsonFrames } = require('../electron/oversized-record.cjs'); const parse = JSON.parse, modes = [], messages = [];
  JSON.parse = (text, reviver) => { modes.push(!!reviver); return parse(text, reviver); };
  try { const read = jsonFrames(value => messages.push(value), assert.fail, assert.fail);
    read(Buffer.from('{"items":[{"text":"plain"}]}\n'));
    assert.equal(modes.at(-1), false);
    read(Buffer.from('{"item":{"type":"imageGeneration","result":"pixels"}}\n'));
    assert.equal(messages[1].item.result, undefined);
  } finally { JSON.parse = parse; }
});
test('S10 stopping during SSH connection disposes the late child without initializing it', async t => {
  const root = directory(t); let release, killed = 0, disposed = 0, writes = 0;
  const child = Object.assign(new EventEmitter(), { remote: true, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { killed++; this.exitCode = 0; queueMicrotask(() => { this.emit('exit', 0); this.emit('close', 0); }); }, dispose() { disposed++; } });
  child.stdin.on('data', () => writes++);
  const runtime = createCodexRuntime({ launchRemote: () => new Promise(resolve => { release = resolve; }) }).create({ kind: 'ssh', cwd: root }, () => {});
  const opening = runtime.start().catch(error => error); await runtime.close(); release({ cwd: root, child }); await opening;
  assert.equal(writes, 0); assert.equal(killed, 1); assert.equal(disposed, 1);
});
test('S14 shell removes provider key and OAuth names in every letter case', async t => {
  const root = directory(t), abort = new AbortController();
  const result = await require('../electron/features/claude-sdk/shell.cjs').runShell({ cwd: root, env: { ...process.env,
    CODEX_API_KEY: 'private', CLAUDE_CODE_OAUTH_TOKEN: 'private', AWS_SECRET_ACCESS_KEY: 'private', AWS_REGION: 'offline-region', AWS_PROFILE: 'offline-profile' }, signal: abort.signal,
    command: 'printf "%s:%s:%s:%s:%s" "${CODEX_API_KEY-unset}" "${CLAUDE_CODE_OAUTH_TOKEN-unset}" "${AWS_SECRET_ACCESS_KEY-unset}" "${AWS_REGION-unset}" "${AWS_PROFILE-unset}"', output() {} });
  assert.equal(result.stdout, 'unset:unset:unset:offline-region:offline-profile');
});
test('S3 shell background descendants cannot hold timeout and cancellation hostage', async t => {
  const root = directory(t), abort = new AbortController();
  const began = Date.now();
  const task = require('../electron/features/claude-sdk/shell.cjs').runShell({ cwd: root, env: process.env, command: 'sleep 5 & echo started',
    signal: abort.signal, timeout: 1000, output() { setTimeout(() => abort.abort(), 250); } });
  const result = await Promise.race([task, pause(2500).then(() => assert.fail('shell timeout did not settle'))]);
  assert.ok(Date.now() - began < 2500); abort.abort(); await result.closed;
});
test('S9 subscription limits are isolated by project including SSH', async t => {
  const root = directory(t), streams = new Map();
  const provider = { apiState: () => ({ status: 'ready' }), usage: { summary: () => ({}) }, create(spec, emit) {
    const stream = require('../electron/features/native-session/events.cjs').createEventStream(spec, emit); streams.set(spec.projectId, stream);
    return { start: async () => {}, close() {}, snapshot: () => ({ state: 'idle' }) };
  } };
  const native = createNativeSessions({ directory: root, claude: provider, codex: provider, emit() {},
    resolveSpec: id => ({ owner: 'gui', kind: id === 'ssh' ? 'ssh' : 'local', projectId: id, terminalId: id }) });
  t.after(() => native.close());
  await native.start('ssh', { agent: 'codex' });
  const remote = { scopeId: 'remote', billingRoute: 'subscription', observedAtMs: 1, state: 'ready', limitsById: {}, resetCredits: null, ordinaryUsageAllowed: null, source: 'remote' };
  streams.get('ssh').publish('limits.updated', remote);
  assert.equal((await native.usage('local')).agents.codex.limits, null);
  assert.equal((await native.usage('ssh')).agents.codex.limits.source, 'remote');
});
test('S13 oversized history response shrinks a page without a dropped-item notice', async () => {
  let drop; const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const filename = path.join(__dirname, '../electron/features/codex-app-server/rpc.cjs'), source = fs.readFileSync(filename, 'utf8'), module = { exports: {} };
  require('node:vm').runInNewContext(source, { module, Buffer, setTimeout, clearTimeout, require: () => ({ MAX_FRAME: 1000, jsonFrames: (_receive, dropped) => {
    drop = dropped; const read = () => {}; read.end = read.clear = () => {}; return read;
  } }) });
  let notices = 0; const rpc = module.exports.createRpc(child, { onDropped: () => notices++ });
  const request = rpc.request('thread/turns/list', {}); drop({ id: '1' }, 1001);
  await assert.rejects(request, { code: 'history_frame_limit' }); assert.equal(notices, 0); rpc.close();
});

test('S1 S2 shell submits an independent immediate user turn and leaves slash input intact', async t => {
  const root = directory(t), fake = fakeSdk(), events = [];
  const runtime = createClaudeRuntime({ directory: root, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'fake-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  runtime.credentials.save('sk-ant-offline-review-not-a-real-key'); disposers.get(root).push(() => runtime.close());
  const session = runtime.create({ owner: 'gui', cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, GIT_CEILING_DIRECTORIES: root } }, event => events.push(event));
  await session.start(); await session.shell('shell', 'printf REVIEW_SHELL'); await pause(20);
  assert.equal(fake.inputs.length, 1);
  assert.deepEqual(fake.inputs[0].message.content, [{ type: 'text', text: '<bash-input>printf REVIEW_SHELL</bash-input>\n' },
    { type: 'text', text: '<bash-stdout>REVIEW_SHELL</bash-stdout><bash-stderr></bash-stderr>' }]);
  assert.equal(events.filter(row => row.type === 'turn.started' && row.payload.origin === 'user').length, 1);
  await session.send({ clientMessageId: 'compact', text: '/compact' }); await pause(10);
  assert.equal(fake.inputs[1].message.content, '/compact');
});

test('O5 cleared JSON stream stops dispatching later frames from the same chunk', () => {
  const rows = [], read = require('../electron/oversized-record.cjs').jsonFrames(value => { rows.push(value); read.clear(); }, assert.fail, assert.fail);
  read(Buffer.from('{"first":true}\n{"second":true}\n')); assert.deepEqual(rows, [{ first: true }]);
});
test('S8 escaped non-image types still avoid the reviver', () => {
  const parse = JSON.parse, modes = [];
  JSON.parse = (text, reviver) => { modes.push(!!reviver); return parse(text, reviver); };
  try {
    const read = require('../electron/oversized-record.cjs').jsonFrames(() => {}, assert.fail, assert.fail);
    read(Buffer.from('{"type":"plain","text":"\\u1234"}\n')); assert.equal(modes.at(-1), false);
  } finally { JSON.parse = parse; }
});

test('S8 escaped image property names cannot retain pixels', () => {
  const messages = [], read = require('../electron/oversized-record.cjs').jsonFrames(value => messages.push(value), assert.fail, assert.fail);
  read(Buffer.from('{"\\u0074ype":"imageGeneration","result":"pixels"}\n'));
  read(Buffer.from('{"kind":"image_gen.\\u0067eneration","result":"pixels"}\n'));
  assert.deepEqual(messages.map(value => Object.hasOwn(value, 'result')), [false, false]);
});
test('S3 cancellation stops background writes and timeout stops foreground writes before closing', { timeout: 10000 }, async t => {
  for (const mode of ['abort', 'timeout']) {
    const root = directory(t), abort = new AbortController();
    const result = await require('../electron/features/claude-sdk/shell.cjs').runShell({ cwd: root, env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
      command: 'while true; do printf x >> heartbeat; sleep 0.05; done' + (mode === 'abort' ? ' & echo started' : ''), signal: abort.signal, timeout: mode === 'timeout' ? 1500 : 5000, output() {} });
    if (mode === 'abort') abort.abort();
    await result.closed;
    const heartbeat = path.join(root, 'heartbeat'), before = fs.readFileSync(heartbeat, 'utf8');
    await pause(200); assert.equal(fs.readFileSync(heartbeat, 'utf8'), before, mode + ' must stop the descendant writer');
  }
});


test('S3 closing after model startup failure waits for shell disposal', async t => {
  const root = directory(t), fake = fakeSdk({ preflightSource: 'oauth' });
  let ended = false, finish;
  const closed = new Promise(resolve => { finish = () => { ended = true; resolve(); }; });
  function load(file, overrides) {
    const module = { exports: {} }, native = require('node:module').createRequire(file);
    require('node:vm').runInNewContext(fs.readFileSync(file, 'utf8'), { module, __dirname: path.dirname(file),
      process, Buffer, AbortController, setTimeout, clearTimeout, queueMicrotask,
      require: name => overrides[name] || native(name) });
    return module.exports;
  }
  const sessionModule = load(path.resolve(__dirname, '../electron/features/claude-sdk/session.cjs'), {
    './shell.cjs': { runShell: ({ signal }) => {
      signal.addEventListener('abort', () => setTimeout(finish, 40), { once: true });
      return Promise.resolve({ exitCode: 0, stdout: 'started', stderr: '', closed });
    } },
  });
  const { createClaudeRuntime: isolated } = load(path.resolve(__dirname, '../electron/features/claude-sdk/index.cjs'), { './session.cjs': sessionModule });
  const runtime = isolated({ directory: root, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'fake-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  runtime.credentials.save('sk-ant-offline-review-not-a-real-key'); disposers.get(root).push(() => runtime.close());
  const session = runtime.create({ owner: 'gui', cwd: root, env: { HOME: root, USERPROFILE: root, GIT_CEILING_DIRECTORIES: root } }, () => {});
  await session.start();
  try {
    await assert.rejects(session.shell('failed-shell-turn', 'service &'));
    await session.close(); assert.equal(ended, true, 'model failure cannot bypass waiting for owned shell disposal');
  } finally { await closed; }
});

test('S14 shell also removes Claude credential prefixes and custom API key names', async t => {
  const root = directory(t), names = ['ClAuDe_CoDe_SeSsIoN_AcCeSs_ToKeN', 'CLAUDE_AUTH_TOKEN', 'CLAUDE_API_KEY', 'CUSTOM_MODEL_API_KEY'];
  const script = 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(name=>' + JSON.stringify(names.map(name => name.toUpperCase())) + '.includes(name.toUpperCase()))))';
  const result = await require('../electron/features/claude-sdk/shell.cjs').runShell({ cwd: root,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: root, ...Object.fromEntries(names.map(name => [name, 'private'])) },
    command: 'node -e ' + JSON.stringify(script), signal: new AbortController().signal, output() {} });
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('helper completion waits for its log file handle to close', async t => {
  const root = directory(t), brief = path.join(root, 'brief.md'), out = path.join(root, 'answer.md');
  fs.writeFileSync(brief, 'Offline log lifetime'); let stream;
  const create = fs.createWriteStream;
  const mock = t.mock.method(fs, 'createWriteStream', function (...args) { stream = create.apply(this, args); return stream; });
  try {
    const code = await require('../integration/dispatch.cjs').run(['codex', '--role', 'review', '--title', 'Log lifetime', '--model', 'fixture',
      '--effort', 'high', '--read-only', '--cwd', root, '--brief', brief, '--out', out], {
      env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: root, GIT_CEILING_DIRECTORIES: root },
      stdout: { write() {} }, resolveExecutable: (_agent, args) => ({ file: process.execPath,
        args: [path.join(__dirname, 'fixtures/codex-app-server.cjs'), ...args] }),
    });
    assert.equal(code, 0); assert.equal(stream.closed, true, 'finish is not the same as closing the underlying file');
  } finally {
    mock.mock.restore();
    if (stream && !stream.closed) await require('node:events').once(stream, 'close');
  }
});
