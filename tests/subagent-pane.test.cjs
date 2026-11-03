const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// The sub-agent view: the open-view store, how a view follows its feed, the view itself, the activity pane's rows that open it and the
// terminal grid cell it takes. Source files are transpiled the way the other UI tests do it; the heavy neighbours are stood in.
const src = path.join(__dirname, '..', 'src');

const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
before(() => { Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {}, lang: '' } } }); });
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

// The conversation renderer is stood in by an element that says what it was given; the sub-agent view by one that says which view it is.
const feedStub = { ConversationFeed: props => React.createElement('div', { className: 'conversation-feed', 'data-agent': props.agent, 'data-live': String(props.live), 'data-entries': props.entries.length, 'data-project': props.projectId, 'data-link': typeof props.onOpenLink }) };
const viewStub = { SubagentPane: props => React.createElement('div', { className: 'subagent-stub', 'data-terminal': props.terminalId, 'data-call': props.callId, 'data-project': props.projectId, 'data-close': typeof props.onClose }) };
const screenStub = { readScreen: () => null, subscribeScreen: () => () => {} }, sendStub = { sendToAgent() { throw new Error('rendering must not send input'); } };
// One loader for the store, the activity pane and the grid, so they share one store, as they do in the window.
const load = makeLoader({
  '../reading/ConversationFeed': feedStub, '../agents/SubagentPane': viewStub, '../terminal/terminal-screen': screenStub, '../home/send-to-agent': sendStub,
  './AgentLauncher': { AgentLauncher: () => null }, './TerminalPane': { TerminalPane: ({ id }) => React.createElement('div', { 'data-pane': id }) },
  '../reading/ReadingView': { ReadingView: () => null }, '../reading/reading-mode': { readingShown: () => false, setReading() {}, syncReading() {}, useTerminalChoice: () => [] },
  '../workspace/useProjectReorder': { TERMINAL_SPLITS: {}, useReorder: () => ({}) },
  // Native sessions have their own tests (native-session-ui.test.cjs); here no terminal runs one, and the usage card is not under test.
  '../native-session/NativeSessionView': { NativeSessionView: () => null }, '../native-session/NativePathNote': { NativePathNote: () => null },
  '../native-session/native-store.ts': { useNativeEntries: () => new Map(), nativeShown: () => false, ensureNativeSession() {} }, './ApiUsage': { ApiUsage: () => null },
});
const zh = run => { load('shared/i18n.ts').applyLanguage('zh'); return run(); };
const splits = () => load('features/agents/subagent-splits.ts');
const settle = () => new Promise(resolve => setImmediate(resolve));
const count = (html, pattern) => (html.match(pattern) ?? []).length;
const openIds = terminalId => splits().splitsOf(splits().getSplits(), terminalId).map(item => item.callId);
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];

const rate = { samples: 3, activeMs: 10_000, outputTokens: 940 };
const feed = (revision, patch = {}) => ({ id: 'agent:a', agent: 'Codex', model: 'gpt-6.1-sol', effort: 'max', fast: true, title: 'Refactor the grid', role: '执行', state: 'running', startedAt: 1000, endedAt: null,
  rate, entries: [{ id: 'e1' }, { id: 'e2' }], revision, ...patch });

// ---- which views are open -------------------------------------------------------------------------------------------------------
test('one view per terminal: a second open replaces the first at any width, a repeated click closes, terminals keep their own', () => {
  const s = splits(), heard = [];
  const leave = s.subscribeSplits(() => heard.push(openIds('t-limit')));
  s.openSplit('t-limit', 'a'); s.openSplit('t-limit', 'b');
  assert.deepEqual(openIds('t-limit'), ['b'], 'the second view replaced the first');
  s.openSplit('t-limit', 'b');
  assert.deepEqual([openIds('t-limit'), heard], [['b'], [['a'], ['b']]], 'opening the open view changes nothing and tells nobody');
  leave();
  s.openSplit('t-other', 'x');
  assert.deepEqual([openIds('t-limit'), openIds('t-other')], [['b'], ['x']], 'each terminal keeps its own view');
  s.toggleSplit('t-limit', 'b');
  assert.deepEqual(openIds('t-limit'), [], 'a repeated click closes it');
  s.toggleSplit('t-limit', 'b'); s.toggleSplit('t-limit', 'c');
  assert.deepEqual(openIds('t-limit'), ['c'], 'a click on another sub-agent replaces the open one');
  assert.equal(s.isSplitOpen(s.getSplits(), 't-limit', 'c'), true); assert.equal(s.isSplitOpen(s.getSplits(), 't-limit', 'b'), false); assert.equal(s.isSplitOpen(s.getSplits(), 't-other', 'c'), false);
  assert.deepEqual(openIds('t-other'), ['x'], 'the other terminal was left alone');
  for (const gone of ['limitSplits', 'splitLimit', 'MAX_SPLITS', 'NARROW_CENTRE']) assert.equal(gone in s, false, `${gone} existed only for the second view`);
  s.closeSplit('t-limit', 'c'); s.closeSplit('t-other', 'x'); s.closeSplit('t-limit', 'nothing-open');
  assert.deepEqual([openIds('t-limit'), openIds('t-other')], [[], []]);
});

test('replacing a view drops the feed kept for it, the way closing does', async () => {
  const s = splits(), bridge = stubBridge(() => Promise.resolve({ ok: true, value: feed(4) }));
  const firstState = callId => { let first; s.followFeed(bridge, 't-swap', callId, state => { first ??= state; })(); return first.status; };
  s.openSplit('t-swap', 'a'); s.followFeed(bridge, 't-swap', 'a', () => {})();
  await settle();
  assert.equal(firstState('a'), 'ok', 'the open view keeps its feed');
  s.openSplit('t-swap', 'b');
  assert.equal(firstState('a'), 'loading', 'the replaced view’s feed went with it');
  s.closeSplit('t-swap', 'b');
});

test('subscribers hear every change to the open views and stop hearing when they leave', () => {
  const s = splits(), heard = [];
  const leave = s.subscribeSplits(() => heard.push(openIds('t-hear')));
  s.openSplit('t-hear', 'a'); s.toggleSplit('t-hear', 'a');
  assert.deepEqual(heard, [['a'], []]);
  leave(); s.openSplit('t-hear', 'b');
  assert.equal(heard.length, 2); s.closeSplit('t-hear', 'b');
});

test('a closed view and the views of a removed terminal leave nothing behind: no open view, no kept feed', async () => {
  const s = splits(), bridge = stubBridge(() => Promise.resolve({ ok: true, value: feed(4) }));
  const firstState = (terminalId, callId) => { let first; s.followFeed(bridge, terminalId, callId, state => { first ??= state; })(); return first.status; };
  for (const [terminalId, callId] of [['t-keep', 'a'], ['t-shut', 'b'], ['t-gone', 'c'], ['t-gone', 'd']]) { s.openSplit(terminalId, callId); s.followFeed(bridge, terminalId, callId, () => {})(); }
  await settle();
  assert.equal(firstState('t-shut', 'b'), 'ok', 'a view that opens again at once shows the feed it had');
  s.closeSplit('t-shut', 'b');
  assert.equal(firstState('t-shut', 'b'), 'loading', 'closing the view dropped its kept feed');
  const heard = [], leave = s.subscribeSplits(() => heard.push(true));
  s.pruneSplits(new Set(['t-keep', 't-gone']));
  assert.deepEqual(heard, [], 'nothing to prune: nobody is told');
  s.pruneSplits(new Set(['t-keep']));
  assert.deepEqual([openIds('t-keep'), openIds('t-gone'), heard.length], [['a'], [], 1], 'the views of a terminal that went close');
  assert.deepEqual([firstState('t-keep', 'a'), firstState('t-gone', 'c')], ['ok', 'loading'], 'its kept feeds went too, the live terminal keeps its own');
  leave(); s.closeSplit('t-keep', 'a');
});

