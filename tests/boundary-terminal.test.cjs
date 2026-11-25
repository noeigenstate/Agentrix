// Guards for the invariants in electron/features/terminal/BOUNDARY.md and src/features/terminal/BOUNDARY.md that no
// other test covered.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identifiers } = require('./helpers/source-structure.cjs');
const fs = require('node:fs');
const path = require('node:path');
const jsx = require('react/jsx-runtime');
const { hookHarness } = require('./helpers/hook-harness.cjs');

const noop = () => {}, disposable = { dispose: noop };
const flush = () => new Promise(resolve => setImmediate(resolve));

// Returns the restore, to run after the component's cleanups (which still use the globals).
function setGlobals(globals) {
  const saved = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  return () => { for (const [key, descriptor] of Object.entries(saved)) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; };
}

const elements = node => !node || typeof node !== 'object' ? []
  : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children)];

// A TerminalPane with a stand-in xterm and preload, recording what reaches the program, the screen and the clipboard.
function paneHarness(t, agentrix = {}) {
  const calls = [], screen = [], listeners = new Map();
  let terminal;
  const node = parentElement => ({ parentElement, clientWidth: 800, clientHeight: 400, dataset: {},
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
    setAttribute: noop, removeAttribute: noop, contains: () => false, closest: () => null, focus: noop });
  const host = node(null), observer = class { observe() {} disconnect() {} };
  const restore = setGlobals({
    document: { body: node(null), activeElement: null, documentElement: { dataset: {} } },
    window: { agentrix: {
      onTerminalData: listener => { calls.push('subscribe'); agentrix.data = listener; return noop; },
      onTerminalPaste: () => noop, terminalFocus: noop, resizeTerminal: noop,
      attachTerminal: () => { calls.push('attach'); return agentrix.attach ?? Promise.resolve({ ok: true, value: { sessionId: 'session', seq: 0, data: '' } }); },
      writeTerminal: (id, data) => calls.push(['write', data]),
      readClipboard: async () => { calls.push('read-clipboard'); return { ok: true, value: 'clipboard' }; },
      copy: async text => { calls.push(['copy', text]); return { ok: true }; },
    }, setTimeout, clearTimeout },
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop, MutationObserver: observer, ResizeObserver: observer,
  });
  class Terminal {
    constructor(options) { this.options = options; this.selection = ''; this.osc = new Map(); terminal = this;
      this.parser = { registerOscHandler: (code, handler) => { this.osc.set(code, handler); return disposable; } }; }
    open(parent) { this.element = node(parent); this.textarea = node(this.element); }
    attachCustomKeyEventHandler(handler) { this.keys = handler; }
    hasSelection() { return !!this.selection; }
    getSelection() { return this.selection; }
    selectAll() { calls.push('select-all'); }
    paste(text) { calls.push(['paste', text]); }
    focus() {} registerLinkProvider() { return disposable; } onData() { return disposable; }
    onSelectionChange() { return disposable; } onResize() { return disposable; } dispose() {}
  }
  const harness = hookHarness('src/features/terminal/TerminalPane.tsx', {
    'react/jsx-runtime': { ...jsx, jsx: (type, props) => { if (props.className === 'terminal-host') props.ref.current = host; return jsx.jsx(type, props); } },
    'react-dom': { createPortal: element => element },
    '@xterm/xterm': { Terminal }, '@xterm/xterm/css/xterm.css': {},
    './terminal-popup': { registerReadingTerminal: () => noop }, './terminal-fit': { fitTerminal: noop },
    './terminal-links': { createTerminalLinkProvider: noop }, './terminal-styling': { styleTerminal: () => disposable },
    './terminal-theme': { terminalOptions: { fontWeight: 400 }, terminalTheme: noop },
    './terminal-renderer': { gpuRenderer: () => ({ set: noop, dispose: noop }), setTerminalWeight: noop, terminalRenderer: () => 'dom', useTerminalRenderer: () => 'dom' },
    './terminal-font': { terminalFontFamily: () => 'monospace' },
    './terminal-screen': { registerScreen: () => noop, setQueueCount: noop, setScreenAgent: noop, writeScreen: (id, data) => screen.push(data) },
    './i18n': { t: text => text }, './platform': {
      isMac: !!agentrix.mac, isWindows: false, commandShortcut: key => agentrix.mac ? '⌘' + key : 'Ctrl+' + key,
    },
  });
  t.after(() => { harness.dispose(); restore(); });
  const render = () => harness.render('TerminalPane', { id: 'terminal', sessionId: 'session', fontSize: 14,
    focused: true, agent: agentrix.agent, remote: agentrix.remote, onError: assert.fail, onOpenLink: agentrix.openLink ?? noop }).result;
  render();
  return { calls, screen, terminal, render, gesture: (name, event) => listeners.get(name)?.(event) };
}

