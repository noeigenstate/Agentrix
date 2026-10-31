const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { cleanupTerminal } = require('./helpers/terminal-cleanup.cjs');
const { createEventServer } = require('../electron/events.cjs');
const { createTerminalEnvironment } = require('../electron/terminal-env.cjs');
// The real text: Markdown, backticks and an exclamation mark pass through the wrappers untouched.
const { READING_NOTE: NOTE } = require('../electron/features/agents/reading-note.cjs');
const { findShell, linuxShell, shellEnvironment, bashArguments, withoutAppImage } = require('../electron/zsh-terminal.cjs');
const { linuxFileClipboard, readFileList, parseFileList } = require('../electron/file-clipboard.cjs');
const { shellEvent } = require('../integration/agent-event.cjs');

const integrationDir = path.resolve(__dirname, '../integration');
const helper = path.join(integrationDir, 'agent-event.cjs');

async function eventually(check, what, deadline = 15000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    // what may be a function, so the message shows the terminal output at the time it gave up.
    if (Date.now() - started > deadline) throw new Error(`Timed out waiting for ${typeof what === 'function' ? what() : what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
function runHook(command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('Linux finds a shell in the system folders or PATH and uses the chosen one when it is installed', () => {
  const have = files => file => files.includes(file);
  assert.equal(findShell('zsh', { platform: 'linux', env: { PATH: '/opt/x/bin:relative' }, exists: have(['/opt/x/bin/zsh']) }), '/opt/x/bin/zsh');
  assert.equal(findShell('zsh', { platform: 'linux', env: { PATH: '/opt/x/bin' }, exists: have(['/usr/bin/zsh', '/opt/x/bin/zsh']) }), '/usr/bin/zsh');
  assert.equal(findShell('zsh', { platform: 'linux', env: { PATH: 'relative' }, exists: have(['relative/zsh']) }), null);
  assert.equal(findShell('zsh', { platform: 'darwin', env: { PATH: '/opt/homebrew/bin' }, exists: have(['/opt/homebrew/bin/zsh']) }), null, 'macOS uses the system zsh');

  const find = installed => name => installed.includes(name) ? `/usr/bin/${name}` : null;
  const both = find(['bash', 'zsh']), bashOnly = find(['bash']);
  assert.deepEqual(linuxShell('zsh', { env: {}, find: both }), { kind: 'zsh', file: '/usr/bin/zsh', zsh: true });
  assert.deepEqual(linuxShell('bash', { env: { SHELL: '/usr/bin/zsh' }, find: both }), { kind: 'bash', file: '/usr/bin/bash', zsh: true });
  assert.equal(linuxShell('powershell', { env: { SHELL: '/usr/bin/zsh' }, find: both }).kind, 'zsh', 'until one is chosen, the login shell');
  assert.equal(linuxShell('powershell', { env: { SHELL: '/bin/fish' }, find: both }).kind, 'bash');
  assert.deepEqual(linuxShell('zsh', { env: {}, find: bashOnly }), { kind: 'bash', file: '/usr/bin/bash', zsh: false }, 'zsh that is not installed falls back to Bash');
  assert.equal(linuxShell('bash', { env: {}, find: () => null }).file, '/bin/bash');
  assert.deepEqual(bashArguments('/app/integration'), ['--rcfile', '/app/integration/bash-integration.bash', '-i']);
});

test('terminals started from an AppImage leave out its folders and variables', () => {
  const env = {
    APPIMAGE: '/home/u/Agentrix.AppImage', APPDIR: '/tmp/.mount_ab', ARGV0: 'x', OWD: '/home/u', HOME: '/home/u',
    PATH: '/tmp/.mount_ab:/tmp/.mount_ab/usr/sbin:/home/u/.local/bin:/usr/bin', LD_LIBRARY_PATH: '/tmp/.mount_ab/usr/lib',
    XDG_DATA_DIRS: '/tmp/.mount_ab/usr/share/::/usr/share/gnome:/usr/share/', GSETTINGS_SCHEMA_DIR: '/tmp/.mount_ab/usr/share/glib-2.0/schemas:/opt/s',
  };
  assert.deepEqual(withoutAppImage(env), { HOME: '/home/u', PATH: '/home/u/.local/bin:/usr/bin', XDG_DATA_DIRS: '/usr/share/gnome:/usr/share/', GSETTINGS_SCHEMA_DIR: '/opt/s' });
  assert.equal(withoutAppImage({ PATH: '/tmp/.mount_ab/bin', APPDIR: '/tmp/.mount_ab' }).PATH, '/tmp/.mount_ab/bin', 'only inside an AppImage');
  assert.equal(withoutAppImage({ APPIMAGE: 'a', APPDIR: '/tmp/.mount_ab', PATH: '/tmp/.mount_abc/bin' }).PATH, '/tmp/.mount_abc/bin', 'a neighbouring folder stays');
});

test('a Bash report becomes the event zsh sends', () => {
  assert.deepEqual(shellEvent(['shell-prompt', '7', '0', 'codex', 'true', 'false', '/h/.codex', '/p/中文 项目'], 'p', 'k'),
    { projectId: 'p', sessionKey: 'k', type: 'shell-prompt', sequence: 7, exitCode: 0, agent: 'codex', codexAvailable: true, claudeAvailable: false, codexHome: '/h/.codex', cwd: '/p/中文 项目' });
  assert.equal(shellEvent(['codex-exited', '8', '130', 'claude', 'false', 'true', '', '/'], 'p', 'k').exitCode, 130);
  assert.equal(shellEvent(['codex-exited', '8', 'x', 'other', 'yes', 'no', '', '/'], 'p', 'k').agent, 'codex');
  assert.equal(shellEvent(['turn-complete', '1'], 'p', 'k'), null, 'only shell reports');
  assert.equal(shellEvent(['shell-prompt', '-1'], 'p', 'k'), null);
});

test('the Linux file clipboard writes the formats file managers read and reads theirs back', async () => {
  assert.deepEqual(parseFileList('copy\nfile:///tmp/a%20b\nfile:///tmp/%E4%B8%AD\n'), ['/tmp/a b', '/tmp/中']);
  assert.deepEqual(parseFileList('# comment\r\nfile:///etc/hosts\r\nhttps://example.com/x\r\n'), ['/etc/hosts']);
  assert.deepEqual(parseFileList(''), []);

  let written;
  class ClipboardItem { constructor(items) { this.items = items; } }
  const electron = () => ({ ClipboardItem, clipboard: { write: async items => { written = items; } } });
  assert.deepEqual(await linuxFileClipboard('copy', ['/tmp/a b', '/tmp/中'], { electron }), { count: 2 });
  assert.deepEqual(written[0].items, {
    'electron application/osclipboard;format="x-special/gnome-copied-files"': 'copy\nfile:///tmp/a%20b\nfile:///tmp/%E4%B8%AD',
    'electron application/osclipboard;format="text/uri-list"': 'file:///tmp/a%20b\r\nfile:///tmp/%E4%B8%AD\r\n',
    'text/plain': '/tmp/a b\n/tmp/中',
  });
  await assert.rejects(linuxFileClipboard('move', ['/a'], { electron }));

  // wl-paste on Wayland, xclip on X11; an installed tool with no files answers "none" without Electron.
  const calls = [];
  const tool = answers => async (file, args) => { calls.push([file, ...args].join(' ')); return answers[[file, ...args].join(' ')] ?? null; };
  const noElectron = () => { throw new Error('Electron was asked'); };
  assert.deepEqual(await readFileList({ env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, electron: noElectron, runTool: tool({
    'wl-paste --list-types': 'text/plain\nx-special/gnome-copied-files\n',
    'wl-paste --no-newline --type x-special/gnome-copied-files': 'cut\nfile:///home/u/a.txt',
  }) }), ['/home/u/a.txt']);
  assert.deepEqual(await readFileList({ env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, electron: noElectron, runTool: tool({
    'xclip -selection clipboard -t TARGETS -o': 'TARGETS\ntext/uri-list\n', 'xclip -selection clipboard -t text/uri-list -o': 'file:///x\r\n',
  }) }), ['/x'], 'no wl-paste: xclip');
  assert.deepEqual(await readFileList({ env: { DISPLAY: ':0' }, electron: noElectron, runTool: tool({ 'xclip -selection clipboard -t TARGETS -o': 'UTF8_STRING\n' }) }), []);
  // Neither tool: Electron's clipboard.
  const item = { types: ['electron application/osclipboard;format="TARGETS"', 'electron application/osclipboard;format="text/uri-list"'],
    getType: async type => ({ text: async () => type.includes('uri-list') ? 'file:///y\r\n' : '' }) };
  assert.deepEqual(await readFileList({ env: { DISPLAY: ':0' }, runTool: async () => null, electron: () => ({ clipboard: { read: async () => [item] } }) }), ['/y']);
  assert.deepEqual(await readFileList({ env: {}, runTool: async () => null, electron: () => ({ clipboard: { read: async () => [] } }) }), []);
});

test('a real Bash terminal keeps the user start-up files and reports prompts, Codex and Claude Code', { skip: process.platform !== 'linux' || !findShell('bash'), timeout: 60000 }, async t => {
  const pty = require('node-pty');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-bash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), bin = path.join(home, 'bin'), log = path.join(root, 'log');
  const project = path.join(root, "项目 空格 'q' $x");
  const sessionFolder = path.join(root, "sessions 'quoted'"), noteFile = path.join(sessionFolder, 'terminal-skills.txt');
  for (const folder of [bin, log, project, sessionFolder]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(noteFile, NOTE);
  // The user's own ~/.bashrc puts codex and claude on PATH, aliases claude, keeps its own prompt command and
  // moves elsewhere.
  fs.writeFileSync(path.join(home, '.bashrc'), [
    'export PATH="$HOME/bin:$PATH"', "alias claude='claude --model opus'", 'PG_TEST_BASHRC=1', "PROMPT_COMMAND='PG_TEST_LAST=$?'", 'cd /', '',
  ].join('\n'));
  const recorder = path.join(root, 'recorder.cjs');
  fs.writeFileSync(recorder, `const fs = require('node:fs'), path = require('node:path');
const [agent, ...args] = process.argv.slice(2);
fs.writeFileSync(path.join(process.env.PG_TEST_LOG, agent + '.json'), JSON.stringify(args));
if (agent === 'claude') fs.copyFileSync(args[args.indexOf('--settings') + 1], path.join(process.env.PG_TEST_LOG, 'claude-settings.json'));
process.exitCode = Number(process.env.PG_TEST_EXIT || 0);
`);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nPG_TEST_EXIT=3 exec "$PG_TEST_NODE" "$PG_TEST_RECORDER" codex "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexec "$PG_TEST_NODE" "$PG_TEST_RECORDER" claude "$@"\n', { mode: 0o755 });

  const events = [];
  const server = await createEventServer(event => events.push(event));
  t.after(() => server.close());
  const source = { ...process.env, HOME: home, TMPDIR: sessionFolder, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PG_TEST_NODE: process.execPath, PG_TEST_RECORDER: recorder, PG_TEST_LOG: log, AGENTRIX_READING_NOTE: NOTE, AGENTRIX_READING_NOTE_FILE: noteFile };
  delete source.LANG; delete source.LC_ALL; delete source.LC_CTYPE; delete source.CODEX_HOME; delete source.PROMPT_COMMAND;
  const env = shellEnvironment(createTerminalEnvironment(source, ''), { socket: server.address, projectId: 'project', sessionKey: 'key', node: process.execPath, helper, startDir: project, locale: 'C.UTF-8' });
  const terminal = pty.spawn(findShell('bash'), bashArguments(integrationDir), { name: 'xterm-256color', cols: 120, rows: 30, cwd: project, env });
  cleanupTerminal(t, terminal);
  let output = '';
  terminal.onData(data => { output += data; });
  const type = text => terminal.write(text + '\r');
  const waitEvent = (predicate, what) => eventually(() => events.find(predicate), () => `${what}\n--- terminal output ---\n${output}`);
  const readLog = name => eventually(() => { try { return fs.readFileSync(path.join(log, name), 'utf8').trim(); } catch { return null; } }, name);

  const ready = await waitEvent(event => event.type === 'shell-ready', 'shell-ready');
  const prompt = await waitEvent(event => event.type === 'shell-prompt', 'the first prompt');
  assert.ok(prompt.sequence > ready.sequence);
  for (const event of [ready, prompt]) {
    assert.equal(event.projectId, 'project'); assert.equal(event.sessionKey, 'key');
    assert.equal(event.cwd, project, 'the terminal opens in the project even though .bashrc moved');
    assert.equal(event.codexAvailable, true); assert.equal(event.claudeAvailable, true);
    assert.equal(event.codexHome, path.join(home, '.codex'));
  }
  assert.match(output, /AGENTRIX/);

  // The user's file ran, nothing of Agentrix leaks into programs started here, and the user's own prompt
  // command still sees the exit status of the last command.
  type('false');
  type('printf "%s\\n" "${AGENTRIX_SESSION_KEY-0}${AGENTRIX_SOCKET-0}${AGENTRIX_NODE-0}${AGENTRIX_READING_NOTE-0}|$PG_TEST_BASHRC|$PG_TEST_LAST|$LANG|$TERM_PROGRAM|$(bash -c \'type -t codex\' 2>/dev/null)" > "$PG_TEST_LOG/state"');
  assert.equal(await readLog('state'), '0000|1|1|C.UTF-8|agentrix|file');

  // codex: started and exited around the real program, which gets notify and the title setting first.
  type('codex resume --last');
  const exited = await waitEvent(event => event.type === 'codex-exited', 'codex-exited');
  const started = events.find(event => event.type === 'codex-started');
  assert.ok(started && started.sequence < exited.sequence); assert.equal(started.agent, 'codex'); assert.equal(started.command, 'resume', 'the first word goes with it (agent-command.cjs)'); assert.equal(exited.exitCode, 3);
  const codexArgs = JSON.parse(fs.readFileSync(path.join(log, 'codex.json'), 'utf8'));
  // What the reading view can show comes next, before the user's own arguments.
  assert.deepEqual(codexArgs.slice(2), ['-c', 'tui.terminal_title=["session-id"]', '-c', `developer_instructions="${NOTE}"`, 'resume', '--last']);
  assert.equal(codexArgs[0], '-c');
  const notify = JSON.parse(codexArgs[1].replace(/^notify=/, ''));
  assert.deepEqual(notify, ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', process.execPath, helper, 'codex-notify', server.address, 'project', 'key']);
  await promisify(execFile)(notify[0], [...notify.slice(1), JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'thread', 'turn-id': 'turn' })]);
  await waitEvent(event => event.type === 'turn-complete' && event.eventId === 'thread:turn', 'turn-complete');

  // claude: the user's alias still applies, and the hooks it is given report each turn.
  type('claude -p "中文 prompt"');
  const claudeExited = await waitEvent(event => event.type === 'codex-exited' && event.agent === 'claude', 'claude to exit');
  assert.equal(claudeExited.exitCode, 0);
  assert.ok(events.some(event => event.type === 'codex-started' && event.agent === 'claude' && event.command === '-p'));
  const claudeArgs = JSON.parse(fs.readFileSync(path.join(log, 'claude.json'), 'utf8'));
  assert.deepEqual([claudeArgs.slice(0, 2), claudeArgs.slice(4)], [['--model', 'opus'], ['--append-system-prompt', NOTE, '-p', '中文 prompt']]);
  assert.equal(claudeArgs[2], '--settings');
  assert.equal(path.dirname(claudeArgs[3]), sessionFolder);
  assert.match(path.basename(claudeArgs[3]), /^terminal-claude-settings-[A-Za-z0-9]{6}$/);
  assert.equal(fs.existsSync(claudeArgs[3]), false, 'the session settings file is removed after Claude exits');
  const hooks = JSON.parse(fs.readFileSync(path.join(log, 'claude-settings.json'), 'utf8')).hooks;
  const input = { session_id: 'session-1', transcript_path: '/claude/session-1.jsonl', prompt: '修复 "登录" $HOME `x`' };
  assert.deepEqual(await runHook(hooks.UserPromptSubmit[0].hooks[0].command, input), { code: 0, output: '' }, 'a hook prints nothing');
  const working = await waitEvent(event => event.type === 'agent-activity' && event.state === 'working', 'the working hook');
  assert.equal(working.prompt, input.prompt); assert.equal(working.transcriptPath, input.transcript_path); assert.equal(working.sessionKey, 'key');
  await runHook(hooks.Stop[0].hooks[0].command, input);
  await waitEvent(event => event.type === 'agent-activity' && event.state === 'complete', 'the stop hook');

  // Without a note file the wrapper uses a named file in TMPDIR, and also cleans up after a failed CLI.
  type('__pg_note_file=; PG_TEST_EXIT=7 claude --version');
  const failed = await waitEvent(event => event.type === 'codex-exited' && event.agent === 'claude' && event.sequence > claudeExited.sequence, 'claude to exit without a note file');
  assert.equal(failed.exitCode, 7);
  const fallbackArgs = JSON.parse(fs.readFileSync(path.join(log, 'claude.json'), 'utf8'));
  assert.equal(path.dirname(fallbackArgs[3]), sessionFolder);
  assert.match(path.basename(fallbackArgs[3]), /^agentrix-claude-settings-[A-Za-z0-9]{6}$/);
  assert.equal(fs.existsSync(fallbackArgs[3]), false, 'the fallback settings file is removed after a failed CLI');
  const fallbackHooks = JSON.parse(fs.readFileSync(path.join(log, 'claude-settings.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(fallbackHooks), Object.keys(hooks));
  assert.match(fallbackHooks.SessionStart[0].hooks[0].command, / session ''$/);

  // Every report from this shell is newer than the one before it.
  const sequences = events.filter(event => typeof event.sequence === 'number').map(event => event.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  // A closed Agentrix never stops the shell or the agent.
  server.close();
  type('codex; echo done > "$PG_TEST_LOG/after-close"');
  await readLog('after-close');
});
