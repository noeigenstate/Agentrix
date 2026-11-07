const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TokenRates } = require('../electron/features/agents/token-rate.cjs');
const { createNativeUsage } = require('../electron/features/native-session/agent-usage.cjs');
const { validEvent } = require('../electron/features/native-session/validate.cjs');
const { createEvents } = require('../electron/features/codex-app-server/events.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const start = (id, model = 'claude-opus-5-5') => ({ type: 'stream_event', event: { type: 'message_start', message: { id, model, usage: { output_tokens: 0 } } } });
const delta = output => ({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: output } } });
test('native Claude uses the shared response samples, excludes child streams and all parallel tool wait', () => {
  const meter = new TokenRates('claude'); meter.nativeBegin(1000);
  meter.nativeClaude(start('r1'), 1500); meter.nativeClaude(delta(10), 2000);
  assert.equal(meter.snapshot().outputTokens, 10); assert.equal(meter.snapshot().activeMs, 1000);
  for (const id of ['a', 'b']) meter.nativeClaude({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id } } }, 2000);
  meter.nativeClaude(delta(20), 3000);
  meter.nativeClaude({ type: 'stream_event', event: { type: 'message_stop' } }, 3000);
  meter.nativeClaude({ type: 'assistant', message: { id: 'r1', model: 'claude-opus-5-5', usage: { output_tokens: 20 } } }, 4000);
  for (const message of [start('child', 'claude-haiku-5-5'), delta(999)]) meter.nativeClaude({ ...message, parent_tool_use_id: 'a' }, 4500);
  meter.nativeClaude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } }, 7000);
  meter.nativeClaude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b' }] } }, 9000);
  meter.nativeClaude(start('r2'), 9500); meter.nativeClaude(delta(20), 11000);
  assert.deepEqual(meter.snapshot(), { outputTokens: 40, activeMs: 4000, samples: 2, updatedAt: 11000, partial: false });
  meter.nativeEnd(); meter.nativeClaude(delta(999), 19000);
  assert.equal(meter.snapshot().outputTokens, 40, 'turn totals never count child consumption or idle');
  meter.nativeBegin(20000); meter.nativeClaude(start('r3', 'claude-sonnet-5-5'), 21000); meter.nativeClaude(delta(5), 22000);
  assert.equal(meter.snapshot().outputTokens, 5, 'models keep separate rates');
  assert.equal(meter.snapshot('claude-opus-5-5').outputTokens, 40);
});

test('a one-token response finalizes its latency even when the final counter has not increased', () => {
  const meter = new TokenRates('claude'); meter.nativeBegin(1000);
  const opening = start('one-token'); opening.event.message.usage.output_tokens = 1;
  meter.nativeClaude(opening, 1500);
  meter.nativeClaude({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'one' } } }, 2000);
  meter.nativeClaude({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } }, 2500);
  meter.nativeClaude({ type: 'stream_event', event: { type: 'message_stop' } }, 2600);
  meter.nativeClaude({ type: 'assistant', message: { id: 'one-token', model: 'claude-opus-5-5', usage: { output_tokens: 1 } } }, 3000);
  assert.equal(meter.snapshot().activeMs, 1500); assert.equal(meter.snapshot().samples, 1); assert.equal(meter.snapshot().outputTokens, 1);
});

test('native response counters never estimate from text, replay, absent usage, synthetic models or invalid clocks', () => {
  for (const value of [null, undefined, -1, NaN, 1.5]) {
    const meter = new TokenRates('claude'); meter.nativeBegin(1000); meter.nativeClaude(start('reply'), 1100);
    meter.nativeClaude({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'many words' } } }, 1200);
    meter.nativeClaude(delta(value), 1300); assert.equal(meter.snapshot().samples, 0);
  }
  for (const [message, at] of [[{ ...start('r'), isReplay: true }, 1200], [start('r', '<synthetic>'), 1200], [start('r'), 999]]) {
    const meter = new TokenRates('claude'); meter.nativeBegin(1000); meter.nativeClaude(message, at); meter.nativeClaude(delta(10), at);
    assert.equal(meter.snapshot().samples, 0);
  }
  const meter = new TokenRates('claude'); meter.nativeBegin(1000); meter.nativeClaude(start('r'), 1100); meter.nativeClaude(delta(10), 2000);
  for (const message of [{ ...delta(900), isSidechain: true }, { ...delta(900), isReplay: true }, delta(5)]) meter.nativeClaude(message, 3000);
  assert.equal(meter.snapshot().outputTokens, 10);
});

