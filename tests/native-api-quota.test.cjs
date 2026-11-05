const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const empty = () => ({ version: 1, text: '', images: [], undelivered: [] });
function fixture(t, { mode = 'api-then-terminal', sendStatus = 'delivered', owner = 'gui' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-quota-')), fake = fakeSdk({ auto: false });
  let clock = 1000000, terminals = [];
  const events = [], sends = [], specs = [], config = { claudePath: mode, monthlyBudgetUsd: 10 };
  const runtime = createClaudeRuntime({ directory, now: () => clock, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'fake-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  runtime.credentials.save('sk-ant-fake-offline-quota');
  const router = createRouter({ claude: runtime, codex: {}, settings: { get: () => config }, resolveSpec: id => ({ terminalId: id, projectId: 'p', owner,
    agent: 'claude', cwd: directory, env: { PATH: '', HOME: directory, USERPROFILE: directory } }), emit: event => events.push(event),
    terminalSessions: () => terminals, observeTerminal: () => ({ state: 'idle', background: { known: true, count: 0 } }), terminal: spec => { specs.push(spec); },
    prepareTerminal: async spec => { specs.push(spec); const session = { identity: {}, spec, path: 'terminal' };
      return { session, cancel() {}, commit() { terminals = [session]; }, send(input) { sends.push(input); return { status: sendStatus }; } }; } });
  t.after(async () => { await router.close(); await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const handoff = async (draft = empty()) => { const snapshot = router.snapshot('t');
    router.answer('t', snapshot.runtimeSessionId, 'handoff', { handoff: { changeId: snapshot.switchState.changeId, draft } }); await tick(); };
  async function refuse({ error = 'billing_error', text = 'Credit balance is too low', executed = false, consumed = true,
    usage = { input_tokens: 0, output_tokens: 0 }, another = false } = {}) {
    const started = await router.start('t', { agent: 'claude' });
    await router.send('t', started.runtimeSessionId, { clientMessageId: 'refused', text: 'Keep this exact input' }); await tick();
    if (another) await router.send('t', started.runtimeSessionId, { clientMessageId: 'second-input', text: 'Keep the queued correction too' });
    if (executed) fake.emit({ type: 'assistant', message: { model: 'real-model', content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: {} }] } });
    const receipt = consumed ? { user_message_uuid: 'refused' } : {};
    fake.emit({ type: 'assistant', ...receipt, error, message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text }] } });
    fake.emit({ type: 'result', uuid: randomUUID(), ...receipt, subtype: 'success', terminal_reason: 'api_error', is_error: true,
      total_cost_usd: 0, usage, result: text }); await tick();
    return started;
  }
  return { runtime, router, fake, events, sends, specs, handoff, refuse, config, time: ms => { clock += ms; } };
}
for (const [error, text] of [['billing_error', 'Credit balance is too low'], ['rate_limit', 'enforced_spend_limit_reached'], ['invalid_request', 'You have reached your specified API usage limits']]) {
  test(`quota fallback ${text}: same id, safe input sent once after readiness, no intermediate completion`, async t => {
    const f = fixture(t); await f.refuse({ error, text });
    assert.equal(f.router.switchState('t').phase, 'preparing'); assert.equal(f.sends.length, 0);
    await f.handoff();
    assert.equal(f.router.switchState('t').current, 'terminal'); assert.equal(f.specs[0].providerSessionId.length, 36);
    assert.deepEqual(f.sends, [{ clientMessageId: 'refused', text: 'Keep this exact input', images: [] }]);
    assert.equal(f.events.filter(event => event.type === 'turn.completed' && !event.replay).length, 0);
    assert.match(f.router.switchState('t').reason, /已转到 Claude Code/);
    f.router.reconcile(); await tick(); assert.equal(f.sends.length, 1);
  });
}
for (const kind of ['composer-draft', 'cli-draft', 'executed']) test(`quota fallback preserves ${kind} and returns refused input without clearing or sending`, async t => {
  const f = fixture(t, { sendStatus: 'rejected' }); await f.refuse({ executed: kind === 'executed' });
  const draft = empty(); if (kind === 'composer-draft') draft.text = 'Owner is typing';
  await f.handoff(draft);
  assert.equal(f.sends.length, kind === 'cli-draft' ? 1 : 0);
  const received = f.router.snapshot('t').handoff.draft;
  if (kind === 'composer-draft') { assert.equal(received.text, draft.text); assert.equal(received.undelivered[0].text, 'Keep this exact input'); }
  else assert.equal(received.text, 'Keep this exact input');
});
test('API-only keeps the owner session and console action; ordinary rate limiting never changes path', async t => {
  for (const ordinary of [false, true]) {
    const f = fixture(t, { mode: ordinary ? 'api-then-terminal' : 'api-only' });
    await f.refuse(ordinary ? { error: 'rate_limit', text: 'Too many requests' } : {});
    assert.equal(f.specs.length, 0); assert.equal(f.router.snapshot('t').state, 'idle');
    assert.equal(f.router.switchState('t').current, 'api');
    if (!ordinary) assert.equal(f.events.findLast(event => event.type === 'limits.updated').payload.notice.action, 'check-console');
  }
});
test('quota availability remains scoped and sticky; only one new session can claim a ten-minute trial', async t => {
  const f = fixture(t); await f.refuse(); await f.handoff();
  assert.equal(f.runtime.apiState(10, 'other').status, 'ready');
  assert.equal(f.runtime.apiState(10, 'p', null, 'dispatch').status, 'ready', 'an owner refusal cannot reroute a worker');
  f.time(599999); assert.equal(f.runtime.claimApiRetry('p'), null);
  f.time(1); const token = f.runtime.claimApiRetry('p'); assert.equal(typeof token, 'string');
  assert.equal(f.runtime.claimApiRetry('p'), null); assert.equal(f.runtime.apiState(10, 'p').status, 'credits_exhausted');
  assert.equal(f.runtime.apiState(10, 'p', token).status, 'ready');
  const trial = f.runtime.create({ owner: 'gui', agent: 'claude', projectId: 'p', terminalId: 'trial', runtimeSessionId: 'trial', apiTrial: token,
    cwd: f.specs[0].cwd, env: { PATH: '' } }, () => {});
  await trial.start(); await trial.send({ clientMessageId: 'trial-input', text: 'Retry once' }); await tick();
  assert.equal(f.runtime.apiState(10, 'p').status, 'credits_exhausted', 'identity preflight alone cannot clear a credit refusal');
  f.runtime.resetAvailability(); assert.equal(f.runtime.apiState(10, 'p').status, 'ready');
});
test('workers retain their billing failure behavior and never use the owner fallback', async t => {
  const f = fixture(t, { owner: 'dispatch' }); await f.refuse();
  assert.equal(f.runtime.apiState(10, 'p').status, 'ready'); assert.equal(f.specs.length, 0); assert.equal(f.sends.length, 0);
});

