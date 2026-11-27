const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { queryOptions } = require('../electron/features/claude-sdk/query.cjs');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { terminalHooks } = require('../electron/features/terminal-events/hook-channel.cjs');
const { writeBootstrap, removeBootstrap, updateBootstrapLead, updateDispatchSeats } = require('../electron/features/terminal-events/bootstrap-file.cjs');
const { argumentsOf, commandOf, WorkerOutput } = require('../integration/dispatch.cjs');
const { seatRouting } = require('../integration/agent-event.cjs');
const { adapterOfModel, agentOfModel } = require('../electron/features/routing/seat-rules.mjs');
const { CLAUDE_EFFORT, agentOfModel: workerAgentOfModel } = require('../electron/features/agents/call-seat.cjs');

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
function assertSeatDenied(output, seat, message) {
  const { hookSpecificOutput: decision } = output ?? {};
  assert.equal(decision?.permissionDecision, 'deny');
  assert.equal(decision.hookEventName, 'PreToolUse');
  assert.match(decision.permissionDecisionReason, message);
  assert.ok(decision.permissionDecisionReason.includes(`Use start_role with seat="${seat}".`));
  assert.match(decision.permissionDecisionReason, /use ToolSearch to load mcp__agentrix__start_role/);
  assert.match(decision.permissionDecisionReason, /Do not retry with an Agent call that omits \[seat\]/);
  assert.equal(decision.updatedInput, undefined);
}
const developer = { model: 'opus', effort: 'low' };
const frontend = { model: 'claude-sonnet-5-5', agentModel: 'sonnet', effort: 'high' };
const specialtyCases = [
  ['developer/frontend', { developer, frontend }, frontend],
  ['developer/frontend', { frontend }, frontend],
  ['developer/frontend', { developer }, developer],
  ['developer/frontend', {}, null],
  ['x-mobile', { 'x-mobile': frontend }, frontend],
  ['x-mobile', { developer }, null],
];
module.exports = { specialtyCases };

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
  const modified = { ...input, prompt: 'Owner hook changed this', run_in_background: false };
  assert.deepEqual((await pre(hook(modified))).hookSpecificOutput.updatedInput, { ...modified, model: 'sonnet', effort: 'high' });
});

test('Agent and Task launch the enabled specialty, fall back to Developer, or leave an off-team call alone', () => {
  for (const [seat, map, choice] of specialtyCases) {
    for (const toolName of ['Agent', 'Task']) {
      const tool = { ...input, description: `[${seat}] Check the UI` };
      const result = seatRouting(JSON.stringify(hook(tool, toolName)), JSON.stringify(map));
      const update = result.output?.hookSpecificOutput?.updatedInput;
      assert.deepEqual(update, choice ? { ...tool, model: choice.agentModel ?? choice.model, effort: choice.effort } : undefined, seat);
      if (!choice) assert.deepEqual(result, {}, seat);
    }
  }
});

test('a seat rewrite failure leaves the SDK hook answer empty while policy errors still block', async t => {
  const broken = new Proxy(seats, { ownKeys() { throw new Error('broken seat map'); } });
  const [matcher] = sdkHooks(t, broken).PreToolUse;
  assert.equal(matcher.onFailure, 'block');
  assert.deepEqual(await matcher.hooks[0](hook()), {});
  const pre = sdkHooks(t, seats, () => { throw new Error('policy failed'); }).PreToolUse[0].hooks[0];
  await assert.rejects(pre(hook()), /policy failed/);
});

test('unknown, untagged, disabled, and non-Agent calls leave their inputs untouched', async t => {
  const pre = sdkHooks(t).PreToolUse[0].hooks[0];
  for (const description of ['Sketch', '[unknown] Sketch', 'Use [designer] Sketch']) {
    const payload = hook({ ...input, description });
    assert.deepEqual(await pre(payload), {});
    assert.deepEqual(seatRouting(JSON.stringify(payload), JSON.stringify(seats)), {});
  }
  assert.deepEqual(await pre(hook(input, 'Bash')), {});
  assert.deepEqual(await sdkHooks(t, null).PreToolUse[0].hooks[0](hook()), {});
});

