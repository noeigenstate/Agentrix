const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { hookHarness } = require('./helpers/hook-harness.cjs');

// The native session view: the model the events fold into, the store that keeps it, the view and its request cards, the launcher's choice of
// route, the grid cell it takes and the parent relay that no longer types. A fake bridge stands in for the main process everywhere: no real
// SDK, app-server, key or account is ever touched.
const src = path.join(__dirname, '..', 'src');


function makeLoader(overrides = {}) {
  const cache = new Map();
  const resolve = (from, name) => [name, `${name}.ts`, `${name}.tsx`].map(candidate => path.resolve(path.dirname(from), candidate)).find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = new Module(filename, module);
    mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
    cache.set(filename, mod);
    const original = mod.require.bind(mod);
    mod.require = name => {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name.endsWith('.css')) return {};
      if (name.endsWith('.json')) return original(name);
      if (name === '@phosphor-icons/react') return new Proxy({}, { get: (_, icon) => () => React.createElement('svg', { 'data-icon': icon }) });
      return name.startsWith('.') ? load(resolve(filename, name)) : original(name);
    };
    mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
    return mod.exports;
  }
  return relative => load(path.join(src, relative));
}

// The heavy neighbours are stood in: Markdown by an element that says its text, the avatar and the width-fitting hook by plain ones.
const fit = { index: 0 };   // which hint the width-fitting hook says fits; one past the list is "none does"
const load = makeLoader({
  './Markdown': { Markdown: ({ text }) => React.createElement('div', { className: 'md' }, text) },
  '../../shared/UserAvatar': { UserAvatar: () => React.createElement('i', { className: 'avatar' }) },
  '../../shared/useFittingHint': { fullHintProps: () => ({}), HIDDEN_NOTE: {}, useFittingHint: (box, hints) => hints[fit.index] ?? '' },
  './ResetQuota': { ResetQuota: () => null },
});
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
before(() => { Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {}, lang: '' } } }); load('shared/i18n.ts').applyLanguage('zh'); });
after(() => { if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document; });

const settle = async () => { for (let round = 0; round < 6; round++) await new Promise(resolve => setImmediate(resolve)); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
// The same, with the hook-free components below the first level run as well, so a card’s inner parts are seen.
const deep = node => Array.isArray(node) ? node.flatMap(deep) : React.isValidElement(node) ? (typeof node.type === 'function' ? deep(node.type(node.props)) : [node, ...deep(node.props.children)]) : [];
const fill = (text, values = {}) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);

// One runtime's event stream: sequence numbers count up; `extra` overrides any field of an event.
function stream(base = {}) {
  let n = 0;
  return (type, payload = {}, extra = {}) => ({ schemaVersion: 1, eventId: `e${++n}`, sequence: n, connectionEpoch: 'ep1', provider: 'claude', transport: 'claude-sdk', projectId: 'p1', terminalId: 't1',
    runtimeSessionId: 'rs1', providerSessionId: null, runId: null, turnId: 'turn1', itemId: null, receivedAtMs: 1000 + n, occurredAtMs: 1000 + n, replay: false, ...base, type, payload, ...extra });
}

// ---- the model ----------------------------------------------------------------------------------------------------------------------
test('events fold into one conversation: deltas stream, a completed snapshot replaces them, repeats change nothing, and what no event says stays null', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const events = [
    ev('session.state', { state: 'running', reason: null }),
    ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'hi', clientMessageId: 'c1' } }, { itemId: 'u1' }),
    ev('item.delta', { channel: 'text', text: 'Hel' }, { itemId: 'a1' }),
    ev('item.delta', { channel: 'text', text: 'lo' }, { itemId: 'a1' }),
  ];
  const streamed = applyEvents(emptyModel(), events).model;
  assert.deepEqual([streamed.order, streamed.items.a1.kind, streamed.items.a1.deltas.text], [['u1', 'a1'], 'agent-message', 'Hello']);
  const done = applyEvents(streamed, [ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'Hello there' } }, { itemId: 'a1' })]).model;
  assert.deepEqual([done.items.a1.deltas.text, done.items.a1.content.text, done.order], ['', 'Hello there', ['u1', 'a1']], 'the completed snapshot replaces the streamed pieces');
  assert.deepEqual(applyEvents(done, events).model, done, 'events heard again change nothing');
  const bare = applyEvents(emptyModel(), [ev('session.state', { state: 'idle' })]).model;
  assert.deepEqual([bare.path, bare.diff, bare.plan, bare.error, bare.session.reason], [null, null, null, null, null], 'nothing is invented');
});

test('a gap stops the fold and asks for a snapshot; another session or connection epoch is dropped and asked about once', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const model = applyEvents(emptyModel(), [ev('session.state', { state: 'idle' })]).model;
  const gap = applyEvents(model, [ev('turn.started'), ev('session.state', { state: 'waiting' }, { sequence: 9 }), ev('session.state', { state: 'running' }, { sequence: 10 })]);
  assert.deepEqual([gap.resync, gap.model.lastSequence, gap.model.session.state], [true, 2, 'idle'], 'the events after the gap wait for the snapshot');
  for (const base of [{ connectionEpoch: 'ep2' }, { runtimeSessionId: 'rs2' }]) {
    const other = stream(base), delta = () => other('item.delta', { channel: 'text', text: 'x' }, { itemId: 'z' });
    const first = applyEvents(model, [delta()]), again = applyEvents(first.model, [delta()]);
    assert.deepEqual([first.resync, again.resync, first.model.items], [true, false, model.items], JSON.stringify(base));
  }
  const strict = applyEvents(emptyModel(), [ev('session.state', { state: 'idle' }, { sequence: 40 }), ev('session.state', { state: 'running' }, { sequence: 44 })], false);
  assert.deepEqual([strict.resync, strict.model.session.state], [false, 'running'], 'a snapshot’s own events may be compacted');
});

test('requests wait for the owner until they are resolved, an ended session has none, and receipts follow the runtime', () => {
  const { applyEvents, emptyModel, canSend, isOver } = load('features/native-session/native-model.ts'), ev = stream();
  const model = applyEvents(emptyModel(), [
    ev('session.state', { state: 'waiting', reason: null }),
    ev('request.opened', { requestId: 'r1', kind: 'command', blocking: true, title: 'Run npm test', preview: 'npm test', actions: [], providerData: {} }),
    ev('request.opened', { requestId: 'r1', kind: 'command', title: 'again' }),
    ev('request.opened', { requestId: 'r2', kind: 'question', title: 'Which?', questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }] }] }),
    ev('input.receipt', { clientMessageId: 'c9', status: 'queued' }),
    ev('input.receipt', { clientMessageId: 'c9', status: 'consumed' }),
  ]).model;
  assert.deepEqual(model.requests.map(request => [request.id, request.kind, request.title, request.questions.length]), [['r1', 'command', 'Run npm test', 0], ['r2', 'question', 'Which?', 1]]);
  assert.equal(model.receipts.c9, 'consumed');
  const resolved = applyEvents(model, [ev('request.resolved', { requestId: 'r1', resolution: 'allowed', reason: null })]).model;
  assert.deepEqual(resolved.requests.map(request => request.id), ['r2']);
  const over = applyEvents(resolved, [ev('session.state', { state: 'stopped', reason: 'user' })]).model;
  assert.deepEqual([over.requests, canSend(model), canSend(over), isOver(over)], [[], true, false, true]);
});

test('a reasoning summary is no part of the model, a diff and a plan are replaced by the next and cleared by a new turn, and a turn ends with its own status', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const model = applyEvents(emptyModel(), [
    ev('turn.started', { origin: 'user', clientMessageId: 'c1' }),
    ev('item.delta', { channel: 'reasoning-summary', text: 'first ', index: 0 }, { itemId: 'th' }),
    ev('turn.diff', { diff: '+one' }), ev('turn.diff', { diff: '+one\n+two' }),
    ev('plan.updated', { explanation: 'x', steps: [{ step: 'A', status: 'pending' }] }), ev('plan.updated', { explanation: null, steps: [{ step: 'A', status: 'completed' }, { step: 'B', status: null }] }),
    ev('path.changed', { previous: 'api', selected: 'terminal', reason: 'budget_exhausted' }),
    ev('error', { code: 'rate', message: 'Too many requests', retryable: true, willRetry: true, stage: 'turn' }),
  ]).model;
  assert.deepEqual([model.items.th, model.order], [undefined, []], 'a thinking summary is kept nowhere: the conversation does not show it');
  assert.equal(model.diff, '+one\n+two');
  assert.deepEqual(model.plan, { explanation: null, steps: [{ text: 'A', status: 'completed' }, { text: 'B', status: null }] });
  assert.deepEqual([model.path.selected, model.path.reason, model.error.willRetry, model.turn.running], ['terminal', 'budget_exhausted', true, true]);
  const ended = applyEvents(model, [ev('turn.completed', { status: 'interrupted', error: null })]).model;
  assert.deepEqual([ended.turn, ended.error], [{ running: false, status: 'interrupted', error: null, end: { reason: null, message: null, durationMs: null, costUsdMicros: null, costEstimated: null, tokens: null } }, model.error]);
  assert.deepEqual([ended.diff === model.diff, ended.plan === model.plan], [true, true], 'the end of a turn keeps its diff and plan to read');
  const next = applyEvents(ended, [ev('turn.started', {})]).model;
  assert.deepEqual([next.error, next.diff, next.plan], [null, null, null], 'a new turn clears the last error, diff and plan');
});

test('a stream a newer message replaced is discarded whole: the half answer already heard goes, a late piece is dropped, and no entry is drawn for it', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), { nativeEntries } = load('features/native-session/native-entries.ts'), ev = stream();
  const heard = applyEvents(emptyModel(), [ev('item.delta', { channel: 'text', text: 'half an ans', index: 0 }, { itemId: 'old:0' }), ev('item.delta', { channel: 'text', text: 'The whole', index: 0 }, { itemId: 'new:0' })]).model;
  assert.deepEqual(nativeEntries(heard).map(entry => entry.text), ['half an ans', 'The whole']);
  const dropped = applyEvents(heard, [ev('item.upsert', { kind: 'agent-message', status: 'interrupted', content: { text: '', discarded: true } }, { itemId: 'old:0' }), ev('item.delta', { channel: 'text', text: 'late', index: 0 }, { itemId: 'old:0' })]).model;
  assert.deepEqual(nativeEntries(dropped).map(entry => entry.text), ['The whole'], 'the discarded item is hidden and its late piece does not bring it back');
  assert.equal(dropped.items['old:0'].deltas.text, '');
});

// ---- the words ----------------------------------------------------------------------------------------------------------------------
test('words: receipts, routes, money and quota windows say what is known and "未知" for what is not', () => {
  const words = load('features/native-session/native-words.ts'), item = (kind, content = {}, extra = {}) => ({ id: 'i', kind, status: null, content, turnId: null, at: null, deltas: { text: '', output: '', plan: '' }, ...extra });
  assert.deepEqual(['queued', 'delivered', 'consumed', 'rejected', 'unknown', 'mystery', null].map(words.receiptWord), ['已排队', '已送达', '已被读取', '未送达', '送达状态未知', null, null]);
  assert.deepEqual([null, undefined, 0, 5, 1_234_567].map(words.money), ['未知', '未知', '$0.00', '<$0.01', '$1.23'], 'unknown is not zero, and zero is not unknown');
  assert.deepEqual(['budget_exhausted', 'native_cli_required', 'no_key', 'something_new', 'a.b-c', null, '输入框里有未发送的文字', 'process exited'].map(words.reasonWords),
    ['本月 API 预算已用完', '未找到原生 Claude Code，无法通过 API 运行', '还没有保存 API key', null, null, null, '输入框里有未发送的文字', 'process exited'],
    'a code we know is said in words, a code nobody mapped is not shown, and a sentence main wrote for the owner is shown as it is');
  assert.deepEqual(words.windowWords({ usedPercent: 40, windowDurationMins: 300, resetsAtMs: null }), { span: '5 小时', used: '40%', resets: '未知' });
  assert.deepEqual([words.windowWords(null), words.windowWords({ usedPercent: null, windowDurationMins: 10080, resetsAtMs: null }).used], [null, '未知']);
  assert.deepEqual(['in_progress', 'completed', 'failed', 'declined', null].map(status => words.itemState(item('command', {}, { status }))), ['running', 'done', 'failed', null, null]);
  assert.deepEqual([words.messageText(item('agent-message', { text: 'final' }, { deltas: { text: 'streamed', output: '', plan: '' } })), words.messageText(item('agent-message', { text: 'final' }))], ['streamed', 'final']);
  assert.deepEqual(words.commandOf(item('command', { command: ['npm', 'test'], exitCode: 1, durationMs: 1500, output: 'old' }, { deltas: { text: '', output: 'live', plan: '' } })),
    { command: 'npm test', phrase: null, cwd: null, exitCode: 1, durationMs: 1500, output: 'live' });
  assert.deepEqual(words.fileChanges(item('file-change', { path: 'a.ts', diff: '+x' })), [{ path: 'a.ts', kind: null, diff: '+x' }]);
});

// ---- the store ----------------------------------------------------------------------------------------------------------------------
async function withBridge(bridge, run) {
  const store = load('features/native-session/native-store.ts'), saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: { nativeSession: bridge } } });
  try { await run(store); } finally { store.disposeNativeStore(); if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window; }
}
// The hooks read the store without a browser: a server render takes the current snapshot.
const read = (use) => { let found; renderToStaticMarkup(React.createElement(() => { found = use(); return null; })); return found; };
const entriesOf = store => read(store.useNativeEntries);

test('the window subscribes first and asks for a snapshot after; events that arrive meanwhile are folded on top of it and a repeat drops', async () => {
  const ev = stream(), history = [ev('session.state', { state: 'idle' }), ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'hi', clientMessageId: 'c1' } }, { itemId: 'u1', replay: true })];
  const live = ev('item.delta', { channel: 'text', text: 'Hello' }, { itemId: 'a1' }), asked = [];
  let emit = null, release; const gate = new Promise(resolve => { release = resolve; });
  const bridge = { onEvent: listener => { emit = listener; return () => { emit = null; }; }, snapshot: async id => { asked.push(id); await gate; return { ok: true, value: { runtimeSessionId: 'rs1', lastSequence: 2, events: history } }; } };
  await withBridge(bridge, async store => {
    store.ensureNativeSession('t1');
    assert.ok(emit, 'events are subscribed before the snapshot is asked for'); assert.deepEqual(asked, ['t1']);
    emit(live); emit(history[1]);
    release(); await settle();
    const entry = entriesOf(store).get('t1');
    assert.deepEqual([entry.model.order, entry.model.items.a1.deltas.text, entry.model.lastSequence, asked], [['u1', 'a1'], 'Hello', 3, ['t1']]);
    assert.equal(store.nativeShown(entry), true);
  });
});

test('a gap in the sequence asks for one new snapshot, which covers the missing events', async () => {
  const ev = stream(), first = [ev('session.state', { state: 'idle' })], lost = ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'hi' } }, { itemId: 'u1' });
  const next = ev('item.delta', { channel: 'text', text: 'ok' }, { itemId: 'a1' });
  let emit = null, calls = 0;
  const bridge = { onEvent: listener => { emit = listener; return () => {}; }, snapshot: async () => ({ ok: true, value: ++calls === 1 ? { runtimeSessionId: 'rs1', lastSequence: 1, events: first } : { runtimeSessionId: 'rs1', lastSequence: 3, events: [...first, lost, next] } }) };
  await withBridge(bridge, async store => {
    store.ensureNativeSession('t1'); await settle();
    emit(next); await settle();
    assert.equal(calls, 1, 'the snapshot is asked for after a short pause, not at once');
    await sleep(400);
    assert.equal(calls, 2);
    assert.deepEqual([entriesOf(store).get('t1').model.order, entriesOf(store).get('t1').model.lastSequence], [['u1', 'a1'], 3]);
  });
});

test('a finished session’s view can be closed until another starts, and a session moved to the terminal gives way to it with its reason', async () => {
  const ev = stream(), second = stream({ runtimeSessionId: 'rs2' }), moved = stream({ terminalId: 't2' });
  const ended = [ev('session.state', { state: 'stopped', reason: 'user' })], next = [second('session.state', { state: 'idle' })];
  const switched = [moved('session.state', { state: 'running' }), moved('path.changed', { previous: 'api', selected: 'terminal', reason: 'rate_limited' })];
  let emit = null, answer = { t1: ended, t2: switched };
  const bridge = { onEvent: listener => { emit = listener; return () => {}; }, snapshot: async id => ({ ok: true, value: { runtimeSessionId: answer[id][0].runtimeSessionId, lastSequence: answer[id].at(-1).sequence, events: answer[id] } }) };
  await withBridge(bridge, async store => {
    store.ensureNativeSession('t1'); store.ensureNativeSession('t2'); await settle();
    assert.equal(store.nativeShown(entriesOf(store).get('t1')), true);
    store.dismissNative('t1');
    assert.equal(store.nativeShown(entriesOf(store).get('t1')), false, 'the owner closed the finished view');
    answer = { t1: next }; emit(next[0]); await sleep(400);
    assert.equal(store.nativeShown(entriesOf(store).get('t1')), true, 'a session that starts there shows again');
    const away = entriesOf(store).get('t2');
    assert.deepEqual([store.nativeShown(away), store.terminalSwitch(away).reason], [false, 'rate_limited'], 'the terminal’s reading view takes the cell and the reason stays');
    store.dismissNote('t2');
    assert.equal(store.terminalSwitch(entriesOf(store).get('t2')), null);
    store.noteTerminalSwitch('t3', 'no_key');
    const own = entriesOf(store).get('t3');
    assert.deepEqual([store.nativeShown(own), store.terminalSwitch(own).reason], [false, 'no_key']);
  });
});

test('a replayed event never counts as news for the usage panel; a live one does, and a plain message does not', async () => {
  const ev = stream(), bridge = { onEvent: listener => { bridge.emit = listener; return () => {}; }, snapshot: async () => ({ ok: true, value: null }) };
  await withBridge(bridge, async store => {
    store.ensureNativeSession('t1'); await settle();
    const revision = () => read(store.useUsageRevision);
    bridge.emit(ev('usage.updated', { input: 1 }, { replay: true })); bridge.emit(ev('limits.updated', {}, { replay: true }));
    assert.equal(revision(), 0);
    bridge.emit(ev('usage.updated', { input: 2 })); assert.equal(revision(), 1);
    bridge.emit(ev('item.delta', { channel: 'text', text: 'x' }, { itemId: 'a' })); assert.equal(revision(), 1);
    bridge.emit(ev('turn.completed', { status: 'completed', error: null })); assert.equal(revision(), 2);
  });
});

// ---- how a session starts -----------------------------------------------------------------------------------------------------------
test('the launch route follows the settings: native by default, the terminal when chosen, the reason when a missing key is why, and nothing for API-only without a key', () => {
  const { launchRoute } = load('features/native-session/native-bridge.ts'), set = (claudePath, codexView = 'native') => ({ claudePath, codexView, monthlyBudgetUsd: null });
  const native = { how: 'native' }, terminal = (reason = null) => ({ how: 'terminal', reason });
  assert.deepEqual([launchRoute('claude', null, null), launchRoute('codex', null, true)], [terminal(), terminal()], 'settings not read or no bridge: today’s terminal');
  assert.deepEqual([launchRoute('claude', set('api-then-terminal'), true), launchRoute('claude', set('api-then-terminal'), null), launchRoute('claude', set('api-only'), true)], [native, native, native]);
  assert.deepEqual([launchRoute('claude', set('terminal-only'), true), launchRoute('claude', set('terminal-only'), false)], [terminal(), terminal()]);
  assert.deepEqual([launchRoute('claude', set('api-then-terminal'), false), launchRoute('claude', set('api-only'), false)], [terminal('no_key'), { how: 'blocked', reason: 'no_key' }]);
  assert.deepEqual([launchRoute('codex', set('terminal-only', 'native'), false), launchRoute('codex', set('api-only', 'terminal'), true)], [native, terminal()], 'Codex follows its own view setting and needs no key');
});

