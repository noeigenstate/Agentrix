const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { createClaudeSession } = require('../electron/features/claude-sdk/session.cjs');
const { queryOptions } = require('../electron/features/claude-sdk/query.cjs');
const { createUsage } = require('../electron/features/claude-sdk/usage.cjs');
const { encodeClaudeCwd } = require('../electron/claude-sessions.cjs');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { sameDirectory } = require('../electron/session-files.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');

const at = seconds => Date.UTC(2026, 0, 1) + seconds * 1000;
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
async function until(check) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('native sub-agent reports did not settle');
}

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-native-subagents-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const cwd = path.join(directory, 'project'), home = path.join(directory, 'config');
  const parentId = 'parent-session', projectFolder = path.join(home, 'projects', encodeClaudeCwd(cwd));
  fs.mkdirSync(cwd); fs.mkdirSync(projectFolder, { recursive: true });
  const transcript = path.join(projectFolder, `${parentId}.jsonl`);
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', cwd, sessionId: parentId, message: { content: 'Parent prompt' } }) + '\n');
  return { directory, cwd, home, parentId, transcript, folder: path.join(projectFolder, parentId, 'subagents') };
}

function nativeHost(f, calls) {
  const project = { id: 'project', kind: 'local', path: f.cwd }, sessions = new Map(), nativeSpecs = new Map();
  const s = { terminalId: 'terminal', agent: 'claude', nativeStructured: true, codexActive: true,
    status: 'codex', nativeRuntimeSessionId: 'native-run', claudeSessionId: f.parentId };
  let scheduled = 0;
  const context = vm.createContext({ path, randomUUID, sessions, nativeSpecs, quitting: false,
    store: { findTerminal: () => ({ project, record: { restore: {} } }), settings: {}, expectCompletion() { assert.fail('a child hook must not rearm completion'); } },
    findProject: () => project, disposeTerminal() {}, runtimeDir: f.directory, eventServer: {}, controlAddress: 'offline',
    writeBootstrap() {}, nativeEnvironment: () => ({ CLAUDE_CONFIG_DIR: f.home, PATH: '' }),
    startupNote: () => '', handoffFile: () => '', READING_NOTE: '', integrationDir: f.directory,
    skills: { delivery: () => ({}) }, callsOf: current => { assert.equal(current, s); return calls; },
    scheduleState: () => { scheduled++; } });
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function nativeSpec('), source.indexOf('function structuredEvent(')), context);
  const spec = context.nativeSpec('terminal', 'claude', false);
  s.nativeSpec = spec; sessions.set('terminal', s);
  return { spec, s, context, sessions, nativeSpecs, scheduled: () => scheduled };
}

async function sessionFixture(t, f, onSubagent, options = {}) {
  const fake = fakeSdk({ auto: false, sessionId: f.parentId, ...options }), events = [];
  let now = at(0);
  const spec = { owner: 'gui', agent: 'claude', terminalId: 'terminal', projectId: 'project', runtimeSessionId: 'native-run',
    cwd: f.cwd, env: { CLAUDE_CONFIG_DIR: f.home, PATH: '' }, model: 'claude-opus-5-5', effort: 'high', onSubagent };
  const session = createClaudeSession(spec, event => events.push(event), {
    loadSdk: async () => fake.sdk, resolveExecutable: async () => 'offline-only',
    credentials: { status: () => ({ saved: true }), read: () => 'sk-ant-offline-native-subagents' },
    usage: createUsage({ file: path.join(f.directory, 'usage.json'), now: () => now }), now: () => now,
    canContinue: () => spec.mayContinue?.() !== false,
  });
  t.after(() => session.close());
  await session.start(); await session.send({ clientMessageId: 'parent-input', text: 'Parent task' }); await tick();
  const hook = (name, input, toolUseId) => {
    const callback = fake.calls[0].options.hooks[name]?.[0]?.hooks[0];
    assert.equal(typeof callback, 'function', `${name} is registered on the real query options`);
    return callback({ session_id: f.parentId, transcript_path: f.transcript, cwd: f.cwd,
      hook_event_name: name, agent_id: 'child', agent_type: 'Explore', ...input }, toolUseId, { signal: new AbortController().signal });
  };
  return { spec, fake, events, session, hook, clock: value => { now = at(value); } };
}

test("a native Claude session's Agent-tool sub-agent has its row from SubagentStart, its rate from its transcript, and ends on SubagentStop", async t => {
  const f = workspace(t), calls = new AgentCalls({ terminalId: 'terminal', claudeHome: () => f.home, now: () => at(0) });
  t.after(() => calls.dispose());
  const host = nativeHost(f, calls), runtime = await sessionFixture(t, f, host.spec.onSubagent);
  assert.equal(fs.existsSync(f.folder), false);
  assert.deepEqual(await runtime.hook('SubagentStart'), {});
  const rows = () => calls.snapshot().flatMap(group => group.items);
  await until(() => rows().length === 1);
  assert.equal(rows().length, 1, 'the hook creates a row before the child transcript exists');
  assert.equal(calls.folder, f.folder);
  assert.equal(calls.snapshot()[0].rate, null);
  await calls.work;
  fs.mkdirSync(f.folder, { recursive: true });
  const childFile = path.join(f.folder, 'agent-child.jsonl');
  fs.copyFileSync(path.join(__dirname, 'fixtures/claude-subagent-token-rate.jsonl'), childFile);
  const child = [...calls.calls.values()].find(call => call.agentId === 'child');
  assert.ok(child);
  calls.refresh(child.key); await calls.work;
  assert.equal(calls.snapshot()[0].model, 'claude-opus-5-5');
  assert.equal(calls.snapshot()[0].rate.outputTokens, 120);
  assert.equal(calls.snapshot()[0].rate.activeMs, 5000);
  assert.equal(calls.snapshot()[0].rate.samples, 2);
  runtime.clock(8);
  assert.deepEqual(await runtime.hook('SubagentStop', { agent_transcript_path: childFile }), {});
  await until(() => child.done);
  await calls.work;
  assert.equal(rows().length, 1);
  assert.equal(child.done, true); assert.equal(rows()[0].endedAt, at(8));
  assert.equal(runtime.events.filter(event => event.type === 'turn.completed').length, 0);
  assert.equal(runtime.events.filter(event => event.type === 'usage.updated').length, 0, 'child rates never enter parent usage');
  assert.doesNotMatch(JSON.stringify(runtime.events), /Placeholder finding|Placeholder result/);
});

test('the sub-agent callbacks answer {} and change no query option', async t => {
  const f = workspace(t), abort = new AbortController(), reports = [];
  t.after(() => abort.abort());
  const spec = { owner: 'gui', cwd: f.cwd, env: { PATH: '' }, model: 'claude-opus-5-5', effort: 'high', context: 'Existing context' };
  const options = queryOptions(spec, { abort, key: 'offline-only', executable: 'offline-only', providerSessionId: f.parentId,
    policy: () => ({ behavior: 'deny', reason: 'Existing policy' }), canUseTool: async () => ({ behavior: 'deny' }),
    onSubagent: (...args) => { reports.push(args); if (args[0] === 'stop') throw new Error('offline reporting failure'); } });
  const before = { ...options, hooks: null }, settings = fs.readFileSync(options.settings, 'utf8');
  const input = { session_id: f.parentId, agent_id: 'child', agent_type: 'Explore', transcript_path: f.transcript };
  for (const [event, kind] of [['SubagentStart', 'start'], ['SubagentStop', 'stop']]) {
    const callback = options.hooks[event]?.[0]?.hooks[0]; assert.equal(typeof callback, 'function');
    assert.deepEqual(await callback(input, 'toolu_child', { signal: abort.signal }), {});
    assert.deepEqual(reports.at(-1), [kind, input, 'toolu_child']);
  }
  assert.deepEqual({ ...options, hooks: null }, before);
  assert.equal(fs.readFileSync(options.settings, 'utf8'), settings);
  const policy = await options.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Read', tool_input: { file_path: 'file' } });
  assert.equal(policy.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(options.systemPrompt.append.includes('Existing context'), true);
});

test('native sub-agent signals stay ordered and ignore invalid or retired query callbacks', async t => {
  const f = workspace(t), reports = [];
  const runtime = await sessionFixture(t, f, (signal, binding) => reports.push({ signal, binding }));
  await Promise.all([runtime.hook('SubagentStart', {}, 'toolu_child'), runtime.hook('SubagentStop', { agent_transcript_path: path.join(f.folder, 'agent-child.jsonl') })]);
  await until(() => reports.length === 2);
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[0].signal, { kind: 'start', terminalId: 'terminal', agentId: 'child', agentType: 'Explore',
    transcriptPath: null, toolUseId: 'toolu_child', at: at(0) });
  assert.equal(reports[1].signal.kind, 'stop'); assert.equal(reports[1].signal.toolUseId, null);
  assert.deepEqual(reports[0].binding, { runtimeSessionId: 'native-run', providerSessionId: f.parentId, folder: f.folder });
  await runtime.hook('SubagentStart', { session_id: 'other-session' });
  await runtime.hook('SubagentStart', { agent_id: '../escape' });
  await tick();
  assert.equal(reports.length, 2);
  await runtime.session.close();
  assert.deepEqual(await runtime.hook('SubagentStart'), {});
  assert.equal(reports.length, 2);
});

for (const [title, retirement] of [
  ['an interrupted native query reports stop for every open child before returning idle', 'interrupt'],
  ['a native path change at turn end reports stop for every open child', 'turn-path'],
  ['cancelling an idle native query for a path change reports stop for every open child', 'idle-path'],
  ['a native query stream ending reports stop for every open child', 'stream'],
]) test(title, async t => {
  const f = workspace(t), reports = [];
  const runtime = await sessionFixture(t, f, (signal, binding) => reports.push({ signal, binding }), { interruptResult: false });
  for (const agent_id of ['first', 'second', 'finished']) await runtime.hook('SubagentStart', { agent_id });
  await until(() => reports.length === 3);
  await runtime.hook('SubagentStop', { agent_id: 'finished' });
  await until(() => reports.length === 4);
  assert.equal(Object.hasOwn(reports[3].signal, 'outcome'), false, 'an SDK SubagentStop stays plain');
  runtime.clock(3);
  const result = { type: 'result', uuid: 'parent-result', terminal_reason: 'completed', subtype: 'success', total_cost_usd: 0, modelUsage: {} };
  if (retirement === 'interrupt') {
    await runtime.session.interrupt(); runtime.fake.fail(new Error('offline interrupted query'));
  } else if (retirement === 'stream') runtime.fake.end();
  else {
    if (retirement === 'turn-path') runtime.spec.mayContinue = () => false;
    runtime.fake.emit(result);
    await until(() => runtime.session.snapshot().state === 'idle');
    if (retirement === 'idle-path') { runtime.spec.mayContinue = () => false; runtime.session.policyChanged(); }
  }
  await until(() => runtime.fake.closes.length === 1);
  assert.deepEqual(reports.filter(entry => entry.signal.kind === 'stop').map(entry => entry.signal.agentId).sort(), ['finished', 'first', 'second']);
  for (const entry of reports.slice(4)) {
    assert.equal(entry.signal.kind, 'stop'); assert.equal(entry.signal.at, at(3));
    assert.equal(entry.signal.outcome, 'killed');
    assert.deepEqual(entry.binding, { runtimeSessionId: 'native-run', providerSessionId: f.parentId, folder: f.folder });
  }
  await runtime.hook('SubagentStart', { agent_id: 'late-child' }); await tick();
  assert.equal(reports.length, 6, 'retirement stops once and a late callback cannot revive the run');
  assert.notEqual(runtime.session.snapshot().state, 'failed');
});

for (const backgroundSource of ['snapshot', 'start', 'transition']) test(`native interrupt keeps its query and ${backgroundSource} background children while killing foreground children`, async t => {
  const f = workspace(t), reports = [];
  const calls = new AgentCalls({ terminalId: 'terminal', claudeHome: () => f.home, now: () => at(0) });
  const host = nativeHost(f, calls);
  const runtime = await sessionFixture(t, f, (signal, binding) => { reports.push(signal); host.spec.onSubagent(signal, binding); });
  t.after(() => calls.dispose());
  for (const agent_id of ['foreground', 'background']) await runtime.hook('SubagentStart', { agent_id });
  await until(() => reports.length === 2);
  if (backgroundSource === 'snapshot') {
    runtime.fake.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [
      { task_id: 'background', run_id: 'run-1', task_type: 'local_agent', description: 'Background child' },
      { task_id: 'shell-job', run_id: 'run-1', task_type: 'local_bash', description: 'Background shell' },
    ] });
  } else {
    runtime.fake.emit({ type: 'system', subtype: 'task_started', task_id: 'background', run_id: 'run-1',
      task_type: 'local_agent', is_backgrounded: backgroundSource === 'start' });
    if (backgroundSource === 'transition') runtime.fake.emit({ type: 'system', subtype: 'task_updated', task_id: 'background', run_id: 'run-1', patch: { is_backgrounded: true } });
    runtime.fake.emit({ type: 'system', subtype: 'task_started', task_id: 'shell-job', run_id: 'run-1', task_type: 'local_bash', is_backgrounded: true });
  }
  await until(() => runtime.session.activity().count === 2);
  runtime.clock(3); await runtime.session.interrupt();
  await until(() => runtime.session.snapshot().state === 'idle');
  const stops = reports.filter(signal => signal.kind === 'stop');
  assert.deepEqual(stops.map(signal => signal.agentId), ['foreground']);
  assert.equal(stops[0].outcome, 'killed'); assert.equal(stops[0].at, at(3));
  const foreground = [...calls.calls.values()].find(call => call.agentId === 'foreground');
  const background = [...calls.calls.values()].find(call => call.agentId === 'background');
  assert.equal(foreground.done, true); assert.equal(foreground.outcome, 'killed');
  assert.equal(foreground.failure.reason, 'killed'); assert.equal(background.done, false);
  assert.equal(runtime.fake.interrupts.length, 1); assert.equal(runtime.fake.closes.length, 0);
  assert.equal(runtime.session.activity().count, 2, 'background tasks remain live');
  await runtime.session.send({ clientMessageId: 'after-interrupt', text: 'Continue the conversation' });
  await until(() => runtime.fake.inputs.length === 2);
  assert.equal(runtime.fake.calls.length, 1, 'the same CLI query accepts the next input');
  await runtime.hook('SubagentStop', { agent_id: 'background', agent_transcript_path: path.join(f.folder, 'agent-background.jsonl') });
  await until(() => reports.length === 4);
  assert.equal(reports[3].agentId, 'background'); assert.equal(reports[3].kind, 'stop');
  assert.equal(Object.hasOwn(reports[3], 'outcome'), false, 'the actual SDK stop is completed by default');
  assert.equal(background.done, true); assert.equal(background.outcome, 'completed');
  for (const task_id of ['background', 'shell-job']) runtime.fake.emit({ type: 'system', subtype: 'task_notification', task_id, run_id: 'run-1', status: 'completed' });
  runtime.fake.emit({ type: 'result', uuid: 'next-result', terminal_reason: 'completed', subtype: 'success', total_cost_usd: 0, modelUsage: {} });
  await until(() => runtime.session.activity().count === 0 && runtime.session.snapshot().state === 'idle');
  assert.equal(reports.length, 4); assert.equal(runtime.fake.closes.length, 0);
});

