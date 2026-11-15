const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const { waitFor } = require('../scripts/wait.mjs');
const empty = () => ({ version: 1, text: '', images: [], undelivered: [] });
function fixture(t, { mode = 'api-then-terminal', sendStatus = 'delivered', owner = 'gui' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-quota-')), fake = fakeSdk({ auto: false });
  let clock = 1000000, terminals = [];
  // The runtime's clock and timers are one injected pair: time() moves the clock and runs every timer it reaches.
  const due = new Set(), timers = { setTimeout: (run, delay) => { const task = { run, at: clock + delay }; due.add(task); return task; }, clearTimeout: task => due.delete(task) };
  const events = [], sends = [], specs = [], config = { claudePath: mode, monthlyBudgetUsd: 10 };
  const runtime = createClaudeRuntime({ directory, now: () => clock, timers, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'fake-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  runtime.credentials.save('sk-ant-fake-offline-quota');
  const router = createRouter({ claude: runtime, codex: {}, settings: { get: () => config }, resolveSpec: id => ({ terminalId: id, projectId: 'p', owner,
    agent: 'claude', cwd: directory, env: { PATH: '', HOME: directory, USERPROFILE: directory } }), emit: event => events.push(event),
    terminalSessions: () => terminals, observeTerminal: () => ({ state: 'idle', background: { known: true, count: 0 } }), terminal: spec => { specs.push(spec); },
    prepareTerminal: async spec => { specs.push(spec); const session = { identity: {}, spec, path: 'terminal' };
      return { session, cancel() {}, commit() { terminals = [session]; }, send(input) { sends.push(input); return { status: sendStatus }; } }; } });
  t.after(async () => { await router.close(); await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const handoff = async (draft = empty()) => { const snapshot = router.snapshot('t');
    router.answer('t', snapshot.runtimeSessionId, 'handoff', { handoff: { changeId: snapshot.switchState.changeId, draft } }); await waitFor(() => router.switchState('t')?.current === 'terminal', 'quota handoff'); };
  async function refuse({ error = 'billing_error', text = 'Credit balance is too low', executed = false, consumed = true,
    usage = { input_tokens: 0, output_tokens: 0 }, another = false } = {}) {
    const started = await router.start('t', { agent: 'claude' });
    await router.send('t', started.runtimeSessionId, { clientMessageId: 'refused', text: 'Keep this exact input' }); await waitFor(() => fake.inputs.length === 1, 'quota input');
    if (another) await router.send('t', started.runtimeSessionId, { clientMessageId: 'second-input', text: 'Keep the queued correction too' });
    if (executed) fake.emit({ type: 'assistant', message: { model: 'real-model', content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: {} }] } });
    const receipt = consumed ? { user_message_uuid: 'refused' } : {};
    fake.emit({ type: 'assistant', ...receipt, error, message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text }] } });
    fake.emit({ type: 'result', uuid: randomUUID(), ...receipt, subtype: 'success', terminal_reason: 'api_error', is_error: true,
      total_cost_usd: 0, usage, result: text }); await waitFor(() => router.snapshot('t')?.state === 'idle' || router.switchState('t')?.phase === 'preparing', 'provider refusal');
    return started;
  }
  return { runtime, router, fake, events, sends, specs, handoff, refuse, config, time: ms => { clock += ms; for (const task of [...due].filter(task => task.at <= clock)) { due.delete(task); task.run(); } } };
}
for (const [error, text] of [['billing_error', 'Credit balance is too low'], ['rate_limit', 'enforced_spend_limit_reached'], ['invalid_request', 'You have reached your specified API usage limits'], ['rate_limit', 'Too many requests']]) {
  test(`quota fallback ${text}: same id, safe input sent once after readiness, no intermediate completion`, async t => {
    const f = fixture(t); await f.refuse({ error, text });
    assert.equal(f.router.switchState('t')?.phase, 'preparing'); assert.equal(f.sends.length, 0);
    await f.handoff();
    assert.equal(f.router.switchState('t').current, 'terminal'); assert.equal(f.specs[0].providerSessionId.length, 36);
    assert.deepEqual(f.sends, [{ clientMessageId: 'refused', text: 'Keep this exact input', images: [] }]);
    assert.equal(f.events.filter(event => event.type === 'turn.completed' && !event.replay).length, 0);
    assert.match(f.router.switchState('t').reason, /已转到 Claude Code/);
    await f.router.reconcile(); assert.equal(f.sends.length, 1);
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
test('API-only stops on provider limits and retains the console action without switching', async t => {
  for (const rate of [false, true]) {
    const f = fixture(t, { mode: 'api-only' });
    await f.refuse(rate ? { error: 'rate_limit', text: 'Too many requests' } : {});
    assert.equal(f.specs.length, 0); assert.equal(f.router.snapshot('t').state, 'idle');
    assert.equal(f.router.switchState('t').current, 'api');
    if (!rate) assert.equal(f.events.findLast(event => event.type === 'limits.updated').payload.notice.action, 'check-console');
    await assert.rejects(f.router.send('t', f.router.snapshot('t').runtimeSessionId, { clientMessageId: 'blocked', text: 'not sent' }));
  }
});

test('quota availability remains scoped and sticky; only one new session can claim a ten-minute trial', async t => {
  const f = fixture(t); await f.refuse(); await f.handoff();
  assert.equal(f.runtime.apiState('other').status, 'ready');
  assert.equal(f.runtime.apiState('p', null, 'dispatch').status, 'ready', 'an owner refusal cannot reroute a worker');
  f.time(599999); assert.equal(f.runtime.claimApiRetry('p'), null);
  f.time(1); const token = f.runtime.claimApiRetry('p'); assert.equal(typeof token, 'string');
  assert.equal(f.runtime.claimApiRetry('p'), null); assert.equal(f.runtime.apiState('p').status, 'credits_exhausted');
  assert.equal(f.runtime.apiState('p', token).status, 'ready');
  const trial = f.runtime.create({ owner: 'gui', agent: 'claude', projectId: 'p', terminalId: 'trial', runtimeSessionId: 'trial', apiTrial: token,
    cwd: f.specs[0].cwd, env: { PATH: '' } }, () => {});
  await trial.start(); await trial.send({ clientMessageId: 'trial-input', text: 'Retry once' }); await waitFor(() => f.fake.inputs.length === 2, 'trial input');
  assert.equal(f.runtime.apiState('p').status, 'credits_exhausted', 'identity preflight alone cannot clear a credit refusal');
  f.runtime.resetAvailability(); assert.equal(f.runtime.apiState('p').status, 'ready');
});
test('workers retain their billing failure behavior and never use the owner fallback', async t => {
  const f = fixture(t, { owner: 'dispatch' }); await f.refuse();
  assert.equal(f.runtime.apiState('p').status, 'ready'); assert.equal(f.specs.length, 0); assert.equal(f.sends.length, 0);
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
  await f.router.reconcile();
  const { current, target, phase } = f.router.switchState('t');
  assert.deepEqual({ current, target, phase }, { current: 'terminal', target: 'terminal', phase: 'stable' }, 'an existing terminal never initiates a timed retry');
});

test('an explicit turn in an idle retained query observes settings invalidation and can record a fresh refusal', async t => {
  const f = fixture(t, { mode: 'api-only' }); const started = await f.refuse();
  f.runtime.resetAvailability(); assert.equal(f.runtime.apiState('p').status, 'ready');
  await f.router.send('t', started.runtimeSessionId, { clientMessageId: 'fresh-turn', text: 'An explicit fresh turn' });
  await waitFor(() => f.fake.inputs.length === 2, 'renewed query input');
  f.fake.emit({ type: 'assistant', user_message_uuid: 'fresh-turn', error: 'billing_error', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Credit balance is too low' }] } });
  f.fake.emit({ type: 'result', uuid: randomUUID(), user_message_uuid: 'fresh-turn', is_error: true, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } }); await waitFor(() => f.runtime.apiState('p').status === 'credits_exhausted', 'fresh refusal');
  assert.equal(f.runtime.apiState('p').status, 'credits_exhausted');
});

test('a key revoked mid-session leaves the route unavailable: with API, then terminal the next message is not sent to the API and the session moves to the terminal', async t => {
  const f = fixture(t), started = await f.router.start('t', { agent: 'claude' });
  await f.router.send('t', started.runtimeSessionId, { clientMessageId: 'first', text: 'Before the key was revoked' }); await waitFor(() => f.fake.inputs.length === 1, 'first input');
  f.fake.emit({ type: 'assistant', user_message_uuid: 'first', error: 'authentication_failed', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] } });
  f.fake.emit({ type: 'result', uuid: randomUUID(), user_message_uuid: 'first', subtype: 'success', is_error: true, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
  await waitFor(() => f.router.snapshot('t')?.state === 'idle' || f.router.switchState('t')?.phase === 'preparing', 'refused turn');
  assert.equal(f.runtime.apiState('p').status, 'invalid_key');
  assert.equal(f.events.findLast(event => event.type === 'limits.updated')?.payload.source, 'invalid_key');
  assert.equal((await f.router.send('t', started.runtimeSessionId, { clientMessageId: 'second', text: 'After the key was revoked' })).status, 'rejected');
  assert.equal(f.fake.inputs.length, 1, 'nothing more reaches the API');
  await f.handoff(); assert.equal(f.router.switchState('t').current, 'terminal');
});

test('the terminal switch names the limit that moved the session: credits, a rate limit and an account limit each in their own words', async t => {
  const words = {
    credits: ['控制台余额不足，请到 Claude Console 的 Billing 充值。已转到 Claude Code 终端。', '控制台余额不足，请到 Claude Console 的 Billing 充值。已转到 Claude Code 终端，未自动发送的消息已保留，请检查终端输入框后继续。'],
    rate: ['API 请求达到速率限制，已转到 Claude Code 终端。', 'API 请求达到速率限制，已转到 Claude Code 终端，未自动发送的消息已保留，请检查终端输入框后继续。'],
    account: ['Claude 账号或组织的 API 用量已达上限，已转到 Claude Code 终端。', 'Claude 账号或组织的 API 用量已达上限，已转到 Claude Code 终端，未自动发送的消息已保留，请检查终端输入框后继续。'],
  };
  for (const [kind, refusal] of [['credits', {}], ['rate', { error: 'rate_limit', text: 'Too many requests' }], ['account', { error: 'spend_limit', text: 'enforced_spend_limit_reached' }]]) {
    for (const kept of [false, true]) {
      const f = fixture(t, { sendStatus: kept ? 'rejected' : 'delivered' }); await f.refuse(refusal); await f.handoff();
      assert.equal(f.router.switchState('t').reason, words[kind][kept ? 1 : 0], `${kind}, kept=${kept}`);
    }
  }
});

test('a final rate limit stops and moves only the session that received it; another owner session in the project keeps the API', async t => {
  const f = fixture(t), other = await f.router.start('other', { agent: 'claude' });
  await f.refuse({ error: 'rate_limit', text: 'Too many requests' }); await f.handoff();
  assert.equal(f.router.switchState('t').current, 'terminal');
  assert.equal(f.runtime.apiState('p').status, 'ready', 'a new session in the project takes the API');
  await f.router.reconcile();
  assert.notEqual(f.router.switchState('other')?.target, 'terminal');
  const receipt = await f.router.send('other', other.runtimeSessionId, { clientMessageId: 'other-input', text: 'Still on the API' });
  assert.equal(receipt.status, 'queued'); await waitFor(() => f.fake.inputs.some(input => input.uuid === 'other-input'), 'other session input');
});

for (const [kind, refusal] of [['credits', {}], ['account limits', { error: 'spend_limit', text: 'enforced_spend_limit_reached' }]]) {
  test(`${kind} stay project-wide: another owner session in the project moves to the terminal too`, async t => {
    const f = fixture(t); await f.router.start('other', { agent: 'claude' });
    await f.refuse(refusal); await f.router.reconcile();
    assert.equal(f.router.switchState('other')?.target, 'terminal');
    assert.equal(f.runtime.apiState('p').status, kind === 'credits' ? 'credits_exhausted' : 'account_limit');
  });
}

test('a rate-limit fallback returns to the API when its one-minute hold ends, driven by the expiry alone, by the switch-back path', async t => {
  const f = fixture(t);
  f.fake.sdk.getSessionMessages = async id => [{ type: 'user', uuid: randomUUID(), session_id: id, parent_tool_use_id: null, message: { role: 'user', content: 'Keep this exact input' } }];
  await f.refuse({ error: 'rate_limit', text: 'Too many requests' }); await f.handoff();
  const stateOf = () => { const { current, target, phase } = f.router.switchState('t'); return { current, target, phase }; };
  // Before the hold ends even an explicit pass keeps the card on the terminal.
  f.time(59999); await f.router.reconcile();
  assert.deepEqual(stateOf(), { current: 'terminal', target: 'terminal', phase: 'stable' });
  // The expiry is the only event: its timer asks for the pass, and the settle point asks for nothing.
  f.time(1); await f.router.settled();
  assert.deepEqual(stateOf(), { current: 'terminal', target: 'api', phase: 'preparing' });
  const snapshot = f.router.snapshot('t');
  f.router.answer('t', snapshot.runtimeSessionId, 'handoff', { handoff: { changeId: snapshot.switchState.changeId, draft: empty() } });
  await f.router.settled();
  assert.deepEqual(stateOf(), { current: 'api', target: 'api', phase: 'stable' });
  assert.deepEqual(f.router.snapshot('t').events.findLast(event => event.type === 'path.changed').payload, { previous: 'terminal', selected: 'api', reason: null });
});
