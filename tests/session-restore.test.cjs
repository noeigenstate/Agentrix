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

test('the product restore path sends continuation only after interrupted Codex resumes', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  for (const kind of ['local', 'ssh']) for (const interrupted of [true, false]) {
    const restore = { agent: 'codex', threadId: 'old-thread', interrupted }, calls = [], session = { terminalId: 't', ready: true, codexAvailable: true };
    const context = vm.createContext({ restorePlans: new Map([['t', { codex: true }]]), sessions: new Map([['t', session]]), randomUUID,
      store: { findTerminal: () => ({ record: { restore } }), expectCompletion: () => calls.push('armed') },
      nativeSessions: { start: async () => { calls.push('resumed'); return { runtimeSessionId: 'runtime' }; },
        send: async (_id, runtime, message) => { assert.equal(runtime, 'runtime'); assert.equal(message.text, '继续'); calls.push('sent'); context.store.expectCompletion(); return { status: 'delivered' }; } },
      readingHistory: { close() {} }, broadcast() {}, claudeResumeCommand });
    vm.runInContext(main.slice(main.indexOf('async function resumeAfterPrompt('), main.indexOf('function remoteFor(')), context);
    await context.resumeAfterPrompt({ id: 'p', kind }, session);
    assert.deepEqual(calls, interrupted ? ['resumed', 'sent', 'armed'] : ['resumed']);
  }
});

test('a fast automatic continuation completing before send resolves is never rearmed', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const session = { terminalId: 't', ready: true, codexAvailable: true }, restore = { agent: 'codex', threadId: 'old', interrupted: true };
  let armed = false, armings = 0;
  const context = vm.createContext({ restorePlans: new Map([['t', { codex: true }]]), sessions: new Map([['t', session]]), randomUUID,
    store: { findTerminal: () => ({ record: { restore } }), expectCompletion: () => { armed = true; armings++; } },
    nativeSessions: { start: async () => ({ runtimeSessionId: 'runtime' }), send: async () => {
      // The real provider may deliver started and completed notifications in one stdout chunk.
      armed = true; armings++; armed = false; return { status: 'delivered' };
    } }, readingHistory: { close() {} }, broadcast() {}, claudeResumeCommand });
  vm.runInContext(main.slice(main.indexOf('async function resumeAfterPrompt('), main.indexOf('function remoteFor(')), context);
  await context.resumeAfterPrompt({ id: 'p', kind: 'local' }, session);
  assert.equal(armed, false); assert.equal(armings, 1);
});