// ---- following one agent --------------------------------------------------------------------------------------------------------
function stubBridge(answer) {
  const calls = [], hear = { listener: null };
  return { calls, hear, subagentFeed: (terminalId, callId) => { calls.push([terminalId, callId]); return answer(calls.length); },
    onSubagentFeed: listener => { hear.listener = listener; return () => { hear.listener = null; }; } };
}
const event = (revision, callId) => ({ terminalId: 't1', callId, revision });

test('a feed is read at once and again only when the main process reports a newer revision for this very call', async () => {
  const bridge = stubBridge(call => Promise.resolve({ ok: true, value: feed(call) })), states = [];
  const stop = splits().followFeed(bridge, 't1', 'agent:follow-1', state => states.push(state));
  await settle();
  assert.deepEqual(states.map(state => [state.status, state.feed?.revision ?? null]), [['loading', null], ['ok', 1]]);
  bridge.hear.listener(event(1, 'agent:follow-1')); await settle();
  assert.equal(bridge.calls.length, 1, 'the revision it already shows is not read again');
  bridge.hear.listener(event(5, 'agent:someone-else')); bridge.hear.listener({ terminalId: 't2', callId: 'agent:follow-1', revision: 5 }); await settle();
  assert.equal(bridge.calls.length, 1, 'another call or another terminal is not this view’s business');
  bridge.hear.listener(event(2, 'agent:follow-1')); await settle();
  assert.deepEqual([bridge.calls.length, states.at(-1).feed.revision], [2, 2]);
  stop();
  assert.equal(bridge.hear.listener, null, 'stopping lets go of the push');
});

test('only one read is in flight: changes meanwhile are read once it returns, and a feed older than the one shown is ignored', async () => {
  const pending = [], bridge = stubBridge(() => new Promise(resolve => pending.push(resolve))), states = [];
  splits().followFeed(bridge, 't1', 'agent:follow-2', state => states.push(state));
  for (const revision of [2, 3, 4]) bridge.hear.listener(event(revision, 'agent:follow-2'));
  assert.equal(bridge.calls.length, 1, 'three changes while a read is out start no further read');
  pending[0]({ ok: true, value: feed(1) }); await settle();
  assert.equal(bridge.calls.length, 2, 'the newest change is read once the first read has returned');
  pending[1]({ ok: true, value: feed(4) }); await settle();
  assert.deepEqual([bridge.calls.length, states.at(-1).feed.revision], [2, 4]);
  bridge.hear.listener(event(5, 'agent:follow-2')); pending[2]({ ok: true, value: feed(3) }); await settle();
  assert.equal(states.at(-1).feed.revision, 4, 'a late, older answer does not replace the newer one');
  assert.equal(bridge.calls.length, 3, 'and it does not make the view ask in a loop');
});

test('a feed the main process no longer keeps ends the following but keeps the last content; a failed read is tried again at the next change', async () => {
  let mode = 'ok';
  const bridge = stubBridge(call => mode === 'ok' ? Promise.resolve({ ok: true, value: feed(call, { entries: [{ id: `e${call}` }] }) }) : mode === 'boom' ? Promise.resolve({ ok: false, error: 'boom' })
    : mode === 'throws' ? Promise.reject(new Error('ipc closed')) : Promise.resolve({ ok: false, error: 'gone' }));
  const states = [], last = () => states.at(-1);
  splits().followFeed(bridge, 't1', 'agent:follow-3', state => states.push(state));
  await settle(); mode = 'boom';
  bridge.hear.listener(event(2, 'agent:follow-3')); await settle();
  assert.deepEqual([last().status, last().error, last().feed.revision], ['error', 'boom', 1], 'a failed read keeps what the view has and says why');
  mode = 'throws'; bridge.hear.listener(event(3, 'agent:follow-3')); await settle();
  assert.deepEqual([last().status, last().error], ['error', 'ipc closed']);
  mode = 'ok'; bridge.hear.listener(event(4, 'agent:follow-3')); await settle();
  assert.deepEqual([last().status, last().error, last().feed.revision], ['ok', null, 4], 'the next change reads again and clears the error');
  mode = 'gone'; bridge.hear.listener(event(5, 'agent:follow-3')); await settle();
  assert.deepEqual([last().status, last().error, last().feed.revision], ['gone', null, 4], 'gone is final and the content stays');
  const calls = bridge.calls.length; bridge.hear.listener(event(9, 'agent:follow-3')); await settle();
  assert.equal(bridge.calls.length, calls, 'nothing more is asked of a gone feed');
});

test('a view that opens again shows the feed it last had at once, and counts what came after the entry the owner last saw', async () => {
  const bridge = stubBridge(() => Promise.resolve({ ok: true, value: feed(7) })), s = splits();
  s.followFeed(bridge, 't1', 'agent:follow-4', () => {})(); await settle();
  const states = []; s.followFeed(bridge, 't1', 'agent:follow-4', state => states.push(state))();
  assert.deepEqual([states[0].status, states[0].feed.revision], ['ok', 7], 'the cached feed is the first thing shown');
  const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.deepEqual([s.unreadAfter(entries, 'd'), s.unreadAfter(entries, 'b'), s.unreadAfter(entries, 'gone'), s.unreadAfter(entries, null), s.unreadAfter([], null)], [0, 2, 4, 4, 0]);
});

// ---- the view -------------------------------------------------------------------------------------------------------------------
// Hooks do nothing and the feed is a fixed state, so the view's own words can be read and its handlers called.
const hookApi = { ...React, useState: start => [typeof start === 'function' ? start() : start, () => {}], useRef: current => ({ current }), useEffect() {} };
function paneLoader(state, react = hookApi) {
  const loader = makeLoader({ '../reading/ConversationFeed': feedStub, '../terminal/terminal-screen': screenStub, '../home/send-to-agent': sendStub, react,
    '../../shared/useNow': { useNow: () => 126_000 }, './subagent-splits.ts': { ...splits(), useSubagentFeed: () => state } });
  loader('shared/i18n.ts').applyLanguage('zh');
  return loader('features/agents/SubagentPane.tsx').SubagentPane;
}
const paneProps = (patch = {}) => ({ terminalId: 't1', callId: 'dispatch:a', projectId: 'p1', onClose() {}, onError() {}, onOpenLink() {}, ...patch });
const paneMarkup = (state, patch, react) => renderToStaticMarkup(React.createElement(paneLoader(state, react), paneProps(patch)));
const ok = (patch, status = 'ok') => ({ feed: feed(3, patch), status, error: null });

