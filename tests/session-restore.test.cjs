// Codex restore entry, marker and stop cases live in restore-owner-stop.test.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { claudeResumeCommand } = require('../electron/session-restore.cjs');
const { createTerminalLifecycle } = require('../electron/app/terminal-lifecycle.cjs');
test('Claude Code resumes its recorded conversation and continues only an unfinished turn', () => {
  const id = randomUUID();
  assert.equal(claudeResumeCommand({ agent: 'claude', threadId: id, interrupted: true }), `claude --resume ${id} "继续"\r`);
  assert.equal(claudeResumeCommand({ agent: 'claude', threadId: id }), `claude --resume ${id}\r`);
  assert.equal(claudeResumeCommand({ agent: 'claude' }), 'claude --continue\r', 'no recorded session continues the newest one in the folder');
  assert.throws(() => claudeResumeCommand({ agent: 'claude', threadId: 'x; rm -rf' }), /无效/);
});

test('a fast automatic continuation completing before restoreTerminal resolves is never rearmed', async () => {
  const saved = { agent: 'codex', threadId: 'thread', codex: true, interrupted: true };
  let armed = false, armings = 0;
  const context = { restorePlans: new Map(), startupErrors: new Map(), broadcast() {},
    ...require('../electron/features/cli-adapters/registry.cjs'),
    store: { findTerminal: () => ({ project: { kind: 'local', path: __dirname }, record: { restore: saved } }), setRestore(_id, patch) { Object.assign(saved, patch); },
      expectCompletion() { armed = true; armings++; } },
    nativeSessions: { start: async () => ({ runtimeSessionId: 'runtime' }), async continueInterrupted(_id, _runtime, beforeSend) {
      beforeSend(); assert.equal(saved.interrupted, false);
      context.store.expectCompletion(); armed = false;
    } } };
  await createTerminalLifecycle(context).restoreTerminal('t'); assert.equal(armed, false); assert.equal(armings, 1);
});
