const { createWindowHost } = require('../electron/app/window-host.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { claudeBackgroundEnvironment } = require('../electron/shared/claude-background.cjs');
const { registerClaudeWorker } = require('../electron/features/native-session/worker.cjs');
const { writeBootstrap, updateBootstrapBackground, updateBootstrapLead, removeBootstrap } = require('../electron/features/terminal-events/bootstrap-file.cjs');
const { shimWords } = require('../integration/shims/intercept.cjs');
const { createNativeHost } = require('../electron/features/native-session/host.cjs');
const root = path.join(__dirname, '..'), variable = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS';
function temporary(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-nobg-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}
function moduleWith(file, replacements, tail = '') {
  const filename = path.join(root, file), native = createRequire(filename), module = { exports: {} };
  const context = { module, exports: module.exports, require: name => replacements[name] || native(name), __filename: filename,
    __dirname: path.dirname(filename), process, Buffer, AbortController, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\n' + tail, context);
  return module.exports;
}

test('main registration applies the current background choice to each SDK worker', async () => {
  let handler, captured, callback;
  const settings = { claudeBackgroundTasks: false }, source = { [variable]: 'inherited', claude_code_disable_background_tasks: '1' };
  const runtime = { start: async () => {}, close: async () => {}, send: async () => {
    callback({ type: 'turn.completed', payload: { status: 'completed' } });
    callback({ type: 'session.state', payload: { state: 'idle' } });
  } };
  const context = { registerClaudeWorker, claudeBackgroundEnvironment, withoutAppImage: env => env, process: { env: source },
    store: { settings }, dispatchControl: { onRequest: (name, value) => { handler = value; } }, workerTerminals: null,
    createNativeSessions: () => ({ getSettings: () => ({ claudePath: 'api-only' }) }),
    claudeRuntime: { apiState: () => ({ status: 'ready' }), create: (spec, onEvent) => { captured = spec; callback = onEvent; return runtime; } } };
  createNativeHost(context).wireNativeSessions();
  for (const allow of [false, true, false, undefined]) {
    context.store.settings = allow === undefined ? undefined : { claudeBackgroundTasks: allow };
    await handler({ runId: 'fixture', cwd: root, projectId: 'fixture', leadMode: 'native' }, { prompt: 'fixture' },
      { emit() {}, onControl: () => () => {} });
    assert.equal(captured.env[variable], allow ? undefined : '1');
    assert.equal(captured.env.claude_code_disable_background_tasks, undefined);
  }
  assert.equal(source[variable], 'inherited');
});

test('open terminals read a refreshed bootstrap at every Claude start in both directions', async t => {
  const folder = temporary(t), file = path.join(folder, 'session.json');
  writeBootstrap({ file, eventServer: { name: 'fixture', address: 'fixture' }, sessionKey: 'fixture', claudeBackgroundTasks: false });
  const source = { AGENTRIX_BOOTSTRAP: file, PATH: '', [variable]: 'old', claude_code_disable_background_tasks: 'old' };
  for (const allow of [false, true, false]) {
    await updateBootstrapBackground(file, allow);
    const env = { ...source }, words = shimWords(env, { depth: 0 });
    for (let i = 0; i < words.length; i++) {
      if (words[i] === '-u') delete env[words[++i]];
      else { const split = words[i].indexOf('='); env[words[i].slice(0, split)] = words[i].slice(split + 1); }
    }
    assert.equal(env[variable], allow ? undefined : '1');
    assert.equal(env.claude_code_disable_background_tasks, undefined);
    assert.equal(JSON.parse(fs.readFileSync(file)).sessionKey, 'fixture');
  }
  removeBootstrap(file);
});

test('bootstrap refresh retries busy renames and leaves fresh launch policy after exhaustion', async t => {
  const folder = temporary(t), file = path.join(folder, 'session.json'), delays = [];
  writeBootstrap({ file, eventServer: { name: 'fixture', address: 'fixture' }, claudeBackgroundTasks: false });
  let attempts = 0;
  await updateBootstrapBackground(file, true, { rename: (from, to) => {
    if (++attempts < 4) throw Object.assign(new Error('busy'), { code: ['EPERM', 'EACCES', 'EBUSY'][attempts - 1] });
    fs.renameSync(from, to);
  }, delay: async ms => { delays.push(ms); } });
  assert.deepEqual(delays, [25, 50, 100]);
  await assert.rejects(updateBootstrapBackground(file, false, { rename: (from, to) => {
    if (to === file) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    fs.renameSync(from, to);
  },
    delay: async () => {} }), /busy/);
  assert.equal(JSON.parse(fs.readFileSync(file)).claudeBackgroundTasks, true, 'bootstrap remains old after the locked rename');
  const words = shimWords({ AGENTRIX_BOOTSTRAP: file, PATH: '' }, { depth: 0 });
  assert.ok(words.includes(variable + '=1'), 'next launch re-reads the latest policy despite the old bootstrap');
});

test('background policy readers see the old whole file through retries and concurrent updates publish in order', async t => {
  const folder = temporary(t), file = path.join(folder, 'session.json'), policy = file + '.background.json';
  writeBootstrap({ file, eventServer: { name: 'fixture', address: 'fixture' }, sessionKey: 'fixture' });
  await updateBootstrapBackground(file, false);
  const blocked = Promise.withResolvers(), release = Promise.withResolvers(), seen = [];
  const first = updateBootstrapBackground(file, true, { rename: (from, to) => {
    if (to === policy) {
      seen.push(JSON.parse(fs.readFileSync(policy)).claudeBackgroundTasks);
      if (seen.length === 1) { blocked.resolve(); throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }
      assert.equal(JSON.parse(fs.readFileSync(from)).claudeBackgroundTasks, true);
    }
    fs.renameSync(from, to);
  }, delay: () => release.promise });
  await blocked.promise;
  const next = updateBootstrapBackground(file, false);
  release.resolve();
  await Promise.all([first, next]);
  assert.deepEqual(seen, [false, false]);
  assert.equal(JSON.parse(fs.readFileSync(policy)).claudeBackgroundTasks, false);
  assert.equal(JSON.parse(fs.readFileSync(file)).claudeBackgroundTasks, false);
});

test('a new lead is present in the versioned sidecar before the legacy file changes', t => {
  const folder = temporary(t), file = path.join(folder, 'session.json'), observed = [];
  updateBootstrapLead(file, { model: 'opus', effort: 'high' });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    observed.push({ target: path.extname(to), versioned: fs.readFileSync(file + '.lead.env', 'utf8'), legacy: fs.readFileSync(file + '.lead', 'utf8') });
  });
  updateBootstrapLead(file, { model: 'sonnet', effort: 'low' });
  assert.deepEqual(observed.map(value => value.target), ['.env', '.lead']);
  assert.equal(observed[0].versioned.split('\n').find(row => row.startsWith('model=')), 'model=sonnet');
  assert.equal(observed[0].legacy.split('\n')[0], 'opus');
  assert.equal(observed[1].legacy.split('\n')[0], 'sonnet');
});

