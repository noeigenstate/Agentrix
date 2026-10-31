const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// A fresh copy per test: the module's state is the thing under test.
function freshReady() {
  const filename = path.join(__dirname, '..', 'src', 'features', 'reading', 'reading-ready.ts');
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return mod.exports;
}
const run = (overrides = {}) => ({ session: 'session', thread: undefined, start: undefined, active: true, ...overrides });
// What one rendered frame does: the view asks, then its effect remembers.
const frame = (ready, id, state, inputShown) => { const answer = ready.cliReady(id, state, inputShown); ready.rememberReady(id, state, inputShown); return answer; };

test('a terminal is ready once its CLI input was seen, and stays ready while the screen shows something else', () => {
  const ready = freshReady();
  assert.equal(frame(ready, 'a', run({ thread: 'thread' }), false), false);
  assert.equal(frame(ready, 'a', run({ thread: 'thread' }), true), true);
  assert.equal(frame(ready, 'a', run({ thread: 'thread' }), false), true, 'a dialog has no input box');
  assert.equal(frame(ready, 'b', run({ thread: 'thread' }), false), false, 'readiness is per terminal');
});

test('asking never changes what is remembered: only the effect writes', () => {
  const ready = freshReady();
  assert.equal(ready.cliReady('a', run(), true), true, 'seen in this very frame');
  assert.equal(ready.cliReady('a', run(), false), false, 'but not remembered until rememberReady');
  ready.rememberReady('a', run(), true);
  assert.equal(ready.cliReady('a', run(), false), true);
  assert.equal(ready.cliReady('a', run({ session: 'other' }), false), false);
  assert.equal(ready.cliReady('a', run(), false), true, 'a question about another session left it alone');
});

test('readiness needs a live session and an active CLI to begin, and ends with the CLI or the session', () => {
  const ready = freshReady();
  assert.equal(frame(ready, 'a', run({ session: null }), true), false);
  assert.equal(frame(ready, 'a', run({ active: false }), true), false);
  assert.equal(frame(ready, 'a', run(), true), true);
  assert.equal(frame(ready, 'a', run({ active: false }), false), false, 'the CLI stopped');
  assert.equal(frame(ready, 'a', run(), false), false, 'and must draw its input again');
  frame(ready, 'a', run(), true);
  assert.equal(frame(ready, 'a', run({ session: 'other' }), false), false, 'another session is not ready');
  assert.equal(frame(ready, 'a', run(), false), false, 'and the old one is not remembered');
});

test('a thread learned later keeps readiness, a different thread ends it, and the new thread starts ready only with its input', () => {
  const ready = freshReady();
  frame(ready, 'a', run(), true);
  assert.equal(frame(ready, 'a', run({ thread: 'first' }), false), true, 'the first turn binds the thread');
  assert.equal(frame(ready, 'a', run(), false), true, 'a missing thread is unknown, not different');
  assert.equal(frame(ready, 'a', run({ thread: 'second' }), false), false);
  assert.equal(frame(ready, 'a', run({ thread: 'second' }), true), true);
  assert.equal(frame(ready, 'a', run({ thread: 'first' }), false), false, 'the earlier thread is not remembered');
});

test('a CLI that restarted into the same session is not ready, whether or not the view was there to see it stop', () => {
  const ready = freshReady();
  frame(ready, 'a', run({ start: 100 }), true);
  assert.equal(frame(ready, 'a', run({ start: 100 }), false), true);
  assert.equal(frame(ready, 'a', run({ start: undefined }), false), true, 'an unknown start is not a different one');
  assert.equal(frame(ready, 'a', run({ start: 200 }), false), false, 'the start moved while nothing was rendering');
  assert.equal(frame(ready, 'a', run({ start: 200 }), true), true);
  assert.equal(frame(ready, 'a', run({ start: 100 }), false), false);
});

test('a dialog opens the terminal once, until the view says the CLI has moved on', () => {
  const ready = freshReady();
  assert.equal(ready.startDialog('a', 'Exit plan mode?'), true);
  assert.equal(ready.startDialog('a', 'Exit plan mode?'), false, 'a remount or a redraw');
  assert.equal(ready.startDialog('b', 'Exit plan mode?'), true, 'per terminal');
  assert.equal(ready.startDialog('a', ''), true, 'another dialog');
  ready.endDialog('a');
  assert.equal(ready.startDialog('a', ''), true, 'the next notice');
  assert.ok(ready.DIALOG_SETTLE >= 1000, 'longer than a redraw takes');
});
