const { bootstrapScript, runPowerShellHook } = require('./helpers/powershell-hook.cjs');
const { dispatchEnvironment } = require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createEventServer } = require('../electron/events.cjs');
const { RoutingStore, remoteGuide, MAX_SSH_GUIDE_BYTES } = require('../electron/features/routing/store.cjs');
const { createSessionPresentation } = require('../electron/app/session-presentation.cjs');
const { createNativeHost } = require('../electron/features/native-session/host.cjs');
const { adapterOf } = require('../electron/features/cli-adapters/registry.cjs');
const { startupNote } = require('../electron/features/agents/handoff.cjs');
const { READING_NOTE } = require('../electron/features/agents/reading-note.cjs');
const { updateBootstrapMode, updateBootstrapLead, updateDispatchSeats } = require('../electron/features/terminal-events/bootstrap-file.cjs');
const { terminalHooks } = require('../electron/features/terminal-events/hook-channel.cjs');

// A terminal's hooks as main writes them (hook-channel.cjs), for a wrapper run outside Agentrix.
const hooksFor = shell => terminalHooks({ port: 4242, terminalId: 'project', sessionKey: 'key', eventServer: { name: 'absent', address: '/absent.sock' }, env: {},
  cwd: os.tmpdir(), shell, platform: process.platform, home: os.tmpdir(), read: () => '{}' });
// The PowerShell session object a wrapper reads, with its command hooks only: these wrapper tests are about the note and arguments.
const powershellSession = bootstrap => fs.writeFileSync(bootstrap, JSON.stringify({
  nodePath: process.execPath,
  hooks: { channel: 'command', settings: { fallback: hooksFor({ posix: false, powershellPath: 'powershell.exe', script: 'fixture.ps1' }).settings.fallback } },
}));


