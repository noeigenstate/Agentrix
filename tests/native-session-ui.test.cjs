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
  '../reading/ReadingView': { Markdown: ({ text }) => React.createElement('div', { className: 'md' }, text) },
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
  const { applyEvents, emptyModel, groups } = load('features/native-session/native-model.ts'), ev = stream();
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
  assert.deepEqual(groups(done).map(group => group.kind), ['user', 'agent']);
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

test('reasoning summaries gather by segment, a diff and a plan are replaced by the next, and a turn ends with its own status', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const model = applyEvents(emptyModel(), [
    ev('turn.started', { origin: 'user', clientMessageId: 'c1' }),
    ev('item.delta', { channel: 'reasoning-summary', text: 'first ', index: 0 }, { itemId: 'th' }), ev('item.delta', { channel: 'reasoning-summary', text: 'second', index: 1 }, { itemId: 'th' }),
    ev('item.delta', { channel: 'reasoning-summary', text: 'part', index: 0 }, { itemId: 'th' }),
    ev('turn.diff', { diff: '+one' }), ev('turn.diff', { diff: '+one\n+two' }),
    ev('plan.updated', { explanation: 'x', steps: [{ step: 'A', status: 'pending' }] }), ev('plan.updated', { explanation: null, steps: [{ step: 'A', status: 'completed' }, { step: 'B', status: null }] }),
    ev('path.changed', { previous: 'api', selected: 'terminal', reason: 'budget_exhausted' }),
    ev('error', { code: 'rate', message: 'Too many requests', retryable: true, willRetry: true, stage: 'turn' }),
  ]).model;
  assert.deepEqual(model.items.th.deltas.reasoning, ['first part', 'second']);
  assert.equal(model.diff, '+one\n+two');
  assert.deepEqual(model.plan, { explanation: null, steps: [{ text: 'A', status: 'completed' }, { text: 'B', status: null }] });
  assert.deepEqual([model.path.selected, model.path.reason, model.error.willRetry, model.turn.running], ['terminal', 'budget_exhausted', true, true]);
  const ended = applyEvents(model, [ev('turn.completed', { status: 'interrupted', error: null })]).model;
  assert.deepEqual([ended.turn, ended.error], [{ running: false, status: 'interrupted', error: null }, model.error]);
  assert.equal(applyEvents(ended, [ev('turn.started', {})]).model.error, null, 'a new turn clears the last error');
});