// A stand-in for the main process on `window.agentrix`, for the launcher.
function launcher(runtime, calls) {
  const bridge = {
    getSettings: async () => ({ ok: true, value: runtime.settings }), keyStatus: async () => ({ ok: true, value: { saved: runtime.saved } }),
    start: async (...args) => { calls.push(['start', ...args]); return { ok: true, value: { runtimeSessionId: 'rs1' } }; },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: {
    getAgents: async () => ({ ok: true, value: { npm: true, installing: null, error: null, codex: { installed: true }, claude: { installed: true } } }), onAgents: () => () => {},
    agentHistory: async () => ({ ok: true, value: { claude: null, codex: null } }),
    getState: async () => ({ ok: true, value: { projects: [{ id: 'p', terminals: [{ id: 't1', sessionId: null, status: 'stopped' }] }] } }),
    agentLaunch: async (...args) => { calls.push(['launch', ...args]); return { ok: true, value: true }; }, nativeSession: bridge,
  } } });
  const bridgeModule = require('../src/features/native-session/native-bridge.ts');
  const harness = hookHarness('src/features/terminal/AgentLauncher.tsx', {
    '@phosphor-icons/react': { CircleNotch() {}, Terminal() {} }, './AgentBrandIcon.ts': { ClaudeLogo() {}, CodexLogo() {} }, './time': { relativeTime: () => '' }, './i18n': { t: fill }, './agent-launcher.css': {},
    './native-store.ts': { noteTerminalSwitch: (...args) => calls.push(['note', ...args]), refreshNativeSession: id => calls.push(['refresh', id]) }, './native-bridge.ts': bridgeModule,
  });
  const props = { terminalId: 't1', projectId: 'p', onAction: async promise => { const result = await promise; return result.ok ? result.value : undefined; }, onOpenTerminal() {} };
  const render = () => harness.render('AgentLauncher', props).result;
  const button = agent => elements(render()).find(node => node.type === 'button' && node.props.className?.startsWith(`agent-launcher-agent is-${agent}`));
  const note = agent => elements(button(agent)).find(node => node.type === 'small').props.children;
  return { render, button, note, text: () => renderToStaticMarkup(render()), done() { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; } };
}

test('the launcher starts a native session or a terminal by the settings, says where the click goes, and a missing key never starts a hidden terminal', async () => {
  const set = (claudePath, codexView = 'native') => ({ claudePath, codexView, monthlyBudgetUsd: null });
  const cases = [
    ['claude', { settings: set('api-then-terminal'), saved: true }, [['start', 't1', { agent: 'claude', resume: false }], ['refresh', 't1']], '开始新的对话 · API · 原生界面'],
    ['claude', { settings: set('terminal-only'), saved: true }, [['launch', 't1', 'claude', 'new']], '开始新的对话'],
    ['claude', { settings: set('api-then-terminal'), saved: false }, [['launch', 't1', 'claude', 'new'], ['note', 't1', 'no_key']], '开始新的对话 · 没有 API key，改用终端'],
    ['claude', { settings: set('api-only'), saved: false }, [], '开始新的对话 · 需先保存 API key'],
    ['codex', { settings: set('api-then-terminal', 'native'), saved: false }, [['start', 't1', { agent: 'codex', resume: false }], ['refresh', 't1']], '开始新的对话 · 原生界面'],
    ['codex', { settings: set('api-then-terminal', 'terminal'), saved: true }, [['launch', 't1', 'codex', 'new']], '开始新的对话'],
  ];
  for (const [agent, runtime, expected, note] of cases) {
    const calls = [], view = launcher(runtime, calls);
    try {
      view.render(); await settle();
      assert.equal(view.note(agent), note, `${agent} ${JSON.stringify(runtime)}`);
      view.button(agent).props.onClick(); await settle();
      assert.deepEqual(calls, expected, `${agent} ${JSON.stringify(runtime)}`);
      if (!expected.length) assert.match(view.text(), /只用 API 运行，但还没有保存 API key/, 'and it says why nothing started');
    } finally { view.done(); }
  }
});

test('the Codex native-terminal mode keeps its own meaning whatever the native settings say', async () => {
  const calls = [], view = launcher({ settings: { claudePath: 'api-then-terminal', codexView: 'native', monthlyBudgetUsd: null }, saved: true }, calls);
  try {
    view.render(); await settle();
    elements(view.render()).find(node => node.props.role === 'radio' && /原生终端/.test(String(node.props.children))).props.onClick();
    view.button('codex').props.onClick(); await settle();
    assert.deepEqual(calls, [['launch', 't1', 'codex', 'native']], 'the app-server proxy mode launches the terminal, never a native session');
  } finally { view.done(); }
});

// ---- the view -----------------------------------------------------------------------------------------------------------------------
const richSession = ev => [
  ev('session.state', { state: 'running', reason: null }),
  ev('turn.started', { origin: 'user', clientMessageId: 'c1' }),
  ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'fix the test', clientMessageId: 'c1' } }, { itemId: 'u1' }),
  ev('input.receipt', { clientMessageId: 'c1', status: 'consumed' }),
  ev('item.upsert', { kind: 'reasoning-summary', status: 'completed', content: { text: 'Looking at the failing assertion' } }, { itemId: 'th1' }),
  ev('item.upsert', { kind: 'reasoning-summary', status: 'completed', content: {} }, { itemId: 'th2' }),
  ev('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'npm test', cwd: '/work' } }, { itemId: 'k1' }),
  ev('item.delta', { channel: 'output', text: 'FAIL a.test.js' }, { itemId: 'k1' }),
  ev('item.upsert', { kind: 'file-change', status: 'completed', content: { changes: [{ path: 'src/a.ts', kind: 'update', diff: '-old\n+new' }] } }, { itemId: 'f1' }),
  ev('item.delta', { channel: 'text', text: 'Done: ' }, { itemId: 'm1' }), ev('item.delta', { channel: 'text', text: 'it passes now.' }, { itemId: 'm1' }),
  ev('plan.updated', { explanation: null, steps: [{ step: 'Run tests', status: 'completed' }, { step: 'Fix', status: 'pending' }] }),
  ev('turn.diff', { diff: '+added line\n-removed line' }),
  ev('request.opened', { requestId: 'r1', kind: 'command', blocking: true, title: 'Run rm -rf build', preview: 'rm -rf build', actions: [], providerData: {} }),
];

// The draft handoff hook is tested on its own below; the views get this stand-in of it.
const handoffStub = () => ({ locked: false, incoming: null, offers: [], taken: 0, offer(draft) { this.offers.push(draft); }, take() { const draft = this.incoming; this.incoming = null; this.taken++; return draft; } });

async function viewHtml(build, base = {}) {
  const ev = stream(base), events = build(ev);
  let html = '';
  await withBridge({ onEvent: () => () => {}, snapshot: async () => ({ ok: true, value: { runtimeSessionId: events[0].runtimeSessionId, lastSequence: events.length, events } }) }, async store => {
    store.ensureNativeSession('t1'); await settle();
    html = renderToStaticMarkup(React.createElement(load('features/native-session/NativeSessionView.tsx').NativeSessionView, { terminalId: 't1', projectId: 'p1', handoff: handoffStub(), onError() {}, onOpenLink() {} }));
  });
  return html;
}

test('events become the reading view’s entries: your message and pictures, the reply, steps with their output and state, the plan and the diff, and nothing made up', () => {
  const { nativeEntries } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const model = applyEvents(emptyModel(), [
    ...richSession(ev),
    ev('item.upsert', { kind: 'tool', status: 'completed', content: { name: 'Read', input: '{"file_path":"/a/b.ts"}', output: 'file text' } }, { itemId: 't1' }),
    ev('item.upsert', { kind: 'tool', status: 'failed', content: { tool: 'search', server: 'docs', arguments: { q: 1 }, output: 'nope' } }, { itemId: 't2' }),
    ev('item.upsert', { kind: 'command', status: 'completed', content: { command: 'npm test', exitCode: 1, durationMs: 1500, output: 'boom' } }, { itemId: 'k2' }),
    ev('item.upsert', { kind: 'file-change', status: 'completed', content: { name: 'Edit', input: '{"file_path":"src/b.ts"}' } }, { itemId: 'f2' }),
  ]).model;
  const entries = nativeEntries(model, { c1: ['data:image/png;base64,AAAA'] });
  assert.deepEqual(entries.map(entry => [entry.role, entry.id]), [['user', 'u1'], ['tool', 'k1'], ['tool', 'f1'], ['assistant', 'm1'], ['tool', 't1'], ['tool', 't2'], ['tool', 'k2'], ['tool', 'f2'], ['tool', 'native:plan'], ['tool', 'native:diff']],
    'a thinking summary is not part of the reading view’s conversation');
  const by = id => entries.find(entry => entry.id === id);
  assert.deepEqual([by('u1').text, by('u1').images], ['fix the test', ['data:image/png;base64,AAAA']]);
  assert.equal(by('m1').text, 'Done: it passes now.');
  assert.deepEqual([by('k1').tool.kind, by('k1').tool.target, by('k1').tool.done, by('k1').tool.failed, by('k1').tool.output], ['command', 'npm test', false, false, 'FAIL a.test.js'], 'a running command shows its output so far');
  assert.deepEqual([by('f1').tool.kind, by('f1').tool.target, by('f1').tool.written, by('f1').tool.done, by('f1').tool.output], ['edit', 'src/a.ts', ['src/a.ts'], true, '-old\n+new']);
  assert.deepEqual([by('t1').tool.kind, by('t1').tool.target, by('t1').tool.output], ['read', '/a/b.ts', 'file text'], 'a tool shows its result, never its input as JSON');
  assert.deepEqual([by('t2').tool.kind, by('t2').tool.target, by('t2').tool.failed, by('t2').tool.done], ['mcp', 'docs · search', true, true]);
  assert.deepEqual([by('k2').tool.failed, by('k2').tool.detail], [true, '退出码 1 · 用时 1.5 秒'], 'a failed exit code fails the step; a folder nobody gave is not written');
  assert.deepEqual([by('f2').tool.target, by('f2').tool.written], ['src/b.ts', ['src/b.ts']], 'Claude names its edited file only in the input');
  assert.deepEqual([by('native:plan').tool.detail, by('native:plan').tool.output], ['1 / 2 步', '[x] Run tests\n[ ] Fix']);
  assert.equal(by('native:diff').tool.output, '+added line\n-removed line');
  const bare = nativeEntries(applyEvents(emptyModel(), [ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'hi' } }, { itemId: 'a1', occurredAtMs: null, receivedAtMs: 5 }), ev('item.upsert', { kind: 'agent-message', status: 'completed', content: {} }, { itemId: 'a2' })]).model);
  assert.deepEqual(bare.map(entry => [entry.id, entry.at]), [['a1', 5]], 'an empty message is no entry');
  const stopped = nativeEntries(applyEvents(emptyModel(), [ev('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'sleep 9' } }, { itemId: 'k' }), ev('session.state', { state: 'stopped', reason: 'user' })]).model);
  assert.deepEqual([stopped[0].tool.done, stopped[0].tool.failed], [true, true], 'a step of a finished session does not run for ever, and is not drawn as done');
});

test('tool steps read the structured fields first: the output, path, command and phrase, and a change’s diff; JSON and pictures are never shown, and TodoWrite is no file change', () => {
  const { nativeEntries } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const upsert = (itemId, kind, content, status = 'completed') => ev('item.upsert', { kind, status, content }, { itemId });
  const big = '{"file_path":"' + 'x'.repeat(70000);
  const model = applyEvents(emptyModel(), [
    upsert('r', 'tool', { name: 'Read', path: '/a/b.ts', input: big, output: 'one\ntwo' }),
    upsert('g', 'tool', { name: 'Agent', input: '{"description":"find the bug","subagent_type":"x"}', output: [{ type: 'text', text: 'found it' }, { type: 'image', source: { data: 'QUJD' } }] }),
    upsert('m', 'tool', { name: 'lookup', server: 'docs', arguments: { q: 1 }, result: { content: [{ type: 'text', text: 'three hits' }], structuredContent: { hits: 3 } } }),
    upsert('i', 'tool', { name: 'Screenshot', output: '[Image result]' }),
    upsert('t', 'tool', { name: 'TodoWrite', input: '{"todos":[]}', output: 'Todos have been modified' }),
    upsert('w', 'file-change', { name: 'Write', path: 'src/big.ts', input: big, changes: [{ path: 'src/big.ts', kind: 'write', diff: 'line 1\nline 2' }], output: 'File created' }),
    upsert('e', 'file-change', { name: 'Edit', path: 'src/a.ts', changes: [{ path: 'src/a.ts', kind: 'edit', diff: 'old\n->\nnew' }] }),
    upsert('b', 'command', { name: 'Bash', command: 'npm test', phrase: '运行测试', input: big, output: 'ok' }),
  ]).model;
  const entries = nativeEntries(model), by = id => entries.find(entry => entry.id === id).tool;
  assert.deepEqual([by('r').kind, by('r').target, by('r').output], ['read', '/a/b.ts', 'one\ntwo'], 'the path is its own field, not read out of a cut-off JSON input');
  assert.deepEqual([by('g').kind, by('g').target, by('g').output], ['agent', 'find the bug', 'found it'], 'blocks give their text; a picture block gives nothing');
  assert.deepEqual([by('m').target, by('m').output], ['docs · lookup', 'three hits']);
  assert.equal(by('i').output, '[Image result]');
  for (const id of ['r', 'g', 'm', 'i', 't', 'w', 'e', 'b']) assert.doesNotMatch(by(id).output ?? '', /[{]["\s]|base64|QUJD/, `${id} shows no JSON or picture data`);
  assert.deepEqual([by('t').kind, by('t').written, by('t').output], ['other', undefined, 'Todos have been modified'], 'TodoWrite is a tool, not a change to a file');
  assert.deepEqual([by('w').kind, by('w').target, by('w').written, by('w').output], ['edit', 'src/big.ts', ['src/big.ts'], 'line 1\nline 2'], 'a large Write keeps its path and shows its content as the diff');
  assert.deepEqual([by('e').target, by('e').output], ['src/a.ts', 'old\n->\nnew']);
  assert.deepEqual([by('b').target, by('b').phrase, by('b').output], ['npm test', '运行测试', 'ok']);
});

test('a step with no result once its turn is over is interrupted, never running and never done: on an idle session, a stopped one, or by its own status', () => {
  const { nativeEntries, runningStep } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const steps = [
    ev('session.state', { state: 'running' }),
    ev('turn.started', { origin: 'user', clientMessageId: 'c' }),
    ev('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'sleep 9' } }, { itemId: 'k' }),
    ev('item.upsert', { kind: 'tool', status: 'completed', content: { name: 'Read', path: '/a' } }, { itemId: 'r' }),
    ev('item.upsert', { kind: 'tool', status: 'interrupted', content: { name: 'Glob' } }, { itemId: 'q' }),
  ];
  const marks = model => Object.fromEntries(nativeEntries(model).map(entry => [entry.id, [entry.tool.done, entry.tool.failed, entry.tool.detail]]));
  const running = applyEvents(emptyModel(), steps).model;
  assert.deepEqual(marks(running), { k: [false, false, ''], r: [true, false, ''], q: [true, true, '已中断'] }, 'while the turn runs a step runs; a step the provider interrupted is a cross');
  assert.equal(runningStep(nativeEntries(running)).target, 'sleep 9');
  const idleButTurn = applyEvents(running, [ev('session.state', { state: 'idle' })]).model;
  assert.deepEqual([idleButTurn.session.state, marks(idleButTurn).k[0]], ['idle', false], 'an idle state while a turn still runs does not end its steps');
  const idle = applyEvents(idleButTurn, [ev('turn.completed', { status: 'interrupted', error: null })]).model;
  const stopped = applyEvents(idle, [ev('session.state', { state: 'stopped', reason: 'user' })]).model;
  for (const [name, over] of [['idle', idle], ['stopped', stopped]]) {
    assert.deepEqual(marks(over), { k: [true, true, '已中断'], r: [true, false, ''], q: [true, true, '已中断'] }, name);
    assert.equal(runningStep(nativeEntries(over)), null, 'nothing is shown running once the turn is over');
  }
});

test('a drawn picture, the owner’s pictures and the note for omitted ones become entries of the reading view, and every item shows the time its record gives', () => {
  const { nativeEntries } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const model = applyEvents(emptyModel(), [
    ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'look', clientMessageId: 'u1', images: ['data:image/png;base64,AAAA'] } }, { itemId: 'u1', occurredAtMs: 111 }),
    ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'and this one', clientMessageId: 'u2', images: [], imagesOmitted: true } }, { itemId: 'u2', occurredAtMs: 222 }),
    ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: '', clientMessageId: 'u3', images: [], imagesOmitted: true } }, { itemId: 'u3', occurredAtMs: null, receivedAtMs: 333 }),
    ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: '', generated: { path: '/p/generated_images/a.png', prompt: 'a red fox' }, images: ['data:image/jpeg;base64,BBBB'] } }, { itemId: 'g1', occurredAtMs: 444 }),
    ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: '', generated: { path: '/p/generated_images/b.png', prompt: 'no thumbnail' }, images: [] } }, { itemId: 'g2' }),
  ]).model;
  const entries = nativeEntries(model, { u2: ['data:image/png;base64,CCCC'] }), by = id => entries.find(entry => entry.id === id);
  assert.deepEqual(entries.map(entry => [entry.id, entry.at]), [['u1', 111], ['u2', 222], ['u3', 333], ['g1', 444]], 'the record’s own time, the time heard when it gave none; a drawing with no picture to show is no entry');
  assert.deepEqual([by('u1').images, by('u1').imagesOmitted], [['data:image/png;base64,AAAA'], undefined]);
  assert.deepEqual([by('u2').images, by('u2').imagesOmitted], [['data:image/png;base64,CCCC'], undefined], 'the pictures this window still holds are shown, and then nothing was omitted');
  assert.deepEqual([by('u3').text, by('u3').images, by('u3').imagesOmitted], ['', undefined, true], 'omitted pictures leave the note, even with no words');
  assert.deepEqual([by('g1').role, by('g1').generated, by('g1').images], ['assistant', { path: '/p/generated_images/a.png', prompt: 'a red fox' }, ['data:image/jpeg;base64,BBBB']]);
  const replayed = applyEvents(emptyModel(), [ev('item.delta', { channel: 'text', text: 'Hel' }, { itemId: 'a', occurredAtMs: null, receivedAtMs: 900 }), ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'Hello' } }, { itemId: 'a', occurredAtMs: 500 })]).model;
  assert.equal(replayed.items.a.at, 500, 'a replayed record’s own time replaces the time it was first heard');
});

