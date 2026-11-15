const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { timeoutScale } = require('../scripts/wait.mjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
// G6: a budget option in any spelling, as an SDK option or a CLI flag (extraArgs keys carry no dashes).
const BUDGET = /max[-_]?budget/i;
// Code that could launch Claude Code or decide on spend: modules, shell, PowerShell and batch scripts.
const CODE = /\.(?:c?js|mjs|tsx?|ps1|sh|zsh|bash|cmd|bat)$/;
const codeFiles = () => ['electron', 'src', 'integration', 'scripts'].flatMap(folder => fs.readdirSync(path.join(__dirname, '..', folder), { recursive: true })
  .map(name => path.join(__dirname, '..', folder, name)).filter(file => CODE.test(file) && fs.statSync(file).isFile()));
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-provider-')), bus = new EventEmitter(), events = [];
  const fake = fakeSdk({ uniqueSessions: true, ...options });
  const original = fake.sdk.query;
  fake.sdk.query = spec => ({ ...original(spec), getContextUsage: async () => ({ model: 'fake-model', totalTokens: 1 }) });
  const runtime = createClaudeRuntime({ directory, safeStorage, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'offline-only' });
  runtime.credentials.save('sk-ant-offline-provider-fixture');
  t.after(async () => { await runtime.close(); await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const wait = predicate => new Promise(resolve => {
    const listener = event => { if (predicate(event)) { bus.off('event', listener); resolve(event); } };
    bus.on('event', listener);
  });
  const create = (owner = 'gui', extra = {}) => runtime.create({ owner, agent: 'claude', cwd: directory, env: { PATH: '' }, projectId: 'p',
    terminalId: randomUUID(), runtimeSessionId: randomUUID(), ...extra }, event => { events.push(event); bus.emit('event', event); });
  const send = async (session, id = randomUUID()) => {
    const completed = wait(event => event.runtimeSessionId === session.snapshot().runtimeSessionId && event.type === 'turn.completed');
    await session.send({ clientMessageId: id, text: 'offline input' }); await completed;
  };
  return { directory, runtime, fake, create, events, wait, send };
}

test('no SDK option or CLI argument carries a budget cap', { timeout: 15000 * timeoutScale }, async t => {
  const f = fixture(t), owner = f.create(); await owner.start();
  await owner.send({ clientMessageId: 'question', text: '/status' });
  await f.send(owner);
  f.runtime.credentials.save('sk-ant-offline-replacement-fixture');
  await f.send(owner);
  const worker = f.create('dispatch'); await worker.start(); await f.send(worker);
  const resumed = f.create('gui', { providerSessionId: randomUUID() }); await resumed.start(); await f.send(resumed);
  const { probeBillingIdentity } = require('../electron/features/claude-sdk/billing.cjs');
  await probeBillingIdentity({ key: 'sk-ant-offline-probe', spec: { owner: 'gui', cwd: f.directory, env: { PATH: '' } },
    loadSdk: async () => f.fake.sdk, resolveExecutable: async () => 'offline-only' });
  assert.ok(f.fake.calls.length >= 5);
  for (const { options } of f.fake.calls) assert.doesNotMatch(JSON.stringify(options), BUDGET);
});

test('two native owner sessions and a native worker run at once with no allowance shared or held', { timeout: 15000 * timeoutScale }, async t => {
  const f = fixture(t), sessions = [f.create(), f.create(), f.create('dispatch')];
  await Promise.all(sessions.map(session => session.start()));
  await Promise.all(sessions.map(session => f.send(session)));
  assert.equal(f.fake.calls.length, 3);
  assert.equal(f.runtime.apiState('p').status, 'ready');
  assert.equal('reserve' in f.runtime.usage, false); assert.equal('available' in f.runtime.usage, false);
  assert.equal(sessions.every(session => session.snapshot().state === 'idle'), true);
});

test('an old settings file with monthlyBudgetUsd and an old ledger with reservations load cleanly and lose them on the next write', async t => {
  const f = fixture(t), settingsFile = path.join(f.directory, 'legacy-settings.json'), usageFile = path.join(f.directory, 'legacy-usage.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ claudePath: 'api-only', monthlyBudgetUsd: 0, codexAutoReset: false }));
  const { createSettings } = require('../electron/features/native-session/settings.cjs');
  const settings = createSettings(settingsFile); assert.equal(Object.hasOwn(settings.get(), 'monthlyBudgetUsd'), false);
  settings.set({ codexAutoReset: true }); assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(settingsFile)), 'monthlyBudgetUsd'), false);
  fs.writeFileSync(usageFile, JSON.stringify({ version: 1, days: {}, sessions: {}, reservations: { old: { micros: 10000000 } }, estimates: { old: {} } }));
  const usage = require('../electron/features/claude-sdk/usage.cjs').createUsage({ file: usageFile });
  usage.record('observed', { uuid: 'one', total_cost_usd: 3 });
  const saved = JSON.parse(fs.readFileSync(usageFile));
  assert.equal(Object.hasOwn(saved, 'reservations'), false); assert.equal(Object.hasOwn(saved, 'estimates'), false);
  assert.equal(usage.summary().monthUsdMicros, 3000000);
});

