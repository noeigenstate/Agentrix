// Codex restore entry, marker and stop cases live in restore-owner-stop.test.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { claudeResumeCommand } = require('../electron/session-restore.cjs');
test('Claude Code resumes its recorded conversation and continues only an unfinished turn', () => {
  const id = randomUUID();
  assert.equal(claudeResumeCommand({ agent: 'claude', threadId: id, interrupted: true }), `claude --resume ${id} "继续"\r`);
  assert.equal(claudeResumeCommand({ agent: 'claude', threadId: id }), `claude --resume ${id}\r`);
  assert.equal(claudeResumeCommand({ agent: 'claude' }), 'claude --continue\r', 'no recorded session continues the newest one in the folder');
  assert.throws(() => claudeResumeCommand({ agent: 'claude', threadId: 'x; rm -rf' }), /无效/);
});

test('a fast automatic continuation completing before restoreTerminal resolves is never rearmed', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const saved = { agent: 'codex', threadId: 'thread', codex: true, interrupted: true };
  let armed = false, armings = 0;
  const context = vm.createContext({ restorePlans: new Map(), startupErrors: new Map(), broadcast() {},
    store: { findTerminal: () => ({ record: { restore: saved } }), setRestore(_id, patch) { Object.assign(saved, patch); },
      expectCompletion() { armed = true; armings++; } },
    nativeSessions: { start: async () => ({ runtimeSessionId: 'runtime' }), async continueInterrupted(_id, _runtime, beforeSend) {
      beforeSend(); assert.equal(saved.interrupted, false);
      context.store.expectCompletion(); armed = false;
    } } });
  vm.runInContext(main.slice(main.indexOf('function restoreTerminal('), main.indexOf('function startTerminal(')), context);
  await context.restoreTerminal('t'); assert.equal(armed, false); assert.equal(armings, 1);
});
