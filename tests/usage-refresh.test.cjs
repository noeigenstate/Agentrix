const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { UsageMeter, claudeAccount, selectClaudeAccount } = require('../electron/features/agents/agent-usage.cjs');
const { CodexActivityReader, monitorActivity } = require('../electron/codex-activity.cjs');
const { CodexAccountUsage, accountResult } = require('../electron/features/agents/codex-account-usage.cjs');
const { ClaudeAccountUsage, readClaudeAccount } = require('../electron/features/agents/claude-account-usage.cjs');
const { promptText } = require('../electron/prompt-queue.cjs');

const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const section = (from, to) => main.slice(main.indexOf(from), main.indexOf(to));
const accounts = section('let claudeAccountTimer =', '// Restores and the reading-view picker');
const claudeService = section('const claudeAccounts = new', 'const { agentCommand }');
const notes = section('function noteSettings(', '// A skill step names the skill;');
const historyUsage = section('function usageHistory(', '// What the activity pane shows');
const lifecycle = section('function startUsage(', 'let claudeAccountTimer =');
const hooks = section('function claudeActivity(', 'function onEvent(');
const events = section('function onEvent(', '// The agent chosen on a new project');
const state = section('function publicState(', 'function terminalIds(');
const histories = [...main.matchAll(/const onHistory = ready => \{[\s\S]*?\r?\n    \};/g)].map(match => match[0]);
const flush = () => new Promise(resolve => setImmediate(resolve));
const account = (at = 1000, percent = 12, resetsAt = null) => ({ limits: [{ minutes: 300, percent, resetsAt }], at, source: 'Claude Code' });
const session = (terminalId, agent = 'claude', projectId = 'local') => ({
  terminalId, projectId, codexActive: true, agent, usage: new UsageMeter(agent),
  promptQueue: { list: () => [], finish() {} },
});

function watcherFs(existsSync = () => true) {
  const watchers = [];
  return { watchers, fs: { existsSync, watch(folder, options, callback) {
    const watcher = { folder, options, callback, closed: false, unreffed: false, close() { this.closed = true; }, unref() { this.unreffed = true; }, on(_event, listener) { this.error = listener; } };
    watchers.push(watcher); return watcher;
  } } };
}

function runtime(overrides = {}) {
  const sessions = overrides.sessions || new Map([['one', session('one')]]);
  const terminalIds = project => {
    const ids = [...sessions.values()].filter(s => s.projectId === project.id).map(s => s.terminalId);
    return ids.length ? ids : [project.id];
  };
  const context = vm.createContext({
    UsageMeter, promptText, sessions, process, path, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    fs: watcherFs().fs, quitting: false, scheduleState() {},
    store: { projects: [{ id: 'local', kind: 'local' }, { id: 'remote', kind: 'ssh' }], settings: {}, expectCompletion: () => assert.fail('background usage must not rearm completion'), setRestore() {} },
    claudeAccountFiles: () => [path.join(os.tmpdir(), 'usage-cache', '.claude.json'), path.join(os.tmpdir(), 'usage-cache', '.codepulse', 'claude-quota.json')],
    claudeAccount: async () => account(), agentSettings: previous => previous,
    ClaudeAccountUsage, readClaudeAccount: async () => ({ state: 'skipped', reason: 'fixture' }),
    electronNet: { fetch: () => assert.fail('unexpected Chromium fetch') },
    codexProvider: async () => id => id, claudeProvider: async () => 'Anthropic', claudeConfigDir: () => '',
    followClaude() {}, applyActivity() {}, broadcast() {}, startSkillSession() {}, endSkillSession() {}, isLocalAgentCommand: (_agent, text) => text.startsWith('/'),
    terminalIds, shownTerminalIds: terminalIds,
    localShell: () => ({ kind: 'pwsh' }), t: value => value, getBranch: () => '', startupErrors: new Map(),
    desktopGlassBackend: null, desktopGlassActive: false, desktopGlassWindow: false, windowZoom: null, app: { getVersion: () => 'test' },
    ...overrides,
  });
  // Run the real main-process functions without requiring Electron or creating a terminal.
  const api = vm.runInContext(`${claudeService}\n${accounts}\n${notes}\n${historyUsage}\n${lifecycle}\n${hooks}\n${events}\n${state}\n({
    refreshClaudeAccounts, startUsage, stopUsageAccount, disposeClaudeAccounts, scheduleUsageRollover, noteSettings, usageHistory, claudeActivity, onEvent, publicState,
    claudeAccounts,
    resources: () => ({ claudeAccountTimer, claudeAccountSoon, claudeAccountPending, claudeAccountWatchers, usageRolloverTimer, usageRolloverAt })
  })`, context);
  api.history = (s, agent) => vm.runInContext(`s => { ${histories[agent === 'claude' ? 0 : 1]}; return onHistory; }`, context)(s);
  api.close = () => { context.quitting = true; api.disposeClaudeAccounts(); api.scheduleUsageRollover(); };
  return api;
}

