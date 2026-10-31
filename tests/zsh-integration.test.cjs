const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { cleanupTerminal } = require('./helpers/terminal-cleanup.cjs');
const { createEventServer, socketAddress } = require('../electron/events.cjs');
const { createTerminalEnvironment } = require('../electron/terminal-env.cjs');
// The real text: Markdown, backticks and an exclamation mark pass through the wrappers untouched.
const { READING_NOTE: NOTE } = require('../electron/features/agents/reading-note.cjs');
const { ZSH, findShell, prepareZshStartup, zshEnvironment, terminalLocale, loginShellPath, mergePath } = require('../electron/zsh-terminal.cjs');
const { codexEvent, claudeEvent } = require('../integration/agent-event.cjs');

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
// Runs a hook command the way Claude Code does: through sh, with the hook's JSON on standard input.
function runHook(command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('the terminal locale follows the system language and falls back to en_US.UTF-8', () => {
  const have = new Set(['zh_CN.UTF-8', 'zh_TW.UTF-8', 'en_US.UTF-8', 'en_GB.UTF-8']), exists = name => have.has(name);
  assert.equal(terminalLocale(['zh-Hans-CN', 'en-CN'], exists), 'zh_CN.UTF-8');
  assert.equal(terminalLocale(['zh-Hant-TW'], exists), 'zh_TW.UTF-8');
  assert.equal(terminalLocale(['zh-Hans-SG'], exists), 'zh_CN.UTF-8');
  assert.equal(terminalLocale(['en-GB'], exists), 'en_GB.UTF-8');
  assert.equal(terminalLocale(['tlh-KX', 'x'], exists), 'en_US.UTF-8');
  assert.equal(terminalLocale([], exists), 'en_US.UTF-8');
});

test('the login shell PATH comes first and keeps the folders only the current PATH has', async () => {
  assert.equal(mergePath('/opt/homebrew/bin:/usr/bin:/bin', '/usr/bin:/bin:/usr/sbin:/sbin'), '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(mergePath(null, '/usr/bin:/bin'), '/usr/bin:/bin');
  const reply = output => loginShellPath({ shell: '/bin/zsh', run: (_file, _args, _options, done) => done(null, output) });
  assert.equal(await reply('Last login: today\n__AGENTRIX_PATH__\n/a:/b\n__AGENTRIX_PATH__\n'), '/a:/b');
  assert.equal(await reply('no markers'), null);
  assert.equal(await loginShellPath({ run: () => { throw new Error('ENOENT'); } }), null);
});

test('a socket path too long for macOS moves to /tmp', () => {
  assert.equal(socketAddress('pg-1', '/var/folders/x/T'), '/var/folders/x/T/pg-1.sock');
  assert.equal(socketAddress('pg-1', '/' + 'a'.repeat(120)), '/tmp/pg-1.sock');
});

test('Codex notify and Claude hook payloads become the events notify.ps1 and claude-hook.ps1 send', () => {
  assert.equal(codexEvent(JSON.stringify({ type: 'approval-requested' }), 'p', 'k'), null);
  assert.deepEqual(codexEvent(JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'thread', 'turn-id': 'turn', 'last-assistant-message': 'x' }), 'p', 'k'),
    { projectId: 'p', sessionKey: 'k', type: 'turn-complete', eventId: 'thread:turn', threadId: 'thread', turnId: 'turn' });
  assert.match(codexEvent(JSON.stringify({ type: 'agent-turn-complete' }), 'p', 'k').eventId, /^[0-9A-F]{64}$/);
  assert.equal(claudeEvent(JSON.stringify({ prompt: 'x' }), 'p', 'k', 'start'), null, 'no session id');
  assert.equal(claudeEvent(JSON.stringify({ session_id: 's' }), 'p', 'k', 'other'), null);
  // SessionStart (a start, /resume, /clear) reports the conversation file Claude writes from now on.
  const session = claudeEvent(JSON.stringify({ session_id: 's2', transcript_path: '/t/s2.jsonl', source: 'clear' }), 'p', 'k', 'session');
  assert.deepEqual([session.state, session.sessionId, session.transcriptPath, session.prompt], ['session', 's2', '/t/s2.jsonl', null]);
  const working = claudeEvent(JSON.stringify({ session_id: 's', transcript_path: '/t/s.jsonl', prompt: '长'.repeat(3000) }), 'p', 'k', 'start');
  assert.equal(working.state, 'working'); assert.equal(working.prompt.length, 2000); assert.equal(working.transcriptPath, '/t/s.jsonl');
  assert.match(working.eventId, /^s:\d+$/);
  const complete = claudeEvent(JSON.stringify({ session_id: 's', prompt: 'ignored' }), 'p', 'k', 'stop');
  assert.equal(complete.state, 'complete'); assert.equal(complete.prompt, null);
  for (const notification_type of ['permission_prompt', 'elicitation_dialog']) {
    const notice = claudeEvent(JSON.stringify({ session_id: 's', notification_type, message: '长'.repeat(400) }), 'p', 'k', 'notify');
    assert.equal(notice.state, 'attention'); assert.equal(notice.message, '长'.repeat(300)); assert.equal(notice.prompt, null);
  }
  for (const notification_type of ['idle_prompt', 'auth_success', 'other', undefined]) assert.equal(claudeEvent(JSON.stringify({ session_id: 's', notification_type }), 'p', 'k', 'notify'), null);
  assert.equal(claudeEvent(JSON.stringify({ session_id: 's', notification_type: 'permission_prompt', message: 42 }), 'p', 'k', 'notify').message, '42');
});

