const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { createNativeUsage } = require('../electron/features/native-session/agent-usage.cjs');
const { turnResult, reasons } = require('../electron/features/claude-sdk/result.cjs');
const { createEvents } = require('../electron/features/codex-app-server/events.cjs');
const { tokenUsage } = require('../electron/features/codex-app-server/account.cjs');
const { validEvent } = require('../electron/features/native-session/validate.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-structured-')), fake = fakeSdk({ auto: false, interruptResult: false }), events = [], meter = createNativeUsage('claude');
  const runtime = createClaudeRuntime({ directory, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'offline-fixture-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  runtime.credentials.save('sk-ant-offline-not-a-real-key');
  let config = { claudePath: 'api-only', monthlyBudgetUsd: 10 }, committed = 0;
  const router = createRouter({ claude: runtime, settings: { get: () => config }, emit(event) { events.push(event); meter.apply(event); },
    resolveSpec: terminalId => ({ agent: 'claude', owner: 'gui', terminalId, projectId: 'p', cwd: directory, env: { HOME: directory, PATH: '' } }),
    async prepareTerminal(spec) { return { session: { spec, identity: {}, path: 'terminal' }, commit() { committed++; }, cancel() {} }; } });
  t.after(async () => { await router.close(); await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const started = await router.start('t', { agent: 'claude' });
  await router.send('t', started.runtimeSessionId, { clientMessageId: 'm', text: 'offline turn' }); await tick();
  return { fake, router, events, meter, runtimeSessionId: started.runtimeSessionId, commits: () => committed,
    switch: async () => { config = { ...config, claudePath: 'terminal-only' }; router.reconcile(true); await tick(); },
    result: async message => { await tick(); fake.emit({ type: 'result', uuid: require('node:crypto').randomUUID(), total_cost_usd: 0, modelUsage: {}, ...message }); await tick(); } };
}
for (const subtype of ['success', 'error_during_execution']) test(`G4 stop with ${subtype}/is_error can finish a pending switch through real SDK session/router/coordinator`, async t => {
  const f = await fixture(t); await f.switch(); assert.equal(f.router.switchState('t').phase, 'waiting-turn');
  await f.router.interrupt('t', f.runtimeSessionId); await tick();
  // Cover the CLI's alternate interrupted result shape too, without replacing the session's pump.
  await f.result({ subtype, is_error: subtype !== 'success', terminal_reason: 'aborted_streaming' });
  assert.equal(f.router.switchState('t').phase, 'preparing');
  const state = f.router.switchState('t');
  f.router.answer('t', f.runtimeSessionId, `handoff-${state.changeId}`, { handoff: { changeId: state.changeId, draft: { version: 1, text: '', images: [], undelivered: [] } } });
  await tick(); assert.equal(f.commits(), 1); assert.equal(f.router.switchState('t').current, 'terminal');
  assert.equal(f.events.some(event => event.type === 'session.state' && event.payload.state === 'failed'), false);
});
test('G6 terminal_reason controls the outcome even when subtype is success, and absent data remains unknown', () => {
  assert.equal(turnResult({ subtype: 'success', terminal_reason: 'completed' }).status, 'completed');
  for (const reason of ['tool_deferred', 'max_turns', 'budget_exhausted', 'background_requested', 'stop_hook_prevented']) {
    assert.equal(turnResult({ subtype: 'success', terminal_reason: reason }).status, 'interrupted', reason);
  }
  for (const reason of ['api_error', 'prompt_too_long', 'image_error', 'turn_setup_failed']) assert.equal(turnResult({ subtype: 'success', terminal_reason: reason }).status, 'failed', reason);
  for (const reason of Object.keys(reasons)) assert.match(turnResult({ terminal_reason: reason }).message, /。$/);
  const absent = turnResult({ subtype: 'success' }); assert.equal(absent.status, 'unknown'); assert.equal(absent.error, null);
  for (const field of ['durationMs', 'apiDurationMs', 'costUsdMicros', 'tokens']) assert.equal(absent[field], null);
});
test('G2/G6 production SDK result pipeline separates cumulative usage from round/context/cost and replays no billing', async t => {
  const f = await fixture(t);
  f.fake.emit({ type: 'assistant', message: { id: 'a', model: 'model', usage: { input_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 3 }, content: [{ type: 'text', text: 'Offline' }] } });
  await f.result({ subtype: 'success', terminal_reason: 'completed', duration_ms: 1234, duration_api_ms: 800, total_cost_usd: 0.02,
    usage: { input_tokens: 30, cache_read_input_tokens: 6, cache_creation_input_tokens: 4, output_tokens: 10 },
    modelUsage: { model: { inputTokens: 90, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, outputTokens: 20, contextWindow: 345678 } } });
  const view = f.meter.snapshot(); assert.deepEqual(view.context, { used: 30, window: 345678 }); assert.deepEqual(view.round, { input: 40, cached: 6, output: 10 });
  assert.deepEqual(view.total, { input: 105, cached: 10, output: 20 });
  const result = f.events.find(event => event.type === 'turn.completed'); assert.equal(result.payload.costUsdMicros, 20000); assert.equal(result.payload.durationMs, 1234);
  assert.equal(result.payload.tokens.input, 30); assert.ok(validEvent(result));
  await f.router.send('t', f.runtimeSessionId, { clientMessageId: 'next', text: 'next' });
  await f.result({ subtype: 'success', terminal_reason: 'completed', total_cost_usd: 0.03, modelUsage: { model: { inputTokens: 91, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, outputTokens: 21, contextWindow: 345678 } } });
  assert.equal(f.events.filter(event => event.type === 'turn.completed').at(-1).payload.costUsdMicros, 10000, 'cost is a delta, not the query total');
});
test('G7 SDK rate events preserve reset evidence and reject credits without exposing raw errors', async t => {
  const f = await fixture(t), reset = Math.floor(Date.now() / 1000) + 3600;
  f.fake.emit({ type: 'assistant', message: { id: 'quoting-error', content: [{ type: 'text', text: 'Documentation: enforced_spend_limit_reached' }] } }); await tick();
  assert.equal(f.events.filter(event => event.type === 'limits.updated').length, 0, 'ordinary quoted prose is not provider evidence');
  f.fake.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.8, resetsAt: reset } }); await tick();
  const warning = f.events.find(event => event.type === 'limits.updated').payload;
  assert.equal(warning.limitsById.five_hour.primary.usedPercent, 80); assert.equal(warning.providerStatus, 'allowed_warning');
  f.fake.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', errorCode: 'credits_required', resetsAt: reset } }); await tick();
  const rejected = f.events.filter(event => event.type === 'limits.updated').at(-1).payload;
  assert.equal(rejected.ordinaryUsageAllowed, false); assert.equal(rejected.notice.code, 'credits_required'); assert.equal(rejected.notice.resetsAtMs, reset * 1000);
  assert.match(rejected.notice.message, /服务端拒绝/); assert.match(rejected.notice.message, /所属的组织/);
  assert.equal(rejected.notice.action, 'check-console'); assert.equal(f.meter.snapshot().limits[0].percent, 80);
});
test('G8 Codex structured tokens and in-flight commands use observations, never fixed windows or guessed dollars', () => {
  const meter = createNativeUsage('codex'), events = createEvents({ projectId: 'p', terminalId: 't', runtimeSessionId: 'r' }, event => meter.apply(event), Date.now);
  events.notification('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 90, cachedInputTokens: 18, outputTokens: 27 } } }); events.beginTurn();
  events.notification('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30 }, last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, totalTokens: 13 }, modelContextWindow: 123456 } });
  assert.deepEqual(meter.snapshot().context, { used: 13, window: 123456 }); assert.deepEqual(meter.snapshot().round, { input: 10, cached: 2, output: 3 });
  assert.deepEqual(meter.snapshot().total, { input: 100, cached: 20, output: 30 });
  const latest = meter.snapshot(); for (const event of events.snapshot().events) meter.apply(event); assert.deepEqual(meter.snapshot(), latest, 'replay restores snapshots without adding tokens');
  assert.equal(tokenUsage({}).contextWindow, null); assert.equal(tokenUsage({}).costUsdMicros, null);
  events.notification('item/started', { item: { id: 'command', type: 'commandExecution', command: 'watch', status: 'inProgress' } }); assert.equal(events.activity().count, 1);
  events.notification('item/completed', { item: { id: 'command', type: 'commandExecution', command: 'watch', status: 'completed' } }); assert.deepEqual(events.activity(), { known: true, count: 0 });
  events.notification('item/completed', { item: { id: 'child-call', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } } });
  assert.equal(events.activity().count, 1, 'a running child survives the parent tool receipt');
  events.notification('item/completed', { item: { id: 'child-end', type: 'collabAgentToolCall', tool: 'closeAgent', receiverThreadIds: ['child'] } }); assert.equal(events.activity().count, 0);
});