const fixtures = path.join(__dirname, 'fixtures/usage-refresh');

test('an open Codex rollout pushes new and out-of-order limit records without any lifecycle change', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-rollout-'));
  fs.mkdirSync(path.join(root, 'sessions'));
  const records = fs.readFileSync(path.join(fixtures, 'codex.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  records[0].payload.cwd = root;
  const file = path.join(root, 'sessions', `rollout-${records[0].payload.id}.jsonl`);
  const line = record => JSON.stringify(record) + '\n';
  fs.writeFileSync(file, records.slice(0, 3).map(line).join(''));
  const s = session('one', 'codex'); let updated, states = 0;
  const api = runtime({ sessions: new Map([['one', s]]), scheduleState() { ++states; updated?.(); } });
  const shown = () => api.publicState().projects[0].terminals[0].agentUsage;
  const reader = new CodexActivityReader(root, root, 0, {
    onRecord: record => api.noteSettings(s, 'codex', record), onHistory: ready => api.usageHistory(s, ready),
  });
  let activityChanges = 0;
  const monitor = monitorActivity(() => reader.read(), () => ++activityChanges, { interval: 1000, watch: () => reader.filename });
  const writer = await fs.promises.open(file, 'a');
  t.after(async () => { monitor.stop(); await writer.close(); api.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await monitor.poll();
  assert.equal(shown().limits[0].percent, 1);
  const activityBefore = activityChanges, stateBefore = states;
  const pushed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('new rollout limits did not reach public state within 2.5 seconds')), 2500);
    updated = () => { if (shown().limits[0].percent === 2) { clearTimeout(timer); resolve(); } };
  });
  await writer.write(line(records[3])); await pushed;
  assert.equal(shown().limitsAt, Date.parse(records[3].timestamp));
  assert.ok(states > stateBefore, 'usage schedules its own IPC state push');
  assert.equal(activityChanges, activityBefore, 'an unchanged turn snapshot never drops a usage update');
  await writer.write(line(records[2])); await monitor.poll();
  assert.equal(shown().limits[0].percent, 2);
  assert.equal(shown().limitsAt, Date.parse(records[3].timestamp));
});

test('Claude watches cache/statusline fixtures promptly and retains a slower fallback for missed events', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1793176219000 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-claude-'));
  const own = path.join(root, '.claude.json'), pulse = path.join(root, 'claude-quota.json');
  fs.copyFileSync(path.join(fixtures, 'claude.json'), own);
  const s = session('one'); let publishes = 0;
  const watched = watcherFs();
  const api = runtime({ sessions: new Map([['one', s]]), claudeAccountFiles: () => [own, pulse],
    fs: watched.fs, claudeAccount: () => claudeAccount(own, pulse), scheduleState: () => ++publishes });
  t.after(() => { api.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await api.refreshClaudeAccounts();
  assert.equal(s.usage.snapshot().limitsFrom, 'Claude Code');
  fs.copyFileSync(path.join(fixtures, 'codepulse.json'), pulse);
  t.mock.timers.tick(2000);
  assert.equal(api.resources().claudeAccountPending, null, 'idle accounts do not reread the full files every two seconds');
  watched.watchers[0].callback('rename', path.basename(pulse));
  t.mock.timers.tick(25);
  await api.resources().claudeAccountPending;
  const shown = api.publicState().projects[0].terminals[0].agentUsage;
  assert.deepEqual([...shown.limits].map(limit => limit.percent), [33, 22]);
  assert.equal(shown.limitsFrom, 'CodePulse'); assert.equal(shown.limitsAt, 1793176218563);
  assert.equal(publishes, 2);
  fs.unlinkSync(pulse); // A transient replacement must not let the older Claude cache win.
  t.mock.timers.tick(27975); await api.resources().claudeAccountPending;
  assert.equal(s.usage.snapshot().limitsAt, shown.limitsAt); assert.equal(publishes, 2);
});

test('rollout limits publish during history without exposing partial conversation totals', t => {
  const s = session('one', 'codex'); let publishes = 0;
  const api = runtime({ sessions: new Map([['one', s]]), scheduleState: () => ++publishes });
  t.after(() => api.close());
  api.usageHistory(s, false);
  const records = fs.readFileSync(path.join(fixtures, 'codex.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const record of records.slice(2)) api.noteSettings(s, 'codex', { ...record, payload: {
    ...record.payload, info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } },
  } });
  const shown = api.publicState().projects[0].terminals[0].agentUsage;
  assert.equal(shown.total, null);
  assert.equal(shown.limits[0].percent, 2);
  assert.equal(publishes, 2);
  assert.equal(api.resources().usageRolloverAt, 1793774184000);
});