test('native Codex counts provider output including reasoning once, ending responses before tool waits', () => {
  const meter = new TokenRates('codex'); meter.setModel('gpt-6.1-sol', 0); meter.nativeBegin(1000);
  meter.nativeCodex('item/started', { item: { id: 'tool', type: 'commandExecution' } }, 3000);
  meter.nativeCodex('thread/tokenUsage/updated', { tokenUsage: { total: { outputTokens: 100 }, last: { outputTokens: 100, reasoningOutputTokens: 60 } } }, 8000);
  meter.nativeCodex('item/completed', { item: { id: 'tool', type: 'commandExecution' } }, 9000);
  meter.nativeCodex('item/agentMessage/delta', { delta: 'answer' }, 11000);
  meter.nativeCodex('item/completed', { item: { id: 'reply', type: 'agentMessage' } }, 12000);
  const usage = { tokenUsage: { total: { outputTokens: 150 }, last: { outputTokens: 50 } } };
  meter.nativeCodex('thread/tokenUsage/updated', usage, 14000); meter.nativeCodex('thread/tokenUsage/updated', usage, 15000);
  assert.deepEqual(meter.snapshot(), { outputTokens: 150, activeMs: 5000, samples: 2, updatedAt: 12000, partial: false });
});

test('empty Codex counters, shell output and stale-turn deltas cannot create or corrupt a model sample', () => {
  let now = 1000;
  const events = createEvents({ runtimeSessionId: 'r', terminalId: 't', projectId: 'p' }, () => {}, () => now);
  events.binding.turnId = 'turn'; events.publish('routing.updated', { effective: { model: 'gpt-6.1-sol' } });
  events.publish('turn.started', { origin: 'user', clientMessageId: 'input' });
  now = 1500; events.notification('item/commandExecution/outputDelta', { turnId: 'turn', itemId: 'shell', delta: 'not model output' });
  events.notification('item/agentMessage/delta', { turnId: 'old-turn', itemId: 'stale', delta: 'old response' });
  events.notification('thread/tokenUsage/updated', { turnId: 'turn', tokenUsage: { total: { outputTokens: 0 }, last: { outputTokens: 0 } } });
  assert.equal(events.tokenRate().samples, 0);
  now = 2000; events.notification('item/agentMessage/delta', { turnId: 'turn', itemId: 'reply', delta: 'new response' });
  events.notification('thread/tokenUsage/updated', { turnId: 'turn', tokenUsage: { total: { outputTokens: 1 }, last: { outputTokens: null } } });
  now = 2500; events.notification('thread/tokenUsage/updated', { turnId: 'turn', tokenUsage: { total: { outputTokens: 20 }, last: { outputTokens: 20 } } });
  assert.equal(events.tokenRate().activeMs, 1000); assert.equal(events.tokenRate().outputTokens, 20);
});