test('native and terminal Agent hooks deny the Codex Developer seat and still report the mismatch', async t => {
  const reports = [];
  const pre = sdkHooks(t, seats, deferred, (_input, result) => reports.push(result)).PreToolUse[0].hooks[0];
  const payload = hook({ ...input, description: '[developer] P2-A world layout' });
  const native = await pre(payload);
  const terminal = seatRouting(JSON.stringify(payload), JSON.stringify(seats));
  assert.deepEqual([native, terminal.output].map(output => output?.hookSpecificOutput?.permissionDecision), ['deny', 'deny']);
  assertSeatDenied(native, 'developer', /uses Codex/);
  assertSeatDenied(terminal.output, 'developer', /uses Codex/);
  const observed = { toolUseId: payload.tool_use_id, phase: 'pre', model: null, effort: null, expected: seats.developer };
  assert.deepEqual(reports, [observed, { note: terminal.output.systemMessage }]);
  assert.match(terminal.output.systemMessage, /uses Codex/);
  assert.deepEqual(terminal.observed, { ...observed, sessionId: payload.session_id });
});

test('unsupported Claude Agent settings are denied without replacing existing SDK policy', async t => {
  const notices = [];
  const pre = sdkHooks(t, seats, deferred, (_input, result) => { if (result.note) notices.push(result.note); }).PreToolUse[0].hooks[0];
  for (const [seat, tool] of [['qa', input], ['reviewer', input], ['designer', { ...input, subagent_type: 'fork' }]]) {
    const payload = hook({ ...tool, description: `[${seat}] Review` });
    assertSeatDenied(await pre(payload), seat, /cannot apply/);
    assertSeatDenied(seatRouting(JSON.stringify(payload), JSON.stringify(seats)).output, seat, /cannot apply/);
    assert.match(notices.at(-1), /cannot apply/);
  }
  assert.equal(notices.length, 3);
  const denied = sdkHooks(t, seats, () => ({ behavior: 'deny', reason: 'limited' })).PreToolUse[0].hooks[0];
  assert.deepEqual(await denied(hook()), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'limited' } });
});

