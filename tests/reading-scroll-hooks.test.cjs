const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hookHarness } = require('./helpers/hook-harness.cjs');
const { blocks } = require('../src/features/reading/useVisibleTail.ts');
const entries = count => Array.from({ length: count }, (_, index) => ({ id: String(index), role: 'assistant', at: 0 }));

function scrollHarness(t) {
  const handlers = {}, writes = [], frames = new Map(); let frame = 0, resize;
  const node = {
    scrollTop: 0, scrollHeight: 1000, clientHeight: 200,
    scrollTo(options) { writes.push(options); if (options.behavior !== 'smooth') this.scrollTop = Math.max(0, Math.min(options.top, this.scrollHeight - this.clientHeight)); },
    addEventListener(name, handler) { handlers[name] = handler; }, removeEventListener() {},
  };
  const globals = {
    requestAnimationFrame: callback => { frames.set(++frame, callback); return frame; },
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} disconnect() {} },
    window: { addEventListener() {}, removeEventListener() {} },
  };
  const descriptors = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const harness = hookHarness('src/features/reading/useStickToBottom.ts');
  t.after(() => {
    harness.dispose();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const container = { current: node }, content = { current: {} };
  return {
    node, writes, handlers, container,
    render: (list, key = 'terminal:session') => harness.render('useStickToBottom', container, content, list, key),
    resize: () => resize(),
    frame: () => { for (const callback of frames.values()) callback(); frames.clear(); },
  };
}

test('the first nonempty layout pins instantly and becomes ready before paint', t => {
  const h = scrollHarness(t), empty = [];
  assert.equal(h.render(empty).result.ready, false);
  h.node.scrollHeight = 2000;
  const frame = h.render(entries(40));
  assert.equal(frame.renders[0].ready, false, 'list begins hidden');
  assert.equal(frame.result.ready, true, 'layout update reveals it before paint');
  assert.equal(h.node.scrollTop, 1800);
  assert.ok(h.writes.every(write => write.behavior === 'instant'));
});

test('switching terminal or session resets readiness, follow state and unseen IDs', t => {
  const h = scrollHarness(t), list = entries(40);
  h.render(list); h.frame();
  h.handlers.wheel({ deltaY: -1 }); h.node.scrollTop = 100; h.handlers.scroll();
  assert.equal(h.render([...list, { id: 'new' }]).result.unseen, 1);
  for (const key of ['second:session', 'second:new-session']) {
    h.node.scrollTop = 0;
    const frame = h.render(list, key);
    assert.equal(frame.renders[0].ready, false);
    assert.deepEqual([frame.result.stuck, frame.result.unseen, frame.result.ready], [true, 0, true]);
    assert.equal(h.node.scrollTop, 800);
  }
});

test('stuck streaming and resize pin instantly; a scrolled-up reader stays and counts only new IDs', t => {
  const h = scrollHarness(t), list = entries(40);
  h.render(list); h.frame();
  h.node.scrollHeight = 1200; h.resize();
  assert.equal(h.node.scrollTop, 1000); h.frame();
  h.node.scrollHeight = 1400; h.render([...list, { id: 'new' }]);
  assert.equal(h.node.scrollTop, 1200); h.frame();
  h.handlers.wheel({ deltaY: -20 }); h.node.scrollTop = 300; h.handlers.scroll();
  const count = h.writes.length;
  h.node.scrollHeight = 1600;
  assert.equal(h.render([...list, { id: 'new' }, { id: 'newer' }]).result.unseen, 1);
  h.resize(); assert.equal(h.node.scrollTop, 300); assert.equal(h.writes.length, count);
  assert.equal(h.render([...list, { id: 'new', text: 'updated' }, { id: 'newer' }]).result.unseen, 1);
});

test('prepending a history page keeps the new-message count at zero while live arrivals still count', t => {
  const h = scrollHarness(t), list = entries(80);
  h.render(list); h.frame();
  h.handlers.wheel({ deltaY: -20 }); h.node.scrollTop = 300; h.handlers.scroll();
  const older = Array.from({ length: 40 }, (_, n) => ({ id: `old-${n}` }));
  assert.equal(h.render([...older, ...list]).result.unseen, 0);
  assert.equal(h.render([...older, ...list, { id: 'new-live-message' }]).result.unseen, 1);
});

test('a live reply arriving before the unchanged pending card counts once; prepends and prompt receipts do not', t => {
  const h = scrollHarness(t), list = [...entries(2), { id: 'pending:echo' }];
  h.render(list); h.frame(); h.handlers.wheel({ deltaY: -20 }); h.node.scrollTop = 300; h.handlers.scroll();
  assert.equal(h.render([...entries(2), { id: 'new' }, { id: 'pending:echo' }]).result.unseen, 1);
  assert.equal(h.render([{ id: 'old' }, ...entries(2), { id: 'new' }, { id: 'pending:echo' }]).result.unseen, 1);
});

test('automatic content growth interrupts a smooth latest-button jump with an instant pin', t => {
  const h = scrollHarness(t), list = entries(40);
  const initial = h.render(list).result; h.frame();
  h.node.scrollTop = 200; initial.toBottom('smooth');
  assert.equal(h.writes.at(-1).behavior, 'smooth');
  h.node.scrollHeight = 1500; h.resize();
  assert.equal(h.writes.at(-1).behavior, 'instant');
  assert.equal(h.node.scrollTop, 1300);
  h.node.scrollTop = 0; initial.toBottom();
  assert.equal(h.writes.at(-1).behavior, 'instant', 'sending a prompt does not animate');
});

test('earlier-page layout compensates scroll height and anchors streamed arrivals', t => {
  const harness = hookHarness('src/features/reading/useVisibleTail.ts'); t.after(() => harness.dispose());
  let held = 0;
  const node = { scrollTop: 230, scrollHeight: 1000, scrollTo(options) { assert.equal(options.behavior, 'instant'); this.scrollTop = options.top; } };
  const container = { current: node }, list = blocks(entries(100));
  const render = (grouped, key = 'first', stuck = false) => harness.render('useVisibleTail', grouped, key, container, stuck, () => held++).result;
  const initial = render(list, 'first', true);
  assert.equal(initial.visible.length, 40); initial.showEarlier(); node.scrollHeight = 1800;
  const earlier = render(list);
  assert.equal(held, 1); assert.equal(earlier.visible.length, 80); assert.equal(earlier.earlier, 20);
  assert.equal(node.scrollTop, 1030);
  const streaming = render(blocks(entries(102)));
  assert.equal(streaming.visible[0].entry.id, '20'); assert.equal(streaming.visible.length, 82);
  assert.equal(node.scrollTop, 1030);
  assert.equal(render(list, 'second', true).visible.length, 40, 'another session starts with one tail page');
});

test('a paged prepend waits for its asynchronous entries and compensates once they commit', async t => {
  const harness = hookHarness('src/features/reading/useVisibleTail.ts'); t.after(() => harness.dispose());
  let complete, held = 0;
  const node = { scrollTop: 150, scrollHeight: 1000, scrollTo(options) { this.scrollTop = options.top; } };
  const container = { current: node }, list = blocks(entries(80));
  const remote = { paged: true, hasEarlier: true, loading: false, loadEarlier: () => new Promise(resolve => { complete = resolve; }) };
  const render = (grouped = list, options = remote) => harness.render('useVisibleTail', grouped, 'session', container, false, () => held++, options).result;
  const initial = render(); assert.equal(initial.visible.length, 80); assert.equal(initial.earlier, 0); assert.equal(initial.hasEarlier, true);
  const loading = initial.showEarlier(); render(list, { ...remote, loading: true });
  assert.equal(node.scrollTop, 150);
  complete(true); await loading; node.scrollHeight = 1600;
  const prepended = blocks([...Array.from({ length: 40 }, (_, n) => ({ id: `old${n}`, role: 'assistant', at: 0 })), ...entries(80)]);
  assert.equal(render(prepended).visible.length, 120);
  assert.equal(node.scrollTop, 750); assert.equal(held, 1);
  render(prepended); assert.equal(node.scrollTop, 750);
});

test('returning to the bottom releases the prepend ResizeObserver before later image or Markdown growth', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let active = false, resize, position = 300;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  globalThis.ResizeObserver = class { constructor(callback) { resize = callback; } observe() { active = true; } disconnect() { active = false; } };
  const h = hookHarness('src/features/reading/useVisibleTail.ts');
  t.after(() => { h.dispose(); if (previous) Object.defineProperty(globalThis, 'ResizeObserver', previous); else delete globalThis.ResizeObserver; });
  const anchor = { isConnected: true, getBoundingClientRect: () => ({ top: position - node.scrollTop, bottom: position - node.scrollTop + 30 }) };
  const node = { scrollTop: 150, scrollHeight: 1000, firstElementChild: {}, getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [anchor],
    scrollTo({ top }) { this.scrollTop = top; }, addEventListener() {}, removeEventListener() {} };
  const container = { current: node }, list = blocks(entries(100));
  const render = stuck => h.render('useVisibleTail', list, 'session', container, stuck, () => {}).result;
  render(false).showEarlier(); position += 600; node.scrollHeight += 600; render(false);
  assert.equal(node.scrollTop, 750); assert.equal(active, true);
  node.scrollTop = 1400; render(true); assert.equal(active, false);
  position += 100; node.scrollHeight += 100; if (active) resize();
  assert.equal(node.scrollTop, 1400, 'the old anchor cannot drag a latest-button or composer jump back');
});