test('new account limits reach the pane during slow history while conversation totals stay held', async t => {
  for (const agent of ['codex', 'claude']) {
    const s = session('one', agent); let publishes = 0;
    const at = 2000;
    const service = new CodexAccountUsage({ scope: async () => null, read: async () => accountResult({
      rateLimits: { primary: { usedPercent: 33, windowDurationMins: 300, resetsAt: 300 } },
    }, at) });
    const api = runtime({ sessions: new Map([['one', s]]), codexAccounts: service,
      scheduleState: () => ++publishes, claudeAccount: async () => account(at, 33, 300000) });
    t.after(() => { api.close(); service.dispose(); });
    // Exercise the production account callback as well as public-state serialization.
    api.startUsage({ kind: 'local', path: os.tmpdir() }, s, { accountLaunch: 'model-only-v1', codexHome: path.join(os.tmpdir(), 'fake-usage-home') });
    if (agent === 'codex') {
      s.usage.providerId = 'openai'; s.usage.scopeCwd = os.tmpdir(); s.bindUsageAccount();
    }
    api.usageHistory(s, false);
    s.usage.total = { input: 100, cached: 0, output: 10 };
    await api.refreshClaudeAccounts(); await flush();
    const shown = api.publicState().projects[0].terminals[0].agentUsage;
    assert.equal(shown.total, null);
    assert.equal(shown.limitsAt, at); assert.equal(shown.limits[0].percent, 33);
    assert.ok(publishes > 0);
  }
});

test('one Claude account read updates every local meter and publishes once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  const sessions = new Map(['first', 'middle', 'last'].map(terminalId => [terminalId, {
    terminalId, projectId: 'local', codexActive: true, agent: 'claude', usage: new UsageMeter('claude'),
  }]));
  sessions.set('remote', { projectId: 'remote', codexActive: true, agent: 'claude', usage: new UsageMeter('claude') });
  let at = 1000, reads = 0, publishes = 0;
  const api = runtime({
    sessions, scheduleState: () => ++publishes,
    claudeAccount: async () => { ++reads; return account(at); },
  });
  t.after(() => api.close());
  for (at of [1000, 2000, 3000]) {
    if (at === 2000) sessions.get('first').usage.account(account(at));
    await api.refreshClaudeAccounts();
    assert.deepEqual([...sessions.values()].slice(0, 3).map(s => s.usage.limitsAt), [at, at, at]);
  }
  assert.equal(reads, 3); assert.equal(publishes, 3);
  await api.refreshClaudeAccounts();
  assert.equal(publishes, 3, 'unchanged displayed values do not publish');
  assert.equal(sessions.get('remote').usage.limitsAt, null);
});

