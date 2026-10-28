const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function fixture(file) {
  const frames = new Map(), resize = [], mutations = [], changes = [];
  let sequence = 0, target, moving = false, preferenceChange;
  const host = () => ({ events: new Map(), addEventListener(type, fn) { this.events.set(type, fn); }, removeEventListener(type) { this.events.delete(type); } });
  const window = { ...host(), innerWidth: 1000, innerHeight: 700 };
  const document = { ...host(), documentElement: { dataset: { motion: 'smooth' } }, body: {}, querySelector: () => null };
  const preference = { matches: false, addEventListener(_name, fn) { preferenceChange = fn; }, removeEventListener() { preferenceChange = undefined; } };
  const exports = {};
  const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/shared/', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, { exports, document, window, matchMedia: () => preference,
    requestAnimationFrame(fn) { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class {
      constructor(fn) { this.callback = fn; resize.push(this); }
      observe(element) { this.element = element; } disconnect() { this.element = null; }
    },
    MutationObserver: class {
      constructor(fn) { this.callback = fn; mutations.push(this); }
      observe(element) { this.element = element; } disconnect() { this.element = null; }
    },
  });
  const element = box => ({ box, getBoundingClientRect() { return this.box; }, closest: () => moving ? {} : null });
  target = element({ left: 10, top: 20, width: 400, height: 300 });
  return { exports, window, document, preference, resize, changes,
    get target() { return target; }, set target(value) { target = value; }, element,
    start: () => exports.observeBounds(() => target, box => changes.push(box)),
    get pendingFrames() { return frames.size; }, set moving(value) { moving = value; },
    mutate() { for (const item of mutations) if (item.element) item.callback(); },
    mediaChange(value) { preference.matches = value; preferenceChange?.(); },
    frame() { for (const [id, fn] of [...frames]) { frames.delete(id); fn(16); } },
  };
}

test('bounds tracking is idle at rest and coalesces layout notifications without unchanged updates', () => {
  const f = fixture('observeBounds.ts'), stop = f.start();
  assert.equal(f.changes.length, 1); assert.equal(f.pendingFrames, 0);
  f.mutate(); f.mutate(); f.resize[0].callback();
  assert.equal(f.pendingFrames, 1); f.frame();
  assert.equal(f.changes.length, 1); assert.equal(f.pendingFrames, 0);
  f.target.box.left = 30; f.mutate(); f.frame();
  assert.equal(f.changes.length, 2); assert.equal(f.changes[1].left, 30);
  stop();
});

test('bounds tracking follows every focus/drag frame and stops polling when the motion ends', () => {
  const f = fixture('observeBounds.ts'), stop = f.start();
  f.moving = true; f.mutate(); f.frame();
  assert.equal(f.pendingFrames, 1); assert.equal(f.changes.length, 1);
  for (const left of [25, 60, 100]) { f.target.box.left = left; f.frame(); }
  assert.deepEqual(f.changes.map(box => box.left), [10, 25, 60, 100]);
  f.moving = false; f.frame(); assert.equal(f.pendingFrames, 0);
  f.mutate(); stop(); assert.equal(f.pendingFrames, 0);
  f.mutate(); assert.equal(f.pendingFrames, 0);
});

test('bounds tracking rebinds replaced cards, reports disappearance and cleans up scroll/resize', () => {
  const f = fixture('observeBounds.ts'), stop = f.start();
  f.target = f.element({ left: 20, top: 40, width: 200, height: 300 }); f.mutate(); f.frame();
  assert.equal(f.resize[0].element, f.target);
  f.target = null; f.mutate(); f.frame(); assert.equal(f.changes.at(-1), null);
  f.target = f.element({ left: 20, top: 40, width: 200, height: 300 }); f.document.events.get('scroll')(); f.frame();
  assert.equal(f.changes.at(-1).width, 200);
  f.window.innerWidth = 800; f.window.events.get('resize')(); f.frame();
  assert.equal(f.changes.length, 5, 'viewport changes reposition overlays even when the target stays still');
  stop(); assert.equal(f.window.events.size, 0); assert.equal(f.document.events.size, 0);
});

test('imperative motion observes live app and system settings and releases its listeners', () => {
  const f = fixture('motion.ts'), states = [];
  const stop = f.exports.observeMotion(() => states.push(f.exports.motionReduced()));
  f.exports.applyMotion('off'); f.mutate();
  f.exports.applyMotion('smooth'); f.mutate(); f.mediaChange(true);
  f.exports.applyMotion('system'); f.mutate(); f.mediaChange(false);
  assert.deepEqual(states, [true, false, false, true, false]);
  stop(); f.mutate(); f.mediaChange(true); assert.equal(states.length, 5);
});
