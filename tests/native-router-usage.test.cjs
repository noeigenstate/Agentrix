const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { registerClaudeWorker } = require('../electron/features/native-session/worker.cjs');
const { nextPath, subscriptionLimits } = require('../electron/features/native-session/usage.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { createEventStream } = require('../electron/features/native-session/events.cjs');
const { createUsage } = require('../electron/features/claude-sdk/usage.cjs');

for (const [agent, config, status, cli, expected] of [
  ['claude', {}, 'no_key', 'ok', ['terminal', 'no_key']],
  ['claude', {}, 'ready', 'ok', ['api', null]],
  ['claude', {}, 'budget_exhausted', 'ok', ['terminal', 'budget_exhausted']],
  ['claude', {}, 'ready', 'missing', ['terminal', 'cli_missing']],
  ['claude', {}, 'ready', 'too_old', ['terminal', 'cli_too_old']],
  ['claude', { claudePath: 'api-only' }, 'ready', 'ok', ['api', 'set_api']],
  ['claude', { claudePath: 'api-only' }, 'no_key', 'ok', [null, 'no_key']],
  ['claude', { claudePath: 'api-only' }, 'ready', 'too_old', [null, 'cli_too_old']],
  ['claude', { claudePath: 'terminal-only' }, 'no_key', 'missing', ['terminal', 'set_terminal']],
  ['claude', {}, 'rate_limited', 'ok', ['terminal', 'rate_limited']],
  ['claude', {}, 'credits_exhausted', 'ok', ['terminal', 'credits_exhausted']],
  ['claude', {}, 'invalid_key', 'ok', ['terminal', 'invalid_key']],
  ['codex', {}, null, 'ok', ['native', null]],
  ['codex', {}, null, 'missing', ['terminal', 'cli_missing']],
  ['codex', { codexView: 'terminal' }, null, 'missing', ['terminal', 'set_terminal']],
]) test(`next path: ${agent} ${JSON.stringify(config)} ${status} CLI ${cli}`, () => {
  assert.deepEqual(nextPath(agent, config, { status }, { status: cli }), { path: expected[0], reason: expected[1] });
});

test('subscription limits preserve milliseconds, missing windows, credits, source and freshness', () => {
  const account = { at: 1000, source: 'fixture', limits: [{ minutes: 10080, percent: 42, resetsAt: 1234567890000 }] };
  const value = subscriptionLimits(account, 'scope', 120000, 1001);
  assert.equal(value.limitsById.subscription.primary, undefined);
  assert.deepEqual(value.limitsById.subscription.secondary, { usedPercent: 42, windowDurationMins: 10080, resetsAtMs: 1234567890000 });
  assert.equal(value.observedAtMs, 1000); assert.equal(value.source, 'fixture'); assert.equal(value.billingRoute, 'subscription');
  assert.equal(value.state, 'ready'); assert.equal(value.resetCredits, null);
  assert.equal(subscriptionLimits(account, 'scope', 120000, 121001).state, 'stale');
  assert.equal(subscriptionLimits(null, 'scope', 120000), null);
  assert.equal(subscriptionLimits({}, 'scope', 120000), null);
  assert.equal(subscriptionLimits({ resetQuery: { state: 'loading' } }, 'scope', 120000).state, 'loading');
  assert.equal(subscriptionLimits({ resetQuery: { state: 'error' } }, 'scope', 120000).state, 'error');
  assert.deepEqual(subscriptionLimits({ resets: { left: 0 } }, 'scope', 120000).resetCredits, { availableCount: 0 });
});

test('native limit events win over subscription fallback and reads leave running paths unchanged', async () => {
  let stream;
  const runtime = { apiState: () => ({ status: 'ready' }), usage: { summary: () => ({}) }, create(spec, emit) {
    stream = createEventStream(spec, emit);
    return { async start() {}, async close() {}, snapshot: () => ({ state: 'idle' }) };
  } };
  const config = { claudePath: 'api-then-terminal', codexView: 'native', monthlyBudgetUsd: null };
  const router = createRouter({ claude: runtime, codex: runtime, settings: { get: () => config },
    resolveSpec: id => ({ terminalId: id, projectId: 'p' }), emit() {} });
  const fallback = subscriptionLimits({ limits: [{ minutes: 300, percent: 10 }] }, 'subscription', 120000);
  assert.equal(router.usage({ limits: { claude: fallback } }).agents.claude.limits.source, 'subscription');
  await router.start('t', { agent: 'claude' });
  const native = { ...fallback, source: 'native', billingRoute: 'api' };
  stream.publish('limits.updated', native);
  config.claudePath = 'terminal-only';
  const usage = router.usage({ limits: { claude: fallback } });
  assert.equal(usage.agents.claude.path, 'api'); assert.equal(usage.agents.claude.reason, null);
  assert.deepEqual(usage.agents.claude.next, { path: 'terminal', reason: 'set_terminal' });
  assert.equal(usage.agents.claude.limits.source, 'native');
  usage.agents.claude.limits.source = 'mutated';
  assert.equal(router.usage().agents.claude.limits.source, 'native');
  await router.close();
});

test('real main assembly reports terminal-only Claude subscription usage without a key or native session', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-main-usage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const forbidden = () => assert.fail('usage read must not start an account poll, CLI session, SDK or network request');
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: forbidden };
  const at = Date.now(), reset = at + 3600000;
  const terminal = { terminalId: 't', projectId: 'p', agent: 'claude', codexActive: true, status: 'codex',
    activitySince: at, usage: { agent: 'claude', limits: [] } };
  const claudeAccounts = new Proxy({ account: { at, source: 'Claude', limits: [
    { minutes: 300, percent: 25, resetsAt: reset }, { minutes: 10080, percent: 60, resetsAt: reset + 86400000 },
  ] } }, { get: (target, key) => key in target ? target[key] : forbidden });
  const codexAccounts = new Proxy({ interval: 30000, entries: new Map([['codex-scope', { value: {
    at, source: 'Codex', limits: [{ minutes: 300, percent: 12, resetsAt: reset }], resets: { left: 2 }, resetQuery: { state: 'ready' },
  } }]]) }, { get: (target, key) => key in target ? target[key] : forbidden });
  let cli = 'ok', codexInstalled = true;
  const focused = { claude: { ...claudeAccounts.account, connection: { kind: 'subscription', active: false } },
    codex: { ...codexAccounts.entries.get('codex-scope').value, connection: { kind: 'subscription', active: false } } };
  let focusedReads = 0;
  const context = { path, structuredClone, claudeAccounts, codexAccounts, sessions: new Map([['t', terminal]]),
    projectAccounts: { snapshot: id => id === 'p' ? focused : null, read: async () => { focusedReads++; } },
    shellPathReady: Promise.resolve(), createTerminalEnvironment: () => ({}), withoutAppImage: value => value, process: { env: {} },
    store: { projects: [{ id: 'p', kind: 'local' }], findTerminal: () => ({ project: { id: 'p', kind: 'local' }, record: { restore: {} } }) },
    randomUUID: require('node:crypto').randomUUID, queueMicrotask, wholeThread: require('../electron/terminal-title.cjs').wholeThread,
    app: { getPath: () => directory, isPackaged: false }, subscriptionLimits, createNativeSessions, registerClaudeWorker,
    createClaudeRuntime: options => createClaudeRuntime({ ...options, request: forbidden, resolveExecutable: forbidden, inspectCli: forbidden }),
    createSdkLoader: () => forbidden, inspectClaudeExecutable: async () => ({ status: cli }),
    codexExecutable: async () => codexInstalled ? 'fixture-codex' : null,
    nativeSpec: forbidden, quitting: false, send() {}, scheduleState() {}, t: value => value,
    require: name => {
      if (name === 'electron') return { safeStorage };
      if (name === './features/team/team.cjs') return { projectTeam: forbidden };
      assert.fail(`unexpected require: ${name}`);
    },
    importFixture: async name => {
      if (name === './features/codex-app-server/index.cjs') return { createCodexRuntime: () => ({ create: forbidden }) };
      if (name === './features/agents/dispatch-control.cjs') return { createDispatchControl: () => ({
        listen: async () => ({ address: 'fixture-control' }), onRequest() {},
      }) };
      assert.fail(`unexpected import: ${name}`);
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function structuredEvent('), source.indexOf('async function readNativeConnections(')), context);
  vm.runInContext(source.slice(source.indexOf('function localClaudeMeters('), source.indexOf('function disposeClaudeAccounts(')), context);
  // Execute the actual main composition and callbacks; substitute only dynamic module loading at the process boundary.
  vm.runInContext(source.slice(source.indexOf('async function readNativeConnections('), source.indexOf('function startTerminal('))
    .replaceAll('await import(', 'await importFixture('), context);
  await context.initializeNativeSessions();
  t.after(() => context.nativeSessions.close());
  const handlers = new Map(); context.nativeSessions.register((name, handle) => handlers.set(name, handle));
  const usage = id => handlers.get('native:usage')(id);
  let value = await usage();
  assert.equal(context.nativeSessions.has('t'), false);
  assert.equal(value.agents.claude.path, null); assert.equal(value.lastSwitch, undefined);
  assert.deepEqual(value.agents.claude.next, { path: 'terminal', reason: 'no_key' });
  assert.equal(value.agents.claude.connection.kind, 'subscription');
  assert.equal(value.agents.claude.limits.source, 'Claude'); assert.equal(value.agents.claude.limits.observedAtMs, at);
  assert.equal(value.agents.claude.limits.state, 'ready');
  assert.equal(value.agents.claude.limits.limitsById.subscription.primary.resetsAtMs, reset);
  assert.equal(value.agents.claude.limits.limitsById.subscription.secondary.usedPercent, 60);
  assert.equal(value.agents.codex.limits.limitsById.subscription.primary.usedPercent, 12);
  assert.equal(value.agents.codex.limits.resetCredits.availableCount, 2);
  assert.equal(value.apiRecords, false); assert.equal(value.todayUsdMicros, null); assert.equal(value.monthUsdMicros, null);
  const fakeKey = 'sk-ant-api03-fixture-only-never-real';
  handlers.get('native:key-save')(fakeKey);
  value = await usage();
  assert.deepEqual(value.agents.claude.next, { path: 'api', reason: null });
  assert.equal(value.agents.claude.path, null); assert.equal(value.agents.claude.connection.kind, 'subscription');
  assert.equal(value.apiRecords, false); assert.ok(!JSON.stringify(value).includes(fakeKey));
  handlers.get('native:settings-set')({ monthlyBudgetUsd: 0 });
  assert.equal((await usage()).agents.claude.next.reason, 'budget_exhausted');
  handlers.get('native:settings-set')({ monthlyBudgetUsd: null });
  cli = 'too_old'; assert.equal((await usage()).agents.claude.next.reason, 'cli_too_old');
  cli = 'missing'; assert.equal((await usage()).agents.claude.next.reason, 'cli_missing');
  codexInstalled = false; assert.equal((await usage()).agents.codex.next.reason, 'cli_missing');
  cli = 'ok';
  handlers.get('native:settings-set')({ claudePath: 'terminal-only', codexView: 'terminal' });
  value = await usage();
  assert.equal(value.agents.claude.next.reason, 'set_terminal'); assert.equal(value.agents.codex.next.reason, 'set_terminal');
  claudeAccounts.account.limits[0].percent = 30;
  assert.equal((await usage()).agents.claude.limits.limitsById.subscription.primary.usedPercent, 30, 'reads use the latest held observation');
  claudeAccounts.account = null; codexAccounts.entries.clear();
  value = await usage();
  assert.equal(value.agents.claude.limits, null); assert.equal(value.agents.codex.limits, null);
  terminal.usage = { agent: 'claude', limits: [{ minutes: 300, percent: 33, resetsAt: reset }], limitsAt: at, limitsFrom: 'CodePulse' };
  value = await usage();
  assert.equal(value.agents.claude.limits.source, 'CodePulse'); assert.equal(value.agents.claude.limits.limitsById.subscription.primary.usedPercent, 33);
  context.sessions.clear();
  value = await usage('p');
  assert.equal(focusedReads, 1);
  for (const agent of ['claude', 'codex']) {
    assert.equal(value.agents[agent].connection.kind, 'subscription');
    assert.equal(value.agents[agent].connection.active, false);
    assert.equal(value.agents[agent].path, null);
    assert.equal(value.agents[agent].limits.state, 'ready');
  }
  assert.equal(value.agents.codex.limits.limitsById.subscription.primary.usedPercent, 12);
});

test('API records distinguish an empty ledger from zero spend and survive reload', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-usage-records-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'usage.json');
  const usage = createUsage({ file });
  assert.equal(usage.summary().apiRecords, false); assert.equal(usage.summary().todayUsdMicros, null);
  const lease = usage.reserve(10);
  assert.equal(usage.summary().apiRecords, false, 'a reservation alone is not an API session record');
  usage.release(lease.id);
  usage.record('fixture-session', { uuid: 'result', total_cost_usd: 0 });
  assert.equal(usage.summary().apiRecords, true); assert.equal(usage.summary().todayUsdMicros, 0);
  assert.equal(createUsage({ file }).summary().apiRecords, true);
});
