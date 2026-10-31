const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

function fixture(t) {
  const runtimeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-terminal-cleanup-')));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const sessionId = randomUUID(), id = 'terminal', otherId = randomUUID();
  const files = session => [`${session}.json`, `${session}-skills.txt`, `${session}-claude-settings-${'a'.repeat(32)}.json`, `${session}-claude-settings-Abc123`];
  for (const name of [...files(sessionId), ...files(otherId), 'unrelated.json']) fs.writeFileSync(path.join(runtimeDir, name), 'fixture');
  const s = { projectId: 'project', terminalId: id, sessionId, bootstrapFile: path.join(runtimeDir, `${sessionId}.json`), skillNoteFile: path.join(runtimeDir, `${sessionId}-skills.txt`),
    gate: { dispose() {} }, promptQueue: { reset() {} }, completionWork: { reset: () => false }, approval: { context() {} } };
  const sessions = new Map([[id, s]]), calls = [];
  s.terminal = { kill() { calls.push('kill'); assert.ok(fs.existsSync(s.bootstrapFile)); } };
  const context = vm.createContext({ fs, path, sessions, readingHistory: { close() {} }, endSkillSession() {}, stopUsageAccount() {},
    skills: { endSession(project, session) { calls.push([project, session]); } }, clearTimeout, broadcast() {}, store: { setRestore() {} },
    restorePlans: new Map(), quitting: false, project: { id: s.projectId }, id, s, sessionId, bootstrapFile: s.bootstrapFile, skillNoteFile: s.skillNoteFile,
    flush() {}, terminal: { onExit(fn) { context.onExit = fn; } }, t: () => '' });
  vm.runInContext(main.slice(main.indexOf('function cleanupTerminalFiles('), main.indexOf('function registerIpc(')), context);
  return { runtimeDir, files, sessionId, otherId, id, s, sessions, calls, context };
}

test('disposing a terminal removes its abandoned Claude settings after killing the shell and preserves other sessions', t => {
  const f = fixture(t);
  f.context.disposeTerminal(f.id);
  assert.equal(f.sessions.has(f.id), false);
  assert.ok(f.calls.includes('kill'));
  for (const name of f.files(f.sessionId)) assert.equal(fs.existsSync(path.join(f.runtimeDir, name)), false, name);
  for (const name of [...f.files(f.otherId), 'unrelated.json']) assert.equal(fs.existsSync(path.join(f.runtimeDir, name)), true, name);
  f.context.disposeTerminal(f.id);
});

test('normal terminal exit also removes abandoned settings so the runtime folder can be removed', t => {
  const f = fixture(t);
  for (const name of [...f.files(f.otherId), 'unrelated.json']) fs.unlinkSync(path.join(f.runtimeDir, name));
  const start = main.indexOf('  terminal.onExit(({ exitCode }) => {');
  vm.runInContext(main.slice(start, main.indexOf('\n  captureBranch(project);', start)), f.context);
  f.context.onExit({ exitCode: 0 });
  assert.deepEqual(fs.readdirSync(f.runtimeDir), []);
  fs.rmdirSync(f.runtimeDir);
  assert.equal(fs.existsSync(f.runtimeDir), false);
});
