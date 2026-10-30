const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CompletionHistory } = require('../electron/completion-history.cjs');
const { CompletionWork } = require('../electron/completion-work.cjs');
const { TranscriptTail } = require('../electron/agent-actions.cjs');
const { CodexActivityReader } = require('../electron/codex-activity.cjs');
const { HISTORY_WINDOW, LIVE_READ_LIMIT } = require('../electron/transcript-window.cjs');

const at = new Date().toISOString();
const row = record => JSON.stringify({ timestamp: at, ...record }) + '\n';
const tool = (name, id, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input }] } });
const call = (name, call_id, args) => ({ type: 'response_item', payload: { type: 'function_call', name, call_id, arguments: JSON.stringify(args) } });
const output = (call_id, value) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id, output: JSON.stringify(value) } });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-completion-history-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('completion prefix includes the record skipped by the display tail even at an exact newline boundary', async t => {
  const directory = await fixture(t), filename = path.join(directory, 'session.jsonl');
  const first = row({ type: 'system' });
  await fs.writeFile(filename, first + row(tool('Agent', 'boundary', { run_in_background: true })) + row({ type: 'system' }));
  const file = await fs.open(filename, 'r'); t.after(() => file.close());
  const history = new CompletionHistory(Buffer.byteLength(first)), records = [];
  assert.equal(await history.read(file, record => records.push(record)), true);
  assert.equal(records.length, 2); assert.equal(records[1].message.content[0].id, 'boundary');
});

test('large valid records preserve completion metadata after outputs without making history uncertain', async t => {
  const directory = await fixture(t), filename = path.join(directory, 'session.jsonl'), work = new CompletionWork();
  t.after(() => work.reset());
  const receipt = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'launch', content: 'x'.repeat(2 * 1024 * 1024) }] }, toolUseResult: { backgroundTaskId: 'shell' } };
  await fs.writeFile(filename, row(tool('Bash', 'launch', {})) + row(receipt));
  const file = await fs.open(filename, 'r'); t.after(() => file.close());
  const history = new CompletionHistory((await file.stat()).size - 1);
  assert.equal(await history.read(file, record => work.record(record, 'claude')), true);
  assert.equal(history.uncertain, false); assert.ok(work.find('shell'));
});

test('cooperative recovery drains the prefix in order without idle-poll timers', async t => {
  const directory = await fixture(t), filename = path.join(directory, 'history.jsonl');
  const lines = Array.from({ length: 1800 }, (_, n) => row({ type: 'system', n, padding: 'x'.repeat(4096) }));
  await fs.writeFile(filename, lines.join(''));
  const file = await fs.open(filename, 'r'); t.after(() => file.close());
  const history = new CompletionHistory((await file.stat()).size - 1), seen = [];
  let yielded = false; setImmediate(() => { yielded = true; });
  assert.equal(await history.catchUp(file, record => seen.push(record.n)), true);
  assert.equal(yielded, true);
  assert.deepEqual(seen, Array.from({ length: 1800 }, (_, n) => n));
});

test('a replaced session cancels cooperative recovery before another chunk can report work', async t => {
  const directory = await fixture(t), filename = path.join(directory, 'history.jsonl');
  await fs.writeFile(filename, row({ type: 'system', padding: 'x'.repeat(8192) }).repeat(1600));
  const file = await fs.open(filename, 'r'); t.after(() => file.close());
  const history = new CompletionHistory((await file.stat()).size - 1);
  let current = true, seen = 0;
  setImmediate(() => { current = false; });
  assert.equal(await history.catchUp(file, () => seen++, () => current), false);
  const before = seen;
  assert.equal(await history.catchUp(file, () => seen++, () => current), false);
  assert.equal(seen, before); assert.equal(history.done, false);
});

for (const agent of ['claude', 'codex']) test(`${agent} recovers launches and ends before the 8 MiB tail, then reads the remaining worker's end`, async t => {
  const directory = await fixture(t), folder = path.join(directory, 'sessions');
  await fs.mkdir(folder);
  const filename = path.join(folder, 'rollout-parent.jsonl'), work = new CompletionWork();
  const thread = '00000000-0000-4000-8000-000000000001';
  t.after(() => work.reset());
  const launches = agent === 'claude' ? [tool('Agent', 'ended', { run_in_background: true }), tool('Bash', 'running', { run_in_background: true }),
    tool('TaskStop', 'stop', { task_id: 'ended' })]
    : [{ type: 'session_meta', payload: { id: thread, cwd: directory, source: 'cli' } },
      call('spawn_agent', 'spawn-ended', {}), output('spawn-ended', { agent_id: 'ended' }),
      call('spawn_agent', 'spawn-running', {}), output('spawn-running', { agent_id: 'running' }),
      call('close_agent', 'close', { id: 'ended' }), output('close', {})];
  const padding = row({ type: 'system', padding: 'x'.repeat(8192) });
  const stop = agent === 'claude' ? { type: 'assistant', uuid: 'stop', message: { stop_reason: 'end_turn', content: [] } }
    : { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } };
  await fs.writeFile(filename, launches.map(row).join('') + padding.repeat(Math.ceil((HISTORY_WINDOW + LIVE_READ_LIMIT) / padding.length))
    + (agent === 'codex' ? row({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } }) : '') + row(stop));
  const receive = record => work.record(record, agent);
  const reader = agent === 'claude' ? new TranscriptTail(filename, { onWorkRecord: receive })
    : new CodexActivityReader(directory, directory, 0, { onWorkRecord: receive, onRecord: receive });
  let snapshot;
  const read = async () => {
    snapshot = agent === 'claude' ? (await reader.read(receive), work.turn) : await reader.read();
    work.reading = reader.historyPending;
  };
  await read(); assert.equal(reader.historyPending, true, 'prefix recovery is bounded per poll');
  for (let count = 0; reader.historyPending && count < 8; count++) await read();
  assert.equal(reader.historyPending, false); assert.equal(reader.workHistory.uncertain, false);
  assert.equal(work.tasks.size, 1); assert.ok(work.find('running')); assert.equal(work.find('ended'), undefined);
  assert.equal(work.state(snapshot), 'working', 'parent completion cannot hide a launch before the tail');
  const end = agent === 'claude' ? [
    { type: 'user', message: { content: '<task-notification><task-id>running</task-id><status>killed</status></task-notification>' } }, stop,
  ] : [call('close_agent', 'close-running', { id: 'running' }), output('close-running', {})];
  await fs.appendFile(filename, end.map(row).join('')); await read();
  assert.equal(work.tasks.size, 0); assert.equal(work.state(snapshot), 'complete');
});
