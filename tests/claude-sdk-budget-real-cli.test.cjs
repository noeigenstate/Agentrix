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
