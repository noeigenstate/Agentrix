const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { createTerminalLifecycle } = require('../electron/app/terminal-lifecycle.cjs');

function fixture(t) {
  const runtimeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-terminal-cleanup-')));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const sessionId = randomUUID(), id = 'terminal', otherId = randomUUID();
  const files = session => [`${session}.json`, `${session}-claude-env.sh`, `${session}-skills.txt`, `${session}-claude-settings-${'a'.repeat(32)}.json`, `${session}-claude-settings-Abc123`];
  for (const name of [...files(sessionId), ...files(otherId), 'unrelated.json']) fs.writeFileSync(path.join(runtimeDir, name), 'fixture');
  const s = { projectId: 'project', terminalId: id, sessionId, bootstrapFile: path.join(runtimeDir, `${sessionId}.json`), skillNoteFile: path.join(runtimeDir, `${sessionId}-skills.txt`),
    gate: { dispose() {} }, promptQueue: { reset() {} }, completionWork: { reset: () => false }, approval: { context() {} } };
  const sessions = new Map([[id, s]]), calls = [];
  let onExit;
  s.terminal = { kill() { calls.push('kill'); assert.ok(fs.existsSync(s.bootstrapFile)); }, onData() {}, onExit(fn) { onExit = fn; } };
  const lifecycle = createTerminalLifecycle({ fs, path, sessions, nativeSessions: null, nativeSpecs: new Map(), readingHistory: { close() {} }, AgentCalls, disposeDispatchInbox: terminal => calls.push(['inbox', terminal]), endSkillSession() {}, stopUsageAccount() {}, syncDashboardLive() {},
    skills: { endSession(project, session) { calls.push([project, session]); } }, clearTimeout, broadcast() {}, store: { setRestore() {} },
    restorePlans: new Map(), startupErrors: new Map(), quitting: false, bindDispatchInbox() {}, captureBranch() {},
    report(error) { throw error; }, removeBootstrap: require('../electron/features/terminal-events/bootstrap-file.cjs').removeBootstrap, t: () => '' });
  return { runtimeDir, files, sessionId, otherId, id, s, sessions, calls, lifecycle, exit() { lifecycle.bindTerminalEvents(s, { id: s.projectId }, {}); onExit({ exitCode: 0 }); } };
}

test('disposing a terminal removes its abandoned Claude settings after killing the shell and preserves other sessions', t => {
  const f = fixture(t);
  f.lifecycle.disposeTerminal(f.id);
  assert.equal(f.sessions.has(f.id), false);
  assert.ok(f.calls.includes('kill'));
  assert.ok(f.calls.some(call => call[0] === 'inbox' && call[1] === f.id), 'the closed terminal\'s dispatch inbox goes with it');
  for (const name of f.files(f.sessionId)) assert.equal(fs.existsSync(path.join(f.runtimeDir, name)), false, name);
  for (const name of [...f.files(f.otherId), 'unrelated.json']) assert.equal(fs.existsSync(path.join(f.runtimeDir, name)), true, name);
  f.lifecycle.disposeTerminal(f.id);
});

test('normal terminal exit also removes abandoned settings so the runtime folder can be removed', t => {
  const f = fixture(t);
  for (const name of [...f.files(f.otherId), 'unrelated.json']) fs.unlinkSync(path.join(f.runtimeDir, name));
  f.exit();
  assert.deepEqual(fs.readdirSync(f.runtimeDir), []);
  fs.rmdirSync(f.runtimeDir);
  assert.equal(fs.existsSync(f.runtimeDir), false);
});

test('a runtime folder removed from outside does not make terminal cleanup throw in main', t => {
  const f = fixture(t);
  fs.rmSync(f.runtimeDir, { recursive: true, force: true });
  assert.doesNotThrow(() => f.lifecycle.disposeTerminal(f.id));
  assert.equal(f.sessions.has(f.id), false);
});
