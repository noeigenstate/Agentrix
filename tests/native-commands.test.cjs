const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { createIpcAdapter } = require('../electron/shared/ipc.cjs');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { listAgentCommands } = require('../electron/agent-commands.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const { createNormalizer } = require('../electron/features/claude-sdk/normalize.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('native command IPC is sender guarded, identity bound, and lazy file fallback starts no SDK query', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), config = path.join(root, 'custom-config');
  fs.mkdirSync(path.join(config, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(config, 'commands/offline.md'), '---\ndescription: Offline user command\n---\nHello');
  const fake = fakeSdk();
  const claude = createClaudeRuntime({ directory: path.join(root, 'state'), loadSdk: async () => fake.sdk, resolveExecutable: async () => 'synthetic-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  claude.credentials.save('sk-ant-offline-native-command-fixture');
  const native = createNativeSessions({ directory: path.join(root, 'native'), claude, codex: {}, emit() {},
    resolveSpec: id => { if (id !== 'terminal') throw new Error('removed'); return { projectId: 'p', terminalId: id, cwd: root, env: { HOME: home, CLAUDE_CONFIG_DIR: config } }; },
    readCommands: spec => listAgentCommands({ agent: spec.agent, projectPath: spec.cwd, home, claudeHome: config }) });
  t.after(() => native.close());
  const handlers = new Map(), webContents = { mainFrame: { url: 'agentrix://app/index.html' } };
  const { handle } = createIpcAdapter({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getWindow: () => ({ webContents }), t: value => value });
  native.register(handle);
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const { value: started } = await handlers.get('native:start')(event, 'terminal', { agent: 'claude' });
  const commands = handlers.get('native:commands'); assert.equal(typeof commands, 'function');
  const result = await commands(event, 'terminal', started.runtimeSessionId);
  assert.equal(result.ok, true);
  assert.ok(result.value.some(row => row.name === '/offline' && row.source === 'user'));
  assert.ok(result.value.some(row => row.name === '/compact'));
  assert.ok(result.value.every(row => row.view === 'reading'));
  assert.ok(result.value.some(row => row.name === '/clear'));
  assert.equal(result.value.some(row => row.name === '/permissions'), false);
  assert.equal(fake.calls.length, 0); assert.deepEqual(claude.usage.summary().monthUsdMicros, null);
  assert.ok(native.snapshot('terminal').events.every(row => !row.type.includes('command')));
  assert.equal((await commands(event, 'terminal', 'old-runtime')).ok, false);
  assert.equal((await commands(event, 'terminal', started.runtimeSessionId, { cwd: root })).ok, false);
  await assert.rejects(commands({ ...event, sender: {} }, 'terminal', started.runtimeSessionId), /Rejected IPC sender/);
  const sent = [], callbacks = new Map(); let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), { require: () => ({
    contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer: { invoke: (...args) => sent.push(args), on: (name, fn) => callbacks.set(name, fn) },
  }) });
  bridge.nativeSession.commands('terminal', started.runtimeSessionId);
  assert.deepEqual(sent, [['native:commands', 'terminal', started.runtimeSessionId]]);
});

test('SDK command pushes replace skills while native controls remain available', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-command-push-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = fakeSdk({ auto: false }), initial = [{ name: 'old-skill', description: 'Old' }, { name: 'context', description: 'Context', builtin: true }];
  const query = fake.sdk.query;
  fake.sdk.query = spec => ({ ...query(spec), supportedCommands: async () => initial });
  const claude = createClaudeRuntime({ directory: root, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'synthetic-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  claude.credentials.save('sk-ant-offline-native-command-fixture');
  t.after(() => claude.close());
  const session = claude.create({ cwd: root, env: { PATH: '' }, owner: 'gui', runtimeSessionId: randomUUID() }, () => {});
  await session.start(); await session.send({ clientMessageId: 'first', text: 'go' }); await tick();
  assert.ok((await session.commands([])).some(row => row.name === '/old-skill'));
  fake.emit({ type: 'system', subtype: 'init', session_id: fake.sessionId, apiKeySource: 'ANTHROPIC_API_KEY', slash_commands: ['context'], terminal_slash_commands: ['context'] });
  await tick(); assert.deepEqual(await session.commands([]), []);
  fake.emit({ type: 'system', subtype: 'commands_changed', commands: [
    { name: 'new-skill', description: 'New' }, { name: 'clear', aliases: ['reset', 'new'], builtin: true }, { name: 'context', builtin: true },
  ] }); await tick();
  assert.deepEqual((await session.commands([])).map(row => row.name), ['/clear', '/new-skill']);
});

test('local slash output renders once as assistant text without becoming an owner prompt or leaking wrappers', () => {
  const events = [], normalize = createNormalizer((type, payload, extra) => events.push({ type, payload, extra }));
  const compact = { type: 'user', uuid: 'compact-result', message: { content: '<local-command-stdout>Compacted </local-command-stdout>' } };
  normalize(compact); normalize(compact);
  normalize({ type: 'system', subtype: 'local_command_output', uuid: 'system-result', content: 'LOCAL OUTPUT' });
  normalize({ ...compact, uuid: 'history-machine', isReplay: true });
  normalize({ ...compact, uuid: 'live-sdk-replay', isReplay: true }, { live: true });
  assert.deepEqual(events.map(event => [event.payload.kind, event.payload.content.text]), [['agent-message', 'Compacted'], ['agent-message', 'LOCAL OUTPUT'], ['agent-message', 'Compacted']]);
});

test('a command reply resolved after its project closes is rejected before reaching the renderer', async () => {
  let alive = true, release;
  const provider = { apiState: () => ({ status: 'ready' }), create: () => ({
    start() {}, snapshot: () => ({ state: 'idle' }), close() {}, commands: () => new Promise(resolve => { release = resolve; }),
  }) };
  const router = createRouter({ claude: provider, codex: provider, emit() {}, settings: { get: () => ({ claudePath: 'api-only' }) },
    resolveSpec: id => { if (!alive) throw new Error('项目已关闭。'); return { terminalId: id, projectId: 'p' }; } });
  const started = await router.start('terminal', { agent: 'claude' });
  const pending = router.commands('terminal', started.runtimeSessionId); await tick();
  alive = false; release([{ name: '/old', description: 'Late result', source: 'project', view: 'reading' }]);
  await assert.rejects(pending, /项目已关闭/); await router.close();
});