test('Codex: a command reads its phrase from main, and the plan and diff of an earlier turn are gone when a new one starts', () => {
  const { nativeEntries } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream({ provider: 'codex', transport: 'codex-app-server' });
  const first = applyEvents(emptyModel(), [
    ev('turn.started', { origin: 'user', clientMessageId: 'c1' }),
    ev('item.upsert', { kind: 'command', status: 'completed', content: { command: ['npm', 'test'], phrase: '运行测试', exitCode: 0 } }, { itemId: 'k' }),
    ev('plan.updated', { explanation: null, steps: [{ step: 'A', status: 'completed' }] }), ev('turn.diff', { diff: '+x' }), ev('session.state', { state: 'idle' }),
  ]).model;
  assert.deepEqual(nativeEntries(first).map(entry => entry.id), ['k', 'native:plan', 'native:diff']);
  assert.equal(nativeEntries(first)[0].tool.phrase, '运行测试');
  const second = applyEvents(first, [ev('turn.started', { origin: 'user', clientMessageId: 'c2' })]).model;
  assert.deepEqual(nativeEntries(second).map(entry => entry.id), ['k'], 'the second turn does not end with the first one’s plan and changes');
});

test('what the owner sent and the conversation does not show is pending: sending, queued, or refused and lost; an echoed one is a message, and unknown delivery is never offered again', () => {
  const { nativeEntries, nativePending } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const user = (id, text, content = {}) => ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text, clientMessageId: id, ...content } }, { itemId: id });
  const receipt = (id, status) => ev('input.receipt', { clientMessageId: id, status });
  const model = applyEvents(emptyModel(), [
    user('c2', 'refused while switching', { unsent: true, images: ['data:image/png;base64,BBBB'] }), user('c3', 'held in the queue'), receipt('c3', 'queued'), user('c4', 'delivered'), receipt('c4', 'consumed'),
    receipt('c6', 'rejected'), receipt('c7', 'unknown'), receipt('c8', 'delivered'),
  ]).model;
  const sent = [{ id: 'c4', text: 'delivered', at: 4 }, { id: 'c5', text: 'in flight', at: 5 }, { id: 'c6', text: 'turned away', at: 6 }, { id: 'c7', text: 'who knows', at: 7 }, { id: 'c8', text: 'read, not echoed', at: 8 }];
  assert.deepEqual(nativeEntries(model).map(entry => entry.id), ['c4'], 'only an ordinary message is in the conversation');
  const { prompts, queued, lost } = nativePending(model, sent);
  const sending = Object.fromEntries(prompts.map(prompt => [prompt.id, prompt.sending]));
  assert.deepEqual(sending, { c2: false, c3: false, c5: true, c6: false, c7: true, c8: false }, 'no receipt or an unknown one reads as sending: it is neither lost nor offered again');
  assert.deepEqual([[...queued], [...lost].sort()], [['c3'], ['c2', 'c6']]);
  assert.deepEqual(prompts.find(prompt => prompt.id === 'c2').images, ['data:image/png;base64,BBBB']);
  assert.deepEqual(nativePending(model, sent, new Set(['c2', 'c5'])).prompts.map(prompt => prompt.id).sort(), ['c3', 'c6', 'c7', 'c8']);
  assert.equal(nativePending(model, sent, new Set(['c2'])).lost.has('c2'), false, 'a dismissed card is gone with its mark');
});

test('the view is the reading view’s: its markup is the feed’s, the working line and the stop are the reading view’s, and nothing is native-only but the requests', async () => {
  const html = await viewHtml(richSession);
  assert.match(html, /<div class="reading-view" data-agent="claude" data-native-session="rs1">/);
  assert.match(html, /class="reading-step is-user/); assert.match(html, /<p class="is-folded">fix the test<\/p>/); assert.match(html, /class="reading-step is-agent is-claude/);
  assert.match(html, /<div class="md">Done: it passes now\.<\/div>/);
  assert.match(html, /class="reading-tools[^"]*is-running/); assert.match(html, /运行 1 条命令/);
  const running = await viewHtml(ev => [ev('session.state', { state: 'running' }), ev('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'npm test' } }, { itemId: 'k1' }), ev('item.delta', { channel: 'output', text: 'FAIL a.test.js' }, { itemId: 'k1' })]);
  assert.match(running, /<pre class="reading-tool-output">FAIL a\.test\.js<\/pre>/, 'the group at the end that still runs is open, with the output so far, as the reading view opens it');
  assert.match(html, /运行 1 条命令 · 编辑 1 个文件/); assert.match(html, /<code class="reading-tools-file">[^>]*a\.ts/); assert.match(html, /调用 1 个工具/, 'the plan and the diff are steps of the last group');
  assert.match(html, /reading-status is-working is-claude/); assert.match(html, /正在运行 npm test/); assert.match(html, /Esc 中断/);
  assert.match(html, /title="中断（Esc）"/, 'the stop button is the reading view’s, in the composer'); assert.doesNotMatch(html, /<textarea[^>]*disabled/, 'and the message box stays usable');
  assert.match(html, /<div class="native-tail">/); assert.match(html, /Run rm -rf build/); assert.match(html, />允许本次</); assert.match(html, />拒绝</);
  assert.doesNotMatch(html, /native-head|native-state|native-runtime|native-stop|native-receipt|native-step|Claude · API|已被读取|会话已就绪|→/, 'no header, no receipt words, no native-only decoration');
  assert.doesNotMatch(html, /思考摘要|Looking at the failing/, 'a thinking summary is not drawn');
  assert.doesNotMatch(html, /Codex/);
});

test('a finished session says why and offers a new conversation; a Codex session is the reading view’s Codex; an idle one has no stop and no line of its own before there is a reply', async () => {
  const ended = await viewHtml(ev => [ev('session.state', { state: 'failed', reason: 'native_cli_required' })]);
  assert.match(ended, /未找到原生 Claude Code，无法通过 API 运行/); assert.match(ended, /开始新的对话/); assert.match(ended, /<textarea[^>]*disabled/); assert.doesNotMatch(ended, /中断（Esc）/);
  const round = (ev, completed) => [ev('session.state', { state: 'idle', reason: null }), ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'hi', clientMessageId: 'c1' } }, { itemId: 'u1' }),
    ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'hello' } }, { itemId: 'a1' }), ev('turn.completed', completed)];
  const codex = await viewHtml(ev => round(ev, { status: 'completed', error: null }), { provider: 'codex', transport: 'codex-app-server' });
  assert.match(codex, /data-agent="codex"/); assert.match(codex, /<b class="reading-step-label">Codex<\/b>/); assert.match(codex, /class="result-status"/, 'a finished round has the reading view’s result row'); assert.doesNotMatch(codex, /中断（Esc）/);
  assert.doesNotMatch(codex, /<textarea[^>]*disabled/); assert.doesNotMatch(codex, /本轮已完成|空闲|Codex · 原生/);
  const failed = await viewHtml(ev => round(ev, { status: 'failed', error: 'max_turns reached' }));
  assert.match(failed, /result-status is-failed/); assert.match(failed, /失败/, 'a turn that failed is not 已完成, whatever else the result says');
  const empty = await viewHtml(ev => [ev('session.state', { state: 'idle', reason: null })]);
  assert.doesNotMatch(empty, /会话已就绪|result-status|reading-step/, 'nothing yet: no line of its own');
});

// The session component with real hooks, the heavy neighbours stood in. `show` replaces the model's events; `change` is the terminal's SwitchState.
function sessionView(events, bridge, base = {}) {
  const model = require('../src/features/native-session/native-model.ts'), ev = stream(base), dismissed = [], handoff = handoffStub(), toBottom = [];
  let change = null;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: { nativeSession: bridge } } });
  const build = list => ({ model: model.applyEvents(model.emptyModel(), list).model, dismissed: null, noteDismissed: false, handoff: null });
  const parts = { AgentMark() {}, PendingPromptEntries() {}, QuoteChip() {}, quoteExcerpt: load('features/reading/message-quote.ts').quoteExcerpt, withQuote: load('features/reading/message-quote.ts').withQuote, ResultActions() {}, ResultChecks() {}, ResultStatus() {}, TimelineStep() {}, UserImages() {}, WorkingLine() {}, pastedPicture: load('features/reading/image-input.ts').pastedPicture, latestResult: load('features/reading/result-round.ts').latestResult, useStickToBottom: () => ({ stuck: true, unseen: 0, toBottom: () => toBottom.push(true), ready: true }) };
  const feed = { ConversationDecorations: { Provider() {} }, ConversationFeed() {} };
  const harness = hookHarness('src/features/native-session/NativeSessionView.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './useFittingHint': { fullHintProps: () => ({}), HIDDEN_NOTE: {}, useFittingHint: (box, hints) => hints[0] },
    './action-text': { actionText: tool => `${tool.kind}:${tool.target}` }, './ConversationFeed': feed, './feed-parts': parts,
    './native-entries.ts': load('features/native-session/native-entries.ts'), './native-pictures.ts': load('features/native-session/native-pictures.ts'), './NativeRequestCard': { NativeRequestCard() {} }, './native-session.css': {},
    './native-store.ts': { dismissNative: id => dismissed.push(id), nativeShown: () => true, useNativeEntries: () => new Map(), resolveSwitch: terminal => terminal },
    './SwitchNotice': { asksChoice: state => (state?.phase === 'awaiting-choice' || state?.phase === 'waiting-background') && !!state.requestId, SwitchLine() {}, SwitchQuestion() {} }, './native-words': words(),
  });
  let entry = build(events(ev));
  const tree = () => harness.render('NativeSession', { terminalId: 't1', projectId: 'p1', entry, autoFocus: false, switchState: change, handoff, onError() {}, onOpenLink() {} }).result;
  const find = predicate => elements(tree()).find(predicate), box = () => find(node => node.type === 'textarea');
  return {
    ev, find, box, tree, dismissed, handoff, parts, toBottom, show(list) { entry = build(list); }, switching(state) { change = state; },
    prompts: () => find(node => node.type === parts.PendingPromptEntries).props, decorations: () => find(node => node.props?.value?.frame).props.value, feed: () => find(node => node.type === feed.ConversationFeed).props,
    type: value => box().props.onChange({ target: { value } }),
    press: (init = {}) => { const prevented = []; box().props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => prevented.push(true), ...init }); return prevented.length; },
    done() { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; },
  };
}
const idle = ev => [ev('session.state', { state: 'idle', reason: null })];
const stopButton = view => view.find(node => node.type === 'button' && node.props.title === '中断（Esc）');

test('Enter sends the trimmed message at once and shows it as sending until the runtime echoes it; Shift+Enter, IME and an empty box send nothing', async () => {
  const sends = [], view = sessionView(idle, { send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } });
  try {
    view.press(); view.type('   '); view.press(); view.type('hello'); view.press({ shiftKey: true }); view.press({ nativeEvent: { isComposing: true } });
    assert.deepEqual(sends, []);
    view.type('  hello  ');
    assert.equal(view.press(), 1, 'Enter is taken so it adds no line'); await settle();
    assert.equal(sends.length, 1); const [terminal, session, id, text] = sends[0];
    assert.deepEqual([terminal, session, typeof id, text], ['t1', 'rs1', 'string', 'hello']);
    assert.equal(view.box().props.value, '', 'the box emptied');
    assert.deepEqual(view.prompts().prompts.map(prompt => [prompt.text, prompt.sending]), [['hello', true]], 'until a receipt arrives it reads as being sent, as the reading view’s pending message');
    const echo = status => [...idle(view.ev), view.ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'hello', clientMessageId: id } }, { itemId: id }), view.ev('input.receipt', { clientMessageId: id, status })];
    view.show(echo('consumed'));
    assert.deepEqual(view.prompts().prompts, [], 'the echoed message is in the conversation, not also pending');
    assert.deepEqual(view.feed().entries.map(entry => [entry.role, entry.text]), [['user', 'hello']]);
    view.show(echo('queued'));
    assert.deepEqual([view.prompts().prompts.length, view.prompts().queued(view.prompts().prompts[0]), view.feed().entries.length], [1, true, 0], 'held in the runtime’s queue it waits, as a queued message does in the reading view');
  } finally { view.done(); }
});

test('a picture pasted or dropped joins the next message, and pictures alone can be sent; what the runtime would refuse is refused first, with the reason', async () => {
  const sends = [], view = sessionView(idle, { send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } });
  const reader = globalThis.FileReader;
  globalThis.FileReader = class { readAsDataURL(file) { setImmediate(() => { this.result = `data:${file.type};base64,${file.body}`; this.onload(); }); } };
  const file = (type, body = 'AAAA', size = 4) => ({ type, body, size });
  const attached = () => elements(view.tree()).find(node => node.type === view.parts.UserImages)?.props.images;
  const sendButton = () => elements(view.tree()).find(node => node.type === 'button' && /reading-send/.test(node.props.className ?? ''));
  const paste = (items, text = '') => { const prevented = []; view.box().props.onPaste({ clipboardData: { getData: () => text, items }, preventDefault: () => prevented.push(true) }); return prevented.length; };
  const item = (picture, type = picture.type) => ({ kind: 'file', type, getAsFile: () => picture });
  const root = () => elements(view.tree()).find(node => node.props?.['data-native-session']).props;
  const drop = (files, types = ['Files']) => { const prevented = [], dataTransfer = { types, files }; root().onDrop({ dataTransfer, preventDefault: () => prevented.push(true) }); return prevented.length; };
  const error = () => elements(view.tree()).find(node => node.props?.role === 'alert')?.props.children;
  try {
    assert.equal(sendButton().props.disabled, true, 'nothing to send yet');
    assert.equal(paste([item(file('image/png'))], 'copied words'), 0, 'a paste with words is the box’s own');
    assert.equal(paste([{ kind: 'string', type: 'text/plain' }]), 0);
    assert.equal(paste([item(file('image/png', 'AAAA'))]), 1, 'a pasted picture is taken from the box');
    await settle(); view.tree();
    assert.deepEqual(attached(), ['data:image/png;base64,AAAA']);
    assert.equal(sendButton().props.disabled, false, 'a picture alone can be sent');
    paste([item(file('image/gif'))]); await settle();
    assert.deepEqual([attached().length, error()], [1, '只能附加 PNG、JPEG 或 WebP 图片。'], 'a format the runtime refuses is refused before it is attached');
    paste([item(file('image/webp', 'W', 6 * 1024 * 1024))]); await settle();
    assert.deepEqual([attached().length, error()], [1, '图片太大（超过 5 MB），请压缩后再附加。']);
    assert.equal(drop([file('image/jpeg', 'BBBB')]), 1, 'the drop is taken so the window does not open the file'); await settle(); view.tree();
    assert.deepEqual([attached(), error()], [['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB'], undefined], 'a drop adds to the pictures and clears the earlier error');
    assert.equal(drop([], ['text/plain']), 0, 'a drag that carries no file is left alone');
    drop([file('image/png', 'C'), file('image/png', 'D'), file('image/png', 'E')]); await settle(); view.tree();
    assert.deepEqual([attached().length, error()], [4, '最多附加 4 张图片，请先移除一张。'], 'four pictures at most');
    view.press(); await settle(); view.tree();
    assert.equal(sends.length, 1, 'Enter with only pictures sends them');
    assert.deepEqual([sends[0][3], sends[0][4].length], ['请看附上的图片。', 4], 'with the one line the runtime needs');
    assert.equal(attached(), undefined, 'the pictures left with the message');
    view.type('look at this'); paste([item(file('image/png', 'F'))]); await settle(); view.tree(); view.press(); await settle();
    assert.deepEqual([sends[1][3], sends[1][4]], ['look at this', ['data:image/png;base64,F']], 'words and a picture go together');
  } finally { globalThis.FileReader = reader; view.done(); }
});

test('while the box is shut a drop is taken and nothing is attached', async () => {
  const view = sessionView(ended => [...idle(ended), ended('session.state', { state: 'stopped', reason: 'user' })], {});
  try {
    const prevented = [];
    elements(view.tree()).find(node => node.props?.['data-native-session']).props.onDrop({ dataTransfer: { types: ['Files'], files: [{ type: 'image/png', size: 1 }] }, preventDefault: () => prevented.push(true) });
    await settle();
    assert.deepEqual([prevented.length, elements(view.tree()).some(node => node.type === view.parts.UserImages)], [1, false]);
  } finally { view.done(); }
});

test('a message the main process refuses comes back into the box with the reason, unless something new was typed meanwhile', async () => {
  const answers = [{ ok: false, error: 'no such session' }, { ok: false, error: 'busy' }], view = sessionView(idle, { send: async () => answers.shift() });
  try {
    view.type('please retry'); view.press(); await settle();
    assert.deepEqual([view.box().props.value, view.find(node => node.props?.role === 'alert').props.children], ['please retry', 'no such session']);
    assert.deepEqual(view.prompts().prompts, [], 'nothing is shown as sent');
    view.press(); view.type('something else'); await settle();
    assert.equal(view.box().props.value, 'something else');
  } finally { view.done(); }
});

test('a message sent while the switch freezes the input is shown as unsent, never as sent; sending it again is the owner’s click, and a refusal brings the card back', async () => {
  const sends = [], answers = [{ ok: true, value: {} }, { ok: false, error: 'frozen' }];
  const view = sessionView(idle, { send: async (...args) => { sends.push(args); return answers.shift(); } });
  try {
    view.type('while frozen'); view.press(); await settle();
    const id = sends[0][2];
    // Main took the call and refused the message: an unsent item with the same id, and no receipt of delivery.
    view.show([...idle(view.ev), view.ev('item.upsert', { kind: 'user-message', status: 'interrupted', content: { text: 'while frozen', clientMessageId: id, unsent: true } }, { itemId: id })]);
    const shown = view.prompts();
    assert.deepEqual(shown.prompts.map(prompt => prompt.text), ['while frozen']); assert.equal(shown.undelivered(shown.prompts[0]), true, 'drawn as not delivered');
    assert.equal(shown.queued(shown.prompts[0]), false); assert.deepEqual(view.feed().entries, [], 'and not as a message of the conversation');
    view.tree(); assert.deepEqual(view.handoff.offers.at(-1).undelivered, [{ clientMessageId: id, text: 'while frozen', images: undefined }], 'a switch carries it as unsent');
    shown.onResend(shown.prompts[0]); await settle();
    assert.deepEqual([sends.length, sends[1][3], sends[1][2] === id], [2, 'while frozen', false], 'sent again as a new message, by the click');
    assert.equal(view.prompts().prompts.some(prompt => prompt.id === id), true, 'the refused send brings the first card back');
    view.prompts().onDiscard(view.prompts().prompts.find(prompt => prompt.id === id));
    assert.equal(view.prompts().prompts.some(prompt => prompt.id === id), false, 'and the owner can drop it');
  } finally { view.done(); }
});

test('a quoted message waits above the box and goes before the words of the next message only, as in the reading view; a refused send gives it back', async () => {
  const sends = [], answers = [{ ok: false, error: 'busy' }, { ok: true, value: {} }];
  const view = sessionView(idle, { send: async (...args) => { sends.push(args); return answers.shift(); } });
  try {
    const quote = () => view.find(node => node.type === view.parts.QuoteChip)?.props.quote;
    assert.equal(view.decorations().quote.disabled, null);
    const words = ['the plan', 'is this'].join('\n'), sent = ['> the plan', '> is this', '', 'ok'].join('\n');
    view.decorations().quote.pick('Claude Code', words); view.tree();
    assert.deepEqual(quote(), { who: 'Claude Code', excerpt: words });
    view.type('ok'); view.press(); await settle();
    assert.equal(sends[0][3], sent); assert.equal(quote().who, 'Claude Code', 'the refused send gives the quote back');
    view.type('ok'); view.press(); await settle();
    assert.equal(sends[1][3], sent); assert.equal(quote(), undefined, 'a quote goes with one message');
  } finally { view.done(); }
});

