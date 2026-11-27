const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { readAgyAccount, agyAccountLimits } = require('../electron/features/agy-acp/usage.cjs');
const { withFocusedAccountReaders } = require('../electron/features/agents/usage-host.cjs');
const { createNativeUsage } = require('../electron/features/native-session/agent-usage.cjs');
const { adapters } = require('../electron/features/cli-adapters/registry.cjs');

const at = Date.UTC(2026, 10, 26);
const reset = '2026-11-27T01:00:00Z';
const bucket = (id, window, remaining_fraction, reset_time = reset) => ({ id, window, remaining_fraction, reset_time });
const reply = { status: 'SUCCESS', num_turns: 0, account_id: 'private-account-id', email: 'private-email',
  command: { name: 'usage', data: { groups: [
    { name: 'private-plan-name', buckets: [bucket('gemini-5h', '5h', 0.8), bucket('gemini-weekly', 'weekly', 1)] },
    { buckets: [bucket('3p-5h', '5h', 0, '1970-01-01T00:00:00Z'), bucket('3p-weekly', 'weekly', 0.5), bucket('bad', 'weekly', 1.01)] },
  ] } } };

function peer(result, { version = '1.5.18', hold = false } = {}) {
  const stopped = [], launches = [];
  let launched;
  const usageStarted = new Promise(resolve => { launched = resolve; });
  const options = {
    now: () => at, env: { agy_cli_disable_auto_update: 'false', PATH: 'fixture' }, locate: () => 'fake-agy',
    spawnProcess(file, args, spawnOptions) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      const probe = args[0] === '--version';
      launches.push({ file, args, ...spawnOptions });
      if (!probe) launched();
      if (!probe && hold) return child;
      queueMicrotask(() => {
        child.stdout.end(probe ? `agy ${version}` : JSON.stringify(result));
        child.emit('close', 0);
      });
      return child;
    },
    async stopChild(child) { stopped.push(child); child.stdout.destroy(); },
  };
  return { stopped, launches, usageStarted, options };
}

test('agy reads its own four quota windows without emitting account data', async () => {
  const { stopped, launches, options } = peer(reply);
  const account = await readAgyAccount(options), payload = agyAccountLimits(account);
  assert.deepEqual(launches.map(launch => launch.args), [['--version'], ['-p', '/usage', '--output-format', 'json']]);
  for (const launch of launches) {
    assert.deepEqual(launch.env, { PATH: 'fixture', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
    assert.equal(launch.windowsHide, true);
  }
  assert.equal(stopped.length, 2);
  assert.equal(account.connection.kind, 'subscription');
  assert.equal(payload.state, 'ready');
  assert.equal(payload.observedAtMs, at);
  const window = (usedPercent, windowDurationMins, resetsAtMs = Date.parse(reset)) => ({ usedPercent, windowDurationMins, resetsAtMs });
  assert.deepEqual(payload.limitsById, { gemini: { primary: window(20, 300), secondary: window(0, 10080) },
    '3p': { primary: window(100, 300, null), secondary: window(50, 10080) } });
  assert.doesNotMatch(JSON.stringify([account, payload]), /private|email|account_id/);
});

test('missing, old, unauthenticated and aborted reads have no numeric allowance', async () => {
  const old = peer(reply, { version: '1.5.17' });
  const signedOut = peer({ status: 'ERROR', num_turns: 0, email: 'private-email' });
  const unexpectedTurn = peer({ ...reply, num_turns: 1 });
  for (const options of [{ ...old.options, locate: () => null }, old.options, signedOut.options, unexpectedTurn.options]) {
    const payload = agyAccountLimits(await readAgyAccount(options));
    assert.equal(payload.state, 'unavailable');
    assert.deepEqual(payload.limitsById, {});
  }
  assert.deepEqual(old.launches.map(launch => launch.args), [['--version']]);
  const controller = new AbortController(), hanging = peer(reply, { hold: true });
  const reading = readAgyAccount({ ...hanging.options, signal: controller.signal });
  await hanging.usageStarted;
  controller.abort();
  assert.equal(agyAccountLimits(await reading).state, 'unavailable');
  assert.equal(hanging.stopped.length, 2);
});

test('focused usage reads cache agy separately and refresh it without retaining a failed reading', async () => {
  const live = await readAgyAccount(peer(reply).options);
  const unavailable = await readAgyAccount(peer({ status: 'ERROR' }).options);
  const legacy = { codex: { source: 'Codex' }, claude: { source: 'Claude' } };
  const base = { read: async () => legacy, snapshot: () => legacy, close() {} };
  let now = at, count = 0;
  const registered = adapters().map(adapter => adapter.usage?.focusedLimits
    ? { ...adapter, usage: { ...adapter.usage, accountReader: async () => ++count === 1 ? live : { ...unavailable, at: now } } } : adapter);
  const accounts = withFocusedAccountReaders(base, { cwd: () => 'fixture', now: () => now, registered: () => registered,
    seats: id => id === 'two' ? { writer: { model: 'agy:claude-opus-5-5' } } : { lead: { model: 'gpt-6.2-sol' } } });
  const options = { env: { HOME: 'fixture' } }, first = { id: 'one', quotaAgents: ['agy'] }, second = { id: 'two' };
  assert.deepEqual(await accounts.read({ id: 'unrelated' }, options), legacy);
  assert.equal(count, 0);
  const saved = { id: 'saved', terminals: [{ restore: { agent: 'agy', threadId: 'fixture-thread' } }] };
  assert.deepEqual(await accounts.read(saved, options), { ...legacy, agy: live });
  assert.deepEqual(await accounts.read(first, options), { ...legacy, agy: live });
  await accounts.read(second, options);
  assert.equal(count, 1);
  assert.deepEqual(accounts.focusedLimits(first.id), {});
  assert.equal(accounts.focusedLimits(second.id).agy.state, 'ready');
  now += 299999;
  await accounts.read(second, options);
  assert.equal(count, 1);
  now++;
  await accounts.read(second, options);
  assert.equal(count, 2);
  assert.equal(accounts.focusedLimits(second.id).agy.state, 'unavailable');
  assert.deepEqual(accounts.snapshot(second.id).agy.limits, []);
  await accounts.close();
  assert.deepEqual(accounts.focusedLimits(second.id), {});
});

test('the agy native meter keeps its own tokens, context and model identity', () => {
  const meter = createNativeUsage('agy');
  meter.apply({ type: 'routing.updated', payload: { observed: { model: 'agy:claude-opus-5-5' } } });
  const round = { input: 20, cachedInput: 10, cacheWrite: 5, output: 2 };
  meter.apply({ type: 'usage.updated', payload: { ...round, round, contextTokens: 150, contextWindow: 1000 } });
  const { round: measured, context, provider, model } = meter.snapshot();
  assert.deepEqual(measured, { input: 35, cached: 10, output: 2 });
  assert.deepEqual(context, { used: 150, window: 1000 });
  assert.equal(provider, 'Google Antigravity');
  assert.equal(model, 'agy:claude-opus-5-5');
});
