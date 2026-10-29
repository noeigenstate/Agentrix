const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { UsageMeter } = require('../electron/features/agents/agent-usage.cjs');
const { TokenRates, emptyRate } = require('../electron/features/agents/token-rate.cjs');
const { CodexActivityReader } = require('../electron/codex-activity.cjs');
const { TranscriptTail } = require('../electron/agent-actions.cjs');
const { HISTORY_WINDOW } = require('../electron/transcript-window.cjs');

const at = seconds => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const fixture = async name => (await fs.readFile(path.join(__dirname, 'fixtures', name), 'utf8')).trim().split('\n').map(JSON.parse);
const replay = (meter, records) => { for (const record of records) meter.apply(record); return meter.snapshot(); };
const rate = (outputTokens, activeMs, samples, seconds, partial = false) => ({ outputTokens, activeMs, samples, updatedAt: Date.parse(at(seconds)), partial });
const prompt = (seconds = 1) => ({ type: 'user', uuid: 'prompt', timestamp: at(seconds), message: { content: 'Inspect placeholder.' } });
const reply = (seconds = 3, extra = {}) => ({ type: 'assistant', parentUuid: 'prompt', timestamp: at(seconds), message: { id: 'reply', model: 'claude-opus-5-5', usage: { output_tokens: 100 } }, ...extra });
const event = (seconds, type, payload = {}) => ({ type: 'event_msg', timestamp: at(seconds), payload: { type, ...payload } });

test('readable main transcripts wait for their first eligible response; SSH rates remain unavailable', () => {
  for (const agent of ['claude', 'codex']) {
    assert.deepEqual(new UsageMeter(agent).snapshot().rate, emptyRate(false));
    assert.equal(new UsageMeter(agent, { rates: false }).snapshot().rate, null);
  }
});

test('Claude deduplicates blocks, repairs late prompts/results and partitions main models without sidechains', async () => {
  const records = await fixture('claude-token-rate.jsonl'), meter = new UsageMeter('claude');
  replay(meter, records.slice(0, 3));
  assert.deepEqual(meter.snapshot().rate, emptyRate(false), 'an unread parent is not a boundary');
  meter.apply(records[3]);
  assert.deepEqual(meter.snapshot().rate, rate(100, 2000, 1, 3));
  const main = meter.snapshot();
  assert.equal(meter.apply(records[4]), false);
  assert.deepEqual(meter.snapshot(), main, 'a child cannot change main usage, model, calls or rate');
  replay(meter, records.slice(5, 8));
  assert.deepEqual(meter.snapshot().rate, rate(100, 2000, 1, 3), 'both parallel results are required');
  meter.apply(records[8]);
  assert.deepEqual(meter.snapshot().rate, rate(300, 5000, 2, 12), 'the last result at 9s excludes tool time and the background notice');
  meter.apply(records[9]);
  assert.deepEqual(meter.snapshot().rate, rate(340, 6000, 2, 13));
  replay(meter, records.slice(10, 12));
  assert.equal(meter.snapshot().model, 'claude-sonnet-5-5');
  assert.deepEqual(meter.snapshot().rate, rate(90, 3000, 1, 18));
  replay(meter, records.slice(12));
  assert.equal(meter.snapshot().model, 'claude-opus-5-5');
  assert.deepEqual(meter.snapshot().rate, rate(420, 10000, 3, 24));
  replay(meter, await fixture('claude-subagent-token-rate.jsonl'));
  assert.deepEqual(meter.snapshot().rate, rate(420, 10000, 3, 24));
});

test('Claude rejects missing identities, models, usage, zero/backward intervals and unknown ancestry', () => {
  for (const record of [reply(1), reply(0), reply(3, { parentUuid: 'unknown' }),
    reply(3, { message: { model: 'claude-opus-5-5', usage: { output_tokens: 100 } } }),
    reply(3, { message: { id: 'reply', usage: { output_tokens: 100 } } }),
    reply(3, { message: { id: 'reply', model: 'claude-opus-5-5' } })]) {
    const meter = new UsageMeter('claude'); replay(meter, [prompt(), record]);
    assert.equal(meter.snapshot().rate.samples, 0);
  }
  const meter = new UsageMeter('claude');
  replay(meter, [prompt(), reply(), reply(4, { message: { id: 'missing-model', usage: { output_tokens: 10 } } })]);
  assert.equal(meter.snapshot().model, null, 'a missing model cannot borrow its neighbour');
  assert.equal(meter.snapshot().rate.samples, 0);
});