test('Stop is the composer’s button while it works, Esc does the same, neither is offered when idle; a finished session takes no message and can be closed', async () => {
  const interrupts = [], bridge = { interrupt: async (...args) => { interrupts.push(args); return { ok: true, value: {} }; }, send: async () => assert.fail('nothing to send') };
  const working = sessionView(ev => [...idle(ev), ev('turn.started', { origin: 'user', clientMessageId: null })], bridge);
  try {
    stopButton(working).props.onClick(); await settle();
    working.box().props.onKeyDown({ key: 'Escape', preventDefault() {} }); await settle();
    assert.deepEqual(interrupts, [['t1', 'rs1'], ['t1', 'rs1']]);
    working.show(idle(working.ev));
    assert.equal(stopButton(working), undefined, 'idle: no Stop');
    working.box().props.onKeyDown({ key: 'Escape', preventDefault() {} }); await settle();
    assert.equal(interrupts.length, 2, 'and Esc interrupts nothing');
  } finally { working.done(); }
  const ended = sessionView(ev => [ev('session.state', { state: 'stopped', reason: 'user' })], bridge);
  try {
    assert.equal(ended.box().props.disabled, true);
    ended.type('too late'); ended.press(); await settle();
    ended.find(node => node.type === 'button' && node.props.children === '开始新的对话').props.onClick();
    assert.deepEqual(ended.dismissed, ['t1']);
  } finally { ended.done(); }
});

test('the working line says the step in hand, the result belongs to a round that has ended, and a waiting session says it waits', () => {
  const user = ev => ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'go', clientMessageId: 'c1' } }, { itemId: 'u1' });
  const view = sessionView(ev => [...idle(ev), ev('turn.started', { origin: 'user', clientMessageId: 'c1' }), user(ev), ev('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'npm test' } }, { itemId: 'k1' })], {});
  try {
    const working = view.decorations().status;
    assert.equal(working.type, view.parts.WorkingLine); assert.deepEqual([working.props.agent, working.props.label], ['claude', '正在command:npm test']);
    assert.equal(view.decorations().running, true); assert.equal(view.decorations().anchor, undefined, 'no result while it works');
    view.show([...idle(view.ev), view.ev('turn.started', { origin: 'user', clientMessageId: 'c1' }), user(view.ev)]);
    assert.equal(view.find(node => node.type === view.parts.WorkingLine).props.label, 'Claude Code 正在思考', 'no step: it is thinking, on a step of its own after your message');
    view.show([...idle(view.ev), user(view.ev), view.ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'done' } }, { itemId: 'a1' }), view.ev('turn.completed', { status: 'completed', error: null })]);
    assert.deepEqual([view.decorations().status, view.decorations().anchor, view.feed().live], [null, 'a1', false], 'the round ended: the result stands on its reply');
    view.show([...idle(view.ev), view.ev('session.state', { state: 'waiting', reason: null })]);
    assert.equal(view.find(node => node.props?.className === 'reading-status is-waiting').props.role, 'status');
  } finally { view.done(); }
});

test('each pending request gets its card, for this session; a stopped session has none', () => {
  const view = sessionView(ev => [...idle(ev), ev('request.opened', { requestId: 'r1', kind: 'command', title: 'one' }), ev('request.opened', { requestId: 'r2', kind: 'file-change', title: 'two' })], {});
  try {
    const cards = elements(view.tree()).filter(node => node.props?.request);
    assert.deepEqual(cards.map(node => [node.props.request.id, node.props.terminalId, node.props.sessionId]), [['r1', 't1', 'rs1'], ['r2', 't1', 'rs1']]);
    view.show([...idle(view.ev), view.ev('request.opened', { requestId: 'r3', kind: 'command', title: 'x' }), view.ev('session.state', { state: 'stopped', reason: 'user' })]);
    assert.equal(elements(view.tree()).filter(node => node.props?.request).length, 0);
  } finally { view.done(); }
});

// ---- the request cards --------------------------------------------------------------------------------------------------------------
function cardView(request, bridge) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: { nativeSession: bridge } } });
  const harness = hookHarness('src/features/native-session/NativeRequestCard.tsx', { '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill } });
  const tree = () => deep(harness.render('NativeRequestCard', { request, terminalId: 't1', sessionId: 'rs1' }).result);
  const button = label => tree().find(node => node.type === 'button' && node.props.children === label), input = index => tree().filter(node => node.type === 'input')[index];
  return { tree, button, input, done() { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; } };
}
const request = (patch = {}) => ({ id: 'r1', kind: 'command', blocking: true, title: 'Run npm test', preview: 'npm test', questions: [], at: 1, ...patch });

test('a request is allowed once or denied by the owner’s click only, shut while the answer goes and open again with the reason when refused', async () => {
  const answers = [], results = [{ ok: true, value: {} }, { ok: false, error: 'already answered' }];
  const view = cardView(request(), { answer: async (...args) => { answers.push(args); return results.shift(); } });
  try {
    assert.equal(view.tree().find(node => node.type === 'pre').props.children, 'npm test');
    assert.equal(answers.length, 0, 'it waits: nothing is answered by itself');
    view.button('允许本次').props.onClick(); view.button('允许本次').props.onClick(); await settle();
    assert.deepEqual(answers, [['t1', 'rs1', 'r1', { decision: 'allow' }]], 'one click, one answer');
    assert.equal(view.button('拒绝').props.disabled, true, 'shut until the main process resolves it');
  } finally { view.done(); }
  const again = cardView(request(), { answer: async (...args) => { answers.push(args); return { ok: false, error: 'already answered' }; } });
  try {
    again.button('拒绝').props.onClick(); await settle();
    assert.deepEqual(answers.at(-1), ['t1', 'rs1', 'r1', { decision: 'deny' }]);
    assert.equal(again.tree().find(node => node.props?.role === 'alert').props.children, 'already answered');
    assert.equal(again.button('拒绝').props.disabled, false, 'and it can be answered again');
  } finally { again.done(); }
});

test('a question card says it has a question and shows only the question and its options: never the tool’s name or its raw input; the tool has no step of its own', () => {
  const questions = [{ id: 'q1', question: 'Which database?', options: [{ label: 'SQLite' }] }];
  const view = cardView(request({ id: 'r3', kind: 'question', title: 'AskUserQuestion', preview: '{"questions":[{"question":"Which database?"}]}', questions }), {});
  try {
    assert.equal(view.tree().find(node => node.type === 'strong').props.children, '它有问题要问你');
    assert.equal(view.tree().some(node => node.type === 'pre'), false, 'no raw input under the question');
  } finally { view.done(); }
  const { nativeEntries } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const model = applyEvents(emptyModel(), [ev('item.upsert', { kind: 'tool', status: 'completed', content: { name: 'AskUserQuestion', input: '{"questions":[]}' } }, { itemId: 'q' }), ev('item.upsert', { kind: 'tool', status: 'completed', content: { name: 'Read', path: '/a' } }, { itemId: 'r' })]).model;
  assert.deepEqual(nativeEntries(model).map(entry => entry.id), ['r']);
});

test('questions are answered one by one with options, your own words or a secret, and the answer goes only once every question has one', async () => {
  const sent = [], questions = [
    { id: 'q1', question: 'Which database?', options: [{ label: 'SQLite', description: 'file based' }, { label: 'Postgres' }] },
    { id: 'q2', question: 'Which features?', multiSelect: true, options: [{ label: 'auth' }, { label: 'search' }] },
    { id: 'q3', question: 'API token?', isSecret: true },
  ];
  const view = cardView(request({ id: 'r2', kind: 'question', title: 'Questions', preview: '', questions }), { answer: async (...args) => { sent.push(args); return { ok: true, value: {} }; } });
  try {
    const radios = () => view.tree().filter(node => node.props?.role === 'radio'), boxes = () => view.tree().filter(node => node.props?.role === 'checkbox');
    assert.equal(view.button('提交回答').props.disabled, true, 'nothing answered yet');
    assert.equal(view.input(2).props.type, 'password', 'a secret is a password field');
    assert.equal(view.input(0).props.type, 'text');
    radios()[1].props.onClick(); boxes()[0].props.onClick(); boxes()[1].props.onClick(); boxes()[0].props.onClick();
    assert.deepEqual([radios()[1].props['aria-checked'], boxes().map(node => node.props['aria-checked'])], [true, [false, true]], 'a pick, and a multiple pick that can be undone');
    assert.equal(view.button('提交回答').props.disabled, true, 'the secret is still empty');
    view.input(2).props.onChange({ target: { value: 'tok-123' } });
    view.input(0).props.onChange({ target: { value: ' MySQL ' } });
    assert.equal(view.button('提交回答').props.disabled, false);
    view.button('提交回答').props.onClick(); await settle();
    assert.deepEqual(sent, [['t1', 'rs1', 'r2', { answers: { q1: 'MySQL', q2: ['search'], q3: 'tok-123' } }]], 'your own words win over a pick of a single question');
    sent.length = 0;
    const skip = cardView(request({ id: 'r3', kind: 'question', questions }), { answer: async (...args) => { sent.push(args); return { ok: true, value: {} }; } });
    try { skip.button('不回答').props.onClick(); await settle(); assert.deepEqual(sent, [['t1', 'rs1', 'r3', { decision: 'deny' }]], 'the owner can decline to answer'); } finally { skip.done(); }
  } finally { view.done(); }
});

// ---- the grid cell ------------------------------------------------------------------------------------------------------------------
function gridMarkup(terminals, { focused = false, native = [], moved = [], handoffs = [] } = {}) {
  const marker = (name, props) => React.createElement('div', { className: name, 'data-terminal': props.terminalId ?? props.id, 'data-phase': props.switchState?.phase ?? '', 'data-active': String(props.terminalActive ?? '') });
  const load = makeLoader({
    '../agents/SubagentPane': { SubagentPane: () => null }, '../agents/subagent-splits.ts': { closeSplit() {}, splitsOf: () => [], useSplits: () => [] },
    './AgentLauncher': { AgentLauncher: props => marker('launcher-stub', props) }, './TerminalPane': { TerminalPane: props => marker('pane-stub', props) }, '../reading/ReadingView': { ReadingView: () => null },
    '../reading/reading-mode': { readingShown: () => false, setReading() {}, syncReading() {}, useTerminalChoice: () => [] }, '../workspace/useProjectReorder': { TERMINAL_SPLITS: {}, useReorder: () => ({}) },
    '../native-session/NativeSessionView': { NativeSessionView: props => marker('native-stub', props) }, '../native-session/NativePathNote': { NativePathNote: props => marker('note-stub', props) },
    '../native-session/draft-handoff.ts': { useHandoff: (id, session, state) => { handoffs.push([id, session, state?.phase ?? null]); return {}; } },
    '../native-session/native-store.ts': { useNativeEntries: () => new Map(native.map(id => [id, { shown: true }])), nativeShown: entry => !!entry?.shown, ensureNativeSession() {} },
  });
  return renderToStaticMarkup(React.createElement(load('features/terminal/ProjectTerminals.tsx').ProjectTerminals, { project: { id: 'p', name: 'P', kind: 'local', terminals }, focused, fontSize: 13, activeId: null, setActiveId() {}, onExpand() { throw new Error('expanded'); }, onAction: async () => {}, onError() {}, onOpenLink() {} }));
}
const terminal = (id, patch = {}) => ({ id, title: id, sessionId: null, status: 'stopped', codexActive: false, readingHistory: null, agentStarting: false, needsInput: null, ...patch });

test('a native session takes the card’s cell where a terminal would, with no launcher; the terminal’s own view takes it back with the reason', () => {
  const small = gridMarkup([terminal('t1')], { native: ['t1'] });
  assert.match(small, /class="native-stub" data-terminal="t1"/); assert.doesNotMatch(small, /launcher-stub|pane-stub/); assert.match(small, /data-reading="true"/);
  assert.match(gridMarkup([terminal('t1')]), /launcher-stub/, 'without a session the launcher stays');
  const back = gridMarkup([terminal('t1', { sessionId: 's1', codexActive: true })], { native: ['t1'] });
  assert.match(back, /pane-stub/); assert.match(back, /class="note-stub" data-terminal="t1"/); assert.doesNotMatch(back, /native-stub/, 'a terminal that runs shows the terminal, not the old native view');
  const both = gridMarkup([terminal('t1'), terminal('t2')], { focused: true, native: ['t2'] });
  assert.deepEqual([(both.match(/native-stub/g) ?? []).length, (both.match(/launcher-stub/g) ?? []).length], [1, 1], 'an expanded project: the native split beside the one still to be started');
});

// ---- guards -------------------------------------------------------------------------------------------------------------------------
test('the native view writes to no terminal, never expands a project, and reaches the main process only through the bridge file', () => {
  const dir = path.join(src, 'features/native-session'), files = fs.readdirSync(dir).filter(file => /\.tsx?$/.test(file));
  const code = file => fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\/.*$/gm, '');
  const all = files.map(code).join('\n');
  assert.doesNotMatch(all, /writeTerminal|writeApproval|answerTerminal|startTerminal|closeTerminal|sendToAgent|readClipboard|onExpand|expandProject/, 'typing in a small card cannot expand it, and nothing types into a pty');
  assert.deepEqual(files.filter(file => /window\.agentrix/.test(code(file))), ['native-bridge.ts'], 'one file reads the bridge off window');
  assert.doesNotMatch(all, /console\.|localStorage|sessionStorage/, 'a secret answer is kept nowhere');
});

test('interventions have no planner relay sender or mounted renderer listener', () => {
  assert.equal(fs.existsSync(path.join(src, 'features/agents/parent-relay.ts')), false);
  const main = fs.readFileSync(path.join(src, '../electron/main.cjs'), 'utf8');
  assert.doesNotMatch(main, /sendParentPrompt|webContents\.send\('agents:relay'/);
  assert.doesNotMatch(fs.readFileSync(path.join(src, 'App.tsx'), 'utf8'), /startParentRelay/);
});

test('terminal fallback exposes unsent text for copying without submitting it or claiming delivery', async () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const text = 'keep this draft\n保留原文', copied = [], dismissed = [];
  const model = applyEvents(emptyModel(), [
    ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'already sent' } }, { itemId: 'old' }),
    ev('item.upsert', { kind: 'user-message', status: 'interrupted', content: { text, clientMessageId: 'draft', unsent: true } }, { itemId: 'draft' }),
    ev('input.receipt', { clientMessageId: 'draft', status: 'rejected' }),
    ev('path.changed', { previous: 'api', selected: 'terminal', reason: 'budget_exhausted' }),
  ]).model;
  const entry = { model, dismissed: null, noteDismissed: false, handoff: null };
  const harness = hookHarness('src/features/native-session/NativePathNote.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './native-session.css': {},
    './native-store.ts': { useNativeEntries: () => new Map([['t1', entry]]), terminalSwitch: load('features/native-session/native-store.ts').terminalSwitch, dismissNote: id => dismissed.push(id),
      resolveSwitch: load('features/native-session/native-store.ts').resolveSwitch, useSwitchNoteShown: () => true, dismissSwitchNote() {} },
    './native-words': words(), './native-bridge.ts': { copyNativeText: async value => { copied.push(value); return { ok: true }; } }, './SwitchNotice': load('features/native-session/SwitchNotice.tsx'),
  });
  try {
    const nodes = () => elements(harness.render('NativePathNote', { terminalId: 't1' }).result);
    const box = nodes().find(node => node.type === 'textarea');
    assert.equal(box.props.readOnly, true); assert.equal(box.props.value, text);
    assert.equal(nodes().filter(node => node.type === 'textarea').length, 1, 'sent messages are not recovery drafts');
    assert.equal(model.receipts.draft, 'rejected');
    nodes().find(node => node.type === 'button' && node.props.children === '复制未发送的消息').props.onClick(); await settle();
    assert.deepEqual(copied, [text]); assert.equal(model.receipts.draft, 'rejected', 'copying never changes delivery');
    nodes().find(node => node.type === 'button' && node.props.title === '知道了').props.onClick();
    assert.deepEqual(dismissed, ['t1']);
    entry.noteDismissed = true; assert.equal(harness.render('NativePathNote', { terminalId: 't1' }).result, null);
  } finally { harness.dispose(); }
});

// ---- the acceptance fixes -----------------------------------------------------------------------------------------------------------
test('the requests and the switch question stand at the end of the timeline on the agent’s own content edge, and a request grows in the conversation instead of scrolling inside its card', async () => {
  const html = await viewHtml(richSession), content = html.slice(html.indexOf('reading-content'), html.indexOf('class="reading-composer"'));
  assert.match(content, /<div class="native-tail">/); assert.ok(content.indexOf('reading-step is-agent') < content.indexOf('native-tail'), 'the request waits at the end of the conversation');
  assert.doesNotMatch(html, /reading-choice-host|native-summary|native-requests/, 'no host below the conversation whose card would scroll inside it');
  const css = fs.readFileSync(path.join(src, 'features/native-session/native-session.css'), 'utf8');
  assert.match(css, /\.native-tail \{[^}]*margin-left: var\(--reading-inset\);/, 'the same left edge as the reply text and the tool pills');
  assert.match(css, /\.native-tail \.native-request \{ max-height: none; overflow: visible; \}/, 'the base card’s 45vh cap and scrollbar are off');
  assert.doesNotMatch(await viewHtml(ev => [ev('session.state', { state: 'idle', reason: null })]), /native-tail/, 'nothing to show, no empty wrapper');
});

