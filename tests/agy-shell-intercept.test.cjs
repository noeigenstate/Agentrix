const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { timeoutScale } = require('../scripts/wait.mjs');
const { createEventServer } = require('../electron/events.cjs');
const { findShell } = require('../electron/zsh-terminal.cjs');
const { shellEvent } = require('../integration/agent-event.cjs');
const { intercept, terminalLaunch } = require('../integration/shims/intercept.cjs');
const { adapterOf } = require('../electron/features/cli-adapters/registry.cjs');
const { dispatchEnvironment } = require('./fixtures/team-isolation.cjs');

const integration = path.resolve(__dirname, '../integration');
const windows = process.platform === 'win32';
const system = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
const powershell = path.join(system, 'WindowsPowerShell/v1.0/powershell.exe');
const exec = promisify(execFile);
const posix = file => windows ? file.replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()).replaceAll('\\', '/') : file;
const commands = [['--version'], ['-h'], ['help'], ['-p', 'two words'], ['acp'], ['mcp', 'list']];
const shellCommands = windows ? [commands[0], commands[3]] : commands;
const lines = shellCommands.map(words => ['agy', ...words.map(word => /\s/.test(word) ? JSON.stringify(word) : word)].join(' '));
const commandTimeout = (windows ? 60000 : 24000) * timeoutScale;
const shellTimeout = (windows ? 90000 : 30000) * timeoutScale;

async function shellFixture(t) {
  const folder = await fs.mkdtemp(path.join(__dirname, '.agy-shell-'));
  const events = [], server = await createEventServer(event => events.push(event));
  t.after(async () => {
    await server.close();
    await fs.rm(folder, { recursive: true, force: true, maxRetries: 5 });
  });
  const bootstrap = path.join(folder, 'bootstrap.json'), record = path.join(folder, 'argv.jsonl');
  await fs.writeFile(bootstrap, JSON.stringify({
    projectPath: folder, projectId: 'project', sessionKey: 'key', pipeName: server.name, nodePath: process.execPath,
  }));
  const env = {
    ...Object.fromEntries(Object.entries(dispatchEnvironment()).filter(([key]) => key.toUpperCase() !== 'PATH')),
    AGENTRIX_BOOTSTRAP: bootstrap, AGENTRIX_NODE: process.execPath, AGENTRIX_SOCKET: server.address, AGENTRIX_PROJECT_ID: 'project',
    AGENTRIX_SESSION_KEY: 'key', ARGV_RECORDER_FILE: record, PSModuleAnalysisCachePath: path.join(folder, 'module-cache'),
    HOME: folder, ZDOTDIR: folder, BASH_ENV: '',
  };
  return { folder, env, events, record };
}

async function verifyLaunch({ folder, events, record }, expected = shellCommands) {
  const requests = events.filter(event => event.type === 'agent-started');
  assert.equal(requests.length, 1, JSON.stringify(events));
  const [event] = requests;
  assert.deepEqual([event.agent, event.args, event.projectId, event.sessionKey], ['agy', [], 'project', 'key']);
  assert.equal(await fs.realpath(event.cwd), await fs.realpath(folder));
  assert.equal(events.some(event => event.type === 'agent-exited'), false);
  const rows = (await fs.readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line).args);
  assert.deepEqual(rows, expected);
}

