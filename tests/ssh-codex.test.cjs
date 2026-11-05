const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter, once } = require('node:events');
const { spawn } = require('node:child_process');
const { createRemoteCodexProcess } = require('../electron/features/ssh/codex-process.cjs');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const vm = require('node:vm');

function transport(t, root) {
  const events = new EventEmitter(), calls = [], processes = new Map();
  const connection = { events, link: { key: 'same-ssh-host' }, closed: false, close() { this.closed = true; events.emit('exit'); }, async request(op, params) {
    calls.push([op, params]);
    if (op === 'codex-open') {
      const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], {
        cwd: root, env: { ...process.env, GIT_CEILING_DIRECTORIES: root }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      processes.set(params.processId, child);
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => events.emit('codex-process', {
        type: 'codex-data', processId: params.processId, stream, data: bytes.toString('base64'),
      }));
      child.once('close', code => events.emit('codex-process', { type: 'codex-exit', processId: params.processId, code }));
    } else if (op === 'codex-input') processes.get(params.processId).stdin.write(Buffer.from(params.data, 'base64'));
    else if (op === 'codex-eof') processes.get(params.processId).stdin.end();
    else if (op === 'codex-close') {
      const child = processes.get(params.processId);
      if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'close'); child.kill(); await ended; }
    }
    return {};
  } };
  t.after(async () => { for (const child of processes.values()) if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'close'); child.kill(); await ended; } });
  return { connection, calls };
}

test('SSH Codex starts, sends, resumes and reads accounts solely through its remote byte channel', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-ssh-')), seen = [];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = transport(t, root), forbidden = () => assert.fail('SSH accessed local executable/account/process');
  const factory = createCodexRuntime({ resolveExecutable: forbidden, spawnProcess: forbidden,
    launchRemote: async () => ({ cwd: root, context: 'Remote instructions "quoted"\nsecond line', child: createRemoteCodexProcess(f.connection) }) });
  const runtime = factory.create({ kind: 'ssh', owner: 'gui', projectId: 'remote', cwd: '/srv/project' }, event => seen.push(event));
  t.after(() => runtime.close());
  const opened = await runtime.start(); assert.equal(runtime.pid, undefined);
  assert.equal((await runtime.send({ clientMessageId: 'owner', text: '你好' })).status, 'delivered');
  for (let at = 0; at < 100 && runtime.snapshot().state !== 'idle'; at++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(seen.some(event => event.type === 'turn.completed'));
  assert.equal((await runtime.readAccount()).kind, 'unknown');
  const concurrent = transport(t, root);
  const duplicate = createCodexRuntime({ resolveExecutable: forbidden, spawnProcess: forbidden,
    launchRemote: async () => ({ cwd: root, child: createRemoteCodexProcess(concurrent.connection) }) }).create({
    kind: 'ssh', owner: 'gui', projectId: 'another-project-on-same-host', providerSessionId: opened.providerSessionId, cwd: '/srv/project',
  }, () => {});
  t.after(() => duplicate.close());
  await assert.rejects(duplicate.resume(), /thread_in_use/);
  assert.equal(runtime.snapshot().state, 'idle', 'refusing another channel must keep the original session usable');
  await runtime.close(); assert.ok(f.connection.closed);
  const second = transport(t, root), resumed = createCodexRuntime({ resolveExecutable: forbidden, spawnProcess: forbidden,
    launchRemote: async () => ({ cwd: root, child: createRemoteCodexProcess(second.connection) }) }).create({
    kind: 'ssh', owner: 'gui', projectId: 'remote', providerSessionId: opened.providerSessionId, cwd: '/srv/project',
  }, () => {});
  t.after(() => resumed.close());
  assert.equal((await resumed.resume()).providerSessionId, opened.providerSessionId);
  await resumed.close();
  const inputs = f.calls.filter(([op]) => op === 'codex-input').map(([, params]) => Buffer.from(params.data, 'base64').toString()).join('');
  const start = inputs.trim().split('\n').map(JSON.parse).find(row => row.method === 'thread/start');
  assert.match(start.params.config.developer_instructions, /quoted/);
});

test('remote process IDs isolate output; a lost SSH channel fails once without local kill', async () => {
  const events = new EventEmitter(), calls = [], connection = { events, request: async (...args) => calls.push(args), close() {} };
  const child = createRemoteCodexProcess(connection), output = [];
  child.stdout.on('data', bytes => output.push(bytes.toString()));
  const id = calls[0][1].processId;
  events.emit('codex-process', { type: 'codex-data', processId: 'other', data: Buffer.from('foreign').toString('base64') });
  events.emit('codex-process', { type: 'codex-data', processId: id, data: Buffer.from('bound').toString('base64') });
  const closed = once(child, 'close'); events.emit('exit'); events.emit('exit');
  assert.equal((await closed)[0], 255); assert.deepEqual(output, ['bound']);
  assert.equal(events.listenerCount('codex-process'), 0);
});

