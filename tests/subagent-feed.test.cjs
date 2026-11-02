const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { FINAL_LIMIT, FINAL_TTL } = require('../electron/features/agents/subagent-feed.cjs');
const { encodeClaudeCwd, findClaudeSession } = require('../electron/claude-sessions.cjs');
const { containedFile, findRolloutSession } = require('../electron/session-files.cjs');
const { ConversationLog, claudeConversation, codexConversation } = require('../electron/conversation.cjs');
const { registerAgentsIpc } = require('../electron/features/agents/ipc.cjs');
const { createIpcAdapter } = require('../electron/shared/ipc.cjs');

const BASE = Date.UTC(2026, 0, 1), iso = seconds => new Date(BASE + seconds * 1000).toISOString();
const lines = records => records.map(record => JSON.stringify(record) + '\n').join('');
const start = (id, cwd, background = true) => ({ type: 'assistant', timestamp: iso(0), cwd,
  message: { content: [{ type: 'tool_use', name: 'Agent', id, input: { model: 'sonnet', effort: 'high', description: `Synthetic task ${id}`, run_in_background: background } }] } });
const result = (id, toolUseResult = {}, error = false) => ({ type: 'user', timestamp: iso(10), toolUseResult,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Synthetic receipt.', is_error: error }] } });
const notice = (id, status = 'completed', seconds = 10) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(seconds),
  content: `<task-notification><tool-use-id>${id}</tool-use-id><status>${status}</status></task-notification>` });