test('a foreground call shows its seat before PostToolUse and reconciles final input and child records', async t => {
  const calls = new AgentCalls({ local: false, roles: () => Object.keys(seats) });
  t.after(() => calls.dispose());
  const hooks = sdkHooks(t, seats, deferred, (_input, result) => calls.observeSeatInput(result));
  const pre = hooks.PreToolUse[0].hooks[0], post = hooks.PostToolUse[0].hooks[0];
  const foreground = { ...input, run_in_background: false };
  await pre(hook(foreground));
  calls.apply({ type: 'assistant', timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: foreground }] } });
  assert.deepEqual([calls.snapshot()[0].model, calls.snapshot()[0].effort], ['sonnet', 'high']);
  const expectedSeat = { model: seats.designer.model, effort: 'high', fast: false };
  assert.deepEqual(calls.snapshot()[0].items[0].expected, expectedSeat);
  await post(hook({ ...foreground, model: 'opus', effort: 'low' }, 'Agent', 'PostToolUse'));
  calls.observeSeatInput({ toolUseId: 'toolu_1', phase: 'pre', model: 'haiku', effort: 'low',
    expected: { model: 'haiku', effort: 'low', fast: false } });
  assert.deepEqual([calls.snapshot()[0].model, calls.snapshot()[0].effort], ['opus', 'low']);
  assert.deepEqual(calls.snapshot()[0].items[0].expected, expectedSeat);
  calls.remoteRecords({ child: { toolUseId: 'toolu_1', records: [{ type: 'assistant', timestamp: new Date().toISOString(),
    perTurnEffort: 'max', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done' }] } }] } });
  assert.deepEqual([calls.snapshot()[0].model, calls.snapshot()[0].effort], ['claude-opus-5-5', 'max']);
});

test('a PostToolUse receipt updates activity whether it arrives before or after the parent tool record', async t => {
  for (const receiptFirst of [true, false]) {
    const calls = new AgentCalls({ local: false, roles: () => Object.keys(seats) });
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
  const launchSeats = fs.readFileSync(file + '.lead', 'utf8').split('\n')[3];
  updateBootstrapLead(file, { ...launch, seatsMap: { designer: { model: 'haiku', effort: 'low' } } });
  assert.deepEqual(seatRouting(JSON.stringify(hook()), launchSeats), {
    output: expected, observed: { toolUseId: 'toolu_1', model: 'sonnet', effort: 'high', sessionId: 'fixture', phase: 'pre',
      expected: { model: seats.designer.model, effort: 'high', fast: false } },
  });
  assert.deepEqual(seatRouting(JSON.stringify(hook()), 'null'), {});
  assert.deepEqual(seatRouting(JSON.stringify(hook(rewritten, 'Agent', 'PostToolUse')), launchSeats),
    { observed: { toolUseId: 'toolu_1', model: 'sonnet', effort: 'high', sessionId: 'fixture', phase: 'post' } });
});

test('a running terminal and SDK query read new seats and fall back on malformed or missing data', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bootstrapFile = path.join(dir, 'terminal.json'), sidecar = bootstrapFile + '.seats';
  const abort = new AbortController();
  t.after(() => abort.abort());
  const notices = [];
  const { hooks } = queryOptions({ owner: 'gui', cwd: dir, env: {}, seatsMap: seats, bootstrapFile },
    { key: 'synthetic', abort, policy: deferred, onSeat: (_input, receipt) => { if (receipt.note) notices.push(receipt.note); } });
  const pre = hooks.PreToolUse[0].hooks[0], payload = hook();
  const terminal = () => seatRouting(JSON.stringify(payload), JSON.stringify(seats), bootstrapFile).output ?? {};
  const check = async choice => { assert.deepEqual(terminal(), choice); assert.deepEqual(await pre(payload), choice); };
  await check(expected);
  updateDispatchSeats(bootstrapFile, { designer: { model: 'haiku', effort: 'low' } });
  const live = { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, model: 'haiku', effort: 'low' } } };
  await check(live);
  assert.deepEqual(seatRouting(JSON.stringify(payload), 'null', bootstrapFile).output, live);
  for (const [choice, tool, message] of [
    [seats.developer, input, /uses Codex/], [seats.qa, input, /cannot apply/],
    [{ model: 'gemini-3.8-flash', effort: 'low' }, input, /uses Antigravity/],
    [seats.designer, { ...input, subagent_type: 'fork' }, /cannot apply/],
  ]) {
    updateDispatchSeats(bootstrapFile, { designer: choice });
    const current = hook(tool);
    assertSeatDenied(await pre(current), 'designer', message);
    assertSeatDenied(seatRouting(JSON.stringify(current), null, bootstrapFile).output, 'designer', message);
    assert.match(notices.at(-1), message);
  }
  assert.equal(notices.length, 4);
  if (process.platform !== 'win32') assert.equal(fs.statSync(sidecar).mode & 0o777, 0o600);
  for (const malformed of ['{', '{"designer":{"model":"-bad","effort":"low"}}', '{"bad/id":{"model":"haiku","effort":"low"}}',
    '{"designer":{"model":"haiku","effort":"HIGH"}}', JSON.stringify({ extra: '界'.repeat(3000) }), Buffer.from([0xff])]) {
    fs.writeFileSync(sidecar, malformed);
    await check(expected);
  }
  updateDispatchSeats(bootstrapFile, {});
  await check({});
  fs.unlinkSync(sidecar);
  await check(expected);
});

test('Codex dispatch resolves its seat before admission through the private bootstrap snapshot', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-seats-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'dispatch.json'), env = { AGENTRIX_BOOTSTRAP: file };
  writeBootstrap({ file, eventServer: { name: 'fixture', address: '/fixture' }, dispatchSeats: seats });
  const argv = ['codex', '--role', 'investigate', '--title', 'Test', '--cwd', '.', '--brief', 'brief.md', '--out', 'out.md', '--seat', 'developer/backend'];
  const launch = argumentsOf(argv, env);
  assert.deepEqual([launch.model, launch.effort, launch.fast], ['gpt-6.2-sol', 'xhigh', true]);
  updateDispatchSeats(file, { developer: { model: 'gpt-6.2-astra', effort: 'high', fast: false } });
  assert.equal(argumentsOf(argv, env).model, 'gpt-6.2-astra');
  assert.equal(argumentsOf(argv, { ...env, AGENTRIX_SEATS: JSON.stringify(seats) }).model, 'gpt-6.2-astra');
  assert.equal(argumentsOf([...argv, '--model', 'gpt-explicit', '--effort', 'medium', '--fast'], env).model, 'gpt-explicit');
  const frozenEnv = { ...env, AGENTRIX_SEATS: JSON.stringify(seats) };
  const oldFlags = [...argv, '--model', launch.model, '--effort', launch.effort, '--fast'];
  for (const launchEnv of [env, frozenEnv]) {
    const stale = argumentsOf(oldFlags, launchEnv);
    assert.deepEqual([stale.model, stale.effort, stale.fast], ['gpt-6.2-astra', 'high', false]);
  }
  updateDispatchSeats(file, { developer });
  assert.throws(() => argumentsOf(oldFlags, env), /uses claude/);
  assert.deepEqual(JSON.parse(updateDispatchSeats(file, { ...seats, padding: '\u754c'.repeat(3000) })),
    { format: 'agentrix.seat-map', version: 1, seats: null });
  assert.equal(argumentsOf(argv, env).model, launch.model);
  assert.equal(argumentsOf(argv, { ...env, AGENTRIX_SEATS: JSON.stringify(seats) }).model, launch.model);
  removeBootstrap(file);
  assert.equal(fs.existsSync(file + '.seats'), false);
  assert.equal(fs.existsSync(file + '.launch-seats'), false);
});