test('only what the reading view does not have stays in native-session.css', () => {
  const css = fs.readFileSync(path.join(src, 'features/native-session/native-session.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const classes = new Set(css.match(/\.native-[a-z-]+/g));
  assert.deepEqual([...classes].sort(), ['.native-ask', '.native-ended', '.native-error', '.native-path-note', '.native-path-summary', '.native-preview', '.native-request', '.native-switch', '.native-switch-question', '.native-switch-text', '.native-tail', '.native-unsent'].sort(),
    'no header, step, receipt, diff or plan style of its own');
});

test('a new request pulls the view to it even when the owner had scrolled up; an ordinary step does not', () => {
  const view = sessionView(idle, {});
  try {
    view.tree(); assert.equal(view.toBottom.length, 0);
    view.show([...idle(view.ev), view.ev('item.delta', { channel: 'text', text: 'one' }, { itemId: 'a1' })]); view.tree();
    assert.equal(view.toBottom.length, 0, 'an ordinary step is followed only by the reading view’s own stick-to-bottom');
    view.show([...idle(view.ev), view.ev('request.opened', { requestId: 'r1', kind: 'command', title: 'Run it' })]); view.tree();
    assert.equal(view.toBottom.length, 1, 'a request waiting for the owner is brought into view');
  } finally { view.done(); }
});

test('a command’s folder reads as its last two parts on one line with the whole path as the tooltip of the step’s line', async () => {
  const { shortPath } = words(), cwd = '/home/someone/work/very/long/path/to/the/project';
  assert.deepEqual([shortPath('/work'), shortPath('C:\\Users\\someone\\work\\very\\long\\path\\project\\sub'), shortPath(cwd)], ['/work', '…\\project\\sub', '…/the/project']);
  const html = await viewHtml(ev => [ev('session.state', { state: 'running', reason: null }), ev('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'npm test', cwd } }, { itemId: 'k' })]);
  assert.ok(html.includes('…/the/project')); assert.doesNotMatch(html.replace(/ title="[^"]*"/g, ''), /\/home\/someone/, 'the folder’s head is not drawn');
});

test('the message box always has a hint: the longest that fits, and the shortest when none does', async () => {
  try {
    fit.index = 0; assert.match(await viewHtml(ev => idle(ev)), /placeholder="给它发消息 · Enter 发送，Shift\+Enter 换行"/);
    fit.index = 9; assert.match(await viewHtml(ev => idle(ev)), /placeholder="发消息"/, 'a width that fits none of them still names the box');
  } finally { fit.index = 0; }
});

test('Codex falling back to the terminal leaves its reason where the native view stood, in words; the owner’s own choice of the terminal gives no reason to tell', async () => {
  const cases = [['codex_cli_required', '已改用终端 · 未找到 Codex 命令行，无法使用原生界面'], ['unsupported_codex_version', '已改用终端 · 这个 Codex 版本不支持原生界面'], ['some_new_code', '已改用终端'], [null, '已改用终端']];
  for (const [reason, words] of cases) {
    const ev = stream({ provider: 'codex', transport: 'codex-app-server' }), events = [ev('path.changed', { previous: null, selected: 'terminal', reason })];
    let html = '', shown = null;
    await withBridge({ onEvent: () => () => {}, snapshot: async () => ({ ok: true, value: { runtimeSessionId: 'rs1', lastSequence: 1, events } }) }, async store => {
      store.ensureNativeSession('t1'); await settle();
      shown = store.nativeShown(entriesOf(store).get('t1'));
      html = renderToStaticMarkup(React.createElement(load('features/native-session/NativePathNote.tsx').NativePathNote, { terminalId: 't1' }));
    });
    assert.equal(shown, false, 'the terminal’s own view takes the cell');
    assert.ok(html.includes(`<span>${words}</span>`), String(reason)); assert.doesNotMatch(html, /暂时不可用|some_new_code/, 'a reason nobody gave is not made up, and a code is not shown');
  }
});

// ---- the API usage card -------------------------------------------------------------------------------------------------------------
const words = () => load('features/native-session/native-words.ts');
const usageOf = (patch = {}) => ({
  month: '2026-11', apiRecords: true, todayUsdMicros: 1_230_000, monthUsdMicros: 12_400_000, estimated: true, budgetUsd: 50,
  agents: {
    claude: { path: 'api', reason: null, next: { path: 'api', reason: null }, connection: { kind: 'api', source: 'session init: ANTHROPIC_API_KEY', observedAt: 1 }, limits: { state: 'ready', limitsById: {}, ordinaryUsageAllowed: true } },
    codex: { path: 'native', reason: null, next: { path: 'native', reason: null }, connection: { kind: 'subscription', source: 'account/read: ChatGPT login', observedAt: 1 }, limits: { state: 'ready', ordinaryUsageAllowed: true, limitsById: { codex: { limitName: 'Codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAtMs: Date.now() + 3600_000 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAtMs: null } } } } },
  }, ...patch,
});

// The terminal in view when none runs an agent: no current agent, so no section has a context length or a round.
const quietTerminal = { id: 't1', agent: 'claude', codexActive: false, sessionId: null, agentUsage: null };
async function usageHtml(bridge, terminal = quietTerminal, projectId = 'p1') {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: bridge ? { nativeSession: bridge } : {} } });
  const harness = hookHarness('src/features/agents/ApiUsage.tsx', { './i18n': { t: fill }, './native-store.ts': { useUsageRevision: () => 0 }, './native-words': words(), './Metric': load('features/agents/Metric.tsx'), './ResetQuota': { ResetQuota: () => null }, './activity-pane.css': {} });
  try {
    harness.render('ApiUsage', { terminal, projectId }); await sleep(30);
    return renderToStaticMarkup(harness.render('ApiUsage', { terminal, projectId }).result);
  } finally { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; }
}

const usageSection = (html, agent) => {
  const section = html.match(new RegExp(`<section class="api-agent" aria-label="${agent}">([\\s\\S]*?)</section>`));
  assert.ok(section, `${agent} has its own named section`);
  return section[1];
};

test('the usage block groups Claude and Codex separately: only a connection row, spend and a set budget as a bar under an API connection, the subscription bars under a subscription, the last switch under its agent', async () => {
  const asked = [];
  const html = await usageHtml({ usage: async projectId => { asked.push(projectId); return { ok: true, value: usageOf() }; } });
  const claude = usageSection(html, 'Claude'), codex = usageSection(html, 'Codex');
  const labels = section => [...section.matchAll(/<dt>([^<]+)<\/dt>/g)].map(match => match[1]);
  assert.deepEqual(asked, ['p1'], 'the read is scoped to the project in view');
  assert.match(html, /<h3 class="activity-card-title">运行方式与额度<\/h3>/);
  assert.match(claude, /<h4[^>]*>Claude<\/h4>/); assert.match(codex, /<h4[^>]*>Codex<\/h4>/);
  assert.deepEqual(labels(claude), ['连接']); assert.deepEqual(labels(codex), ['连接']);
  assert.doesNotMatch(html, /最近切换/, 'the owner asked for no last-switch row, even after a switch');
  assert.doesNotMatch(html, /新会话/, 'the new-session row is gone, and so is the route it showed');
  assert.ok(claude.includes('<dt>连接</dt><dd><span title="session init: ANTHROPIC_API_KEY">已连接 API</span></dd>'), 'the connection source stays in its tooltip');
  assert.ok(codex.includes('<dt>连接</dt><dd><span title="account/read: ChatGPT login">ChatGPT 订阅</span></dd>'));
  // An API connection: the budget as a bar (a share of the month's spend) and the spend, never the subscription windows.
  assert.match(claude, /<span class="activity-metric-label">月预算<\/span><span class="activity-meter[^"]*" role="meter"[^>]*aria-valuenow="25"[^>]*>[\s\S]*?<b>25%<\/b><small>本月 \$12\.40 \/ \$50\.00<\/small>/);
  assert.match(claude, /<span class="activity-metric-label">API 花费<\/span><small>今日 \$1\.23 · 本月 \$12\.40 · 估算<\/small>/); assert.match(claude, /title="估算，按公开价格计算"/);
  assert.ok(claude.indexOf('月预算') < claude.indexOf('API 花费'));
  assert.doesNotMatch(claude, /5 小时额度|每周额度|额度来自/);
  // A subscription: the two windows as the same bars, never spend or a budget.
  assert.match(codex, /<span class="activity-metric-label">5 小时额度<\/span>[\s\S]*?aria-valuenow="40"[\s\S]*?<b[^>]*>40%<\/b><small>[^<]+ 重置<\/small>/);
  assert.match(codex, /<span class="activity-metric-label">每周额度<\/span>[\s\S]*?aria-valuenow="10"[\s\S]*?<b[^>]*>10%<\/b>/);
  assert.doesNotMatch(codex, /API 花费|月预算|最近切换/);
});

test('the usage block says 未知 for what nobody gave and keeps a real zero as $0.00', async () => {
  // Connection not known (an older main, or nothing running): the connection and the allowance both say so, and nothing is measured.
  const unknown = await usageHtml({ usage: async () => ({ ok: true, value: usageOf({ todayUsdMicros: 0, monthUsdMicros: null, budgetUsd: null, agents: {
    claude: { path: null, reason: null, next: { path: null, reason: null }, limits: null }, codex: { path: 'terminal', reason: null, limits: { state: 'rate_limited' } } } }) }) });
  for (const agent of ['Claude', 'Codex']) {
    const section = usageSection(unknown, agent);
    assert.match(section, /<dt>连接<\/dt><dd><span>未知<\/span><\/dd>/);
    assert.match(section, /<dt>额度<\/dt><dd><span>未知<\/span><\/dd>/, 'not connected or not known: 额度 未知');
    assert.doesNotMatch(section, /activity-metrics|role="meter"|API 花费|月预算|5 小时额度/);
  }
  assert.doesNotMatch(unknown, /最近切换|还没有切换过|新会话/);
  // An API connection: a real zero is $0.00; a missing amount is 未知; a budget with no known spend has no share and no bar; no budget says 未设置.
  const api = patch => usageHtml({ usage: async () => ({ ok: true, value: usageOf({ ...patch }) }) });
  const none = await api({ todayUsdMicros: 0, monthUsdMicros: null, budgetUsd: null });
  assert.match(none, /<small>今日 \$0\.00 · 本月 未知 · 估算<\/small>/); assert.match(none, /<span class="activity-metric-label">月预算<\/span><small>未设置<\/small>/); assert.doesNotMatch(usageSection(none, 'Claude'), /role="meter"/);
  const noShare = await api({ monthUsdMicros: null });
  assert.match(noShare, /<span class="activity-metric-label">月预算<\/span><b[^>]*>未知<\/b><small>本月 未知 \/ \$50\.00<\/small>/); assert.doesNotMatch(usageSection(noShare, 'Claude'), /role="meter"/, 'no spend, no share, no bar');
  assert.match(await api({ todayUsdMicros: null, monthUsdMicros: null }), /<small>今日 未知 · 本月 未知 · 估算<\/small>/, 'records with missing amounts stay unknown, never $0.00');
  // The warning colour only from 90%.
  assert.doesNotMatch(usageSection(await api({ monthUsdMicros: 44_000_000 }), 'Claude'), /is-warn/); assert.match(await api({ monthUsdMicros: 45_000_000 }), /activity-metric is-warn activity-figure/);
  // A rate-limited subscription with no window says so rather than a number.
  const limited = usageOf({  }); limited.agents.codex.limits = { state: 'rate_limited', limitsById: {} };
  assert.match(usageSection(await usageHtml({ usage: async () => ({ ok: true, value: limited }) }), 'Codex'), /<small>已限流，恢复时间未知<\/small>/);
});

test('the usage block distinguishes no API records from records with unknown or zero spend, and Codex on the API has none to show', async () => {
  const html = await usageHtml({ usage: async () => ({ ok: true, value: usageOf({ apiRecords: false, todayUsdMicros: null, monthUsdMicros: null, budgetUsd: null }) }) });
  assert.match(usageSection(html, 'Claude'), /<span class="activity-metric-label">API 花费<\/span><small>还没有 API 用量记录<\/small>/);
  assert.doesNotMatch(usageSection(html, 'Claude'), /估算|今日|本月|role="meter"|最近切换/);
  assert.doesNotMatch(usageSection(html, 'Codex'), /API 用量记录/);
  // Codex through the API: the same words and no budget (there is no spend record to measure one against).
  const codexApi = usageOf({  }); codexApi.agents.codex.connection = { kind: 'api', source: 'account/read: API key', observedAt: 1 };
  const codex = usageSection(await usageHtml({ usage: async () => ({ ok: true, value: codexApi }) }), 'Codex');
  assert.match(codex, /<span class="activity-metric-label">API 花费<\/span><small>还没有 API 用量记录<\/small>/);
  assert.doesNotMatch(codex, /月预算|5 小时额度|每周额度|role="meter"/);
});

test('the allowance of each agent follows its connection: the current session’s agent leads with the context and ends with the round, windows come from main with the session’s own as fallback', async () => {
  const future = Date.now() + 3600_000, tokens = { input: 496000, cached: 476000, output: 5100 };
  const current = (agent, extra = {}) => ({ id: 't1', agent, codexActive: true, sessionId: 's1', agentStartedAt: 1, agentUsage: { provider: null, limits: [], context: { used: 170000, window: 1000000 }, round: tokens, total: null, ...extra } });
  const usage = usageOf({ budgetUsd: null }), sub = { kind: 'subscription', source: null, observedAt: 1 };
  usage.agents.claude = { ...usage.agents.claude, connection: sub, limits: null };
  // The session's agent without windows from main falls back to what its own records gave; the other agent has neither context nor round.
  const fallback = await usageHtml({ usage: async () => ({ ok: true, value: usage }) }, current('claude', { limits: [{ minutes: 300, percent: 20, resetsAt: future }, { minutes: 10080, percent: 26, resetsAt: future }], limitsAt: Date.now(), limitsFrom: 'Claude Code' }));
  const claude = usageSection(fallback, 'Claude'), codex = usageSection(fallback, 'Codex');
  const order = ['上下文长度', '5 小时额度', '每周额度', '>本轮<', '额度来自 Claude Code'].map(text => claude.indexOf(text));
  assert.ok(order.every((position, i) => position >= 0 && (!i || position > order[i - 1])), 'context, the two windows, the round, then where the numbers come from');
  assert.match(claude, /aria-valuenow="20"/); assert.match(claude, /aria-valuenow="26"/); assert.match(claude, /aria-valuenow="17"/);
  assert.doesNotMatch(claude, /API 花费|月预算/, 'a subscription has no spend or budget');
  assert.doesNotMatch(codex, /上下文长度|>本轮<|>本次对话</, 'the other agent has no context or round');
  assert.match(codex, /5 小时额度/);
  // Windows from main come first: the session's own numbers do not replace them.
  const main = usageOf({  }); main.agents.claude = { ...main.agents.claude, connection: sub, limits: { state: 'ready', observedAtMs: Date.now(), limitsById: { five: { primary: { usedPercent: 33, windowDurationMins: 300, resetsAtMs: future }, secondary: null } } } };
  const preferred = usageSection(await usageHtml({ usage: async () => ({ ok: true, value: main }) }, current('claude', { limits: [{ minutes: 300, percent: 20, resetsAt: future }] })), 'Claude');
  assert.match(preferred, /aria-valuenow="33"/); assert.doesNotMatch(preferred, /aria-valuenow="20"/); assert.match(preferred, /额度来自 Claude，/);
  // A window nobody measured says 未知 (never 0), and an expired one waits for its next reading.
  const odd = usageOf({  }); odd.agents.codex.limits = { state: 'stale', limitsById: { a: { primary: { usedPercent: null, windowDurationMins: 300, resetsAtMs: null }, secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAtMs: Date.now() - 1000 } } } };
  const staleHtml = usageSection(await usageHtml({ usage: async () => ({ ok: true, value: odd }) }), 'Codex');
  assert.match(staleHtml, /<span class="activity-metric-label">5 小时额度<\/span><b[^>]*>未知<\/b>/); assert.doesNotMatch(staleHtml, /<b[^>]*>0%<\/b>/);
  assert.match(staleHtml, /已重置，等待更新/); assert.match(staleHtml, /数据可能已过期/);
  // Not connected: the connection and 额度 未知 and nothing to measure, even for the session's own agent.
  const idle = usageOf({  }); idle.agents.codex = { ...idle.agents.codex, connection: { kind: 'none', source: null, observedAt: 1 }, limits: null };
  const none = usageSection(await usageHtml({ usage: async () => ({ ok: true, value: idle }) }), 'Codex');
  assert.match(none, /<dt>连接<\/dt><dd><span[^>]*>未连接<\/span><\/dd>/); assert.match(none, /<dt>额度<\/dt><dd><span>未知<\/span><\/dd>/); assert.doesNotMatch(none, /role="meter"|5 小时额度/);
  assert.equal(words().nextPathWord, undefined, 'the route of the next session is not drawn any more, so its words are gone');
});

test('the connection in use reads in words per agent: Claude API / subscription / not connected, Codex ChatGPT subscription / API, and unknown as 未知', async () => {
  const { connectionWord } = words(), c = (kind, source = null) => ({ kind, source, observedAt: 1 });
  const kinds = ['api', 'subscription', 'none', 'unknown'];
  assert.deepEqual(kinds.map(kind => connectionWord('claude', c(kind)).text), ['已连接 API', '订阅（Claude Code 登录）', '未连接', '未知']);
  assert.deepEqual(kinds.map(kind => connectionWord('codex', c(kind)).text), ['API', 'ChatGPT 订阅', '未连接', '未知']);
  assert.deepEqual([connectionWord('claude', undefined), connectionWord('codex', null), connectionWord('claude', c('api', 'init'))], [{ text: '未知', source: null }, { text: '未知', source: null }, { text: '已连接 API', source: 'init' }]);
  const html = await usageHtml({ usage: async () => ({ ok: true, value: usageOf({ agents: {
    claude: { path: 'terminal', reason: null, next: { path: 'terminal', reason: 'set_terminal' }, limits: null, connection: c('subscription', 'terminal: Claude Code login') },
    codex: { path: 'terminal', reason: null, next: { path: 'terminal', reason: 'set_terminal' }, limits: null, connection: c('api', 'account/read: API key') } } }) }) });
  assert.ok(usageSection(html, 'Claude').includes('<dt>连接</dt><dd><span title="terminal: Claude Code login">订阅（Claude Code 登录）</span></dd>'));
  assert.ok(usageSection(html, 'Codex').includes('<dt>连接</dt><dd><span title="account/read: API key">API</span></dd>'));
});

test('a connection test reads as four lines, each with a tone and a next step for what failed, and nothing in it can carry the key', () => {
  const { connectionLines } = words(), required = '2.1.317';
  const good = { checkedAt: 1, key: { status: 'ok', detail: null, latencyMs: 182.4 }, models: ['claude-opus-5-5', 'a', 'b', 'c', 'd', 'e', 'f'], cli: { status: 'ok', version: '2.1.317', required }, path: 'api', reason: null };
  const lines = connectionLines(good);
  assert.deepEqual(lines.map(line => [line.id, line.tone, line.label, line.text, line.hint]), [
    ['key', 'ok', '密钥', '有效 · 182 ms', null], ['models', 'ok', '可用模型', 'claude-opus-5-5、a、b、c、d 等 7 个', null],
    ['cli', 'ok', 'Claude Code', '版本 2.1.317（满足 ≥ 2.1.317）', null], ['path', 'ok', '新会话将使用', 'API', null]]);
  const bad = connectionLines({ ...good, key: { status: 'invalid', detail: 'The key was refused.', latencyMs: 40 }, models: null, cli: { status: 'too_old', version: '2.0.0', required }, path: 'terminal', reason: 'no_key' });
  assert.deepEqual(bad.map(line => [line.id, line.tone, line.text]), [['key', 'bad', '无效'], ['models', 'warn', '未知'], ['cli', 'bad', '版本 2.0.0 过低（需要 ≥ 2.1.317）'], ['path', 'ok', '终端（订阅） · 还没有保存 API key']]);
  assert.match(bad[0].hint, /检查密钥/); assert.equal(bad[0].title, 'The key was refused.'); assert.equal(bad[2].hint, '请升级 Claude Code。');
  const hint = (status, detail = null) => connectionLines({ ...good, key: { status, detail, latencyMs: null } })[0];
  assert.deepEqual(['missing', 'forbidden', 'rate_limited', 'unreachable', 'error'].map(status => [hint(status).tone, hint(status).hint !== null]), [['bad', true], ['bad', true], ['warn', true], ['bad', true], ['bad', true]]);
  assert.match(hint('forbidden').hint, /权限/); assert.match(hint('unreachable').hint, /网络/); assert.match(hint('error', 'boom').hint, /boom/);
  assert.equal(hint('rate_limited').text, '被限流', 'a failed check shows no latency');
  const odd = connectionLines({ ...good, models: [], cli: { status: 'missing', version: null, required }, path: null });
  assert.deepEqual(odd.map(line => [line.tone, line.text]), [['ok', '有效 · 182 ms'], ['warn', '没有可用模型'], ['bad', '未找到'], ['warn', '未知']]);
  assert.match(odd[2].hint, /请安装 Claude Code（需要 ≥ 2\.1\.317）/);
  assert.doesNotMatch(JSON.stringify([lines, bad, odd]), /sk-ant/);
});

test('when main gives no usage (a read that failed or has not come back, a project it cannot answer for, no bridge) the current session’s context, bars and tokens stay, and the connection and the allowance read 未知', async () => {
  const future = Date.now() + 3600_000, round = { input: 496000, cached: 476000, output: 5100 };
  const session = { id: 't1', agent: 'claude', codexActive: true, sessionId: null, agentStartedAt: 1, agentUsage: { provider: null, limits: [{ minutes: 300, percent: 20, resetsAt: future }], limitsAt: Date.now(), limitsFrom: 'Claude Code', context: { used: 170000, window: 1000000 }, round, total: null } };
  for (const bridge of [{ usage: async () => ({ ok: false, error: 'native sessions are local only' }) }, { usage: async () => new Promise(() => {}) }, null]) {
    const html = await usageHtml(bridge, session), claude = usageSection(html, 'Claude'), codex = usageSection(html, 'Codex');
    assert.match(claude, /上下文长度/); assert.match(claude, /aria-valuenow="17"/); assert.match(claude, /5 小时额度/); assert.match(claude, />本轮</, 'its context, bar and round are the session’s own');
    assert.match(claude, /连接<\/dt><dd><span>未知<\/span>/); assert.doesNotMatch(codex, /上下文长度|>本轮</); assert.match(codex, /连接<\/dt><dd><span>未知<\/span>/);
    assert.equal((html.match(/role="alert"/g) ?? []).length, bridge?.usage.toString().includes('local only') ? 1 : 0, 'an error is one line, not the whole block');
  }
  assert.match(await usageHtml({ usage: async () => ({ ok: false, error: 'locked' }) }), /role="alert">无法读取额度：locked/, 'a failed read says so');
  assert.equal(await usageHtml(null), '', 'a window without the bridge and without a session shows no card');
  assert.match(await usageHtml(null, { ...session, agentUsage: null }), /上下文长度/, 'a session that has not answered yet says its context comes with the first reply');
});

test('a failed read says so, a window without the bridge shows no card, and limits read as their provider gave them', async () => {
  assert.match(await usageHtml({ usage: async () => ({ ok: false, error: 'locked' }) }), /role="alert">无法读取额度：locked/);
  assert.equal(await usageHtml(null), '');
  const { limitLines } = load('features/agents/ApiUsage.tsx'), soon = Date.now() + 3600_000;
  assert.match(limitLines({ state: 'rate_limited', limitsById: { api: { primary: { usedPercent: 100, windowDurationMins: 60, resetsAtMs: soon } } } })[0], /^已限流，约 .+ 恢复$/);
  assert.deepEqual(limitLines({ ordinaryUsageAllowed: false }), ['已限流，恢复时间未知']);
  assert.deepEqual(limitLines({ state: 'unavailable' }), ['暂时读不到']);
  assert.deepEqual(limitLines(null), ['未知']);
  assert.deepEqual(limitLines({ state: 'stale', limitsById: { a: { primary: { usedPercent: 5, windowDurationMins: 60, resetsAtMs: null } } } }), ['1 小时 · 已用 5% · 未知 重置', '数据可能已过期']);
});

// ---- the run-mode switch (r12) -------------------------------------------------------------------------------------------------------
const switchState = (patch = {}) => ({ changeId: 3, current: 'api', target: 'terminal', phase: 'waiting-turn', background: { count: null, known: false }, requestId: null, reason: null, ...patch });

test('switch words: the header says where a change goes and when, a failure says the session stayed, and an unknown background count is never a number', () => {
  const words = load('features/native-session/native-words.ts'), line = patch => words.switchLine(switchState(patch));
  assert.equal(line(), '本轮结束后切到 终端');
  assert.equal(line({ target: 'native' }), '本轮结束后切到 原生'); assert.equal(line({ target: 'api' }), '本轮结束后切到 API');
  assert.equal(line({ reason: '输入框里有未发送的文字' }), '输入框里有未发送的文字', 'a reason from main is the line');
  assert.equal(line({ phase: 'waiting-background' }), '等后台任务结束后再切到 终端');
  assert.deepEqual(['preparing', 'switching'].map(phase => line({ phase })), ['正在切到 终端', '正在切到 终端']);
  assert.deepEqual(['stable', 'awaiting-choice', 'rolling-back'].map(phase => line({ phase })), [null, null, null], 'nothing under way, the question has its card and a failure its note');
  assert.equal(words.switchLine(null), null);
  const failure = patch => words.switchNote(switchState({ phase: 'rolling-back', ...patch }));
  assert.equal(failure(), '没有切换成功，仍使用 API'); assert.equal(failure({ reason: 'native_cli_required' }), '没有切换成功，仍使用 API · 未找到原生 Claude Code，无法通过 API 运行');
  const settled = patch => words.switchNote(switchState({ phase: 'stable', ...patch }));
  assert.equal(settled({ outcome: 'failed', reason: '终端没有启动' }), '没有切换成功，仍使用 API · 终端没有启动', 'only the outcome failed says the switch failed');
  assert.equal(settled({ reason: '终端没有启动' }), null, 'a reason alone is not a failure: an ended change that gives no outcome says nothing');
  assert.equal(settled({ outcome: 'switched', reason: '旧进程没有正常退出' }), '旧进程没有正常退出', 'switched with a reason is a switch that worked, told as the warning it is');
  assert.deepEqual([settled({ outcome: 'switched' }), settled({ outcome: 'restored' }), settled({ outcome: 'stopped' })], [null, null, null], 'no reason, nothing to tell');
  assert.deepEqual([settled({ outcome: 'restored', reason: '已恢复到原来的会话' }), settled({ outcome: 'stopped', reason: '会话已停止，没有切换' })], ['已恢复到原来的会话', '会话已停止，没有切换'], 'a restore or a stop says its reason, not that it failed');
  assert.doesNotMatch(String(settled({ outcome: 'switched', reason: 'native_cli_required' })), /没有切换成功/);
  assert.deepEqual([failure({ phase: 'waiting-turn', reason: '输入框里有未发送的文字' }), words.switchNote(switchState({ phase: 'waiting-turn', outcome: 'failed', reason: 'x' })), words.switchNote(null)], [null, null, null], 'a change still waiting is not an ended one');
  const background = (count, known) => words.backgroundWords({ count, known });
  assert.equal(background(2, true), '切换会结束 2 个后台任务。'); assert.equal(background(0, true), '切换会结束 0 个后台任务。', 'a real zero is a zero');
  for (const unknown of [background(null, false), background(3, false), background(null, true)]) { assert.match(unknown, /还不知道/); assert.doesNotMatch(unknown, /\d/, 'unknown is not a number'); }
});

test('resolveSwitch: ProjectTerminal’s state and the event stream’s are one state; the newer change wins, then the later phase, and a finished session has none', () => {
  const { resolveSwitch } = load('features/native-session/native-store.ts'), entry = (state, session = { state: 'running', reason: null }) => ({ model: { switchState: state, session } });
  const a = switchState({ phase: 'waiting-turn' }), b = switchState({ phase: 'preparing' }), later = switchState({ changeId: 4, phase: 'waiting-turn' });
  assert.deepEqual([resolveSwitch(null, undefined), resolveSwitch(a, undefined), resolveSwitch(undefined, entry(b)), resolveSwitch(null, entry(null))], [null, a, b, null]);
  assert.equal(resolveSwitch(a, entry(b)), b, 'inside one change the later phase is the newer copy, from either side');
  assert.equal(resolveSwitch(b, entry(a)), b);
  assert.equal(resolveSwitch(later, entry(switchState({ phase: 'switching' }))), later, 'a newer change beats an older change’s later phase');
  assert.equal(resolveSwitch(a, entry(later)), later);
  assert.equal(resolveSwitch(null, entry(b, { state: 'stopped', reason: 'user' })), null, 'a finished session is not on its way anywhere');
});

test('the store folds switch.updated and a snapshot’s switch state into the entry, a settled change asks again for its draft, and a draft is taken once', async () => {
  const ev = stream(), waiting = switchState(), prepare = switchState({ phase: 'preparing' }), stable = switchState({ phase: 'stable' });
  const first = [ev('session.state', { state: 'idle' }), ev('switch.updated', waiting)];
  const draft = { version: 2, text: 'keep me', images: [], undelivered: [{ clientMessageId: 'c1', text: 'never sent' }] };
  let emit = null, calls = 0, reply = () => ({ ok: true, value: { runtimeSessionId: 'rs1', lastSequence: first.length, events: first, state: 'idle' } });
  const bridge = { onEvent: listener => { emit = listener; return () => {}; }, snapshot: async () => { calls++; return reply(); } };
  await withBridge(bridge, async store => {
    store.ensureNativeSession('t1'); await settle();
    assert.deepEqual([entriesOf(store).get('t1').model.switchState.phase, calls], ['waiting-turn', 1]);
    emit(ev('switch.updated', prepare)); await settle();
    assert.deepEqual([entriesOf(store).get('t1').model.switchState.phase, calls], ['preparing', 1], 'a live update changes the state without asking again');
    reply = () => ({ ok: true, value: { runtimeSessionId: 'rs1', lastSequence: 4, events: [...first, ev('session.state', { state: 'idle' })], state: 'idle', switchState: stable, handoff: { changeId: 3, draft } } });
    emit(ev('switch.updated', stable)); await sleep(400);
    assert.equal(calls, 2, 'a settled change asks for the snapshot, which may carry the draft');
    assert.equal(entriesOf(store).get('t1').model.switchState.phase, 'stable'); assert.deepEqual(entriesOf(store).get('t1').handoff.draft, draft);
    assert.deepEqual(store.takeHandoff('t1'), draft); assert.equal(store.takeHandoff('t1'), null, 'once');
    store.refreshNativeSession('t1'); await settle();
    assert.equal(entriesOf(store).get('t1').handoff, null, 'the same change in a later snapshot does not bring the words back');
    emit(ev('switch.updated', stable, { replay: true })); await sleep(400);
    assert.equal(calls, 3, 'a replayed settle is not news (only the explicit refresh asked)');
  });
});

test('a live switch.updated moves the usage count of waiting sessions; a replayed one does not', async () => {
  const ev = stream(), bridge = { onEvent: listener => { bridge.emit = listener; return () => {}; }, snapshot: async () => ({ ok: true, value: null }) };
  await withBridge(bridge, async store => {
    store.ensureNativeSession('t1'); await settle();
    bridge.emit(ev('switch.updated', switchState(), { replay: true })); assert.equal(read(store.useUsageRevision), 0);
    bridge.emit(ev('switch.updated', switchState({ phase: 'preparing' }))); assert.equal(read(store.useUsageRevision), 1);
  });
});

function noticeView(bridge) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: { nativeSession: bridge } } });
  const harness = hookHarness('src/features/native-session/SwitchNotice.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './native-session.css': {}, './native-store.ts': { resolveSwitch: (terminal, entry) => terminal ?? entry?.model.switchState ?? null, useNativeEntries: () => new Map() },
    './native-words': words(), './native-bridge.ts': { nativeBridge: () => bridge },
  });
  const question = (state, sessionId = 'rs1') => elements(harness.render('SwitchQuestion', { terminalId: 't1', sessionId, state }).result);
  const button = (state, label, sessionId) => question(state, sessionId).find(node => node.type === 'button' && node.props.children === label);
  return { harness, question, button, done() { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; } };
}
const asking = (patch = {}) => switchState({ phase: 'awaiting-choice', requestId: 'rq1', background: { count: 2, known: true }, ...patch });

test('the question card shows only while main asks, says what a switch ends, and sends the owner’s choice with the change and request it was asked for', async () => {
  const answers = [], view = noticeView({ answer: async (...args) => { answers.push(args); return { ok: true, value: {} }; } });
  try {
    for (const state of [null, switchState(), asking({ requestId: null }), asking({ phase: 'waiting-background', requestId: null }), asking({ phase: 'stable' })]) assert.deepEqual(view.question(state), [], JSON.stringify(state));
    const nodes = view.question(asking());
    assert.equal(nodes.find(node => node.type === 'section').props.className, 'reading-choice native-request native-switch-question', 'the request card’s look');
    assert.equal(nodes.find(node => node.type === 'strong').props.children, '现在切到 终端？'); assert.equal(nodes.find(node => node.props?.className === 'native-switch-text').props.children, '切换会结束 2 个后台任务。');
    assert.deepEqual(nodes.filter(node => node.type === 'button').map(node => node.props.children), ['等它们结束', '现在切换']);
    assert.equal(answers.length, 0, 'it waits for the owner’s click');
    view.button(asking(), '等它们结束').props.onClick(); await settle();
    assert.deepEqual(answers, [['t1', 'rs1', 'rq1', { switch: { changeId: 3, requestId: 'rq1', action: 'wait' } }]]);
    assert.equal(view.button(asking(), '现在切换').props.disabled, true, 'shut while the answer is with main'); view.button(asking(), '现在切换').props.onClick(); await settle();
    assert.equal(answers.length, 1, 'one answer per question');
    assert.equal(view.button(asking({ phase: 'waiting-background' }), '现在切换').props.disabled, false, 'after 等它们结束 the same request in the waiting phase can still switch now');
    assert.equal(view.button(asking({ requestId: 'rq2' }), '现在切换').props.disabled, false, 'a new question is a new card');
    view.button(asking({ requestId: 'rq2' }), '现在切换').props.onClick(); await settle();
    assert.deepEqual(answers.at(-1), ['t1', 'rs1', 'rq2', { switch: { changeId: 3, requestId: 'rq2', action: 'now' } }]);
    assert.deepEqual(view.question(asking({ phase: 'waiting-background' })).filter(node => node.type === 'button').map(node => node.props.children), ['现在切换'], 'while it waits for the tasks, the owner can still switch now');
    view.button(asking({ phase: 'waiting-background', requestId: 'rq9' }), '现在切换').props.onClick(); await settle();
    assert.deepEqual(answers.at(-1), ['t1', 'rs1', 'rq9', { switch: { changeId: 3, requestId: 'rq9', action: 'now' } }]);
    const bare = view.question(asking({ background: { count: 0, known: false } })).find(node => node.props?.className === 'native-switch-text').props.children;
    assert.match(bare, /还不知道/); assert.doesNotMatch(bare, /\d/, 'unknown background state is not “0 tasks”');
    view.button(asking({ requestId: 'rq3' }), '现在切换', null).props.onClick(); await settle();
    assert.equal(answers.at(-1)[1], 't1', 'a terminal session has no runtime id: main finds it by the terminal');
  } finally { view.done(); }
});

test('a refused answer opens the question again with the reason', async () => {
  const view = noticeView({ answer: async () => ({ ok: false, error: 'the change has moved on' }) });
  try {
    view.button(asking(), '等它们结束').props.onClick(); await settle();
    assert.equal(view.question(asking()).find(node => node.props?.role === 'alert').props.children, 'the change has moved on');
    assert.equal(view.button(asking(), '等它们结束').props.disabled, false, 'and it can be answered again');
  } finally { view.done(); }
  const thrown = noticeView({ answer: async () => { throw new Error('ipc closed'); } });
  try { thrown.button(asking(), '现在切换').props.onClick(); await settle(); assert.equal(thrown.question(asking()).find(node => node.props?.role === 'alert').props.children, 'ipc closed'); } finally { thrown.done(); }
});

test('an answer main ignores as late ({accepted: false}) is not an answer taken: the card opens again and says so', async () => {
  const view = noticeView({ answer: async () => ({ ok: true, value: { accepted: false } }) });
  try {
    view.button(asking(), '现在切换').props.onClick(); await settle();
    assert.equal(view.question(asking()).find(node => node.props?.role === 'alert').props.children, '这个选择已经过期，没有生效。');
    assert.equal(view.button(asking(), '现在切换').props.disabled, false);
  } finally { view.done(); }
});

test('the switch line and the question stand at the end of the timeline, not in a header, and neither is a request', () => {
  const view = sessionView(idle, {});
  try {
    assert.equal(elements(view.tree()).some(node => node.props?.className === 'native-tail'), false, 'nothing under way: nothing is added');
    view.switching(switchState({ phase: 'waiting-turn' }));
    const nodes = elements(view.tree()), tail = nodes.find(node => node.props?.className === 'native-tail');
    assert.ok(tail, 'a line under way has its place in the conversation'); assert.equal(elements(tail.props.children).filter(node => node.props?.state?.phase === 'waiting-turn').length, 2, 'the line and the question read the state');
    assert.equal(nodes.some(node => node.props?.request), false, 'the question is not a request');
    view.switching(asking());
    const asked = elements(view.tree()).find(node => node.props?.className === 'native-tail');
    assert.ok(asked, 'the question has its place in the conversation'); assert.equal(elements(asked.props.children).filter(node => node.props?.state?.phase === 'awaiting-choice').length, 2);
    view.switching(asking({ phase: 'waiting-background' }));
    assert.equal(elements(view.tree()).some(node => node.props?.className === 'native-tail'), true, 'while it waits, the owner can still switch now');
    assert.equal(view.decorations().status, null, 'a switch under way is no round in progress'); assert.equal(view.toBottom.length, 1, 'the question is brought into view once');
  } finally { view.done(); }
});

test('a draft carried into the native view lands in the empty box, beside typed words otherwise, with its pictures and unsent messages; nothing is sent', async () => {
  const sends = [], view = sessionView(idle, { send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } });
  const texts = () => elements(view.tree()).filter(node => node.type === 'li').map(node => node.props.children[0]);
  const take = node => node.type === 'button' && node.props.children === '取回';
  const attached = () => elements(view.tree()).find(node => node.type === view.parts.UserImages)?.props.images;
  try {
    view.handoff.incoming = { version: 1, text: 'half a thought', images: ['data:image/png;base64,AAAA'], undelivered: [{ clientMessageId: 'u1', text: 'refused earlier' }, { clientMessageId: 'u2', text: 'second', images: ['data:image/png;base64,BBBB'] }] };
    view.tree(); await settle(); view.tree();
    assert.equal(view.box().props.value, 'half a thought'); assert.deepEqual(texts(), ['refused earlier', 'second']);
    assert.equal(view.handoff.taken, 1, 'taken once'); assert.deepEqual(sends, [], 'arrival sends nothing');
    assert.deepEqual(attached(), ['data:image/png;base64,AAAA'], 'the picture waits with the next message');
    assert.equal(elements(view.tree()).find(take).props.disabled, true, 'the box is not empty: nothing replaces it');
    view.type(''); view.tree();
    elements(view.tree()).find(take).props.onClick(); view.tree();
    assert.equal(view.box().props.value, 'refused earlier'); assert.deepEqual(texts(), ['second']);
    view.press(); await settle(); view.tree();
    assert.equal(sends.length, 1); assert.deepEqual(sends[0].slice(0, 2), ['t1', 'rs1']); assert.equal(sends[0][3], 'refused earlier'); assert.deepEqual(sends[0][4], ['data:image/png;base64,AAAA'], 'the carried picture goes with the owner’s own send');
    view.type('typing now'); view.tree();
    view.handoff.incoming = { version: 2, text: 'new words', images: [], undelivered: [] };
    view.tree(); await settle(); view.tree();
    assert.equal(view.box().props.value, 'typing now', 'typed words stay'); assert.deepEqual(texts(), ['second', 'new words'], 'the carried words wait beside them, unsent');
  } finally { view.done(); }
});

