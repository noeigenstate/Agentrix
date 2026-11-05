require('./fixtures/team-isolation.cjs');
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
for (const kind of ['local', 'ssh']) test(`N10 ${kind} history lookup resumes the listed thread without a model or account read`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-history-')), home = path.join(root, 'codex');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const threadId = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(home, 'sessions', 'rollout-' + threadId + '.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd: root } }) + '\n');
  const env = { ...process.env, CODEX_HOME: home, GIT_CEILING_DIRECTORIES: root }, methods = [], children = [], runtimes = [];
  let readOnly;
  const launch = () => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/gui-codex-app-server.cjs')], { cwd: root, env, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    const write = child.stdin.write.bind(child.stdin); child.stdin.write = (line, ...args) => { methods.push(JSON.parse(line)); return write(line, ...args); };
    children.push(child); return child;
  };
  const forbidden = () => assert.fail('SSH history used a local resolver');
  const factory = createCodexRuntime({ resolveExecutable: kind === 'ssh' ? forbidden : async () => 'fixture', spawnProcess: kind === 'ssh' ? forbidden : launch,
    launchRemote: async (_spec, options) => { readOnly = options.readOnly; return { cwd: root, child: launch() }; } });
  t.after(async () => { for (const runtime of runtimes.reverse()) await runtime.close(); for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const spec = { kind, cwd: kind === 'ssh' ? '/remote/project' : root, env, projectId: 'p', terminalId: 't', owner: 'gui' };
  const history = await factory.history(spec); assert.equal(history.id, threadId);
  if (kind === 'ssh') assert.equal(readOnly, true, 'lookup does not consume a first-open delivery');
  assert.ok(methods.some(row => row.method === 'thread/list')); assert.ok(!methods.some(row => /account|turn\/start/.test(row.method)));
  const facade = createNativeSessions({ directory: path.join(root, 'state'), codex: factory, claude: { apiState: () => ({ status: 'no_key' }) },
    resolveSpec: () => spec, readHistory: async () => ({ codex: history }), emit() {}, terminal: forbidden }); runtimes.push(facade);
  await facade.start('t', { agent: 'codex', resume: true });
  assert.equal(facade.snapshot('t').events.find(event => event.providerSessionId)?.providerSessionId, threadId);
  assert.ok(methods.some(row => row.method === 'thread/resume')); assert.ok(!methods.some(row => row.method === 'turn/start' && row.params?.threadId));
});
for (const last of ['task_started', 'task_complete']) test(`N3 continuation verifies the actual app-server last turn (${last}) and sends once`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-resume-')), home = path.join(root, 'codex'), threadId = '11111111-1111-4111-8111-111111111111';
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'sessions', 'rollout-' + threadId + '.jsonl'), [{ type: 'session_meta', payload: { id: threadId, cwd: root } }, { type: 'event_msg', payload: { type: last } }].map(JSON.stringify).join('\n') + '\n');
  const methods = []; let facade;
  t.after(async () => { await facade?.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const factory = createCodexRuntime({ resolveExecutable: async () => 'fixture', spawnProcess: (_file, _args, options) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/gui-codex-app-server.cjs')], { ...options, env: { ...options.env, CODEX_HOME: home, GIT_CEILING_DIRECTORIES: root } });
    const write = child.stdin.write.bind(child.stdin); child.stdin.write = (line, ...args) => { methods.push(JSON.parse(line)); return write(line, ...args); }; return child;
  } });
  facade = createNativeSessions({ directory: root, codex: factory, claude: { apiState: () => ({ status: 'no_key' }) }, resolveSpec: () => ({ cwd: root, providerSessionId: threadId }), emit() {}, terminal() { assert.fail(); } });
  const opened = await facade.start('t', { agent: 'codex', resume: true }); let cleared = 0;
  await facade.continueInterrupted('t', opened.runtimeSessionId, () => cleared++);
  await facade.continueInterrupted('t', opened.runtimeSessionId, () => cleared++);
  assert.ok(methods.some(row => row.method === 'thread/turns/list'));
  assert.equal(methods.filter(row => row.method === 'turn/start' && row.params?.threadId).length, last === 'task_started' ? 1 : 0);
  assert.equal(cleared, last === 'task_started' ? 1 : 0);
});


test('N10 forgetting a terminal aborts its read-only history lookup', async () => {
  let signal, reads = 0;
  const { createRouter } = require('../electron/features/native-session/router.cjs');
  const router = createRouter({ claude: {}, settings: { get: () => ({}) }, resolveSpec() {}, emit() {},
    readHistory: async (_id, options) => { signal = options?.signal; if (!signal || ++reads > 1) return null;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('lookup_canceled')), { once: true })); } });
  const pending = router.history('terminal').then(value => ({ value }), error => ({ error }));
  for (let n=0; n<10 && !signal; n++) await Promise.resolve();
  await router.forget('terminal'); const result = await pending;
  assert.equal(signal?.aborted, true); assert.match(result.error.message, /lookup_canceled/); await router.close();
  await assert.rejects(router.history('terminal'), /session_closed/); assert.equal(reads, 1);
});


test('N10 main disposal cancels history even before a terminal process exists', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8'); let canceled = 0;
  const context = { readingHistory: { close() {} }, sessions: new Map(), nativeSpecs: new Map(),
    nativeSessions: { forget: async () => { canceled++; } }, report() {} };
  require('node:vm').runInNewContext(source.slice(source.indexOf('function disposeTerminal('), source.indexOf('function registerUnavailableNative(')), context);
  context.disposeTerminal('loading-history'); assert.equal(canceled, 1);
});