// macOS, and Linux where zsh is installed.
const zsh = process.platform === 'darwin' ? fs.existsSync(ZSH) && ZSH : process.platform === 'linux' ? findShell('zsh') : null;
test('a real zsh terminal keeps the user start-up files and reports prompts, Codex and Claude Code', { skip: !zsh, timeout: 60000 }, async t => {
  const pty = require('node-pty');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-zsh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), bin = path.join(home, 'bin'), log = path.join(root, 'log');
  const project = path.join(root, "项目 空格 'q' $x");
  const sessionFolder = path.join(root, "sessions 'quoted'"), noteFile = path.join(sessionFolder, 'terminal-skills.txt');
  for (const folder of [bin, log, project, sessionFolder]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(noteFile, NOTE);
  // The user's own start-up files: each leaves a mark, .zprofile puts codex and claude on PATH, .zshrc aliases
  // claude and moves elsewhere.
  // Debian and Ubuntu's /etc/zsh/zshrc runs compinit, which stops to ask when a completion folder is writable by
  // others (as /usr/local is on CI runners); the documented switch turns that off for this user.
  fs.writeFileSync(path.join(home, '.zshenv'), 'export PG_TEST_ZSHENV=1\nskip_global_compinit=1\n');
  fs.writeFileSync(path.join(home, '.zprofile'), 'path=("$HOME/bin" $path)\n');
  fs.writeFileSync(path.join(home, '.zshrc'), "alias claude='claude --model opus'\nPG_TEST_ZSHRC=1\ncd /\n");
  fs.writeFileSync(path.join(home, '.zlogin'), 'PG_TEST_ZLOGIN=1\n');
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
  const folder = prepareZshStartup(path.join(root, 'zdotdir'), integrationDir);
  const source = { ...process.env, HOME: home, TMPDIR: sessionFolder, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PG_TEST_NODE: process.execPath, PG_TEST_RECORDER: recorder, PG_TEST_LOG: log, AGENTRIX_READING_NOTE: NOTE, AGENTRIX_READING_NOTE_FILE: noteFile };
  delete source.ZDOTDIR; delete source.LANG; delete source.LC_ALL; delete source.LC_CTYPE; delete source.CODEX_HOME;
  const env = zshEnvironment(createTerminalEnvironment(source, ''), { folder, socket: server.address, projectId: 'project', sessionKey: 'key', node: process.execPath, helper, startDir: project, locale: 'en_US.UTF-8' });
  const terminal = pty.spawn(zsh, ['-l', '-i'], { name: 'xterm-256color', cols: 120, rows: 30, cwd: project, env });
  cleanupTerminal(t, terminal);
  let output = '';
  terminal.onData(data => { output += data; });
  const type = text => terminal.write(text + '\r');
  const waitEvent = (predicate, what) => eventually(() => events.find(predicate), () => `${what}\n--- terminal output ---\n${output}`);

  const ready = await waitEvent(event => event.type === 'shell-ready', 'shell-ready');
  const prompt = await waitEvent(event => event.type === 'shell-prompt', 'the first prompt');
  assert.ok(prompt.sequence > ready.sequence);
  for (const event of [ready, prompt]) {
    assert.equal(event.projectId, 'project'); assert.equal(event.sessionKey, 'key');
    assert.equal(event.cwd, project, 'the terminal opens in the project even though .zshrc moved');
    assert.equal(event.codexAvailable, true); assert.equal(event.claudeAvailable, true);
    assert.equal(event.codexHome, path.join(home, '.codex'));
  }
  assert.match(output, /AGENTRIX/);

  // The shell itself: the user's files all ran, nothing of Agentrix leaks into programs started here.
  type('print -r -- "${ZDOTDIR-unset}|$HISTFILE|${+AGENTRIX_SESSION_KEY}${+AGENTRIX_SOCKET}|$PG_TEST_ZSHENV$PG_TEST_ZSHRC$PG_TEST_ZLOGIN|$LANG|$TERM_PROGRAM" > "$PG_TEST_LOG/state"');
  const state = await eventually(() => { try { return fs.readFileSync(path.join(log, 'state'), 'utf8').trim(); } catch { return null; } }, 'the shell state');
  // macOS's /etc/zshrc names a history file; Linux leaves that to the user's own files.
  assert.equal(state, `unset|${process.platform === 'darwin' ? path.join(home, '.zsh_history') : ''}|00|111|en_US.UTF-8|agentrix`);

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
  // Codex appends the turn's JSON and runs the command; the event reaches the window.
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
  assert.deepEqual(await runHook(hooks.Notification[0].hooks[0].command, { ...input, notification_type: 'permission_prompt', message: 'Approve tool' }), { code: 0, output: '' });
  await waitEvent(event => event.type === 'agent-activity' && event.state === 'attention' && event.message === 'Approve tool', 'the permission hook');
  const noticeCount = events.filter(event => event.state === 'attention').length;
  assert.deepEqual(await runHook(hooks.Notification[0].hooks[0].command, { ...input, notification_type: 'idle_prompt' }), { code: 0, output: '' });
  assert.equal(events.filter(event => event.state === 'attention').length, noticeCount);
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
  type('codex; print -r -- done > "$PG_TEST_LOG/after-close"');
  await eventually(() => fs.existsSync(path.join(log, 'after-close')), 'the shell to continue without Agentrix');
});