test('query retirement kills background children while real SDK SubagentStop stays plain', async t => {
  const f = workspace(t), reports = [];
  const runtime = await sessionFixture(t, f, signal => reports.push(signal));
  for (const agent_id of ['completed', 'background']) await runtime.hook('SubagentStart', { agent_id });
  await until(() => reports.length === 2);
  await runtime.hook('SubagentStop', { agent_id: 'completed' });
  await until(() => reports.length === 3);
  assert.equal(Object.hasOwn(reports[2], 'outcome'), false);
  runtime.fake.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'background', run_id: 'run-1', task_type: 'local_agent', description: 'Background child' },
  ] });
  await until(() => runtime.session.activity().count === 1);
  runtime.clock(4); runtime.fake.end();
  await until(() => runtime.fake.closes.length === 1);
  assert.equal(reports.length, 4);
  assert.equal(reports[3].kind, 'stop'); assert.equal(reports[3].agentId, 'background');
  assert.equal(reports[3].outcome, 'killed'); assert.equal(reports[3].at, at(4));
  assert.equal(reports.filter(signal => signal.kind === 'stop' && signal.agentId === 'completed').length, 1);
});

test('interrupt cleanup covers queued starts before the next turn without killing its children', async t => {
  const f = workspace(t), reports = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const runtime = await sessionFixture(t, f, signal => {
    reports.push(signal);
    if (signal.kind === 'start' && signal.agentId === 'blocking') return gate;
  });
  await runtime.hook('SubagentStart', { agent_id: 'blocking' });
  await until(() => reports.length === 1);
  for (const agent_id of ['queued-foreground', 'queued-background']) await runtime.hook('SubagentStart', { agent_id });
  await runtime.hook('SubagentStop', { agent_id: 'blocking' });
  runtime.fake.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'queued-background', run_id: 'run-1', task_type: 'local_agent', description: 'Background child' },
  ] });
  await until(() => runtime.session.activity().count === 1);
  runtime.clock(3); await runtime.session.interrupt();
  await until(() => runtime.session.snapshot().state === 'idle');
  runtime.clock(4); await runtime.session.send({ clientMessageId: 'next-turn', text: 'Next turn' });
  await runtime.hook('SubagentStart', { agent_id: 'next-turn' });
  release();
  await until(() => reports.filter(signal => signal.kind === 'start').length === 4);
  const stops = reports.filter(signal => signal.kind === 'stop');
  assert.deepEqual(stops.map(signal => signal.agentId).sort(), ['blocking', 'queued-foreground']);
  assert.equal(Object.hasOwn(stops.find(signal => signal.agentId === 'blocking'), 'outcome'), false, 'the queued SDK stop completes before synthetic cleanup');
  const killed = stops.find(signal => signal.agentId === 'queued-foreground');
  assert.equal(killed.outcome, 'killed'); assert.equal(killed.at, at(3), 'late cleanup keeps the interrupted turn timestamp');
  assert.equal(runtime.fake.calls.length, 1); assert.equal(runtime.fake.closes.length, 0);
});

