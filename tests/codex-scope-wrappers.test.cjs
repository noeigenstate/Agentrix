const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFile } = require('node:child_process'), { promisify } = require('node:util');
const { createEventServer } = require('../electron/events.cjs');
const { isolatedEnvironment } = require('../scripts/native-approval-probe.cjs');
const { timeoutScale } = require('../scripts/wait.mjs');
const { TERMINAL_COMMANDS } = require('./fixtures/codex-terminal-commands.cjs');
const exec = promisify(execFile), integration = path.resolve(__dirname, '../integration');
const argv = ['resume', '11111111-1111-4111-8111-111111111111', '-m', 'fixture', '中文 "quotes" \\ end'];
// What starts a conversation, or is not known to start none: these ask the host and never reach the CLI.
const conversations = [[], argv, ['--profile', 'other'], ['exec', 'task'], ['review'], ['fork', '--last'], ['修复登录页'],
  ['Login'], ['login logout'], ['-v'], ['--model', 'fixture', 'login'], ['e', 'task'], ['agents'], ['queue'], ['cloud'], ['unknown-word']];
// Management runs with arguments a shell could damage: spaces, quotes, a trailing backslash, an empty word.
const managed = [...TERMINAL_COMMANDS.map(word => [word]), ['mcp', 'add', 'name with space', '--env', 'A="b c"', '中文 \\ end\\', '']];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-wrapper-'));
  t.after(async () => { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return root;
}
const powershell = () => path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const recorded = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
const requests = events => events.filter(event => event.type === 'agent-started').map(event => event.args);

// A terminal's own wrappers in one PowerShell, with `folder` first on PATH. Each case is one typed codex (with piped
// input when it has one); the result is what the shell printed, the requests the host received and what the stand-in
// CLI recorded.
async function typedInPowerShell(t, folder, cases, { missing = false } = {}) {
  const root = fixture(t), record = path.join(root, 'recorded.jsonl'), events = [], server = await createEventServer(event => events.push(event));
  t.after(() => server.close());
  const bootstrap = path.join(root, 'bootstrap.json'), script = path.join(root, 'probe.ps1');
  fs.writeFileSync(bootstrap, JSON.stringify({ projectPath: root, projectId: 't', sessionKey: 'key', pipeName: server.name }));
  const env = { ...isolatedEnvironment(root), AGENTRIX_BOOTSTRAP: bootstrap, AGENTRIX_NODE: process.execPath, ARGV_RECORDER_FILE: record, WRAPPER_CASES: JSON.stringify(cases),
    PATH: folder + path.delimiter + process.env.PATH, PSModuleAnalysisCachePath: path.join(root, 'module-cache') };
  delete env.Path;
  // WRAPPERS_LOADED tells a probe killed by its timeout apart: stopped while loading, or inside a codex. Nothing is
  // printed before the load, which is what sets the output encoding.
  fs.writeFileSync(script, `$env:AGENTRIX_AGENT_ONLY='1'\n. '${integration.replace(/'/g, "''")}\\bootstrap.ps1'\nWrite-Output 'WRAPPERS_LOADED'
${missing ? '$global:AgentrixCodexCommand = $null' : ''}
$cases = ConvertFrom-Json $env:WRAPPER_CASES
foreach ($case in $cases) {
    $values = @($case.args)
    if ($null -ne $case.input) { $case.input | codex @values } else { codex @values }
    Write-Output "EXIT=$LASTEXITCODE"
}
Write-Output 'SHELL_RETURNED'
`);
  const result = await exec(powershell(), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { cwd: root, env, windowsHide: true, timeout: (8000 + 2000 * cases.length) * timeoutScale });
  assert.equal(result.stderr, ''); assert.match(result.stdout, /SHELL_RETURNED/);
  return { root, env, events, record, stdout: result.stdout, exits: [...result.stdout.matchAll(/EXIT=(-?\d+)/g)].map(match => Number(match[1])) };
}
// The stand-in CLI as a real executable named codex.exe in a folder of its own.
async function recorderExecutable(t) {
  const folder = fixture(t);
  await exec(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', `/out:${path.join(folder, 'codex.exe')}`, path.join(__dirname, 'fixtures/argv-recorder.cs')], { windowsHide: true });
  await (await import('../scripts/gui-codex-env.mjs')).markStandIn(folder);
  return folder;
}

test('PowerShell native wrapper preserves empty and quoted argv and returns without an executable',
  { skip: process.platform !== 'win32', timeout: 15000 * timeoutScale }, async t => {
    const typed = await typedInPowerShell(t, fixture(t), [[], argv].map(args => ({ args })), { missing: true });
    assert.deepEqual(requests(typed.events), [[], argv]);
    assert.deepEqual(typed.exits, [0, 0]);
  });

test('PowerShell and the cmd shim request native Codex for every conversation form, preserve argv, return to the shell and never run its executable',
  { skip: process.platform !== 'win32', timeout: 60000 * timeoutScale }, async t => {
    const folder = await recorderExecutable(t);
    const typed = await typedInPowerShell(t, folder, conversations.map(args => ({ args })));
    assert.equal(typed.stdout.match(/原生模式/g)?.length, conversations.length);
    assert.deepEqual(requests(typed.events), conversations, JSON.stringify(typed.events));
    assert.deepEqual(typed.exits, conversations.map(() => 0));
    await exec(powershell(), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(integration, 'agent.ps1'), 'codex', ...argv],
      { cwd: typed.root, env: typed.env, windowsHide: true, timeout: 8000 * timeoutScale });
    assert.deepEqual(requests(typed.events).at(-1), argv);
    assert.equal(typed.events.some(event => event.type === 'agent-exited'), false, 'no terminal Codex invocation or fabricated completion');
    assert.deepEqual(recorded(typed.record), [], 'no conversation form reaches the CLI');
    await assert.rejects(exec(process.env.ComSpec, ['/d', '/c', 'codex'], { cwd: typed.root, env: typed.env, windowsHide: true }), { code: 7 });
    assert.deepEqual(recorded(typed.record), [{ args: [], input: null }], 'outside an injected shell the executable is unchanged');
  });

test('PowerShell and the cmd shim run the Codex CLI\'s management commands in the terminal: exact argv, piped input, its exit code and no native request',
  { skip: process.platform !== 'win32', timeout: 90000 * timeoutScale }, async t => {
    const folder = await recorderExecutable(t), key = { args: ['login', '--with-api-key'], input: 'fixture-key' };
    const typed = await typedInPowerShell(t, folder, [...managed.map(args => ({ args })), key]);
    assert.deepEqual(recorded(typed.record).map(run => run.args), [...managed, key.args]);
    assert.equal(recorded(typed.record).at(-1).input.trim(), key.input, 'what is piped to codex reaches the CLI');
    assert.deepEqual(typed.exits, [...managed, key].map(() => 7), 'the exit code is the CLI\'s own');
    assert.deepEqual(requests(typed.events), [], 'a management run asks for no native session');
    assert.doesNotMatch(typed.stdout, /原生模式/);
    // Command Prompt: the doskey macro runs agent.ps1, which exits with the CLI's code.
    for (const args of [['mcp', 'list'], ['-h']]) {
      await assert.rejects(exec(powershell(), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(integration, 'agent.ps1'), 'codex', ...args],
        { cwd: typed.root, env: typed.env, windowsHide: true, timeout: 8000 * timeoutScale }), { code: 7 });
      assert.deepEqual(recorded(typed.record).at(-1).args, args);
    }
    assert.deepEqual(requests(typed.events), []);

    // npm installs Codex as script shims: PowerShell runs those as it runs any command.
    const shims = fixture(t);
    fs.writeFileSync(path.join(shims, 'codex.cmd'), `@echo off\r\n"${path.join(folder, 'codex.exe')}" %*\r\n`);
    const shim = await typedInPowerShell(t, shims, [{ args: ['mcp', 'list'] }, { args: ['--version'] }]);
    assert.deepEqual(recorded(shim.record).map(run => run.args), [['mcp', 'list'], ['--version']]);
    assert.deepEqual(shim.exits, [7, 7]); assert.deepEqual(requests(shim.events), []);

    // Not installed: said like Claude Code's wrapper says it, and a conversation is still the host's to open.
    const absent = await typedInPowerShell(t, fixture(t), [{ args: ['--version'] }, { args: ['login'] }, { args: ['resume', '--last'] }], { missing: true });
    assert.equal(absent.stdout.match(/Codex CLI was not found in PATH/g)?.length, 2);
    assert.deepEqual(absent.exits, [127, 127, 0]); assert.deepEqual(requests(absent.events), [['resume', '--last']]);
    assert.deepEqual(recorded(absent.record), []);
  });

