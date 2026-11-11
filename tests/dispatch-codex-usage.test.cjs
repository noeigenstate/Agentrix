// A planner in a terminal (no native Codex session) dispatches Codex workers on app-server: the pane's Codex section takes
// their own app-server's account and quota, with the same rules as a native session. Synthetic app-server and events only.
require('./fixtures/team-isolation.cjs');
const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const { run } = require('../integration/dispatch.cjs');
const { createEventServer } = require('../electron/events.cjs');
const { createDispatchControl } = require('../electron/features/agents/dispatch-control.cjs');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { acceptDispatch, dispatchAccount, validDispatch } = require('../electron/features/agents/dispatch-events.cjs');
const { accountScopeId } = require('../electron/features/agents/codex-account-usage.cjs');
const { accountConnection } = require('../electron/features/codex-app-server/account.cjs');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { registerClaudeWorker } = require('../electron/features/native-session/worker.cjs');
const { subscriptionLimits } = require('../electron/features/native-session/usage.cjs');

const first = { type: 'chatgpt', email: 'first@example.invalid' }, second = { type: 'chatgpt', email: 'second@example.invalid' };
const routing = { model: 'synthetic-model', effort: 'high', fast: null };
const start = id => ({ type: 'dispatch-start', projectId: 't', sessionKey: 'planner-key', id, agent: 'codex', role: '审查', title: 'Synthetic usage',
  ...routing, cwd: '/project', brief: '/brief.md', out: '/out.md', sessionId: randomUUID(), startedAt: 1000 });
const end = id => ({ type: 'dispatch-end', projectId: 't', sessionKey: 'planner-key', id, ...routing, exitCode: 0, reason: 'exit',
  outputTokens: 1, activeMs: 1, endedAt: 2000 });
const report = (id, account, usedPercent, at, limitsById) => ({ type: 'dispatch-account', projectId: 't', sessionKey: 'planner-key', id,
  connection: { kind: 'subscription', observedAt: at, scopeId: accountScopeId(account) },
  limits: { state: 'ready', observedAtMs: at, resetCredits: { availableCount: 2 }, ordinaryUsageAllowed: true, scopeId: 'helper-scope', billingRoute: 'unknown',
    source: 'codex-app-server', limitsById: limitsById || { codex: { primary: { usedPercent, windowDurationMins: 300, resetsAtMs: at + 3600000 } } } } });