function keydown(key, code, modifiers = {}) {
  const event = { type: 'keydown', key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, isComposing: false, prevented: false, ...modifiers };
  event.preventDefault = () => { event.prevented = true; };
  return event;
}

test('OSC 8 modifier clicks pass project paths to the link opener', t => {
  const opened = [];
  const { terminal } = paneHarness(t, { remote: true, openLink: (id, target) => opened.push([id, target]) });
  const { activate } = terminal.options.linkHandler;
  const paths = ['/srv/fixture/docs/nested', './docs/notes.txt', 'C:\\project\\notes.txt'];
  const click = { button: 0, ctrlKey: true, preventDefault: noop };
  activate({ ...click, ctrlKey: false }, paths[0]);
  activate({ ...click, button: 1 }, paths[0]);
  for (const target of paths) activate(click, target);
  assert.deepEqual(opened, paths.map(target => ['terminal', target]));
});

test('the terminal key handler passes zoom keys and Ctrl+C without a selection to the program', async t => {
  const { calls, terminal } = paneHarness(t);
  for (const [key, code, shiftKey] of [['=', 'Equal'], ['+', 'Equal', true], ['-', 'Minus'], ['0', 'Digit0'], ['c', 'KeyC']]) {
    const event = keydown(key, code, { ctrlKey: true, shiftKey: !!shiftKey });
    assert.equal(terminal.keys(event), true, `Ctrl+${key} must reach the program`);
    assert.equal(event.prevented, false, `Ctrl+${key} must not be swallowed`);
  }
  // Only copy (with a selection), paste and select-all are the window's.
  terminal.selection = 'picked';
  assert.equal(terminal.keys(keydown('c', 'KeyC', { ctrlKey: true })), false);
  await flush();
  assert.deepEqual(calls.filter(call => call[0] === 'copy'), [['copy', 'picked']]);
});

test('terminal output applies in sequence order: the attach snapshot, then newer packets of the same session only', async t => {
  let attached;
  const agentrix = { attach: new Promise(resolve => { attached = resolve; }) };
  const { calls, screen } = paneHarness(t, agentrix);
  assert.deepEqual(calls.slice(0, 2), ['subscribe', 'attach'], 'subscribe before the snapshot, so no packet falls between them');
  for (const packet of [{ seq: 4, data: 'old' }, { seq: 6, data: 'six' }, { seq: 7, data: 'other', sessionId: 'previous' }, { seq: 8, data: 'other', id: 'elsewhere' }])
    agentrix.data({ id: 'terminal', sessionId: 'session', ...packet });
  assert.deepEqual(screen, [], 'nothing is written before the snapshot');
  attached({ ok: true, value: { sessionId: 'session', seq: 5, data: 'snapshot' } });
  await flush();
  for (const seq of [6, 5, 7]) agentrix.data({ id: 'terminal', sessionId: 'session', seq, data: `again-${seq}` });
  assert.deepEqual(screen, ['snapshot', 'six', 'again-7']);
});

test('OSC 52 requires a recent gesture and shows a receipt', async t => {
  let now = 10;
  t.mock.method(performance, 'now', () => now);
  const { calls, terminal, render, gesture } = paneHarness(t, { agent: 'codex' });
  const osc = terminal.osc.get(52), text = 'c;' + Buffer.from('copied text').toString('base64');
  const copies = () => calls.filter(call => typeof call !== 'string' || call === 'read-clipboard');
  assert.equal(osc(text), true);
  gesture('keydown', { isTrusted: false }); osc(text);
  gesture('pointerdown', { isTrusted: true }); now += 3001; osc(text);
  assert.deepEqual(copies(), []);
  gesture('keydown', { isTrusted: true });
  for (const blocked of ['c;?', 'c;not base64!', 'c;' + Buffer.alloc(65537).toString('base64')]) osc(blocked);
  assert.deepEqual(copies(), []);
  osc(text); osc(text);
  await Promise.resolve();
  assert.deepEqual(copies(), [['copy', 'copied text']]);
  assert.equal(elements(render()).find(node => node.props?.role === 'status').props.children, '终端已将文字复制到剪贴板');
});

test('OSC 8 allows HTTP(S) and file URLs and blocks other URL schemes', t => {
  const urls = [], { terminal } = paneHarness(t, { openLink: (_, url) => urls.push(url) });
  const event = { ctrlKey: true, button: 0, preventDefault() {} };
  for (const url of ['javascript:void(0)', ' custom://fixture', 'https://example.test/path', 'file:///fixture.txt']) terminal.options.linkHandler.activate(event, url);
  assert.deepEqual(urls, ['https://example.test/path', 'file:///fixture.txt']);
});

