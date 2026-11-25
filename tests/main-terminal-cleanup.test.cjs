const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { createTerminalLifecycle } = require('../electron/app/terminal-lifecycle.cjs');
const { retryFileOperation } = require('../electron/file-retry.cjs');
const { WorkspaceStore } = require('../electron/state.cjs');

function fixture(t, extraDeps = {}) {
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
    report(error) { throw error; }, t: () => '', ...extraDeps });
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

test('B3 a stubborn Windows file does not block later deletions or the terminal exit state', t => {
  const reported = [], ended = [];
  const f = fixture(t, { report: error => reported.push(error.code),
    retryFileOperation: operation => retryFileOperation(operation, { platform: 'win32' }) });
  const files = f.files(f.sessionId), locked = f.s.bootstrapFile + '.launch-note', transient = path.join(f.runtimeDir, files[4]), rm = fs.rmSync;
  fs.writeFileSync(locked, 'locked sidecar');
  fs.writeFileSync(f.s.bootstrapFile + '.mode', 'later sidecar');
  let lockedAttempts = 0, transientAttempts = 0;
  t.mock.method(fs, 'rmSync', (file, ...args) => {
    const busy = file === locked ? ++lockedAttempts : file === transient && ++transientAttempts < 2;
    if (busy) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return rm(file, ...args);
  });
  f.s.calls = { endSession: () => ended.push(true) };
  f.exit();
  assert.equal(f.s.status, 'exited');
  assert.deepEqual(ended, [true]);
  assert.deepEqual(reported, ['EPERM']);
  assert.equal(lockedAttempts, 5);
  assert.equal(transientAttempts, 2);
  assert.equal(fs.existsSync(locked), true);
  for (const name of [...files, files[0] + '.mode']) assert.equal(fs.existsSync(path.join(f.runtimeDir, name)), false);
});

test('C2 and E2 failed terminal spawn removes startup files and clears a deleted saved cwd', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-startup-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = fs.mkdtempSync(path.join(root, 'runtime-'));
  const workspace = path.join(root, 'workspace.json'), store = new WorkspaceStore(workspace), project = store.add(root).project;
  const deleted = path.join(root, 'deleted');
  store.setRestore(project.id, { cwd: deleted, codex: true });
  const restorePlans = new Map([[project.id, { cwd: deleted, codex: true }]]);
  const spawnError = new Error('PTY spawn failed'), sessions = new Map(), starts = [];
  const lifecycle = createTerminalLifecycle({ sessions, findProject: () => project, fs, path, process: { platform: 'win32', env: {} },
    store, restorePlans, randomUUID, runtimeDir, integrationDir: root, createTerminalEnvironment: () => ({}), withoutAppImage: env => env,
    terminalHooks: () => null, accountEnvironment: () => ({}), claudeLocator: { peek: () => null }, codexLocator: { peek: () => null },
    writeBootstrap: ({ file }) => fs.writeFileSync(file, 'boot'), skills: { delivery: () => ({}) },
    startupNoteFields: () => ({ full: 'note', launch: 'short' }), handoffFile: () => path.join(root, 'handoff'),
    writeFileAtomic: (file, text) => fs.writeFileSync(file, text), writeHandoff: async () => {}, memoryDir: () => root,
    pty: { spawn(_file, _args, options) { starts.push(options.cwd, fs.readdirSync(runtimeDir).length); throw spawnError; } },
    retryFileOperation, report: assert.fail });
  assert.throws(() => lifecycle.startTerminal(project.id), error => error === spawnError);
  assert.deepEqual(starts, [project.path, 3]);
  assert.deepEqual(fs.readdirSync(runtimeDir), []);
  assert.equal(sessions.size, 0);
  assert.equal(new WorkspaceStore(workspace).findTerminal(project.id).record.restore.cwd, null);
  assert.deepEqual(restorePlans.get(project.id), { codex: true });
});
