const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { createClaudeActivity } = require('../electron/features/terminal-events/claude-activity.cjs');
const { createHookIngest } = require('../electron/features/terminal-events/hook-ingest.cjs');

const at = seconds => Date.parse('2026-01-01T00:00:00Z') + seconds * 1000;
const items = calls => calls.snapshot().flatMap(group => group.items);
const signal = (kind, agentId = 'child', seconds = 0, extra = {}) => ({ kind, terminalId: 't', agentId,
  agentType: 'general-purpose', transcriptPath: null, toolUseId: null, at: at(seconds), ...extra });
const use = (id = 'toolu_child', input = {}) => ({ type: 'assistant', timestamp: new Date(at(0)).toISOString(),
  message: { model: 'claude-parent', content: [{ type: 'tool_use', name: 'Agent', id, input: { description: 'Inspect parser', ...input } }] } });
const result = (seconds = 4) => ({ type: 'user', timestamp: new Date(at(seconds)).toISOString(), toolUseResult: { agentId: 'child' },
  message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_child', content: 'Done' }] } });
function tracker(t, options = {}) {
  const calls = new AgentCalls({ terminalId: 't', since: 0, now: () => at(30), local: false, ...options });
  t.after(() => calls.dispose());
  return calls;
}
function hooks(t, { local = false } = {}) {
  const calls = tracker(t, { local }), stateEvents = [], s = { terminalId: 't', projectId: 'p', agent: 'claude', codexActive: true,
    claudeSessionId: 'parent', activitySince: at(0), activityMonitor: { poll: async () => {} } };
  const project = { id: 'p', kind: local ? 'local' : 'ssh', path: '/project' };
  const deps = { sessions: new Map([['t', s]]), store: { projects: [project] }, callsOf: () => calls,
    claudeActivity: (...args) => stateEvents.push(args), followClaude() {} };
  const activity = createClaudeActivity(deps);
  let clock = at(1);
  const ingest = createHookIngest({ keyOf: () => 'key', now: () => clock, deliver: activity.claudeHook });
  return { calls, s, stateEvents, take(event, payload = {}, seconds = 1) {
    clock = at(seconds); ingest.take('t', event, JSON.stringify({ session_id: 'parent', ...payload }));
  } };
}

test('a SubagentStart gives the row before the sub-agent transcript exists; SubagentStop ends it', async t => {
  const f = hooks(t);
  f.take('SubagentStart', { agent_id: 'child', agent_type: 'Explore', transcript_path: '/parent.jsonl' });
  assert.equal(items(f.calls).length, 1);
  assert.equal(f.calls.running().length, 1);
  assert.equal(items(f.calls)[0].viewable, false);
  assert.equal(f.calls.calls.values().next().value.filename, undefined, 'the parent transcript is not the child transcript');
  f.take('SubagentStop', { agent_id: 'child', agent_type: 'Explore', agent_transcript_path: '/subagents/agent-child.jsonl' }, 5);
  assert.equal(f.calls.running().length, 0);
  assert.equal(items(f.calls)[0].endedAt, at(5));
  assert.deepEqual(f.stateEvents, [], 'lifecycle hooks never start or finish the owner round');
});

test('SendMessage keeps only bounded target fields and revives the finished row, marked resumed', t => {
  const f = hooks(t);
  f.take('SubagentStart', { agent_id: 'child' });
  f.take('SubagentStop', { agent_id: 'child' }, 2);
  assert.equal(items(f.calls).length, 1);
  const id = items(f.calls)[0].id;
  f.calls.review(at(3), true);
  f.take('PreToolUse', { tool_name: 'SendMessage', tool_use_id: 'continue-1', tool_input: { to: 'child', recipient: 'child',
    message: 'Private words', content: 'Private words', summary: 'Private summary' } }, 4);
  assert.deepEqual(items(f.calls).map(item => [item.id, item.resumed]), [[id, true]]);
  assert.equal(f.calls.running().length, 1);
  const captured = [];
  const ingest = createHookIngest({ keyOf: () => 'key', deliver: event => captured.push(event) });
  ingest.take('t', 'PreToolUse', JSON.stringify({ tool_name: 'SendMessage', tool_input: { to: 'x'.repeat(3000), recipient: 'child', message: 'Private words' } }));
  assert.equal(captured[0].payload.tool_input.to.length <= 2000, true);
  assert.equal(captured[0].payload.tool_input.recipient, 'child');
  assert.equal(JSON.stringify(captured).includes('Private words'), false);
  ingest.take('t', 'PreToolUse', JSON.stringify({ tool_name: 'Bash', tool_input: { to: 'child' } }));
  assert.equal(captured[1].payload.tool_input, undefined);
});

test('hook and transcript identities deduplicate in either order and late transcript results cannot end a signal-held row', t => {
  for (const first of ['hook', 'transcript']) {
    const calls = tracker(t);
    if (first === 'hook') calls.subagent(signal('start'));
    calls.apply(use());
    if (first === 'transcript') calls.subagent(signal('start'));
    calls.apply(result());
    assert.equal(items(calls).length, 1);
    assert.equal(calls.running().length, 1);
    calls.subagent(signal('stop', 'child', 5));
    calls.apply(result(6));
    assert.equal(items(calls).length, 1);
    assert.equal(calls.running().length, 0);
  }
});

test('Claude workers from every project terminal remain visible across terminal selection and both lead modes', t => {
  const scope = new Map();
  for (const mode of ['terminal', 'native']) {
    for (const terminalId of [`${mode}-1`, `${mode}-2`]) {
      const calls = AgentCalls.forTerminal(scope, terminalId, () => tracker(t, { terminalId }));
      calls.subagent(signal('start', `child-${terminalId}`, 1, { terminalId }));
    }
  }
  for (const selected of ['terminal-1', 'native-2', 'terminal-2']) {
    const projectItems = ['terminal-1', 'terminal-2', 'native-1', 'native-2'].flatMap(id => items(AgentCalls.forTerminal(scope, id)));
    assert.equal(projectItems.length, 4, selected);
    assert.equal(new Set(projectItems.map(item => item.id)).size, 4);
  }
});

test('duplicate and stale lifecycle signals cannot revive a stopped run or double-account a continuation', t => {
  const finished = [], calls = tracker(t, { finished: (_call, event) => finished.push(event) });
  calls.subagent(signal('start', 'child', 1, { toolUseId: 'toolu_child' }));
  calls.subagent(signal('stop', 'child', 2));
  calls.subagent(signal('stop', 'child', 2));
  calls.subagent(signal('start', 'child', 1));
  assert.equal(calls.running().length, 0);
  assert.equal(finished.length, 1);
  calls.subagent(signal('continue', 'child', 3, { toolUseId: 'continue-1' }));
  calls.subagent(signal('start', 'child', 4));
  calls.subagent(signal('continue', 'child', 3, { toolUseId: 'continue-1' }));
  calls.subagent(signal('stop', 'child', 5));
  calls.subagent(signal('stop', 'child', 5));
  calls.subagent(signal('continue', 'child', 6, { toolUseId: 'continue-1' }));
  assert.equal(calls.running().length, 0, 'replayed continuation identity cannot reopen the run');
  assert.equal(finished.length, 2);
  assert.equal(new Set(finished.map(event => event.id)).size, 2);
  assert.equal(items(calls).length, 1);
});

test('a continuation cancels the previous retirement timer and retains its open feed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = tracker(t);
  calls.subagent(signal('start'));
  calls.subagent(signal('stop', 'child', 1));
  t.mock.timers.tick(2000);
  calls.subagent(signal('continue', 'child', 2, { toolUseId: 'continue-1' }));
  t.mock.timers.tick(30000);
  assert.equal(items(calls)[0].hidden, false);
  assert.equal(calls.running().length, 1);
  const call = calls.calls.values().next().value;
  assert.equal(calls.feeds.owned(call).completedAt, undefined);
});

test('old sessions, other terminals and invalid lifecycle identities never add rows', t => {
  const f = hooks(t);
  f.take('SubagentStart', { session_id: 'old-parent', agent_id: 'child' });
  f.take('SubagentStart', { agent_id: '../child' });
  f.s.codexActive = false;
  f.take('SubagentStart', { agent_id: 'inactive' });
  assert.equal(items(f.calls).length, 0);
  assert.equal(f.calls.subagent(signal('start', 'other', 1, { terminalId: 'another-terminal' })), false);
  assert.equal(f.calls.subagent(signal('start', 'child', 1, { at: NaN })), false);
});

test('SSH toolUseId binds a foreground child before its result and temporary partial flags recover without resetting history', async t => {
  const calls = tracker(t), records = (await fs.readFile(path.join(__dirname, 'fixtures/claude-subagent-ssh.compact.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  calls.apply(use());
  calls.remoteRecords({ child: { toolUseId: 'toolu_child', records: records.slice(0, 3), reset: true, partial: false, behind: true } });
  assert.deepEqual(calls.remoteSubagents(), ['child']);
  assert.equal(calls.snapshot()[0].rate.outputTokens, 45);
  calls.remoteRecords({ child: { toolUseId: 'toolu_child', records: [], reset: false, partial: true, behind: true } });
  assert.equal(calls.snapshot()[0].rate.partial, true);
  calls.remoteRecords({ child: { toolUseId: 'toolu_child', records: records.slice(3), reset: false, partial: false, behind: false } });
  assert.equal(calls.snapshot()[0].rate.partial, false);
  assert.equal(calls.snapshot()[0].rate.outputTokens, 75);
});

test('a temporary SSH partial flag changes each poll without losing earlier response samples', async t => {
  const calls = tracker(t), records = (await fs.readFile(path.join(__dirname, 'fixtures/claude-subagent-ssh.compact.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  calls.apply(use('toolu_child', { run_in_background: true })); calls.apply(result(1));
  calls.remoteRecords({ child: { records: records.slice(0, 3), reset: true, partial: false, behind: true } });
  calls.remoteRecords({ child: { records: [], reset: false, partial: true, behind: true } });
  assert.equal(calls.snapshot()[0].rate.partial, true);
  calls.remoteRecords({ child: { records: records.slice(3), reset: false, partial: false, behind: false } });
  assert.equal(calls.snapshot()[0].rate.partial, false);
  assert.equal(calls.snapshot()[0].rate.outputTokens, 75);
});

test('a continued child accounts each run from its own response samples exactly once', async t => {
  const finished = [], calls = tracker(t, { finished: (_call, event) => finished.push(event) });
  const records = (await fs.readFile(path.join(__dirname, 'fixtures/claude-subagent-ssh.compact.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  calls.subagent(signal('start', 'child', 0, { toolUseId: 'toolu_child' }));
  calls.remoteRecords({ child: { records, reset: true, partial: false, behind: false } });
  calls.subagent(signal('stop', 'child', 9));
  calls.subagent(signal('continue', 'child', 10, { toolUseId: 'continue-1' }));
  const continued = records.map(record => ({ ...record, timestamp: new Date(Date.parse(record.timestamp) + 10000).toISOString() }));
  calls.remoteRecords({ child: { records: [...records, ...continued], reset: false, partial: false, behind: false } });
  calls.subagent(signal('stop', 'child', 19));
  assert.deepEqual(finished.map(event => event.outputTokens), [75, 75]);
  assert.equal(new Set(finished.map(event => event.id)).size, 2);
});

for (const end of ['reset', 'dispose', 'monitor']) {
  test(`${end} records ended-but-behind runs once as partial`, t => {
    const finished = [], calls = tracker(t, { finished: (_call, event) => finished.push(event) });
    calls.apply(use('toolu_child', { run_in_background: true }));
    calls.apply(result(1));
    calls.remoteRecords({ child: { records: [], reset: true, partial: false, behind: true } });
    calls.apply({ type: 'user', timestamp: new Date(at(4)).toISOString(), message: { content:
      '<task-notification><tool-use-id>toolu_child</tool-use-id><status>completed</status></task-notification>' } });
    assert.equal(finished.length, 0);
    if (end === 'monitor') {
      const project = { id: 'p', kind: 'ssh', path: '/project' }, s = { terminalId: 't', codexActive: true, agent: 'claude' };
      const deps = { sessions: new Map([['t', s]]), claudeConfigDir: () => '/unused', callsOf: () => calls,
        monitorActivity: () => ({ poll: async () => {}, stop() {} }), applyActivity() {} };
      createClaudeActivity(deps).followClaude(project, s, { sessionId: 'parent', transcriptPath: '/claude/projects/project/parent.jsonl' });
      s.activityMonitor.stop(); s.activityMonitor.stop();
    } else { calls[end](); calls[end](); }
    assert.equal(finished.length, 1, end);
    assert.equal(finished[0].partial, true, end);
    assert.equal(finished[0].outputTokens, null, end);
    assert.equal(finished[0].totalOutputTokens, null, end);
  });
}

test('transcript history reset retains a signal-held row while parent exit clears it', t => {
  const calls = tracker(t);
  calls.subagent(signal('start'));
  const id = items(calls)[0].id;
  calls.reset(true);
  assert.equal(calls.running().length, 1);
  assert.equal(items(calls)[0].id, id);
  calls.endSession();
  assert.deepEqual(items(calls), []);
});

test('local metadata joins a hook-first row to the tool identity before the foreground result', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-d3a-meta-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const calls = tracker(t, { local: true });
  calls.setFolder(folder); calls.subagent(signal('start'));
  const id = items(calls)[0].id;
  await fs.writeFile(path.join(folder, 'agent-child.meta.json'), JSON.stringify({ toolUseId: 'toolu_child' }));
  calls.apply(use()); await calls.work;
  assert.equal(items(calls).length, 1);
  assert.equal(items(calls)[0].id, id);
  assert.equal(calls.running().length, 1);
});

test('a local child transcript supplies its own rate without inheriting the parent settings', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-d3a-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const calls = tracker(t, { local: true });
  calls.setFolder(folder);
  calls.subagent(signal('start'));
  await calls.work;
  assert.equal(items(calls).length, 1);
  assert.equal(items(calls)[0].viewable, false);
  const records = await fs.readFile(path.join(__dirname, 'fixtures/claude-subagent-ssh.jsonl'), 'utf8');
  await fs.writeFile(path.join(folder, 'agent-child.jsonl'), records);
  const call = calls.calls.values().next().value;
  calls.refresh(call.key); await calls.work;
  assert.equal(calls.snapshot()[0].model, 'claude-opus-5-5');
  assert.equal(calls.snapshot()[0].rate.outputTokens, 75);
  assert.equal(items(calls)[0].viewable, true);
  assert.equal(calls.running().length, 1);
});

test('an intercepted declaration preserves source through starting, running and ended AgentCall items', t => {
  const calls = tracker(t), id = 'dispatch-worker';
  calls.dispatch({ type: 'dispatch-declared', id, source: 'intercepted', agent: 'claude', role: 'execution', title: 'Inspect parser', cwd: '/project',
    requested: { model: 'sonnet', effort: 'high', fast: false }, at: at(0) });
  assert.equal(items(calls)[0].source, 'intercepted');
  calls.dispatch({ type: 'dispatch-start', id, agent: 'claude', role: 'execution', title: 'Inspect parser', cwd: '/project',
    model: 'claude-sonnet', effort: 'high', fast: false, startedAt: at(1) });
  assert.equal(items(calls)[0].source, 'intercepted');
  calls.dispatch({ type: 'dispatch-end', id, endedAt: at(2), reason: 'error', exitCode: 1, outputTokens: null, activeMs: null });
  assert.equal(items(calls)[0].source, 'intercepted');
});