test('a draft that comes back to the box it left (a switch that failed) is shown once: in the box, its picture once, and a message that is still here as lost is not listed again', async () => {
  const sends = [], view = sessionView(idle, { send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } });
  const texts = () => elements(view.tree()).filter(node => node.type === 'li').map(node => node.props.children[0]);
  const attached = () => elements(view.tree()).find(node => node.type === view.parts.UserImages)?.props.images;
  try {
    view.type('half a thought'); view.tree();
    view.type('refused'); view.press(); await settle();
    const id = sends[0][2];
    view.show([...idle(view.ev), view.ev('item.upsert', { kind: 'user-message', status: 'interrupted', content: { text: 'refused', clientMessageId: id, unsent: true } }, { itemId: id })]);
    view.type('half a thought'); view.tree();
    view.handoff.incoming = { version: 3, text: 'half a thought', images: ['data:image/png;base64,AAAA'], undelivered: [{ clientMessageId: id, text: 'refused' }, { clientMessageId: 'old', text: 'from before' }] };
    view.tree(); await settle(); view.tree();
    view.handoff.incoming = { version: 4, text: 'half a thought', images: ['data:image/png;base64,AAAA'], undelivered: [{ clientMessageId: 'old', text: 'from before' }] };
    view.tree(); await settle(); view.tree();
    assert.equal(view.box().props.value, 'half a thought'); assert.deepEqual(texts(), ['from before'], 'the words are in the box and in no list; the refused message is its card’s alone');
    assert.deepEqual(attached(), ['data:image/png;base64,AAAA']);
  } finally { view.done(); }
});

