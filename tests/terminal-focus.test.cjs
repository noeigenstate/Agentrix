const { test } = require('node:test');
const assert = require('node:assert/strict');
const jsx = require('react/jsx-runtime');
const { hookHarness } = require('./helpers/hook-harness.cjs');

function terminalHarness(t, initial = {}) {
  const noop = () => {}, disposable = { dispose: noop };
  const frames = new Map(), terminals = [], fits = [], focused = [];
  let sequence = 0;
  const node = (className, parentElement = null) => ({
    className, parentElement, clientWidth: 800, clientHeight: 400,
    addEventListener: noop, removeEventListener: noop,
    contains(target) { for (; target; target = target.parentElement) if (target === this) return true; return false; },
    closest(selector) { for (let target = this; target; target = target.parentElement) if (`.${target.className}` === selector) return target; return null; },
    focus() { document.activeElement = this; },
  });
  const body = node('body'), split = node('terminal-split', body), host = node('terminal-host', node('terminal-split-body', split));
  const observer = class { observe() {} disconnect() {} };
  const globals = {
    document: { body, activeElement: body, documentElement: { dataset: {} } },
    window: { agentrix: {
      onTerminalData: () => noop, onTerminalPaste: () => noop, terminalFocus: noop,
      attachTerminal: async () => ({ ok: true, value: { sessionId: 'session', seq: 0, data: '' } }),
    } },
    requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: id => frames.delete(id), MutationObserver: observer, ResizeObserver: observer,
  };
  const descriptors = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  class Terminal {
    constructor(options) { this.options = options; this.parser = { registerOscHandler: () => disposable }; terminals.push(this); }
    open(parent) { this.element = node('xterm', parent); this.textarea = node('xterm-helper-textarea', this.element); }
    focus() { focused.push(this); this.textarea.focus(); }
    registerLinkProvider() { return disposable; }
    onData() { return disposable; }
    onSelectionChange() { return disposable; }
    onResize() { return disposable; }
    attachCustomKeyEventHandler() {}
    dispose() { if (document.activeElement === this.textarea) body.focus(); }
  }
  const harness = hookHarness('src/features/terminal/TerminalPane.tsx', {
    'react/jsx-runtime': { ...jsx, jsx: (type, props) => { if (props.className === 'terminal-host') props.ref.current = host; return jsx.jsx(type, props); } },
    '@xterm/xterm': { Terminal }, '@xterm/xterm/css/xterm.css': {},
    './terminal-popup': { registerReadingTerminal: () => noop },
    './terminal-fit': { fitTerminal: terminal => fits.push(terminal) },
    './terminal-links': { createTerminalLinkProvider: noop }, './terminal-styling': { styleTerminal: () => disposable },
    './terminal-theme': { terminalOptions: { fontWeight: 400 }, terminalTheme: noop },
    './terminal-renderer': { gpuRenderer: () => ({ set: noop, dispose: noop }), setTerminalWeight: noop, terminalRenderer: () => 'dom', useTerminalRenderer: () => 'dom' },
    './terminal-font': { terminalFontFamily: () => 'monospace' }, './terminal-screen': { registerScreen: () => noop, writeScreen: noop },
    './i18n': { t: text => text }, './platform': { isMac: false, isWindows: false },
  });
  t.after(() => {
    harness.dispose();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  let props = { id: 'terminal', sessionId: 'session', fontSize: 14, focused: false, onError: assert.fail, onOpenLink: noop, ...initial };
  const render = (patch = {}) => { props = { ...props, ...patch }; harness.render('TerminalPane', props); };
  const frame = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } };
  render(); frame(); fits.length = 0; focused.length = 0;
  return { node, body, split, frames, fits, focused, terminals, render, frame };
}

test('activating a split preserves intentional tool focus through delayed autofocus', t => {
  const h = terminalHarness(t), tools = h.node('terminal-split-tools', h.split);
  for (const name of ['restart', 'close']) {
    h.render({ focused: false }); h.body.focus(); h.render({ focused: true });
    const control = h.node(name, tools);
    control.focus(); // Focus can change after the effect schedules its frame.
    const fits = h.fits.length;
    h.frame();
    assert.equal(document.activeElement, control, `${name} retains keyboard focus`);
    assert.equal(h.fits.length, fits, 'activation leaves fitting to the settled ResizeObserver');
  }
  assert.equal(h.focused.length, 0);
});

test('activation still autofocuses from project controls, another split or a detached control', t => {
  const h = terminalHarness(t), other = h.node('terminal-split', h.body);
  for (const target of [h.body, h.node('project-menu', h.body), h.node('restart', other), h.node('xterm-helper-textarea', other), h.node('removed-control')]) {
    h.render({ focused: false }); target.focus(); h.render({ focused: true });
    assert.equal(document.activeElement, target, 'autofocus waits until the next frame');
    h.frame();
    assert.equal(document.activeElement, h.terminals.at(-1).textarea);
  }
  assert.equal(h.focused.length, 5);
  assert.equal(h.fits.length, 0);
});

test('returning from reading and replacing a session retain fallback autofocus', t => {
  const h = terminalHarness(t);
  h.node('reading-composer', h.split).focus();
  h.body.focus(); // Unmounting the reading composer releases its DOM focus.
  h.render({ focused: true }); h.frame();
  const previous = h.terminals.at(-1);
  assert.equal(document.activeElement, previous.textarea);
  h.render({ sessionId: 'replacement' });
  assert.equal(document.activeElement, h.body, 'the disposed session releases focus before the frame');
  h.frame();
  assert.notEqual(h.terminals.at(-1), previous);
  assert.equal(document.activeElement, h.terminals.at(-1).textarea);
  assert.equal(h.focused.length, 2);
});

test('autofocus requires a focused live session and cancels when the split becomes inactive', t => {
  const h = terminalHarness(t, { sessionId: null, focused: true });
  assert.equal(h.terminals.length, 0);
  assert.equal(h.focused.length, 0);
  h.render({ sessionId: 'started' });
  assert.equal(document.activeElement, h.body);
  h.frame();
  assert.equal(document.activeElement, h.terminals.at(-1).textarea);
  h.render({ focused: false }); h.body.focus();
  h.render({ sessionId: 'background-session' }); h.frame();
  assert.equal(document.activeElement, h.body, 'background sessions do not take focus');
  h.render({ focused: true }); h.render({ focused: false });
  assert.equal(h.frames.size, 0, 'deactivation cancels pending autofocus');
  h.frame();
  assert.equal(document.activeElement, h.body);
  assert.equal(h.focused.length, 1);
});
