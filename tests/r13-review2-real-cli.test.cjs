require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { harness, opening, textBlock, finish } = require('./fixtures/claude-real.cjs');
const skip = !process.env.AGENTRIX_REAL_CLAUDE && 'set AGENTRIX_REAL_CLAUDE';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const mode of ['empty', 'server-500']) test(`N4 real CLI compact ${mode} shows its failure instead of claiming compaction`, { skip, timeout: 60000 }, async t => {
  let refuse = false;
  const f = await harness(t, data => refuse ? { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'OFFLINE_COMPACT_REFUSED' } } }
    : [opening(data), ...textBlock(0, 'WARMUP'), ...finish('end_turn')]);
  const raw = [], events = [];
  const runtime = require('../electron/features/claude-sdk/index.cjs').createClaudeRuntime({ directory: path.join(f.cwd, 'state'),
    loadSdk: async () => ({ ...f.sdk, query(options) {
      const query = f.sdk.query(options);
      return new Proxy(query, { get(target, key) {
        if (key === Symbol.asyncIterator) return async function* () { for await (const message of target) { raw.push(message); yield message; } };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } }), resolveExecutable: async () => process.env.AGENTRIX_REAL_CLAUDE,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  f.cleanup(() => runtime.close()); runtime.credentials.save('sk-ant-offline-compact-review-only');
  const session = runtime.create({ owner: 'gui', cwd: f.cwd, env: f.env, runtimeSessionId: 'compact-review' }, event => events.push(event));
  const wait = async count => {
    for (let n = 0; n < 1000; n++) { if (events.filter(event => event.type === 'turn.completed').length === count && session.snapshot().state === 'idle') return; await pause(20); }
    assert.fail('compact did not finish');
  };
  await session.start();
  if (mode !== 'empty') { await session.send({ clientMessageId: 'warm', text: 'Warm up' }); await wait(1); }
  const before = events.length; refuse = mode === 'server-500';
  await session.send({ clientMessageId: 'compact', text: '/compact keep the tests' }); await wait(mode === 'empty' ? 1 : 2);
  const turn = events.slice(before), result = raw.findLast(message => message.type === 'result');
  t.diagnostic(JSON.stringify({ mode, result: { subtype: result.subtype, is_error: result.is_error, local_command: result.local_command, terminal_reason: result.terminal_reason, stop_reason: result.stop_reason },
    local: raw.filter(message => message.local_command_run).map(message => ({ command: message.local_command_run, content: message.message?.content })) }));
  assert.equal(turn.some(event => event.type === 'context.compacted'), false);
  assert.equal(turn.find(event => event.type === 'turn.completed').payload.status, 'failed');
  assert.ok(turn.some(event => event.type === 'item.upsert' && event.payload.kind === 'agent-message' && event.payload.content.text), 'the actual CLI failure is visible');
});
