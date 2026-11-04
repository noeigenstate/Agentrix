const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const { createEventStream } = require('../electron/features/native-session/events.cjs');
const { InputGate, SubmissionTracker, isTerminalResponse } = require('../electron/terminal-input.cjs');
const { PromptQueue } = require('../electron/prompt-queue.cjs');
const { CompletionWork } = require('../electron/completion-work.cjs');
const { ActionLog } = require('../electron/agent-actions.cjs');
const { ConversationLog } = require('../electron/conversation.cjs');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const ts = require('typescript');
const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const draft = { version: 1, text: '', images: [], undelivered: [] };
async function fixture(t, { native = false, ssh = false, apiOnly = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-switch-review-'));
  const project = { id: 'p', path: directory, kind: ssh ? 'ssh' : 'local' }, events = [], created = [];
  let saved = true, facade;
  t.after(async () => { await facade?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const host = { terminalId: 't', projectId: 'p', agent: 'claude', codexActive: true, sessionId: 'pty', status: 'codex',
    nativeRuntimeSessionId: 'r', nativeStructured: native, nativeSpec: {}, cliState: { sessionId: 'pty', state: 'idle' },
    submissions: new SubmissionTracker(), promptQueue: new PromptQueue(), completionWork: new CompletionWork(), approval: { invalidate() {} } };
  const context = { createNativeUsage: require('../electron/features/native-session/agent-usage.cjs').createNativeUsage, sessions: new Map([['t', host]]), store: { findTerminal: () => ({ project, record: { restore: {} } }) },
    nativeSpecs: new Map(), randomUUID: require('node:crypto').randomUUID, wholeThread: value => !!value, launchPlans: new Map(), quitting: false,
    fs, process, clearTimeout, readingHistory: { close() {} }, stopUsageAccount() {}, endSkillSession() {}, skills: { endSession() {} }, syncDashboardLive() {}, report(error) { throw error; },
    InputGate, isTerminalResponse, nativeSessions: null, scheduleState() {}, broadcast() {}, setTimeout, applyActivity() {}, findProject: () => project,
    PromptQueue, CompletionWork, ActionLog, ConversationLog, dashboard: { run() {} }, t: value => value };
  context.store.setRestore = () => {};
  vm.createContext(context);
  vm.runInContext(main.slice(main.indexOf('function localSwitchSessions('), main.indexOf('async function initializeNativeSessions(')), context);
  const gateStart = main.indexOf('  s.gate = new InputGate('), gateEnd = main.indexOf('  const refreshCompletion', gateStart);
  context.s = host; context.id = 't'; context.terminal = { write() {} };
  vm.runInContext(main.slice(gateStart, gateEnd), context);
  vm.runInContext(main.slice(main.indexOf('function disposeTerminal('), main.indexOf('function registerUnavailableNative(')), context);
  vm.runInContext(main.slice(main.indexOf('function structuredEvent('), main.indexOf('async function readNativeConnections(')), context);
  const tree = ts.createSourceFile('main.cjs', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let activate;
  const visit = node => { if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'activateNative') activate = node.initializer.getText(tree); ts.forEachChild(node, visit); };
  visit(tree); assert.ok(activate);
  const activateNative = vm.runInContext(`(${activate})`, context);
  const provider = { resetAvailability() {}, credentials: { status: () => ({ saved }), clear() { saved = false; return { saved }; }, save() { saved = true; return { saved }; } },
    usage: { summary: () => ({}) }, apiState: () => ({ status: saved ? 'ready' : 'no_key' }), create(spec, emit) {
      const stream = createEventStream(spec, emit); let state = 'idle';
      const runtime = { closed: false, sent: 0, background: { known: true, count: 2 },
        start() { stream.publish('session.state', { state: 'starting' }); stream.publish('session.state', { state }); }, resume() { return this.start(); }, prepareResume() {},
        snapshot: () => ({ ...stream.snapshot(), state }), activity: () => runtime.background,
        send() { runtime.sent++; return { status: 'queued' }; }, close() { runtime.closed = true; state = 'stopped'; stream.publish('session.state', { state }); },
        state(value) { state = value; stream.publish('session.state', { state }); } };
      created.push(runtime); return runtime;
    } };
  const validation = /validateProject: projectId => \{([^\n]*?)\},\r?\n/.exec(main);
  assert.ok(validation, 'use the actual main project validation');
  context.store.projects = [project];
  const validateProject = vm.runInContext(`projectId => {${validation[1]}\n}`, context);
  facade = createNativeSessions({ directory, claude: provider, resolveSpec: id => ({ owner: 'gui', projectId: 'p', terminalId: id, agent: 'claude', cwd: directory }),
    terminalSessions: context.localSwitchSessions, observeTerminal: context.observeSwitchTerminal, validateProject,
    switchOptions: { handoffTimeoutMs: 20 }, connections: async () => ({}), emit: event => events.push(event),
    changed: (_id, event) => { if (event) context.structuredEvent('t', event); },
    activateNative, terminal: () => { host.nativeStructured = false; } });
  context.nativeSessions = facade; host.observeNativeSwitch = () => facade.observe('t');
  facade.getSettings();
  const handlers = new Map(); facade.register((name, fn) => handlers.set(name, fn));
  await handlers.get('native:settings-set')({ claudePath: native ? (apiOnly ? 'api-only' : 'api-then-terminal') : 'terminal-only' });
  if (native) await facade.start('t', { agent: 'claude' });
  t.after(async () => { host.gate.dispose(); await facade.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const settings = patch => handlers.get('native:settings-set')(patch);
  const answer = action => { const state = facade.switchState('t'); return facade.answer('t', facade.snapshot('t')?.runtimeSessionId || 't', state.requestId,
    { switch: { changeId: state.changeId, requestId: state.requestId, action } }); };
  return { facade, host, context, events, created, settings, answer, handlers, directory };
}

test('F1 real InputGate launch/escape traffic does not invent a draft in main or block the coordinator', async t => {
  const f = await fixture(t);
  f.host.gate.afterPrompt('claude --resume synthetic\r'); f.host.gate.release(); f.host.gate.input('\x1b'); f.host.gate.input('\x1b[C');
  assert.equal(f.context.observeSwitchTerminal({ identity: f.host }).draftBlocked, false);
  f.host.submissions.write('real draft'); assert.equal(f.context.observeSwitchTerminal({ identity: f.host }).draftBlocked, true);
  f.host.completionWork.start('observed-job', Date.now()); assert.equal(f.context.observeSwitchTerminal({ identity: f.host }).background.count, 1);
  f.host.completionWork.finish('observed-job'); assert.deepEqual(JSON.parse(JSON.stringify(f.context.observeSwitchTerminal({ identity: f.host }).background)), { known: true, count: 0 });
  f.host.submissions.write('\x15'); await f.settings({ claudePath: 'api-only' }); await tick();
  assert.equal(f.facade.switchState('t').phase, 'preparing', 'G5 an observed idle terminal without tasks switches directly');
});

test('F1 real main request observations keep native dialog keys separate from an actual draft', async t => {
  const f = await fixture(t); f.host.native = {}; f.host.agent = 'codex'; f.host.draftSubmissions = new SubmissionTracker({ captureText: false });
  f.host.actions = new ActionLog(() => {});
  Object.assign(f.context, { nativeSkillActions: () => [], describeActions() {} });
  vm.runInContext(main.slice(main.indexOf('function nativeSessionEvent('), main.indexOf('function nativeSpec(')), f.context);
  const listeners = {};
  require('../electron/features/terminal/ipc.cjs').registerTerminalIpc({ handle() {}, listen: (name, fn) => { listeners[name] = fn; },
    getSession: () => f.host, getProjectById: assert.fail, expectCompletion: assert.fail });
  f.context.nativeSessionEvent('t', 'pty', { id: 17, method: 'item/commandExecution/requestApproval', params: { threadId: 'same' } });
  listeners['terminal:write']('t', '1'); assert.equal(f.context.observeSwitchTerminal({ identity: f.host }).draftBlocked, false);
  f.context.nativeSessionEvent('t', 'pty', { method: 'serverRequest/resolved', params: { requestId: 17 } });
  listeners['terminal:write']('t', '\x1b[D'); assert.equal(f.context.observeSwitchTerminal({ identity: f.host }).draftBlocked, false);
  listeners['terminal:write']('t', 'new text'); assert.equal(f.context.observeSwitchTerminal({ identity: f.host }).draftBlocked, true);
  assert.equal(f.host.draftSubmissions.text, '');
  f.context.nativeSessionEvent('t', 'pty', { id: 18, method: 'item/commandExecution/requestApproval', params: { threadId: 'same' } });
  listeners['terminal:write']('t', '\r');
  f.context.nativeSessionEvent('t', 'pty', { method: 'serverRequest/resolved', params: { requestId: 18 } });
  assert.equal(f.context.observeSwitchTerminal({ identity: f.host }).draftBlocked, true, 'a dialog cannot erase the draft waiting behind it');
});

test('F7/F8 main keeps the replacement terminal identity and closes waiting switch records', async t => {
  const f = await fixture(t); await f.settings({ claudePath: 'api-only' }); await tick();
  const next = { ...f.host, sessionId: 'new-pty', nativeRuntimeSessionId: 'new-runtime', cliState: { sessionId: 'new-pty', state: 'idle' } };
  f.context.sessions.set('t', next); f.facade.reconcile(); await tick();
  assert.equal(next.nativeRuntimeSessionId, 'new-runtime');
  assert.equal(f.events.at(-1).runtimeSessionId, 'new-runtime');
  await f.facade.forget('t'); assert.equal(f.facade.switchState('t'), null);
  assert.equal((await f.facade.usage()).switches.waiting, 0);
});

test('F11 key clear succeeds even if an idle runtime checkpoint cannot decrypt', async t => {
  const f = await fixture(t, { native: true });
  f.created[0].checkpoint = () => { throw new Error('Synthetic decryption failure'); };
  assert.deepEqual(f.facade.keyClear(), { saved: false });
});

test('F12 an adapter rejection during an asynchronous send still produces an unsent item and receipt', async t => {
  const f = await fixture(t, { native: true }); f.created[0].send = async () => ({ status: 'rejected' });
  await f.facade.send('t', f.facade.snapshot('t').runtimeSessionId, { clientMessageId: 'adapter-rejected', text: 'Keep this input' });
  assert.ok(f.events.some(event => event.type === 'input.receipt' && event.payload.clientMessageId === 'adapter-rejected' && event.payload.status === 'rejected'));
  assert.ok(f.events.some(event => event.type === 'item.upsert' && event.payload.content.unsent));
});

test('F15 staged main dispatch updates use the source tracker and survive activation state retention', async t => {
  const f = await fixture(t); Object.assign(f.context, { AgentCalls, path, os, claudeConfigDir: () => f.directory, send() {} });
  f.host.usageEnv = { CODEX_HOME: f.directory, CLAUDE_CONFIG_DIR: f.directory };
  vm.runInContext(main.slice(main.indexOf('function callsOf('), main.indexOf('function resolveIntervention(')), f.context);
  const calls = f.context.callsOf(f.host, { kind: 'local' }); t.after(() => calls.dispose());
  const id = '11111111-1111-4111-8111-111111111111';
  calls.dispatch({ type: 'dispatch-start', id, agent: 'claude', model: 'fake', cwd: os.tmpdir(), title: 'Synthetic', startedAt: Date.now(), helperPid: process.pid });
  const staged = { ...f.host, switchPreviousHost: f.host, calls: undefined }; f.context.sessions.set('t', staged);
  const incoming = f.context.callsOf(staged, { kind: 'local' }); assert.equal(incoming, calls);
  incoming.dispatch({ type: 'dispatch-end', id, model: 'fake', reason: 'exit', exitCode: 0, endedAt: Date.now(), outputTokens: null, activeMs: null });
  f.context.retainAgentState(staged, f.host); assert.equal(staged.calls.running().length, 0); assert.equal(staged.calls.snapshot()[0].items[0].failure, null);
});

test('F13/F14 a no-history terminal starts fresh through actual main activation and releases retired background tracking only', async t => {
  const f = await fixture(t);
  f.host.completionWork.start('retired-task', Date.now()); f.host.completionWork.notifications.add('retired-notification');
  f.host.completionWork.reviewAt = 42;
  await f.settings({ claudePath: 'api-only' }); await tick(); f.answer('now'); await tick();
  const state = f.facade.switchState('t');
  f.facade.answer('t', 't', `handoff-${state.changeId}`, { handoff: { changeId: state.changeId, draft } }); await tick();
  assert.equal(f.facade.switchState('t').current, 'api');
  const host = f.context.sessions.get('t'); assert.equal(host.nativeStructured, true);
  assert.equal(host.completionWork.tasks.size, 0); assert.equal(host.completionWork.notifications.size, 0); assert.equal(host.completionWork.reviewAt, 42);
});

test('F2 missing or rejected handoff times out through the real facade/router and keeps the main terminal', async t => {
  const f = await fixture(t); await f.settings({ claudePath: 'api-only' }); await tick(); f.answer('now'); await tick();
  const state = f.facade.switchState('t');
  assert.throws(() => f.handlers.get('native:answer')('t', 't', `handoff-${state.changeId}`, { handoff: { changeId: state.changeId,
    draft: { ...draft, images: ['data:image/gif;base64,AA=='] } } }));
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(f.facade.switchState('t').phase, 'stable'); assert.equal(f.host.nativeStructured, false);
  assert.ok(f.facade.switchState('t').reason);
});

test('F3 main unknown background can wait and later switch now using the same request', async t => {
  const f = await fixture(t); f.host.completionWork.uncertain = true; await f.settings({ claudePath: 'api-only' }); await tick();
  const requestId = f.facade.switchState('t').requestId;
  assert.equal(f.answer('wait').accepted, true); await tick();
  assert.equal(f.facade.switchState('t').requestId, requestId); assert.equal(f.answer('now').accepted, true);
});

test('F4 waiting for background never uses the legacy destructive fallback and returns an unsent receipt', async t => {
  const f = await fixture(t, { native: true }); await f.settings({ claudePath: 'terminal-only' }); await tick(); f.answer('wait'); await tick();
  const result = await f.facade.send('t', f.facade.snapshot('t').runtimeSessionId, { clientMessageId: 'unsent', text: 'Preserve me' });
  assert.equal(result.status, 'rejected'); assert.equal(f.created[0].closed, false);
  assert.ok(f.events.some(event => event.type === 'input.receipt' && event.payload.clientMessageId === 'unsent' && event.payload.status === 'rejected'));
});

test('F5 actual main project validation permits read-only SSH usage with none connections and no path', async t => {
  const f = await fixture(t, { ssh: true }); const usage = await f.facade.usage('p');
  for (const agent of ['claude', 'codex']) { assert.equal(usage.agents[agent].path, null); assert.equal(usage.agents[agent].connection.kind, 'none'); }
});

test('F6 clearing an api-only key blocks running sends and retires at the turn boundary', async t => {
  const f = await fixture(t, { native: true, apiOnly: true }), runtime = f.created[0];
  runtime.state('running'); f.facade.keyClear(); await tick();
  const result = await f.facade.send('t', f.facade.snapshot('t').runtimeSessionId, { clientMessageId: 'after-clear', text: 'Must not bill' });
  assert.equal(result.status, 'rejected'); assert.equal(runtime.sent, 0); assert.equal(runtime.closed, false);
  runtime.state('idle'); await tick(); assert.equal(runtime.closed, true);
  assert.ok(f.events.some(event => event.type === 'session.state' && event.payload.state === 'stopped' && event.payload.reason));
});