test('Codex prefers response usage times, deduplicates counters and includes reasoning only once', async () => {
  const records = await fixture('codex-token-rate.jsonl'), meter = new UsageMeter('codex');
  replay(meter, records.slice(0, 5));
  assert.deepEqual(meter.snapshot().rate, rate(100, 2000, 1, 3));
  replay(meter, records.slice(5, 13));
  assert.deepEqual(meter.snapshot().rate, rate(100, 2000, 1, 3), 'the delayed token_count must not include tool wait');
  replay(meter, records.slice(13, 16));
  assert.deepEqual(meter.snapshot().rate, rate(220, 5000, 2, 12));
  replay(meter, records.slice(16, 18));
  assert.equal(meter.snapshot().model, 'gpt-6-astra');
  assert.deepEqual(meter.snapshot().rate, emptyRate(false));
  replay(meter, records.slice(18, 20));
  assert.deepEqual(meter.snapshot().rate, rate(90, 3000, 1, 20));
  replay(meter, records.slice(20));
  assert.equal(meter.snapshot().model, 'gpt-6.1-sol');
  assert.deepEqual(meter.snapshot().rate, rate(260, 9000, 3, 27));
  assert.equal(meter.snapshot().total.output, 350, 'existing token accounting stays intact');
  const before = meter.snapshot();
  replay(meter, [{ type: 'session_meta', payload: { source: 'exec' } }, { type: 'turn_context', payload: { model: 'other' } }]);
  assert.deepEqual(meter.snapshot(), before, 'exec records never enter the main Codex meter');
});

test('legacy Codex counts use model completion before tool waits and skip repeated totals', () => {
  const meter = new TokenRates('codex');
  const count = (seconds, output_tokens) => event(seconds, 'token_count', { info: { total_token_usage: { output_tokens } } });
  replay(meter, [
    { type: 'turn_context', timestamp: at(0), payload: { model: 'gpt-6.1-sol' } },
    event(1, 'user_message', { message: 'Inspect placeholder.' }),
    { type: 'response_item', timestamp: at(3), payload: { type: 'function_call', call_id: 'tool' } },
    { type: 'response_item', timestamp: at(9), payload: { type: 'function_call_output', call_id: 'tool' } }, count(11, 100),
  ]);
  assert.deepEqual(meter.snapshot(), rate(100, 2000, 1, 3));
  replay(meter, [{ type: 'response_item', timestamp: at(12), payload: { type: 'message', role: 'assistant' } }, count(14, 160), count(15, 160)]);
  assert.deepEqual(meter.snapshot(), rate(160, 5000, 2, 12));
});

test('Codex response ids dedupe even without cumulative usage; incomplete and interrupted intervals stay empty', () => {
  const meter = new TokenRates('codex');
  const usage = { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'response', usage: { output_tokens: 100 } } };
  replay(meter, [{ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }, event(1, 'user_message', { message: 'Placeholder.' }), usage, usage,
    event(10, 'token_count', { info: { total_token_usage: { output_tokens: 100 } } })]);
  assert.deepEqual(meter.snapshot(), rate(100, 2000, 1, 3));
  for (const records of [[usage], [event(1, 'user_message', { message: 'Placeholder.' }), event(2, 'turn_aborted'), usage]]) {
    const empty = new TokenRates('codex'); replay(empty, records);
    assert.equal(empty.snapshot().samples, 0);
  }
  meter.reset(true);
  assert.deepEqual(meter.snapshot(), emptyRate(true));
});

test('late Codex response usage replaces a counter sample without borrowing the new turn model', () => {
  for (const cumulative of [true, false]) {
    const meter = new TokenRates('codex');
    replay(meter, [{ type: 'turn_context', timestamp: at(0), payload: { model: 'gpt-6.1-sol' } },
      event(1, 'user_message', { message: 'Placeholder.' }), event(11, 'token_count', { info: { total_token_usage: { output_tokens: 100 } } }),
      { type: 'turn_context', timestamp: at(12), payload: { model: 'gpt-6-astra' } }]);
    const usage = { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'late-response', usage: { output_tokens: 100 }, ...(cumulative ? { thread_token_usage: { output_tokens: 100 } } : {}) } };
    meter.apply(usage); meter.apply(usage);
    assert.equal(meter.model, 'gpt-6-astra');
    assert.deepEqual(meter.snapshot('gpt-6.1-sol'), rate(100, 2000, 1, 3));
    assert.deepEqual(meter.snapshot(), emptyRate(false));
  }
});