// The helper as the planner's terminal runs it, against the synthetic app-server; every event it sends to main, in order.
// With control, main's registration hands the helper main's account key, as for a local project. The key is not this
// process's own, so a helper that did not name the account with it gives another name. Returns the events and the key.
async function dispatchCodex(t, env, { control = true } = {}) {
  const accountKey = randomBytes(32).toString('hex');
  const lifetime = resources(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-dispatch-usage-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const events = [], server = await createEventServer(event => events.push(event)); lifetime.defer('close events', () => server.close());
  const brief = path.join(root, 'brief.md'), out = path.join(root, 'answer.md'), bootstrap = path.join(root, 'bootstrap.json');
  fs.writeFileSync(brief, 'Synthetic task');
  const binding = { pipeName: server.name.startsWith('agentrix-') ? server.name : server.address, projectId: 't', sessionKey: 'planner-key' };
  if (control) {
    const channel = createDispatchControl({ accountKey, resolveRun: auth => auth.capability === 'synthetic-capability'
      ? { runId: auth.runId, projectId: 't', cwd: root, allow: [], agent: 'codex', readOnly: true, local: true } : null });
    const { address } = await channel.listen(); lifetime.defer('close control', () => channel.close());
    Object.assign(binding, { controlAddress: address, controlCapability: 'synthetic-capability' });
  }
  fs.writeFileSync(bootstrap, JSON.stringify(binding));
  const code = await run(['codex', '--role', 'review', '--title', 'Synthetic usage', '--model', 'synthetic-model', '--effort', 'high',
    '--cwd', root, '--brief', brief, '--out', out], { env: { PATH: '', HOME: root, USERPROFILE: root, CODEX_HOME: root, AGENTRIX_BOOTSTRAP: bootstrap, ...env },
    stdout: { write() {} },
    resolveExecutable: (_agent, args) => ({ file: process.execPath, args: [path.join(__dirname, 'fixtures/codex-app-server.cjs'), ...args] }),
    launch: (file, args, options) => lifetime.child(spawn(file, args, options)) });
  assert.equal(code, 0);
  for (let n = 0; !events.some(event => event.type === 'dispatch-end') && n < 200; n++) await new Promise(resolve => setTimeout(resolve, 10));
  // Anything the helper still had in flight arrives now or never.
  await new Promise(resolve => setTimeout(resolve, 200));
  return { events, accountKey };
}

// main.cjs's own event handler, usage readers and native-session assembly; a planner Claude in a terminal and no Codex
// session. projectAccount is what the project's own account read retained (null: it gave nothing, as reported).
async function mainAssembly(t, { kind = 'local', projectAccount = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-dispatch-main-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const forbidden = () => assert.fail('usage read must not start an account poll, CLI session, SDK or network request');
  const project = { id: 'p', kind }, calls = new AgentCalls(); t.after(() => calls.dispose());
  const planner = { terminalId: 't', projectId: 'p', sessionKey: 'planner-key', agent: 'claude', codexActive: true, status: 'codex',
    activitySince: Date.now(), usage: { agent: 'claude', limits: [] } };
  const context = { path, structuredClone, sessions: new Map([['t', planner]]), claudeAccounts: { account: null },
    codexAccounts: new Proxy({ interval: 30000, entries: new Map(), closeProject() {} }, { get: (target, key) => key in target ? target[key] : forbidden }),
    projectAccounts: { snapshot: id => id === 'p' && projectAccount ? { codex: projectAccount } : null, read: async () => null, close() {} },
    shellPathReady: Promise.resolve(), createTerminalEnvironment: () => ({}), withoutAppImage: value => value, process: { env: {} },
    store: { projects: [project], findTerminal: () => ({ project, record: { restore: {} } }), remove() {} },
    randomUUID, queueMicrotask, wholeThread: require('../electron/terminal-title.cjs').wholeThread,
    app: { getPath: () => directory, isPackaged: false }, subscriptionLimits, createNativeSessions, registerClaudeWorker,
    createClaudeRuntime: options => createClaudeRuntime({ ...options, request: forbidden, resolveExecutable: forbidden, inspectCli: forbidden }),
    createSdkLoader: () => forbidden, inspectClaudeExecutable: async () => ({ status: 'ok' }), codexExecutable: async () => 'fixture-codex',
    generatedPreview: forbidden, nativeSpec: forbidden, quitting: false, send() {}, scheduleState() {}, t: value => value,
    broadcast() {}, callsOf: () => calls, acceptShellEvent: () => false, rememberClaudeSource() {},
    require: name => {
      if (name === 'electron') return { safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: forbidden } };
      if (name === './features/agents/dispatch-events.cjs') return require('../electron/features/agents/dispatch-events.cjs');
      if (name === './features/team/team.cjs') return { projectTeam: forbidden };
      assert.fail(`unexpected require: ${name}`);
    },
    importFixture: async name => {
      if (name === './features/codex-app-server/index.cjs') return { createCodexRuntime: () => ({ create: forbidden }) };
      if (name === './features/agents/dispatch-control.cjs') return { createDispatchControl: () => ({ listen: async () => ({ address: 'fixture-control' }), onRequest() {} }) };
      assert.fail(`unexpected import: ${name}`);
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function onEvent('), source.indexOf('function launchAfterPrompt(')), context);
  vm.runInContext(source.slice(source.indexOf('function structuredEvent('), source.indexOf('async function readNativeConnections(')), context);
  vm.runInContext(source.slice(source.indexOf('function localClaudeMeters('), source.indexOf('function disposeClaudeAccounts(')), context);
  vm.runInContext(source.slice(source.indexOf('async function readNativeConnections('), source.indexOf('function startTerminal('))
    .replaceAll('await import(', 'await importFixture('), context);
  // The workspace's project removal, as main registers it.
  const removeProject = vm.runInContext(`(${/removeProject: (id => \{[^\n]*\}),/.exec(source)[1]})`, context);
  await context.initializeNativeSessions();
  t.after(() => context.nativeSessions.close());
  const handlers = new Map(); context.nativeSessions.register((name, handle) => handlers.set(name, handle));
  return { context, removeProject, held: () => vm.runInContext('dispatchAccounts', context),
    usage: async () => (await handlers.get('native:usage')('p')).agents.codex };
}

test('a dispatched Codex worker reports its app-server account and quota between its start and end, and the pane shows them without a native session', async t => {
  const { events, accountKey } = await dispatchCodex(t, { SYNTHETIC_CODEX_ACCOUNT: JSON.stringify(first) });
  const types = events.map(event => event.type), reports = events.filter(event => event.type === 'dispatch-account');
  assert.ok(reports.length > 0, `the helper reported no account: ${types.join(', ')}`);
  assert.ok(types.indexOf('dispatch-account') > types.indexOf('dispatch-start'), 'reports follow the start');
  assert.ok(types.lastIndexOf('dispatch-account') < types.indexOf('dispatch-end'), 'no report follows the end');
  const [sent] = reports;
  assert.equal(sent.connection.kind, 'subscription');
  assert.equal(sent.connection.scopeId, accountScopeId(first, accountKey), 'the worker\'s account has the name main\'s key gives it');
  assert.equal(sent.limits.limitsById.codex.primary.usedPercent, 25);
  assert.ok(!JSON.stringify(events).includes(first.email), 'the account identity never leaves the helper');
  const { context, usage } = await mainAssembly(t);
  assert.equal((await usage()).connection.kind, 'unknown', 'without a report the section is 未知, as reported');
  for (const event of events) context.onEvent(event);
  // The pane reads while the worker runs; what it read last stays after the worker ended.
  const codex = await usage();
  assert.equal(context.nativeSessions.has('t'), false, 'no native session is involved');
  assert.equal(codex.connection.kind, 'subscription'); assert.equal(codex.connection.active, false);
  assert.equal(codex.connection.scopeId, accountScopeId(first, accountKey));
  assert.equal(codex.limits.limitsById.codex.primary.usedPercent, 25);
  assert.equal(codex.limits.resetCredits.availableCount, 2);
  assert.equal(codex.limits.accountScopeId, accountScopeId(first, accountKey));
  assert.equal(codex.limits.limitsById.codex.primary.resetsAtMs, 100000, 'a reset time already past is kept for the pane to say it waits for an update');
});

test('a worker that signs in to another account reads it again: the next report names the new account', async t => {
  const { events, accountKey } = await dispatchCodex(t, { SYNTHETIC_CODEX_ACCOUNT: JSON.stringify(first), SYNTHETIC_CODEX_NEXT_ACCOUNT: JSON.stringify(second) });
  const reports = events.filter(event => event.type === 'dispatch-account');
  // However soon after the switch the start is confirmed, the report reads the account then: it names the new one.
  assert.ok(reports.length > 0);
  assert.equal(reports.at(-1).connection.scopeId, accountScopeId(second, accountKey));
  assert.equal(reports.at(-1).limits.limitsById.codex.primary.usedPercent, 60);
  assert.ok(!reports.some(event => event.connection.scopeId === accountScopeId(first, accountKey) && event.limits?.limitsById.codex?.primary?.usedPercent === 60),
    'the second account\'s quota is never reported for the first');
});

test('without main\'s account key (no control channel, or an SSH run) the helper names no account', async t => {
  const { events } = await dispatchCodex(t, { SYNTHETIC_CODEX_ACCOUNT: JSON.stringify(first) }, { control: false });
  const reports = events.filter(event => event.type === 'dispatch-account');
  assert.ok(reports.length > 0);
  assert.ok(reports.every(event => event.connection.kind === 'subscription' && event.connection.scopeId === undefined));
  const key = randomBytes(32).toString('hex'), registered = [];
  const channel = createDispatchControl({ accountKey: key,
    resolveRun: auth => ({ runId: auth.runId, projectId: 't', cwd: os.tmpdir(), allow: [], local: auth.capability === 'local' }) });
  const { address } = await channel.listen(); t.after(() => channel.close());
  for (const capability of ['local', 'ssh']) {
    const socket = net.connect(address);
    socket.on('data', data => { registered.push(JSON.parse(data.toString().trim())); socket.destroy(); });
    socket.once('connect', () => socket.write(JSON.stringify({ v: 1, type: 'register', runId: capability, projectId: 't', sessionKey: 'k', capability }) + '\n'));
    await new Promise(resolve => socket.once('close', resolve));
  }
  assert.equal(registered.find(value => value.runId === 'local').accountKey, key);
  assert.equal(registered.find(value => value.runId === 'ssh').accountKey, undefined);
});

test('reports keep the last reading, follow a newer one of the same account and never mix two accounts', async t => {
  const { context, usage } = await mainAssembly(t), at = Date.now(), id = randomUUID();
  context.onEvent(start(id));
  context.onEvent(report(id, first, 40, at - 2000));
  let codex = await usage();
  assert.equal(codex.connection.scopeId, accountScopeId(first)); assert.equal(codex.limits.limitsById.codex.primary.usedPercent, 40);
  assert.equal((await usage()).limits.limitsById.codex.primary.usedPercent, 40, 'the last reading stays when nothing new arrives');
  context.onEvent(report(id, first, 45, at - 1000));
  assert.equal((await usage()).limits.limitsById.codex.primary.usedPercent, 45);
  context.onEvent(report(id, second, 10, at, { other: { secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAtMs: at + 86400000 } } }));
  codex = await usage();
  assert.equal(codex.connection.scopeId, accountScopeId(second));
  assert.deepEqual(Object.keys(codex.limits.limitsById), ['other'], 'the first account\'s windows are not merged into the second\'s');
  assert.equal(codex.limits.accountScopeId, accountScopeId(second));
  context.onEvent(report(id, first, 99, at - 500));
  codex = await usage();
  assert.equal(codex.connection.scopeId, accountScopeId(second), 'an older reading of another account does not replace the newer one');
  assert.equal(codex.limits.limitsById.other.secondary.usedPercent, 10);
});

test('the project\'s own named account stands: another account\'s report never displaces its connection or quota', async t => {
  const at = Date.now(), id = randomUUID();
  const projectAccount = { at: at - 5000, source: 'Codex', limits: [{ minutes: 300, percent: 12, resetsAt: at + 3600000 }], resets: { left: 1 },
    resetQuery: { state: 'ready' }, connection: { kind: 'subscription', active: false, source: 'codex-account-usage account/read', observedAt: at - 5000, scopeId: accountScopeId(first) } };
  const { context, usage } = await mainAssembly(t, { projectAccount });
  context.onEvent(start(id));
  context.onEvent(report(id, second, 90, at));
  for (let n = 0; n < 2; n++) {
    const codex = await usage();
    assert.equal(codex.connection.scopeId, accountScopeId(first), 'the connection does not flip to the reported account');
    assert.equal(codex.limits.accountScopeId, accountScopeId(first));
    assert.equal(codex.limits.limitsById.subscription.primary.usedPercent, 12);
  }
  context.onEvent(report(id, first, 30, at + 1));
  const codex = await usage();
  assert.equal(codex.connection.scopeId, accountScopeId(first));
  assert.equal(codex.limits.limitsById.codex.primary.usedPercent, 30, 'a newer report of the same account follows');
});

test('account reports come from a running Codex call, are bounded, read as stale when old, stay out of SSH projects and go with the project', async t => {
  const at = Date.now(), id = randomUUID(), session = { terminalId: 't', sessionKey: 'planner-key' }, accept = () => true;
  const calls = new AgentCalls(); t.after(() => calls.dispose());
  assert.equal(acceptDispatch(session, report(id, first, 20, at), calls, accept), false, 'an unknown call cannot report');
  calls.dispatch(start(id));
  for (const patch of [{ sessionKey: 'forged' }, { projectId: 'other-terminal' }]) {
    assert.equal(acceptDispatch(session, { ...report(id, first, 20, at), ...patch }, calls, accept), false);
  }
  assert.equal(acceptDispatch(session, report(id, first, 20, at), calls, accept), true);
  const event = report(id, first, 20, at);
  for (const bad of [{ connection: { ...event.connection, kind: 'invented' } }, { connection: { ...event.connection, scopeId: first.email } },
    { connection: { ...event.connection, observedAt: at + 120000 } }, { limits: { ...event.limits, observedAtMs: at + 120000 } },
    { limits: { ...event.limits, limitsById: { codex: { primary: { usedPercent: 101 } } } } }, { limits: { ...event.limits, state: 'loading' } },
    { connection: { kind: 'unknown', observedAt: null }, limits: null }]) {
    assert.equal(dispatchAccount({ ...event, ...bad }), null); assert.equal(validDispatch({ ...event, ...bad }), false);
  }
  const payload = dispatchAccount(event);
  assert.equal(payload.scopeId, `codex-dispatch:${accountScopeId(first)}`); assert.equal(payload.billingRoute, 'subscription');
  assert.equal(payload.accountConnection.scopeId, accountScopeId(first));
  assert.equal(structuredClone(payload).accountConnection, undefined, 'the connection evidence never crosses IPC');
  calls.dispatch(end(id));
  assert.equal(acceptDispatch(session, report(id, first, 20, at), calls, accept), false, 'an ended call no longer reports');

  const { context, usage, held, removeProject } = await mainAssembly(t);
  context.onEvent(start(id));
  context.onEvent(report(id, first, 20, at - 61000));
  const old = await usage();
  assert.equal(old.limits.state, 'stale', 'past two account intervals the report reads as stale');
  assert.equal(old.connection.scopeId, accountScopeId(first), 'and its account still names the connection');
  removeProject('p');
  assert.equal(held().has('p'), false, 'a removed project\'s report goes with it');
  const ssh = await mainAssembly(t, { kind: 'ssh' });
  ssh.context.onEvent(start(id)); ssh.context.onEvent(report(id, first, 20, at));
  assert.equal(ssh.held().size, 0, 'an SSH host\'s account uses its own channel');
  assert.equal((await ssh.usage()).limits, null);
});

test('a native Codex session names its account with main\'s key and carries nothing else of it', () => {
  const connection = accountConnection({ account: first }, 1000), key = randomBytes(32).toString('hex');
  assert.equal(connection.scopeId, accountScopeId(first));
  assert.deepEqual(Object.getOwnPropertyNames(connection).sort(), ['kind', 'observedAt', 'scopeId', 'source']);
  assert.equal(accountConnection({ account: first }, 1000, key).scopeId, accountScopeId(first, key));
  assert.notEqual(accountScopeId(first, key), accountScopeId(first), 'another key gives another name');
  assert.equal(accountConnection({ account: {} }, 1000).scopeId, undefined, 'an account nobody named has no name');
});