test('the PowerShell bootstrap finds an agent on PATH in PowerShell\'s order and never through Get-Command',
  { skip: process.platform !== 'win32', timeout: 15000 * timeoutScale }, async t => {
    const source = fs.readFileSync(path.join(integration, 'bootstrap.ps1'), 'utf8');
    // For a name that is not installed, Get-Command goes on to analyse every installed module before it answers.
    assert.doesNotMatch(source.split(/\r?\n/).filter(line => !line.trim().startsWith('#')).join('\n'), /Get-Command/);
    const root = fixture(t), first = path.join(root, 'first'), second = path.join(root, 'second folder'), script = path.join(root, 'finder.ps1');
    for (const [folder, names] of [[first, ['script.ps1', 'script.cmd', 'script', 'batch.cmd', 'batch', 'bare']], [second, ['batch.bat', 'late.exe']]]) {
      fs.mkdirSync(folder); for (const name of names) fs.writeFileSync(path.join(folder, name), '');
    }
    const begin = source.indexOf('function global:Find-AgentrixProgram');
    fs.writeFileSync(script, '\ufeff' + source.slice(begin, source.indexOf('$global:AgentrixCodexCommand', begin)) + `
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD'
$env:Path = ';"' + $env:FINDER_FIRST + '";' + $env:FINDER_SECOND + '\\;'
Write-Output (@('script', 'batch', 'bare', 'late', 'absent') | ForEach-Object { "$(Find-AgentrixProgram $_)" } | ConvertTo-Json -Compress)
`);
    const result = await exec(powershell(), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { env: { ...isolatedEnvironment(root), FINDER_FIRST: first, FINDER_SECOND: second }, windowsHide: true, timeout: 8000 * timeoutScale });
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout).map(found => found.toLowerCase()),
      [path.join(first, 'script.ps1'), path.join(first, 'batch.cmd'), path.join(first, 'bare'), path.join(second, 'late.exe'), ''].map(found => found.toLowerCase()),
      'a script before PATHEXT before the bare name, an earlier folder before a later one, quoted and empty entries read');
  });