function fixture(t, routingNote = () => '') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-routing-launch-')));
  const project = { id: 'project', path: path.join(root, 'project'), name: 'Isolated' };
  const remote = { id: 'ssh', kind: 'ssh', path: '/srv/work' };
  fs.mkdirSync(project.path);
  const options = { dataDir: root, guideFile: path.join(__dirname, '../resources/routing/model-routing.md'),
    getProjects: () => [project, remote], getAgents: () => ({ claude: { installed: true }, codex: { installed: true } }), routingNote, report: assert.fail };
  const store = new RoutingStore(options);
  t.after(() => {
    store.endSession(project.id, 'claude');
    store.endSession(project.id, 'codex');
    store.endSession(project.id, 'new');
    store.endSession(project.id, 'wrapper');
    store.endSession(project.id, 'unix');
    store.endSession(project.id, 'cmd');
    store.endSession(remote.id, 'remote');
    store.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const save = (roles = {}, conductor = true) => store.setRouting('template', null, { conductor, roles }, null);
  const saveProject = (roles = {}, conductor = true) =>
    store.setRouting('project', project.id, { roles, conductor }, store.seatsInfo(project.id).routing.digest);
  const launch = (id, agent = 'claude') => store.launch(project, false, id, { agent, started: true });
  const note = id => {
    assert.deepEqual(save(), { ok: true });
    return startupNote(READING_NOTE, path.join(root, 'handoff.md'), path.join(project.path, 'skills'), launch(id), path.join(root, 'dispatch.cjs'));
  };
  return { root, store, project, remote, options, save, saveProject, launch, note };
}

function localPresentation(t, f, cliActive) {
  const session = { projectId: f.project.id, terminalId: 'terminal', sessionId: 'claude', agent: 'claude', cliActive,
    skillNoteFile: path.join(f.root, 'current-note.txt'), bootstrapFile: path.join(f.root, 'terminal.json') };
  const sessions = new Map([[session.terminalId, session]]);
  const { tellMode, takeModeNote } = createNativeHost({ routing: f.store, adapterOf, sessions });
  const writes = [];
  const presentation = createSessionPresentation({
    sessions, store: { projects: [f.project] }, routing: f.store, report: assert.fail, randomUUID, path, startupNote, READING_NOTE,
    handoffFile: () => path.join(f.root, 'handoff.md'), updateBootstrapMode, updateBootstrapLead, updateDispatchSeats, tellMode,
    writeFileAtomic: (file, text) => { writes.push(text); fs.writeFileSync(file, text); },
  });
  updateBootstrapMode(session.bootstrapFile, false);
  t.after(() => presentation.endSkillSession(session));
  return { ...presentation, session, writes, nextPromptNote: () => takeModeNote(session.terminalId) };
}

function hookProcess(file, args, input, noteFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: { ...dispatchEnvironment(), AGENTRIX_READING_NOTE_FILE: noteFile }, timeout: 15000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function powershellProbe(folder, script, noteFile) {
  const file = path.join(folder, 'probe.ps1');
  fs.writeFileSync(file, '\uFEFF' + script); // Windows PowerShell requires the BOM for UTF-8 source.
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return hookProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {}, noteFile);
}


test('native launch has only its mode sentence and a conductor reads one rendered guide with its adopted weights', t => {
  let weights = 'Adopted routing: favor reviewer coverage.';
  const f = fixture(t, () => weights);
  const native = f.store.launch(f.project);
  assert.equal(native.guide, null);
  assert.match(native.note, /^Agentrix runs this session in native mode:/);
  assert.doesNotMatch(native.note, /read and follow|weights/);
  assert.deepEqual(f.store.setRouting('project', f.project.id, { conductor: true, roles: {} }, f.store.seatsInfo(f.project.id).routing.digest), { ok: true });
  assert.deepEqual(f.save(), { ok: true });
  const claude = f.launch('claude'), remote = f.store.launch(f.remote, true, 'remote', { started: true });
  assert.match(claude.note, /Before any task, read and follow .*\/routing\/rendered\/[0-9a-f]{32}\.md\.$/);
  assert.ok(claude.note.includes(claude.guide.path.replaceAll('\\', '/')));
  assert.equal(fs.readFileSync(claude.guide.path, 'utf8'), claude.guide.text);
  assert.match(claude.guide.text, /### Adopted routing weights\n\nAdopted routing: favor reviewer coverage\.\n$/);
  assert.match(remote.note, /Before any task, read and follow \{AGENTRIX_ROUTING\}\.$/);
  assert.doesNotMatch(JSON.stringify(remote), new RegExp(f.root.replaceAll('\\', '/')));
  const wire = remoteGuide(remote.guide);
  assert.deepEqual(Object.keys(wire), ['key', 'text']);
  assert.match(wire.key, /^[a-f0-9]{64}$/);
  assert.equal(wire.text, remote.guide.text);
  assert.throws(() => remoteGuide({ text: 'é'.repeat(MAX_SSH_GUIDE_BYTES / 2 + 1) }), /SSH size limit/);
  weights = 'New weights.';
  assert.equal(f.launch('claude').guide.text, claude.guide.text);
  assert.match(f.launch('new').guide.text, /New weights\.\n$/);
});

test('a running Claude or Codex launch keeps the guide and seats it was given while new launches use the accepted settings', t => {
  const f = fixture(t);
  assert.deepEqual(f.save({ researcher: { model: 'haiku', effort: 'high' } }), { ok: true });
  const claude = f.launch('claude'), codex = f.launch('codex', 'codex');
  const latest = f.store.seatsInfo(f.project.id);
  const roles = { researcher: { model: 'opus', effort: 'high' } };
  assert.deepEqual(f.store.setRouting('project', f.project.id, { conductor: true, roles }, latest.routing.digest), { ok: true });
  assert.equal(f.store.dispatchSeats(f.project.id).researcher.model, 'opus');
  for (const [agent, started] of [['claude', claude], ['codex', codex]]) {
    const pinned = f.launch(agent, agent);
    assert.deepEqual(pinned.guide, started.guide);
    assert.equal(pinned.seatsMap.researcher.model, 'haiku');
    assert.equal(fs.readFileSync(pinned.guide.path, 'utf8'), started.guide.text);
  }
  assert.match(f.launch('new', 'codex').guide.text, /^\| researcher \|.*\| opus · high \|/m);
});

test('a launch restores a changed read-only rendered guide at the same path', t => {
  const f = fixture(t);
  assert.deepEqual(f.save(), { ok: true });
  const guide = f.launch('claude').guide, original = fs.realpathSync.native(guide.path);
  fs.chmodSync(original, 0o600);
  fs.writeFileSync(original, ' '.repeat(Buffer.byteLength(guide.text)));
  fs.chmodSync(original, 0o444);
  const restored = f.launch('new').guide;
  assert.equal(fs.realpathSync.native(restored.path), original);
  assert.equal(restored.text, guide.text);
  assert.equal(fs.readFileSync(original, 'utf8'), guide.text);
  assert.equal(fs.statSync(original).mode & 0o222, 0);
});

test('switching a running local Claude from native to conductor gives the seats through the guide once', t => {
  const f = fixture(t), terminal = localPresentation(t, f, true);
  terminal.session.toldSeats = 'Seats from the previous conversation in this terminal.';
  terminal.startSkillSession(f.project, terminal.session);
  assert.match(terminal.writes[0], /in native mode/);
  const roles = { researcher: { model: 'haiku', effort: 'high' } };
  assert.deepEqual(f.saveProject(roles), { ok: true });
  terminal.refreshRoutingNotes();
  terminal.refreshRoutingNotes();
  const note = terminal.nextPromptNote(), guidePath = /read and follow (.*?); start roles/.exec(note)?.[1];
  assert.match(note, /switched this conversation's mode.*in conductor mode/);
  assert.doesNotMatch(note, /the owner changed model routing/);
  assert.ok(guidePath);
  assert.equal(fs.realpathSync.native(path.dirname(guidePath)), fs.realpathSync.native(f.store.renderedDir));
  assert.match(fs.readFileSync(guidePath, 'utf8'), /^\| researcher \|.*\| haiku /m);
  assert.equal(terminal.nextPromptNote(), null);
  for (const model of ['opus', 'haiku']) {
    assert.deepEqual(f.saveProject({ researcher: { ...roles.researcher, model } }), { ok: true });
    terminal.refreshRoutingNotes();
    assert.match(terminal.nextPromptNote(), new RegExp(`the owner changed model routing.*\\(researcher\\): ${model}`));
    terminal.refreshRoutingNotes();
    assert.equal(terminal.nextPromptNote(), null);
  }
});

test('idle shells rewrite the startup note once per changed mode or routing and skip unchanged notes', t => {
  const f = fixture(t), terminal = localPresentation(t, f, false);
  terminal.refreshRoutingNotes();
  assert.equal(terminal.writes.length, 1);
  assert.match(terminal.writes[0], /in native mode/);
  const roles = { researcher: { model: 'haiku', effort: 'high' } };
  for (const [index, model] of ['haiku', 'opus'].entries()) {
    assert.deepEqual(f.saveProject({ researcher: { ...roles.researcher, model } }), { ok: true });
    terminal.refreshRoutingNotes();
    terminal.refreshRoutingNotes();
    assert.equal(terminal.writes.length, index + 2);
    const note = fs.readFileSync(terminal.session.skillNoteFile, 'utf8');
    assert.equal(note, terminal.writes.at(-1));
    assert.match(note, /in conductor mode/);
    const guidePath = /read and follow (.*?\/routing\/rendered\/[a-f0-9]{32}\.md)\./.exec(note)?.[1];
    assert.ok(guidePath);
    assert.equal(fs.realpathSync.native(path.dirname(guidePath)), fs.realpathSync.native(f.store.renderedDir));
    assert.match(fs.readFileSync(guidePath, 'utf8'), new RegExp(`^\\| researcher \\|.*\\| ${model} `, 'm'));
  }
});

test('a Codex resume can read the old guide after a restart, and cleanup only removes expired unused guides', t => {
  const f = fixture(t);
  assert.deepEqual(f.save(), { ok: true });
  const ended = f.launch('codex', 'codex').guide.path, live = f.launch('claude').guide.path;
  assert.notEqual(ended, live);
  f.store.endSession(f.project.id, 'codex');
  f.store.close();
  const reopened = new RoutingStore(f.options);
  t.after(() => reopened.close());
  assert.ok(fs.statSync(ended).isFile());
  const expired = new Date(Date.now() - 31 * 86400_000);
  for (const file of [ended, live]) {
    if (process.platform === 'win32') fs.chmodSync(file, 0o600);
    fs.utimesSync(file, expired, expired);
  }
  const legacy = path.join(f.root, 'skill-delivery', path.basename(ended));
  fs.mkdirSync(path.dirname(legacy));
  fs.writeFileSync(legacy, 'old data');
  fs.utimesSync(legacy, expired, expired);
  reopened.pruneRenderedGuides();
  assert.equal(fs.existsSync(ended), false);
  assert.equal(fs.existsSync(live), true);
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'old data');
});

test('a remote terminal launch sends only the launch note and its single guide', t => {
  const f = fixture(t);
  assert.deepEqual(f.save(), { ok: true });
  const calls = [];
  const s = { agent: 'claude', projectId: f.remote.id, terminal: { request: (...args) => { calls.push(args); return Promise.resolve(); } } };
  const presentation = createSessionPresentation({ routing: f.store, randomUUID, path, startupNote, READING_NOTE, report: assert.fail });
  presentation.startSkillSession(f.remote, s, 41);
  t.after(() => presentation.endSkillSession(s));
  assert.equal(calls.length, 1);
  const [[op, { sequence, note, guide }]] = calls;
  assert.deepEqual([op, sequence], ['launch-note', 41]);
  assert.deepEqual(guide, remoteGuide(f.store.sessionSnapshot(f.remote.id, s.skillSessionId).guide));
  assert.match(note, /\{AGENTRIX_ROUTING\}/);
  assert.doesNotMatch(note, /\{AGENTRIX_(?:SKILLS|AGENTS)\}/);
});

test('Node and PowerShell SessionStart report the conversation for startup, resume, compact and clear without stdout context', async t => {
  const seen = [];
  const server = await createEventServer(event => seen.push(event));
  t.after(() => server.close());
  const helper = path.join(__dirname, '../integration/agent-event.cjs');
  const proc = (source, platform) => ({ session_id: platform + '-' + source, source, hook_event_name: 'SessionStart', transcript_path: '/fixture/transcript.jsonl' });
  const sources = ['startup', 'resume', 'compact', 'clear'];
  for (const source of sources) {
    const result = await hookProcess(process.execPath, [helper, 'claude-hook', server.address, 'fixture', 'fixture-key', 'session'], proc(source, 'node'));
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
    if (process.platform === 'win32') {
      const ps = await runPowerShellHook('session', proc(source, 'powershell'), { pipeName: server.name });
      assert.deepEqual(ps, { code: 0, stdout: '', stderr: '' });
    }
  }
  await server.close();
  assert.deepEqual(seen.filter(event => event.sessionId.startsWith('node-')).map(event => event.sessionSource), sources);
  if (process.platform === 'win32') assert.deepEqual(seen.filter(event => event.sessionId.startsWith('powershell-')).map(event => event.sessionSource), sources);
  assert.ok(seen.every(event => event.state === 'session' && event.transcriptPath === '/fixture/transcript.jsonl'));
});

test('Unix Claude wrapper keeps the startup note on the command line, and reports SessionStart; the shell never runs Codex', { skip: process.platform === 'win32' }, async t => {
  const terminalSession = '11111111-1111-4111-8111-111111111111';
  const f = await fixture(t), bin = path.join(f.root, 'bin'), home = path.join(f.root, 'home'), noteFile = path.join(f.root, `${terminalSession}-skills.txt`);
  const note = f.note('unix'), bootstrap = path.join(f.root, 'terminal.json');
  fs.mkdirSync(bin); fs.mkdirSync(home); fs.writeFileSync(noteFile, note);
  fs.writeFileSync(bootstrap, JSON.stringify({ projectId: terminalSession, projectPath: f.root, sessionKey: 'fixture', pipeName: 'unused' }));
  const script = path.join(f.root, 'fake.cjs');
  fs.writeFileSync(script, `const fs = require('node:fs'), path = require('node:path');
const [agent, ...args] = process.argv.slice(2);
const settings = agent === 'claude' ? JSON.parse(fs.readFileSync(args[1], 'utf8')) : null;
const note = process.env.AGENTRIX_READING_NOTE_FILE;
fs.writeFileSync(path.join(process.env.CAPTURE_ROOT, agent + '.json'), JSON.stringify({ note, args, settings }));`);
  const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
  for (const agent of ['claude', 'codex']) fs.writeFileSync(path.join(bin, agent), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${agent} "$@"\n`, { mode: 0o700 });
  const shell = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  const source = path.join(__dirname, process.platform === 'darwin' ? '../integration/zsh-integration.zsh' : '../integration/bash-integration.bash');
  const env = { HOME: home, ZDOTDIR: home, AGENTRIX_USER_ZDOTDIR: home, PATH: `${bin}:/usr/bin:/bin`, CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    CAPTURE_ROOT: f.root, AGENTRIX_BOOTSTRAP: bootstrap, AGENTRIX_NODE: process.execPath, AGENTRIX_READING_NOTE_FILE: noteFile,
    AGENTRIX_EVENT_HELPER: path.join(__dirname, '../integration/agent-event.cjs') };
  const hooks = hooksFor({ posix: true, node: process.execPath, helper: env.AGENTRIX_EVENT_HELPER });
  Object.assign(env, { AGENTRIX_HOOK_PORT: String(hooks.port), AGENTRIX_HOOK_CHANNEL: hooks.channel, AGENTRIX_HOOK_SETTINGS: hooks.settings.http, AGENTRIX_HOOK_FALLBACK: hooks.settings.fallback });
  await new Promise((resolve, reject) => {
    const child = spawn(shell, ['-c', 'source "$1" zshrc && claude hello && codex hello', '_', source], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; child.stderr.on('data', bytes => { errors += bytes; }); child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(errors)));
  });
  const claude = JSON.parse(fs.readFileSync(path.join(f.root, 'claude.json')));
  // Typing codex asks for a native session, whose start carries the note: the executable on PATH is never run.
  assert.equal(fs.existsSync(path.join(f.root, 'codex.json')), false);
  assert.equal(claude.note, undefined, 'the startup note path stays private to the wrapper');
  assert.equal(claude.args[2], '--append-system-prompt');
  assert.equal(claude.args[3], note);
  assert.match(claude.args[3], /^You run inside Agentrix/);
  assert.deepEqual(claude.args.slice(4), ['hello']);
  assert.ok(!JSON.stringify(claude.args).includes('中文说明'));
  const hook = claude.settings.hooks.SessionStart[0].hooks[0].command;
  assert.match(hook, / session$/);
  assert.ok(claude.args[3].includes('/routing/rendered/'));
  assert.equal(fs.realpathSync.native(path.dirname(claude.args[1])), f.root);
  assert.ok(path.basename(claude.args[1]).startsWith(`${terminalSession}-claude-settings-`));
  assert.equal(fs.existsSync(claude.args[1]), false, 'settings file is removed after exit');
});

test('PowerShell Claude wrapper keeps the startup note and fallback before intact resume arguments', { skip: process.platform !== 'win32' }, async t => {
  const terminalSession = '11111111-1111-4111-8111-111111111111';
  const f = await fixture(t), noteFile = path.join(f.root, `${terminalSession}-skills.txt`), note = f.note('wrapper');
  const bootstrap = path.join(f.root, 'terminal.json');
  fs.writeFileSync(noteFile, note);
  const command = path.join(f.root, 'claude.ps1');
  fs.writeFileSync(command, "@{ args = @($args); settings = (Get-Content -LiteralPath $args[1] -Raw | ConvertFrom-Json) } | ConvertTo-Json -Depth 10 -Compress\n");
  powershellSession(bootstrap);
  const script = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
${bootstrapScript(bootstrap)}
function global:Send-AgentrixEvent {}
function global:Get-AgentrixCommand {}
$global:AgentrixClaudeExecutable = $global:AgentrixClaudeCommand = '${command.replace(/'/g, "''")}'
claude --resume fixture '继续'`;
  const result = await powershellProbe(f.root, script, noteFile);
  assert.equal(result.stderr, ''); assert.equal(result.code, 0);
  const { args, settings } = JSON.parse(result.stdout);
  assert.equal(args[0], '--settings'); assert.ok(settings.hooks.SessionStart);
  assert.equal(fs.realpathSync.native(path.dirname(args[1])), f.root);
  assert.match(path.basename(args[1]), new RegExp(`^${terminalSession}-claude-settings-[0-9a-f]{32}\\.json$`));
  assert.equal(fs.existsSync(args[1]), false);
  assert.equal(args[2], '--append-system-prompt');
  assert.equal(args[3], note);
  assert.match(args[3], /^You run inside Agentrix.*Before any task, read and follow .*\/routing\/rendered\//);
  assert.doesNotMatch(args[3], /中文说明|Agentrix skill delivery:/);
  assert.deepEqual(args.slice(4), ['--resume', 'fixture', '继续']);
});

test('two Claude launches in one PowerShell shell read the current startup note each time', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), noteFile = path.join(f.root, 'current-note.txt'), bootstrap = path.join(f.root, 'terminal.json');
  const command = path.join(f.root, 'claude.ps1');
  fs.writeFileSync(command, "$args[([array]::IndexOf($args, '--append-system-prompt') + 1)]\n");
  powershellSession(bootstrap);
  fs.writeFileSync(noteFile, 'First note.');
  const script = `
$ProgressPreference = 'SilentlyContinue'
${bootstrapScript(bootstrap)}
function global:Send-AgentrixEvent {}
function global:Get-AgentrixCommand {}
$global:AgentrixClaudeExecutable = $global:AgentrixClaudeCommand = '${command.replace(/'/g, "''")}'
$env:AGENTRIX_READING_NOTE = 'Stale note.'
$first = claude
[IO.File]::WriteAllText($env:AGENTRIX_READING_NOTE_FILE, 'Second note.')
$second = claude
@{ first = $first; second = $second } | ConvertTo-Json -Compress`;
  const result = await powershellProbe(f.root, script, noteFile);
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { first: 'First note.', second: 'Second note.' });
});

test('PowerShell 5.1 fallback passes a settings file through a real fake claude.cmd with the startup note intact', { skip: process.platform !== 'win32' }, async t => {
  const terminalSession = '11111111-1111-4111-8111-111111111111';
  const f = await fixture(t), bin = path.join(f.root, 'shim with spaces'), noteFile = path.join(f.root, `${terminalSession}-skills.txt`); fs.mkdirSync(bin);
  const note = f.note('cmd'), bootstrap = path.join(f.root, 'terminal.json');
  fs.writeFileSync(noteFile, note);
  const captureFile = path.join(f.root, 'argv.json'), fake = path.join(bin, 'capture.cjs'), command = path.join(bin, 'claude.cmd');
  fs.writeFileSync(fake, `const fs = require('node:fs'), args = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(args[1], 'utf8'));
fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ args, settings }));`);
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  powershellSession(bootstrap);
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  const script = `$ProgressPreference = 'SilentlyContinue'\n${bootstrapScript(bootstrap)}\nfunction global:Send-AgentrixEvent {}\nfunction global:Get-AgentrixCommand {}
$global:AgentrixClaudeExecutable = ${quote(command)}
$global:AgentrixClaudeCommand = ${quote(command)}
claude --resume fixture 'next task'`;
  const result = await powershellProbe(f.root, script, noteFile);
  assert.equal(result.stderr, ''); assert.equal(result.code, 0);
  const { args, settings } = JSON.parse(fs.readFileSync(captureFile));
  assert.equal(args[0], '--settings'); assert.equal(fs.realpathSync.native(path.dirname(args[1])), f.root);
  assert.match(path.basename(args[1]), new RegExp(`^${terminalSession}-claude-settings-[0-9a-f]{32}\\.json$`));
  assert.ok(settings.hooks.SessionStart[0].hooks[0].command.includes('fixture.ps1'));
  assert.equal(args[2], '--append-system-prompt');
  assert.equal(args[3], note);
  assert.deepEqual(args.slice(4), ['--resume', 'fixture', 'next task']);
  assert.equal(fs.existsSync(args[1]), false);
});