test('the native view offers its draft to a switch: the words, the pictures and only the messages main refused; and its input shuts only when main accepts', async () => {
  const view = sessionView(idle, { send: async () => ({ ok: true, value: {} }) });
  try {
    view.tree(); view.type('draft one'); view.tree();
    assert.deepEqual(view.handoff.offers.at(-1), { text: 'draft one', images: [], undelivered: [] });
    view.type('sent words'); view.tree(); view.press(); await settle(); view.tree();
    assert.deepEqual(view.handoff.offers.at(-1), { text: '', images: [], undelivered: [] }, 'a message in flight is not offered: it may arrive');
    assert.equal(view.box().props.disabled, false, 'until main accepts, the old input stays as it was');
    view.handoff.locked = true; view.tree();
    assert.equal(view.box().props.disabled, true); assert.equal(view.box().props.placeholder, '正在切换运行方式，稍后继续');
  } finally { view.done(); }
});

test('a card nobody offers a draft for (the raw terminal) hands main an empty draft, so its switch is never left preparing; a picture main would refuse stays out of the draft instead of stopping it', async () => {
  const answers = [], hook = handoffHook({ answer: async (...args) => { answers.push(args); return { ok: true, value: { changeId: 3, version: 0, accepted: true } }; } }, { state: switchState({ phase: 'preparing' }), identity: { runtimeSessionId: 'rs7' } });
  try {
    hook.render(); await settle();
    assert.deepEqual(answers, [['t1', 'rs7', 'handoff-3', { handoff: { changeId: 3, draft: { version: 0, text: '', images: [], undelivered: [] } } }]], 'with no view, an empty draft; the session is the one the window knows');
    assert.equal(hook.render().locked, true);
  } finally { hook.done(); }
  const seen = [], pictures = handoffHook({ answer: async (...args) => { seen.push(args[3]); return { ok: true, value: {} }; } }, { state: switchState({ phase: 'waiting-turn' }) });
  try {
    pictures.render().offer({ text: 'x', images: ['data:image/gif;base64,AAAA', 'data:image/png;base64,BBBB'], undelivered: [{ clientMessageId: 'u', text: 'y', images: ['data:image/gif;base64,AAAA'] }] });
    pictures.set({ state: switchState({ phase: 'preparing' }) }); pictures.render(); await settle();
    assert.deepEqual(seen.at(-1).handoff.draft, { version: 1, text: 'x', images: ['data:image/png;base64,BBBB'], undelivered: [{ clientMessageId: 'u', text: 'y', images: [] }] });
  } finally { pictures.done(); }
});

function handoffHook(bridge, current) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window'), taken = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: { nativeSession: bridge } } });
  const harness = hookHarness('src/features/native-session/draft-handoff.ts', {
    './native-bridge.ts': { nativeBridge: () => bridge },
    './native-store.ts': { resolveSwitch: terminal => terminal, useNativeEntries: () => new Map([['t1', { model: current.identity ? { identity: current.identity } : {}, handoff: current.incoming ? { changeId: 9, draft: current.incoming } : null }]]), takeHandoff: id => { taken.push(id); return current.incoming; } },
  });
  return { render: () => harness.render('useHandoff', 't1', null, current.state).result, taken, set(patch) { Object.assign(current, patch); }, done() { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; } };
}

test('the draft goes to main once per version when a switch prepares, only an accepted receipt for the latest version shuts the input, and a failed switch opens it again', async () => {
  const answers = []; let receipt = { ok: true, value: { changeId: 3, version: 1, accepted: false } };
  const hook = handoffHook({ answer: async (...args) => { answers.push(args); return receipt; } }, { state: switchState({ phase: 'waiting-turn' }) });
  try {
    let handoff = hook.render(); handoff.offer({ text: 'one', images: [], undelivered: [] });
    hook.render(); await settle();
    assert.deepEqual(answers, [], 'nothing leaves while the switch only waits'); assert.equal(handoff.locked, false);
    hook.set({ state: switchState({ phase: 'preparing' }) }); hook.render(); await settle();
    assert.deepEqual(answers, [['t1', 't1', 'handoff-3', { handoff: { changeId: 3, draft: { version: 1, text: 'one', images: [], undelivered: [] } } }]]);
    assert.equal(hook.render().locked, false, 'not accepted: the old input is untouched');
    hook.render(); await settle(); assert.equal(answers.length, 1, 'the same version is not sent twice');
    handoff = hook.render(); handoff.offer({ text: 'one two', images: ['data:image/png;base64,AAAA'], undelivered: [{ clientMessageId: 'w1', text: 'not delivered' }] });
    receipt = { ok: true, value: { changeId: 3, version: 2, accepted: true } };
    hook.render(); await settle(); hook.render();
    assert.equal(answers.length, 2); assert.deepEqual(answers[1][3].handoff.draft, { version: 2, text: 'one two', images: ['data:image/png;base64,AAAA'], undelivered: [{ clientMessageId: 'w1', text: 'not delivered' }] });
    assert.equal(hook.render().locked, true, 'accepted: the old input shuts while the switch goes');
    hook.set({ state: switchState({ phase: 'switching' }) }); assert.equal(hook.render().locked, true);
    hook.set({ state: switchState({ phase: 'rolling-back' }) }); assert.equal(hook.render().locked, false, 'a switch that fails gives the input back');
    hook.set({ state: switchState({ changeId: 4, phase: 'preparing' }) }); assert.equal(hook.render().locked, false, 'a new change is a new handoff');
  } finally { hook.done(); }
});

test('a receipt for an older version shuts nothing, and a refused or throwing answer is offered again with the next update of the switch', async () => {
  const pending = [], offer = text => ({ text, images: [], undelivered: [] }), accepted = version => ({ ok: true, value: { changeId: 3, version, accepted: true } });
  const hook = handoffHook({ answer: (...args) => new Promise(resolve => pending.push({ version: args[3].handoff.draft.version, resolve })) }, { state: switchState({ phase: 'waiting-turn' }) });
  try {
    const handoff = hook.render(); handoff.offer(offer('a')); hook.set({ state: switchState({ phase: 'preparing' }) }); hook.render(); handoff.offer(offer('ab')); hook.render();
    assert.deepEqual(pending.map(call => call.version), [1, 2]);
    pending[0].resolve(accepted(1)); await settle();
    assert.equal(hook.render().locked, false, 'version 1 was accepted but the draft is already at version 2');
    pending[1].resolve({ ok: false, error: 'busy' }); await settle();
    hook.set({ state: switchState({ phase: 'preparing', reason: 'again' }) }); hook.render(); await settle();
    assert.deepEqual(pending.map(call => call.version), [1, 2, 2], 'a refused answer is offered again with the next update');
    pending[2].resolve(Promise.reject(new Error('ipc'))); await settle();
    hook.set({ state: switchState({ phase: 'preparing', reason: 'and again' }) }); hook.render(); await settle();
    assert.equal(pending.length, 4, 'so is one that threw'); assert.equal(hook.render().locked, false);
    pending[3].resolve(accepted(2)); await settle();
    assert.equal(hook.render().locked, true);
  } finally { hook.done(); }
  const quiet = handoffHook({ answer: async () => { throw new Error('never asked'); } }, { state: null });
  try { const handoff = quiet.render(); handoff.offer(offer('x')); quiet.render(); await settle(); assert.equal(quiet.render().locked, false); } finally { quiet.done(); }
});

test('the draft that arrives is read from the entry and handed over by take', () => {
  const hook = handoffHook({}, { state: null, incoming: { version: 1, text: 'back', images: [], undelivered: [] } });
  try {
    const handoff = hook.render();
    assert.equal(handoff.incoming.text, 'back'); assert.equal(handoff.take().text, 'back'); assert.deepEqual(hook.taken, ['t1']);
  } finally { hook.done(); }
});

test('a failed switch is told in the path note whichever transport the card is on, until the owner closes it; the move-to-terminal note is still the terminal’s only', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream(), store = load('features/native-session/native-store.ts');
  const model = applyEvents(emptyModel(), [ev('session.state', { state: 'idle' }), ev('path.changed', { previous: 'api', selected: 'terminal', reason: 'budget_exhausted' })]).model;
  const entry = { model, dismissed: null, noteDismissed: false, handoff: null }, dismissed = []; let shown = true;
  const harness = hookHarness('src/features/native-session/NativePathNote.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './native-session.css': {}, './native-words': words(), './native-bridge.ts': { copyNativeText: async () => ({ ok: true }) }, './SwitchNotice': load('features/native-session/SwitchNotice.tsx'),
    './native-store.ts': { useNativeEntries: () => new Map([['t1', entry]]), terminalSwitch: store.terminalSwitch, dismissNote: () => dismissed.push('path'), resolveSwitch: store.resolveSwitch, useSwitchNoteShown: () => shown, dismissSwitchNote: (id, state) => dismissed.push([id, state.changeId]) },
  });
  const note = props => harness.render('NativePathNote', { terminalId: 't1', ...props }).result;
  const text = props => { const result = note(props); return result && elements(result).find(node => node.type === 'span')?.props.children; };
  try {
    const failed = switchState({ phase: 'rolling-back', reason: '终端没有启动' });
    assert.equal(text({ terminalActive: false, switchState: failed }), '没有切换成功，仍使用 API · 终端没有启动', 'a native card has no terminal move to tell, but a failure it does');
    assert.equal(text({ terminalActive: false }), null, 'a native card says nothing about the terminal move'); assert.match(text({ terminalActive: true }), /已改用终端/);
    assert.match(text({ terminalActive: true, switchState: failed }), /没有切换成功/, 'the failure of the change in hand comes first');
    elements(note({ switchState: failed })).find(node => node.props?.title === '知道了').props.onClick();
    assert.deepEqual(dismissed, [['t1', 3]], 'closing it is for that change');
    shown = false; assert.match(text({ terminalActive: true, switchState: failed }), /已改用终端/, 'closed: the older note is not hidden by it');
    assert.equal(text({ terminalActive: false, switchState: failed }), null);
    assert.equal(text({ terminalActive: false, switchState: switchState({ phase: 'preparing' }) }), null, 'a switch under way is not a failure');
  } finally { harness.dispose(); }
});

test('every card holds its draft handoff, whatever it shows: the raw terminal, the reading view and the native view alike, so a switch never waits for a view that is not there', () => {
  const handoffs = [], state = switchState({ phase: 'preparing' });
  gridMarkup([terminal('t1', { sessionId: 's1', codexActive: true, switchState: state, nativeRuntimeSessionId: 'rs1' }), terminal('t2'), terminal('t3', { switchState: state })], { focused: true, native: ['t3'], handoffs });
  assert.deepEqual(handoffs.sort(), [['t1', 'rs1', 'preparing'], ['t2', null, null], ['t3', null, 'preparing']], 'one per card, with its own switch state');
  const grid = fs.readFileSync(path.join(src, 'features/terminal/ProjectTerminals.tsx'), 'utf8');
  assert.equal((grid.match(/useHandoff\(/g) ?? []).length, 1, 'one place holds it');
  assert.doesNotMatch(fs.readFileSync(path.join(src, 'features/native-session/NativeSessionView.tsx'), 'utf8'), /useHandoff\(/, 'and the native view takes it from the card like the reading view');
});

test('the grid hands each card’s switch state to the note over it and to the native view, on both transports', () => {
  const state = switchState({ phase: 'preparing' });
  const term = gridMarkup([terminal('t1', { sessionId: 's1', codexActive: true, switchState: state })]);
  assert.match(term, /class="note-stub" data-terminal="t1" data-phase="preparing" data-active="true"/);
  const native = gridMarkup([terminal('t1', { switchState: state })], { native: ['t1'] });
  assert.match(native, /class="native-stub" data-terminal="t1" data-phase="preparing"/, 'the native view draws its own line in its header');
  assert.match(native, /class="note-stub" data-terminal="t1" data-phase="preparing" data-active="false"/, 'the failure note reaches a native card too');
  assert.match(gridMarkup([terminal('t1', { sessionId: 's1' })]), /data-phase=""/, 'no switch, no state');
});

test('over a terminal card the path note carries the switch line and the question, in one frame with the other notes; over a native card it leaves them to the view', () => {
  const store = load('features/native-session/native-store.ts'), SwitchLine = () => null, SwitchQuestion = () => null;
  const harness = hookHarness('src/features/native-session/NativePathNote.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './native-session.css': {}, './native-words': words(), './native-bridge.ts': { copyNativeText: async () => ({ ok: true }) },
    './native-store.ts': { useNativeEntries: () => new Map(), terminalSwitch: store.terminalSwitch, dismissNote() {}, resolveSwitch: store.resolveSwitch, useSwitchNoteShown: () => true, dismissSwitchNote() {} },
    './SwitchNotice': { asksChoice: state => state?.phase === 'awaiting-choice' && !!state.requestId, SwitchLine, SwitchQuestion },
  });
  const frame = props => harness.render('NativePathNote', { terminalId: 't1', ...props }).result;
  const parts = result => elements(result).filter(node => node.type === SwitchLine || node.type === SwitchQuestion).map(node => [node.type === SwitchLine ? 'line' : 'question', node.props.sessionId ?? null, node.props.state.phase]);
  try {
    assert.equal(frame({ terminalActive: true, switchState: switchState({ phase: 'stable' }) }), null, 'a settled change has nothing to say');
    assert.equal(frame({ terminalActive: true }), null);
    const waiting = frame({ terminalActive: true, switchState: switchState({ phase: 'waiting-turn' }), sessionId: 'rs9' });
    assert.equal(waiting.props.className, 'native-path-note'); assert.deepEqual(parts(waiting), [['line', null, 'waiting-turn'], ['question', 'rs9', 'waiting-turn']]);
    const question = frame({ terminalActive: true, switchState: asking() });
    assert.ok(question, 'the question alone is enough to show the frame'); assert.deepEqual(parts(question).map(part => part[0]), ['question']);
    assert.equal(frame({ terminalActive: false, switchState: asking() }), null, 'a native card’s view draws the question itself');
    assert.equal(frame({ terminalActive: false, switchState: switchState({ phase: 'switching' }) }), null);
  } finally { harness.dispose(); }
});

test('the switch parts write to no terminal, never expand a project and keep no secret: the guard covers the new files', () => {
  const dir = path.join(src, 'features/native-session'), code = file => fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\/.*$/gm, '');
  for (const file of ['SwitchNotice.tsx', 'draft-handoff.ts']) {
    assert.ok(fs.existsSync(path.join(dir, file)), file);
    assert.doesNotMatch(code(file), /writeTerminal|pasteTerminal|onExpand|expandProject|window\.agentrix|console\.|localStorage|sessionStorage/, file);
  }
  assert.doesNotMatch(code('draft-handoff.ts'), /\.send\(/, 'a draft is handed to main and never sent by the handoff');
});

// ---- the reading view's side of the draft handoff -------------------------------------------------------------------------------------
const { popupHarness } = require('./reading-popup-coverage.test.cjs');
const { DIALOG_SETTLE } = require('../src/features/reading/reading-ready.ts');

function handoffProps() {
  return { locked: false, incoming: null, offers: [], taken: 0, offer(draft) { this.offers.push(draft); }, take() { const draft = this.incoming; this.incoming = null; this.taken++; return draft; } };
}

test('the reading view offers its words and the messages still waiting to be written, and nothing else; the box shuts only when the handoff says so', t => {
  const h = popupHarness(t, 'codex'), handoff = handoffProps();
  h.props.handoff = handoff; h.render();
  assert.deepEqual(handoff.offers.at(-1), { text: '', images: [], undelivered: [] });
  h.edit('half a thought');
  assert.deepEqual(handoff.offers.at(-1), { text: 'half a thought', images: [], undelivered: [] });
  // A dialog is waiting, so a sent message waits in the outbox for the input to come back.
  h.view.rows = ['Settings', 'Esc to close']; h.render(); h.tick(DIALOG_SETTLE);
  h.keys('Enter');
  const waiting = handoff.offers.at(-1);
  assert.equal(waiting.text, ''); assert.deepEqual(waiting.undelivered.map(message => message.text), ['half a thought']); assert.match(waiting.undelivered[0].clientMessageId, /^waiting-\d+$/);
  const box = () => elements(h.tree()).find(element => element.type === 'textarea').props;
  assert.equal(box().disabled, false, 'until the handoff is accepted the input is untouched');
  handoff.locked = true; h.render();
  assert.equal(box().disabled, true); assert.equal(box().placeholder, '正在切换运行方式，稍后继续');
  assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, []);
});

test('a draft that comes with the new session goes into the empty box, beside typed words otherwise; its messages wait as unsent for the owner’s click, and nothing is written to the terminal', t => {
  const h = popupHarness(t, 'codex'), handoff = handoffProps(), box = () => elements(h.tree()).find(element => element.type === 'textarea').props;
  const unsent = () => elements(h.tree()).filter(element => element.type === 'li').map(element => element.props.children[0]);
  const retrieve = () => elements(h.tree()).find(element => element.type === 'button' && element.props.children === '取回');
  h.props.handoff = handoff; h.render();
  handoff.incoming = { version: 2, text: 'carried words', images: ['data:image/png;base64,AAAA'], undelivered: [{ clientMessageId: 'u1', text: 'never delivered' }] };
  h.render(); h.render();
  assert.equal(box().value, 'carried words'); assert.equal(handoff.taken, 1, 'taken once');
  assert.deepEqual(unsent(), ['never delivered'], 'an undelivered message is shown as unsent and is not sent');
  assert.deepEqual(handoff.offers.at(-1).undelivered.map(message => message.text), ['never delivered'], 'and a second switch offers it again: it is still not delivered');
  assert.deepEqual(elements(h.tree()).find(element => element.props?.images)?.props.images, ['data:image/png;base64,AAAA'], 'the picture is shown, to be pasted again');
  assert.equal(retrieve().props.disabled, true, 'the box holds words: the message does not replace them');
  h.edit(''); retrieve().props.onClick(); h.render();
  assert.equal(box().value, 'never delivered'); assert.deepEqual(unsent(), []);
  h.edit('typing now'); handoff.incoming = { version: 3, text: 'second draft', images: [], undelivered: [] }; h.render(); h.render();
  assert.equal(box().value, 'typing now'); assert.deepEqual(unsent(), ['second draft'], 'the arriving words wait beside what is being typed');
  assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, [], 'handing a draft over writes nothing and sends nothing');
});