test('the view names the task first, then the model, settings, state, speed and time, and renders the feed read-only with live links', () => zh(() => {
  const html = paneMarkup(ok({}));
  assert.match(html, /<section class="subagent-split" aria-label="Refactor the grid · GPT-6\.1-Sol 的输出，只读">/);
  assert.match(html, /<span class="subagent-title" title="Refactor the grid">Refactor the grid<\/span><span class="subagent-tag subagent-state is-running">运行中<\/span>/);
  assert.match(html, /<div class="subagent-meta" title="执行 · GPT-6\.1-Sol · max · 快速 · 94 token\/s · gpt-6\.1-sol">执行 · GPT-6\.1-Sol · max · 快速 · 94 token\/s<\/div>/, 'role, model, settings and speed on the quiet second line');
  assert.match(html, /<span class="subagent-elapsed" title="已运行">2:05<\/span>/, 'now is 126 s, it started at 1 s');
  assert.match(html, /<button type="button" class="icon-button" title="关闭分屏（Esc）" aria-label="关闭 Refactor the grid · GPT-6\.1-Sol 的分屏">/);
  assert.match(html, /<div class="subagent-body" tabindex="0" role="log" aria-live="off" aria-label="Refactor the grid · GPT-6\.1-Sol 的消息和工具步骤，只读">/);
  assert.match(html, /<div class="conversation-feed" data-agent="codex" data-live="true" data-entries="2" data-project="p1" data-link="function">/, 'the feed gets the agent, the project and the link handler');
  assert.match(html, /只读 · 自动跟随最新一步/);
  assert.equal(count(html, /<textarea/g), 1, 'the owner’s one text box, for the word to the agent');
  assert.match(paneMarkup(ok({ agent: 'Claude Code', rate: null })), /data-agent="claude"/);
  assert.doesNotMatch(paneMarkup(ok({ effort: null, fast: null })), /max · 快速/);
  assert.doesNotMatch(paneMarkup(ok({ rate: null })), /token\/s/, 'an unknown speed takes no room in the header: no dash, no unit');
  assert.match(html, /<div class="subagent-input-row reading-composer">/, "the input shares the reading composer");
  assert.match(html, /title="停下"[\s\S]*class="icon-button reading-send"[\s\S]*<footer class="subagent-foot">/, "Stop precedes Send above the status line");
}));

