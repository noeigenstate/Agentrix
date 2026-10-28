const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { TokenRates } = require('../electron/features/agents/token-rate.cjs');

const at = seconds => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const prompt = (seconds, uuid) => ({ type: 'user', timestamp: at(seconds), uuid, message: { content: 'Inspect placeholder.' } });
const reply = (seconds, id, parentUuid, content = [], model = 'claude-a', output = 10) => ({
  type: 'assistant', timestamp: at(seconds), uuid: id, parentUuid, message: { id, model, content, usage: { output_tokens: output } },
});
const result = (seconds, id, parentUuid, tool) => ({ type: 'user', timestamp: at(seconds), uuid: id, parentUuid,
  message: { content: [{ type: 'tool_result', tool_use_id: tool }] } });
const event = (seconds, type, payload = {}) => ({ type: 'event_msg', timestamp: at(seconds), payload: { type, ...payload } });
const count = (seconds, output_tokens) => event(seconds, 'token_count', { info: { total_token_usage: { output_tokens } } });
const usage = (seconds, response_id, output_tokens) => ({ type: 'token_usage_record', timestamp: at(seconds), payload: { response_id, usage: { output_tokens } } });
const rate = (outputTokens, activeMs, samples, seconds) => ({ outputTokens, activeMs, samples, updatedAt: seconds ? Date.parse(at(seconds)) : 0, partial: false });

test('Claude repairs late ancestry and tool batches when an earlier reply gains another tool', () => {
  const meter = new TokenRates('claude');
  meter.apply(reply(3, 'owner', 'prompt', [{ type: 'tool_use', id: 'a' }]));
  meter.apply(reply(8, 'child', 'receipt', [], 'claude-a', 20));
  assert.equal(meter.snapshot().samples, 0);
  meter.apply(result(5, 'receipt', 'owner', 'a'));
  assert.deepEqual(meter.snapshot(), rate(20, 3000, 1, 8));
  meter.apply(prompt(1, 'prompt'));
  assert.deepEqual(meter.snapshot(), rate(30, 5000, 2, 8));
  meter.apply({ ...reply(4, 'owner', 'prompt', [{ type: 'tool_use', id: 'b' }]), uuid: 'owner-block-2' });
  assert.deepEqual(meter.snapshot(), rate(10, 3000, 1, 4));
  meter.apply(result(6, 'receipt-b', 'receipt', 'b'));
  assert.deepEqual(meter.snapshot(), rate(30, 5000, 2, 8));
  assert.equal(meter.apply({ type: 'progress', timestamp: at(20), uuid: 'unrelated' }), false);
});

test('per-model updatedAt retreats when the latest reply changes model or loses usage', () => {
  const meter = new TokenRates('claude');
  meter.apply(prompt(1, 'prompt'));
  meter.apply(reply(5, 'a', 'prompt'));
  meter.apply(reply(7, 'b', 'prompt', [], 'claude-a', 20));
  meter.apply(reply(8, 'b', 'prompt', [], 'claude-b', 30));
  assert.deepEqual(meter.snapshot('claude-a'), rate(10, 4000, 1, 5));
  assert.deepEqual(meter.snapshot('claude-b'), rate(30, 7000, 1, 8));
  const missing = reply(9, 'b', 'prompt', [], 'claude-b');
  delete missing.message.usage;
  meter.apply(missing);
  assert.deepEqual(meter.snapshot('claude-b'), rate(0, 0, 0, 0));
  assert.deepEqual(meter.snapshot('claude-a'), rate(10, 4000, 1, 5));
});

test('legacy Claude timestamps repair late prompts, tool results and tied boundaries', () => {
  const meter = new TokenRates('claude');
  meter.apply(prompt(1));
  meter.apply(reply(5, 'a', undefined, [{ type: 'tool_use', id: 'tool' }]));
  meter.apply(reply(10, 'b', undefined, [], 'claude-a', 20));
  meter.apply(result(6, undefined, undefined, 'tool'));
  assert.deepEqual(meter.snapshot(), rate(30, 8000, 2, 10));
  meter.apply(prompt(8));
  assert.deepEqual(meter.snapshot(), rate(30, 6000, 2, 10));
  meter.apply(reply(9, 'a'));
  assert.deepEqual(meter.snapshot(), rate(10, 1000, 1, 9));
  meter.apply(prompt(9));
  assert.deepEqual(meter.snapshot(), rate(30, 2000, 2, 10));
});

test('Codex late usage finds the earliest overlapping counter and removes replaced intervals', () => {
  const meter = new TokenRates('codex');
  meter.apply({ type: 'turn_context', payload: { model: 'codex-a' } });
  meter.apply(event(1, 'user_message', { message: 'Inspect placeholder.' }));
  meter.apply(count(10, 100));
  meter.apply(event(0, 'task_started'));
  meter.apply({ type: 'turn_context', payload: { model: 'codex-b' } });
  meter.apply(event(2, 'user_message', { message: 'Inspect another placeholder.' }));
  meter.apply(count(12, 200));
  meter.apply(usage(5, 'first', 80));
  meter.apply(usage(4, 'first', 80));
  meter.apply(usage(6, 'second', 70));
  assert.deepEqual(meter.snapshot('codex-a'), rate(80, 3000, 1, 4));
  assert.deepEqual(meter.snapshot('codex-b'), rate(70, 4000, 1, 6));
  meter.apply(usage(8, 'unmatched', 10));
  assert.deepEqual(meter.snapshot('codex-b'), rate(70, 4000, 1, 6));
});

test('Codex tool completion corrections update the latest boundary without retaining an obsolete maximum', () => {
  const meter = new TokenRates('codex');
  meter.apply({ type: 'turn_context', payload: { model: 'codex-a' } });
  meter.apply(event(1, 'user_message', { message: 'Inspect placeholder.' }));
  for (const [seconds, call_id] of [[3, 'a'], [4, 'b']]) {
    meter.apply({ type: 'response_item', timestamp: at(seconds), payload: { type: 'function_call', call_id } });
  }
  for (const [seconds, call_id, completed] of [[9, 'a', 9], [11, 'b', 11], [12, 'a', 7], [13, 'b', 6]]) {
    meter.apply(event(seconds, 'item_completed', { item: { type: 'ToolCall', call_id, completed_at_ms: Date.parse(at(completed)) } }));
  }
  meter.apply(usage(5, 'first', 10));
  meter.apply(usage(10, 'second', 20));
  assert.deepEqual(meter.snapshot(), rate(30, 7000, 2, 10));
});

test('Claude replays a generated 20k-record transcript within 1.5 seconds', () => {
  const transcript = [];
  for (let i = 0; i < 10000; i++) {
    transcript.push(JSON.stringify(prompt(i * 2 + 1, `prompt-${i}`)));
    transcript.push(JSON.stringify(reply(i * 2 + 2, `reply-${i}`, `prompt-${i}`)));
  }
  const meter = new TokenRates('claude'), started = performance.now();
  for (const line of transcript) meter.apply(JSON.parse(line));
  const elapsed = performance.now() - started;
  assert.deepEqual(meter.snapshot(), rate(100000, 10000000, 10000, 20000));
  assert.ok(elapsed < 1500, `20k records took ${elapsed.toFixed(0)} ms (limit 1500 ms)`);
});