test('main SSH specification preserves the remote resume folder without local files, credentials or terminal input', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const specs = new Map(), forbidden = () => assert.fail('SSH used local session setup');
  const context = vm.createContext({ findProject: () => ({ id: 'remote', kind: 'ssh', path: '/srv/project' }), sessions: new Map(), nativeSpecs: specs,
    store: { findTerminal: () => ({ record: { restore: { agent: 'codex', threadId: 'remote-thread', cwd: '/srv/project/subfolder' } } }) },
    randomUUID: require('node:crypto').randomUUID, fs: { writeFileSync: forbidden }, createTerminalEnvironment: forbidden, disposeTerminal: forbidden });
  vm.runInContext(source.slice(source.indexOf('function nativeSpec('), source.indexOf('function structuredEvent(')), context);
  const spec = context.nativeSpec('terminal', 'codex', true);
  assert.equal(spec.kind, 'ssh'); assert.equal(spec.cwd, '/srv/project/subfolder'); assert.equal(spec.providerSessionId, 'remote-thread');
  assert.deepEqual(Object.keys(spec.env), []); assert.throws(() => context.nativeSpec('terminal', 'claude', false), /SSH/);
});

test('SSH usage holds remote native limits without consulting local usage inputs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-ssh-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const facade = require('../electron/features/native-session/index.cjs').createNativeSessions({ directory: root,
    claude: { usage: { summary: () => ({}) }, apiState: () => ({ status: 'no_key' }) }, codex: {}, emit() {},
    validateProject: () => ({ kind: 'ssh' }), usageInputs: () => assert.fail('SSH read local accounts/CLI'),
    connections: () => ({ codex: { kind: 'subscription', active: true, source: 'remote app-server', observedAt: 1 } }),
  });
  t.after(() => facade.close());
  const usage = await facade.usage('remote'); assert.equal(usage.agents.claude.path, null);
  assert.equal(usage.agents.codex.next.path, 'native'); assert.equal(usage.agents.codex.connection.source, 'remote app-server');
});

test('missing remote Codex preserves a typed actionable startup failure', async () => {
  const connection = { events: new (require('node:events').EventEmitter)(), close() {}, request: async () => {
    throw Object.assign(new Error('远端未找到 Codex 程序。'), { code: 'codex_cli_required' });
  } };
  const runtime = createCodexRuntime({ launchRemote: async () => ({ cwd: process.cwd(), child: createRemoteCodexProcess(connection) }) })
    .create({ kind: 'ssh', owner: 'gui', cwd: '/remote' }, () => {});
  await assert.rejects(runtime.start(), { code: 'codex_cli_required' }); await runtime.close();
});


test('N10 SSH thread history uses its remote byte channel and closes the lookup without account or model requests', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-ssh-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const f = transport(t, root), forbidden = () => assert.fail('remote history consulted local executables'); let options;
  const factory = createCodexRuntime({ resolveExecutable: forbidden, spawnProcess: forbidden, launchRemote: async (_spec, config) => {
    options = config; return { cwd: root, child: createRemoteCodexProcess(f.connection) };
  } });
  const found = await factory.history({ kind: 'ssh', cwd: '/srv/project', projectId: 'remote' });
  assert.equal(found.id, 'synthetic-thread'); assert.equal(options.readOnly, true); assert.equal(f.connection.closed, true);
  const messages = f.calls.filter(([op]) => op === 'codex-input').flatMap(([, p]) => Buffer.from(p.data, 'base64').toString().trim().split('\n').map(JSON.parse));
  assert.ok(messages.some(message => message.method === 'thread/list'));
  assert.ok(!messages.some(message => /account|turn\/start/.test(message.method)));
});


test('N10 history lookup preserves the actionable missing-remote-Codex reason', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const start = source.indexOf('    readHistory: '), end = source.indexOf('    readCommands:', start);
  const expression = source.slice(start, end).trim().replace(/^readHistory: /, '').replace(/,$/, '');
  const project = { kind: 'ssh', id: 'remote', path: '/srv' };
  const lookup = vm.runInNewContext('(' + expression + ')', { findProject: () => project,
    store: { findTerminal: () => ({ record: { restore: {} } }) }, randomUUID: () => 'fixture', t: value => value,
    codexFactory: { history: async () => { throw Object.assign(new Error('codex_cli_required'), { code: 'codex_cli_required' }); } } });
  await assert.rejects(lookup('terminal'), error => error.code === 'codex_cli_required' && /远端未找到 Codex/.test(error.message));
});


test('N10 aborting a history lookup before SSH connects reaps the late channel', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-history-abort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const f = transport(t, root), abort = new AbortController(); let release, linked;
  const factory = createCodexRuntime({ launchRemote: async (_spec, options) => { linked = options.signal; return new Promise(resolve => { release = resolve; }); } });
  const pending = factory.history({ kind: 'ssh', cwd: '/srv/project' }, { signal: abort.signal }).then(value => ({ value }), error => ({ error }));
  abort.abort(); const canceledBeforeReady = linked.aborted;
  release({ cwd: root, child: createRemoteCodexProcess(f.connection) }); const result = await pending;
  assert.equal(canceledBeforeReady, true); assert.ok(result.error); assert.equal(f.connection.closed, true);
  assert.ok(!f.calls.some(([op]) => op === 'codex-input'), 'canceled lookup sends no initialize or thread/list');
});
