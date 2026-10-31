const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SkillsStore } = require('../electron/features/skills/store.cjs');
const { startupNote } = require('../electron/features/agents/handoff.cjs');
const { readDelivery, sessionContext } = require('../electron/features/skills/session.cjs');

async function fixture(t, routingNote = () => '') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-skill-session-')));
  const project = { id: 'project', path: path.join(root, 'project'), name: 'Isolated' };
  fs.mkdirSync(project.path);
  const store = new SkillsStore({ dataDir: path.join(root, 'profile'), builtinDir: path.join(root, 'builtins'), getProjects: () => [project], routingNote });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const draft = { name: 'sample', scope: 'global', projectId: null, description: 'Use when testing 中文说明.', text: 'First body.' };
  await store.save(null, draft);
  const delivery = id => store.delivery(project, false, id, { agent: 'claude', started: true });
  const note = id => startupNote('Reading rules.', null, null, delivery(id));
  return { root, store, project, draft, delivery, note };
}

test('startup/resume deduplicate CLI session plus content fingerprint, compact/clear always deliver', async t => {
  const f = await fixture(t), first = f.note('terminal-first');
  const context = source => sessionContext({ session_id: 'cli-session', source }, first);
  assert.match(context('startup').hookSpecificOutput.additionalContext, /sample/);
  assert.equal(context('resume'), null);
  assert.equal(context('startup'), null);
  assert.ok(context('compact')); assert.ok(context('clear')); assert.equal(context('resume'), null);
  const second = f.note('terminal-second');
  assert.equal(f.delivery('terminal-first').fingerprint, f.delivery('terminal-second').fingerprint, 'terminal-specific paths do not change content identity');
  assert.equal(sessionContext({ session_id: 'cli-session', source: 'resume' }, second), null);
  assert.ok(sessionContext({ session_id: 'different-cli', source: 'startup' }, second));
  await f.store.save('user:sample', { ...f.draft, text: 'Changed body, same description.' });
  const changed = f.note('terminal-third');
  assert.notEqual(readDelivery(changed).fingerprint, readDelivery(first).fingerprint);
  assert.ok(sessionContext({ session_id: 'cli-session', source: 'resume' }, changed));
  assert.ok(sessionContext({ session_id: 'cli-session', source: 'compact' }, changed));
  await f.store.save('user:sample', f.draft);
  assert.ok(sessionContext({ session_id: 'cli-session', source: 'resume' }, f.note('reverted')), 'compaction invalidates receipts for previous manifests too');
  assert.equal(sessionContext({ session_id: '../../escape', source: 'startup' }, changed), null);
  assert.equal(sessionContext({ session_id: 'cli-session', source: 'unexpected' }, changed), null);
});