for (const kind of ['bash', 'zsh']) {
  const shell = kind === 'bash'
    ? process.env.AGENTRIX_TEST_BASH || (windows ? 'C:/Program Files/Git/bin/bash.exe' : findShell(kind))
    : process.env.AGENTRIX_TEST_ZSH || (windows ? null : findShell(kind));
  test(`${kind} redirects bare agy and sends other commands to the installed CLI`, { timeout: shellTimeout }, async t => {
    if (!shell || !(await fs.stat(shell).catch(() => null))) return t.skip(`${kind} is unavailable`);
    const fixture = await shellFixture(t), { folder, env } = fixture;
    const executable = path.join(folder, 'agy'), recorder = path.join(folder, 'record.cjs');
    await fs.writeFile(executable, '#!/bin/sh\nexec "$AGENTRIX_TEST_NODE" "$AGENTRIX_TEST_RECORDER" "$@"\n', { mode: 0o755 });
    await fs.writeFile(recorder, 'require("node:fs").appendFileSync(process.env.ARGV_RECORDER_FILE, JSON.stringify({args:process.argv.slice(2)})+"\\n"); process.exitCode=7;\n');
    Object.assign(env, {
      AGENTRIX_NODE: posix(process.execPath), AGENTRIX_EVENT_HELPER: posix(path.join(integration, 'agent-event.cjs')),
      AGENTRIX_TEST_NODE: posix(process.execPath), AGENTRIX_TEST_RECORDER: posix(recorder), HOME: posix(folder), ZDOTDIR: posix(folder),
      TMPPREFIX: posix(path.join(folder, 'zsh')),
      PATH: [folder, ...(windows ? [path.dirname(shell)] : ['/usr/bin', '/bin'])].join(path.delimiter),
    });
    const wrapper = `source "$1"${kind === 'zsh' ? ' zshrc' : ''}`;
    const checked = lines.map(line => `${line}; code=$?; [[ $code == 7 ]] || { printf '%s: exit %s\\n' ${JSON.stringify(line)} "$code" >&2; exit 1; }`);
    const script = [wrapper, 'agy || exit', ...checked].join('\n');
    const opts = kind === 'bash' ? ['--noprofile', '--norc'] : ['-f'];
    const run = script => exec(shell, [...opts, '-c', script, kind, posix(path.join(integration, `${kind}-integration.${kind}`))],
      { cwd: folder, env, timeout: commandTimeout, windowsHide: true, signal: t.signal });
    await run(script);
    await run(`alias agy='agy ""'\n${wrapper}\nagy; [[ $? == 7 ]]`);
    await fs.rm(executable);
    await run(wrapper + '\nagy; [[ $? == 127 ]]');
    await verifyLaunch(fixture, [...shellCommands, ['']]);
  });
}

