require('./fixtures/team-isolation.cjs');
const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { argumentsOf, run } = require('../integration/dispatch.cjs');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { createDispatchIntake } = require('../electron/features/agents/dispatch-intake.cjs');
const { createDispatchControl } = require('../electron/features/agents/dispatch-control.cjs');
const { resolveRegistration } = require('../electron/features/agents/dispatch-registration.cjs');
const { locateTeam } = require('../electron/features/team/team-locate.cjs');
const { teamAt } = require('../electron/features/team/team.cjs');
const { RunInbox } = require('../electron/features/team/inbox.cjs');
const { DispatchOutbox } = require('../integration/dispatch-outbox.cjs');
const { dispatchDirectory } = require('../electron/features/agents/dispatch-events.cjs');
const { createEventServer } = require('../electron/events.cjs');

const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const ast = ts.createSourceFile('main.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = names => ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join('\n');

function mainFixture(t, { native = true, now = Date.now } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-dispatch-e2e-'));
  const project = { id: 'project', kind: 'local', path: root }, sessions = new Map(), nativeSpecs = new Map(), errors = [];
  let binds = 0;
  const context = vm.createContext({ path, fs, os, randomUUID, sessions, nativeSpecs, quitting: false, errors,
    Date: class extends Date { static now() { return now(); } },
    AgentCalls: class extends AgentCalls { constructor(options) { super({ ...options, now }); } },
    store: { projects: [project], findTerminal: () => ({ project, record: { restore: {} } }), setRestore() {} },
    findProject: () => project, runtimeDir: root, integrationDir: path.join(__dirname, '../integration'), eventServer: null, controlAddress: null,
    startupNote: () => '', READING_NOTE: '', handoffFile: () => '', nativeEnvironment: () => ({}),
    writeBootstrap: ({ file, ...value }) => fs.writeFileSync(file, JSON.stringify(value)),
    scheduleState() {}, broadcast() {}, send() {}, report: value => errors.push(String(value?.message || value)),
    dashboard: { run() {} }, createNativeUsage: () => ({ apply() {} }), nativeSessions: { forget: async () => {}, tokenRate: () => null },
    PromptQueue: class { reset() {} }, CompletionWork: class { reset() {} }, ActionLog: class {}, ConversationLog: class {},
    readingHistory: { close() {} }, syncDashboardLive() {}, endSkillSession() {}, skills: { endSession() {}, delivery: () => null }, stopUsageAccount() {},
    clearTimeout, startupErrors: new Map(), reportHookChannel() {}, acceptShellEvent: () => false,
    claudeConfigDir: () => path.join(root, 'claude'), rememberClaudeSource() {}, require: name => {
      if (name === './features/team/team-locate.cjs') return { locateTeam };
      throw new Error(`Unexpected main dependency: ${name}`);
    } });
  vm.runInContext(functions(['callsOf', 'nativeSpec', 'structuredEvent', 'onEvent', 'disposeTerminal', 'cleanupTerminalFiles', 'dispatchedOnly']), context);
  Object.assign(context, createDispatchIntake(context));
  const bind = context.bindDispatchInbox;
  context.bindDispatchInbox = (...args) => { binds++; return bind(...args); };
  const host = ast.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(value => value.name.getText(ast) === 'host'));
  const initializer = host.declarationList.declarations.find(value => value.name.getText(ast) === 'host').initializer;
  const reporting = initializer.properties.find(value => value.name?.getText(ast) === 'dispatchRefused');
  if (reporting?.initializer) context.dispatchRefused = vm.runInContext(`(${reporting.initializer.getText(ast)})`, context);
  function start(key = 'synthetic-old-key', runtimeSessionId = randomUUID()) {
    const spec = context.nativeSpec('terminal', 'claude', false);
    Object.assign(spec, { sessionKey: key, controlCapability: 'synthetic-capability' });
    context.structuredEvent('terminal', { type: 'session.state', runtimeSessionId, transport: 'claude-sdk', payload: { state: 'starting' } });
    const session = sessions.get('terminal'); session.nativeStructured = native;
    return session;
  }
  const session = start();
  t.after(async () => { context.disposeDispatchInbox(); await session.calls?.dispatchReplay?.(); for (const value of sessions.values()) value.calls?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, project, context, session, sessions, start, errors, binds: () => binds };
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
  f.context.disposeTerminal('terminal', { preserveNative: true, preserveCalls: true });
  const restarted = f.start('synthetic-new-key');
  assert.equal(restarted.bootstrapFile, f.session.bootstrapFile, 'the outbox directory follows the terminal across hosts');
  assert.equal(restarted.calls, calls, 'a terminal restart retains its live worker rows');
  assert.equal(f.context.bindDispatchInbox(restarted, f.project), inbox); await inbox.work;
  const frame = outbox.append({ type: 'dispatch-start', id, agent: 'claude', role: '审查', title: 'Synthetic dispatch', cwd: f.root,
    brief: '/brief', out: '/out', model: 'synthetic-model', effort: 'high', fast: false, sessionId: 'synthetic-child', startedAt: 1001 });
  f.context.onEvent({ ...frame, sessionKey: 'synthetic-old-key' }); await inbox.work;
  assert.equal(calls.snapshot()[0].items[0].state, 'running');
  f.context.onEvent({ ...frame, seq: 3, mac: '0'.repeat(64), sessionKey: 'synthetic-old-key' }); await inbox.work;
  assert.deepEqual(f.errors, ['dispatch.invalid_event']);
  f.context.disposeTerminal('terminal', { preserveNative: true, preserveCalls: true });
  // Removal must also release a tracker when a replacement host has not been created.
  f.context.disposeTerminal('terminal', { preserveNative: true });
  assert.equal(inbox.disposed, true);
  assert.equal(AgentCalls.forTerminal(f.sessions, 'terminal'), null);
  assert.equal(calls.calls.size, 0);
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
  await team.admit({ agent: 'claude', role: '审查', title: 'Synthetic refusal', model: 'synthetic-model', cwd: f.root, allow: [] }, id);
  const inbox = new RunInbox(team, id); await inbox.open();
  const deps = { sessions: f.sessions, store: f.context.store,
    locateTeam: async (_cwd, options) => options?.details ? { status: 'found', common: f.root, team } : team };
  const result = await registrationOnBoard(deps, { runId: id, projectId: 'terminal', sessionKey: f.session.sessionKey,
    capability: f.session.controlCapability, cwd: f.root, agent: 'claude', allow: [], readOnly: true, roundtable: false }, true);
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
      DISPATCH_FIXTURE: fixture, DISPATCH_CAPTURE: path.join(f.root, 'capture.json') },
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
