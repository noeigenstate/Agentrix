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
  const context = { createNativeUsage: require('../electron/features/native-session/agent-usage.cjs').createNativeUsage, quitting: false, nativeSpecs: new Map([['t', { agent: 'claude' }]]), sessions, scheduleState() {}, t: text => text,
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
  assert.equal((await handlers.get('native:usage')()).agents.codex.path, 'terminal');
  assert.equal(handlers.get('native:start')('t', { agent: 'claude', resume: true }).runtimeSessionId, 'fallback-runtime');
  assert.equal(plans.get('t').threadId, '11111111-1111-4111-8111-111111111111');
  assert.equal(starts.length, 1);
  assert.throws(() => handlers.get('native:start')('t', { agent: 'claude', cwd: '/renderer-injected' }));
  assert.throws(() => handlers.get('native:send')(), /原生会话暂不可用/);
});
