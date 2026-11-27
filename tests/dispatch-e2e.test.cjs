const { createNativeHost } = require('../electron/features/native-session/host.cjs');
const { createShellEvents } = require('../electron/features/terminal-events/shell-events.cjs');
const { createTerminalLifecycle } = require('../electron/app/terminal-lifecycle.cjs');
require('./fixtures/team-isolation.cjs');
const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn, execFileSync } = require('node:child_process');
const { argumentsOf, run, runDetached, startDetached } = require('../integration/dispatch.cjs');
const { createRoleTools } = require('../integration/role-tools.cjs');
const { intercept } = require('../integration/shims/intercept.cjs');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { createDispatchIntake, reportDispatchRefusal } = require('../electron/features/agents/dispatch-intake.cjs');
const { createHostInputs } = require('../electron/features/native-session/host-inputs.cjs');
const { createDispatchControl } = require('../electron/features/agents/dispatch-control.cjs');
const { resolveRegistration } = require('../electron/features/agents/dispatch-registration.cjs');
const { locateTeam } = require('../electron/features/team/team-locate.cjs');
const { sameDirectory } = require('../electron/session-files.cjs');
const { teamAt } = require('../electron/features/team/team.cjs');
const { RunInbox } = require('../electron/features/team/inbox.cjs');
const { DetachedRuns, DispatchOutbox } = require('../integration/dispatch-outbox.cjs');
const { writeBootstrap } = require('../electron/features/terminal-events/bootstrap-file.cjs');
const { terminalHooks } = require('../electron/features/terminal-events/hook-channel.cjs');
const { DashboardRecords } = require('../electron/features/dashboard/records.cjs');
const { dispatchDirectory } = require('../electron/features/agents/dispatch-events.cjs');
const { createEventServer } = require('../electron/events.cjs');
const { registerTerminalIpc } = require('../electron/features/terminal/ipc.cjs');
const { WorkspaceStore } = require('../electron/state.cjs');

test('the first confirmed role notice survives restart until its conversation acknowledges it', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-role-notice-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'workspace.json');
  let store = new WorkspaceStore(file);
  const first = store.add(fs.mkdtempSync(path.join(folder, 'first-'))).project;
  const second = store.add(fs.mkdtempSync(path.join(folder, 'second-'))).project;
  const intake = () => createDispatchIntake({ store, broadcast() {}, rememberClaudeSource() {},
    callsOf: () => ({ dispatch: () => true }) });
  const start = (host, project, terminalId = project.id, extra = {}) => {
    const session = { terminalId, sessionKey: 'fixture-key' };
    return host.acceptDispatchEvent(session, project, { type: 'dispatch-start', id: randomUUID(), projectId: terminalId,
      sessionKey: session.sessionKey, agent: 'codex', role: '执行', title: 'Check', cwd: folder, brief: 'brief.md',
      out: 'answer.md', model: 'gpt-6.2-sol', effort: 'low', fast: false, sessionId: 'role-session', startedAt: 1, ...extra });
  };
  const host = intake(), terminalId = store.addTerminal(first.id);
  start(host, first, terminalId, { sessionKey: 'wrong-key' });
  start(host, first, terminalId, { unconfirmed: true });
  assert.equal(store.pendingRolePermissionsNotice, null);
  start(host, first, terminalId);
  start(host, second);
  const target = { projectId: first.id, terminalId };
  assert.deepEqual(store.pendingRolePermissionsNotice, target);
  assert.equal(store.settings.rolePermissionsNoticeSeen, false);
  store = new WorkspaceStore(file);
  assert.deepEqual(store.pendingRolePermissionsNotice, target, 'refresh or restart still has the original conversation target');
  store.acknowledgeRolePermissionsNotice(second.id);
  store.updateSettings({ rolePermissionsNoticeSeen: true });
  assert.equal(store.settings.rolePermissionsNoticeSeen, false);
  store.acknowledgeRolePermissionsNotice(terminalId);
  store.acknowledgeRolePermissionsNotice(terminalId);
  store = new WorkspaceStore(file);
  assert.equal(store.settings.rolePermissionsNoticeSeen, true);
  start(intake(), second);
  assert.equal(store.pendingRolePermissionsNotice, null);
});

