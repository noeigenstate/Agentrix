const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const filename = path.join(__dirname, '../src/features/workspace/useProjectReorder.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const original = ['a', 'b', 'c', 'd', 'e', 'f'];
const reordered = ['b', 'c', 'a', 'd', 'e', 'f'];

// Execute the real hook and its registered handlers. Only its host (hooks, DOM rectangles,
// event delivery and animation clock) is simulated; insertion and finish logic come from source.
function fixture(initial = reordered, { deferCommit = false } = {}) {
  let workspace = [...initial], hook, cursor = 0, sequence = 0, effects = [], clock = 0, reduced = false, motionChange;
  let styleWrites = 0;
  const values = [], dependencies = [], frames = new Map(), timers = new Map(), animations = [];
  const commits = [], pendingCommits = [], captured = new Set();
  const host = () => {
    const listeners = new Map();
    return {
      addEventListener(type, callback) { listeners.set(type, [...(listeners.get(type) || []), callback]); },
      removeEventListener(type, callback) { listeners.set(type, (listeners.get(type) || []).filter(fn => fn !== callback)); },
      handlers(type) { return [...(listeners.get(type) || [])]; },
      dispatch(type, event = {}) { for (const fn of this.handlers(type)) fn(pointer(event)); render(); },
    };
  };
  const pointer = overrides => ({ pointerId: 1, preventDefault() {}, stopPropagation() {}, ...overrides });
  const rect = (left, top, width = 400, height = 280) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const order = () => hook?.order || workspace;
  const animate = (keyframes, options) => {
    let finish;
    const animation = { keyframes, options, playState: 'running', finished: new Promise(resolve => { finish = resolve; }),
      finish() { this.playState = 'finished'; finish(); }, cancel() { this.canceled = true; this.playState = 'idle'; finish(); } };
    animations.push(animation);
    return animation;
  };
  const slots = Object.fromEntries(initial.map(id => [id, {
    dataset: { projectSlot: id },
    get offsetLeft() { return order().indexOf(id) % 3 * 412; },
    get offsetTop() { return Math.floor(order().indexOf(id) / 3) * 292; },
    offsetWidth: 400, offsetHeight: 280,
    getBoundingClientRect() { return rect(30 + this.offsetLeft, 50 + this.offsetTop); },
    getClientRects() { return [this.getBoundingClientRect()]; }, animate,
  }]));
  const panels = Object.fromEntries(initial.map(id => [id, {
    dataset: { projectId: id }, style: { setProperty() { styleWrites++; } },
    getBoundingClientRect: () => slots[id].getBoundingClientRect(), animate,
  }]));
  const area = { scrollTop: 0, getBoundingClientRect: () => rect(20, 40, 1244, 592) };
  const grid = { ...host(), scrollLeft: 0, scrollTop: 0,
    closest: () => area, querySelectorAll: () => order().map(id => slots[id]),
    getBoundingClientRect: () => rect(30, 50, 1224, 572),
    setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id), releasePointerCapture: id => captured.delete(id),
  };
  const document = host();
  const window = { ...host(), getSelection: () => ({ removeAllRanges() {} }),
    setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
  };
  const same = (a, b) => a && a.length === b.length && a.every((value, index) => value === b[index]);
  const effect = (fn, deps) => {
    const index = cursor++;
    if (!same(dependencies[index], deps)) { dependencies[index] = deps; effects.push(fn); }
  };
  const react = {
    useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in values)) values[index] = { current: initial }; return values[index]; },
    useEffect: effect, useLayoutEffect: effect,
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, window, document, getComputedStyle: () => ({ transform: 'none' }),
    requestAnimationFrame(fn) { const id = ++sequence; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    require(name) {
      if (name === 'react') return react;
      if (name === 'react-dom') return { flushSync(fn) { fn(); render(); } };
      if (name === '../../shared/motion') return { motionReduced: () => reduced, observeMotion(fn) { motionChange = fn; return () => {}; } };
      throw new Error(`Unexpected hook dependency: ${name}`);
    },
  }, { filename });
  function commit(next) {
    commits.push(Array.from(next));
    const broadcast = () => { workspace = Array.from(next); render(); };
    if (!deferCommit) { broadcast(); return Promise.resolve(); }
    return new Promise(resolve => pendingCommits.push(() => { broadcast(); resolve(); }));
  }
  function render() {
    cursor = 0; effects = [];
    hook = exports.useProjectReorder(true, '', workspace, commit);
    const pending = effects; effects = [];
    for (const fn of pending) fn();
  }
  render();
  const point = index => ({ clientX: 30 + index % 3 * 412 + 70, clientY: 50 + Math.floor(index / 3) * 292 + 70 });
  const down = (id = 'a', kind = 'name') => {
    const header = { closest: () => panels[id] };
    const target = { closest(selector) {
      if (selector === '.panel-header') return kind === 'terminal' ? null : header;
      if (selector === 'button:not(.panel-name), [role="menu"]') return kind === 'toolbar' ? {} : null;
      throw new Error(`Unexpected pick selector: ${selector}`);
    } };
    hook.onPointerDown({ ...pointer(point(order().indexOf(id))), target, currentTarget: grid, button: 0, isPrimary: true });
    render();
  };
  const activate = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } render(); };
  const frame = (elapsed = 1000 / 60) => { clock += elapsed; render(); for (const [id, fn] of [...frames]) { frames.delete(id); fn(clock); } render(); };
  const flushPromises = () => new Promise(resolve => setImmediate(resolve));
  const finishLanding = async () => { for (const animation of animations) animation.finish(); await flushPromises(); render(); };
  return {
    down, activate, frame, finishLanding,
    // A delivered movement is observed after its display frame; queueMove models coalesced input within one frame.
    move(index, overrides) { document.dispatch('pointermove', { ...point(index), ...overrides }); frame(); },
    queueMove(index, overrides) { document.dispatch('pointermove', { ...point(index), ...overrides }); },
    release(index, overrides) { document.dispatch('pointerup', { ...point(index), ...overrides }); },
    releaseHandler: () => document.handlers('pointerup')[0],
    callRelease(fn, index, overrides) { fn(pointer({ ...point(index), ...overrides })); render(); },
    cancel(type) {
      if (type === 'Escape') document.dispatch('keydown', { key: 'Escape' });
      else if (type === 'blur') window.dispatch('blur');
      else if (type === 'lostpointercapture') grid.dispatch(type);
      else document.dispatch('pointercancel');
    },
    click() { const event = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; hook.onClickCapture(event); return event; },
    resolveCommit() { assert.equal(pendingCommits.length, 1); pendingCommits.shift()(); },
    get drag() { return hook.drag; }, get order() { return Array.from(order()); }, get workspace() { return [...workspace]; },
    get commits() { return commits; }, get captured() { return captured.size; },
    get styleWrites() { return styleWrites; }, get scrollTop() { return area.scrollTop; }, get animations() { return animations; },
    motionOff() { reduced = true; motionChange(); render(); },
  };
}

