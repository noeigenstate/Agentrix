const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { queryOptions } = require('../electron/features/claude-sdk/query.cjs');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { terminalHooks } = require('../electron/features/terminal-events/hook-channel.cjs');
const { updateBootstrapLead } = require('../electron/features/terminal-events/bootstrap-file.cjs');
const { argumentsOf, commandOf, WorkerOutput } = require('../integration/dispatch.cjs');
const { seatRouting } = require('../integration/agent-event.cjs');

const seats = {
  designer: { model: 'claude-sonnet-5-5', agentModel: 'sonnet', effort: 'high', fast: false },
  developer: { model: 'gpt-6.2-sol', effort: 'xhigh', fast: true },
  qa: { model: 'claude-opus-5[1m]', effort: 'high' },
  reviewer: { model: 'opus', effort: 'adaptive' },
};
const input = { description: '[designer] Mockup role library', prompt: 'Make a sketch', model: 'haiku', effort: 'medium', run_in_background: true };
const hook = (tool_input = input, tool_name = 'Agent', hook_event_name = 'PreToolUse') =>
  ({ tool_input, tool_name, hook_event_name, session_id: 'fixture', tool_use_id: 'toolu_1' });
const rewritten = { ...input, model: 'sonnet', effort: 'high' };
const expected = { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: rewritten } };
const deferred = () => ({ behavior: 'defer' });
function sdkHooks(t, seatsMap = seats, policy = deferred, onSeat) {
  const abort = new AbortController();
  t.after(() => abort.abort());
  return queryOptions({ env: {}, cwd: process.cwd(), owner: 'gui', seatsMap }, { key: 'synthetic', abort, policy, onSeat }).hooks;
}

test('native Agent and Task hooks overwrite model and effort from the frozen choice', async t => {
  const pre = sdkHooks(t).PreToolUse[0].hooks[0];
  assert.deepEqual(await pre(hook()), expected);
  assert.deepEqual(await pre(hook(input, 'Task')), expected);
  assert.deepEqual(await pre(hook(rewritten)), {});
  assert.equal(input.effort, 'medium');
  assert.deepEqual(await pre(hook({ ...input, description: '[designer/web] Sketch' })),
    { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...rewritten, description: '[designer/web] Sketch' } } });
});

test('unknown, untagged, disabled, and non-Agent calls leave their inputs untouched', async t => {
  const pre = sdkHooks(t).PreToolUse[0].hooks[0];
  for (const description of ['Sketch', '[unknown] Sketch', 'Use [designer] Sketch']) {
    assert.deepEqual(await pre(hook({ ...input, description })), {});
  }
  assert.deepEqual(await pre(hook(input, 'Bash')), {});
  assert.deepEqual(await sdkHooks(t, null).PreToolUse[0].hooks[0](hook()), {});
});

test('Codex and unsupported Agent settings show a note without changing tool input or policy', async t => {
  const notices = [];
  const pre = sdkHooks(t, seats, deferred, (_input, result) => notices.push(result.note)).PreToolUse[0].hooks[0];
  for (const seat of ['developer', 'qa', 'reviewer']) {
    const result = await pre(hook({ ...input, description: `[${seat}] Review` }));
    assert.deepEqual(Object.keys(result), ['systemMessage']);
    assert.match(result.systemMessage, seat === 'developer' ? /dispatch helper/ : /cannot apply/);
  }
  assert.match((await pre(hook({ ...input, subagent_type: 'fork' }))).systemMessage, /cannot apply/);
  assert.equal(notices.length, 4);
  const denied = sdkHooks(t, seats, () => ({ behavior: 'deny', reason: 'limited' })).PreToolUse[0].hooks[0];
  assert.deepEqual(await denied(hook()), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'limited' } });
});

test('a PostToolUse receipt updates activity whether it arrives before or after the parent tool record', async t => {
  for (const receiptFirst of [true, false]) {
    const calls = new AgentCalls({ local: false, seatIds: () => Object.keys(seats) });
    t.after(() => calls.dispose());
    const post = sdkHooks(t, seats, deferred, (_input, result) => calls.observeSeatInput(result)).PostToolUse[0].hooks[0];
    const applied = hook(rewritten, 'Agent', 'PostToolUse');
    if (receiptFirst) await post(applied);
    calls.apply({ type: 'assistant', timestamp: new Date().toISOString(),
      message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input }] } });
    if (!receiptFirst) {
      await post(hook(input, 'Agent', 'PostToolUse'));
      assert.equal(calls.snapshot()[0].effort, 'medium');
      await post(applied);
    }
    assert.equal(calls.snapshot()[0].effort, 'high');
    assert.equal(calls.snapshot()[0].model, 'sonnet');
    const child = { type: 'assistant', timestamp: new Date().toISOString(), perTurnEffort: 'max',
      message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Sketch' }] } };
    calls.remoteRecords({ child: { toolUseId: 'toolu_1', records: [], reset: true } });
    assert.equal(calls.snapshot()[0].effort, 'high');
    calls.remoteRecords({ child: { toolUseId: 'toolu_1', records: [child] } });
    assert.equal(calls.snapshot()[0].effort, 'max');
  }
});

