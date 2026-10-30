const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { UsageMeter } = require('../electron/features/agents/agent-usage.cjs');

const use = (id, name = 'Agent', input = {}) => ({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, toolUseResult = {}, is_error = false) => ({ type: 'user', toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'placeholder', is_error }] } });
const notice = (id, status = 'completed', array = false) => {
  const body = `<task-notification><task-id>task</task-id><tool-use-id>${id}</tool-use-id><status>${status}</status><summary>Placeholder</summary></task-notification>`;
  return { type: 'user', message: { content: array ? [{ type: 'text', text: body }] : body } };
};
const stop = (timestamp = '2026-10-23T02:32:55.157Z') => ({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1, hookInfos: [{ command: 'claude-hook.ps1 -Kind stop', durationMs: 399 }], hookErrors: [], preventedContinuation: false, timestamp });
const states = calls => calls.snapshot().map(({ preparing, running, reviewing }) => [preparing, running, reviewing]);

async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-calls-'));
  const calls = new AgentCalls(); calls.setFolder(folder);
  t.after(async () => { calls.reset(); await fs.rm(folder, { recursive: true, force: true }); });
  return { folder, calls };
}

function finishDispatch(calls, id, reason, exitCode = 1) {
  const route = { model: 'gpt-6.1-terra', effort: 'max', fast: true };
  const start = { type: 'dispatch-start', id, agent: 'codex', role: '审查', title: id, ...route,
    sessionId: reason === 'unconfirmed' ? null : 'session', startedAt: 1000 };
  const end = { type: 'dispatch-end', id, ...route, reason, exitCode, outputTokens: null, activeMs: null, endedAt: 5000 };
  assert.equal(calls.dispatch(start), true); assert.equal(calls.dispatch(end), true);
  return { start, end };
}

test('unconfirmed dispatches expire after five seconds without removing other failures or reviving duplicates', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let changes = 0;
  const calls = new AgentCalls({ local: false, changed: () => changes++ }); t.after(() => calls.reset());
  const failed = finishDispatch(calls, 'unconfirmed', 'unconfirmed', null);
  finishDispatch(calls, 'success', 'exit', 0);
  for (const reason of ['capacity', 'scope', 'error', 'killed', 'exit']) finishDispatch(calls, reason, reason);
  const rows = () => calls.snapshot()[0]?.items || [];
  assert.deepEqual(rows().find(item => item.title === 'unconfirmed').failure, { reason: 'unconfirmed', exitCode: null });
  assert.equal(rows().find(item => item.title === 'success').state, 'done');
  t.mock.timers.tick(2999); assert.equal(rows().length, 7); assert.equal(changes, 0);
  t.mock.timers.tick(1); assert.equal(rows().length, 6); assert.equal(changes, 1);
  t.mock.timers.tick(1999); assert.equal(rows().find(item => item.title === 'unconfirmed').state, 'reviewing');
  t.mock.timers.tick(1);
  assert.deepEqual(rows().map(item => item.title).sort(), ['capacity', 'error', 'exit', 'killed', 'scope']);
  assert.equal(changes, 2);
  assert.equal(calls.dispatch(failed.start), false);
  assert.equal(calls.dispatch(failed.end), false);
  assert.equal(calls.dispatch({ type: 'dispatch-rate', id: failed.start.id, outputTokens: 1, activeMs: 1 }), false);
  assert.equal(calls.review(6000, true), true);
  assert.deepEqual(calls.snapshot(), []);
});

test('an unconfirmed dispatch reviewed before expiry does not publish a second change', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let changes = 0;
  const calls = new AgentCalls({ local: false, changed: () => changes++ }); t.after(() => calls.reset());
  const failed = finishDispatch(calls, 'early-review', 'unconfirmed', null);
  assert.equal(calls.review(6000, true), true);
  assert.deepEqual(calls.snapshot(), []);
  t.mock.timers.tick(5000);
  assert.equal(changes, 0); assert.equal(calls.dispatch(failed.start), false);
});

