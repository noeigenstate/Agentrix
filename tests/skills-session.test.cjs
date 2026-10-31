const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SkillsStore } = require('../electron/features/skills/store.cjs');
const { startupNote } = require('../electron/features/agents/handoff.cjs');
const { READING_NOTE } = require('../electron/features/agents/reading-note.cjs');
const { digest, deliveryMarker, readDelivery, sessionContext } = require('../electron/features/skills/session.cjs');
const receiptFixture = require('./fixtures/skill-receipts/lifecycle.json');

async function fixture(t, routingNote = () => '') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-skill-session-')));
  const project = { id: 'project', path: path.join(root, 'project'), name: 'Isolated' };
  fs.mkdirSync(project.path);
  const store = new SkillsStore({ dataDir: path.join(root, 'profile'), builtinDir: path.join(root, 'builtins'), getProjects: () => [project], routingNote });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const draft = { name: 'sample', scope: 'global', projectId: null, description: 'Use when testing 中文说明.', text: 'First body.' };
  await store.save(null, draft);
  const delivery = id => store.delivery(project, false, id, { agent: 'claude', started: true });
  const note = id => startupNote(READING_NOTE, path.join(root, 'handoff.md'), path.join(project.path, 'skills'), delivery(id), path.join(root, 'dispatch.cjs'));
  return { root, store, project, draft, delivery, note };
}

test('startup/resume deduplicate CLI session plus content fingerprint, compact/clear always deliver', async t => {
  const f = await fixture(t), first = f.note('terminal-first');
  const context = source => sessionContext({ session_id: 'cli-session', source }, first);
  assert.equal(context('startup').hookSpecificOutput.additionalContext, `Agentrix skill instructions:\n${readDelivery(first).instructions}`);
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
  const [startup, instructions] = startupNote(READING_NOTE, null, null, remote).split(' Agentrix skill delivery: ');
  assert.match(startup, /^You run inside Agentrix/);
  assert.ok(startup.includes(`Current project skills manifest: ${remote.manifest}.`));
  assert.equal(instructions, `remote. ${remote.bundle.instructions}`);
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
  assert.equal(fs.existsSync(first.sessionManifest), false, 'startup prunes snapshots with no live session reference');
  await reopened.save('user:sample', { ...f.draft, description: 'Updated current instructions.' });
  const second = reopened.delivery(f.project, false, 'terminal-two', { agent: 'codex', started: true });
  assert.equal(second.manifest, first.manifest);
  assert.match(fs.readFileSync(first.manifest, 'utf8'), /Updated current instructions/);
  assert.equal(fs.readFileSync(second.sessionManifest, 'utf8').includes('Updated current instructions.'), true);
  const current = fs.readFileSync(first.manifest, 'utf8');
  reopened.delivery(f.project, false, 'idle-shell');
  reopened.delivery(f.project, false, 'unobserved-codex', { agent: 'codex' });
  const claude = reopened.delivery(f.project, false, 'claude-launch', { agent: 'claude', started: true });
  assert.notEqual(claude.manifest, first.manifest);
  assert.equal(fs.readFileSync(first.manifest, 'utf8'), current, 'previews and other agents do not replace the current Codex delivery');
  reopened.endSession(f.project.id, 'terminal-two');
  assert.equal(fs.readFileSync(first.manifest, 'utf8'), current);
  assert.match(originalSnapshot, /First body|sample/);
});