test('invalid tool-use IDs keep native sub-agent signals by falling back to agent identity', async t => {
  const f = workspace(t), reports = [];
  const runtime = await sessionFixture(t, f, signal => reports.push(signal));
  const ids = [['x'.repeat(161), null], ['not/a/tool-id', null], ['toolu_valid-1', 'toolu_valid-1'], ['', null]];
  for (const [index, [id, expected]] of ids.entries()) {
    await runtime.hook('SubagentStart', { agent_id: `child-${index}` }, id);
    await until(() => reports.length === index + 1);
    assert.equal(reports[index].toolUseId, expected);
    assert.equal(reports[index].agentId, `child-${index}`);
  }
});

test('SDK sub-agent callbacks answer before transcript discovery settles', async t => {
  const f = workspace(t), abort = new AbortController();
  t.after(() => abort.abort());
  let release, answered = 0, discovered = false;
  const discovery = new Promise(resolve => { release = resolve; }).then(() => { discovered = true; });
  const options = queryOptions({ owner: 'gui', cwd: f.cwd, env: { PATH: '' } }, {
    abort, key: 'offline-only', executable: 'offline-only', policy: () => ({ behavior: 'defer' }), onSubagent: () => discovery,
  });
  const pending = ['SubagentStart', 'SubagentStop'].map(event => options.hooks[event][0].hooks[0]({}).then(answer => {
    assert.deepEqual(answer, {}); answered++;
  }));
  try {
    await tick();
    assert.equal(answered, 2, 'neither CLI hook waits for transcript discovery');
    assert.equal(discovered, false);
  } finally { release(); await Promise.all(pending); }
});

