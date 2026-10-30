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

test('a terminal is ready once its CLI input was seen, and stays ready while the screen shows something else', () => {
  const { cliReady } = freshReady();
  assert.equal(cliReady('a', 'session', 'thread', true, false), false);
  assert.equal(cliReady('a', 'session', 'thread', true, true), true);
  assert.equal(cliReady('a', 'session', 'thread', true, false), true, 'a dialog has no input box');
  assert.equal(cliReady('b', 'session', 'thread', true, false), false, 'readiness is per terminal');
});

test('readiness needs a live session and an active CLI to begin, and ends with the CLI or the session', () => {
  const { cliReady } = freshReady();
  assert.equal(cliReady('a', null, undefined, true, true), false);
  assert.equal(cliReady('a', 'session', undefined, false, true), false);
  assert.equal(cliReady('a', 'session', undefined, true, true), true);
  assert.equal(cliReady('a', 'session', undefined, false, false), false, 'the CLI stopped');
  assert.equal(cliReady('a', 'session', undefined, true, false), false, 'and must draw its input again');
  cliReady('a', 'session', undefined, true, true);
  assert.equal(cliReady('a', 'other', undefined, true, false), false, 'another session is not ready');
  assert.equal(cliReady('a', 'session', undefined, true, false), false, 'and the old one is not remembered');
});

test('a thread learned later keeps readiness, a different thread ends it, and the new thread starts ready only with its input', () => {
  const { cliReady } = freshReady();
  cliReady('a', 'session', undefined, true, true);
  assert.equal(cliReady('a', 'session', 'first', true, false), true, 'the first turn binds the thread');
  assert.equal(cliReady('a', 'session', undefined, true, false), true, 'a missing thread is unknown, not different');
  assert.equal(cliReady('a', 'session', 'second', true, false), false);
  assert.equal(cliReady('a', 'session', 'second', true, true), true);
  assert.equal(cliReady('a', 'session', 'first', true, false), false, 'the earlier thread is not remembered');
});

test('a dialog opens the terminal once, until nothing waits any more', () => {
  const { startDialog, endDialog } = freshReady();
  assert.equal(startDialog('a', 'Exit plan mode?'), true);
  assert.equal(startDialog('a', 'Exit plan mode?'), false, 'a remount or a redraw');
  assert.equal(startDialog('b', 'Exit plan mode?'), true, 'per terminal');
  assert.equal(startDialog('a', ''), true, 'another dialog');
  endDialog('a');
  assert.equal(startDialog('a', ''), true, 'the next notice');
});