test('an active release inserts at its final cell without a delivered final pointermove', async () => {
  const f = fixture(); f.down(); f.activate();
  assert.equal(f.drag.id, 'a');
  f.release(0); f.frame();
  assert.deepEqual(f.commits, [original]);
  assert.ok(f.drag, 'the floating card remains until landing finishes');
  await f.finishLanding();
  assert.deepEqual(f.workspace, original); assert.equal(f.drag, null);
});

test('release reconciles an intermediate preview with the final cell', async () => {
  const f = fixture(); f.down(); f.activate(); f.move(1);
  assert.deepEqual(f.order, ['b', 'a', 'c', 'd', 'e', 'f']);
  f.release(0); f.frame(); await f.finishLanding();
  assert.deepEqual(f.commits, [original]); assert.deepEqual(f.order, original);
});

test('coalesced release coordinates include the final row as well as the column', async () => {
  const f = fixture(); f.down(); f.activate(); f.release(3); f.frame(); await f.finishLanding();
  assert.deepEqual(f.commits, [['b', 'c', 'd', 'a', 'e', 'f']]);
});

test('an active release in the source cell remains a no-op', async () => {
  const f = fixture(); f.down(); f.activate(); f.release(2); f.frame(); await f.finishLanding();
  assert.deepEqual(f.order, reordered); assert.equal(f.commits.length, 0); assert.equal(f.drag, null);
});

test('normal delivered movement keeps the preview and commits once', async () => {
  const f = fixture(); f.down(); f.activate(); f.move(1); f.move(0);
  assert.deepEqual(f.order, original);
  f.release(0); f.frame(); await f.finishLanding();
  assert.deepEqual(f.commits, [original]);
  assert.equal(f.click().prevented, true, 'drag consumes the following click');
  assert.equal(f.click().prevented, false, 'ordinary later clicks are not suppressed');
});

test('forward insertion, Escape and reverse release preserve the original three-gesture sequence', async () => {
  const f = fixture(original); f.down(); f.activate(); f.move(1); f.move(2);
  f.release(2); f.frame(); await f.finishLanding();
  assert.deepEqual(f.workspace, reordered);
  f.down(); f.activate(); f.move(1); f.cancel('Escape'); f.release(1); f.frame(); await f.finishLanding();
  assert.deepEqual(f.workspace, reordered);
  f.down(); f.activate(); f.release(0); f.frame(); await f.finishLanding();
  assert.deepEqual(f.workspace, original); assert.deepEqual(f.commits, [reordered, original]);
});

