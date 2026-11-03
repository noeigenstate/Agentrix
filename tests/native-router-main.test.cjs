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
  const context = { quitting: false, nativeSpecs: new Map([['t', { agent: 'claude' }]]), sessions, scheduleState() {},
    store: { findTerminal: () => ({ project: { id: 'p' } }), expectCompletion: id => starts.push(id), setRestore: (id, patch) => restored.push({ id, patch }) },
    applyActivity: (_project, _session, snapshot) => activity.push(snapshot) };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function structuredEvent('), source.indexOf('async function initializeNativeSessions(')), context);
  return { ...context, starts, activity, restored, terminal, queued };
}
const event = (type, payload, replay = false) => ({ type, payload, replay, runtimeSessionId: 'runtime', providerSessionId: 'provider', turnId: 'turn', receivedAtMs: 1 });

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