// ---- the words ----------------------------------------------------------------------------------------------------------------------
test('words: receipts, routes, money and quota windows say what is known and "未知" for what is not', () => {
  const words = load('features/native-session/native-words.ts'), item = (kind, content = {}, extra = {}) => ({ id: 'i', kind, status: null, content, turnId: null, at: null, deltas: { text: '', output: '', reasoning: [], plan: '' }, ...extra });
  assert.deepEqual(['queued', 'delivered', 'consumed', 'rejected', 'unknown', 'mystery', null].map(words.receiptWord), ['已排队', '已送达', '已被读取', '未送达', '送达状态未知', null, null]);
  assert.deepEqual([null, undefined, 0, 5, 1_234_567].map(words.money), ['未知', '未知', '$0.00', '<$0.01', '$1.23'], 'unknown is not zero, and zero is not unknown');
  assert.deepEqual(['budget_exhausted', 'native_cli_required', 'something_new', null].map(words.reasonWords), ['本月 API 预算已用完', '未找到原生 Claude Code，无法通过 API 运行', 'something_new', null], 'a code nobody mapped is shown as given');
  assert.equal(words.runtimeWord({ provider: 'claude', transport: 'claude-sdk' }), 'Claude · API');
  assert.equal(words.runtimeWord({ provider: 'codex', transport: 'codex-app-server' }), 'Codex · 原生');
  assert.deepEqual(words.windowWords({ usedPercent: 40, windowDurationMins: 300, resetsAtMs: null }), { span: '5 小时', used: '40%', resets: '未知' });
  assert.deepEqual([words.windowWords(null), words.windowWords({ usedPercent: null, windowDurationMins: 10080, resetsAtMs: null }).used], [null, '未知']);
  assert.deepEqual(['in_progress', 'completed', 'failed', 'declined', null].map(status => words.itemState(item('command', {}, { status }))), ['running', 'done', 'failed', null, null]);
  assert.deepEqual([words.messageText(item('agent-message', { text: 'final' }, { deltas: { text: 'streamed', output: '', reasoning: [], plan: '' } })), words.messageText(item('agent-message', { text: 'final' }))], ['streamed', 'final']);
  assert.deepEqual(words.commandOf(item('command', { command: ['npm', 'test'], exitCode: 1, durationMs: 1500, output: 'old' }, { deltas: { text: '', output: 'live', reasoning: [], plan: '' } })),
    { command: 'npm test', cwd: null, exitCode: 1, durationMs: 1500, output: 'live' });
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

async function viewHtml(build, base = {}) {
  const ev = stream(base), events = build(ev);
  let html = '';
  await withBridge({ onEvent: () => () => {}, snapshot: async () => ({ ok: true, value: { runtimeSessionId: events[0].runtimeSessionId, lastSequence: events.length, events } }) }, async store => {
    store.ensureNativeSession('t1'); await settle();
    html = renderToStaticMarkup(React.createElement(load('features/native-session/NativeSessionView.tsx').NativeSessionView, { terminalId: 't1' }));
  });
  return html;
}

test('the view draws the conversation from events: your message with its receipt, words, thinking, a command and its output, files, plan, diff and the request waiting', async () => {
  const html = await viewHtml(richSession);
  assert.match(html, /Claude · API/); assert.match(html, /工作中/);
  assert.match(html, /<p>fix the test<\/p><small class="native-receipt">已被读取<\/small>/);
  assert.match(html, /<div class="md">Done: it passes now\.<\/div>/);
  assert.equal(html.match(/思考摘要/g).length, 1, 'a thinking step with no summary shows nothing');
  assert.match(html, /运行命令/); assert.match(html, /\$ npm test/); assert.match(html, /FAIL a\.test\.js/, 'a running command is open, with its output so far');
  assert.match(html, /修改文件/); assert.match(html, /a\.ts/); assert.doesNotMatch(html, /\+new/, 'a finished step is folded until opened');
  assert.match(html, /计划/); assert.match(html, /1 \/ 2 步/); assert.match(html, /Run tests/);
  assert.match(html, /本轮改动/); assert.doesNotMatch(html, /added line/);
  assert.match(html, /Run rm -rf build/); assert.match(html, /rm -rf build/); assert.match(html, />允许本次</); assert.match(html, />拒绝</);
  assert.match(html, /native-stop/, 'Stop while it works'); assert.match(html, /正在工作…/);
  assert.doesNotMatch(html, /<textarea[^>]*disabled/, 'and the message box stays usable');
  assert.doesNotMatch(html, /Codex/);
});

test('a finished session says why and offers a new conversation; a Codex session is named by its app-server; an idle one has no Stop', async () => {
  const ended = await viewHtml(ev => [ev('session.state', { state: 'failed', reason: 'native_cli_required' })]);
  assert.match(ended, /未找到原生 Claude Code，无法通过 API 运行/); assert.match(ended, /开始新的对话/); assert.match(ended, /<textarea[^>]*disabled/); assert.doesNotMatch(ended, /native-stop/);
  const codex = await viewHtml(ev => [ev('session.state', { state: 'idle', reason: null }), ev('turn.completed', { status: 'completed', error: null })], { provider: 'codex', transport: 'codex-app-server' });
  assert.match(codex, /Codex · 原生/); assert.match(codex, /本轮已完成/); assert.match(codex, /空闲/); assert.doesNotMatch(codex, /native-stop/); assert.doesNotMatch(codex, /<textarea[^>]*disabled/);
  const empty = await viewHtml(ev => [ev('session.state', { state: 'idle', reason: null })]);
  assert.match(empty, /会话已就绪，说点什么吧/);
});

// The session component with real hooks, the heavy neighbours stood in; `entry` is replaced by `show`.
// `handoff` stands in for the draft handoff hook (tested on its own below) and `change` is the terminal's SwitchState.
function sessionView(events, bridge, base = {}) {
  const model = require('../src/features/native-session/native-model.ts'), ev = stream(base), dismissed = [];
  const handoff = { locked: false, incoming: null, offers: [], taken: 0, offer(draft) { this.offers.push(draft); }, take() { const draft = this.incoming; this.incoming = null; this.taken++; return draft; } };
  let change = null;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: { nativeSession: bridge } } });
  const build = list => ({ model: model.applyEvents(model.emptyModel(), list).model, dismissed: null, noteDismissed: false, handoff: null });
  const harness = hookHarness('src/features/native-session/NativeSessionView.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './UserAvatar': { UserAvatar() {} }, './useFittingHint': { fullHintProps: () => ({}), HIDDEN_NOTE: {}, useFittingHint: (box, hints) => hints[0] },
    './AgentBrandIcon.ts': { ClaudeLogo() {}, CodexLogo() {} }, './NativeItems': { NativeItemView() {}, NativeSummary() {} }, './NativeRequestCard': { NativeRequestCard() {} },
    './native-store.ts': { dismissNative: id => dismissed.push(id), ensureNativeSession() {}, nativeShown: () => true, useNativeEntries: () => new Map(), resolveSwitch: terminal => terminal }, './native-session.css': {},
    './draft-handoff.ts': { useHandoff: () => handoff }, './SwitchNotice': { asksChoice: state => state?.phase === 'awaiting-choice' && !!state.requestId, SwitchLine() {}, SwitchQuestion() {} },
    './native-words': { itemState: () => null, messageText: item => item.content.text ?? '', reasonWords: reason => reason, receiptWord: status => status, routeWord: value => value, runtimeWord: () => 'Claude · API', sessionWord: state => state, turnWord: status => status },
  });
  let entry = build(events(ev));
  const tree = () => harness.render('NativeSession', { terminalId: 't1', entry, autoFocus: false, switchState: change }).result;
  const find = predicate => elements(tree()).find(predicate), box = () => find(node => node.type === 'textarea');
  return {
    ev, find, box, tree, dismissed, handoff, show(list) { entry = build(list); }, switching(state) { change = state; },
    type: value => box().props.onChange({ target: { value } }),
    press: (init = {}) => { const prevented = []; box().props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => prevented.push(true), ...init }); return prevented.length; },
    done() { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; },
  };
}
const idle = ev => [ev('session.state', { state: 'idle', reason: null })];