test("typing, selecting or copying in a small card's terminal never expands the project", t => {
  const restore = setGlobals({ ResizeObserver: class { observe() {} disconnect() {} } });
  const expanded = [], selected = [];
  const harness = hookHarness('src/features/terminal/ProjectTerminals.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }),
    './AgentLauncher': { AgentLauncher: () => null }, './lead-sync': { LeadSync: () => null }, './TerminalPane': { TerminalPane: () => null },
    './NativeSessionView': { NativeSessionView: () => null }, './NativePathNote': { NativePathNote: () => null },
    './native-store.ts': { useNativeEntries: () => new Map(), nativeShown: () => false, ensureNativeSession() {} }, './draft-handoff.ts': { useHandoff: () => ({}) },
    './ReadingView': { ReadingView: () => null },
    './SubagentPane': { SubagentPane: () => null },
    './subagent-splits.ts': { closeSplit: noop, splitsOf: () => [], useSplits: () => [] },
    './reading-mode': { useTerminalChoice: () => [], syncReading: noop, setReading: noop, readingShown: () => false },
    './useProjectReorder': { TERMINAL_SPLITS: {}, useReorder: () => ({}) }, './i18n': { t: text => text },
  });
  t.after(() => { harness.dispose(); restore(); });
  const agent = { id: 'agent', title: 'agent', sessionId: 'session', status: 'running', cliActive: true };
  const tree = harness.render('ProjectTerminals', { project: { id: 'p', name: 'p', terminals: [agent] }, focused: false, fontSize: 14, activeId: null,
    setActiveId: id => selected.push(id), onExpand: () => expanded.push('expand'), onAction: noop, onError: noop, onOpenLink: noop }).result;
  // The card's body is drawn by the function child of the card that holds its draft handoff.
  const top = elements(tree), nodes = [...top, ...top.filter(node => typeof node.props?.children === 'function').flatMap(node => elements(node.props.children({})))], split = nodes.find(node => node.props?.['data-terminal-id'] === 'agent');
  // Every pointer press and focus inside a split (typing, a drag selection, the copy menu) reaches it through these.
  split.props.onPointerDownCapture(); split.props.onFocusCapture();
  const pane = nodes.find(node => node.props?.sessionId === 'session' && node.props?.id === 'agent');
  for (const value of Object.values(pane.props)) if (typeof value === 'function') value('agent', 'target');
  assert.deepEqual(selected, ['agent', 'agent']);
  assert.deepEqual(expanded, [], 'only the project header, the waiting-status action and explicit expand buttons expand');
  assert.deepEqual(identifiers('src/features/terminal/TerminalPane.tsx', ['expand', 'onExpand', 'onFocus']), []);
});

test('native session tests inject a fake CLI and never start the one installed on the machine', () => {
  for (const file of fs.readdirSync(__dirname).filter(name => name.endsWith('.cjs'))) {
    const text = fs.readFileSync(path.join(__dirname, file), 'utf8');
    for (const match of text.matchAll(/createNativeSession\(\{/g)) {
      let depth = 0, end = match.index + 'createNativeSession'.length;
      do { if (text[end] === '(') depth++; else if (text[end] === ')') depth--; end++; } while (depth && end < text.length);
      assert.match(text.slice(match.index, end), /\bcli\s*:/, `${file}: createNativeSession without an injected cli would run the installed CLI`);
    }
    for (const match of text.matchAll(/\bresolveCli\(([^)]*)\)/g)) assert.match(match[1], /,/, `${file}: resolveCli must be given its PATH, not read this machine's`);
  }
});

test('shortcut labels follow the platform Command and Ctrl keys', t => {
  const { rendererLoader } = require('./helpers/hook-harness.cjs');
  const { stubGlobals } = require('./helpers/renderer-fixtures.cjs');
  const navigator = { userAgent: 'Macintosh' };
  stubGlobals(t, { navigator, document: { documentElement: { dataset: {} } } });
  const shortcut = () => rendererLoader({})('src/shared/platform.ts').commandShortcut;
  assert.deepEqual(['C', 'V', 'Shift+C', 'S'].map(shortcut()), ['⌘C', '⌘V', '⌘⇧C', '⌘S']);
  navigator.userAgent = 'Windows';
  assert.deepEqual(['C', 'V', 'Shift+A', 'S'].map(shortcut()), ['Ctrl+C', 'Ctrl+V', 'Ctrl+Shift+A', 'Ctrl+S']);
});