test('the real Claude poller uses Chromium fetch, publishes sanitized limits without rearming completion, excludes SSH and stops with the last local terminal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000000 });
  const root = path.join(__dirname, '../.test-output/claude-account-usage-20261028/main-fake-home');
  const sessions = new Map([['remote', session('remote', 'claude', 'remote')], ['codex', session('codex', 'codex')],
    ['inactive', { ...session('inactive'), codexActive: false }], ['stale', { ...session('stale'), agent: 'codex' }]]);
  const fakeToken = 'fake-wiring-token-never-publish';
  let requests = 0, publishes = 0, signal, release;
  const api = runtime({ sessions, scheduleState: () => ++publishes,
    claudeAccount: async (_file, _pulse, direct) => selectClaudeAccount(null, account(1000010, 3), direct),
    readClaudeAccount: options => {
      assert.equal(options.routes.length, 1);
      assert.equal(typeof options.fetch, 'function', 'production must inject Chromium fetch before any request is possible');
      return readClaudeAccount({ ...options, env: {}, home: root, platform: 'linux',
      async readFile(file) {
        assert.ok(file.startsWith(root), 'all credential/settings reads use fake paths');
        if (file === path.join(root, '.claude', '.credentials.json')) return JSON.stringify({ claudeAiOauth: {
          accessToken: fakeToken, scopes: ['user:profile', 'user:inference'], expiresAt: 9999999999999,
        } });
        throw Object.assign(new Error(fakeToken), { code: 'ENOENT' });
      } });
    },
    electronNet: { async fetch(_url, init) {
        ++requests; signal = init.signal;
        assert.equal(init.headers.Authorization, `Bearer ${fakeToken}`);
        if (requests === 2) return new Promise(resolve => { release = resolve; });
        return { status: 200, json: async () => ({ five_hour: { utilization: 24, resets_at: '1970-01-01T01:00:00Z' }, private: fakeToken }) };
    } },
  });
  t.after(() => api.close());
  await api.refreshClaudeAccounts();
  t.mock.timers.tick(60000); await flush(); assert.equal(requests, 0);
  const s = session('one'); s.usageEnv = {}; s.usageCwd = path.join(root, 'project'); sessions.set('one', s);
  await api.refreshClaudeAccounts();
  t.mock.timers.tick(249); await flush(); assert.equal(requests, 0);
  t.mock.timers.tick(1); await flush(); assert.equal(requests, 1);
  t.mock.timers.tick(25); await api.resources().claudeAccountPending;
  const shown = api.publicState().projects[0].terminals.find(item => item.id === 'one').agentUsage;
  assert.equal(shown.limitsFrom, 'Claude'); assert.equal(shown.limits[0].percent, 24);
  assert.equal(sessions.get('remote').usage.limitsAt, null); assert.equal(sessions.get('inactive').usage.limitsAt, null);
  assert.doesNotMatch(JSON.stringify(api.publicState()), /fake-wiring-token|Authorization|Bearer/);
  assert.ok(publishes > 0);
  const event = { state: 'complete', sessionId: 'one-session', eventId: 'one-stop' };
  api.claudeActivity({ id: 'local', kind: 'local' }, s, event); await flush();
  t.mock.timers.tick(59975); await flush(); assert.equal(requests, 2);
  api.stopUsageAccount(s); s.codexActive = false;
  assert.equal(signal.aborted, true); assert.equal(api.claudeAccounts.active, false);
  const before = publishes;
  release({ status: 200, json: async () => ({ five_hour: { utilization: 99 } }) }); await flush();
  t.mock.timers.tick(120000); await flush();
  assert.equal(requests, 2); assert.equal(publishes, before); assert.equal(s.usage.limits[0].percent, 24);
});

test('a slow pre-query fallback read compares against the current direct observation when it finally publishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000000 });
  const s = session('one'), pulse = { ...account(1100000, 2), source: 'CodePulse' };
  s.usage.account(pulse);
  let release, first = true;
  const api = runtime({ sessions: new Map([['one', s]]),
    claudeAccount: async (_file, _pulse, direct) => {
      if (!first) return selectClaudeAccount(null, pulse, direct);
      first = false; assert.equal(direct, null);
      return new Promise(resolve => { release = resolve; });
    },
    readClaudeAccount: async () => ({ state: 'ready', status: 200, account: { ...account(Date.now(), 24), source: 'Claude' } }),
  });
  t.after(() => api.close());
  const pending = api.refreshClaudeAccounts(); await flush();
  t.mock.timers.tick(250); await flush();
  assert.equal(api.claudeAccounts.account.source, 'Claude');
  release(pulse); await pending;
  assert.deepEqual([s.usage.limitsAt, s.usage.limitsFrom, s.usage.limits[0].percent], [1000250, 'Claude', 24]);
});