test('a Windows sharing violation retries the atomic seat write', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-seats-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'dispatch.json'), rename = fs.renameSync;
  updateDispatchSeats(file, seats);
  let attempts = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (++attempts <= 2) throw Object.assign(new Error('busy'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
    return rename(from, to);
  });
  updateDispatchSeats(file, { developer });
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.seats', 'utf8')), { format: 'agentrix.seat-map', version: 1, seats: { developer } });
  assert.deepEqual(fs.readdirSync(directory), ['dispatch.json.seats']);
});

test('a failed dispatch seat snapshot write leaves the required bootstrap usable', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-seats-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'dispatch.json'), sidecar = file + '.seats';
  fs.mkdirSync(sidecar);
  const snapshot = writeBootstrap({ file, eventServer: { name: 'fixture', address: '/fixture' }, sessionKey: 'fixture-key', dispatchSeats: seats });
  assert.equal(snapshot, undefined);
  const bootstrap = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(bootstrap.sessionKey, 'fixture-key');
  assert.equal(bootstrap.pipeName, process.platform === 'win32' ? 'fixture' : '/fixture');
  assert.equal(Object.hasOwn(bootstrap, 'dispatchSeats'), false);
});

test('the CLI registry and the carried CJS helper agree on Claude model family and built-in effort values', () => {
  const ids = ['opus', 'haiku', 'sonnet', 'fable', 'claude-internal', 'opus-next', 'gpt-6.2-sol', 'o4-mini', 'x-claude-opus'];
  assert.deepEqual(ids.map(workerAgentOfModel), ids.map(agentOfModel));
  const effortValues = ['low', 'medium', 'high', 'xhigh', 'max', 'adaptive', 'HIGH'];
  assert.deepEqual(effortValues.filter(effort => CLAUDE_EFFORT.test(effort)), adapterOfModel('sonnet').manifest.models.efforts);
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