test('startup prunes unused and 30-day-old snapshots and receipts while keeping current manifests and live snapshots', async t => {
  const f = await fixture(t), live = f.delivery('live'), ended = f.delivery('ended');
  f.store.endSession(f.project.id, 'ended');
  const folder = path.dirname(live.manifest), now = Date.now(), old = new Date(now - 31 * 24 * 60 * 60 * 1000);
  const expired = f.delivery('expired');
  for (const file of [expired.sessionManifest, `${expired.sessionManifest}.json`]) fs.utimesSync(file, old, old);
  sessionContext({ session_id: 'old-cli', source: 'startup' }, f.note('receipt'));
  sessionContext({ session_id: 'recent-cli', source: 'startup' }, f.note('receipt'));
  const oldReceiptFolder = path.join(folder, 'receipts/claude', digest('old-cli').slice(0, 32));
  const oldReceipt = path.join(oldReceiptFolder, fs.readdirSync(oldReceiptFolder)[0]); fs.utimesSync(oldReceipt, old, old);
  f.store.pruneDeliveryFiles(now);
  for (const snapshot of [ended, expired]) {
    assert.equal(fs.existsSync(snapshot.sessionManifest), false);
    assert.equal(fs.existsSync(`${snapshot.sessionManifest}.json`), false);
  }
  assert.equal(fs.existsSync(live.sessionManifest), true);
  assert.equal(fs.existsSync(`${live.sessionManifest}.json`), true);
  assert.equal(fs.existsSync(oldReceiptFolder), false);
  const recentFolder = path.join(folder, 'receipts/claude', digest('recent-cli').slice(0, 32));
  assert.equal(fs.readdirSync(recentFolder).length, 1);
  f.store.close();
  const restarted = new SkillsStore({ dataDir: f.store.dataDir, builtinDir: f.store.builtinDir, getProjects: () => [f.project] });
  t.after(() => restarted.close());
  assert.equal(fs.existsSync(live.sessionManifest), true, 'recreating a watcher in the same process preserves still-live CLI references');
  for (const session of ['live', 'expired', 'receipt']) restarted.endSession(f.project.id, session);
  restarted.pruneDeliveryFiles();
  assert.equal(fs.existsSync(live.sessionManifest), false);
  assert.equal(fs.existsSync(live.manifest), true, 'stable current manifests survive restarts');
  assert.equal(fs.readdirSync(recentFolder).length, 1);
});

function receiptPaths(folder) {
  const result = [];
  if (fs.existsSync(folder)) for (const session of fs.readdirSync(folder)) {
    for (const key of fs.readdirSync(path.join(folder, session))) result.push(`${session}/${key}`);
  }
  return result.sort();
}

function expectedReceipts(step) {
  return step.receipts.map(value => {
    const [session, key] = value.split('/');
    return `${digest(session).slice(0, 32)}/${receiptFixture.manifests[key].slice(0, 32)}`;
  }).sort();
}

test('shared receipt lifecycle fixture matches Node SessionStart delivery and every remaining receipt', async t => {
  const f = await fixture(t), folder = path.join(f.root, 'shared-receipts'); fs.mkdirSync(folder);
  const notes = {};
  for (const [name, fingerprint] of Object.entries(receiptFixture.manifests)) {
    const manifest = path.join(folder, `${name}.md`); fs.writeFileSync(manifest, 'Shared instructions.');
    notes[name] = `Note. ${deliveryMarker({ manifest, fingerprint })}`;
  }
  for (const step of receiptFixture.steps) {
    const result = sessionContext({ session_id: step.session, source: step.source }, notes[step.key]);
    assert.equal(Boolean(result), step.deliver, JSON.stringify(step));
    if (result) assert.equal(result.hookSpecificOutput.additionalContext, 'Agentrix skill instructions:\nShared instructions.');
    assert.deepEqual(receiptPaths(path.join(folder, 'receipts/claude')), expectedReceipts(step));
  }
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
    const child = spawn(file, args, { env: { ...process.env, AGENTRIX_BOOTSTRAP: '', AGENTRIX_READING_NOTE_FILE: noteFile }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
  assert.equal(output.hookSpecificOutput.additionalContext, `Agentrix skill instructions:\n${readDelivery(fs.readFileSync(noteFile, 'utf8')).instructions}`);
  const second = await hookProcess(process.execPath, [...args, 'session'], { session_id: 'hook-cli', source: 'resume' }, noteFile);
  assert.equal(second.stdout, '');
  const notify = await hookProcess(process.execPath, [...args, 'notify'], { session_id: 'hook-cli', notification_type: 'permission_prompt' }, noteFile);
  assert.equal(notify.stdout, '');
  const simultaneous = await Promise.all([1, 2].map(() => hookProcess(process.execPath, [...args, 'session'], { session_id: 'concurrent-cli', source: 'startup' }, noteFile)));
  assert.equal(simultaneous.filter(result => result.stdout).length, 1, 'concurrent hook processes share the exclusive receipt');
});

test('Unix wrappers keep the startup note and manifest fallback on the command line, with skills only in SessionStart', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), bin = path.join(f.root, 'bin'), home = path.join(f.root, 'home'), noteFile = path.join(f.root, 'note.txt');
  fs.mkdirSync(bin); fs.mkdirSync(home); fs.writeFileSync(noteFile, f.note('unix'));
  const script = path.join(f.root, 'fake.cjs');
  fs.writeFileSync(script, `const fs=require('node:fs'),args=process.argv.slice(3);fs.writeFileSync(require('node:path').join(process.env.CAPTURE_ROOT, process.argv[2]+'.json'),JSON.stringify({note:process.env.AGENTRIX_READING_NOTE_FILE,args,settings:process.argv[2]==='claude'?JSON.parse(fs.readFileSync(args[1],'utf8')):null}));`);
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
  assert.equal(claude.args[2], '--append-system-prompt');
  assert.equal(claude.args[3], fs.readFileSync(noteFile, 'utf8').split(' Agentrix skill delivery: ')[0] + ' Agentrix delivers skill instructions through its SessionStart hook.');
  assert.match(claude.args[3], /^You run inside Agentrix/);
  assert.deepEqual(claude.args.slice(4), ['hello']);
  assert.ok(!JSON.stringify(claude.args).includes('中文说明'));
  assert.ok(JSON.stringify(codex.args).includes('中文说明'));
  assert.ok(claude.settings.hooks.SessionStart[0].hooks[0].command.includes(noteFile));
  assert.equal(path.dirname(claude.args[1]), f.root);
  assert.equal(fs.existsSync(claude.args[1]), false, 'settings file is removed after exit');
});