test('shared Claude folder watchers coalesce atomic-replace bursts and release with the last local terminal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  const watched = watcherFs(), sessions = new Map(['one', 'two', 'three'].map(id => [id, session(id)]));
  sessions.set('remote', session('remote', 'claude', 'remote'));
  let reads = 0;
  const api = runtime({ sessions, fs: watched.fs, claudeAccount: async () => account(++reads * 1000) });
  t.after(() => api.close());
  await api.refreshClaudeAccounts();
  assert.equal(watched.watchers.length, 2);
  assert.ok(watched.watchers.every(watcher => watcher.options.persistent === false && watcher.unreffed));
  const [own, pulse] = watched.watchers;
  own.callback('rename', '.claude.json'); own.callback('change', Buffer.from('.claude.json'));
  pulse.callback('rename', 'quota.tmp'); pulse.callback('rename', 'claude-quota.json');
  t.mock.timers.tick(24); await flush(); assert.equal(reads, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(reads, 2);
  assert.equal(watched.watchers.length, 2, 'cards share the same watchers');
  assert.deepEqual(['one', 'two', 'three'].map(id => sessions.get(id).usage.limitsAt), [2000, 2000, 2000]);
  pulse.callback('rename', 'claude-quota.json'); pulse.callback('change', 'claude-quota.json');
  t.mock.timers.tick(25); await flush(); assert.equal(reads, 3, 'a replacement does not detach the watcher');
  for (const id of ['one', 'two']) { api.stopUsageAccount(sessions.get(id)); sessions.get(id).codexActive = false; }
  assert.ok(watched.watchers.every(watcher => !watcher.closed));
  own.callback('change', '.claude.json');
  api.stopUsageAccount(sessions.get('three')); sessions.get('three').codexActive = false;
  assert.ok(watched.watchers.every(watcher => watcher.closed));
  assert.equal(api.resources().claudeAccountTimer, null);
  assert.equal(api.resources().claudeAccountSoon, null);
  own.callback('rename', '.claude.json');
  assert.equal(api.resources().claudeAccountSoon, null, 'a queued event from a closed watcher stays inert');
  t.mock.timers.tick(60000); await flush(); assert.equal(reads, 3);
});

test('a missing CodePulse folder is followed from its parent and watcher errors recover on the fallback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  let exists = false, reads = 0;
  const watched = watcherFs(folder => !folder.endsWith('.codepulse') || exists);
  const api = runtime({ fs: watched.fs, claudeAccount: async () => { ++reads; return account(); } });
  t.after(() => api.close());
  await api.refreshClaudeAccounts(); assert.equal(watched.watchers.length, 1);
  exists = true; watched.watchers[0].callback('rename', '.codepulse');
  t.mock.timers.tick(25); await flush(); assert.equal(watched.watchers.length, 2);
  const pulse = watched.watchers[1]; pulse.error(new Error('watch unavailable'));
  assert.equal(pulse.closed, true);
  t.mock.timers.tick(29975); await flush();
  assert.equal(reads, 3); assert.equal(watched.watchers.length, 3);
});

test('real folder watchers read once per atomic file replacement and remain attached', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-watch-'));
  const file = path.join(root, '.claude.json');
  fs.writeFileSync(file, JSON.stringify(account()));
  let reads = 0, changed;
  const api = runtime({ fs, claudeAccountFiles: () => [file], claudeAccount: async () => {
    ++reads; const value = JSON.parse(await fs.promises.readFile(file, 'utf8')); changed?.(); return value;
  } });
  t.after(() => { api.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await api.refreshClaudeAccounts();
  assert.equal(api.resources().claudeAccountTimer.hasRef(), false);
  assert.equal(api.resources().claudeAccountWatchers.size, 1);
  for (const at of [2000, 3000]) {
    const notified = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('watcher did not read replacement')), 2000);
      changed = () => { clearTimeout(timer); resolve(); };
    });
    const replacement = path.join(root, 'atomic.tmp');
    fs.writeFileSync(replacement, JSON.stringify(account(at)));
    fs.renameSync(replacement, file);
    await notified; await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(reads, at / 1000);
  }
});

test('Claude coalesces reads in flight and drops a cache read after its last session stops', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  const pending = [], s = session('one'), sessions = new Map([['one', s]]);
  const api = runtime({ sessions, claudeAccount: () => new Promise(resolve => pending.push(resolve)) });
  t.after(() => api.close());
  const first = api.refreshClaudeAccounts(); await flush();
  void api.refreshClaudeAccounts(); void api.refreshClaudeAccounts(); await flush(); assert.equal(pending.length, 1);
  pending[0](account()); await first;
  t.mock.timers.tick(25); await flush(); assert.equal(pending.length, 2);
  api.stopUsageAccount(s); s.codexActive = false;
  pending[1](account(2000, 80)); await flush();
  assert.equal(s.usage.limitsAt, 1000);
  assert.equal(api.resources().claudeAccountPending, null);
});

