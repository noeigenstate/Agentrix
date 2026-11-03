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

const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
before(() => { Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {}, lang: '' } } }); load('shared/i18n.ts').applyLanguage('zh'); });
after(() => { if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document; });

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
const load = makeLoader({
  '../reading/ReadingView': { Markdown: ({ text }) => React.createElement('div', { className: 'md' }, text) },
  '../../shared/UserAvatar': { UserAvatar: () => React.createElement('i', { className: 'avatar' }) },
  '../../shared/useFittingHint': { fullHintProps: () => ({}), HIDDEN_NOTE: {}, useFittingHint: (box, hints) => hints[0] },
});
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
  assert.deepEqual(words.windowWords({ usedPercent: 40, windowDurationMins: 300, resetsAt: null }), { span: '5 小时', used: '40%', resets: '未知' });
  assert.deepEqual([words.windowWords(null), words.windowWords({ usedPercent: null, windowDurationMins: 10080, resetsAt: null }).used], [null, '未知']);
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
function sessionView(events, bridge, base = {}) {
  const model = require('../src/features/native-session/native-model.ts'), ev = stream(base), dismissed = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: { nativeSession: bridge } } });
  const build = list => ({ model: model.applyEvents(model.emptyModel(), list).model, dismissed: null, noteDismissed: false });
  const harness = hookHarness('src/features/native-session/NativeSessionView.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './UserAvatar': { UserAvatar() {} }, './useFittingHint': { fullHintProps: () => ({}), HIDDEN_NOTE: {}, useFittingHint: (box, hints) => hints[0] },
    './AgentBrandIcon.ts': { ClaudeLogo() {}, CodexLogo() {} }, './NativeItems': { NativeItemView() {}, NativeSummary() {} }, './NativeRequestCard': { NativeRequestCard() {} },
    './native-store.ts': { dismissNative: id => dismissed.push(id), ensureNativeSession() {}, nativeShown: () => true, useNativeEntries: () => new Map() }, './native-session.css': {},
    './native-words': { itemState: () => null, messageText: item => item.content.text ?? '', reasonWords: reason => reason, receiptWord: status => status, routeWord: value => value, runtimeWord: () => 'Claude · API', sessionWord: state => state, turnWord: status => status },
  });
  let entry = build(events(ev));
  const tree = () => harness.render('NativeSession', { terminalId: 't1', entry, autoFocus: false }).result;
  const find = predicate => elements(tree()).find(predicate), box = () => find(node => node.type === 'textarea');
  return {
    ev, find, box, tree, dismissed, show(list) { entry = build(list); },
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
  const marker = (name, props) => React.createElement('div', { className: name, 'data-terminal': props.terminalId ?? props.id });
  const load = makeLoader({
    '../agents/SubagentPane': { SubagentPane: () => null }, '../agents/subagent-splits.ts': { closeSplit() {}, splitsOf: () => [], useSplits: () => [] },
    './AgentLauncher': { AgentLauncher: props => marker('launcher-stub', props) }, './TerminalPane': { TerminalPane: props => marker('pane-stub', props) }, '../reading/ReadingView': { ReadingView: () => null },
    '../reading/reading-mode': { readingShown: () => false, setReading() {}, syncReading() {}, useTerminalChoice: () => [] }, '../workspace/useProjectReorder': { TERMINAL_SPLITS: {}, useReorder: () => ({}) },
    '../native-session/NativeSessionView': { NativeSessionView: props => marker('native-stub', props) }, '../native-session/NativePathNote': { NativePathNote: props => marker('note-stub', props) },
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
  assert.doesNotMatch(all, /writeTerminal|writeApproval|answerTerminal|startTerminal|closeTerminal|sendToAgent|readClipboard|\.copy\(|onExpand|expandProject/, 'typing in a small card cannot expand it, and nothing types into a pty');
  assert.deepEqual(files.filter(file => /window\.agentrix/.test(code(file))), ['native-bridge.ts'], 'one file reads the bridge off window');
  assert.doesNotMatch(all, /console\.|localStorage|sessionStorage/, 'a secret answer is kept nowhere');
});

test('the parent relay answers a request once, by its id, with a refusal, and types nothing into any terminal', async () => {
  const filename = path.join(src, 'features/agents/parent-relay.ts'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  const results = [], hear = { listener: null, off: 0 }, previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: {
    onAgentRelay: listener => { hear.listener = listener; return () => { hear.off++; }; }, agentRelayResult: async (id, error) => { results.push([id, error]); return { ok: true, value: undefined }; },
    writeTerminal: () => assert.fail('a relay must not type'), startTerminal: () => assert.fail('a relay must not start a terminal'),
  } } });
  try {
    const stop = mod.exports.startParentRelay();
    hear.listener({ id: 7, terminalId: 't1', sessionId: 's1', agent: 'claude', text: 'also update the docs', deadline: Date.now() + 3000 }); await settle();
    hear.listener({ id: 8, terminalId: 't2', sessionId: 's2', agent: 'codex', text: 'stop', deadline: Date.now() + 3000 }); await settle();
    assert.deepEqual(results, [[7, mod.exports.RELAY_REFUSED], [8, mod.exports.RELAY_REFUSED]]);
    assert.match(mod.exports.RELAY_REFUSED, /worker directly/);
    stop(); assert.equal(hear.off, 1, 'stopping lets go of the listener');
  } finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; }
});