test('a draft waits while the box cannot take it', t => {
  const h = popupHarness(t, 'codex'), handoff = handoffProps();
  h.props.handoff = handoff; handoff.locked = true; handoff.incoming = { version: 1, text: 'later', images: [], undelivered: [] };
  h.render(); h.render();
  assert.equal(handoff.taken, 0, 'a shut box does not take it'); assert.equal(handoff.incoming.text, 'later');
  handoff.locked = false; h.render(); h.render();
  assert.equal(handoff.taken, 1);
});

// ---- the structured end of a turn, the provider's notice, command phrases ------------------------------------------------------------
const mainWords = {
  completed: '本轮已完成。', tool_deferred: '这次工具调用被钩子推迟，没有执行。', max_turns: '已达到本轮最大执行次数。', budget_exhausted: '本轮 API 预算上限已用完。',
  api_error: 'API 请求失败，本轮未能完成。', owner: '本轮已中断。',
};
// One finished round of a session: your message, a reply (unless `reply` is false) and the turn.completed the provider sent.
const endedRound = (completed, { reply = true, extra = [], provider = {} } = {}) => viewHtml(ev => [ev('session.state', { state: 'idle', reason: null }),
  ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'go', clientMessageId: 'c1' } }, { itemId: 'u1' }), ...extra.map(make => make(ev)),
  ...(reply ? [ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'here is the answer' } }, { itemId: 'a1' })] : []), ev('turn.completed', completed)], provider);
const resultRow = html => (html.match(/<div class="result-status[^"]*"[\s\S]*?<\/p>(?:<p class="result-sub">[^<]*<\/p>)?/) ?? [''])[0];

test('the model keeps how a turn ended as the provider gave it and the provider’s notice, and a field nobody gave stays null', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const done = applyEvents(emptyModel(), [ev('turn.started', {}), ev('turn.completed', { status: 'completed', error: null, terminalReason: 'completed', message: '本轮已完成。', durationMs: 83000, costUsdMicros: 120000, costEstimated: true,
    tokens: { input: 1200, cachedInput: 50000, cacheWrite: 800, output: 300, reasoning: null } })]).model;
  assert.deepEqual(done.turn.end, { reason: 'completed', message: '本轮已完成。', durationMs: 83000, costUsdMicros: 120000, costEstimated: true, tokens: { input: 1200, cachedInput: 50000, cacheWrite: 800, output: 300, reasoning: null } });
  const bare = applyEvents(emptyModel(), [ev('turn.completed', { status: 'failed', error: 'x', durationMs: -5, costUsdMicros: 'a', tokens: { input: null, output: undefined } })]).model;
  assert.deepEqual(bare.turn.end, { reason: null, message: null, durationMs: null, costUsdMicros: null, costEstimated: null, tokens: null }, 'nothing is made up, and a count that is not a count is none');
  const next = stream(), again = applyEvents(emptyModel(), [next('turn.completed', { status: 'completed', error: null, durationMs: 5 }), next('turn.started', {})]).model;
  assert.equal(again.turn.end, null, 'a new turn forgets the last one’s end');
  const text = '额度不足，需要充值后继续。';
  const limited = applyEvents(emptyModel(), [ev('limits.updated', { scopeId: 's', providerStatus: 'rejected', notice: { code: 'credits_required', message: text, resetsAtMs: null } })]).model;
  assert.deepEqual(limited.limits, { providerStatus: 'rejected', notice: { code: 'credits_required', message: text, resetsAtMs: null } });
  assert.equal(applyEvents(limited, [ev('limits.updated', { scopeId: 's', notice: null })]).model.limits.notice, null, 'a later update with no notice clears it');
  assert.equal(applyEvents(emptyModel(), [ev('limits.updated', { scopeId: 's', notice: { code: 'rate_limited' } })]).model.limits.notice, null, 'a notice without words is none');
});

test('turn facts: the duration main measured, this turn’s spend as an estimate and its tokens, nothing for what was not given, and never a zero', () => {
  const { turnFacts, noticeWords, sentence, clockWords } = words(), counts = patch => ({ input: null, cachedInput: null, cacheWrite: null, output: null, reasoning: null, ...patch });
  const end = patch => ({ reason: 'completed', message: '本轮已完成。', durationMs: null, costUsdMicros: null, costEstimated: null, tokens: null, ...patch });
  assert.deepEqual(turnFacts(end({ durationMs: 83000, costUsdMicros: 120000, costEstimated: true, tokens: counts({ input: 1200, cachedInput: 50000, cacheWrite: 800, output: 300 }) }), 'claude', true),
    { durationMs: 83000, spend: '约 $0.12', tokens: '输入 52,000 · 输出 300' }, 'Claude’s input does not hold its cache: the cached and written parts are added; the completed message is not repeated');
  assert.deepEqual(turnFacts(end({ durationMs: 5000, tokens: counts({ input: 1000, cachedInput: 400, output: 50, reasoning: 20 }) }), 'codex', true),
    { durationMs: 5000, tokens: '输入 1,000 · 输出 50' }, 'Codex’s input holds its cache and reasoning is part of its output: neither is added again; Codex gives no spend');
  assert.equal(turnFacts(end({ costUsdMicros: 5, costEstimated: true }), 'claude', true).spend, '约 <$0.01');
  assert.equal(turnFacts(end({ costUsdMicros: 120000, costEstimated: false }), 'claude', true).spend, '$0.12', 'only an estimate is marked 约');
  assert.equal(turnFacts(end({ durationMs: 0, costUsdMicros: 0, tokens: counts({ input: 0, output: 0 }) }), 'claude', true), undefined, 'a duration, spend or count that is zero is not written');
  assert.equal(turnFacts(end(), 'codex', true), undefined); assert.equal(turnFacts(null, 'claude', false), undefined);
  assert.deepEqual(turnFacts(end({ reason: 'tool_deferred', message: mainWords.tool_deferred }), 'claude', false), { message: mainWords.tool_deferred }, 'a turn that did not complete carries main’s sentence');
  assert.deepEqual([sentence(null), sentence(''), sentence('API 请求失败，本轮未能完成。')], [null, null, 'API 请求失败，本轮未能完成。']);
  const at = Date.UTC(2026, 10, 4, 12, 0), later = at + 3 * 3600_000, notice = patch => ({ code: 'rate_limited', message: 'API 请求受到限流。', resetsAtMs: null, ...patch });
  assert.deepEqual(noticeWords(notice({ message: 'API 请求受到限流。' }), at), { text: 'API 请求受到限流。', resets: null }, 'no recovery time given: none is written or guessed');
  assert.deepEqual(noticeWords(notice({ resetsAtMs: later, message: 'API 额度不足，需要充值后继续。' }), at), { text: 'API 额度不足，需要充值后继续。', resets: `约 ${clockWords(later, at)} 恢复` }, 'the time comes from resetsAtMs in the owner’s clock, not as a machine date');
  assert.equal(noticeWords(notice({ resetsAtMs: at - 1 }), at), null, 'a notice whose recovery has passed is over'); assert.equal(noticeWords(null), null);
});

test('the result row draws what the provider said: completed with duration, spend and tokens; deferred, over budget, stopped and API errors are never drawn as done', async () => {
  const claudeDone = resultRow(await endedRound({ status: 'completed', error: null, terminalReason: 'completed', message: mainWords.completed, durationMs: 83000, costUsdMicros: 120000, costEstimated: true,
    tokens: { input: 1200, cachedInput: 50000, cacheWrite: 800, output: 300, reasoning: null } }));
  assert.match(claudeDone, /class="result-status" role="status" aria-label="已完成"/); assert.match(claudeDone, /<span class="result-took"> · 用时 1 分 23 秒 · 约 \$0\.12 · 输入 52,000 · 输出 300<\/span>/);
  assert.doesNotMatch(claudeDone, /本轮已完成/, 'the completed message is not said again'); assert.doesNotMatch(claudeDone, /\{|undefined|null/);
  const codexDone = resultRow(await endedRound({ status: 'completed', error: null, terminalReason: null, message: null, durationMs: 5000, costUsdMicros: null, costEstimated: null, tokens: { input: 1000, cachedInput: 400, cacheWrite: null, output: 50, reasoning: 20 } },
    { provider: { provider: 'codex', transport: 'codex-app-server' } }));
  assert.match(codexDone, /<span class="result-took"> · 用时 5 秒 · 输入 1,000 · 输出 50<\/span>/); assert.doesNotMatch(codexDone, /约|\$/, 'Codex has no spend');
  const bare = resultRow(await endedRound({ status: 'completed', error: null }));
  assert.match(bare, /aria-label="已完成"/); assert.doesNotMatch(bare, /约|\$|输入|输出/, 'a result with no facts writes none');
  const cases = [['tool_deferred', 'interrupted', '已中断'], ['max_turns', 'interrupted', '已中断'], ['budget_exhausted', 'interrupted', '已中断'], ['owner', 'interrupted', '已中断'], ['api_error', 'failed', '失败']];
  for (const [reason, status, label] of cases) {
    const html = await endedRound({ status, error: mainWords[reason], terminalReason: reason === 'owner' ? null : reason, message: mainWords[reason], durationMs: 2000, costUsdMicros: null, costEstimated: true, tokens: null }), row = resultRow(html);
    assert.match(row, new RegExp(`class="result-status is-failed" role="status" aria-label="${label}"`), reason); assert.doesNotMatch(row, /aria-label="已完成"|[0-9:]+ 完成/, `${reason} is never drawn as done`);
    assert.match(row, new RegExp(`<p class="result-sub">${mainWords[reason]}</p>`), `${reason}: main’s sentence is the line under the row`); assert.match(row, /用时 2 秒/);
  }
  // A stopped round whose last step failed is still stopped; a round that failed says failed.
  const stopped = resultRow(await endedRound({ status: 'interrupted', error: mainWords.owner, message: mainWords.owner }, { extra: [ev => ev('item.upsert', { kind: 'command', status: 'failed', content: { command: 'npm test', exitCode: 1 } }, { itemId: 'k1' })], reply: false }));
  assert.match(stopped, /aria-label="已中断"/, 'the turn’s status decides, not its last step');
  // No step or reply to stand on: the sentence is a line of its own (a quiet one for a stop, an alert for a failure), not a row.
  const noneStopped = await endedRound({ status: 'interrupted', error: mainWords.max_turns, message: mainWords.max_turns }, { reply: false }), noneFailed = await endedRound({ status: 'failed', error: mainWords.api_error, message: mainWords.api_error }, { reply: false });
  assert.match(noneStopped, /<p class="reading-status" role="status">已达到本轮最大执行次数。<\/p>/); assert.doesNotMatch(noneStopped, /form-error|result-status/);
  assert.match(noneFailed, /<p class="form-error" role="alert">API 请求失败，本轮未能完成。<\/p>/);
});

test('the provider’s notice that a limit was reached is told in the conversation with its recovery time only when it gave one, and its error event is not told twice', async () => {
  const when = Date.now() + 2 * 3600_000, line = '额度不足，需要充值后继续。';
  const html = notice => viewHtml(ev => [ev('session.state', { state: 'idle', reason: null }), ev('limits.updated', { scopeId: 's', billingRoute: 'api', providerStatus: 'rejected', notice }),
    ev('error', { code: 'credits_required', message: `${line}`, retryable: false, willRetry: false, stage: 'turn' })]);
  const timed = await html({ code: 'credits_required', message: `${line}`, resetsAtMs: when });
  assert.ok(timed.includes(`<p class="reading-status" role="status">${line} · 约 ${words().clockWords(when)} 恢复</p>`)); assert.doesNotMatch(timed, /2026-11-04T|form-error/, 'no machine date, and the same limit is not said twice');
  const untimed = await html({ code: 'credits_required', message: `${line}`, resetsAtMs: null });
  assert.ok(untimed.includes(`<p class="reading-status" role="status">${line}</p>`)); assert.doesNotMatch(untimed, /恢复|服务未提供/, 'no time is guessed or written when the provider gave none');
});

test('a command’s phrase comes from main and the checks it names are listed under a round that wrote files; a Claude Bash command is read from its input', async () => {
  const { nativeEntries } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const model = applyEvents(emptyModel(), [
    ev('item.upsert', { kind: 'command', status: 'completed', content: { command: 'npm test', phrase: '运行测试', exitCode: 0 } }, { itemId: 'k1' }),
    ev('item.upsert', { kind: 'command', status: 'failed', content: { name: 'Bash', input: '{"command":"npx tsc --noEmit"}', phrase: '检查类型', output: 'error TS1' } }, { itemId: 'k2' }),
    ev('item.upsert', { kind: 'command', status: 'completed', content: { command: 'ls' } }, { itemId: 'k3' }),
  ]).model, by = nativeEntries(model);
  assert.deepEqual(by.map(entry => [entry.tool.target, entry.tool.phrase]), [['npm test', '运行测试'], ['npx tsc --noEmit', '检查类型'], ['ls', undefined]], 'no phrase from main, none made up here');
  const html = await endedRound({ status: 'completed', error: null }, { extra: [
    e => e('item.upsert', { kind: 'file-change', status: 'completed', content: { path: 'src/a.ts', diff: '+x' } }, { itemId: 'f1' }),
    e => e('item.upsert', { kind: 'command', status: 'completed', content: { command: 'npm test', phrase: '运行测试', exitCode: 0 } }, { itemId: 'k1' }),
    e => e('item.upsert', { kind: 'command', status: 'failed', content: { name: 'Bash', input: '{"command":"npx tsc"}', phrase: '检查类型' } }, { itemId: 'k2' })] });
  assert.match(html, /<p class="result-list-head">验证<\/p>/); assert.match(html, /运行测试<small>[\s\S]*?npm test/); assert.match(html, /检查类型<small>[\s\S]*?npx tsc/);
  assert.match(html, /<li class="is-failed">[\s\S]*?检查类型/, 'a check that failed is listed as failed');
});

test('the usage block tells the provider’s notice with its recovery time only if it gave one, and offers the console’s billing page for Claude’s API spend only', async () => {
  const line = 'API 额度不足，需要充值后继续。', when = Date.now() + 2 * 3600_000;
  const api = (claude, codex = {}) => { const value = usageOf({  }); Object.assign(value.agents.claude.limits, claude); Object.assign(value.agents.codex.limits, codex); return usageHtml({ usage: async () => ({ ok: true, value }) }); };
  const untimed = usageSection(await api({ providerStatus: 'rejected', ordinaryUsageAllowed: false, notice: { code: 'credits_required', message: line + '', resetsAtMs: null } }), 'Claude');
  assert.ok(untimed.includes('<p class="activity-note" role="status">' + line + '</p>')); assert.doesNotMatch(untimed, /恢复|服务未提供/, 'no time is written when the provider gave none');
  const timed = usageSection(await api({ providerStatus: 'rejected', notice: { code: 'rate_limited', message: 'API 请求受到限流。', resetsAtMs: when } }), 'Claude');
  assert.ok(timed.includes('API 请求受到限流。 · 约 ' + words().clockWords(when) + ' 恢复')); assert.doesNotMatch(timed, /2026-11-04T/);
  assert.doesNotMatch(usageSection(await api({ notice: null }), 'Claude'), /role="status"/, 'no notice, no line');
  // A subscription that is rejected says so from the status; with the provider’s notice the notice speaks and the status line stays quiet.
  const rejected = usageSection(await api({}, { providerStatus: 'rejected' }), 'Codex');
  assert.match(rejected, /已限流，约 [^<]+ 恢复/);
  const both = usageSection(await api({}, { providerStatus: 'rejected', notice: { code: 'rate_limited', message: 'API 请求受到限流。', resetsAtMs: null } }), 'Codex');
  assert.doesNotMatch(both, /已限流/); assert.match(both, /API 请求受到限流。/);
  // The billing link: Claude on the API only, with the spend still marked as an estimate.
  const html = await api({}), claude = usageSection(html, 'Claude');
  assert.ok(claude.includes('<button type="button" class="text-button api-billing">在控制台核对</button>')); assert.ok(claude.includes('今日 $1.23 · 本月 $12.40 · 估算'));
  assert.doesNotMatch(usageSection(html, 'Codex'), /在控制台核对/);
  const subscription = usageOf({  }); subscription.agents.claude.connection = { kind: 'subscription', source: null, observedAt: 1 };
  assert.doesNotMatch(await usageHtml({ usage: async () => ({ ok: true, value: subscription }) }), /在控制台核对/);
  assert.doesNotMatch(await usageHtml({ usage: async () => ({ ok: true, value: usageOf({  }) }) }, quietTerminal, ''), /在控制台核对/, 'without a project there is nothing to open a page through');
});

test('the billing link opens the console page through the project and shows a refusal', async () => {
  const opened = [], previous = Object.getOwnPropertyDescriptor(globalThis, 'window'); let answer = { ok: true, value: { kind: 'external' } };
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: { openLink: async (...args) => { opened.push(args); return answer; } } } });
  const harness = hookHarness('src/features/agents/ApiUsage.tsx', { './i18n': { t: fill }, './native-store.ts': { useUsageRevision: () => 0 }, './native-words': words(), './Metric': load('features/agents/Metric.tsx'), './ResetQuota': { ResetQuota: () => null }, './activity-pane.css': {} });
  try {
    const button = () => elements(harness.render('BillingLink', { projectId: 'p1' }).result).find(node => node.type === 'button');
    button().props.onClick(); await settle();
    assert.deepEqual(opened, [['p1', 'https://platform.claude.com/settings/billing']]);
    assert.equal(elements(harness.render('BillingLink', { projectId: 'p1' }).result).some(node => node.props?.role === 'alert'), false);
    answer = { ok: false, error: '打不开这个链接' }; button().props.onClick(); await settle();
    assert.equal(elements(harness.render('BillingLink', { projectId: 'p1' }).result).find(node => node.props?.role === 'alert').props.children, '打不开这个链接');
  } finally { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; }
});

test('a switch that worked with a warning, one restored and one stopped tell their reason in the path note; only a failed one says it did not switch', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream(), store = load('features/native-session/native-store.ts');
  const entry = { model: applyEvents(emptyModel(), [ev('session.state', { state: 'idle' })]).model, dismissed: null, noteDismissed: false, handoff: null };
  const harness = hookHarness('src/features/native-session/NativePathNote.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './native-session.css': {}, './native-words': words(), './native-bridge.ts': { copyNativeText: async () => ({ ok: true }) }, './SwitchNotice': load('features/native-session/SwitchNotice.tsx'),
    './native-store.ts': { useNativeEntries: () => new Map([['t1', entry]]), terminalSwitch: store.terminalSwitch, dismissNote() {}, resolveSwitch: store.resolveSwitch, useSwitchNoteShown: () => true, dismissSwitchNote() {} },
  });
  const text = patch => { const result = harness.render('NativePathNote', { terminalId: 't1', terminalActive: false, switchState: switchState({ phase: 'stable', ...patch }) }).result; return result && elements(result).find(node => node.type === 'span')?.props.children; };
  try {
    assert.equal(text({ outcome: 'failed', reason: '终端没有启动' }), '没有切换成功，仍使用 API · 终端没有启动');
    assert.equal(text({ outcome: 'switched', reason: '旧进程没有正常退出' }), '旧进程没有正常退出'); assert.equal(text({ outcome: 'restored', reason: '已恢复到原来的会话' }), '已恢复到原来的会话');
    assert.equal(text({ outcome: 'stopped', reason: '会话已停止，没有切换' }), '会话已停止，没有切换');
    assert.equal(text({ outcome: 'switched' }), null); assert.equal(text({ reason: '终端没有启动' }), null, 'a reason without an outcome is not a failure');
  } finally { harness.dispose(); }
});