test('each Claude prompt and Stop hook re-reads the cache, including local commands, without using a remote account', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  let reads = 0, completions = 0;
  const s = session('one'), api = runtime({ sessions: new Map([['one', s]]), claudeAccount: async () => { ++reads; return account(); },
    store: { projects: [{ id: 'local', kind: 'local' }], expectCompletion: () => ++completions, setRestore() {} } });
  t.after(() => api.close());
  await api.refreshClaudeAccounts();
  const hook = (state, eventId, prompt) => ({ state, eventId, sessionId: 'sid', prompt });
  for (const event of [hook('working', 'sid:1', '/usage'), hook('complete', 'sid:2'), hook('working', 'sid:3', 'Fix it'), hook('complete', 'sid:4')]) {
    api.claudeActivity({ id: 'local', kind: 'local' }, s, event); await flush();
  }
  assert.equal(reads, 5); assert.equal(completions, 1, 'only the real prompt rearms completion');
  api.claudeActivity({ id: 'remote', kind: 'ssh' }, s, hook('working', 'sid:5', '/usage')); await flush();
  assert.equal(reads, 5);
});

test('Codex records and parent turn notifications actively refresh; history and child notifications do not', () => {
  const s = session('one', 'codex'), refreshes = []; let polls = 0;
  s.sessionKey = 'key'; s.rootThreadId = 'parent';
  s.usageAccount = { refresh: age => refreshes.push(age) };
  s.activityMonitor = { poll: () => ++polls };
  const api = runtime({ sessions: new Map([['one', s]]) });
  const record = type => ({ type: 'event_msg', payload: { type } });
  api.noteSettings(s, 'codex', record('token_count'));
  api.noteSettings(s, 'codex', record('task_complete'));
  api.noteSettings(s, 'codex', record('turn_completed'));
  api.noteSettings(s, 'codex', record('turn_aborted'));
  const notify = threadId => api.onEvent({ projectId: 'one', sessionKey: 'key', type: 'turn-complete', threadId });
  notify('child'); notify('parent');
  assert.deepEqual(refreshes, [30000, undefined, undefined, undefined]); assert.equal(polls, 1);
  s.usageHistory = s.usage.snapshot();
  api.noteSettings(s, 'codex', record('token_count')); api.noteSettings(s, 'codex', record('task_complete'));
  assert.equal(refreshes.length, 4);
  api.close();
});

test('slow history never publishes intermediate totals and releases only its final usage, for both agents', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  for (const agent of ['codex', 'claude']) {
    const s = session('one', agent); let begins = 0, ends = 0, actionResets = 0, conversationResets = 0, publishes = 0;
    s.conversation = { beginHistory: () => ++begins, endHistory: () => ++ends, reset: () => ++conversationResets };
    s.actions = { reset: () => ++actionResets };
    const api = runtime({ sessions: new Map([['one', s]]), scheduleState: () => ++publishes,
      store: { projects: [{ id: 'local', kind: 'local' }], settings: {}, expectCompletion: () => assert.fail('history usage must not rearm completion') } });
    const history = api.history(s, agent);
    const shown = () => api.publicState().projects[0].terminals[0].agentUsage;
    const record = output => agent === 'codex'
      ? { type: 'event_msg', timestamp: new Date(1000).toISOString(), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: output } } } }
      : { type: 'assistant', timestamp: new Date(1000).toISOString(), message: { id: 'reply', usage: { input_tokens: 100, output_tokens: output } } };
    history(false);
    if (agent === 'claude') api.noteSettings(s, agent, { type: 'user', timestamp: new Date(500).toISOString(), parentUuid: null, message: { content: 'Prompt' } });
    api.noteSettings(s, agent, record(10));
    t.mock.timers.tick(701);
    assert.equal(shown().total, null); assert.equal(publishes, 0);
    api.noteSettings(s, agent, record(20));
    assert.equal(shown().total, null);
    history(true);
    assert.equal(shown().total.output, 20); assert.equal(publishes, 1);
    assert.deepEqual([begins, ends, actionResets, conversationResets], [1, 1, 1, 1]);
    history(false); assert.equal(shown().total, null, 'replacing or shortening a transcript holds its replay too');
    api.close();
  }
});