test('Settings changes refresh existing local and SSH terminal launch policy', () => {
  const settings = { theme: 'dark', uiZoom: 100, language: 'en', shortcuts: [], claudeBackgroundTasks: false };
  const refreshed = [], remote = { setBackgroundTasks: allow => { refreshed.push(['ssh', allow]); return Promise.resolve(); } };
  const context = { store: { settings, updateSettings: patch => Object.assign(settings, patch) },
    sessions: new Map([['local', { bootstrapFile: 'fixture' }], ['ssh', { terminal: remote }]]),
    updateBootstrapBackground: (file, allow) => refreshed.push([file, allow]), RemoteConnection: Object,
    process: { platform: 'win32' }, report: error => { throw error; } };
  Object.assign(context, createWindowHost(context));
  context.updateStoreSettings({ claudeBackgroundTasks: true });
  context.updateStoreSettings({ claudeBackgroundTasks: false });
  assert.deepEqual(refreshed, [['fixture', true], ['ssh', true], ['fixture', false], ['ssh', false]]);
});

test('a failed bootstrap refresh is reported without unused session flags', async () => {
  const settings = { theme: 'dark', uiZoom: 100, language: 'en', shortcuts: [], claudeBackgroundTasks: false };
  const session = { bootstrapFile: 'fixture' }, reports = [], failure = new Error('synthetic lock');
  let update;
  const context = { store: { settings, updateSettings: patch => Object.assign(settings, patch) }, sessions: new Map([['fixture', session]]),
    updateBootstrapBackground: () => { update = Promise.reject(failure); return update; }, RemoteConnection: Object, process: { platform: 'win32' }, report: error => reports.push(error) };
  Object.assign(context, createWindowHost(context));
  context.updateStoreSettings({ claudeBackgroundTasks: true });
  await assert.rejects(update, /synthetic lock/);
  assert.equal(Object.hasOwn(session, 'backgroundPolicyPending'), false);
  assert.equal(Object.hasOwn(session, 'backgroundPolicyUpdate'), false);
  assert.deepEqual(reports, [failure]);
});

test('terminal worker environments override the saved parent choice', t => {
  const folder = temporary(t);
  const { workerEnvironment } = moduleWith('electron/features/worker-terminals/worker-terminals.cjs', {},
    'module.exports.workerEnvironment = workerEnvironment;');
  const parent = Object.freeze({ PATH: '', [variable]: 'old', claude_code_disable_background_tasks: 'old' });
  for (const allow of [false, true, false]) {
    const env = workerEnvironment(parent, { shims: path.join(root, 'integration/shims'), runId: 'fixture', sessionKey: 'fixture',
      claudeEnvFile: path.join(folder, 'hook.sh'), allowBackgroundTasks: allow });
    assert.equal(env[variable], allow ? undefined : '1');
    assert.equal(env.claude_code_disable_background_tasks, undefined);
  }
});

test('native context advertises background fork only when the launch allows it', t => {
  const { queryOptions } = moduleWith('electron/features/claude-sdk/query.cjs', {
    './routing.cjs': { routeSettings: () => ({}) }, './credentials.cjs': { apiEnvironment: env => env } });
  for (const allow of [false, true]) {
    const abort = new AbortController();
    const options = queryOptions({ owner: 'gui', cwd: temporary(t), env: claudeBackgroundEnvironment({}, allow) },
      { key: 'fixture', abort, policy() {} });
    assert.equal(options.systemPrompt.append.includes('fork subagent runs in the background'), allow);
    abort.abort();
  }
});

module.exports = { moduleWith };