test('a wrong pointer cannot reconcile, end, or commit the active gesture', async () => {
  const f = fixture(); f.down(); f.activate(); f.move(1);
  f.release(0, { pointerId: 2 });
  assert.deepEqual(f.order, ['b', 'a', 'c', 'd', 'e', 'f']);
  assert.equal(f.captured, 1); assert.equal(f.commits.length, 0);
  f.release(0); f.frame(); await f.finishLanding();
  assert.deepEqual(f.commits, [original]);
});

test('duplicate releases cannot change a settling draft, and stale handlers cannot change a later gesture', async () => {
  const f = fixture(); f.down(); f.activate();
  const stale = f.releaseHandler();
  f.release(0);
  f.callRelease(stale, 2);
  assert.deepEqual(f.order, original, 'settling guards run before update');
  f.frame(); await f.finishLanding();
  f.down(); f.activate();
  f.callRelease(stale, 2);
  assert.deepEqual(f.order, original, 'ended guards protect even a later active gesture');
  assert.equal(f.drag.id, 'a'); assert.deepEqual(f.commits, [original]);
  f.cancel('Escape'); f.frame(); await f.finishLanding();
});

test('an inactive click released elsewhere does not activate, reorder or suppress the click', () => {
  const f = fixture(); f.down(); f.release(0); f.activate(); f.frame();
  assert.equal(f.drag, null); assert.equal(f.captured, 0);
  assert.deepEqual(f.order, reordered); assert.equal(f.commits.length, 0);
  assert.equal(f.click().prevented, false);
});

test('release outside the grid cancels an intermediate insertion', async () => {
  const f = fixture(); f.down(); f.activate(); f.move(1);
  f.release(0, { clientX: -100 }); f.frame(); await f.finishLanding();
  assert.deepEqual(f.order, reordered); assert.equal(f.commits.length, 0); assert.equal(f.drag, null);
});

for (const reason of ['Escape', 'blur', 'pointercancel', 'lostpointercapture']) {
  test(`${reason} cancels without a commit and a stale release cannot revive it`, async () => {
    const f = fixture(); f.down(); f.activate(); f.move(1);
    const stale = f.releaseHandler();
    f.cancel(reason); f.callRelease(stale, 0); f.frame(); await f.finishLanding();
    assert.deepEqual(f.order, reordered); assert.equal(f.commits.length, 0); assert.equal(f.drag, null);
  });
}

test('clear waits for persistence as well as landing', async () => {
  const f = fixture(reordered, { deferCommit: true }); f.down(); f.activate(); f.release(0); f.frame();
  await f.finishLanding();
  assert.ok(f.drag); assert.deepEqual(f.workspace, reordered); assert.deepEqual(f.order, original);
  f.resolveCommit(); await f.finishLanding();
  assert.equal(f.drag, null); assert.deepEqual(f.workspace, original);
});

test('terminal and toolbar pointer interactions do not pick up project cards or suppress clicks', () => {
  for (const kind of ['terminal', 'toolbar']) {
    const f = fixture(); f.down('a', kind); f.activate(); f.release(0);
    assert.equal(f.drag, null); assert.equal(f.captured, 0); assert.equal(f.commits.length, 0);
    assert.equal(f.click().prevented, false);
  }
});

test('pointer motion is coalesced into one transform update per display frame', () => {
  const f = fixture(); f.down(); f.activate();
  const before = f.styleWrites;
  f.queueMove(1); f.queueMove(0); f.queueMove(1);
  assert.equal(f.styleWrites, before); assert.deepEqual(f.order, reordered);
  f.frame();
  assert.equal(f.styleWrites - before, 2);
  assert.deepEqual(f.order, ['b', 'a', 'c', 'd', 'e', 'f']);
  f.cancel('blur');
});

test('switching motion off settles an in-flight reorder and its landing without bypassing persistence', async () => {
  const f = fixture(reordered, { deferCommit: true }); f.down(); f.activate(); f.move(1);
  assert.ok(f.animations.some(animation => animation.playState === 'running'));
  f.release(0); f.frame(); f.motionOff();
  assert.ok(f.animations.every(animation => animation.playState !== 'running'));
  await f.finishLanding(); assert.ok(f.drag, 'persistence still owns the floating card');
  f.resolveCommit(); await f.finishLanding();
  assert.equal(f.drag, null); assert.deepEqual(f.workspace, original);
  f.motionOff(); assert.ok(f.animations.every(animation => animation.playState !== 'running'), 'cancelled landings never restart');
});

test('edge auto-scroll has the same speed on remote and high-refresh displays', () => {
  for (const hz of [32, 60, 144]) {
    const f = fixture(); f.down(); f.activate(); f.queueMove(2, { clientY: 630 }); f.frame();
    const before = f.scrollTop;
    for (let i = 0; i < hz; i++) f.frame(1000 / hz);
    assert.ok(Math.abs(f.scrollTop - before - 720) < 1e-8, `${hz} Hz`);
    f.cancel('blur');
  }
});
