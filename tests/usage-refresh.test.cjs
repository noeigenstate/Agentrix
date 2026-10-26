const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { UsageMeter } = require('../electron/features/agents/agent-usage.cjs');
const { CodexAccountUsage, accountResult } = require('../electron/features/agents/codex-account-usage.cjs');
const { promptText } = require('../electron/prompt-queue.cjs');

const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const section = (from, to) => main.slice(main.indexOf(from), main.indexOf(to));
const accounts = section('let claudeAccountTimer =', '// Restores and the reading-view picker');
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
  const context = vm.createContext({
    UsageMeter, promptText, sessions, process, path, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    fs: watcherFs().fs, quitting: false, scheduleState() {},
    store: { projects: [{ id: 'local', kind: 'local' }, { id: 'remote', kind: 'ssh' }], settings: {}, expectCompletion: () => assert.fail('background usage must not rearm completion'), setRestore() {} },
    claudeAccountFiles: () => [path.join(os.tmpdir(), 'usage-cache', '.claude.json'), path.join(os.tmpdir(), 'usage-cache', '.codepulse', 'claude-quota.json')],
    claudeAccount: async () => account(), agentSettings: previous => previous,
    codexProvider: async () => id => id, claudeProvider: async () => 'Anthropic', claudeConfigDir: () => '',
    followClaude() {}, applyActivity() {}, broadcast() {}, isLocalAgentCommand: (_agent, text) => text.startsWith('/'),
    terminalIds: project => [...sessions.values()].filter(s => s.projectId === project.id).map(s => s.terminalId),
    shownTerminalIds: project => [...sessions.values()].filter(s => s.projectId === project.id).map(s => s.terminalId),
    localShell: () => ({ kind: 'pwsh' }), t: value => value, getBranch: () => '', startupErrors: new Map(),
    desktopGlassBackend: null, desktopGlassActive: false, desktopGlassWindow: false, app: { getVersion: () => 'test' },
    ...overrides,
  });
  // Run the real main-process functions without requiring Electron or creating a terminal.
  const api = vm.runInContext(`${accounts}\n${notes}\n${historyUsage}\n${lifecycle}\n${hooks}\n${events}\n${state}\n({
    refreshClaudeAccounts, stopUsageAccount, disposeClaudeAccounts, scheduleUsageRollover, noteSettings, claudeActivity, onEvent, publicState,
    resources: () => ({ claudeAccountTimer, claudeAccountSoon, claudeAccountPending, claudeAccountWatchers, usageRolloverTimer, usageRolloverAt })
  })`, context);
  api.history = (s, agent) => vm.runInContext(`s => { ${histories[agent === 'claude' ? 0 : 1]}; return onHistory; }`, context)(s);
  api.close = () => { context.quitting = true; api.disposeClaudeAccounts(); api.scheduleUsageRollover(); };
  return api;
}

test('one Claude account read updates every local meter and publishes once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  const sessions = new Map(['first', 'middle', 'last'].map(terminalId => [terminalId, {
    terminalId, projectId: 'local', codexActive: true, usage: new UsageMeter('claude'),
  }]));
  sessions.set('remote', { projectId: 'remote', codexActive: true, usage: new UsageMeter('claude') });
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