for (const kind of ['bash', 'zsh']) {
  const shell = kind === 'bash' && process.env.AGENTRIX_TEST_BASH || (process.platform === 'win32' ? kind === 'bash' && 'C:/Program Files/Git/bin/bash.exe' : `/bin/${kind}`);
  // The wrapper alone, with a stand-in CLI that prints its arguments and exits with 7. PROBE_PROGRAM chooses what the
  // user's shell resolves codex to: the program, an alias with options, or nothing.
  async function typed(t, cases) {
    const root = fixture(t), wrapper = path.join(integration, kind === 'bash' ? 'bash-integration.bash' : 'zsh-integration.zsh');
    const probe = path.join(root, 'probe.sh'), cli = path.join(root, 'stand-in-codex'), words = kind === 'bash' ? '__pg_words' : 'reply';
    fs.writeFileSync(cli, '#!/bin/sh\nfor word in "$@"; do printf \'RAN=%s\\n\' "$word"; done\nprintf \'RAN_END\\n\'\nexit 7\n', { mode: 0o755 });
    fs.writeFileSync(probe, 'source "$PROBE_WRAPPER" zshrc >/dev/null\n' +
      `__pg_program() { case $PROBE_PROGRAM in program) ${words}=("$PROBE_CLI");; alias) ${words}=("$PROBE_CLI" --model alias-model);; *) return 1;; esac; }\n` +
      `__pg_send() { printf 'REQUEST=%s\\n' "$6"; }
while (( $# )); do
  PROBE_PROGRAM=$1
  remaining=$2
  shift 2
  probe_args=()
  for (( ; remaining > 0; remaining-- )); do probe_args+=("$1"); shift; done
  codex "\${probe_args[@]}"
  printf 'STATUS=%s\\nCASE_END\\n' "$?"
done
`);
    const shellPath = file => file.replace(/\\/g, '/');
    const flags = kind === 'bash' ? ['--noprofile', '--norc'] : ['-f'];
    const inputs = cases.flatMap(([program, args]) => [program, String(args.length), ...args]);
    const result = await exec(shell, [...flags, shellPath(probe), ...inputs],
      { cwd: root, env: { ...isolatedEnvironment(root), HOME: shellPath(root), MSYS2_ARG_CONV_EXCL: '*',
        PROBE_CLI: shellPath(cli), PROBE_WRAPPER: shellPath(wrapper),
        AGENTRIX_NODE: shellPath(process.execPath), AGENTRIX_EVENT_HELPER: shellPath(path.join(integration, 'agent-event.cjs')) },
      windowsHide: true, timeout: 50000 * timeoutScale });
    const missingManagement = cases.some(([program, args]) => program === 'absent' && args[0] === '--version');
    const diagnostic = 'Agentrix：在 PATH 中找不到 Codex CLI（退出码 127）。请安装后重开终端。';
    assert.equal(result.stderr.replace(/\r\n/g, '\n'), missingManagement ? diagnostic + '\n' : '');
    const results = result.stdout.split(/^CASE_END\r?\n/gm);
    assert.equal(results.pop(), '');
    assert.equal(results.length, cases.length);
    return results.map(stdout => {
      const lines = stdout.split(/\r?\n/), request = lines.find(line => line.startsWith('REQUEST='));
      return { stdout, status: Number(lines.find(line => line.startsWith('STATUS=')).slice(7)), request: request ? JSON.parse(request.slice(8)) : null,
        ran: lines.includes('RAN_END') ? lines.filter(line => line.startsWith('RAN=')).map(line => line.slice(4)) : null };
    });
  }
  const available = { skip: !shell || !fs.existsSync(shell), timeout: 60000 * timeoutScale };

  test(`${kind} wrapper includes alias options in its native request without executing the alias`, available, async t => {
    const cases = [argv, ['login']], results = await typed(t, cases.map(args => ['alias', args]));
    for (const [index, args] of cases.entries()) {
      const result = results[index];
      assert.deepEqual(result.request, ['--model', 'alias-model', ...args], 'an alias with options is no management run even before login');
      assert.equal(result.ran, null); assert.equal(result.status, 0);
    }
  });

  test(`${kind} wrapper requests native Codex for every conversation form and never runs the CLI`, available, async t => {
    const results = await typed(t, conversations.map(args => ['program', args]));
    for (const [index, args] of conversations.entries()) {
      const result = results[index];
      assert.deepEqual(result.request, args); assert.equal(result.ran, null, JSON.stringify(args));
      assert.equal(result.status, 0); assert.match(result.stdout, /原生模式/);
    }
  });

  test(`${kind} wrapper runs the Codex CLI's management commands in the terminal: exact argv, its exit status and no native request`, available, async t => {
    const results = await typed(t, [...managed.map(args => ['program', args]), ['absent', ['--version']], ['absent', ['resume', '--last']]]);
    for (const [index, args] of managed.entries()) {
      const result = results[index];
      assert.deepEqual(result.ran, args); assert.equal(result.status, 7, JSON.stringify(args));
      assert.equal(result.request, null); assert.doesNotMatch(result.stdout, /原生模式/);
    }
    // Not installed: said like Claude Code's wrapper says it, and a conversation is still the host's to open.
    const absent = results.at(-2);
    assert.doesNotMatch(absent.stdout, /Codex CLI/); // The error is checked on stderr.
    assert.equal(absent.status, 127); assert.equal(absent.request, null); assert.equal(absent.ran, null);
    assert.deepEqual(results.at(-1).request, ['resume', '--last']);
  });
}