test('unconfirmed expiry survives a preserving reset but not a full reset', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let changes = 0;
  const calls = new AgentCalls({ local: false, changed: () => changes++ }); t.after(() => calls.reset());
  const kept = finishDispatch(calls, 'kept', 'unconfirmed', null);
  t.mock.timers.tick(2000); calls.reset(true); calls.setFolder('synthetic-folder');
  t.mock.timers.tick(2999); assert.equal(calls.snapshot()[0].items[0].title, 'kept');
  t.mock.timers.tick(1); assert.deepEqual(calls.snapshot(), []); assert.equal(changes, 1);
  assert.equal(calls.dispatch(kept.start), false);
  const cleared = finishDispatch(calls, 'cleared', 'unconfirmed', null);
  t.mock.timers.tick(2000); calls.reset();
  assert.equal(calls.dispatch(cleared.start), true);
  t.mock.timers.tick(3000);
  assert.equal(calls.snapshot()[0].items[0].state, 'running'); assert.equal(changes, 1);
});

test('unconfirmed dispatch expiry is unrefed and cleared on reset', t => {
  const calls = new AgentCalls({ local: false }); t.after(() => calls.reset());
  const clear = t.mock.method(global, 'clearTimeout');
  finishDispatch(calls, 'unconfirmed', 'unconfirmed', null);
  const expiry = calls.calls.get('unconfirmed').expiry;
  assert.equal(expiry.hasRef(), false);
  calls.reset(); assert.ok(clear.mock.calls.some(call => call.arguments[0] === expiry));
});

test('Claude Agent calls keep their own effort and leave unrecorded effort and speed unknown', () => {
  const calls = new AgentCalls({ local: false });
  for (const [id, effort] of [['high', 'high'], ['max', 'max'], ['missing', undefined]]) calls.apply(use(id, 'Agent', { model: 'opus', effort }));
  assert.deepEqual(calls.snapshot().map(({ agent, model, effort, fast }) => ({ agent, model, effort, fast })), [
    { agent: 'Claude Code', model: 'opus', effort: 'high', fast: null },
    { agent: 'Claude Code', model: 'opus', effort: 'max', fast: null },
    { agent: 'Claude Code', model: 'opus', effort: null, fast: null },
  ]);
});

test('Claude worker replies refine only their own effort and speed, and transcript resets restore launch records', async t => {
  const { folder, calls } = await fixture(t);
  const filename = path.join(folder, 'agent-own-settings.jsonl');
  await fs.writeFile(path.join(folder, 'agent-own-settings.meta.json'), JSON.stringify({ toolUseId: 'own-settings', model: 'opus' }));
  const reply = { type: 'assistant', isSidechain: true, effort: 'high', perTurnEffort: 'xhigh', message: { model: 'claude-opus-5-5', usage: { speed: 'fast' }, content: [] } };
  await fs.writeFile(filename, JSON.stringify(reply) + '\n');
  calls.apply(use('own-settings', 'Agent', { model: 'opus', effort: 'medium' })); await calls.work;
  await fs.writeFile(path.join(folder, 'agent-unrelated.meta.json'), JSON.stringify({ toolUseId: 'unrelated', model: 'sonnet', effort: 'low' }));
  await fs.writeFile(path.join(folder, 'agent-unrelated.jsonl'), '{}\n');
  calls.apply(use('unrelated', 'Agent', { model: 'sonnet' })); await calls.work;
  assert.deepEqual(calls.snapshot().map(({ model, effort, fast }) => [model, effort, fast]), [['claude-opus-5-5', 'xhigh', true], ['sonnet', 'low', null]]);
  let changes = 0; calls.changed = () => changes++;
  await fs.appendFile(filename, JSON.stringify({ ...reply, perTurnEffort: 'max', message: { ...reply.message, usage: { speed: 'standard' } } }) + '\n');
  calls.refresh('own-settings'); await calls.work;
  assert.deepEqual([calls.snapshot()[0].effort, calls.snapshot()[0].fast], ['max', false]);
  assert.equal(changes, 1, 'setting-only changes publish even when the model and rate stay the same');
  await fs.writeFile(filename, '\n');
  calls.refresh('own-settings'); await calls.work;
  assert.deepEqual([calls.snapshot()[0].effort, calls.snapshot()[0].fast], ['medium', null], 'a replaced transcript cannot retain another run’s settings');
});