test('Enter sends the trimmed message at once, shows it as sent until the runtime echoes it, and Shift+Enter, IME and an empty box send nothing', async () => {
  const sends = [], view = sessionView(idle, { send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } });
  try {
    view.press(); view.type('   '); view.press(); view.type('hello'); view.press({ shiftKey: true }); view.press({ nativeEvent: { isComposing: true } });
    assert.deepEqual(sends, []);
    view.type('  hello  ');
    assert.equal(view.press(), 1, 'Enter is taken so it adds no line'); await settle();
    assert.equal(sends.length, 1); const [terminal, session, id, text] = sends[0];
    assert.deepEqual([terminal, session, typeof id, text], ['t1', 'rs1', 'string', 'hello']);
    assert.equal(view.box().props.value, '', 'the box emptied');
    const pending = view.find(node => node.props?.className === 'native-receipt');
    assert.equal(pending.props.children, '发送中', 'until a receipt arrives it reads as being sent');
    view.show([...idle(view.ev), view.ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'hello', clientMessageId: id } }, { itemId: 'u1' }), view.ev('input.receipt', { clientMessageId: id, status: 'queued' })]);
    const texts = elements(view.tree()).filter(node => node.type === 'p').map(node => node.props.children);
    assert.deepEqual(texts.filter(text => text === 'hello'), ['hello'], 'the echoed message is shown once, not also as pending');
    assert.equal(view.find(node => node.props?.className === 'native-receipt').props.children, 'queued');
  } finally { view.done(); }
});

test('a message the main process refuses comes back into the box with the reason, unless something new was typed meanwhile', async () => {
  const answers = [{ ok: false, error: 'no such session' }, { ok: false, error: 'busy' }], view = sessionView(idle, { send: async () => answers.shift() });
  try {
    view.type('please retry'); view.press(); await settle();
    assert.deepEqual([view.box().props.value, view.find(node => node.props?.role === 'alert').props.children], ['please retry', 'no such session']);
    assert.equal(view.find(node => node.props?.className === 'native-receipt'), undefined, 'nothing is shown as sent');
    view.press(); view.type('something else'); await settle();
    assert.equal(view.box().props.value, 'something else');
  } finally { view.done(); }
});