// ---- the API usage card -------------------------------------------------------------------------------------------------------------
const words = () => load('features/native-session/native-words.ts');
const usageOf = (patch = {}) => ({
  month: '2026-11', todayUsdMicros: 1_230_000, monthUsdMicros: 12_400_000, estimated: true, budgetUsd: 50, lastSwitch: { at: Date.UTC(2026, 10, 3, 9, 0), agent: 'claude', from: 'api', to: 'terminal', reason: 'budget_exhausted' },
  agents: {
    claude: { path: 'api', reason: null, limits: { state: 'ready', limitsById: {}, ordinaryUsageAllowed: true } },
    codex: { path: 'native', reason: null, limits: { state: 'ready', ordinaryUsageAllowed: true, limitsById: { codex: { limitName: 'Codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: Date.UTC(2026, 10, 3, 12, 30) }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null } } } } },
  }, ...patch,
});

async function usageHtml(bridge) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: bridge ? { nativeSession: bridge } : {} } });
  const harness = hookHarness('src/features/agents/ApiUsage.tsx', { './i18n': { t: fill }, './native-store.ts': { useUsageRevision: () => 0 }, './native-words': words(), './activity-pane.css': {} });
  try {
    harness.render('ApiUsage'); await sleep(30);
    return renderToStaticMarkup(harness.render('ApiUsage').result);
  } finally { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; }
}

test('the usage card shows each agent’s path, the API spend as an estimate, the budget share, limits with their recovery, and the last switch with its reason', async () => {
  const html = await usageHtml({ usage: async () => ({ ok: true, value: usageOf() }) });
  assert.match(html, /<dt>Claude<\/dt><dd>API · 原生界面<\/dd>/); assert.match(html, /<dt>Codex<\/dt><dd>原生界面<\/dd>/);
  assert.match(html, /今日 \$1\.23 · 本月 \$12\.40<\/span>/); assert.match(html, /估算，按公开价格计算/);
  assert.match(html, /\$50\.00 · 已用 25%/); assert.match(html, /role="meter"[^>]*aria-valuenow="25"/);
  assert.match(html, /5 小时 · 已用 40% · [^<]+ 重置/); assert.match(html, /7 天 · 已用 10% · 未知 重置/);
  assert.match(html, /Claude · API → 终端 · \d/); assert.match(html, /本月 API 预算已用完/);
});

test('the usage card says 未知 for what nobody gave and keeps a real zero as $0.00', async () => {
  const html = await usageHtml({ usage: async () => ({ ok: true, value: usageOf({ todayUsdMicros: 0, monthUsdMicros: null, budgetUsd: null, lastSwitch: null, agents: {
    claude: { path: null, reason: null, limits: null }, codex: { path: 'terminal', reason: null, limits: { state: 'rate_limited' } } } }) }) });
  assert.match(html, /今日 \$0\.00 · 本月 未知<\/span>/); assert.match(html, /<dt>Claude<\/dt><dd>未知<\/dd>/); assert.match(html, /<dt>Codex<\/dt><dd>终端<\/dd>/);
  assert.match(html, /<dt>月预算<\/dt><dd><span>未设置<\/span><\/dd>/); assert.doesNotMatch(html, /role="meter"/);
  assert.match(html, /<dt>Claude 额度<\/dt><dd><span>未知<\/span><\/dd>/); assert.match(html, /已限流，恢复时间未知/); assert.match(html, /还没有切换过/);
  assert.match(await usageHtml({ usage: async () => ({ ok: true, value: usageOf({ monthUsdMicros: null }) }) }), /\$50\.00 · 已用 未知/, 'a budget with no known spend has no share');
});

test('a failed read says so, a window without the bridge shows no card, and limits read as their provider gave them', async () => {
  assert.match(await usageHtml({ usage: async () => ({ ok: false, error: 'locked' }) }), /role="alert">无法读取额度：locked/);
  assert.equal(await usageHtml(null), '');
  const { limitLines } = load('features/agents/ApiUsage.tsx'), soon = Date.now() + 3600_000;
  assert.match(limitLines({ state: 'rate_limited', limitsById: { api: { primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: soon } } } })[0], /^已限流，约 .+ 恢复$/);
  assert.deepEqual(limitLines({ ordinaryUsageAllowed: false }), ['已限流，恢复时间未知']);
  assert.deepEqual(limitLines({ state: 'unavailable' }), ['暂时读不到']);
  assert.deepEqual(limitLines(null), ['未知']);
  assert.deepEqual(limitLines({ state: 'stale', limitsById: { a: { primary: { usedPercent: 5, windowDurationMins: 60, resetsAt: null } } } }), ['1 小时 · 已用 5% · 未知 重置', '数据可能已过期']);
});