test('routing note is optional, current on a new delivery and included in bounded SSH manifests', async t => {
  let routing = '';
  const f = await fixture(t, () => routing), before = f.delivery('lead');
  assert.doesNotMatch(fs.readFileSync(before.manifest, 'utf8'), /weight recommendation/);
  routing = 'Adopted routing weight recommendation: sample x code = 0.8.';
  const after = f.delivery('lead');
  assert.match(fs.readFileSync(after.manifest, 'utf8'), /weight recommendation/);
  assert.notEqual(after.fingerprint, before.fingerprint);
  const remote = f.store.delivery({ id: 'ssh', path: '/remote/project', kind: 'ssh' }, true, 'lead-ssh');
  assert.match(remote.bundle.instructions, /weight recommendation/);
  assert.doesNotMatch(remote.bundle.instructions, new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(Object.keys(remote.bundle).sort(), ['files', 'instructions', 'key']);
});

test('Codex resume keeps the current project manifest across terminal exits and app restarts', async t => {
  const f = await fixture(t), launch = id => f.store.delivery(f.project, false, id, { agent: 'codex', started: true });
  const first = launch('terminal-one'), originalNote = startupNote('Read.', null, null, first);
  assert.ok(originalNote.includes(first.manifest.replace(/\\/g, '/')));
  assert.match(originalNote, /do not reload instructions already present/);
  const originalSnapshot = fs.readFileSync(first.sessionManifest, 'utf8');
  f.store.endSession(f.project.id, 'terminal-one'); f.store.close();
  const reopened = new SkillsStore({ dataDir: f.store.dataDir, builtinDir: f.store.builtinDir, getProjects: () => [f.project] });
  t.after(() => reopened.close());
  assert.equal(fs.existsSync(first.manifest), true);
  assert.equal(readDelivery(originalNote).instructions, originalSnapshot);
  await reopened.save('user:sample', { ...f.draft, description: 'Updated current instructions.' });
  const second = reopened.delivery(f.project, false, 'terminal-two', { agent: 'codex', started: true });
  assert.equal(second.manifest, first.manifest);
  assert.match(fs.readFileSync(first.manifest, 'utf8'), /Updated current instructions/);
  assert.equal(fs.readFileSync(first.sessionManifest, 'utf8'), originalSnapshot, 'launch snapshots keep their original fingerprinted instructions');
  const current = fs.readFileSync(first.manifest, 'utf8');
  reopened.delivery(f.project, false, 'idle-shell');
  reopened.delivery(f.project, false, 'unobserved-codex', { agent: 'codex' });
  const claude = reopened.delivery(f.project, false, 'claude-launch', { agent: 'claude', started: true });
  assert.notEqual(claude.manifest, first.manifest);
  assert.equal(fs.readFileSync(first.manifest, 'utf8'), current, 'previews and other agents do not replace the current Codex delivery');
  reopened.endSession(f.project.id, 'terminal-two');
  assert.equal(fs.readFileSync(first.manifest, 'utf8'), current);
});

test('first-open launch snapshots stay correct when later sessions rewrite the current manifest', async t => {
  const f = await fixture(t);
  f.store.setOptions('user:sample', { trigger: 'first-open' });
  const first = f.delivery('first-launch'), firstNote = startupNote('Read.', null, null, first);
  const second = f.delivery('second-launch'), secondNote = startupNote('Read.', null, null, second);
  assert.equal(first.manifest, second.manifest);
  assert.equal(f.store.options['user:sample'].firstOpenedProjects[f.project.id], 'first-launch');
  assert.equal(first.skills[0].trigger, 'first-open'); assert.equal(second.skills[0].trigger, 'auto');
  assert.doesNotMatch(fs.readFileSync(first.manifest, 'utf8'), /this is its first run/);
  const firstContext = sessionContext({ session_id: 'first-cli', source: 'startup' }, firstNote);
  assert.match(firstContext.hookSpecificOutput.additionalContext, /this is its first run/);
  const secondContext = sessionContext({ session_id: 'second-cli', source: 'startup' }, secondNote);
  assert.doesNotMatch(secondContext.hookSpecificOutput.additionalContext, /this is its first run/);
  assert.equal(sessionContext({ session_id: 'first-cli', source: 'resume' }, firstNote), null);
  assert.equal(sessionContext({ session_id: 'second-cli', source: 'resume' }, secondNote), null);
});

function hookProcess(file, args, input, noteFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: { ...process.env, AGENTRIX_READING_NOTE_FILE: noteFile }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('Node SessionStart writes one JSON context even without Agentrix; other hooks remain silent', async t => {
  const f = await fixture(t), noteFile = path.join(f.root, 'note.txt');
  fs.writeFileSync(noteFile, f.note('hook'));
  const args = [path.join(__dirname, '../integration/agent-event.cjs'), 'claude-hook', process.platform === 'win32' ? '\\\\.\\pipe\\absent-agentrix-skill-test' : path.join(f.root, 'absent.sock'), 'project', 'key'];
  const first = await hookProcess(process.execPath, [...args, 'session'], { session_id: 'hook-cli', source: 'startup' }, noteFile);
  assert.equal(first.code, 0); assert.equal(first.stderr, '');
  const output = JSON.parse(first.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /Reading rules.*sample/);
  const second = await hookProcess(process.execPath, [...args, 'session'], { session_id: 'hook-cli', source: 'resume' }, noteFile);
  assert.equal(second.stdout, '');
  const notify = await hookProcess(process.execPath, [...args, 'notify'], { session_id: 'hook-cli', notification_type: 'permission_prompt' }, noteFile);
  assert.equal(notify.stdout, '');
  const simultaneous = await Promise.all([1, 2].map(() => hookProcess(process.execPath, [...args, 'session'], { session_id: 'concurrent-cli', source: 'startup' }, noteFile)));
  assert.equal(simultaneous.filter(result => result.stdout).length, 1, 'concurrent hook processes share the exclusive receipt');
});

test('Unix wrappers pass the private note to child helpers and Claude receives only the SessionStart pointer', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), bin = path.join(f.root, 'bin'), home = path.join(f.root, 'home'), noteFile = path.join(f.root, 'note.txt');
  fs.mkdirSync(bin); fs.mkdirSync(home); fs.writeFileSync(noteFile, f.note('unix'));
  const script = path.join(f.root, 'fake.cjs');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(require('node:path').join(process.env.CAPTURE_ROOT, process.argv[2]+'.json'),JSON.stringify({note:process.env.AGENTRIX_READING_NOTE_FILE,args:process.argv.slice(3)}));`);
  const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
  for (const agent of ['claude', 'codex']) fs.writeFileSync(path.join(bin, agent), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${agent} "$@"\n`, { mode: 0o700 });
  const shell = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  const source = path.join(__dirname, process.platform === 'darwin' ? '../integration/zsh-integration.zsh' : '../integration/bash-integration.bash');
  const env = { HOME: home, ZDOTDIR: home, AGENTRIX_USER_ZDOTDIR: home, PATH: `${bin}:/usr/bin:/bin`, CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    CAPTURE_ROOT: f.root, AGENTRIX_NODE: process.execPath, AGENTRIX_EVENT_HELPER: path.join(__dirname, '../integration/agent-event.cjs'), AGENTRIX_READING_NOTE_FILE: noteFile };
  await new Promise((resolve, reject) => {
    const child = spawn(shell, ['-c', 'source "$1" zshrc; claude hello; codex hello', '_', source], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; child.stderr.on('data', bytes => { errors += bytes; }); child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(errors)));
  });
  const claude = JSON.parse(fs.readFileSync(path.join(f.root, 'claude.json'))), codex = JSON.parse(fs.readFileSync(path.join(f.root, 'codex.json')));
  assert.equal(claude.note, noteFile); assert.equal(codex.note, noteFile);
  assert.match(claude.args[claude.args.indexOf('--append-system-prompt') + 1], /SessionStart/);
  assert.ok(!JSON.stringify(claude.args).includes('中文说明'));
  assert.ok(JSON.stringify(codex.args).includes('中文说明'));
  const settings = JSON.parse(claude.args[claude.args.indexOf('--settings') + 1]);
  assert.ok(settings.hooks.SessionStart[0].hooks[0].command.includes(noteFile));
});

test('PowerShell and Node share receipts and force a delivery after compact/clear', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), noteFile = path.join(f.root, 'note.txt'), note = f.note('powershell');
  fs.writeFileSync(noteFile, note);
  sessionContext({ session_id: 'same-cli', source: 'startup' }, note);
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../integration/claude-hook.ps1'),
    '-PipeName', 'absent-agentrix-skill-test', '-ProjectId', 'project', '-SessionKey', 'key', '-Kind', 'session'];
  const resumed = await hookProcess(powershell, args, { session_id: 'same-cli', source: 'resume' }, noteFile);
  assert.deepEqual(resumed, { code: 0, stdout: '', stderr: '' });
  for (const source of ['compact', 'clear']) {
    const result = await hookProcess(powershell, args, { session_id: 'same-cli', source }, noteFile);
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /中文说明/);
    assert.equal(sessionContext({ session_id: 'same-cli', source: 'resume' }, note), null);
  }
});