test('the host tracker keeps native rows through terminal folder aliases and drive-letter case changes', t => {
  const f = workspace(t), host = nativeHost(f, null), project = { kind: 'local', path: f.cwd };
  Object.assign(host.context, { fs, os, AgentCalls, sameDirectory, claudeConfigDir: () => f.home, send() {} });
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function callsOf('), source.indexOf('// An owner intervention')), host.context);
  host.s.nativeStructured = false;
  const calls = host.context.callsOf(host.s, project); t.after(() => calls.dispose());
  host.s.nativeStructured = true;
  assert.equal(host.context.callsOf(host.s, project), calls, 'a native host also adopts an existing terminal tracker');
  fs.mkdirSync(f.folder, { recursive: true }); calls.setFolder(f.folder);
  calls.apply({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [
    { type: 'tool_use', id: 'live-child', name: 'Agent', input: { subagent_type: 'Explore' } },
  ] } });
  const child = calls.calls.get('live-child'); assert.ok(child);
  const terminal = { terminalId: 'terminal', agent: 'claude', nativeStructured: false };
  host.sessions.set('terminal', terminal);
  assert.equal(host.context.callsOf(terminal, project), calls);
  const alias = path.join(f.home, 'project-alias');
  fs.symlinkSync(path.dirname(f.transcript), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const folders = [f.folder + path.sep, path.join(alias, f.parentId, 'subagents')];
  if (process.platform === 'win32') folders.push(f.folder.toUpperCase());
  for (const folder of folders) {
    terminal.calls.setFolder(folder);
    assert.equal(calls.calls.get('live-child'), child, 'equivalent folder spelling never resets the tracker');
    assert.equal(calls.folder, f.folder);
  }
  terminal.calls.setFolder(null);
  assert.equal(calls.folder, null); assert.equal(calls.calls.size, 0, 'a real unbind still clears native rows');
});

test('main binds the native rate folder before reporting a row and ignores stale runtimes', t => {
  const f = workspace(t), received = [], calls = {
    setFolder: folder => received.push(['folder', folder]),
    subagent: signal => { received.push(['signal', signal]); return true; },
  };
  const host = nativeHost(f, calls);
  assert.equal(typeof host.spec.onSubagent, 'function');
  const signal = { kind: 'start', terminalId: 'terminal', agentId: 'child', agentType: 'Explore', transcriptPath: null, toolUseId: null, at: at(0) };
  const binding = { runtimeSessionId: 'native-run', providerSessionId: f.parentId, folder: f.folder };
  host.spec.onSubagent(signal, binding);
  assert.deepEqual(received, [['folder', f.folder], ['signal', signal]]);
  assert.equal(host.scheduled(), 1);
  host.spec.onSubagent(signal, { ...binding, runtimeSessionId: 'old-run' });
  host.spec.onSubagent(signal, { ...binding, providerSessionId: 'old-session' });
  host.spec.onSubagent({ ...signal, terminalId: 'other-terminal' }, binding);
  host.s.codexActive = false; host.spec.onSubagent(signal, binding); host.s.codexActive = true;
  host.context.quitting = true; host.spec.onSubagent(signal, binding); host.context.quitting = false;
  host.nativeSpecs.set('terminal', { ...host.spec }); host.spec.onSubagent(signal, binding);
  assert.equal(received.length, 2); assert.equal(host.scheduled(), 1);
});

test('native retirement clears its child rows and keeps dispatched workers', t => {
  const f = workspace(t), calls = new AgentCalls({ terminalId: 'terminal', now: () => at(0) });
  t.after(() => calls.dispose());
  const host = nativeHost(f, calls); host.s.calls = calls; calls.setFolder(f.folder);
  calls.dispatch({ type: 'dispatch-declared', id: 'dispatched-worker', agent: 'codex', role: 'execution', title: 'Independent worker',
    cwd: f.cwd, at: at(0), requested: { model: 'gpt-6.1-sol', effort: 'high', fast: true } });
  calls.apply({ type: 'assistant', timestamp: new Date(at(0)).toISOString(), message: { content: [
    { type: 'tool_use', id: 'native-child', name: 'Agent', input: { subagent_type: 'Explore' } },
  ] } });
  assert.equal(calls.calls.size, 2);
  host.context.createNativeUsage = () => ({ apply() {} });
  host.context.store.setRestore = () => {};
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function structuredEvent('), source.indexOf('async function initializeNativeSessions(')), host.context);
  host.context.structuredEvent('terminal', { type: 'session.state', runtimeSessionId: 'native-run', providerSessionId: f.parentId, payload: { state: 'stopped' } });
  assert.deepEqual([...calls.calls.keys()], ['dispatched-worker']);
  assert.equal(calls.folder, null); assert.equal(host.s.codexActive, false);
});

test('native transcript folder discovery keeps SDK aliases before the parent file exists and rejects escapes', async t => {
  const { claudeSubagentFolder } = require('../electron/features/claude-sdk/transcript-folder.cjs');
  const f = workspace(t), spec = { cwd: f.cwd, env: { CLAUDE_CONFIG_DIR: f.home } };
  const alias = path.join(f.home, 'projects', 'alias-spelling'), parent = path.join(alias, `${f.parentId}.jsonl`);
  fs.mkdirSync(alias);
  assert.equal(await claudeSubagentFolder(spec, f.parentId, parent), path.join(alias, f.parentId, 'subagents'));
  const pending = path.join(f.home, 'projects', 'not-created-yet');
  assert.equal(await claudeSubagentFolder(spec, f.parentId, path.join(pending, `${f.parentId}.jsonl`)), path.join(pending, f.parentId, 'subagents'));
  assert.equal(await claudeSubagentFolder(spec, f.parentId), f.folder, 'without a hook path the shared verified session lookup supplies it');
  assert.equal(await claudeSubagentFolder(spec, '../escape', parent), null);
  assert.equal(await claudeSubagentFolder(spec, f.parentId, path.join(f.cwd, `${f.parentId}.jsonl`)), null);
  assert.equal(await claudeSubagentFolder(spec, f.parentId, path.join(alias, 'other-session.jsonl')), null);
  const link = path.join(f.home, 'projects', 'linked');
  fs.symlinkSync(f.cwd, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await claudeSubagentFolder(spec, f.parentId, path.join(link, `${f.parentId}.jsonl`)), null);
});