test('background Agent runs finish once on queue enqueue for each terminal status', () => {
  for (const status of ['completed', 'failed', 'killed']) {
    const calls = new AgentCalls();
    calls.apply(use('a', 'Agent', { model: 'sonnet', run_in_background: true }));
    calls.apply(result('a', { isAsync: true, status: 'async_launched', agentId: 'child' }));
    const queued = {
      type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-17T00:47:36.711Z', sessionId: '<session>',
      content: notice('a', status).message.content,
    };
    assert.equal(calls.snapshot()[0].running, 1);
    assert.equal(calls.apply(queued), true);
    assert.deepEqual(states(calls), [[0, 0, 1]]);
    assert.equal(calls.apply(queued), false);
    assert.equal(calls.apply(notice('a', status, true)), false);
    for (const operation of ['dequeue', 'remove']) assert.equal(calls.apply({ ...queued, operation }), false);
    assert.deepEqual(states(calls), [[0, 0, 1]]);
  }
});

test('BashOutput and TaskOutput only finish their matching background call on a successful terminal receipt', () => {
  for (const name of ['BashOutput', 'TaskOutput']) {
    for (const status of ['completed', 'failed', 'killed']) {
      const calls = new AgentCalls();
      for (const id of ['worker', 'other']) {
        calls.apply(use(id, 'Agent', { run_in_background: true }));
        calls.apply(result(id, { backgroundTaskId: `task-${id}` }));
      }
      const poll = (id, task, status, error = false) => {
        calls.apply(use(id, name, name === 'BashOutput' ? { bash_id: task } : { task_id: task }));
        return calls.apply(result(id, name === 'BashOutput' ? { status } : { task: { task_id: task, status } }, error));
      };
      assert.equal(poll('running', 'task-worker', 'running'), false);
      assert.equal(poll('error', 'task-worker', status, true), false);
      assert.equal(poll('unknown', 'unrelated', status), false);
      assert.deepEqual(states(calls), [[0, 2, 0]]);
      assert.equal(poll('done', 'task-worker', status), true);
      assert.deepEqual(states(calls), [[0, 1, 1]]);
      assert.equal(poll('duplicate', 'task-worker', status), false);
      calls.apply(stop());
      assert.deepEqual(states(calls), [[0, 1, 0]], 'only the completed worker leaves after review');
      assert.equal(poll('late', 'task-worker', status), false);
    }
  }
});

test('TaskStop and KillShell finish only their matching worker after a successful receipt', () => {
  for (const name of ['TaskStop', 'KillShell']) {
    for (const agent of ['Claude Code']) {
      const calls = new AgentCalls({ local: false });
      for (const id of ['worker', 'other']) {
        calls.apply(use(id, 'Agent', { run_in_background: true }));
        calls.apply(result(id, { isAsync: true, agentId: `task-${id}` }));
      }
      const cancel = (id, task, error = false) => {
        calls.apply(use(id, name, name === 'TaskStop' ? { task_id: task } : { shell_id: task }));
        assert.deepEqual(states(calls), [[0, 2, 0]], 'a stop request alone does not end the worker');
        return calls.apply(result(id, { task_id: task, task_type: 'local_bash', message: 'Task stopped.' }, error));
      };
      assert.equal(cancel('failed', 'task-worker', true), false);
      assert.equal(cancel('unknown', 'unrelated'), false);
      assert.equal(cancel('success', 'task-worker'), true);
      assert.deepEqual(states(calls), [[0, 1, 1]]);
      assert.equal(calls.apply(result('success', { task_id: 'task-worker' })), false);
      calls.apply(stop());
      assert.deepEqual(states(calls), [[0, 1, 0]], 'only the stopped worker leaves after review');
      calls.apply(notice('worker'));
      assert.deepEqual(states(calls), [[0, 1, 0]], 'a late notification cannot reopen the stopped worker');
    }
  }
});