test('Codex does not count a delayed tool response against the following generation boundary', () => {
  const meter = new TokenRates('codex');
  replay(meter, [{ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
    { type: 'response_item', timestamp: at(3), payload: { type: 'function_call', call_id: 'tool' } },
    { type: 'response_item', timestamp: at(9), payload: { type: 'function_call_output', call_id: 'tool' } },
    event(11, 'token_count', { info: { total_token_usage: { output_tokens: 100 } } })]);
  assert.deepEqual(meter.snapshot(), emptyRate(false));
});

test('Codex consumes a tool boundary once and starts a fresh batch for the following response', async () => {
  const records = await fixture('codex-token-rate.jsonl'), meter = new TokenRates('codex');
  replay(meter, records.slice(0, 14));
  assert.deepEqual(meter.snapshot(), rate(220, 5000, 2, 12));
  meter.apply({ type: 'token_usage_record', timestamp: at(13), payload: { response_id: 'no-boundary', usage: { output_tokens: 10 }, thread_token_usage: { output_tokens: 230 } } });
  assert.deepEqual(meter.snapshot(), rate(220, 5000, 2, 12));
  replay(meter, [{ type: 'response_item', timestamp: at(14), payload: { type: 'function_call', call_id: 'next-tool' } },
    { type: 'response_item', timestamp: at(16), payload: { type: 'function_call_output', call_id: 'next-tool' } },
    { type: 'token_usage_record', timestamp: at(18), payload: { response_id: 'after-next-tool', usage: { output_tokens: 30 }, thread_token_usage: { output_tokens: 260 } } }]);
  assert.deepEqual(meter.snapshot(), rate(250, 7000, 3, 18));
  assert.equal(meter.tools.size, 0);
});

test('a non-advancing Codex cumulative output cannot introduce another sample under a different response id', () => {
  const meter = new TokenRates('codex');
  replay(meter, [{ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }, event(1, 'user_message', { message: 'Placeholder.' }),
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'response', usage: { output_tokens: 100 }, thread_token_usage: { output_tokens: 100 } } },
    event(4, 'user_message', { message: 'Another placeholder.' }),
    { type: 'token_usage_record', timestamp: at(5), payload: { response_id: 'unchanged', usage: { output_tokens: 100 }, thread_token_usage: { output_tokens: 100 } } }]);
  assert.deepEqual(meter.snapshot(), rate(100, 2000, 1, 3));
});

test('bounded Claude causal bookkeeping retains completed history after old tool owners are evicted', () => {
  const meter = new TokenRates('claude'); meter.apply(prompt());
  let parentUuid = 'prompt';
  for (let i = 0; i < 300; i++) {
    meter.apply({ type: 'assistant', uuid: `reply-${i}`, parentUuid, timestamp: at(2 * i + 2), message: {
      id: `reply-${i}`, model: 'claude-opus-5-5', usage: { output_tokens: 10 }, content: [{ type: 'tool_use', id: `tool-${i}` }],
    } });
    parentUuid = `result-${i}`;
    meter.apply({ type: 'user', uuid: parentUuid, parentUuid: `reply-${i}`, timestamp: at(2 * i + 3), message: { content: [{ type: 'tool_result', tool_use_id: `tool-${i}` }] } });
  }
  assert.deepEqual(meter.snapshot(), rate(3000, 300000, 300, 600));
  assert.ok(meter.replies.size <= 256);
});

test('the main Codex incremental reader ignores a newer exec rollout in the same cwd', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-main-rate-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'sessions'));
  for (const exec of [false, true]) {
    const records = await fixture('codex-token-rate.jsonl'); records[0].payload.cwd = home;
    if (exec) { records[0].payload.source = 'exec'; records[0].payload.id = '22222222-2222-4222-8222-222222222222'; }
    await fs.writeFile(path.join(home, 'sessions', `rollout-${records[0].payload.id}.jsonl`), records.map(record => JSON.stringify(record) + '\n').join(''));
  }
  const meter = new UsageMeter('codex'); t.after(() => meter.reset());
  const reader = new CodexActivityReader(home, home, 0, { onRecord: record => meter.apply(record), onReset: partial => { meter.rates.partial = partial; } });
  await reader.read();
  assert.equal(reader.snapshot.threadId, '11111111-1111-4111-8111-111111111111');
  assert.equal(meter.snapshot().model, 'gpt-6.1-sol');
  assert.deepEqual(meter.snapshot().rate, rate(260, 9000, 3, 27));
});

for (const agent of ['claude', 'codex']) test(`${agent} main history marks a bounded tail partial and clears it on truncation`, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-partial-rate-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'sessions'));
  const records = await fixture(`${agent}-token-rate.jsonl`), meter = new UsageMeter(agent);
  t.after(() => meter.reset());
  const id = agent === 'codex' ? records[0].payload.id : 'placeholder';
  const filename = path.join(home, 'sessions', `rollout-${id}.jsonl`);
  if (agent === 'codex') records[0].payload.cwd = home;
  const header = agent === 'codex' ? JSON.stringify(records.shift()) + '\n' : '';
  const body = values => values.map(record => JSON.stringify(record) + '\n').join('');
  await fs.writeFile(filename, header + 'x'.repeat(HISTORY_WINDOW + 1) + '\n' + body(records));
  const options = { onHistory: ready => { if (!ready) meter.reset(); }, onReset: partial => { meter.rates.partial = partial; } };
  const reader = agent === 'claude' ? new TranscriptTail(filename, options) : new CodexActivityReader(home, home, 0, { ...options, onRecord: record => meter.apply(record) });
  const read = () => agent === 'claude' ? reader.read(record => meter.apply(record)) : reader.read();
  await read();
  assert.deepEqual(meter.snapshot().rate, agent === 'claude' ? rate(420, 10000, 3, 24, true) : rate(260, 9000, 3, 27, true));
  await fs.writeFile(filename, header + body(records.slice(0, 3))); await read();
  assert.deepEqual(meter.snapshot().rate, emptyRate(false));
});