async function windowsFixture(t) {
  const fixture = await shellFixture(t), { folder, env } = fixture;
  for (const name of ['bootstrap.ps1', 'bootstrap.cmd', 'agent.ps1']) await fs.copyFile(path.join(integration, name), path.join(folder, name));
  await fs.writeFile(path.join(folder, 'refresh-path.ps1'), '');
  await fs.writeFile(path.join(folder, 'print-path.ps1'), '$env:Path\n');
  env.AGENTRIX_AGY_EXECUTABLE = path.join(folder, 'agy.exe');
  env.PATH = [path.dirname(powershell), system].join(path.delimiter);
  await exec(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', `/out:${env.AGENTRIX_AGY_EXECUTABLE}`, path.join(__dirname, 'fixtures/argv-recorder.cs')], { windowsHide: true });
  await fs.writeFile(env.AGENTRIX_BOOTSTRAP, JSON.stringify({ ...JSON.parse(await fs.readFile(env.AGENTRIX_BOOTSTRAP, 'utf8')), shims: path.join(integration, 'shims') }));
  return fixture;
}

test('PowerShell redirects bare agy and sends other commands to the installed CLI', { skip: !windows, timeout: shellTimeout }, async t => {
  const fixture = await windowsFixture(t), { folder, env } = fixture;
  const file = path.join(folder, 'terminal.ps1');
  await fs.writeFile(file, ['. "$PSScriptRoot/bootstrap.ps1"', 'agy; if ($LASTEXITCODE -ne 0) { exit 1 }',
    ...lines.map(line => `${line}; if ($LASTEXITCODE -ne 7) { exit 1 }`),
    '$global:AgentrixAgyCommand = $null', 'agy; if ($LASTEXITCODE -ne 127) { exit 1 }'].join('\r\n'));
  await exec(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { cwd: folder, env, timeout: commandTimeout, windowsHide: true, signal: t.signal });
  await verifyLaunch(fixture);
});

test('cmd redirects typed agy through its DOSKEY macro and passes other commands through', { skip: !windows, timeout: shellTimeout }, async t => {
  const fixture = await windowsFixture(t), { folder, env } = fixture;
  const peer = path.join(__dirname, 'fixtures/cmd-terminal-peer.cjs');
  const checked = ['agy', 'if not "%errorlevel%"=="0" exit 20', ...lines.flatMap(line => [line, 'if not "%errorlevel%"=="7" exit 21'])];
  await exec(process.execPath, [peer, path.join(system, 'cmd.exe'), path.join(folder, 'bootstrap.cmd'), ...checked],
    { cwd: folder, env, timeout: commandTimeout, windowsHide: true, signal: t.signal });
  await verifyLaunch(fixture);
});

test('the agy PATH shim follows manifest utilities and skips Agentrix launcher folders', async t => {
  const { folder, env } = await shellFixture(t), marked = path.join(folder, 'shims'), installed = path.join(folder, 'bin');
  await fs.mkdir(marked); await fs.mkdir(installed);
  const name = windows ? 'agy.exe' : 'agy', cli = path.join(installed, name), shim = path.join(marked, name);
  await fs.writeFile(path.join(marked, '.agentrix-shims'), '');
  for (const file of [cli, shim]) await fs.writeFile(file, '', { mode: 0o755 });
  env.PATH = [marked, installed].join(path.delimiter);
  env.AGENTRIX_AGY_EXECUTABLE = shim;
  const launches = [], diagnostics = [], stderr = { write: message => diagnostics.push(message) };
  const launch = (file, args) => {
    launches.push({ file, args });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 7));
    return child;
  };
  const utilities = adapterOf('agy').manifest.words.utilities;
  for (const utility of utilities) assert.equal(await intercept(['agy', '--', utility], { env, launch, stderr }), 7);
  for (const args of [[], ['-p', 'task'], ['acp']]) assert.equal(await intercept(['agy', '--', ...args], { env, launch, stderr }), 2);
  const planner = { ...env, AGENTRIX_DISPATCH_DEPTH: '0' };
  for (const args of commands) assert.equal(await intercept(['agy', '--', ...args], { env: planner, launch, stderr }), 7);
  assert.equal(await intercept(['agy', '--'], { env: planner, launch, stderr }), 2);
  await fs.writeFile(env.AGENTRIX_BOOTSTRAP + '.mode', 'conductor');
  for (const utility of utilities) assert.equal(await intercept(['agy', '--', utility], { env: planner, launch, stderr }), 7);
  for (const args of commands.filter(([word]) => !utilities.includes(word))) {
    assert.equal(await intercept(['agy', '--', ...args], { env: planner, launch, stderr }), 2);
    assert.match(diagnostics.at(-1), /start_role/);
  }
  assert.deepEqual(launches, [...utilities.map(word => [word]), ...commands, ...utilities.map(word => [word])].map(args => ({ file: cli, args })));
});

test('the shell classifier and the native launch use the same bare agy rule', () => {
  const { terminal } = adapterOf('agy');
  const classify = (args, env = {}) => terminalLaunch(env, 'agy', 'classify', 'native', args, undefined, true);
  assert.equal(classify([]), 'native');
  assert.deepEqual(terminal.launch([]), { resume: false });
  for (const args of [...commands, ['resume'], ['--resume'], ['prompt'], ['']]) {
    assert.equal(classify(args), 'passthrough');
    assert.equal(terminal.classify(args), 'passthrough');
    assert.throws(() => terminal.launch(args), /agy/);
  }
  assert.equal(classify([], { AGENTRIX_LAUNCH_ALIAS: '-p' }), 'passthrough');
  assert.equal(classify([], { AGENTRIX_LAUNCH_ALIAS: '', AGENTRIX_LAUNCH_HAS_ALIAS_ARGUMENT: '1' }), 'passthrough');
  assert.equal(terminal.classify([], { alias: '-p' }), 'passthrough');
});

test('the shell event keeps agy and its arguments and refuses unknown agents', () => {
  const report = agent => shellEvent(['v=1', 'type=agent-started', 'sequence=1', `agent=${agent}`, 'args=[]'], 'project', 'key');
  assert.deepEqual([report('agy').agent, report('agy').args, report('agy').accountLaunch], ['agy', [], undefined]);
  assert.equal(report('codex').accountLaunch, 'unavailable');
  assert.equal(report('unregistered'), null);
});