test('HTTP and fallback settings keep observing progress and add a synchronous Agent routing command', () => {
  const hooks = terminalHooks({ port: 4242, seatRouting: true, terminalId: 't', sessionKey: 'test-key',
    eventServer: { name: 'test-pipe', address: '/test.sock' }, env: {}, cwd: '/fixture', read: () => '{}',
    shell: { posix: true, node: process.execPath, helper: '/agent-event.cjs' } });
  for (const mode of ['http', 'fallback']) {
    const { PreToolUse, PostToolUse } = JSON.parse(hooks.settings[mode]).hooks;
    for (const [original, route] of [PreToolUse, PostToolUse]) {
      assert.equal(original.hooks[0].type, mode === 'http' ? 'http' : 'command');
      assert.equal(route.matcher, 'Agent|Task');
      assert.equal(route.hooks[0].async, undefined);
      assert.match(route.hooks[0].command, / seat-routing$/);
    }
  }
});

test('terminal launch snapshots drive the command hook without reading profile settings', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-routing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.json');
  const launch = { model: 'opus', effort: 'medium', seatsMap: seats };
  updateBootstrapLead(file, launch);
  const launchSeats = fs.readFileSync(file + '.lead', 'utf8').split('\n')[5];
  updateBootstrapLead(file, { ...launch, seatsMap: { designer: { model: 'haiku', effort: 'low' } } });
  assert.deepEqual(seatRouting(JSON.stringify(hook()), launchSeats), { output: expected });
  assert.deepEqual(seatRouting(JSON.stringify(hook()), 'null'), {});
  assert.deepEqual(seatRouting(JSON.stringify(hook(rewritten, 'Agent', 'PostToolUse')), launchSeats),
    { observed: { toolUseId: 'toolu_1', model: 'sonnet', effort: 'high', sessionId: 'fixture' } });
});

test('dispatch fills omitted flags from its launch snapshot and preserves explicit values', () => {
  const env = { AGENTRIX_SEATS: JSON.stringify(seats) };
  const base = ['--role', 'investigate', '--title', 'Test', '--cwd', '.', '--brief', 'brief.md', '--out', 'out.md'];
  const codex = argumentsOf(['codex', ...base, '--seat', 'developer/backend'], env);
  assert.deepEqual([codex.model, codex.effort, codex.fast], ['gpt-6.2-sol', 'xhigh', true]);
  const claude = argumentsOf(['claude', ...base, '--seat', 'designer', '--permission', 'plan', '--effort', 'medium', '--fast'], env);
  assert.deepEqual(commandOf(claude).slice(0, 7), ['-p', '--model', 'claude-sonnet-5-5', '--effort', 'medium', '--settings', '{"fastMode":true}']);
  const standard = argumentsOf(['claude', ...base, '--seat', 'designer', '--permission', 'plan'], env);
  assert.deepEqual(commandOf(standard).slice(5, 7), ['--settings', '{"fastMode":false}']);
  assert.throws(() => argumentsOf(['claude', ...base, '--seat', 'developer', '--permission', 'plan'], env), /Missing --model/);
  assert.throws(() => argumentsOf(['codex', ...base, '--seat', 'developer'], {}), /Missing --model/);
});

test('dispatch uses provider settings and leaves missing effort and speed unreported', () => {
  const output = new WorkerOutput('codex');
  output.nativeRouting({ declared: { model: 'gpt-6.2-sol', effort: 'high', fast: true }, effective: { model: 'gpt-6.2-sol' } });
  assert.deepEqual(output.routing(), { model: 'gpt-6.2-sol', effort: null, fast: null });
  output.nativeRouting({ effective: { model: 'gpt-6.2-sol', effort: 'medium', fast: false } });
  assert.deepEqual(output.routing(), { model: 'gpt-6.2-sol', effort: 'medium', fast: false });
  output.nativeRouting({ effective: { model: 'gpt-6.2-sol', effort: 'high', fast: true }, observed: { effort: 'max', fast: false } });
  assert.deepEqual(output.routing(), { model: 'gpt-6.2-sol', effort: 'max', fast: false });
});