test('Stop interrupts the turn while it works and is not offered when idle; a finished session takes no message and can be closed', async () => {
  const interrupts = [], bridge = { interrupt: async (...args) => { interrupts.push(args); return { ok: true, value: {} }; }, send: async () => assert.fail('nothing to send') };
  const working = sessionView(ev => [...idle(ev), ev('turn.started', { origin: 'user', clientMessageId: null })], bridge);
  try {
    working.find(node => typeof node.props?.onStop === 'function').props.onStop(); await settle();
    assert.deepEqual(interrupts, [['t1', 'rs1']]);
    working.show(idle(working.ev));
    assert.equal(working.find(node => 'onStop' in (node.props ?? {})).props.onStop, null, 'idle: no Stop');
  } finally { working.done(); }
  const ended = sessionView(ev => [ev('session.state', { state: 'stopped', reason: 'user' })], bridge);
  try {
    assert.equal(ended.box().props.disabled, true);
    ended.type('too late'); ended.press(); await settle();
    ended.find(node => node.type === 'button' && node.props.children === '开始新的对话').props.onClick();
    assert.deepEqual(ended.dismissed, ['t1']);
  } finally { ended.done(); }
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
function gridMarkup(terminals, { focused = false, native = [], moved = [] } = {}) {
  const marker = (name, props) => React.createElement('div', { className: name, 'data-terminal': props.terminalId ?? props.id, 'data-phase': props.switchState?.phase ?? '', 'data-active': String(props.terminalActive ?? '') });
  const load = makeLoader({
    '../agents/SubagentPane': { SubagentPane: () => null }, '../agents/subagent-splits.ts': { closeSplit() {}, splitsOf: () => [], useSplits: () => [] },
    './AgentLauncher': { AgentLauncher: props => marker('launcher-stub', props) }, './TerminalPane': { TerminalPane: props => marker('pane-stub', props) }, '../reading/ReadingView': { ReadingView: () => null },
    '../reading/reading-mode': { readingShown: () => false, setReading() {}, syncReading() {}, useTerminalChoice: () => [] }, '../workspace/useProjectReorder': { TERMINAL_SPLITS: {}, useReorder: () => ({}) },
    '../native-session/NativeSessionView': { NativeSessionView: props => marker('native-stub', props) }, '../native-session/NativePathNote': { NativePathNote: props => marker('note-stub', props) },
    '../native-session/draft-handoff.ts': { useHandoff: () => ({}) },
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
test('the plan, the diff and the requests stand on the agent’s own content edge, and a request grows in the conversation instead of scrolling inside its card', async () => {
  const html = await viewHtml(richSession), content = html.slice(html.indexOf('reading-content'), html.indexOf('class="reading-composer"'));
  assert.match(content, /<div class="native-summary">/); assert.match(content, /<div class="native-requests">/);
  assert.ok(content.indexOf('native-summary') < content.indexOf('native-requests'), 'the request waits at the end of the conversation');
  assert.doesNotMatch(html, /reading-choice-host/, 'no host below the conversation whose card would scroll inside it');
  const css = fs.readFileSync(path.join(src, 'features/native-session/native-session.css'), 'utf8');
  assert.match(css, /\.native-summary, \.native-requests \{[^}]*margin-left: var\(--reading-inset\);/, 'the same left edge as the reply text and the tool pills');
  assert.match(css, /\.native-requests \.native-request \{ max-height: none; overflow: visible; \}/, 'the base card’s 45vh cap and scrollbar are off');
  assert.doesNotMatch(await viewHtml(ev => [ev('session.state', { state: 'idle', reason: null })]), /native-summary|native-requests/, 'nothing to show, no empty wrapper');
});

test('a new request pulls the view to it even when the owner had scrolled up; an ordinary step does not', () => {
  const view = sessionView(idle, {});
  try {
    const log = () => view.find(node => node.props?.role === 'log'), pane = { scrollTop: 0, scrollHeight: 900 };
    log().props.ref.current = pane;
    view.show([...idle(view.ev), view.ev('item.delta', { channel: 'text', text: 'one' }, { itemId: 'a1' })]); view.tree();
    assert.equal(pane.scrollTop, 900, 'at the end, new steps are followed');
    log().props.onScroll({ currentTarget: { scrollHeight: 2000, scrollTop: 0, clientHeight: 300 } }); pane.scrollTop = 0;
    view.show([...idle(view.ev), view.ev('item.delta', { channel: 'text', text: 'two' }, { itemId: 'a2' })]); view.tree();
    assert.equal(pane.scrollTop, 0, 'scrolled up, an ordinary step leaves the view where it is');
    view.show([...idle(view.ev), view.ev('request.opened', { requestId: 'r1', kind: 'command', title: 'Run it' })]); view.tree();
    assert.equal(pane.scrollTop, 900, 'a request waiting for the owner is brought into view');
  } finally { view.done(); }
});

test('a command’s folder reads as its last two parts on one line with the whole path as the tooltip', async () => {
  const { shortPath } = words(), cwd = '/home/someone/work/very/long/path/to/the/project';
  assert.deepEqual([shortPath('/work'), shortPath('C:\\Users\\someone\\work\\very\\long\\path\\project\\sub'), shortPath(cwd)], ['/work', '…\\project\\sub', '…/the/project']);
  const html = await viewHtml(ev => [ev('session.state', { state: 'running', reason: null }), ev('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'npm test', cwd } }, { itemId: 'k' })]);
  assert.match(html, new RegExp(`<small class="native-facts" title="${cwd}">…/the/project</small>`));
  assert.doesNotMatch(html.replace(/ title="[^"]*"/g, ''), /\/home\/someone/, 'the folder’s head is not drawn');
  assert.match(fs.readFileSync(path.join(src, 'features/native-session/native-session.css'), 'utf8'), /\.native-facts \{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
});

test('the message box always has a hint: the longest that fits, and the shortest when none does', async () => {
  try {
    fit.index = 0; assert.match(await viewHtml(ev => idle(ev)), /placeholder="给它发消息 · Enter 发送，Shift\+Enter 换行"/);
    fit.index = 9; assert.match(await viewHtml(ev => idle(ev)), /placeholder="发消息"/, 'a width that fits none of them still names the box');
  } finally { fit.index = 0; }
});

test('Codex falling back to the terminal leaves its reason where the native view stood, in words', async () => {
  const cases = [['codex_cli_required', '未找到 Codex 命令行，无法使用原生界面'], ['unsupported_codex_version', '这个 Codex 版本不支持原生界面']];
  for (const [reason, words] of cases) {
    const ev = stream({ provider: 'codex', transport: 'codex-app-server' }), events = [ev('path.changed', { previous: null, selected: 'terminal', reason })];
    let html = '', shown = null;
    await withBridge({ onEvent: () => () => {}, snapshot: async () => ({ ok: true, value: { runtimeSessionId: 'rs1', lastSequence: 1, events } }) }, async store => {
      store.ensureNativeSession('t1'); await settle();
      shown = store.nativeShown(entriesOf(store).get('t1'));
      html = renderToStaticMarkup(React.createElement(load('features/native-session/NativePathNote.tsx').NativePathNote, { terminalId: 't1' }));
    });
    assert.equal(shown, false, 'the terminal’s own view takes the cell');
    assert.ok(html.includes(`已改用终端 · ${words}`), reason);
  }
});

// ---- the API usage card -------------------------------------------------------------------------------------------------------------
const words = () => load('features/native-session/native-words.ts');
const usageOf = (patch = {}) => ({
  month: '2026-11', apiRecords: true, todayUsdMicros: 1_230_000, monthUsdMicros: 12_400_000, estimated: true, budgetUsd: 50, lastSwitch: { at: Date.UTC(2026, 10, 3, 9, 0), agent: 'claude', from: 'api', to: 'terminal', reason: 'budget_exhausted' },
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
  assert.deepEqual(labels(claude), ['连接', '最近切换']); assert.deepEqual(labels(codex), ['连接']);
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
  assert.match(claude, /API → 终端 · \d/); assert.match(claude, /本月 API 预算已用完/);
  const switched = await usageHtml({ usage: async () => ({ ok: true, value: usageOf({ lastSwitch: { at: 1, agent: 'codex', from: 'native', to: 'terminal', reason: 'user' } }) }) });
  assert.doesNotMatch(usageSection(switched, 'Claude'), /最近切换/);
  assert.match(usageSection(switched, 'Codex'), /<dt>最近切换<\/dt>/);
});

test('the usage block says 未知 for what nobody gave and keeps a real zero as $0.00', async () => {
  // Connection not known (an older main, or nothing running): the connection and the allowance both say so, and nothing is measured.
  const unknown = await usageHtml({ usage: async () => ({ ok: true, value: usageOf({ todayUsdMicros: 0, monthUsdMicros: null, budgetUsd: null, lastSwitch: null, agents: {
    claude: { path: null, reason: null, next: { path: null, reason: null }, limits: null }, codex: { path: 'terminal', reason: null, limits: { state: 'rate_limited' } } } }) }) });
  for (const agent of ['Claude', 'Codex']) {
    const section = usageSection(unknown, agent);
    assert.match(section, /<dt>连接<\/dt><dd><span>未知<\/span><\/dd>/);
    assert.match(section, /<dt>额度<\/dt><dd><span>未知<\/span><\/dd>/, 'not connected or not known: 额度 未知');
    assert.doesNotMatch(section, /activity-metrics|role="meter"|API 花费|月预算|5 小时额度/);
  }
  assert.doesNotMatch(unknown, /最近切换|还没有切换过|新会话/);
  // An API connection: a real zero is $0.00; a missing amount is 未知; a budget with no known spend has no share and no bar; no budget says 未设置.
  const api = patch => usageHtml({ usage: async () => ({ ok: true, value: usageOf({ lastSwitch: null, ...patch }) }) });
  const none = await api({ todayUsdMicros: 0, monthUsdMicros: null, budgetUsd: null });
  assert.match(none, /<small>今日 \$0\.00 · 本月 未知 · 估算<\/small>/); assert.match(none, /<span class="activity-metric-label">月预算<\/span><small>未设置<\/small>/); assert.doesNotMatch(usageSection(none, 'Claude'), /role="meter"/);
  const noShare = await api({ monthUsdMicros: null });
  assert.match(noShare, /<span class="activity-metric-label">月预算<\/span><b[^>]*>未知<\/b><small>本月 未知 \/ \$50\.00<\/small>/); assert.doesNotMatch(usageSection(noShare, 'Claude'), /role="meter"/, 'no spend, no share, no bar');
  assert.match(await api({ todayUsdMicros: null, monthUsdMicros: null }), /<small>今日 未知 · 本月 未知 · 估算<\/small>/, 'records with missing amounts stay unknown, never $0.00');
  // The warning colour only from 90%.
  assert.doesNotMatch(usageSection(await api({ monthUsdMicros: 44_000_000 }), 'Claude'), /is-warn/); assert.match(await api({ monthUsdMicros: 45_000_000 }), /activity-metric is-warn activity-figure/);
  // A rate-limited subscription with no window says so rather than a number.
  const limited = usageOf({ lastSwitch: null }); limited.agents.codex.limits = { state: 'rate_limited', limitsById: {} };
  assert.match(usageSection(await usageHtml({ usage: async () => ({ ok: true, value: limited }) }), 'Codex'), /<small>已限流，恢复时间未知<\/small>/);
});

test('the usage block distinguishes no API records from records with unknown or zero spend, and Codex on the API has none to show', async () => {
  const html = await usageHtml({ usage: async () => ({ ok: true, value: usageOf({ apiRecords: false, todayUsdMicros: null, monthUsdMicros: null, budgetUsd: null, lastSwitch: null }) }) });
  assert.match(usageSection(html, 'Claude'), /<span class="activity-metric-label">API 花费<\/span><small>还没有 API 用量记录<\/small>/);
  assert.doesNotMatch(usageSection(html, 'Claude'), /估算|今日|本月|role="meter"|最近切换/);
  assert.doesNotMatch(usageSection(html, 'Codex'), /API 用量记录/);
  // Codex through the API: the same words and no budget (there is no spend record to measure one against).
  const codexApi = usageOf({ lastSwitch: null }); codexApi.agents.codex.connection = { kind: 'api', source: 'account/read: API key', observedAt: 1 };
  const codex = usageSection(await usageHtml({ usage: async () => ({ ok: true, value: codexApi }) }), 'Codex');
  assert.match(codex, /<span class="activity-metric-label">API 花费<\/span><small>还没有 API 用量记录<\/small>/);
  assert.doesNotMatch(codex, /月预算|5 小时额度|每周额度|role="meter"/);
});

test('the allowance of each agent follows its connection: the current session’s agent leads with the context and ends with the round, windows come from main with the session’s own as fallback', async () => {
  const future = Date.now() + 3600_000, tokens = { input: 496000, cached: 476000, output: 5100 };
  const current = (agent, extra = {}) => ({ id: 't1', agent, codexActive: true, sessionId: 's1', agentStartedAt: 1, agentUsage: { provider: null, limits: [], context: { used: 170000, window: 1000000 }, round: tokens, total: null, ...extra } });
  const usage = usageOf({ lastSwitch: null, budgetUsd: null }), sub = { kind: 'subscription', source: null, observedAt: 1 };
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
  const main = usageOf({ lastSwitch: null }); main.agents.claude = { ...main.agents.claude, connection: sub, limits: { state: 'ready', observedAtMs: Date.now(), limitsById: { five: { primary: { usedPercent: 33, windowDurationMins: 300, resetsAtMs: future }, secondary: null } } } };
  const preferred = usageSection(await usageHtml({ usage: async () => ({ ok: true, value: main }) }, current('claude', { limits: [{ minutes: 300, percent: 20, resetsAt: future }] })), 'Claude');
  assert.match(preferred, /aria-valuenow="33"/); assert.doesNotMatch(preferred, /aria-valuenow="20"/); assert.match(preferred, /额度来自 Claude，/);
  // A window nobody measured says 未知 (never 0), and an expired one waits for its next reading.
  const odd = usageOf({ lastSwitch: null }); odd.agents.codex.limits = { state: 'stale', limitsById: { a: { primary: { usedPercent: null, windowDurationMins: 300, resetsAtMs: null }, secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAtMs: Date.now() - 1000 } } } };
  const staleHtml = usageSection(await usageHtml({ usage: async () => ({ ok: true, value: odd }) }), 'Codex');
  assert.match(staleHtml, /<span class="activity-metric-label">5 小时额度<\/span><b[^>]*>未知<\/b>/); assert.doesNotMatch(staleHtml, /<b[^>]*>0%<\/b>/);
  assert.match(staleHtml, /已重置，等待更新/); assert.match(staleHtml, /数据可能已过期/);
  // Not connected: the connection and 额度 未知 and nothing to measure, even for the session's own agent.
  const idle = usageOf({ lastSwitch: null }); idle.agents.codex = { ...idle.agents.codex, connection: { kind: 'none', source: null, observedAt: 1 }, limits: null };
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
  const failure = patch => words.switchFailure(switchState({ phase: 'rolling-back', ...patch }));
  assert.equal(failure(), '没有切换成功，仍使用 API'); assert.equal(failure({ reason: 'native_cli_required' }), '没有切换成功，仍使用 API · 未找到原生 Claude Code，无法通过 API 运行');
  assert.equal(failure({ phase: 'stable', reason: '终端没有启动' }), '没有切换成功，仍使用 API · 终端没有启动', 'a settled change that left a reason failed');
  assert.deepEqual([failure({ phase: 'stable' }), failure({ phase: 'waiting-turn', reason: '输入框里有未发送的文字' }), words.switchFailure(null)], [null, null, null]);
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
    for (const state of [null, switchState(), asking({ requestId: null }), asking({ phase: 'waiting-background' }), asking({ phase: 'stable' })]) assert.deepEqual(view.question(state), [], JSON.stringify(state));
    const nodes = view.question(asking());
    assert.equal(nodes.find(node => node.type === 'section').props.className, 'reading-choice native-request native-switch-question', 'the request card’s look');
    assert.equal(nodes.find(node => node.type === 'strong').props.children, '现在切到 终端？'); assert.equal(nodes.find(node => node.props?.className === 'native-switch-text').props.children, '切换会结束 2 个后台任务。');
    assert.deepEqual(nodes.filter(node => node.type === 'button').map(node => node.props.children), ['等它们结束', '现在切换']);
    assert.equal(answers.length, 0, 'it waits for the owner’s click');
    view.button(asking(), '等它们结束').props.onClick(); await settle();
    assert.deepEqual(answers, [['t1', 'rs1', 'rq1', { switch: { changeId: 3, requestId: 'rq1', action: 'wait' } }]]);
    assert.equal(view.button(asking(), '现在切换').props.disabled, true, 'shut while the answer is with main'); view.button(asking(), '现在切换').props.onClick(); await settle();
    assert.equal(answers.length, 1, 'one answer per question');
    assert.equal(view.button(asking({ requestId: 'rq2' }), '现在切换').props.disabled, false, 'a new question is a new card');
    view.button(asking({ requestId: 'rq2' }), '现在切换').props.onClick(); await settle();
    assert.deepEqual(answers.at(-1), ['t1', 'rs1', 'rq2', { switch: { changeId: 3, requestId: 'rq2', action: 'now' } }]);
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

test('the native view’s header carries the switch line, its question stands in the conversation, and neither is a request', () => {
  const view = sessionView(idle, {});
  try {
    view.switching(switchState({ phase: 'waiting-turn' }));
    const nodes = elements(view.tree());
    assert.equal(nodes.filter(node => node.props?.change?.phase === 'waiting-turn').length, 1, 'the header reads the state');
    assert.equal(nodes.some(node => node.props?.request), false, 'the question is not a request');
    assert.equal(nodes.some(node => node.props?.className === 'native-requests'), false, 'and nothing asks while main does not');
    view.switching(asking());
    const box = elements(view.tree()).find(node => node.props?.className === 'native-requests');
    assert.ok(box, 'the question has its place in the conversation'); assert.equal(elements(box.props.children).filter(node => node.props?.state?.phase === 'awaiting-choice').length, 1);
  } finally { view.done(); }
});

test('a draft carried into the native view lands in the empty box, beside typed words otherwise, with its pictures and unsent messages; nothing is sent', async () => {
  const sends = [], view = sessionView(idle, { send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } });
  const texts = () => elements(view.tree()).filter(node => node.type === 'li').map(node => node.props.children[0]);
  const take = node => node.type === 'button' && node.props.children === '取回';
  try {
    view.handoff.incoming = { version: 1, text: 'half a thought', images: ['data:image/png;base64,AAAA'], undelivered: [{ clientMessageId: 'u1', text: 'refused earlier' }, { clientMessageId: 'u2', text: 'second', images: ['data:image/png;base64,BBBB'] }] };
    view.tree(); await settle(); view.tree();
    assert.equal(view.box().props.value, 'half a thought'); assert.deepEqual(texts(), ['refused earlier', 'second']);
    assert.equal(view.handoff.taken, 1, 'taken once'); assert.deepEqual(sends, [], 'arrival sends nothing');
    assert.equal(elements(view.tree()).filter(node => node.type === 'img').length, 1, 'the picture waits with the next message');
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

test('the native view offers its draft to a switch: the words, the pictures and only the messages main refused; and its input shuts only when main accepts', async () => {
  const view = sessionView(idle, { send: async () => ({ ok: true, value: {} }) });
  try {
    view.tree(); view.type('draft one'); view.tree();
    assert.deepEqual(view.handoff.offers.at(-1), { text: 'draft one', images: [], undelivered: [] });
    view.type('sent words'); view.tree(); view.press(); await settle(); view.tree();
    assert.deepEqual(view.handoff.offers.at(-1), { text: '', images: [], undelivered: [] }, 'a message in flight is not offered: it may arrive');
    const sentId = elements(view.tree()).find(node => node.props?.className === 'native-receipt')?.props.children;
    assert.equal(view.box().props.disabled, false, 'until main accepts, the old input stays as it was');
    view.handoff.locked = true; view.tree();
    assert.equal(view.box().props.disabled, true); assert.equal(view.box().props.placeholder, '正在切换运行方式，稍后继续');
    assert.ok(sentId);
  } finally { view.done(); }
});

function handoffHook(bridge, current) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window'), taken = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: { nativeSession: bridge } } });
  const harness = hookHarness('src/features/native-session/draft-handoff.ts', {
    './native-bridge.ts': { nativeBridge: () => bridge },
    './native-store.ts': { resolveSwitch: terminal => terminal, useNativeEntries: () => new Map([['t1', { handoff: current.incoming ? { changeId: 9, draft: current.incoming } : null }]]), takeHandoff: id => { taken.push(id); return current.incoming; } },
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
  const hook = handoffHook({ answer: (...args) => new Promise(resolve => pending.push({ version: args[3].handoff.draft.version, resolve })) }, { state: switchState({ phase: 'preparing' }) });
  try {
    const handoff = hook.render(); handoff.offer(offer('a')); hook.render(); handoff.offer(offer('ab')); hook.render();
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