test('one rollover deadline refreshes each account scope once, keeps stale values and never rearms completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  const sessions = new Map(), env = {}; let codexReads = 0, claudeReads = 0;
  const service = new CodexAccountUsage({ scope: async () => null, interval: 120000, read: async () => {
    ++codexReads; return accountResult({ rateLimitResetCredits: { availableCount: 2 }, rateLimits: { primary: { usedPercent: 80, resetsAt: 110 } } }, 1000);
  } });
  const api = runtime({ sessions, claudeAccount: async () => { ++claudeReads; return account(1000, 80, 110000); } });
  t.after(() => { api.close(); service.dispose(); });
  for (const id of ['codex-one', 'codex-two']) {
    const s = session(id, 'codex'); sessions.set(id, s);
    s.usageAccount = service.watch({ cwd: os.tmpdir(), codexHome: path.join(os.tmpdir(), 'fake-usage-home'), provider: 'openai', accountLaunch: 'model-only-v1', env }, value => s.usage.codexAccount(value));
  }
  sessions.set('claude-one', session('claude-one')); sessions.set('claude-two', session('claude-two'));
  await api.refreshClaudeAccounts(); await flush(); api.scheduleUsageRollover();
  assert.equal(codexReads, 1); assert.equal(claudeReads, 1);
  t.mock.timers.tick(9999); await flush(); assert.equal(codexReads, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(codexReads, 2); assert.equal(claudeReads, 2);
  assert.equal(api.resources().usageRolloverTimer, null);
  for (const s of sessions.values()) assert.equal(s.usage.limits[0].percent, 80, 'expiry never fabricates a zero');
  api.scheduleUsageRollover(); t.mock.timers.tick(1000); await flush();
  assert.equal(codexReads, 2); assert.equal(claudeReads, 2);
  sessions.get('claude-one').usage.account(account(2000, 10, 120000)); api.scheduleUsageRollover();
  assert.equal(api.resources().usageRolloverAt, 120000);
  for (const s of sessions.values()) { api.stopUsageAccount(s); s.codexActive = false; }
  assert.equal(api.resources().usageRolloverTimer, null);
  t.mock.timers.tick(120000); await flush(); assert.equal(codexReads, 2); assert.equal(claudeReads, 2);
});

test('the shared one-shot crosses midnight, five-hour and weekly windows without repeating an expired deadline', async t => {
  const midnight = Date.parse('2026-10-24T00:00:00Z'), week = 7 * 24 * 60 * 60 * 1000;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: midnight - 5 * 60 * 60 * 1000 });
  const codex = session('codex', 'codex'), claude = session('claude');
  const limits = [{ minutes: 300, percent: 80, resetsAt: midnight }, { minutes: 10080, percent: 90, resetsAt: midnight + week }];
  codex.usage.observeLimits(limits, Date.now(), 'Codex');
  let codexReads = 0, claudeReads = 0;
  codex.usageAccount = { refresh: () => ++codexReads };
  const api = runtime({ sessions: new Map([['codex', codex], ['claude', claude]]),
    // Isolate the rollover from the independently tested 30-second fallback.
    setInterval: () => ({ unref() {} }), clearInterval() {},
    claudeAccount: async () => { ++claudeReads; return { limits, at: midnight - week, source: 'Claude Code' }; },
  });
  t.after(() => api.close());
  await api.refreshClaudeAccounts(); api.scheduleUsageRollover();
  t.mock.timers.tick(5 * 60 * 60 * 1000 - 1); await flush();
  assert.equal(codexReads, 0); assert.equal(claudeReads, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(Date.now(), midnight); assert.equal(codexReads, 1); assert.equal(claudeReads, 2);
  assert.equal(api.resources().usageRolloverAt, midnight + week);
  api.scheduleUsageRollover(); t.mock.timers.tick(week); await flush();
  assert.equal(codexReads, 2); assert.equal(claudeReads, 3);
  assert.equal(api.resources().usageRolloverTimer, null);
  api.scheduleUsageRollover(); t.mock.timers.tick(week); await flush();
  assert.equal(codexReads, 2); assert.equal(claudeReads, 3);
});