test('PowerShell Claude wrapper keeps the startup note and fallback before intact resume arguments', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), noteFile = path.join(f.root, 'note.txt'), note = f.note('wrapper');
  fs.writeFileSync(noteFile, note);
  const source = fs.readFileSync(path.join(__dirname, '../integration/bootstrap.ps1'), 'utf8');
  const helper = source.slice(source.indexOf('function global:Get-AgentrixReadingNote'), source.indexOf('# Windows PowerShell 5'));
  const wrapper = source.slice(source.indexOf('function global:claude'), source.indexOf('if ($global:AgentrixAgentOnly)'));
  const script = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
${helper}
${wrapper}
function global:Send-AgentrixEvent {}
function global:Get-AgentrixCommand {}
$global:AgentrixSession = @{ powershellPath = 'powershell.exe'; claudeHookPath = 'fixture.ps1'; pipeName = 'absent'; projectId = 'project'; sessionKey = 'key' }
$global:AgentrixClaudeExecutable = $null
$global:AgentrixClaudeCommand = { @{ args = @($args); settings = (Get-Content -LiteralPath $args[1] -Raw | ConvertFrom-Json) } | ConvertTo-Json -Depth 10 -Compress }
claude --resume fixture '继续'`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = await hookProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {}, noteFile);
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  const { args, settings } = JSON.parse(result.stdout);
  assert.equal(args[0], '--settings'); assert.ok(settings.hooks.SessionStart);
  assert.equal(path.dirname(args[1]), f.root);
  assert.equal(fs.existsSync(args[1]), false);
  assert.equal(args[2], '--append-system-prompt');
  assert.equal(args[3], note.split(' Agentrix skill delivery: ')[0] + ' Agentrix delivers skill instructions through its SessionStart hook.');
  assert.match(args[3], /^You run inside Agentrix/);
  assert.doesNotMatch(args[3], /中文说明|Agentrix skill delivery:/);
  assert.deepEqual(args.slice(4), ['--resume', 'fixture', '继续']);
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
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, `Agentrix skill instructions:\n${readDelivery(note).instructions}`);
    assert.equal(sessionContext({ session_id: 'same-cli', source: 'resume' }, note), null);
  }
});

test('PowerShell 5.1 fallback passes a settings file through a real fake claude.cmd with the startup note intact', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), bin = path.join(f.root, 'shim with spaces'), noteFile = path.join(f.root, 'note.txt'); fs.mkdirSync(bin);
  const note = f.note('cmd'); fs.writeFileSync(noteFile, note);
  const captureFile = path.join(f.root, 'argv.json'), fake = path.join(bin, 'capture.cjs'), command = path.join(bin, 'claude.cmd');
  fs.writeFileSync(fake, `const fs=require('node:fs'),args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(captureFile)},JSON.stringify({args,settings:JSON.parse(fs.readFileSync(args[1],'utf8'))}));`);
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  const source = fs.readFileSync(path.join(__dirname, '../integration/bootstrap.ps1'), 'utf8');
  const helper = source.slice(source.indexOf('function global:Get-AgentrixReadingNote'), source.indexOf('# Windows PowerShell 5'));
  const wrapper = source.slice(source.indexOf('function global:claude'), source.indexOf('if ($global:AgentrixAgentOnly)'));
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  const script = `$ProgressPreference = 'SilentlyContinue'\n${helper}\n${wrapper}\nfunction global:Send-AgentrixEvent {}\nfunction global:Get-AgentrixCommand {}
$global:AgentrixSession = @{ powershellPath = 'powershell.exe'; claudeHookPath = 'fixture.ps1'; pipeName = 'absent'; projectId = 'project'; sessionKey = 'key' }
$global:AgentrixClaudeExecutable = ${quote(command)}
$global:AgentrixClaudeCommand = ${quote(command)}
claude --resume fixture 'next task'`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = await hookProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {}, noteFile);
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  const { args, settings } = JSON.parse(fs.readFileSync(captureFile));
  assert.equal(args[0], '--settings'); assert.equal(path.dirname(args[1]), f.root);
  assert.ok(settings.hooks.SessionStart[0].hooks[0].command.includes('fixture.ps1'));
  assert.equal(args[2], '--append-system-prompt');
  assert.equal(args[3], note.split(' Agentrix skill delivery: ')[0] + ' Agentrix delivers skill instructions through its SessionStart hook.');
  assert.deepEqual(args.slice(4), ['--resume', 'fixture', 'next task']);
  assert.equal(fs.existsSync(args[1]), false);
});

test('shared receipt lifecycle fixture matches PowerShell SessionStart delivery and every remaining receipt', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), folder = path.join(f.root, 'powershell-receipts'); fs.mkdirSync(folder);
  const notes = {};
  for (const [key, fingerprint] of Object.entries(receiptFixture.manifests)) {
    const manifest = path.join(folder, `${key}.md`), noteFile = path.join(folder, `${key}.txt`);
    fs.writeFileSync(manifest, 'Shared instructions.'); fs.writeFileSync(noteFile, `Note. ${deliveryMarker({ manifest, fingerprint })}`);
    notes[key] = noteFile;
  }
  const source = fs.readFileSync(path.join(__dirname, '../integration/claude-hook.ps1'), 'utf8');
  const hook = source.slice(source.indexOf('function Get-AgentrixSessionContext'), source.indexOf('\ntry {'));
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  const script = `$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
${hook}
$fixture = ${quote(JSON.stringify(receiptFixture))} | ConvertFrom-Json
$notes = ${quote(JSON.stringify(notes))} | ConvertFrom-Json
$results = foreach ($step in $fixture.steps) {
  $NoteFile = $notes.($step.key)
  $context = Get-AgentrixSessionContext @{ session_id = $step.session; source = $step.source }
  $receipts = @(foreach ($session in Get-ChildItem -LiteralPath ${quote(path.join(folder, 'receipts/claude'))} -Directory -ErrorAction SilentlyContinue) {
    foreach ($file in Get-ChildItem -LiteralPath $session.FullName -File) { $session.Name + '/' + $file.Name }
  })
  @{ deliver = ($null -ne $context); receipts = @($receipts | Sort-Object) }
}
ConvertTo-Json -InputObject @($results) -Depth 6 -Compress`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = await hookProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {}, notes.alpha);
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  const results = JSON.parse(result.stdout);
  assert.equal(results.length, receiptFixture.steps.length);
  for (const [i, step] of receiptFixture.steps.entries()) assert.deepEqual(results[i], { deliver: step.deliver, receipts: expectedReceipts(step) }, JSON.stringify(step));
});
