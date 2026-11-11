const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
function host() {
  const queued = [];
  const terminal = { nativeStructured: true, nativeRuntimeSessionId: 'runtime', promptQueue: { enqueue: text => queued.push(text), start() {} }, completionWork: { begin() {} }, nativeMessages: new Map() };
  const starts = [], activity = [], restored = [], sessions = new Map([['t', terminal]]);
  // A usage update reads the bound runtime's token rate from the router; this host's runtime has no meter.
  const context = { createNativeUsage: require('../electron/features/native-session/agent-usage.cjs').createNativeUsage, quitting: false, nativeSpecs: new Map([['t', { agent: 'claude' }]]), sessions, scheduleState() {}, t: text => text,
    nativeSessions: { tokenRate(id, runtimeSessionId) { assert.deepEqual([id, runtimeSessionId], ['t', 'runtime']); return null; } },
    store: { findTerminal: () => ({ project: { id: 'p' } }), expectCompletion: id => starts.push(id), setRestore: (id, patch) => restored.push({ id, patch }) },
    applyActivity: (_project, _session, snapshot) => activity.push(snapshot) };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function structuredEvent('), source.indexOf('async function initializeNativeSessions(')), context);
  return { ...context, starts, activity, restored, terminal, queued };
}
test('G2 real main structured events populate the same terminal agentUsage fields without a terminal meter', () => {
  const main = host();
  main.structuredEvent('t', event('turn.started', { origin: 'user', clientMessageId: 'usage' }));
  main.structuredEvent('t', event('usage.updated', { input: 100, cachedInput: 20, cacheWrite: 10, output: 5, reasoning: null,
    contextWindow: 234567, contextTokens: 88, costUsdMicros: 3000, costEstimated: true,
    round: { input: 50, cachedInput: 2, cacheWrite: 3, output: 4, reasoning: null } }));
  const s = main.sessions.get('t');
  const expression = source.slice(source.indexOf('agentUsage: s?.nativeStructured') + 'agentUsage: '.length, source.indexOf('\n          // A run of the CLI')).trim().replace(/,$/, '');
  const usage = vm.runInNewContext(expression, { s, dispatchedOnly() { throw new Error('not a terminal fallback'); } });
  assert.deepEqual(usage.context, { used: 88, window: 234567 }); assert.deepEqual(usage.round, { input: 55, cached: 2, output: 4 });
  assert.deepEqual(usage.total, { input: 130, cached: 20, output: 5 });
  main.structuredEvent('t', event('usage.updated', { input: null, cachedInput: null, cacheWrite: null, output: null, contextWindow: null }));
  assert.equal(s.nativeUsage.snapshot().context, null, 'no hard-coded window');
});
const event = (type, payload, replay = false) => ({ type, payload, replay, runtimeSessionId: 'runtime', providerSessionId: 'provider', turnId: 'turn', receivedAtMs: 1 });

test('N8 an outdated Claude upgrade notice survives terminal fallback without a replay notification', () => {
  const main = host(), message = 'Claude Code 版本过低，请升级到 2.1.317 或更高';
  main.structuredEvent('t', event('error', { code: 'native_cli_outdated', message }, true));
  assert.equal(main.store.warning, undefined);
  main.structuredEvent('t', event('error', { code: 'native_cli_outdated', message }));
  main.structuredEvent('t', event('session.state', { state: 'stopped', reason: 'native_cli_required' }));
  assert.equal(main.store.warning, message);
});

test('fallback recovery drafts never enter the native sent-message queue', () => {
  const main = host();
  main.structuredEvent('t', event('item.upsert', { kind: 'user-message', content: { text: 'unsent draft', clientMessageId: 'draft', unsent: true } }));
  assert.deepEqual(main.queued, []); assert.equal(main.terminal.nativeMessages.size, 0);
  main.structuredEvent('t', event('item.upsert', { kind: 'user-message', content: { text: 'actually sent', clientMessageId: 'sent' } }));
  assert.deepEqual(main.queued, ['actually sent']); assert.equal(main.terminal.nativeMessages.get('sent'), 'actually sent');
});
test('native main arms completion only for an explicit user turn and ignores replay and idle updates', () => {
  const main = host();
  main.structuredEvent('t', event('turn.started', { origin: 'resume', clientMessageId: null }));
  main.structuredEvent('t', event('turn.started', { origin: 'automatic', clientMessageId: null }));
  main.structuredEvent('t', event('turn.started', { origin: 'user', clientMessageId: 'm' }, true));
  main.structuredEvent('t', event('session.state', { state: 'idle', reason: null }));
  assert.equal(main.starts.length, 0);
  main.structuredEvent('t', event('turn.started', { origin: 'user', clientMessageId: 'm' }));
  main.structuredEvent('t', event('usage.updated', { input: 10 }));
  main.structuredEvent('t', event('turn.completed', { status: 'completed', error: null }));
  assert.equal(main.starts.length, 1); assert.equal(main.activity.at(-1).state, 'complete');
});
test('native stop preserves resume identity while marking its saved launch inactive', () => {
  const main = host(); main.structuredEvent('t', event('session.state', { state: 'stopped', reason: null }));
  assert.equal(main.terminal.codexActive, false); assert.equal(main.terminal.claudeSessionId, 'provider');
  assert.equal(main.restored[0].patch.codex, false); assert.equal(main.restored[0].patch.threadId, undefined);
});
test('late native shutdown events cannot recreate a disposed host session', () => {
  const main = host(); main.sessions.delete('t');
  main.structuredEvent('t', event('session.state', { state: 'stopping', reason: null }));
  main.structuredEvent('t', event('session.state', { state: 'stopped', reason: null }));
  assert.equal(main.sessions.size, 0);
});

test('M5 failed native initialization keeps terminal starts and safe settings available', async () => {
  const handlers = new Map(), starts = [], plans = new Map();
  const context = { randomUUID: () => 'fallback-runtime', launchPlans: plans, readNativeConnections: async () => ({}),
    claudeRuntime: null, readNativeSubscriptionLimits: () => ({}),
    findProject: id => { assert.equal(id, 't'); return { kind: 'local' }; },
    store: { findTerminal: () => ({ record: { restore: { agent: 'claude', threadId: '11111111-1111-4111-8111-111111111111' } } }) },
    launchCommand: (agent, history) => ({ agent, history }), startTerminal: (...args) => starts.push(args), broadcast() {} };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function registerUnavailableNative('), source.indexOf('function registerIpc(')), context);
  context.registerUnavailableNative((name, handler) => handlers.set(name, handler));
  assert.equal(handlers.get('native:settings-get')().claudePath, 'terminal-only');
  assert.equal((await handlers.get('native:usage')()).agents.codex.path, null);
  assert.throws(() => handlers.get('native:start')('t', { agent: 'codex' }), /^Error: Codex 原生模式连接失败，请重试。$/);
  assert.equal(starts.length, 0, 'Codex has no terminal start to fall back to');
  assert.equal(handlers.get('native:start')('t', { agent: 'claude', resume: true }).runtimeSessionId, 'fallback-runtime');
  assert.equal(plans.get('t').threadId, '11111111-1111-4111-8111-111111111111');
  assert.equal(starts.length, 1);
  assert.throws(() => handlers.get('native:start')('t', { agent: 'claude', cwd: '/renderer-injected' }));
  assert.throws(() => handlers.get('native:send')(), /原生会话暂不可用/);
});

// The router's readHistory runs in main's module scope: here it sees only what that scope really declares (findProject, folderOf),
// so a name that lives inside another function fails as it would in the app.
function historyReader({ project, spec, restore = {} }) {
  const start = source.indexOf('    readHistory: '), end = source.indexOf('    readCommands:', start), folders = [], lookups = [];
  const context = { nativeSpecs: new Map(spec ? [['t', spec]] : []), randomUUID: () => 'fixture', t: text => text,
    store: { findTerminal: id => id === 't' ? { project, record: { restore } } : null },
    folderHistory: async folder => { folders.push(folder); return { claude: { id: 'claude-latest' }, codex: null }; },
    codexFactory: { history: async lookup => { lookups.push(lookup); return { id: 'codex-latest' }; } } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function findProject('), source.indexOf('function publicState(')), context);
  return { read: vm.runInContext(`(${source.slice(start, end).trim().replace(/^readHistory: /, '').replace(/,$/, '')})`, context), folders, lookups };
}
test('a local Claude native session reads its folder history: the restored cwd, else the project folder', async () => {
  const project = { kind: 'local', id: 'p', path: '/project' };
  for (const [spec, restore, folder] of [[{ agent: 'claude' }, { cwd: '/project/restored' }, '/project/restored'], [{ agent: 'claude' }, {}, '/project'], [null, {}, '/project']]) {
    const main = historyReader({ project, spec, restore });
    assert.equal((await main.read('t')).claude.id, 'claude-latest');
    assert.deepEqual(main.folders, [folder]); assert.deepEqual(main.lookups, []);
  }
});
test('local Codex and every SSH native session read history through the app-server, never the folder', async () => {
  for (const [kind, agent] of [['local', 'codex'], ['ssh', 'codex'], ['ssh', 'claude']]) {
    const main = historyReader({ project: { kind, id: 'p', path: '/project' }, spec: { agent, cwd: '/project/sub' }, restore: { cwd: '/previous' } });
    const history = await main.read('t');
    assert.equal(history.claude, null); assert.equal(history.codex.id, 'codex-latest');
    assert.deepEqual(main.folders, []); assert.equal(main.lookups.length, 1);
    assert.deepEqual([main.lookups[0].kind, main.lookups[0].cwd, main.lookups[0].terminalId], [kind, '/project/sub', 't']);
  }
});

// 1.4.0-beta.2: codex typed in a new terminal hands it to a native session, and the raw view it leaves reports its focus
// going (ConPTY turns focus reports on) to a host that has no PTY and no prompt tracker: the toast read "Cannot read
// properties of undefined (reading 'write')". Main's own host record, terminal wiring and IPC adapter run here.
test('the raw view a native session replaced reaches no PTY: its replies are dropped and its keys refused, before and after the host exists', () => {
  const { registerTerminalIpc } = require('../electron/features/terminal/ipc.cjs'), { createIpcAdapter } = require('../electron/shared/ipc.cjs');
  const sessions = new Map(), nativeSpecs = new Map([['t', { agent: 'codex', sessionId: 'native', sessionKey: 'key', env: {} }]]);
  let wiring;
  const context = { sessions, nativeSpecs, quitting: false, scheduleState() {}, t: text => text, nativeSessions: {},
    store: { findTerminal: () => ({ project: { id: 'p' } }) }, registerTerminalIpc: value => { wiring = value; },
    createNativeUsage: require('../electron/features/native-session/agent-usage.cjs').createNativeUsage,
    PromptQueue: require('../electron/prompt-queue.cjs').PromptQueue, CompletionWork: require('../electron/completion-work.cjs').CompletionWork,
    ActionLog: require('../electron/agent-actions.cjs').ActionLog, ConversationLog: require('../electron/conversation.cjs').ConversationLog };
  for (const name of ['handle', 'listen', 'findProject', 'startTerminal', 'confirmTerminalClose', 'disposeTerminal', 'broadcast', 'applyActivity', 'pollAfterSubmission', 'send']) context[name] = () => assert.fail(name);
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function structuredEvent('), source.indexOf('async function readNativeConnections(')), context);
  const registration = source.indexOf('terminalInput = registerTerminalIpc(');
  vm.runInContext(source.slice(registration, source.indexOf('registerClipboardIpc(', registration)), context);
  const reports = [], listeners = new Map(), webContents = { mainFrame: { url: 'agentrix://app/index.html' } };
  registerTerminalIpc({ ...wiring, ...createIpcAdapter({ ipcMain: { handle() {}, on: (name, run) => listeners.set(name, run) },
    getWindow: () => ({ webContents }), t: text => text, report: error => reports.push(String(error?.message || error)) }) });
  const write = calls => {
    reports.length = 0;
    for (const args of calls) listeners.get('terminal:write')({ sender: webContents, senderFrame: webContents.mainFrame }, 't', ...args);
    return [...reports];
  };
  const replies = [['\x1b[O'], ['\x1b[I'], ['\x1b[1;1R'], ['\x1b[?1;2c']], keys = [['codex'], ['\r'], ['sign-in code', true]];
  const refused = keys.map(() => '请使用原生会话输入框。');
  // The native start has disposed the PTY and its host is not reported yet.
  assert.deepEqual(write(replies), []); assert.deepEqual(write(keys), refused);
  context.structuredEvent('t', event('session.state', { state: 'starting' }));
  assert.equal(sessions.get('t').nativeStructured, true);
  assert.deepEqual(write(replies), [], 'protocol replies of the replaced terminal have no PTY to reach');
  assert.deepEqual(write(keys), refused, 'keys typed into the replaced terminal are refused with a reason');
});