test('Claude groups keep the latest five tasks and inherit the current provider', () => {
  const meter = new UsageMeter('claude', { provider: 'relay.example' });
  for (let i = 0; i < 7; i++) {
    meter.apply(use(`a${i}`, 'Agent', { model: 'claude-sonnet-5-5', description: `Task ${i}` }));
    if (i < 6) meter.apply(result(`a${i}`));
  }
  assert.deepEqual(meter.snapshot().calls[0], { agent: 'Claude Code', provider: 'relay.example', model: 'claude-sonnet-5-5', effort: null, fast: null, preparing: 0, running: 1, reviewing: 6, tasks: ['Task 2', 'Task 3', 'Task 4', 'Task 5', 'Task 6'], items: Array.from({ length: 7 }, (_, i) => ({ state: i ? 'reviewing' : 'running', role: '通用', title: `Task ${6 - i}` })), rate: null });
  meter.provider = 'Anthropic';
  assert.equal(meter.snapshot().calls[0].provider, 'Anthropic');
  meter.apply(stop());
  assert.deepEqual(meter.snapshot().calls[0].tasks, ['Task 6'], 'reviewed tasks leave the hover text too');
});

test('small meta matches toolUseId and incremental subagent reads resolve the model while continuing checks', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-calls-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  let changes = 0;
  const meter = new UsageMeter('claude', { provider: 'Anthropic', changed: () => changes++ });
  t.after(() => meter.reset());
  meter.calls.setFolder(folder);
  await fs.writeFile(path.join(folder, 'agent-child.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Placeholder', toolUseId: 'a', model: 'sonnet' }));
  const reply = model => JSON.stringify({ type: 'assistant', isSidechain: true, message: { model } }) + '\n';
  const file = path.join(folder, 'agent-child.jsonl');
  // A huge first line straddles the tail boundary; only complete tail records can be considered.
  await fs.writeFile(file, JSON.stringify({ type: 'user', message: { content: 'x'.repeat(300 * 1024) } }) + '\n' + reply('claude-sonnet-5-5') + reply('<synthetic>'));
  meter.apply(use('a', 'Agent', { model: 'sonnet', run_in_background: true }));
  await meter.calls.work;
  assert.equal(meter.snapshot().calls[0].model, 'claude-sonnet-5-5');
  assert.equal(changes, 1);
  assert.ok(meter.calls.timer);
  await fs.appendFile(file, reply('claude-haiku-5-5'));
  assert.equal(meter.snapshot().calls[0].model, 'claude-sonnet-5-5', 'no read until another related record arrives');
  meter.apply(notice('a'));
  await meter.calls.work;
  assert.equal(meter.snapshot().calls[0].model, 'claude-haiku-5-5');
  assert.equal(meter.snapshot().calls[0].running, 0);
  assert.equal(changes, 2);
});

test('late metadata, missing tails, result agentId fallback, and reset during a read are safe', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-calls-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const calls = new AgentCalls(); calls.setFolder(folder);
  calls.apply(use('a', 'Agent', { model: 'sonnet', run_in_background: true }));
  await calls.work;
  await fs.writeFile(path.join(folder, 'agent-late.meta.json'), JSON.stringify({ toolUseId: 'a', model: 'claude-sonnet-5-5' }));
  calls.apply(result('a', { isAsync: true })); await calls.work;
  assert.equal(calls.snapshot()[0].model, 'claude-sonnet-5-5');
  await fs.writeFile(path.join(folder, 'agent-fallback.jsonl'), JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5' } }) + '\n');
  calls.apply(use('b', 'Agent', { model: 'haiku' }));
  calls.apply(result('b', { agentId: 'fallback' })); await calls.work;
  assert.equal(calls.snapshot()[1].model, 'claude-haiku-5-5');
  await fs.writeFile(path.join(folder, 'agent-inherited.meta.json'), JSON.stringify({ toolUseId: 'inherited', model: 'sonnet' }));
  calls.apply(use('inherited')); await calls.work;
  assert.equal(calls.snapshot()[2].model, 'sonnet', 'an inherited parent model yields to the subagent metadata');
  calls.apply(result('inherited', { resolvedModel: 'claude-sonnet-5-5' })); await calls.work;
  assert.equal(calls.snapshot()[0].reviewing + calls.snapshot()[0].preparing, 2, 'the resolved model merges into its route instead of reverting to the alias');
  assert.equal(calls.snapshot().length, 2);
  calls.apply(use('c')); const pending = calls.work; calls.reset(); await pending;
  assert.deepEqual(calls.snapshot(), []);
});