test('the native usage bridge reads host-only rates and keeps the final rate at idle', () => {
  let now = 1000; const usage = createNativeUsage('codex'), records = [];
  const events = createEvents({ projectId: 'p', terminalId: 't', runtimeSessionId: 'r' }, event => { records.push(event); usage.apply(event, event.type === 'usage.updated' ? events.tokenRate() : null); }, () => now);
  events.binding.providerSessionId = 'thread'; events.binding.turnId = 'turn';
  events.publish('routing.updated', { effective: { model: 'gpt-6.1-sol' } }); events.publish('turn.started', { origin: 'user', clientMessageId: 'input' });
  assert.equal(usage.snapshot().rate, null);
  now = 2000; events.notification('item/agentMessage/delta', { itemId: 'reply', delta: 'hello' });
  now = 3000; events.notification('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 10, outputTokens: 20 }, last: { outputTokens: 20 } } });
  const rate = usage.snapshot().rate;
  assert.equal(rate.outputTokens, 20); assert.equal(rate.activeMs, 1000);
  assert.ok(records.filter(row => row.type === 'usage.updated').every(validEvent));
  events.publish('turn.completed', { status: 'completed' }); events.publish('session.state', { state: 'idle' });
  assert.deepEqual(usage.snapshot().rate, rate);
  usage.apply({ type: 'usage.updated', replay: true, payload: { rate: { outputTokens: 999 } } }); assert.deepEqual(usage.snapshot().rate, rate);
  assert.ok(records.every(row => !('rate' in row.payload)), 'provider event protocol stays unchanged');
});

test('native rate reads are bound to the current runtime, including SSH, with no renderer command', async t => {
  for (const kind of ['local', 'ssh']) {
    const expected = { model: 'gpt-6.1-sol', outputTokens: 10, activeMs: 1000, samples: 1, updatedAt: 2000, partial: false };
    const provider = { create: () => ({ start: async () => ({}), close: async () => {}, snapshot: () => ({ state: 'idle' }), tokenRate: () => expected }) };
    const router = createRouter({ codex: provider, claude: { apiState: () => ({ status: 'ready' }) }, settings: { get: () => ({}) },
      emit() {}, resolveSpec: () => ({ owner: 'gui', agent: 'codex', kind, cwd: '/fixture', projectId: 'p', terminalId: 't' }) });
    t.after(() => router.close()); const binding = await router.start('t', { agent: 'codex' });
    assert.deepEqual(router.tokenRate('t', binding.runtimeSessionId), expected);
    assert.throws(() => router.tokenRate('t', 'old-runtime'), /会话已变化/);
  }
});

test('the actual main structured-event bridge supplies the provider rate to agentUsage', () => {
  const sample = { model: 'claude-opus-5-5', outputTokens: 20, activeMs: 1000, samples: 1, updatedAt: 2000, partial: false };
  let reads = 0;
  class Queue { enqueue() {} start() {} }
  const context = { quitting: false, sessions: new Map(), nativeSpecs: new Map([['t', { agent: 'claude' }]]),
    store: { findTerminal: () => ({ project: { id: 'p' } }) }, scheduleState() {}, createNativeUsage,
    PromptQueue: Queue, CompletionWork: Queue, ActionLog: Queue, ConversationLog: Queue,
    nativeSessions: { tokenRate(id, runtime) { reads++; assert.equal(id, 't'); assert.equal(runtime, 'r'); return sample; } } };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function structuredEvent('), source.indexOf('async function readNativeConnections(')), context);
  context.structuredEvent('t', { runtimeSessionId: 'r', type: 'session.state', payload: { state: 'starting' } });
  context.structuredEvent('t', { runtimeSessionId: 'r', type: 'usage.updated', payload: { input: 2, output: 20, cachedInput: 0, cacheWrite: 0 } });
  const snapshot = context.sessions.get('t').nativeUsage.snapshot();
  assert.equal(snapshot.rate.outputTokens, 20); assert.equal(snapshot.rate.activeMs, 1000); assert.equal(snapshot.model, sample.model);
  context.structuredEvent('t', { runtimeSessionId: 'r', replay: true, type: 'usage.updated', payload: {} });
  assert.equal(reads, 1);
});

test('native response bookkeeping stays bounded while per-model sums retain older samples', () => {
  const meter = new TokenRates('claude');
  for (let i = 0; i < 300; i++) {
    meter.nativeBegin(i * 100); meter.nativeClaude(start('response-' + i), i * 100 + 1); meter.nativeClaude(delta(10), i * 100 + 50); meter.nativeEnd();
  }
  assert.equal(meter.replies.size, 256);
  assert.equal(meter.snapshot().outputTokens, 3000); assert.equal(meter.snapshot().activeMs, 15000); assert.equal(meter.snapshot().samples, 300);
});