test('a finished view stays until closed, shows the time it took, and a lost record says so without losing the content', () => zh(() => {
  const done = paneMarkup(ok({ state: 'done', startedAt: 1000, endedAt: 66_000 }));
  assert.match(done, /subagent-state is-done">已完成</); assert.match(done, /<span class="subagent-elapsed" title="用时">1:05<\/span>/); assert.match(done, /只读 · 已完成，分屏保留到你关闭/);
  assert.match(done, /data-live="false"/, 'a finished conversation is no longer live');
  assert.match(paneMarkup(ok({ state: 'done', failure: { reason: 'scope', exitCode: null }, endedAt: 5000 })), /subagent-state is-done">越界</);
  const gone = paneMarkup(ok({ endedAt: null }, 'gone'));
  assert.match(gone, /subagent-state is-done">不可用</); assert.match(gone, /只读 · 记录已不在，分屏保留最后的内容/); assert.match(gone, /data-entries="2"/);
  assert.match(gone, /<span class="subagent-elapsed" title="用时">—<\/span>/, 'a lost record with no end time does not count on');
  const error = paneMarkup({ feed: feed(3), status: 'error', error: 'boom' });
  assert.match(error, /只读 · 读取失败：boom，下次变化时重试/); assert.match(error, /data-live="false"/);
  const loading = paneMarkup({ feed: null, status: 'loading', error: null });
  assert.match(loading, /aria-label="子 agent 的输出，只读"/); assert.match(loading, /<p class="subagent-empty">正在读取…<\/p>/); assert.doesNotMatch(loading, /conversation-feed/);
  assert.match(paneMarkup({ feed: null, status: 'error', error: 'no bridge' }), /<p class="subagent-empty">读取失败：no bridge<\/p>/);
  assert.match(paneMarkup(ok({ startedAt: null })), /title="已运行">—<\/span>/, 'a start the records do not give is a dash');
  assert.match(paneMarkup(ok({ state: 'done', startedAt: 1000, endedAt: null })), /title="用时">—<\/span>/, 'a finished view with no recorded end does not count on to now');
  assert.match(paneMarkup(ok({ state: 'done', startedAt: 66_000, endedAt: 66_000 })), /title="用时">—<\/span>/, 'an end that is not after the start is unknown, not 0:00');
}));

test('the view closes on Escape and on its button, and Escape never travels on to the terminal', () => zh(() => {
  const closed = [], tree = paneLoader(ok({}))(paneProps({ onClose: () => closed.push('closed') })), stopped = [];
  assert.equal(tree.type, 'section');
  const key = name => tree.props.onKeyDown({ key: name, target: { tagName: 'DIV' }, stopPropagation: () => stopped.push(name) });
  key('Enter'); key('a'); assert.deepEqual([closed, stopped], [[], []]);
  key('Escape'); assert.deepEqual([closed, stopped], [['closed'], ['Escape']]);
  elements(tree).find(node => node.type === 'button' && node.props.title === '关闭分屏（Esc）').props.onClick();
  assert.deepEqual(closed, ['closed', 'closed']);
}));

test('Escape inside the message box leaves the box with the typed word kept; Escape elsewhere in the view closes it', () => zh(() => {
  const closed = [], stopped = [], focused = [];
  const react = { ...hookApi, useRef: current => ({ current: current === null ? { focus: () => focused.push(true) } : current }) };
  const tree = paneLoader(ok({}), react)(paneProps({ onClose: () => closed.push(true) }));
  const press = tagName => tree.props.onKeyDown({ key: 'Escape', target: { tagName }, stopPropagation: () => stopped.push(tagName) });
  press('TEXTAREA');
  assert.deepEqual([closed.length, focused.length, stopped], [0, 1, ['TEXTAREA']], 'the box gives up focus, the view stays, the terminal still hears nothing');
  press('DIV');
  assert.deepEqual([closed.length, focused.length], [1, 1], 'the next Escape (focus now in the view) closes it');
}));

test('a finished Task subagent (reviewing, with an end time) takes no word, keeps the time it took and says it is done', () => zh(() => {
  const html = paneMarkup(ok({ state: 'reviewing', startedAt: 1000, endedAt: 66_000 }));
  assert.match(html, /<textarea[^>]*disabled[^>]*placeholder="它已结束或不可用，不能再发消息"/); assert.doesNotMatch(html, /<button[^>]*>停下/);
  assert.match(html, /subagent-state is-done">已完成</, 'the header agrees with the footer: the end time decides, not the feed state'); assert.doesNotMatch(html, /审核中/);
  assert.match(html, /<span class="subagent-elapsed" title="用时">1:05<\/span>/, 'the clock stopped at the end');
  assert.match(html, /只读 · 已完成，分屏保留到你关闭/);
  const reviewing = paneMarkup(ok({ state: 'reviewing', endedAt: null }));
  assert.doesNotMatch(reviewing, /<textarea[^>]*disabled/, 'a reviewer still at work can be told something'); assert.match(reviewing, /subagent-state is-reviewing">审核中</);
}));

test('a word to a dispatched worker is delivered once its resumed transcript carries it; a parent relay and a word not yet seen stay queued', () => {
  const { deliveredIds } = splits(), user = text => ({ id: text, role: 'user', text }), item = (id, text, route = 'dispatch') => ({ id, text, route });
  const entries = [user('first brief'), { id: 'a', role: 'assistant', text: '业主插话：fix the test' }, user('业主插话：fix the test\n\n业主插话：and the docs\n\n继续执行当前任务。')];
  const delivered = sent => [...deliveredIds(entries, sent)];
  assert.deepEqual(delivered([item('1', 'fix the test'), item('2', 'and the docs'), item('3', 'later word')]), ['1', '2'], 'only the owner\'s own lines count, and only words found');
  assert.deepEqual(delivered([item('1', 'fix the test'), item('2', 'fix the test')]), ['1'], 'the same word twice needs two lines');
  assert.deepEqual(delivered([item('1', 'fix the test', 'parent')]), [], 'a relay through the parent leaves no trace to check');
  assert.deepEqual([...deliveredIds([], [item('1', 'x')])], []);
});

test('a delivered word reads 已送达 under the conversation, a queued one 已排队', () => zh(() => {
  const withSent = items => { let slot = 0; return { ...hookApi, useState: start => [slot++ === 1 ? items : typeof start === 'function' ? start() : start, () => {}] }; };
  const entries = [{ id: 'u1', role: 'user', text: '业主插话：fix the test\n\n继续执行当前任务。' }];
  const html = paneMarkup(ok({ entries }), undefined, withSent([intervention(), intervention({ id: 'i2', text: 'and the docs' }), intervention({ id: 'i3', text: 'fix the test', route: 'parent' })]));
  assert.match(html, /<p>fix the test<\/p><small>已送达<\/small>/);
  assert.match(html, /<p>and the docs<\/p><small>已排队<\/small>/);
  assert.match(html, /<p>fix the test<\/p><small>已排队<\/small>/);
}));

// ---- the owner's word to the agent --------------------------------------------------------------------------------------------------
const { hookHarness } = require('./helpers/hook-harness.cjs');
const fill = (text, values = {}) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
const intervention = (patch = {}) => ({ id: 'i1', callId: 'agent:a', text: 'fix the test', at: 5, route: 'dispatch', status: 'queued', ...patch });

// SubagentInput with real hooks and a stand-in bridge; `find` looks in the view as it stands, `done` puts the globals back.
function inputView(bridge, patch = {}, fit = 0) {
  const sent = [], saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: bridge } });
  // The width-fitting hook has its own tests below; here the box shows the hint at index `fit` of the list it was given.
  const words = { queued: '已排队', delivered: '已送达', consumed: '已被读取', rejected: '未送达', unknown: '送达状态未知' };
  const hints = [], harness = hookHarness('src/features/agents/SubagentInput.tsx', { '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './subagent-input.css': {}, './native-words': { receiptWord: status => words[status] ?? null }, './useFittingHint': { ...require('../src/shared/useFittingHint.ts'), useFittingHint: (box, list) => (hints.splice(0, hints.length, ...list), list[fit] ?? '') } });
  const props = { terminalId: 't1', callId: 'agent:a', name: 'Sol', closed: false, onSent: item => sent.push(item), ...patch };
  const tree = () => elements(harness.render('SubagentInput', props).result);
  const find = tag => tree().find(node => node.type === tag), note = () => tree().find(node => node.type === 'span' && node.props.id);
  const press = (init = {}) => { const prevented = []; find('textarea').props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => prevented.push(true), ...init }); return prevented.length; };
  const type = value => find('textarea').props.onChange({ target: { value } });
  return { sent, hints, find, tree, note, press, type, done() { harness.dispose(); if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window; } };
}

test('the send button uses the same input path and a refused or failed delivery preserves the draft', async () => {
  let answer, calls = 0;
  const view = inputView({ interveneAgent: () => { calls++; return new Promise(resolve => { answer = resolve; }); } });
  const send = () => view.tree().find(node => node.type === 'button' && node.props['aria-label'] === '发送');
  try {
    assert.equal(send().props.disabled, true);
    view.type('original'); assert.equal(send().props.disabled, false); send().props.onClick();
    assert.equal(send().props.disabled, true); assert.equal(calls, 1);
    view.type('new draft'); answer({ ok: true, value: intervention({ status: 'rejected' }) }); await settle();
    assert.equal(view.find('textarea').props.value, 'new draft'); assert.deepEqual(view.sent, []);
    assert.equal(view.find('p').props.children, '未送达 · 工作者未提供原因。');
    send().props.onClick(); answer({ ok: true, value: intervention({ status: 'delivered' }) }); await settle();
    assert.equal(view.find('textarea').props.value, ''); assert.equal(view.sent.length, 1);
  } finally { view.done(); }
  const failed = inputView({ interveneAgent: async () => { throw new Error('worker disconnected'); } });
  try {
    failed.type('keep me'); failed.press(); await settle();
    assert.equal(failed.find('textarea').props.value, 'keep me'); assert.equal(failed.find('p').props.children, '未送达 · worker disconnected');
    assert.deepEqual(failed.sent, []);
  } finally { failed.done(); }
});

test('Enter sends the trimmed word; Shift+Enter, an empty box and an IME composition send nothing; a sent word clears the box and is handed on', async () => {
  const calls = [], view = inputView({ interveneAgent: async (...args) => { calls.push(args); return { ok: true, value: intervention() }; } });
  try {
    assert.equal(view.find('textarea').props.maxLength, 4000);
    view.press(); view.type('   '); view.press();
    view.type('  fix the test  ');
    assert.equal(view.press({ shiftKey: true }), 0, 'Shift+Enter is a new line, not a send');
    view.press({ nativeEvent: { isComposing: true } });
    assert.deepEqual(calls, [], 'nothing was sent yet');
    assert.equal(view.press(), 1, 'Enter is taken so it does not add a line'); await settle();
    assert.deepEqual(calls, [['t1', 'agent:a', 'fix the test']]);
    assert.equal(view.find('textarea').props.value, '', 'the box is empty once it was sent');
    assert.deepEqual(view.sent, [intervention()]);
    const receipt = view.find('p');
    assert.deepEqual([receipt.props.role, receipt.props.children], ['status', '已排队'], 'the receipt says how far the word got');
  } finally { view.done(); }
});

test('the receipt follows what main answered: delivered, read, refused or unknown; a new send replaces it and nothing names the planner', async () => {
  const answers = ['delivered', 'consumed', 'rejected', 'unknown', 'mystery'], view = inputView({ interveneAgent: async () => ({ ok: true, value: intervention({ status: answers.shift() }) }) });
  try {
    const seen = [];
    for (let round = 0; round < 5; round++) { view.type('word ' + round); view.press(); await settle(); seen.push(view.find('p').props.children); }
    assert.deepEqual(seen, ['已送达', '已被读取', '未送达 · 工作者未提供原因。', '送达状态未知', '送达状态未知'], 'an unknown status stays unknown');
    assert.doesNotMatch(seen.join(), /主会话|规划员/);
  } finally { view.done(); }
});

test('a refused word shows the reason beside the box, keeps the text and hands nothing on', async () => {
  const view = inputView({ interveneAgent: async () => ({ ok: false, error: 'The agent is not running' }) });
  try {
    view.type('please stop editing the lockfile'); view.press(); await settle();
    const note = view.find('p');
    assert.deepEqual([note.props.role, note.props.children], ['alert', '未送达 · The agent is not running']);
    assert.equal(view.find('textarea').props.value, 'please stop editing the lockfile');
    assert.deepEqual(view.sent, []);
    assert.equal(view.find('button').props.disabled, false, 'the owner can try again or stop it');
  } finally { view.done(); }
});

test('停下 asks the agent to stop through the main process and says so with its receipt; an error replaces the note', async () => {
  const calls = [], answers = [{ ok: true, value: intervention() }, { ok: true, value: intervention({ status: 'delivered' }) }, { ok: false, error: 'no such call' }];
  const view = inputView({ stopAgent: async (...args) => { calls.push(args); return answers.shift(); } });
  try {
    const stop = () => view.find('button').props.onClick();
    stop(); await settle();
    assert.deepEqual(calls, [['t1', 'agent:a']]);
    assert.deepEqual([view.find('p').props.children, view.find('p').props.role], ['已排队', 'status']);
    stop(); await settle();
    assert.equal(view.find('p').props.children, '已送达');
    stop(); await settle();
    assert.deepEqual([view.find('p').props.role, view.find('p').props.children], ['alert', '未送达 · no such call'], 'an error replaces the note');
    assert.deepEqual(view.sent, [], 'a stop is not an entry in the conversation');
  } finally { view.done(); }
});

test('a finished or lost view takes no word: the box is off and says why in its hint, 停下 is gone, and a keypress that gets through still sends nothing', async () => {
  const calls = [], answer = async (...args) => { calls.push(args); return { ok: true, value: intervention() }; };
  const view = inputView({ interveneAgent: answer, stopAgent: answer }, { closed: true });
  try {
    assert.equal(view.find('textarea').props.disabled, true);
    assert.equal(view.find('button'), undefined, 'a button that can never work is not shown beside a disabled box');
    assert.equal(view.find('textarea').props.placeholder, '它已结束或不可用，不能再发消息', 'the reason is the box’s own hint, not a second line under it');
    assert.equal(view.find('p'), undefined);
    assert.deepEqual(view.hints, ['它已结束或不可用，不能再发消息', '已结束，不能再发消息'], 'a narrow box falls back to the short reason');
    view.type('too late'); view.press(); await settle();
    assert.deepEqual(calls, []);
  } finally { view.done(); }
});

test('what the owner sent shows under the conversation as queued, with only its worker receipt', () => zh(() => {
  const withSent = items => { let slot = 0; return { ...hookApi, useState: start => [slot++ === 1 ? items : typeof start === 'function' ? start() : start, () => {}] }; };
  const html = paneMarkup(ok({}), undefined, withSent([intervention(), intervention({ id: 'i2', text: 'and the docs', route: 'parent' })]));
  assert.match(html, /<div class="subagent-sent"><p>fix the test<\/p><small>已排队<\/small><\/div>/);
  assert.match(html, /<div class="subagent-sent"><p>and the docs<\/p><small>已排队<\/small><\/div>/);
  assert.ok(html.indexOf('conversation-feed') < html.indexOf('subagent-sent') && html.indexOf('subagent-sent') < html.indexOf('subagent-input'), 'after the conversation, before the box');
  assert.equal(count(paneMarkup(ok({})), /subagent-sent/g), 0);
}));

test('the input is on while the agent runs and off in a finished view and in a lost one', () => zh(() => {
  const off = html => count(html, /<textarea[^>]*disabled/g);
  assert.deepEqual([paneMarkup(ok({})), paneMarkup(ok({ state: 'done', endedAt: 5000 })), paneMarkup(ok({}, 'gone'))].map(off), [0, 1, 1]);
}));

// ---- the activity pane's rows ---------------------------------------------------------------------------------------------------
const call = items => ({ agent: 'Codex', provider: 'OpenAI', model: 'gpt-6.1-sol', effort: 'max', fast: true, preparing: 0, running: 1, reviewing: 0, tasks: [], rate: null, items });
const item = (id, patch = {}) => ({ id, state: 'running', role: '执行', title: `Task ${id}`, startedAt: 1, endedAt: null, viewable: true, ...patch });
const paneRows = (items, terminalId) => renderToStaticMarkup(React.createElement(load('features/agents/ActivityPane.tsx').ActivityPane, { terminal: {
  id: terminalId, agent: 'claude', codexActive: true, prompts: [], agentSettings: { model: 'claude-opus-5-5', effort: 'high', fast: false }, agentUsage: { provider: 'Anthropic', limits: [], calls: [call(items)] } } }));

test('a call whose record can be read is one button on the same row; one that cannot stays a plain row; the icons and states are unchanged', () => zh(() => {
  const html = paneRows([item('agent:a'), item('dispatch:b', { state: 'done', viewable: false }), item('dispatch:c', { failure: { reason: 'killed', exitCode: null } })], 't-rows');
  assert.equal(count(html, /<button type="button" class="activity-call-open"/g), 2);
  assert.match(html, /<li class="is-running" title="Task agent:a\n点击在旁边查看它在做什么"><button type="button" class="activity-call-open" aria-pressed="false" aria-label="执行 Task agent:a，运行中"><span class="activity-row-icon">/);
  assert.match(html, /<li class="is-done" title="Task dispatch:b"><span class="activity-row-icon">/, 'not viewable: the plain row it always was, with no hint');
  assert.match(html, /aria-label="执行 Task dispatch:c，已停止"/, 'a failed call can be opened too, and says why in its state');
  assert.doesNotMatch(html, /data-icon="(Play|Split|Columns|ArrowSquare)/, 'no new icon');
  assert.equal(count(html, /<span class="activity-row-end">运行中<\/span>/g), 1);
}));

test('an open view makes its row pressed and the hint offers to close it; a click toggles that view and no other', () => zh(() => {
  const s = splits();
  s.openSplit('t-pressed', 'agent:a');
  const html = paneRows([item('agent:a'), item('agent:b')], 't-pressed');
  assert.match(html, /title="Task agent:a\n点击关闭旁边的分屏"><button type="button" class="activity-call-open" aria-pressed="true"/);
  assert.match(html, /title="Task agent:b\n点击在旁边查看它在做什么"><button type="button" class="activity-call-open" aria-pressed="false"/);
  assert.equal(paneRows([item('agent:a')], 't-elsewhere').includes('aria-pressed="true"'), false, 'another terminal’s views are not this pane’s');
  s.closeSplit('t-pressed', 'agent:a');
  // A click is driven through the card itself, with the store read straight from its snapshot instead of a render.
  const clicker = makeLoader({ '../terminal/terminal-screen': screenStub, '../home/send-to-agent': sendStub, react: { ...React, useSyncExternalStore: (subscribe, snapshot) => snapshot() } });
  clicker('shared/i18n.ts').applyLanguage('zh');
  const { CallsCard } = clicker('features/agents/ActivityPane.tsx'), store = clicker('features/agents/subagent-splits.ts');
  const rows = () => elements(CallsCard({ calls: [call([item('agent:a'), item('agent:b'), item('dispatch:c', { viewable: false })])], terminalId: 't-click' })).filter(node => node.props.className === 'activity-call-open');
  assert.equal(rows().length, 2);
  rows()[1].props.onClick();
  assert.deepEqual(store.getSplits().map(view => [view.terminalId, view.callId]), [['t-click', 'agent:b']]);
  assert.deepEqual(rows().map(node => node.props['aria-pressed']), [false, true]);
  rows()[1].props.onClick();
  assert.deepEqual(store.getSplits(), [], 'the same row again closes it');
}));

// ---- the terminal grid ----------------------------------------------------------------------------------------------------------
const terminal = id => ({ id, title: id, sessionId: `s-${id}`, status: 'running', codexActive: true, agent: 'claude', readingHistory: false });
test('a viewable row is a plain row with one full-width button: the row has a single column, so the button never lands in the 16px icon column', () => {
  const css = fs.readFileSync(path.join(src, 'features/agents/activity-pane.css'), 'utf8');
  assert.match(css, /\.activity-call-rows li:has\(> \.activity-call-open\) \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /\.activity-call-rows li > \.activity-call-open \{ display: grid; grid-template-columns: 16px minmax\(0, 1fr\) auto;/, 'the button carries the same 16 | text | state grid inside');
});

const gridMarkup = (terminals, focused) => renderToStaticMarkup(React.createElement(load('features/terminal/ProjectTerminals.tsx').ProjectTerminals, {
  project: { id: 'p1', name: 'Project', kind: 'local', terminals }, focused, fontSize: 14, activeId: terminals[0].id, setActiveId() {}, onExpand() {}, onAction: async () => undefined, onError() {}, onOpenLink() {} }));

test('open views take cells of the expanded grid after the terminals, are not terminal splits, and never appear on a small card', () => zh(() => {
  const s = splits(), one = [terminal('t-grid')];
  const bare = gridMarkup(one, true);
  assert.equal(count(bare, /subagent-slot/g), 0); assert.doesNotMatch(bare, /has-splits/, 'one conversation and no views is not a split grid');
  s.openSplit('t-grid', 'agent:a');
  const single = gridMarkup(one, true);
  assert.match(single, /terminal-grid has-splits/); assert.match(single, /style="--terminal-columns:2;--terminal-rows:1"/);
  assert.match(single, /<div class="subagent-slot"><div class="subagent-stub" data-terminal="t-grid" data-call="agent:a" data-project="p1" data-close="function"><\/div><\/div>/);
  assert.equal(count(single, /data-terminal-slot/g), 1, 'a view is no terminal slot, so the grip’s reordering never sees it');
  assert.doesNotMatch(single, /terminal-split-tools/, 'and with one terminal there are no restart or close tools to offer');
  s.openSplit('t-grid', 'agent:b');
  const replaced = gridMarkup(one, true);
  assert.deepEqual([...replaced.matchAll(/data-call="([^"]+)"/g)].map(match => match[1]), ['agent:b'], 'a second view replaces the first, never stacks beside it');
  assert.match(replaced, /style="--terminal-columns:2;--terminal-rows:1"/, 'one conversation and one view stay side by side');
  assert.doesNotMatch(replaced, /grid-row/, 'the conversation spans no rows: there is no second view to stack');
  assert.equal(count(gridMarkup(one, false), /subagent-/g), 0, 'a small card shows no views');
  assert.doesNotMatch(gridMarkup(one, false), /has-splits/);
  assert.doesNotMatch(single, /has-terminals/, 'a lone conversation beside views is not picked out by the active-split edge');
  const two = gridMarkup([terminal('t-grid'), terminal('t-grid-2')], true);
  assert.match(two, /has-terminals/, 'with several terminals the one in use is');
  assert.match(two, /terminal-split-tools/, 'with several terminals the terminals keep their own tools'); assert.doesNotMatch(two, /grid-row/);
  s.closeSplit('t-grid', 'agent:b');
}));

test('the grid is not rearranged by views of another terminal, and terminals of one project each keep their own view', () => zh(() => {
  const s = splits();
  s.openSplit('t-elsewhere', 'agent:z');
  assert.equal(count(gridMarkup([terminal('t-mine')], true), /subagent-slot/g), 0, 'a view belongs to the terminal whose pane opened it');
  s.openSplit('t-mine', 'agent:a'); s.openSplit('t-mine', 'agent:b');
  assert.deepEqual([...gridMarkup([terminal('t-mine')], true).matchAll(/data-call="([^"]+)"/g)].map(match => match[1]), ['agent:b']);
  s.openSplit('t-mine-2', 'agent:c');
  const both = gridMarkup([terminal('t-mine'), terminal('t-mine-2')], true);
  assert.deepEqual([...both.matchAll(/data-terminal="([^"]+)" data-call="([^"]+)"/g)].map(match => [match[1], match[2]]), [['t-mine', 'agent:b'], ['t-mine-2', 'agent:c']], 'each terminal keeps its own view');
  assert.doesNotMatch(both, /grid-row/);
  s.closeSplit('t-mine', 'agent:b'); s.closeSplit('t-mine-2', 'agent:c'); s.closeSplit('t-elsewhere', 'agent:z');
}));

// ---- the narrow window's way in -------------------------------------------------------------------------------------------------
// CSS hides the activity pane below 1000px; the header of the expanded project then carries a chip that opens the pane's own rows in a popover.
const chipTerminal = (id, items) => ({ id, agentUsage: { provider: 'Anthropic', limits: [], calls: [call(items)] } });
const chipMarkup = (terminal, open) => {
  const chipLoader = makeLoader({ '../terminal/terminal-screen': screenStub, '../home/send-to-agent': sendStub,
    react: { ...React, useState: () => [open, () => {}], useRef: current => ({ current }), useEffect() {}, useSyncExternalStore: (subscribe, snapshot) => snapshot() } });
  chipLoader('shared/i18n.ts').applyLanguage('zh');
  return renderToStaticMarkup(React.createElement(chipLoader('features/agents/SubagentChip.tsx').SubagentChip, { terminal }));
};

test("the narrow window's header chip: counts the called models, shows the running ones, lists the pane's own rows, and exists only for a viewable sub-agent", () => zh(() => {
  const items = [item('agent:a'), item('agent:b', { state: 'done' }), item('dispatch:c', { viewable: false, state: 'preparing' })];
  const closed = chipMarkup(chipTerminal('t-chip', items), false);
  assert.match(closed, /^<div class="subagent-chip-anchor"><button type="button" class="button small subagent-chip" aria-expanded="false" aria-haspopup="dialog">子 agent 3<span class="subagent-chip-run" title="1 个运行中"><i aria-hidden="true"><\/i>1<\/span><\/button><\/div>$/);
  assert.equal(chipMarkup(chipTerminal('t-chip', [item('agent:b', { state: 'done' })]), false).includes('subagent-chip-run'), false, 'nothing running, no running count');
  assert.equal(chipMarkup(chipTerminal('t-chip', [item('dispatch:c', { viewable: false })]), false), '', 'no readable record, no chip');
  assert.equal(chipMarkup({ id: 't-chip', agentUsage: null }, false), '', 'no calls, no chip');
  // Open: the same card the pane shows, row for row (the same buttons, so the same click and the same pressed state).
  const open = chipMarkup(chipTerminal('t-chip', items), true), pane = paneRows(items, 't-chip');
  assert.match(open, /<div class="subagent-menu" role="dialog" aria-label="子 agent">/);
  assert.match(open, /aria-expanded="true"/);
  const rows = html => html.match(/<li class="is-[^"]*"[^>]*>.*?<\/li>/gs);
  assert.equal(rows(open).length, 3, 'the three calls');
  assert.deepEqual(rows(open), rows(pane), 'the same rows as the activity pane');
  assert.equal(count(open, /<button type="button" class="activity-call-open"/g), 2);
}));

test('the chip opens on a click and closes on Escape (focus back on it, the key goes no further), on a press outside, on Tab out of it and on choosing a row', () => zh(() => {
  const slots = [], effects = [], listeners = [], focused = [];
  let cursor = 0;
  const hooks = { ...React,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(callback, deps) {
      const index = cursor++, previous = slots[index];
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
    },
    useSyncExternalStore: (subscribe, snapshot) => snapshot() };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {}, lang: '' },
    addEventListener: (name, listener, capture) => listeners.push({ name, listener, capture }),
    removeEventListener: (name, listener) => listeners.splice(0, listeners.length, ...listeners.filter(entry => entry.name !== name || entry.listener !== listener)) } });
  try {
    const chipLoader = makeLoader({ '../terminal/terminal-screen': screenStub, '../home/send-to-agent': sendStub, react: hooks });
    chipLoader('shared/i18n.ts').applyLanguage('zh');
    const { SubagentChip } = chipLoader('features/agents/SubagentChip.tsx'), { CallsCard } = chipLoader('features/agents/ActivityPane.tsx');
    const terminal = chipTerminal('t-esc', [item('agent:a')]), popup = {}, elsewhere = {};
    // Slot 0 is the open state, 1 the anchor ref, 2 the chip ref: a mounted tree would fill the refs; here the anchor knows `popup` and the chip counts focus.
    const render = () => {
      cursor = 0;
      const tree = elements(SubagentChip({ terminal }));
      slots[1] = { current: { contains: node => node === popup } }; slots[2] = { current: { focus: () => focused.push('chip') } };
      while (effects.length) effects.shift()();
      return tree;
    };
    const chip = () => render().find(node => node.type === 'button' && node.props.className === 'button small subagent-chip');
    const anchor = () => render().find(node => node.props.className === 'subagent-chip-anchor');
    const dialog = () => render().find(node => node.props.role === 'dialog');
    const listener = name => listeners.filter(entry => entry.name === name).at(-1);

    render();
    assert.equal(dialog(), undefined, 'closed at first');
    chip().props.onClick();
    assert.ok(dialog(), 'a click opens it'); assert.equal(chip().props['aria-expanded'], true);
    assert.equal(dialog().props['aria-label'], '子 agent');
    assert.equal(elements(dialog()).find(node => node.type === CallsCard).props.terminalId, 't-esc', 'the pane\'s card for this terminal');

    // Escape closes it, puts focus back on the chip and is swallowed in the capture phase, before the terminal sees it.
    const swallowed = [];
    assert.equal(listener('keydown').capture, true);
    listener('keydown').listener({ key: 'a', stopPropagation: () => swallowed.push('a') });
    assert.ok(dialog(), 'another key leaves it open'); assert.deepEqual(swallowed, []);
    listener('keydown').listener({ key: 'Escape', stopPropagation: () => swallowed.push('Escape') });
    assert.equal(dialog(), undefined); assert.deepEqual([swallowed, focused], [['Escape'], ['chip']]);
    assert.equal(listeners.length, 0, 'its listeners are let go of once it is closed');

    // A press outside closes it; one inside does not.
    chip().props.onClick(); render();
    listener('pointerdown').listener({ target: popup }); assert.ok(dialog(), 'a press inside stays');
    listener('pointerdown').listener({ target: elsewhere }); assert.equal(dialog(), undefined, 'a press outside closes');

    // Tab out of the popover closes it; moving within it does not.
    chip().props.onClick();
    anchor().props.onBlur({ relatedTarget: popup }); assert.ok(dialog());
    anchor().props.onBlur({ relatedTarget: elsewhere }); assert.equal(dialog(), undefined);

    // Choosing a row closes it and hands focus back (the pane's row has already toggled its view); the popover's own space is no choice.
    chip().props.onClick(); focused.length = 0;
    dialog().props.onClick({ target: { closest: () => null } }); assert.ok(dialog());
    dialog().props.onClick({ target: { closest: selector => selector === '.activity-call-open' ? {} : null } });
    assert.equal(dialog(), undefined); assert.deepEqual(focused, ['chip']);
  } finally { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; }
}));

test("the chip's popover is the pane's card on the menu colour, and the chip itself opens no view, writes nothing and expands nothing", () => {
  const read = file => fs.readFileSync(path.join(src, file), 'utf8'), css = read('features/agents/subagent-chip.css');
  assert.match(css, /\.subagent-menu \{ --flow-line: var\(--divider\); --flow-ink: var\(--text-1\); --flow-muted: var\(--text-2\); --flow-faint: var\(--text-3\);/, 'the pane\'s ink levels');
  assert.match(css, /\.subagent-menu \{[^}]*background: var\(--bg-menu\);/);
  assert.doesNotMatch(css, /\.subagent-menu \{[^}]*box-shadow/, 'no new shadow');
  assert.doesNotMatch(read('features/agents/SubagentChip.tsx').replace(/\/\/.*$/gm, ''), /\b(openSplit|toggleSplit|closeSplit)\(|window\.agentrix|writeTerminal|onFocus|onExpand/);
});

test("a sub-agent view's hint stays on one line, so the box keeps its 36px at any width while typed text still grows it", () => {
  const css = fs.readFileSync(path.join(src, 'features/reading/reading.css'), 'utf8');
  assert.match(fs.readFileSync(path.join(src, 'features/agents/SubagentInput.tsx'), 'utf8'), /subagent-input-row reading-composer/);
  assert.match(css, /\.reading-composer textarea::placeholder \{ color: var\(--text-2\); white-space: nowrap; overflow: hidden; \}/);
  assert.match(css, /\.reading-composer textarea \{[^}]*field-sizing: content;[^}]*min-height: 32px;/);
});

test('two splits of one model are told apart by their task: it leads the header and every accessible name, the model follows', () => zh(() => {
  const first = paneMarkup(ok({ model: 'claude-sonnet-5-5', agent: 'Claude Code', title: 'Trace the parser' })), second = paneMarkup(ok({ model: 'claude-sonnet-5-5', agent: 'Claude Code', title: 'Plan the split' }));
  const head = html => html.match(/<header class="subagent-head">.*?<\/header>/)[0];
  assert.notEqual(head(first), head(second));
  assert.ok(head(first).indexOf('Trace the parser') < head(first).indexOf('subagent-meta'), 'the task before the model');
  assert.match(head(first), /<div class="subagent-meta"[^>]*>[^<]*Sonnet 5\.5/, 'the model is on the second line');
  for (const [html, title] of [[first, 'Trace the parser'], [second, 'Plan the split']]) {
    assert.match(html, new RegExp(`aria-label="${title} · Sonnet 5\.5 的输出，只读"`));
    assert.match(html, new RegExp(`aria-label="关闭 ${title} · Sonnet 5\.5 的分屏"`));
    assert.match(html, new RegExp(`aria-label="${title} · Sonnet 5\.5 的消息和工具步骤，只读"`));
  }
  assert.match(paneMarkup(ok({ title: '' })), /aria-label="GPT-6\.1-Sol 的输出，只读"/, 'a task with no title is named by its model, as before');
}));

test('the task keeps the header’s width: only the state, the clock and the close button share its row, who it is goes on one quiet line under it, and the header stays above the feed', () => zh(() => {
  const css = fs.readFileSync(path.join(src, 'features/agents/activity-pane.css'), 'utf8');
  const row = paneMarkup(ok({})).match(/<div class="subagent-head-row">(.*?)<\/div>/)[1];
  assert.deepEqual([...row.matchAll(/class="([^"]+)"/g)].map(match => match[1]), ['agent-brand-icon agent-brand-codex', 'subagent-title', 'subagent-tag subagent-state is-running', 'subagent-elapsed', 'icon-button'], 'no role, model, settings or speed beside the task');
  assert.match(css, /\.subagent-title \{ flex: 1 1 0; min-width: 0; overflow: hidden;[^}]*text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(css, /\.subagent-meta \{ overflow: hidden;[^}]*text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(css, /\.subagent-body \{[^}]*mask-image: linear-gradient\(to bottom, transparent 0, #000 14px\);/, 'a line scrolled under the header fades instead of showing half');
  assert.match(css, /\.subagent-head \{ position: relative; z-index: 1;[^}]*background: var\(--bg-app\); \}/, 'the feed scrolling to its end clips under the header, never over it');
}));

// A sub-agent inside the session has no direct channel (main answers 未送达 for it), so its split offers no box, only the reason; a dispatched worker keeps its box.
test('a sub-agent of the session shows a grey line instead of a message box; a dispatched worker shows the box as before', () => zh(() => {
  const inside = paneMarkup(ok({}), { callId: 'agent:toolu_1' }), worker = paneMarkup(ok({}), { callId: 'dispatch:run-1' });
  assert.equal(count(inside, /<textarea/g), 0); assert.doesNotMatch(inside, /停下|icon-button reading-send/);
  assert.match(inside, /<div class="subagent-input"><p class="subagent-input-note">会话内的子代理没有直达通道，只能通过主会话与它交流。<\/p><\/div>/);
  assert.doesNotMatch(inside, /规划员|转发|粘贴/, 'nothing pasted into the planner is promised');
  assert.equal(count(worker, /<textarea/g), 1); assert.doesNotMatch(worker, /没有直达通道/);
  assert.match(paneMarkup(ok({ state: 'done', endedAt: 5000 }), { callId: 'agent:toolu_1' }), /没有直达通道/, 'a finished one gives the same reason');
}));

test('a narrow message box shows a shorter hint that fits, never a cut-off one: the longest hint comes first, the reason a finished view gives has a short form', () => {
  const view = inputView({}, { name: '实现分块偏移的修复（default） · GPT-6.1-Sol' }, 3);
  try {
    assert.equal(view.find('textarea').props.placeholder, '发消息', 'the shortest, for the narrowest box');
    assert.deepEqual(view.hints, ['给它发消息，Enter 发送，Shift+Enter 换行', '给它发消息，Enter 发送', '给它发消息', '发消息'], 'no hint carries the worker’s long name');
  } finally { view.done(); }
});

test('whenever the box shows a shortened hint, or the last resort, the full one with its keys is its tooltip and a hidden accessible description; the full hint needs neither; the box is never empty', () => {
  const full = '给它发消息，Enter 发送，Shift+Enter 换行';
  for (const fit of [1, 2, 3, 4]) {   // a shorter hint, a short one, the shortest, nothing fits
    const view = inputView({}, {}, fit);
    try {
      const box = view.find('textarea'), note = view.note();
      assert.equal(box.props.title, full); assert.equal(box.props['aria-describedby'], 'subagent-hint-t1-agent:a');
      assert.equal(note.props.id, box.props['aria-describedby']); assert.equal(note.props.children, full);
      assert.equal(note.props.style.position, 'absolute', 'not drawn');
      assert.equal(box.props.placeholder, ['给它发消息，Enter 发送', '给它发消息', '发消息', '发消息'][fit - 1], 'the visible hint is the longest that fits; when none does, the shortest — never an empty box');
    } finally { view.done(); }
  }
  const whole = inputView({}, {}, 0);
  try { assert.equal(whole.find('textarea').props.title, undefined); assert.equal(whole.find('textarea').props['aria-describedby'], undefined); assert.equal(whole.note(), undefined); } finally { whole.done(); }
  const closed = inputView({}, { closed: true }, 1);
  try { assert.equal(closed.find('textarea').props.title, '它已结束或不可用，不能再发消息', 'a finished view keeps its whole reason too'); assert.equal(closed.note().props.children, '它已结束或不可用，不能再发消息'); } finally { closed.done(); }
});

// ---- the hint that fits ---------------------------------------------------------------------------------------------------------
test('the first hint that fits the box is the one shown; when none does, none is', () => {
  const { fittingIndex } = load('shared/useFittingHint.ts'), width = text => text.length * 10, hints = ['a'.repeat(30), 'a'.repeat(20), 'a'.repeat(10)];
  assert.deepEqual([400, 300, 299, 200, 100, 99, 0].map(room => fittingIndex(hints, room, width)), [0, 0, 1, 1, 2, -1, -1]);
  assert.equal(fittingIndex(['only'], 0, width), -1);
});

test('the hook measures the box in its own font, minus its padding, and again whenever the box is resized', () => {
  const saved = ['document', 'getComputedStyle', 'ResizeObserver'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]), fonts = new Set(), observers = [];
  const canvas = { font: '', measureText: text => (fonts.add(canvas.font), { width: text.length * 10 }) };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => canvas }) } });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ font: '400 14px UI', paddingLeft: '12px', paddingRight: '12px' }) });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { constructor(run) { this.run = run; observers.push(this); } observe() {} disconnect() { this.gone = true; } } });
  const node = { clientWidth: 224 }, box = { current: node }, harness = hookHarness('src/shared/useFittingHint.ts'), hints = ['x'.repeat(25), 'x'.repeat(15), 'x'.repeat(5)];
  const shown = list => harness.render('useFittingHint', box, list).result;
  try {
    assert.equal(shown(hints), hints[1], 'room is 224 - 24 = 200: the 250 wide hint does not fit, the 150 wide one does');
    assert.deepEqual([...fonts], ['400 14px UI'], 'measured in the box’s own font');
    node.clientWidth = 100; observers.at(-1).run();
    assert.equal(shown(hints), hints[2], 'the box was narrowed');
    node.clientWidth = 400; observers.at(-1).run();
    assert.equal(shown(hints), hints[0], 'and widened again');
    node.clientWidth = 224;
    assert.equal(shown(['y'.repeat(60)]), '', 'a list that changes under the box is measured afresh; when its only hint does not fit the box shows none, not a cut-off one');
    assert.equal(shown(['y'.repeat(5)]), 'y'.repeat(5), 'and shows it as soon as it does');
    assert.ok(observers[0].gone, 'the old list’s observer was let go');
  } finally {
    harness.dispose();
    for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  }
});
