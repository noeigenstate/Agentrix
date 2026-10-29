// Guards for the invariants in electron/features/terminal/BOUNDARY.md and src/features/terminal/BOUNDARY.md that no
// other test covered.
const { test } = require('node:test');
const assert = require('node:assert/strict');
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
  const calls = [], screen = [];
  let terminal;
  const node = parentElement => ({ parentElement, clientWidth: 800, clientHeight: 400, dataset: {}, addEventListener: noop, removeEventListener: noop, setAttribute: noop, removeAttribute: noop, contains: () => false, closest: () => null, focus: noop });
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
    '@xterm/xterm': { Terminal }, '@xterm/xterm/css/xterm.css': {},
    './terminal-popup': { registerReadingTerminal: () => noop }, './terminal-fit': { fitTerminal: noop },
    './terminal-links': { createTerminalLinkProvider: noop }, './terminal-styling': { styleTerminal: () => disposable },
    './terminal-theme': { terminalOptions: { fontWeight: 400 }, terminalTheme: noop },
    './terminal-renderer': { gpuRenderer: () => ({ set: noop, dispose: noop }), setTerminalWeight: noop, terminalRenderer: () => 'dom', useTerminalRenderer: () => 'dom' },
    './terminal-font': { terminalFontFamily: () => 'monospace' },
    './terminal-screen': { registerScreen: () => noop, writeScreen: (id, data) => screen.push(data) },
    './i18n': { t: text => text }, './platform': { isMac: false, isWindows: false },
  });
  t.after(() => { harness.dispose(); restore(); });
  harness.render('TerminalPane', { id: 'terminal', sessionId: 'session', fontSize: 14, focused: true, onError: assert.fail, onOpenLink: noop });
  return { calls, screen, terminal };
}

function keydown(key, code, modifiers = {}) {
  const event = { type: 'keydown', key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, isComposing: false, prevented: false, ...modifiers };
  event.preventDefault = () => { event.prevented = true; };
  return event;
}

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

test('programs may write the clipboard through OSC 52, but a read request never sends the clipboard to the program', async t => {
  const { calls, terminal } = paneHarness(t);
  const osc = terminal.osc.get(52);
  assert.equal(osc('c;' + Buffer.from('copied text').toString('base64')), true);
  assert.equal(osc('c;?'), true);
  assert.equal(osc('c;not base64!'), true);
  await flush();
  assert.deepEqual(calls.filter(call => typeof call !== 'string' || call === 'read-clipboard'), [['copy', 'copied text']]);
});

test("typing, selecting or copying in a small card's terminal never expands the project", t => {
  const restore = setGlobals({ ResizeObserver: class { observe() {} disconnect() {} } });
  const expanded = [], selected = [];
  const harness = hookHarness('src/features/terminal/ProjectTerminals.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }),
    './AgentLauncher': { AgentLauncher: () => null }, './TerminalPane': { TerminalPane: () => null },
    './ReadingView': { ReadingView: () => null },
    './reading-mode': { useTerminalChoice: () => [], syncReading: noop, setReading: noop, readingShown: () => false },
    './useProjectReorder': { TERMINAL_SPLITS: {}, useReorder: () => ({}) }, './i18n': { t: text => text },
  });
  t.after(() => { harness.dispose(); restore(); });
  const agent = { id: 'agent', title: 'agent', sessionId: 'session', status: 'running', codexActive: true };
  const tree = harness.render('ProjectTerminals', { project: { id: 'p', name: 'p', terminals: [agent] }, focused: false, fontSize: 14, activeId: null,
    setActiveId: id => selected.push(id), onExpand: () => expanded.push('expand'), onAction: noop, onError: noop, onOpenLink: noop }).result;
  const nodes = elements(tree), split = nodes.find(node => node.props?.['data-terminal-id'] === 'agent');
  // Every pointer press and focus inside a split (typing, a drag selection, the copy menu) reaches it through these.
  split.props.onPointerDownCapture(); split.props.onFocusCapture();
  const pane = nodes.find(node => node.props?.sessionId === 'session' && node.props?.id === 'agent');
  for (const value of Object.values(pane.props)) if (typeof value === 'function') value('agent', 'target');
  assert.deepEqual(selected, ['agent', 'agent']);
  assert.deepEqual(expanded, [], 'only the project header, the waiting-status action and explicit expand buttons expand');
  const source = fs.readFileSync(path.join(__dirname, '../src/features/terminal/TerminalPane.tsx'), 'utf8');
  assert.doesNotMatch(source, /expand|onFocus\s*\(/i, 'the terminal itself has no way to expand its project');
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
