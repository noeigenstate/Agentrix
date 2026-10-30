const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { WorkerOutput, CodexRollout, argumentsOf } = require('../integration/dispatch.cjs');

const counter = (input, cached, output) => ({ type: 'event_msg', payload: { type: 'token_count', info: {
  total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });

test('ledger usage uses uncached input and one preferred source with real provider shapes', () => {
  const codex = new WorkerOutput('codex');
  codex.record({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 15 } });
  assert.deepEqual(codex.usage(), { inputTokens: 60, cachedTokens: 40, outputTokens: 15, activeMs: null, reportedCostUsd: null });
  codex.rollout(counter(150, 50, 25));
  codex.record({ type: 'turn.completed', usage: { input_tokens: 999, cached_input_tokens: 0, output_tokens: 999 } });
  assert.equal(codex.usage().inputTokens, 100); assert.equal(codex.usage().cachedTokens, 50); assert.equal(codex.usage().outputTokens, 25);
  const claude = new WorkerOutput('claude');
  claude.record({ type: 'result', subtype: 'success', session_id: randomUUID(), total_cost_usd: 0.125, duration_api_ms: 50,
    usage: { input_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40, output_tokens: 10 } });
  assert.deepEqual(claude.usage(), { inputTokens: 50, cachedTokens: 40, outputTokens: 10, activeMs: 50, reportedCostUsd: 0.125 });
  claude.record({ type: 'result', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 });
  assert.equal(claude.usage().inputTokens, 0); assert.equal(claude.usage().cachedTokens, 0); assert.equal(claude.usage().reportedCostUsd, 0);
  claude.record({ type: 'result', usage: { input_tokens: 20, output_tokens: 5 } });
  assert.equal(claude.usage().inputTokens, null); assert.equal(claude.usage().cachedTokens, null); assert.equal(claude.usage().reportedCostUsd, null);
  codex.rollout(counter(10, 20, 0)); assert.equal(codex.usage().inputTokens, null);
});

test('resumed Codex usage excludes old turns and cannot confirm a start from history', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-ledger-rollout-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const id = randomUUID(), home = path.join(directory, 'codex'), folder = path.join(home, 'sessions', '2026', '01', '01');
  await fs.mkdir(folder, { recursive: true });
  const filename = path.join(folder, `rollout-fixture-${id}.jsonl`);
  const old = [{ type: 'session_meta', payload: { id } }, { type: 'turn_context', payload: { model: 'old-model' } }, counter(1000, 400, 100)];
  await fs.writeFile(filename, old.map(record => JSON.stringify(record) + '\n').join(''));
  const output = new WorkerOutput('codex'), rollout = new CodexRollout(home, output);
  await rollout.prepare(id);
  assert.equal(output.confirmed, false); assert.equal(output.model, null); assert.equal(output.usage().outputTokens, null);
  output.record({ type: 'thread.started', thread_id: id });
  const fresh = [{ type: 'turn_context', timestamp: '2026-01-02T00:00:00Z', payload: { model: 'gpt-6.1-sol', effort: 'max' } },
    { type: 'event_msg', timestamp: '2026-01-02T00:00:01Z', payload: { type: 'user_message', message: 'Synthetic prompt' } },
    { type: 'response_item', timestamp: '2026-01-02T00:00:03Z', payload: { type: 'message', role: 'assistant', content: [] } },
    { ...counter(1120, 450, 125), timestamp: '2026-01-02T00:00:03Z' }];
  await fs.appendFile(filename, fresh.map(record => JSON.stringify(record) + '\n').join(''));
  await rollout.read();
  assert.equal(output.confirmed, true); assert.equal(output.model, 'gpt-6.1-sol');
  assert.equal(output.usage().inputTokens, 70); assert.equal(output.usage().cachedTokens, 50); assert.equal(output.usage().outputTokens, 25);
  assert.equal(output.usage().activeMs, 2000);
  await rollout.read(); assert.equal(output.usage().inputTokens, 70, 'a repeated read is not a second invocation');
  const replacementId = randomUUID(), today = new Date(), pad = value => String(value).padStart(2, '0');
  const todayFolder = path.join(home, 'sessions', String(today.getFullYear()), pad(today.getMonth() + 1), pad(today.getDate()));
  await fs.mkdir(todayFolder, { recursive: true });
  await fs.writeFile(path.join(todayFolder, `rollout-fixture-${replacementId}.jsonl`),
    [{ type: 'session_meta', payload: { id: replacementId } }, { type: 'turn_context', payload: { model: 'replacement-model' } }, counter(30, 10, 5)]
      .map(record => JSON.stringify(record) + '\n').join(''));
  output.record({ type: 'thread.started', thread_id: replacementId });
  await rollout.read();
  assert.equal(output.model, 'replacement-model'); assert.equal(output.usage().inputTokens, 20); assert.equal(output.usage().outputTokens, 5);
  assert.equal(output.effort, null); assert.equal(output.fast, null);
});

test('kind and consolidation options reject unknown repeated and missing values', () => {
  const base = ['codex', '--role', 'review', '--model', 'm', '--effort', 'max', '--cwd', os.tmpdir(), '--title', 't', '--brief', 'b', '--out', 'o'];
  assert.equal(argumentsOf([...base, '--kind', 'ui-check']).kind, 'ui-check');
  for (const suffix of [['--kind', 'other'], ['--kind'], ['--kind', 'core', '--kind', 'test']]) assert.throws(() => argumentsOf([...base, ...suffix]));
  const options = argumentsOf(['consolidate', '--cwd', os.tmpdir(), '--meeting', 'r1', '--summary', 's.md', '--incidents', 'i.json', '--findings', 'f.json']);
  assert.equal(options.incidents, path.join(os.tmpdir(), 'i.json')); assert.equal(options.findings, path.join(os.tmpdir(), 'f.json'));
});