test('subagent items keep every role and full description newest first, including repeated tasks', () => {
  const calls = new AgentCalls();
  const roles = [['Explore', '搜索'], ['Plan', '规划'], ['general-purpose', '通用'], ['claude', '通用'], [undefined, '通用'], ['none', '通用'], ['fork', '分身'], ['custom-worker', 'custom-worker'], ['constructor', 'constructor']];
  for (const [i, [subagent_type]] of roles.entries()) calls.apply(use(`role-${i}`, 'Agent', { subagent_type, description: 'Inspect ' + 'the parser '.repeat(30) }));
  calls.apply(result('role-0'));
  assert.deepEqual(calls.snapshot()[0].items, roles.map(([, role], i) => ({ state: i ? 'running' : 'reviewing', role, title: 'Inspect ' + 'the parser '.repeat(30).trim() })).reverse());
  assert.equal(calls.snapshot()[0].tasks.length, 1, 'hover tasks still deduplicate while rows keep each call');
  assert.equal(calls.snapshot()[0].tasks[0].length, 240, 'existing hover task length stays bounded');
  calls.apply(stop());
  assert.equal(calls.snapshot()[0].items.length, roles.length - 1);
});

test('background and foreground subagents start at their first assistant record and leave after review', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { folder, calls } = await fixture(t);
  for (const [background, status] of [[true, 'completed'], [true, 'failed'], [true, 'killed'], [false, 'completed']]) {
    const id = `${background ? 'background' : 'foreground'}-${status}`, file = path.join(folder, `agent-${id}.jsonl`);
    await fs.writeFile(path.join(folder, `agent-${id}.meta.json`), JSON.stringify({ toolUseId: id, model: 'sonnet' }));
    await fs.writeFile(file, JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'Check the work.' } }) + '\n');
    calls.apply(use(id, 'Agent', { model: 'sonnet', run_in_background: background }));
    if (background) calls.apply(result(id, { isAsync: true, status: 'async_launched', agentId: id }));
    await calls.work;
    assert.deepEqual(states(calls), [[1, 0, 0]]);
    // The worker can start with a tool call, without a text block.
    await fs.appendFile(file, JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: 'Read', id: 'inspect', input: { file_path: 'AGENTS.md' } }] } }) + '\n');
    t.mock.timers.tick(2500); await calls.work;
    assert.deepEqual(states(calls), [[0, 1, 0]]);
    assert.equal(calls.snapshot()[0].model, 'claude-sonnet-5-5'); assert.ok(calls.timer);
    calls.apply(background ? notice(id, status, true) : result(id, { agentId: id, resolvedModel: 'claude-sonnet-5-5' }));
    await calls.work;
    assert.deepEqual(states(calls), [[0, 0, 1]]); assert.equal(calls.timer, null);
    calls.apply(stop()); assert.deepEqual(calls.snapshot(), []);
  }
});

test('failed launches stop preparing immediately and a new user prompt removes only the reviewed calls', async t => {
  const { calls } = await fixture(t);
  calls.apply(use('failed', 'Agent', { model: 'sonnet', run_in_background: true, description: 'Failed launch' }));
  await calls.work;
  assert.deepEqual(states(calls), [[1, 0, 0]]); assert.equal(calls.timer.hasRef(), false);
  calls.apply(result('failed', {}, true)); await calls.work;
  assert.deepEqual(states(calls), [[0, 0, 1]]); assert.equal(calls.timer, null);
  calls.apply(use('working', 'Agent', { model: 'haiku', description: 'Keep working' })); await calls.work;
  calls.apply({ type: 'user', message: { content: 'Check another file.' } });
  assert.equal(calls.snapshot().length, 1);
  assert.deepEqual(calls.snapshot()[0].tasks, ['Keep working']); assert.deepEqual(states(calls), [[1, 0, 0]]);
});

test('failed and killed background workers enter review and leave on Stop, including absorbed reports', () => {
  for (const status of ['failed', 'killed']) {
    const calls = new AgentCalls();
    calls.apply(use(status, 'Agent', { run_in_background: true }));
    calls.apply(result(status, { backgroundTaskId: status }));
    const completion = notice(status, status);
    calls.apply({ type: 'queue-operation', operation: 'enqueue', content: completion.message.content });
    assert.deepEqual(states(calls), [[0, 0, 1]]);
    calls.apply({ type: 'queue-operation', operation: 'remove', content: completion.message.content });
    calls.apply(stop()); assert.deepEqual(calls.snapshot(), []);
  }
});