const childRecords = (suffix = '') => [
  { type: 'user', uuid: `u${suffix}`, parentUuid: null, isSidechain: true, timestamp: iso(1), message: { content: 'Inspect the synthetic parser.' } },
  { type: 'assistant', uuid: `a${suffix}`, parentUuid: `u${suffix}`, isSidechain: true, timestamp: iso(3),
    message: { id: `reply${suffix}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 8, cache_read_input_tokens: 3, output_tokens: 20 },
      content: [{ type: 'text', text: `Synthetic finding${suffix}.` }, { type: 'tool_use', id: `read${suffix}`, name: 'Read', input: { file_path: 'fixture.cjs' } }] } },
  { type: 'user', uuid: `r${suffix}`, parentUuid: `a${suffix}`, isSidechain: true, timestamp: iso(4),
    message: { content: [{ type: 'tool_result', tool_use_id: `read${suffix}`, content: 'Synthetic file body.' }] } },
];

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-feed-'));
  const cwd = path.join(root, 'project'), codexHome = path.join(root, 'codex'), claudeHome = path.join(root, 'claude');
  const folder = path.join(claudeHome, 'projects', encodeClaudeCwd(cwd), 'parent-session', 'subagents');
  await fs.mkdir(folder, { recursive: true }); await fs.mkdir(path.join(codexHome, 'sessions'), { recursive: true });
  const events = [], finished = [];
  const calls = new AgentCalls({ codexHome, claudeHome, since: BASE, feedChanged: event => events.push(event),
    finished: (call, event) => finished.push({ call: { ...call }, event }), ...options });
  calls.setFolder(folder);
  t.after(async () => { calls.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, cwd, codexHome, claudeHome, folder, calls, events, finished };
}
async function task(f, id = 'worker', records = childRecords()) {
  const filename = path.join(f.folder, `agent-${id}.jsonl`);
  await fs.writeFile(filename, lines(records));
  await fs.writeFile(path.join(f.folder, `agent-${id}.meta.json`), JSON.stringify({ toolUseId: id, model: 'sonnet' }));
  f.calls.apply(start(id, f.cwd)); await f.calls.work;
  return filename;
}
function dispatch(f, id, agent = 'codex', sessionId = `session-${id}`, cwd = f.cwd) {
  f.calls.dispatch({ type: 'dispatch-start', id, agent, sessionId, cwd, role: '执行', title: `Dispatch ${id}`,
    model: agent === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5', effort: 'high', fast: null, startedAt: BASE });
  return sessionId;
}
function endDispatch(f, id) {
  f.calls.dispatch({ type: 'dispatch-end', id, model: 'gpt-6.1-sol', effort: 'high', fast: null,
    endedAt: BASE + 10000, reason: 'exit', exitCode: 0, outputTokens: 20, activeMs: 2000 });
}
async function rollout(f, sessionId, extra = {}, records = []) {
  const filename = path.join(f.codexHome, 'sessions', `rollout-synthetic-${sessionId}.jsonl`);
  await fs.writeFile(filename, lines([{ type: 'session_meta', timestamp: iso(0), payload: { id: sessionId, cwd: f.cwd, source: 'exec', ...extra } }, ...records]));
  return filename;
}

test('Claude Task feeds reuse the parent parser in a separate log, update incrementally, and keep stable ids through rebinding', async t => {
  const f = await fixture(t), records = childRecords(), filename = await task(f);
  const log = new ConversationLog();
  for (const record of records) claudeConversation(log, { ...record, isSidechain: false }, f.cwd);
  const first = await f.calls.feed('agent:worker');
  assert.deepEqual(first.entries, log.snapshot());
  assert.ok(first.entries.some(entry => entry.role === 'tool' && entry.tool.done));
  assert.deepEqual(f.calls.snapshot()[0].items[0], { id: 'agent:worker', state: 'running', title: 'Synthetic task worker', role: '通用',
    startedAt: BASE, endedAt: null, viewable: true });
  await fs.appendFile(filename, lines([{ type: 'assistant', uuid: 'later', timestamp: iso(5), isSidechain: true,
    message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Later synthetic step.' }] } }]));
  const next = await f.calls.feed('agent:worker');
  assert.ok(next.revision > first.revision); assert.equal(next.entries.at(-1).text, 'Later synthetic step.');
  assert.equal(first.entries.length, log.snapshot().length, 'an old revision is an immutable snapshot');
  await fs.writeFile(path.join(f.folder, 'agent-rebound.jsonl'), lines(childRecords('-rebound')));
  await fs.rm(path.join(f.folder, 'agent-worker.meta.json'));
  f.calls.apply(result('worker', { agentId: 'rebound', isAsync: true })); await f.calls.work;
  const rebound = await f.calls.feed('agent:worker');
  assert.equal(rebound.id, first.id); assert.ok(rebound.entries.some(entry => entry.text === 'Synthetic finding-rebound.'));
  assert.ok(!rebound.entries.some(entry => entry.text === 'Later synthetic step.'));
});

test('preparing and missing transcripts are not viewable; late metadata makes them readable without changing the call id', async t => {
  const f = await fixture(t);
  f.calls.apply(start('late', f.cwd)); await f.calls.work;
  assert.equal(f.calls.snapshot()[0].items[0].viewable, false);
  await assert.rejects(f.calls.feed('agent:late'), /^Error: unavailable$/);
  await fs.writeFile(path.join(f.folder, 'agent-late.meta.json'), JSON.stringify({ toolUseId: 'late', model: 'sonnet' }));
  await fs.writeFile(path.join(f.folder, 'agent-late.jsonl'), lines(childRecords()));
  const feed = await f.calls.feed('agent:late');
  assert.equal(feed.id, 'agent:late'); assert.ok(feed.entries.length); assert.equal(f.calls.snapshot()[0].items[0].viewable, true);
});

test('dispatched Codex exec workers resolve their own rollout identity and reuse the main Codex parser', async t => {
  const f = await fixture(t), sessionId = dispatch(f, 'codex');
  const records = [{ type: 'event_msg', timestamp: iso(1), payload: { type: 'user_message', message: 'Synthetic Codex task.' } },
    { type: 'event_msg', timestamp: iso(2), payload: { type: 'agent_message', message: 'Synthetic Codex answer.' } }];
  const filename = await rollout(f, sessionId, {}, records);
  const feed = await f.calls.feed('dispatch:codex'), log = new ConversationLog();
  for (const record of (await fs.readFile(filename, 'utf8')).trim().split('\n').map(JSON.parse)) codexConversation(log, record, f.cwd);
  assert.deepEqual(feed.entries, log.snapshot()); assert.equal(feed.agent, 'Codex'); assert.equal(feed.startedAt, BASE);
  assert.equal(feed.rate, null); assert.equal(feed.fast, null);
  const partial = lines([{ type: 'event_msg', timestamp: iso(3), payload: { type: 'agent_message', message: 'Synthetic partial answer.' } }]);
  await fs.appendFile(filename, partial.slice(0, -8));
  assert.equal((await f.calls.feed('dispatch:codex')).revision, feed.revision);
  await fs.appendFile(filename, partial.slice(-8));
  assert.equal((await f.calls.feed('dispatch:codex')).entries.at(-1).text, 'Synthetic partial answer.');
  f.calls.dispatch({ type: 'dispatch-rate', id: 'codex', outputTokens: 40, activeMs: 2000 });
  assert.deepEqual(f.calls.running().find(call => call.id === 'dispatch:codex'), { id: 'dispatch:codex', agent: 'Codex',
    model: 'gpt-6.1-sol', title: 'Dispatch codex', role: '执行', startedAt: BASE,
    rate: { outputTokens: 40, activeMs: 2000, samples: 1, updatedAt: f.calls.calls.get('codex').rate.updatedAt, partial: false } });
  endDispatch(f, 'codex'); await f.calls.work;
  assert.equal((await f.calls.feed('dispatch:codex')).state, 'done');
  assert.ok(!f.calls.running().some(call => call.id === 'dispatch:codex'));
});

test('dispatched Claude workers use dispatch cwd rather than the parent cwd and never fall back to another project', async t => {
  const f = await fixture(t), workerCwd = path.join(f.root, 'worker-worktree');
  const sessionId = dispatch(f, 'claude', 'claude', 'claude-session', workerCwd);
  const project = path.join(f.claudeHome, 'projects', encodeClaudeCwd(workerCwd)); await fs.mkdir(project, { recursive: true });
  const records = childRecords().map(record => ({ ...record, isSidechain: false, sessionId }));
  await fs.writeFile(path.join(project, `${sessionId}.jsonl`), lines(records));
  assert.ok((await f.calls.feed('dispatch:claude')).entries.some(entry => entry.text === 'Synthetic finding.'));
  assert.equal(await findClaudeSession(f.cwd, sessionId, f.claudeHome, { strict: true }), null);
  dispatch(f, 'wrong-project', 'claude', sessionId);
  await assert.rejects(f.calls.feed('dispatch:wrong-project'), /^Error: unavailable$/);
});

test('rollout discovery rejects another session, another cwd, ambiguous identities and traversal-like session ids', async t => {
  const f = await fixture(t), directory = path.join(f.codexHome, 'sessions');
  dispatch(f, 'wrong-id'); await rollout(f, 'session-wrong-id', { id: 'different' });
  await assert.rejects(f.calls.feed('dispatch:wrong-id'), /unavailable/);
  dispatch(f, 'wrong-cwd'); await rollout(f, 'session-wrong-cwd', { cwd: path.join(f.root, 'other-project') });
  await assert.rejects(f.calls.feed('dispatch:wrong-cwd'), /unavailable/);
  dispatch(f, 'duplicate'); const duplicate = await rollout(f, 'session-duplicate');
  await fs.copyFile(duplicate, path.join(directory, 'rollout-second-session-duplicate.jsonl'));
  await assert.rejects(f.calls.feed('dispatch:duplicate'), /unavailable/);
  for (const id of ['../escape', '..\\escape', '/absolute', 'C:\\absolute']) {
    assert.equal(await findRolloutSession(directory, id, f.cwd), null);
    assert.equal(await findClaudeSession(f.cwd, id, f.claudeHome, { strict: true }), null);
  }
  assert.equal(await containedFile(directory, path.join(f.root, 'outside.jsonl')), null);
});

test('junction escapes are rejected for dispatched Claude and Task subagents before any outside transcript is opened', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  const escapedCwd = path.join(f.root, 'escaped-project'), projectLink = path.join(f.claudeHome, 'projects', encodeClaudeCwd(escapedCwd));
  await fs.writeFile(path.join(outside, 'escape-session.jsonl'), lines(childRecords()));
  await fs.symlink(outside, projectLink, process.platform === 'win32' ? 'junction' : 'dir');
  dispatch(f, 'escape', 'claude', 'escape-session', escapedCwd);
  const open = fs.open, opened = [];
  t.mock.method(fs, 'open', (...args) => { opened.push(args[0]); return open(...args); });
  await assert.rejects(f.calls.feed('dispatch:escape'), /unavailable/);
  await fs.rename(f.folder, `${f.folder}-original`);
  await fs.writeFile(path.join(outside, 'agent-escaped.meta.json'), JSON.stringify({ toolUseId: 'escaped' }));
  await fs.writeFile(path.join(outside, 'agent-escaped.jsonl'), lines(childRecords()));
  await fs.symlink(outside, f.folder, process.platform === 'win32' ? 'junction' : 'dir');
  f.calls.apply(start('escaped', f.cwd)); await f.calls.work;
  await assert.rejects(f.calls.feed('agent:escaped'), /unavailable/);
  assert.equal(opened.some(filename => String(filename).includes(`${path.sep}outside${path.sep}`)), false);
  assert.equal(f.calls.snapshot().flatMap(group => group.items).some(item => item.viewable), false);
});

test('SSH and unspecified CLI homes never probe local dispatch transcripts', async t => {
  const f = await fixture(t, { local: false }), open = t.mock.method(fs, 'open'), readdir = t.mock.method(fs, 'readdir');
  f.calls.apply(start('remote-task', f.cwd)); dispatch(f, 'remote-dispatch');
  await assert.rejects(f.calls.feed('agent:remote-task'), /unavailable/);
  await assert.rejects(f.calls.feed('dispatch:remote-dispatch'), /unavailable/);
  assert.equal(open.mock.callCount(), 0); assert.equal(readdir.mock.callCount(), 0);
  assert.ok(f.calls.snapshot().flatMap(group => group.items).every(item => !item.viewable));
  const unbound = new AgentCalls(); t.after(() => unbound.dispose());
  dispatch({ ...f, calls: unbound }, 'unbound');
  await assert.rejects(unbound.feed('dispatch:unbound'), /unavailable/);
  assert.equal(open.mock.callCount(), 0); assert.equal(readdir.mock.callCount(), 0);
});

test('each revision returns at most the newest 400 entries and marks the first retained entry omitted', async t => {
  const f = await fixture(t), records = Array.from({ length: 405 }, (_, i) => ({ type: 'assistant', uuid: `step-${i}`, isSidechain: true,
    timestamp: iso(i), message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: `Synthetic step ${i}` }] } }));
  await task(f, 'bounded', records);
  const feed = await f.calls.feed('agent:bounded');
  assert.equal(feed.entries.length, 400); assert.equal(feed.entries[0].text, 'Synthetic step 5');
  assert.equal(feed.entries[0].omitted, true); assert.equal(feed.entries.at(-1).text, 'Synthetic step 404');
  assert.equal(feed.entries.filter(entry => entry.omitted).length, 1);
});

test('entry-only and header-only changes push a newer revision, coalesced to four per second with trailing delivery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: BASE });
  const f = await fixture(t), filename = await task(f);
  assert.equal(f.events.length, 1);
  const initial = await f.calls.feed('agent:worker');
  for (let i = 0; i < 5; i++) {
    await fs.appendFile(filename, lines([{ type: 'assistant', uuid: `stream-${i}`, isSidechain: true, timestamp: iso(5),
      message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: `Synthetic stream ${i}` }] } }]));
    f.calls.refresh('worker'); await f.calls.work;
  }
  assert.equal(f.events.length, 1);
  const latest = await f.calls.feed('agent:worker'); assert.ok(latest.revision > initial.revision);
  t.mock.timers.tick(249); assert.equal(f.events.length, 1);
  t.mock.timers.tick(1); assert.equal(f.events.length, 2); assert.equal(f.events.at(-1).revision, latest.revision);
  const unchanged = await f.calls.feed('agent:worker'); assert.equal(unchanged.revision, latest.revision);
  f.calls.apply(notice('worker')); await f.calls.work;
  t.mock.timers.tick(250);
  assert.equal(f.events.length, 3); assert.ok(f.events.at(-1).revision > latest.revision);
  assert.equal((await f.calls.feed('agent:worker')).state, 'reviewing');
  f.calls.reset(); const count = f.events.length;
  t.mock.timers.tick(1000); assert.equal(f.events.length, count, 'reset cancels queued callbacks');
});

test('successful dispatch rows disappear after three seconds while their final snapshots expire at thirty minutes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: BASE });
  const f = await fixture(t), sessionId = dispatch(f, 'finished');
  await rollout(f, sessionId, {}, [{ type: 'event_msg', timestamp: iso(1), payload: { type: 'agent_message', message: 'Final synthetic answer.' } }]);
  await f.calls.feed('dispatch:finished'); endDispatch(f, 'finished'); await f.calls.work;
  const final = await f.calls.feed('dispatch:finished'); assert.equal(final.state, 'done');
  t.mock.timers.tick(3000); assert.deepEqual(f.calls.snapshot(), []);
  assert.deepEqual(await f.calls.feed('dispatch:finished'), final);
  t.mock.timers.tick(FINAL_TTL - 3001); assert.deepEqual(await f.calls.feed('dispatch:finished'), final);
  t.mock.timers.tick(1); await assert.rejects(f.calls.feed('dispatch:finished'), /^Error: gone$/);
  assert.equal(f.calls.dispatch({ type: 'dispatch-start', id: 'finished' }), false, 'expired feed cannot resurrect its receipt');
});

test('completed feed retention is bounded at twenty calls, including after a preserving reset', async t => {
  const f = await fixture(t);
  for (let i = 0; i <= FINAL_LIMIT; i++) {
    const id = `final-${i}`, sessionId = dispatch(f, id); await rollout(f, sessionId);
    endDispatch(f, id); await f.calls.work;
  }
  await assert.rejects(f.calls.feed('dispatch:final-0'), /^Error: gone$/);
  assert.equal((await f.calls.feed(`dispatch:final-${FINAL_LIMIT}`)).state, 'done');
  assert.equal(f.calls.feeds.entries.size, FINAL_LIMIT);
  f.calls.reset(true);
  assert.equal((await f.calls.feed(`dispatch:final-${FINAL_LIMIT}`)).state, 'done');
});

test('a final snapshot keeps its last verified contents if the transcript disappears before the end receipt', async t => {
  const f = await fixture(t), sessionId = dispatch(f, 'removed');
  const filename = await rollout(f, sessionId, {}, [{ type: 'event_msg', timestamp: iso(1), payload: { type: 'agent_message', message: 'Last verified synthetic content.' } }]);
  const before = await f.calls.feed('dispatch:removed'); await fs.rm(filename);
  endDispatch(f, 'removed'); await f.calls.work;
  const after = await f.calls.feed('dispatch:removed');
  assert.equal(after.state, 'done'); assert.deepEqual(after.entries, before.entries); assert.ok(after.revision > before.revision);
});

test('a dispatched worker drains every bounded tail chunk before freezing its final snapshot', async t => {
  const f = await fixture(t), sessionId = dispatch(f, 'drain'), filename = await rollout(f, sessionId);
  await f.calls.feed('dispatch:drain');
  await fs.appendFile(filename, lines([
    { type: 'event_msg', payload: { type: 'synthetic_padding', text: 'x'.repeat(5 * 1024 * 1024) } },
    { type: 'event_msg', timestamp: iso(9), payload: { type: 'agent_message', message: 'The last synthetic step.' } },
  ]));
  endDispatch(f, 'drain'); await f.calls.work;
  assert.equal(f.calls.calls.get('drain').feedDrained, false);
  const final = await f.calls.feed('dispatch:drain');
  assert.equal(final.entries.at(-1).text, 'The last synthetic step.');
  assert.equal(f.calls.calls.get('drain').feedDrained, true); assert.equal(final.state, 'done');
});

test('a dispatched worker keeps its CLI home when the interactive terminal later changes homes', async t => {
  const f = await fixture(t); let currentHome = f.codexHome;
  const calls = new AgentCalls({ codexHome: () => currentHome }); t.after(() => calls.dispose());
  dispatch({ ...f, calls }, 'pinned');
  await rollout(f, 'session-pinned', {}, [{ type: 'event_msg', timestamp: iso(1), payload: { type: 'agent_message', message: 'Original synthetic home.' } }]);
  currentHome = path.join(f.root, 'another-codex-home'); await fs.mkdir(path.join(currentHome, 'sessions'), { recursive: true });
  await rollout({ ...f, codexHome: currentHome }, 'session-pinned', {}, [{ type: 'event_msg', timestamp: iso(1), payload: { type: 'agent_message', message: 'Different synthetic home.' } }]);
  const feed = await calls.feed('dispatch:pinned');
  assert.equal(feed.entries.at(-1).text, 'Original synthetic home.');
});

test('rate-only notifications respect the per-call limit across consecutive seconds and deliver the latest revision', t => {
  const pushes = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: BASE });
  const calls = new AgentCalls({ local: false, feedChanged: event => pushes.push({ ...event, at: Date.now() }) });
  t.after(() => calls.dispose());
  dispatch({ calls }, 'one', 'codex', 'one', '/synthetic'); dispatch({ calls }, 'two', 'codex', 'two', '/synthetic');
  for (let i = 1; i <= 40; i++) {
    for (const id of ['one', 'two']) calls.dispatch({ type: 'dispatch-rate', id, outputTokens: i, activeMs: i * 100 });
    t.mock.timers.tick(50);
  }
  for (const id of ['dispatch:one', 'dispatch:two']) {
    for (const offset of [0, 1000]) assert.equal(pushes.filter(event => event.callId === id && event.at >= BASE + offset && event.at < BASE + offset + 1000).length, 4);
    assert.equal(pushes.filter(event => event.callId === id).at(-1).revision, calls.feeds.entries.get(id).snapshot.revision);
  }
});

test('Claude completion records drain the last reply, deduplicate usage and notifications, and preserve success/failure/stop', async t => {
  const f = await fixture(t);
  for (const status of ['completed', 'failed', 'killed']) {
    const id = `result-${status}`, records = childRecords(), filename = await task(f, id, records.slice(0, 1));
    await fs.appendFile(filename, lines(records.slice(1)));
    const corrected = structuredClone(records[1]); corrected.uuid += '-correction'; corrected.message.usage.output_tokens = 25;
    corrected.message.content = []; await fs.appendFile(filename, lines([corrected]));
    f.calls.apply(notice(id, status)); await f.calls.work;
    const receipt = f.finished.at(-1);
    assert.equal(receipt.event.source, 'subagent'); assert.equal(receipt.event.id, `agent:${id}`);
    assert.equal(receipt.call.sourceAgent, 'claude'); assert.equal(receipt.event.model, 'claude-sonnet-5-5');
    assert.equal(receipt.event.totalOutputTokens, 25); assert.equal(receipt.event.inputTokens, 11); assert.equal(receipt.event.cachedTokens, 3);
    assert.equal(receipt.event.outputTokens, 25); assert.equal(receipt.event.activeMs, 2000);
    assert.equal(receipt.event.reason, status === 'completed' ? 'exit' : status === 'killed' ? 'killed' : 'error');
    assert.equal(receipt.event.exitCode, status === 'completed' ? 0 : null);
    f.calls.apply(notice(id, status)); f.calls.apply(result(id)); await f.calls.work;
  }
  assert.equal(f.finished.length, 3);
  assert.equal(f.calls.running().length, 0);
});

test('foreground, poll and stop receipts complete once; missing measurements stay null and history replay never counts', async t => {
  const f = await fixture(t, { local: false });
  f.calls.apply(start('foreground', f.cwd, false)); f.calls.apply(result('foreground'));
  assert.deepEqual(f.finished[0].event, { id: 'agent:foreground', source: 'subagent', model: 'unreported', effort: 'high', fast: null,
    endedAt: BASE + 10000, reason: 'exit', exitCode: 0, outputTokens: null, activeMs: null, inputTokens: null, cachedTokens: null, totalOutputTokens: null });
  f.calls.apply(start('poll', f.cwd)); f.calls.apply(result('poll', { backgroundTaskId: 'poll-task' }));
  f.calls.apply({ ...start('poll-request', f.cwd), message: { content: [{ type: 'tool_use', name: 'TaskOutput', id: 'poll-request', input: { task_id: 'poll-task' } }] } });
  f.calls.apply(result('poll-request', { task: { task_id: 'poll-task', status: 'failed' } }));
  f.calls.apply(start('stop', f.cwd)); f.calls.apply(result('stop', { agentId: 'stop-task', isAsync: true }));
  f.calls.apply({ ...start('stop-request', f.cwd), message: { content: [{ type: 'tool_use', name: 'TaskStop', id: 'stop-request', input: { task_id: 'stop-task' } }] } });
  f.calls.apply(result('stop-request'));
  assert.deepEqual(f.finished.map(value => value.event.reason), ['exit', 'error', 'killed']);
  f.calls.reset(); f.calls.history(true);
  f.calls.apply(start('replayed', f.cwd)); f.calls.apply(result('replayed'));
  f.calls.history(false); f.calls.apply(result('replayed'));
  assert.equal(f.finished.length, 3);
  f.calls.apply({ ...start('old', f.cwd), timestamp: new Date(BASE - 2000).toISOString() });
  f.calls.apply({ ...result('old'), timestamp: new Date(BASE - 1000).toISOString() });
  assert.equal(f.finished.length, 3);
  f.calls.apply(start('foreground', f.cwd, false)); f.calls.apply(result('foreground'));
  assert.equal(f.finished.length, 3, 'reset/replayed tool identities cannot count a finished run again');
});

test('resumed subagent metrics exclude earlier replies while the feed retains its conversation history', async t => {
  const f = await fixture(t), old = childRecords('-old'), current = childRecords('-new');
  for (const record of current) record.timestamp = iso(Date.parse(record.timestamp) / 1000 - BASE / 1000 + 5);
  await fs.writeFile(path.join(f.folder, 'agent-resumed.meta.json'), JSON.stringify({ toolUseId: 'resumed' }));
  await fs.writeFile(path.join(f.folder, 'agent-resumed.jsonl'), lines([...old, ...current]));
  f.calls.apply({ ...start('resumed', f.cwd), timestamp: iso(5) }); await f.calls.work;
  f.calls.apply(notice('resumed')); await f.calls.work;
  assert.equal(f.finished[0].event.totalOutputTokens, 20); assert.equal(f.finished[0].event.activeMs, 2000);
  assert.equal(f.finished[0].event.inputTokens, 11);
  const feed = await f.calls.feed('agent:resumed');
  assert.ok(feed.entries.some(entry => entry.text === 'Synthetic finding-old.'));
  assert.ok(feed.entries.some(entry => entry.text === 'Synthetic finding-new.'));
  f.calls.apply({ ...notice('resumed'), operation: 'remove', timestamp: iso(20) });
  assert.equal((await f.calls.feed('agent:resumed')).endedAt, BASE + 10000, 'review delivery cannot change the completion timestamp');
});

test('transcript rotation and truncation reset only that feed; an in-flight old read cannot publish after reset', async t => {
  const f = await fixture(t), filename = await task(f);
  const first = await f.calls.feed('agent:worker');
  await fs.rename(filename, `${filename}.old`); await fs.writeFile(filename, lines(childRecords('-replacement')));
  const rotated = await f.calls.feed('agent:worker');
  assert.ok(rotated.revision > first.revision); assert.ok(rotated.entries.some(entry => entry.text === 'Synthetic finding-replacement.'));
  assert.ok(!rotated.entries.some(entry => entry.text === 'Synthetic finding.'));
  await fs.writeFile(filename, '\n'); assert.deepEqual((await f.calls.feed('agent:worker')).entries, []);
  const open = fs.open; let release, began;
  const started = new Promise(resolve => { began = resolve; });
  t.mock.method(fs, 'open', async (...args) => {
    if (args[0] === filename) { began(); await new Promise(resolve => { release = resolve; }); }
    return open(...args);
  });
  const pending = f.calls.feed('agent:worker'); await started;
  f.calls.reset(); release(); await assert.rejects(pending, /gone/);
  assert.deepEqual(f.calls.snapshot(), []);
});

test('the IPC validates terminal ownership, rejects cross-terminal call capabilities and uses the shared sender guard', async t => {
  const f = await fixture(t); await task(f);
  const other = new AgentCalls(); t.after(() => other.dispose());
  const handlers = new Map(), webContents = { mainFrame: { url: 'agentrix://app/index.html' } }, window = { webContents };
  const { handle } = createIpcAdapter({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, getWindow: () => window, t: value => value });
  const sessions = new Map([['one', { terminalId: 'one', projectId: 'project', calls: f.calls }], ['two', { terminalId: 'two', projectId: 'project', calls: other }]]);
  registerAgentsIpc({ handle, getSession: id => sessions.get(id), findProject: id => {
    if (!['one', 'two', 'remote'].includes(id)) throw new Error('missing project');
    return { id: 'project', kind: id === 'remote' ? 'ssh' : 'local' };
  } });
  const invoke = (id, callId) => handlers.get('terminal:subagent-feed')({ sender: webContents, senderFrame: webContents.mainFrame }, id, callId);
  assert.equal((await invoke('one', 'agent:worker')).ok, true);
  assert.deepEqual(await invoke('two', 'agent:worker'), { ok: false, error: 'gone' });
  assert.deepEqual(await invoke('remote', 'agent:worker'), { ok: false, error: 'unavailable' });
  assert.equal((await invoke('one', 'agent:../escape')).ok, false);
  sessions.set('two', { terminalId: 'two', projectId: 'different-project', calls: f.calls });
  assert.deepEqual(await invoke('two', 'agent:worker'), { ok: false, error: 'gone' });
  await assert.rejects(handlers.get('terminal:subagent-feed')({ sender: {}, senderFrame: webContents.mainFrame }, 'one', 'agent:worker'), /Rejected IPC sender/);
});

test('preload exposes read-only feed fetch and unsubscribable notifications, with no host native-answer or managed bridges', async () => {
  let bridge; const invoked = [], listeners = new Map();
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8'), { require: name => {
    assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: (...args) => { invoked.push(args); }, on: (channel, listener) => listeners.set(channel, listener),
        removeListener: (channel, listener) => { assert.equal(listeners.get(channel), listener); listeners.delete(channel); } } };
  } });
  bridge.subagentFeed('terminal', 'agent:worker'); assert.deepEqual(invoked, [['terminal:subagent-feed', 'terminal', 'agent:worker']]);
  const events = [], unsubscribe = bridge.onSubagentFeed(event => events.push(event));
  const event = { terminalId: 'terminal', callId: 'agent:worker', revision: 3 };
  listeners.get('terminal:subagent-feed')({}, event); assert.deepEqual(events, [event]);
  unsubscribe(); assert.equal(listeners.size, 0);
  for (const name of ['answerNativeApproval', 'answerNativeQuestion', 'managedPrompt']) assert.equal(name in bridge, false);
});
