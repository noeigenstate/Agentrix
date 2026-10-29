const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerReadingTerminal, mountReadingTerminal, pruneReadingCli } = require('../src/features/terminal/terminal-popup.ts');

function terminalHarness(t) {
  const saved = ['document', 'getComputedStyle', 'ResizeObserver'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const observers = [], sizes = [];
  globalThis.document = { activeElement: null };
  globalThis.getComputedStyle = node => ({ getPropertyValue: name => String(name === 'width' ? node.width : name === 'height' ? node.height : 0) });
  globalThis.ResizeObserver = class {
    constructor(resize) { this.resize = resize; observers.push(this); }
    observe(node) { this.node = node; }
    disconnect() { this.stopped = true; }
  };
  const container = (width, height) => ({
    width, height, children: [],
    appendChild(node) { this.insertBefore(node, null); },
    insertBefore(node, next) {
      if (node.parentElement) node.parentElement.children.splice(node.parentElement.children.indexOf(node), 1);
      const index = next ? this.children.indexOf(next) : this.children.length;
      assert.ok(index >= 0); this.children.splice(index, 0, node); node.parentElement = this;
    },
  });
  const original = container(800, 400), popup = container(780, 350);
  const textarea = {}, element = { contains: node => node === textarea }, sibling = {};
  original.appendChild(element); original.appendChild(sibling); element.nextSibling = sibling;
  const terminal = {
    element, cols: 80, rows: 20, options: { scrollback: 0 },
    _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } }, clear() {} } },
    resize(cols, rows) { this.cols = cols; this.rows = rows; sizes.push([cols, rows]); },
    refresh() {}, focus() { document.activeElement = textarea; }, blur() { document.activeElement = null; },
  };
  const unregister = registerReadingTerminal('t', 's', terminal);
  t.after(() => { unregister(); pruneReadingCli(new Set()); for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  return { terminal, original, popup, element, sibling, textarea, observers, sizes, unregister, container };
}

test('the popup moves the same xterm, refits on both moves and resize, and restores its exact DOM position', t => {
  const h = terminalHarness(t), renderer = h.terminal._core;
  const restore = mountReadingTerminal('t', 's', h.popup);
  assert.equal(h.popup.children[0], h.element); assert.equal(document.activeElement, h.textarea);
  assert.deepEqual(h.sizes, [[78, 17]]);
  h.popup.width = 700; h.observers[0].resize(); assert.deepEqual(h.sizes.at(-1), [70, 17]);
  restore(); restore();
  assert.deepEqual(h.original.children, [h.element, h.sibling]);
  assert.equal(h.element.parentElement, h.original); assert.equal(h.terminal._core, renderer);
  assert.deepEqual(h.sizes.at(-1), [80, 20]); assert.equal(document.activeElement, null);
  assert.equal(h.observers[0].stopped, true);
});

test('restoring the terminal leaves a newly selected terminal or composer in focus', t => {
  const h = terminalHarness(t), restore = mountReadingTerminal('t', 's', h.popup);
  const other = {}; document.activeElement = other;
  restore(); assert.equal(document.activeElement, other);
});

test('session mismatches cannot move a terminal, and pruning or disposal restores a terminal before it is removed', t => {
  const h = terminalHarness(t);
  assert.throws(() => mountReadingTerminal('t', 'other-session', h.popup), /not ready/);
  const restore = mountReadingTerminal('t', 's', h.popup);
  pruneReadingCli(new Set([JSON.stringify(['t', 's'])])); assert.equal(h.element.parentElement, h.popup);
  pruneReadingCli(new Set()); assert.equal(h.element.parentElement, h.original);
  restore(); h.unregister();
  assert.throws(() => mountReadingTerminal('t', 's', h.popup), /not ready/);
});

test('replacing a popup restores the original host before moving to the next one', t => {
  const h = terminalHarness(t), second = h.container(600, 300);
  const firstRestore = mountReadingTerminal('t', 's', h.popup);
  const secondRestore = mountReadingTerminal('t', 's', second);
  firstRestore(); assert.equal(h.element.parentElement, second);
  secondRestore(); assert.equal(h.element.parentElement, h.original);
});

test('a failed popup mount restores xterm instead of leaving it in a discarded modal', t => {
  const h = terminalHarness(t);
  h.terminal.focus = () => { throw new Error('focus failed'); };
  assert.throws(() => mountReadingTerminal('t', 's', h.popup), /focus failed/);
  assert.equal(h.element.parentElement, h.original); assert.equal(h.observers[0].stopped, true);
});
