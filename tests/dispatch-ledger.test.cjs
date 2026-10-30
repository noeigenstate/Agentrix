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
  assert.deepEqual(codex.usage(), { inputTokens: 60, cachedTokens: 40, outputTokens: null, totalOutputTokens: 15, activeMs: null, reportedCostUsd: null });
  codex.rollout(counter(150, 50, 25));
  codex.record({ type: 'turn.completed', usage: { input_tokens: 999, cached_input_tokens: 0, output_tokens: 999 } });
  assert.equal(codex.usage().inputTokens, 100); assert.equal(codex.usage().cachedTokens, 50); assert.equal(codex.usage().totalOutputTokens, 25);
  assert.equal(codex.usage().outputTokens, null);
  const claude = new WorkerOutput('claude');
  claude.record({ type: 'result', subtype: 'success', session_id: randomUUID(), total_cost_usd: 0.125, duration_api_ms: 50,
    usage: { input_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40, output_tokens: 10 } });
  assert.deepEqual(claude.usage(), { inputTokens: 50, cachedTokens: 40, outputTokens: 10, totalOutputTokens: 10, activeMs: 50, reportedCostUsd: 0.125 });
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
  assert.equal(output.model, 'replacement-model'); assert.equal(output.usage().inputTokens, 20); assert.equal(output.usage().totalOutputTokens, 5);
  assert.equal(output.usage().outputTokens, null);
  assert.equal(output.effort, null); assert.equal(output.fast, null);
});

test('kind and consolidation options reject unknown repeated and missing values', () => {
  const base = ['codex', '--role', 'review', '--model', 'm', '--effort', 'max', '--cwd', os.tmpdir(), '--title', 't', '--brief', 'b', '--out', 'o'];
  assert.equal(argumentsOf([...base, '--kind', 'ui-check']).kind, 'ui-check');
  for (const suffix of [['--kind', 'other'], ['--kind'], ['--kind', 'core', '--kind', 'test']]) assert.throws(() => argumentsOf([...base, ...suffix]));
  const options = argumentsOf(['consolidate', '--cwd', os.tmpdir(), '--meeting', 'r1', '--summary', 's.md', '--incidents', 'i.json', '--findings', 'f.json']);
  assert.equal(options.incidents, path.join(os.tmpdir(), 'i.json')); assert.equal(options.findings, path.join(os.tmpdir(), 'f.json'));
});

async function rolloutLab(t, records = []) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-ledger-baseline-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const id = randomUUID(), today = new Date(), pad = value => String(value).padStart(2, '0');
  const folder = path.join(home, 'sessions', String(today.getFullYear()), pad(today.getMonth() + 1), pad(today.getDate()));
  await fs.mkdir(folder, { recursive: true });
  const filename = path.join(folder, `rollout-test-${id}.jsonl`);
  const append = values => fs.appendFile(filename, values.map(record => JSON.stringify(record) + '\n').join(''));
  const meta = { type: 'session_meta', payload: { id, source: 'exec', model_provider: 'openai' } };
  if (records !== null) await append([meta, ...records]);
  const output = new WorkerOutput('codex'), rollout = new CodexRollout(home, output);
  return { id, output, rollout, append, meta };
}

test('resumed Codex never falls back to stdout when its old rollout or counter baseline is absent', async t => {
  for (const initial of [null, [], [counter(1000, 400, 100)]]) {
    const f = await rolloutLab(t, initial);
    await f.rollout.prepare(f.id);
    f.output.record({ type: 'thread.started', thread_id: f.id });
    f.output.record({ type: 'turn.completed', usage: { input_tokens: 1120, cached_input_tokens: 450, output_tokens: 125 } });
    assert.equal(f.output.usage().inputTokens, null); assert.equal(f.output.usage().cachedTokens, null);
    assert.equal(f.output.usage().totalOutputTokens, null);
    await f.append([...(initial === null ? [f.meta] : []), { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }, counter(1120, 450, 125)]);
    await f.rollout.read();
    assert.equal(f.output.usage().inputTokens, initial?.length ? 70 : null);
    assert.equal(f.output.usage().cachedTokens, initial?.length ? 50 : null);
    assert.equal(f.output.usage().totalOutputTokens, initial?.length ? 25 : null);
  }
});

test('new Codex threads start with zero baselines and stdout fallback until counters arrive', async t => {
  const f = await rolloutLab(t);
  f.output.record({ type: 'thread.started', thread_id: f.id });
  await f.rollout.read();
  f.output.record({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 15 } });
  assert.equal(f.output.usage().inputTokens, 60); assert.equal(f.output.usage().totalOutputTokens, 15);
  await f.append([counter(120, 50, 20)]); await f.rollout.read();
  assert.equal(f.output.usage().inputTokens, 70); assert.equal(f.output.usage().cachedTokens, 50);
  assert.equal(f.output.usage().totalOutputTokens, 20);
});

test('backward Codex counters invalidate affected invocation totals instead of retaining stale values', async t => {
  for (const backwards of [counter(900, 350, 90), counter(1100, 430, 120)]) {
    const f = await rolloutLab(t, [counter(1000, 400, 100)]);
    await f.rollout.prepare(f.id);
    f.output.record({ type: 'thread.started', thread_id: f.id });
    await f.append([counter(1120, 450, 125)]); await f.rollout.read();
    assert.equal(f.output.usage().totalOutputTokens, 25);
    await f.append([counter(undefined, undefined, undefined)]); await f.rollout.read();
    await f.append([backwards]); await f.rollout.read();
    f.output.record({ type: 'turn.completed', usage: { input_tokens: 1120, cached_input_tokens: 450, output_tokens: 125 } });
    for (const key of ['inputTokens', 'cachedTokens', 'totalOutputTokens']) assert.equal(f.output.usage()[key], null, key);
    await f.append([counter(1200, 500, 150)]); await f.rollout.read();
    assert.equal(f.output.usage().totalOutputTokens, null, 'a later increase cannot repair a lost counter baseline');
  }
});

test('routing decisions and task kinds have one shared owner for helpers, admission and records', () => {
  const { TASK_KINDS, taskKind, routingVerdict } = require('../electron/features/dashboard/records-routing.cjs');
  assert.ok(Object.isFrozen(TASK_KINDS));
  for (const [role, kind] of [['审查', 'review'], ['调查', 'investigate'], ['圆桌', 'roundtable'], ['执行', null]]) {
    assert.equal(taskKind({ role }), kind); assert.equal(taskKind({ role }, true), 'roundtable');
    assert.equal(taskKind({ role, kind: 'test' }, true), 'test');
  }
  const declared = { model: 'gpt-6.1-sol', effort: 'max', fast: true };
  for (const [actual, expected] of [[declared, 'ok'], [{ model: null, effort: null, fast: null }, 'unverified'],
    [{ ...declared, model: null }, 'unverified'], [{ ...declared, model: null, effort: 'high' }, 'mismatch'],
    [{ ...declared, model: 'unreported' }, 'mismatch'], [{ ...declared, model: 'other' }, 'mismatch'], [{ ...declared, fast: false }, 'mismatch']]) {
    assert.equal(routingVerdict(actual, declared), expected);
  }
});