function fakeClaudeWorker(records, finished) {
  const child = Object.assign(new EventEmitter(), { pid: 2147483647, exitCode: null, remote: true,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.stdin.once('finish', () => child.stdout.write(records[0] + '\n'));
  void finished.then(() => {
    child.exitCode = 0;
    child.stdout.end(records.slice(1).join('\n') + '\n');
    child.stderr.end();
    child.emit('exit', 0);
    child.emit('close', 0);
  });
  return child;
}

async function terminalRoleEnvironment(bootstrapFile) {
  let mcpEnv;
  await intercept(['claude'], { env: { AGENTRIX_BOOTSTRAP: bootstrapFile, AGENTRIX_DISPATCH_DEPTH: '0' },
    locate: () => 'fake-claude', launch: (_file, [config]) => {
      mcpEnv = JSON.parse(config.slice('--mcp-config='.length)).mcpServers.agentrix.env;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    } });
  return mcpEnv;
}

test('roles from a Windows terminal bootstrap appear under the lead project and reach the run history', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-terminal-roles-'));
  const project = { id: randomUUID(), path: path.join(root, 'project'), kind: 'local' };
  const outside = path.join(root, 'outside-worktree');
  for (const folder of [project.path, outside]) fs.mkdirSync(folder);
  const session = { terminalId: randomUUID(), sessionKey: randomUUID(), bootstrapFile: path.join(root, 'terminal.json'), agent: 'claude' };
  const dashboard = new DashboardRecords(root);
  const calls = new AgentCalls({ terminalId: session.terminalId, finished: (call, event) => dashboard.run(project, call, event), dispatchAlive: () => true });
  const intake = createDispatchIntake({ callsOf: () => calls, broadcast() {}, rememberClaudeSource() {} });
  const server = await createEventServer(event => {
    if (event.projectId === session.terminalId) intake.acceptDispatchEvent(session, project, event);
  });
  const inbox = intake.bindDispatchInbox(session, project);
  t.after(async () => {
    await server.close();
    await inbox.work;
    intake.disposeDispatchInbox(session.terminalId);
    calls.dispose();
    await dashboard.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const script = path.resolve(__dirname, '../integration/claude-hook.ps1');
  const hooks = terminalHooks({ platform: 'win32', port: 12345, terminalId: session.terminalId, sessionKey: session.sessionKey,
    eventServer: server, env: {}, cwd: project.path, seatRouting: true, read: () => '{}',
    shell: { powershellPath: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', script,
      node: process.execPath } });
  hooks.fastSettings = Object.fromEntries(Object.entries(hooks.settings).map(([channel, settings]) =>
    [channel, JSON.stringify({ ...JSON.parse(settings), fastMode: true })]));
  writeBootstrap({ file: session.bootstrapFile, eventServer: server, projectId: session.terminalId, projectPath: project.path,
    sessionKey: session.sessionKey, claudeHookPath: script, hooks, conductor: true,
    dispatchSeats: { reviewer: { model: 'sonnet', effort: 'high', fast: false } } });
  assert.ok(fs.statSync(session.bootstrapFile).size > 16 * 1024);

  const mcpEnv = await terminalRoleEnvironment(session.bootstrapFile);
  assert.equal(mcpEnv.AGENTRIX_BOOTSTRAP, session.bootstrapFile);

  const records = fs.readFileSync(path.join(__dirname, 'fixtures/claude-dispatch-stream.jsonl'), 'utf8').trimEnd().split('\n');
  for (const cwd of [project.path, outside]) {
    const store = new DetachedRuns(path.join(cwd, 'receipts'));
    const finish = Promise.withResolvers();
    let settled;
    const roles = createRoleTools({ env: mcpEnv, cwd: project.path, engine: (argv, options) => startDetached(argv, {
      ...options, store, timeout: 5000, launch: (_file, args, { env }) => {
        const { argv: saved } = store.read(path.basename(args.at(-1), '.json'));
        const artifacts = path.dirname(saved[saved.indexOf('--out') + 1]);
        t.after(() => fs.rmSync(artifacts, { recursive: true, force: true }));
        const helper = Object.assign(new EventEmitter(), { unref() {} });
        queueMicrotask(() => helper.emit('spawn'));
        settled = runDetached(args.at(-1), { env, pinnedSeats: true,
          resolveExecutable: () => ({ file: 'fake-worker', args: [] }),
          launch: () => fakeClaudeWorker(records, finish.promise) });
        settled.then(code => helper.emit('exit', code), () => helper.emit('exit', 1));
        return helper;
      } }) });
    let id;
    try {
      const started = await roles.tools.start_role({ cwd, seat: 'reviewer', title: 'Terminal review', brief: 'Review the fixture.', readOnly: true });
      id = started.id;
      assert.match(started.started, /routing ok/);
      await inbox.sweep();
      const group = calls.snapshot().find(value => value.items.some(item => item.id === `dispatch:${id}`));
      const item = group?.items.find(value => value.id === `dispatch:${id}`);
      assert.ok(item, 'the confirmed role must reach the lead terminal inbox');
      assert.equal(item.seat, 'reviewer');
      assert.equal(group.model, 'claude-sonnet-5-5');
      assert.notEqual(item.state, 'done');
      assert.equal(item.controlFailure, 'bootstrap/missing_address');
      assert.equal(calls.byId(`dispatch:${id}`).cwd, cwd);
    } finally {
      finish.resolve();
      await settled;
    }
    await inbox.sweep();
    const item = calls.snapshot().flatMap(group => group.items).find(value => value.id === `dispatch:${id}`);
    assert.deepEqual([item?.state, item?.seat], ['done', 'reviewer']);
    await dashboard.flush();
    const logged = fs.readFileSync(dashboard.file('runs'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.id === id);
    assert.deepEqual(logged.map(row => [row.projectId, row.agent, row.verdict]), [[project.id, 'claude', 'ok']]);
  }
});

function mainFixture(t, { native = true, now = Date.now } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-dispatch-e2e-'));
  const project = { id: 'project', kind: 'local', path: root }, sessions = new Map(), nativeSpecs = new Map(), errors = [], warnings = [];
  let binds = 0;
  const context = vm.createContext({ path, fs, os, process, randomUUID, sameDirectory, sessions, nativeSpecs, quitting: false, errors,
    adapterOf: require('../electron/features/cli-adapters/registry.cjs').adapterOf,
    now, Date: class extends Date { static now() { return now(); } },
    AgentCalls: class extends AgentCalls { constructor(options) { super({ ...options, now }); } },
    store: { projects: [project], findTerminal: () => ({ project, record: { restore: {} } }), setRestore() {} },
    findProject: () => project, runtimeDir: root, integrationDir: path.join(__dirname, '../integration'), eventServer: null, controlAddress: null,
    startupNote: () => '', READING_NOTE: '', handoffFile: () => '', nativeEnvironment: () => ({}),
    writeBootstrap: ({ file, ...value }) => fs.writeFileSync(file, JSON.stringify(value)),
    removeBootstrap: require('../electron/features/terminal-events/bootstrap-file.cjs').removeBootstrap,
    scheduleState() {}, broadcast() {}, send() {}, report: value => errors.push(String(value?.message || value)),
    dispatchRefused: value => reportDispatchRefusal(value, { warn: (_message, code, id) => warnings.push({ code, id }) }),
    dashboard: { run() {} }, createNativeUsage: () => ({ apply() {} }), nativeSessions: { forget: async () => {}, tokenRate: () => null },
    PromptQueue: class { reset() {} }, CompletionWork: class { reset() {} }, ActionLog: class {}, ConversationLog: class {},
    readingHistory: { close() {} }, endSkillSession() {}, routing: { endSession() {}, launch: () => null }, stopUsageAccount() {},
    clearTimeout, startupErrors: new Map(), reportHookChannel() {}, acceptShellEvent: () => false,
    claudeConfigDir: () => path.join(root, 'claude'), rememberClaudeSource() {}, require: name => {
      if (name === './features/team/team-locate.cjs') return { locateTeam };
      throw new Error(`Unexpected main dependency: ${name}`);
    } });
  Object.assign(context, createTerminalLifecycle(context), createShellEvents(context), createDispatchIntake(context), { nativeSpec: createHostInputs(context).nativeSpec });
  const bind = context.bindDispatchInbox;
  context.bindDispatchInbox = (...args) => { binds++; return bind(...args); };
  function start(key = 'synthetic-old-key', runtimeSessionId = randomUUID()) {
    const spec = context.nativeSpec('terminal', 'claude', false);
    Object.assign(spec, { sessionKey: key, controlCapability: 'synthetic-capability' });
    context.structuredEvent('terminal', { type: 'session.state', runtimeSessionId, transport: 'claude-sdk', payload: { state: 'starting' } });
    const session = sessions.get('terminal'); session.nativeStructured = native;
    return session;
  }
  const session = start();
  const handlers = new Map();
  registerTerminalIpc({ handle: (name, fn) => handlers.set(name, fn), listen() {}, confirmTerminalClose: async () => true,
    forgetRestorePlan() {}, disposeTerminal: context.disposeTerminal, startTerminal: () => start('synthetic-new-key') });
  t.after(async () => { context.disposeDispatchInbox(); await session.calls?.dispatchReplay?.(); for (const value of sessions.values()) value.calls?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, project, context, session, sessions, start, errors, warnings, binds: () => binds,
    restart: () => handlers.get('terminal:restart')('terminal') };
}
const declaration = (id, cwd) => ({ type: 'dispatch-declared', id, helperPid: process.pid, agent: 'claude', role: '审查', title: 'Synthetic dispatch',
  cwd, worktree: cwd, requested: { model: 'synthetic-model', effort: 'high', fast: false }, source: 'dispatch', resumed: true, at: 1000 });

test('unsafe allow globs fail at argument parsing before admission or launch', () => {
  const base = ['claude', '--role', 'review', '--title', 'Synthetic scope', '--model', 'synthetic-model', '--effort', 'high', '--permission', 'plan',
    '--cwd', os.tmpdir(), '--brief', 'brief.md', '--out', 'out.md'];
  for (const glob of ['../escape/**', 'src/../outside', '..', '/absolute/**', 'C:/absolute/**', 'C:relative/**', './C:/absolute/**', '.\\.\\C:\\absolute\\**', '\\\\host\\share\\**', '~/**']) {
    assert.throws(() => argumentsOf([...base, '--allow', glob]), /--allow.*relative.*\.\./, glob);
  }
  assert.deepEqual(argumentsOf([...base, '--allow', './src/**/*.cjs']).allow, ['src/**/*.cjs']);
});

test('main binds delivery before launch and publishes the fifteen-second starting notice without a worker start', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = mainFixture(t, { now: () => 1000 });
  assert.equal(f.binds(), 1, 'starting the host must bind its inbox before a helper can launch');
  f.session.calls.local = false;
  const inbox = f.context.bindDispatchInbox(f.session, f.project), id = randomUUID();
  const outbox = new DispatchOutbox({ directory: dispatchDirectory(f.session.bootstrapFile), id, projectId: 'terminal', sessionKey: f.session.sessionKey });
  const frame = outbox.append(declaration(id, f.root)); f.context.onEvent({ ...frame, sessionKey: f.session.sessionKey });
  await inbox.work;
  t.mock.timers.tick(14999); assert.equal(f.session.calls.snapshot()[0].items[0].notice, undefined);
  t.mock.timers.tick(1);
  const item = f.session.calls.snapshot()[0].items[0];
  assert.equal(item.state, 'starting'); assert.equal(item.notice, 'unconfirmed'); assert.equal(item.resumed, true);
});

test('main preserves the admitted row and inbox across host restart and reports a forged late event by code', async t => {
  const f = mainFixture(t, { now: () => 1000 }), calls = f.context.callsOf(f.session, f.project);
  calls.local = false;
  const inbox = f.context.bindDispatchInbox(f.session, f.project), id = randomUUID();
  const outbox = new DispatchOutbox({ directory: dispatchDirectory(f.session.bootstrapFile), id, projectId: 'terminal', sessionKey: f.session.sessionKey });
  f.context.onEvent({ ...outbox.append(declaration(id, f.root)), sessionKey: f.session.sessionKey }); await inbox.work;
  assert.equal(await f.restart(), true);
  const restarted = f.sessions.get('terminal');
  assert.equal(restarted.bootstrapFile, f.session.bootstrapFile, 'the outbox directory follows the terminal across hosts');
  assert.equal(restarted.calls, calls, 'a terminal restart retains its live worker rows');
  assert.equal(f.context.bindDispatchInbox(restarted, f.project), inbox); await inbox.work;
  const frame = outbox.append({ type: 'dispatch-start', id, agent: 'claude', role: '审查', title: 'Synthetic dispatch', cwd: f.root,
    brief: '/brief', out: '/out', model: 'synthetic-model', effort: 'high', fast: false, sessionId: 'synthetic-child', startedAt: 1001 });
  f.context.onEvent({ ...frame, sessionKey: 'synthetic-old-key' }); await inbox.work;
  assert.equal(calls.snapshot()[0].items[0].state, 'running');
  f.context.onEvent({ ...frame, seq: 3, mac: '0'.repeat(64), sessionKey: 'synthetic-old-key' }); await inbox.work;
  f.context.onEvent({ ...frame, seq: 3, mac: '0'.repeat(64), sessionKey: 'synthetic-old-key' }); await inbox.work;
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.warnings, [{ code: 'dispatch.invalid_event', id }]);
  f.context.disposeTerminal('terminal', { preserveNative: true, preserveCalls: true });
  // Removal must also release a tracker when a replacement host has not been created.
  f.context.disposeTerminal('terminal', { preserveNative: true });
  assert.equal(inbox.disposed, true);
  assert.equal(AgentCalls.forTerminal(f.sessions, 'terminal'), null);
  assert.equal(calls.calls.size, 0);
});

async function endedSession(t, ending) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = mainFixture(t, { now: () => 1000 }), calls = f.session.calls, polled = [];
  calls.readModels = async folder => { polled.push(folder); };
  calls.setFolder(path.join(f.root, 'old-subagents'));
  calls.apply({ type: 'assistant', timestamp: new Date(1000).toISOString(), message: { content: [
    { type: 'tool_use', id: 'old-child', name: 'Agent', input: { prompt: 'Synthetic child', subagent_type: 'Explore' } },
  ] } });
  calls.backgroundRecord({ type: 'assistant', timestamp: new Date(1000).toISOString(), message: { content: [
    { type: 'tool_use', id: 'old-shell', name: 'Bash', input: { command: 'synthetic command', run_in_background: true } },
  ] } });
  const id = randomUUID(); calls.dispatch(declaration(id, f.root));
  assert.equal(calls.calls.size, 2); assert.equal(calls.usage(null).background.length, 1);
  Object.assign(f.context, { id: 'terminal', s: f.session, project: f.project, sessionId: f.session.sessionId,
    terminal: f.session.terminal, bootstrapFile: f.session.bootstrapFile, skillNoteFile: null, flush() {}, restorePlans: new Map(), acceptShellEvent: () => true });
  if (ending === 'handoff') f.context.disposeTerminal('terminal', { preserveCalls: true });
  else if (ending === 'cli') {
    f.session.nativeStructured = false;
    f.context.onEvent({ type: 'agent-exited', agent: 'claude', projectId: 'terminal', sessionKey: f.session.sessionKey, exitCode: 0 });
  } else {
    let onExit;
    f.session.terminal = { onData() {}, onExit: callback => { onExit = callback; } };
    Object.assign(f.context, { captureBranch() {}, restorePlans: new Map() });
    f.context.bindTerminalEvents(f.session, f.project, {});
    onExit({ exitCode: 0 });
  }
  assert.deepEqual([...calls.calls.keys()], [id]);
  assert.deepEqual(calls.usage(null)?.background || [], []);
  assert.equal(calls.folder, null);
  t.mock.timers.tick(1000); await calls.work;
  assert.ok(polled.every(folder => folder === null), 'no old subagents folder is polled after exit');
}

test('PTY exit clears background tasks and sub-agents while retaining only dispatch rows', t => endedSession(t, 'pty'));
test('CLI exit clears background tasks and sub-agents while retaining only dispatch rows', t => endedSession(t, 'cli'));
test('a preserved-call handoff clears background tasks and sub-agents while retaining only dispatch rows', t => endedSession(t, 'handoff'));

test('the native-to-terminal fallback preserves the admitted worker and its inbox', async t => {
  const f = mainFixture(t, { now: () => 1000 }), calls = f.session.calls;
  const inbox = f.context.bindDispatchInbox(f.session, f.project), id = randomUUID();
  calls.local = false; calls.dispatch(declaration(id, f.root));
  Object.assign(f.context, { launchPlans: new Map(), launchCommand: () => '', startTerminal: () => f.start('fallback-key') });
  const { terminal } = createNativeHost(f.context).nativeRouterOptions();
  await terminal(f.session.nativeSpec, 'synthetic fallback');
  const next = f.sessions.get('terminal');
  assert.equal(next.calls, calls);
  assert.equal(next.calls.byId(`dispatch:${id}`).done, false);
  assert.equal(f.context.bindDispatchInbox(next, f.project), inbox);
  assert.deepEqual(f.errors, []);
});

async function registrationOnBoard(deps, registration, refused) {
  if (!refused) return resolveRegistration(deps, registration);
  const team = await deps.locateTeam(registration.cwd), file = path.join(team.board, `${registration.runId}.json`);
  const entry = fs.readFileSync(file);
  fs.rmSync(file);
  // Only registration sees the missing board entry; the helper still owns its final inbox check.
  try { return await resolveRegistration(deps, registration); }
  finally { fs.writeFileSync(file, entry, { flag: 'wx' }); }
}

test('a transient registration refusal preserves the admitted helper\'s final control-inbox check', async t => {
  const f = mainFixture(t, { native: false }), team = teamAt(f.root, f.root, true), id = randomUUID();
  team.register({ agent: 'claude', role: '审查', title: 'Synthetic refusal', model: 'synthetic-model', cwd: f.root, allow: [] }, id);
  const inbox = new RunInbox(team, id); await inbox.open();
  const deps = { sessions: f.sessions, store: f.context.store,
    locateTeam: async (_cwd, options) => options?.details ? { status: 'found', common: f.root, team } : team };
  const result = await registrationOnBoard(deps, { runId: id, projectId: 'terminal', sessionKey: f.session.sessionKey,
    capability: f.session.controlCapability, cwd: f.root, agent: 'claude', allow: [], readOnly: true }, true);
  assert.deepEqual(result, { refused: 'dispatch.unknown_run', leadMode: 'terminal' });
  assert.deepEqual(await inbox.take(true), []);
  await inbox.close();
  assert.equal(team.live().find(run => run.id === id).closing, true);
});

async function boardRun(t, { refused = false, native = false } = {}) {
  const lifetime = resources(t), f = mainFixture(t, { native });
  assert.equal(f.binds(), 1, 'main must bind the real helper delivery before registration');
  execFileSync('git', ['init', '-q'], { cwd: f.root, windowsHide: true });
  const events = [], server = await createEventServer(event => { events.push(event); f.context.onEvent(event); });
  lifetime.defer('close event server', () => server.close());
  const control = createDispatchControl({ resolveRun: registration => registrationOnBoard(
    { sessions: f.sessions, store: f.context.store, locateTeam }, registration, refused) });
  const { address } = await control.listen(); lifetime.defer('close control', () => control.close());
  control.onRequest('claude-sdk.run', async (_run, _payload, stream) => {
    stream.emit({ type: 'path.changed', payload: { selected: 'terminal', reason: 'terminal lead (subscription)' } });
  });
  const brief = path.join(f.root, 'brief.md'), out = path.join(f.root, 'out.md'), fixture = path.join(f.root, 'fixture.json');
  fs.writeFileSync(brief, 'Synthetic real-board task');
  fs.writeFileSync(f.session.bootstrapFile, JSON.stringify({ pipeName: server.address, projectId: 'terminal', sessionKey: f.session.sessionKey,
    controlAddress: address, controlCapability: f.session.controlCapability }));
  fs.writeFileSync(fixture, JSON.stringify({ lines: [
    { record: { type: 'system', subtype: 'init', session_id: 'synthetic-child', model: 'synthetic-model' } },
    { delay: 25 }, { record: { type: 'result', result: 'Synthetic result', usage: { output_tokens: 1 }, duration_api_ms: 1 } },
  ] }));
  let stdout = '', launches = 0;
  const code = await run(['claude', '--role', 'review', '--title', 'Synthetic real-board task', '--model', 'synthetic-model', '--effort', 'high',
    '--permission', 'plan', '--cwd', f.root, '--brief', brief, '--out', out], {
    env: { PATH: '', HOME: f.root, USERPROFILE: f.root, CODEX_HOME: path.join(f.root, 'codex'), AGENTRIX_BOOTSTRAP: f.session.bootstrapFile,
      DISPATCH_FIXTURE: fixture, DISPATCH_CAPTURE: path.join(f.root, '.git', 'capture.json') },
    stdout: { write: value => { stdout += value; } },
    resolveExecutable: (_agent, args) => ({ file: process.execPath, args: [path.join(__dirname, 'fixtures/dispatch-worker.cjs'), ...args] }),
    launch: (file, args, options) => { launches++; return lifetime.child(spawn(file, args, options)); },
  });
  for (let n = 0; !events.some(event => event.type === 'dispatch-end') && n < 200; n++) await new Promise(resolve => setTimeout(resolve, 5));
  await f.context.bindDispatchInbox(f.session, f.project).work;
  return { ...f, code, stdout, launches, events };
}

test('the real helper registers against main on its admitted Git board and delivers one completed row', async t => {
  const f = await boardRun(t);
  assert.equal(f.code, 0, f.stdout); assert.equal(f.launches, 1);
  assert.match(f.stdout, /claude-cli: terminal lead \(subscription\)/);
  assert.equal(f.session.calls.snapshot()[0].items.length, 1);
  assert.equal(f.session.calls.snapshot()[0].items[0].state, 'done');
});

test('the real helper reports a coded board refusal while retaining its authenticated visibility row', async t => {
  const f = await boardRun(t, { refused: true });
  assert.equal(f.code, 0, f.stdout); assert.equal(f.launches, 1);
  assert.match(f.stdout, /control_register\/dispatch\.unknown_run/);
  assert.equal(f.session.calls.snapshot()[0].items.length, 1);
  assert.match(f.session.calls.snapshot()[0].items[0].controlFailure, /dispatch\.unknown_run/);
});

test('the real helper fails an authenticated native-lead refusal without launching a subscription CLI', async t => {
  const f = await boardRun(t, { refused: true, native: true });
  assert.equal(f.code, 1); assert.equal(f.launches, 0);
  assert.match(f.stdout, /failed to start .*control_register\/dispatch\.unknown_run/);
  assert.doesNotMatch(f.stdout, /claude-cli:/);
  assert.equal(f.session.calls.snapshot()[0].items[0].failure.reason, 'unconfirmed');
});