for (const uncertain of [{ consumed: false }, { usage: null }, { usage: { input_tokens: 1, output_tokens: 0 } }]) test(`uncertain refusal ${JSON.stringify(uncertain)} returns input without a replay`, async t => {
  const f = fixture(t); await f.refuse(uncertain); await f.handoff();
  assert.equal(f.sends.length, 0); assert.equal(f.router.snapshot('t').handoff.draft.text, 'Keep this exact input');
});
test('a refusal with an in-flight correction retains both messages and replays neither', async t => {
  const f = fixture(t); await f.refuse({ another: true }); await f.handoff();
  assert.equal(f.sends.length, 0);
  assert.deepEqual(f.router.snapshot('t').handoff.draft.undelivered.map(input => input.clientMessageId), ['refused', 'second-input']);
});

test('only a newly opened owner session can spend the bounded API trial; another new session uses terminal', async t => {
  const f = fixture(t); await f.refuse(); await f.handoff();
  f.time(600000);
  await f.router.start('new-trial', { agent: 'claude' });
  assert.equal(f.router.snapshot('new-trial').events.findLast(event => event.type === 'path.changed').payload.selected, 'api');
  await f.router.start('new-terminal', { agent: 'claude' });
  assert.equal(f.router.snapshot('new-terminal').events.findLast(event => event.type === 'path.changed').payload.selected, 'terminal');
  f.router.reconcile(); await tick();
  assert.equal(f.router.switchState('t').current, 'terminal', 'an existing terminal never initiates a timed retry');
});

test('an explicit turn in an idle retained query observes settings invalidation and can record a fresh refusal', async t => {
  const f = fixture(t, { mode: 'api-only' }); const started = await f.refuse();
  f.runtime.resetAvailability(); assert.equal(f.runtime.apiState(10, 'p').status, 'ready');
  await f.router.send('t', started.runtimeSessionId, { clientMessageId: 'fresh-turn', text: 'An explicit fresh turn' });
  f.fake.emit({ type: 'assistant', user_message_uuid: 'fresh-turn', error: 'billing_error', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Credit balance is too low' }] } });
  f.fake.emit({ type: 'result', uuid: randomUUID(), user_message_uuid: 'fresh-turn', is_error: true, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } }); await tick();
  assert.equal(f.runtime.apiState(10, 'p').status, 'credits_exhausted');
});