test('a budget option in any spelling appears nowhere in electron/, src/, integration/ or scripts/ code, shell and batch files included', () => {
  for (const options of [{ extraArgs: { 'max-budget-usd': '1' } }, { maxBudgetUsd: 1 }, { extraArgs: { max_budget_usd: '1' } }]) assert.match(JSON.stringify(options), BUDGET);
  for (const name of ['launch.ps1', 'launch.sh', 'launch.zsh', 'launch.cmd', 'launch.mjs', 'launch.bat']) assert.match(name, CODE, name);
  const root = path.join(__dirname, '..');
  const matches = codeFiles().filter(file => BUDGET.test(fs.readFileSync(file, 'utf8')) || /monthlyBudgetUsd/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(matches.map(file => path.relative(root, file)), []);
});

// B1 item 7: spend is information only. Today's and the month's spend are shown and never compared against a limit.
test('no code path compares spend against a limit', () => {
  const spend = String.raw`\b(?:todayUsdMicros|monthUsdMicros|spentMicros)\b`;
  const compared = new RegExp(String.raw`${spend}[\s)\]?]*[<>]=?(?!>)|(?<![=-])[<>]=?\s*[\w.?()[\]]*${spend}|Math\.(?:min|max)\([^)]*${spend}`);
  for (const line of ['if (summary.monthUsdMicros >= limit) stop();', 'if (cap > usage.todayUsdMicros) go();', 'Math.min(month.spentMicros, cap)']) assert.match(line, compared, line);
  for (const line of ['const month = { spentMicros: count(summary.monthUsdMicros) };', "note={money(usage.todayUsdMicros)}", 'todayUsdMicros => show(todayUsdMicros)']) assert.doesNotMatch(line, compared, line);
  const root = path.join(__dirname, '..');
  const found = codeFiles().flatMap(file => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => compared.test(line)).map(line => `${path.relative(root, file)}: ${line.trim()}`));
  assert.deepEqual(found, []);
});

test('a ledger write failure retains observed spend in memory and retries on the next change', t => {
  const f = fixture(t), file = path.join(f.directory, 'blocked-usage.json'), warnings = [];
  const usage = require('../electron/features/claude-sdk/usage.cjs').createUsage({ file, warn: text => warnings.push(text) });
  fs.mkdirSync(file);
  usage.record('one', { uuid: 'first', total_cost_usd: 1 });
  assert.equal(usage.summary().monthUsdMicros, 1000000); assert.equal(warnings.length, 1);
  fs.rmdirSync(file);
  usage.record('one', { uuid: 'second', total_cost_usd: 2 });
  assert.equal(usage.summary().monthUsdMicros, 2000000);
  assert.equal(JSON.parse(fs.readFileSync(file)).sessions.one.cost, 2000000);
});

test('spend above former limits is information and cannot block another session', { timeout: 15000 * timeoutScale }, async t => {
  const f = fixture(t);
  f.runtime.usage.record('other', { uuid: 'large-spend', total_cost_usd: 1000000 });
  const session = f.create(); await session.start(); await f.send(session);
  assert.equal(f.runtime.apiState('p').status, 'ready');
  assert.equal(f.fake.calls.length, 1); assert.equal(Object.hasOwn(f.fake.calls[0].options, 'maxBudgetUsd'), false);
  assert.equal(f.runtime.usage.summary().monthUsdMicros, 1000000100000);
});

test('unknown observed cost stays unknown without reserving anything', t => {
  const f = fixture(t), usage = f.runtime.usage;
  usage.record('unknown', { uuid: 'no-cost', modelUsage: {} });
  assert.equal(usage.summary().monthUsdMicros, null);
  assert.equal(f.runtime.apiState('p').status, 'ready');
});
