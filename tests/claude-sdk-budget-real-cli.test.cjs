const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { harness, opening, textBlock, finish } = require('./fixtures/claude-real.cjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const skip = !process.env.AGENTRIX_REAL_CLAUDE && 'set AGENTRIX_REAL_CLAUDE';

test('real owner CLI completes a single turn costing over five dollars within its monthly allowance', { skip, timeout: 60000 }, async t => {
  const f = await harness(t, data => {
    const start = opening(data); start.message.usage.input_tokens = 2000000;
    return [start, ...textBlock(0, 'LONG_CONTEXT_DONE'), ...finish('end_turn')];
  });
  const runtime = createClaudeRuntime({ directory: path.join(f.cwd, 'state'), loadSdk: async () => f.sdk,
    resolveExecutable: async () => process.env.AGENTRIX_REAL_CLAUDE,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  f.cleanup(() => runtime.close()); runtime.credentials.save(f.env.ANTHROPIC_API_KEY);
  const events = [], session = runtime.create({ owner: 'gui', cwd: f.cwd, env: f.env, runtimeSessionId: randomUUID(),
    model: 'claude-sonnet-4-5', monthlyBudgetUsd: 20 }, event => events.push(event));
  await session.start(); await session.send({ clientMessageId: 'long-context', text: 'Read a long context.' });
  for (let count = 0; count < 500 && !events.some(event => event.type === 'turn.completed'); count++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(events.find(event => event.type === 'turn.completed')?.payload.status, 'completed');
  assert.ok(runtime.usage.summary().monthUsdMicros > 5000000);
  assert.ok(runtime.usage.summary().monthUsdMicros < 20000000);
  assert.equal(runtime.apiState(20).status, 'ready');
  assert.equal(events.some(event => event.type === 'error' && event.payload.code === 'budget_exhausted'), false);
});

test('real CLI exits before initialize for a cap of 0 or below and runs with the smallest positive cap, which openQuery alone lets through', { skip, timeout: 60000 }, async t => {
  const f = await harness(t, data => [opening(data), ...textBlock(0, 'CAPPED'), ...finish('end_turn')]);
  for (const cap of [0, -1]) await assert.rejects(f.run({ maxBudgetUsd: cap }), /exited with code 1/);
  assert.equal((await f.run({ maxBudgetUsd: 0.000001 })).subtype, 'error_max_budget_usd');
  const { openQuery } = require('../electron/features/claude-sdk/query.cjs');
  for (const cap of [0, -1]) assert.throws(() => openQuery(f.sdk, 'go', f.options({ maxBudgetUsd: cap })), error => error.code === 'invalid_budget');
});

test('real CLI reports a console balance that ran out as a billing_error the product names by its cause', { skip, timeout: 60000 }, async t => {
  const { rateLimits } = require('../electron/features/claude-sdk/limits.cjs');
  const f = await harness(t, () => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error',
    message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } } }));
  const notices = [];
  const result = await f.run({}, message => { const limits = rateLimits(message, null, 'scope', Date.now()); if (limits?.notice) notices.push(limits.notice); });
  assert.equal(result.is_error, true);
  assert.deepEqual([...new Set(notices.map(notice => `${notice.code}:${notice.message}`))], ['credits_required:控制台余额不足，请到 Claude Console 的 Billing 充值。']);
});
