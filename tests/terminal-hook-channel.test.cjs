const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { proxyOf, terminalHooks, downgradeHooks } = require('../electron/features/terminal-events/hook-channel.cjs');
const { systemProxyEnvironment } = require('../electron/system-proxy.cjs');
const { createEventServer } = require('../electron/events.cjs');

const exec = promisify(execFile), root = path.join(__dirname, '..'), integration = path.join(root, 'integration');
const PORT = 4242, NAMES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy'];
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const bash = process.env.AGENTRIX_TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash');
const zsh = ['/bin/zsh', '/usr/bin/zsh'].find(file => process.platform !== 'win32' && fs.existsSync(file));

// The hook URL's proxy decision for one environment: which variable would carry the hooks, or null.
const cases = [
  [{}, null],
  [{ HTTP_PROXY: 'http://proxy:1' }, 'HTTP_PROXY'],
  [{ HTTPS_PROXY: 'http://proxy:1' }, 'HTTPS_PROXY'],
  [{ HTTPS_PROXY: 'http://proxy:1', HTTP_PROXY: 'http://proxy:2' }, 'HTTPS_PROXY'],
  // K0b item 5: the hook client ignores ALL_PROXY, so it alone keeps HTTP hooks.
  [{ ALL_PROXY: 'socks5h://proxy:1' }, null],
  [{ HTTP_PROXY: 'http://proxy:1', NO_PROXY: '127.0.0.1' }, null],
  // A name never matches an address, and [::1] is never exempt.
  [{ HTTP_PROXY: 'http://proxy:1', NO_PROXY: 'localhost' }, 'HTTP_PROXY'],
  [{ HTTP_PROXY: 'http://proxy:1', NO_PROXY: '::1,[::1]' }, 'HTTP_PROXY'],
  // system-proxy.cjs's adoption covers the hook URL.
  [{ HTTP_PROXY: 'http://proxy:1', NO_PROXY: 'localhost,127.0.0.1,::1' }, null],
  [{ HTTP_PROXY: 'http://proxy:1', NO_PROXY: 'localhost, 127.0.0.1' }, null],
  [{ HTTP_PROXY: 'http://proxy:1', NO_PROXY: '*' }, null],
  [{ HTTP_PROXY: 'http://proxy:1', NO_PROXY: `127.0.0.1:${PORT}` }, null],
  [{ HTTP_PROXY: 'http://proxy:1', NO_PROXY: '127.0.0.1:1' }, 'HTTP_PROXY'],
  [{ HTTP_PROXY: 'http://proxy:1', NO_PROXY: '.0.0.1' }, null],
  [{ HTTP_PROXY: 'http://proxy:1', NO_PROXY: '' }, 'HTTP_PROXY'],
  [{ HTTP_PROXY: 'http://proxy:1', NO_PROXY: ' , ' }, 'HTTP_PROXY'],
];
// Lower-case spellings are separate variables only outside Windows.
const posixCases = [
  [{ http_proxy: 'http://proxy:1' }, 'HTTP_PROXY'],
  [{ https_proxy: 'http://proxy:1', no_proxy: '127.0.0.1' }, null],
  [{ HTTP_PROXY: 'http://proxy:1', NO_PROXY: '127.0.0.1', no_proxy: 'localhost' }, 'HTTP_PROXY'],
  [{ HTTP_PROXY: 'http://proxy:1', NO_PROXY: 'localhost', no_proxy: '127.0.0.1' }, 'HTTP_PROXY'],
  [{ HTTP_PROXY: 'http://proxy:1', NO_PROXY: '127.0.0.1', no_proxy: '*' }, null],
];

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-hook-channel-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}
// The text of one shell function in a wrapper, from its first line to the closing brace at the start of a line.
function shellFunction(file, start) {
  const text = fs.readFileSync(path.join(integration, file), 'utf8').replace(/\r\n/g, '\n');
  const begin = text.indexOf(start);
  return text.slice(begin, text.indexOf('\n}\n', begin) + 3);
}
const shQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;
// Each case in a subshell of bash or zsh: only the case's variables are set, then the wrapper's rule answers.
async function posixAnswers(t, shell, file, list) {
  // A macOS login Bash may run under nounset; zsh's function sets its own options.
  const lines = [...(shell === zsh ? [] : ['set -u']), shellFunction(file, '__pg_hook_proxy() {'), `check() { if __pg_hook_proxy ${PORT}; then printf 'R=%s\\n' "$REPLY"; else printf 'R=\\n'; fi; }`];
  for (const [env] of list) lines.push(`( unset ${NAMES.join(' ')}; ${Object.entries(env).map(([name, value]) => `${name}=${shQuote(value)}`).join('; ')}${Object.keys(env).length ? '; ' : ''}check )`);
  const script = path.join(folder(t), 'probe.sh');
  fs.writeFileSync(script, lines.join('\n') + '\n');
  const { stdout } = await exec(shell, [...(shell === zsh ? ['-f'] : ['--noprofile', '--norc']), script.replace(/\\/g, '/')], { windowsHide: true });
  return [...stdout.matchAll(/^R=(.*)$/gm)].map(match => match[1] || null);
}
const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;

test('with a proxy and no loopback NO_PROXY entry the terminal keeps command hooks in PowerShell, bash and zsh alike, and says why', async t => {
  for (const [env, expected] of [...cases, ...posixCases]) assert.equal(proxyOf(env, PORT, 'linux'), expected, JSON.stringify(env));
  for (const [env, expected] of cases) assert.equal(proxyOf(env, PORT, 'win32'), expected, `win32 ${JSON.stringify(env)}`);
  assert.equal(proxyOf({ Http_Proxy: 'http://proxy:1', No_Proxy: 'localhost' }, PORT, 'win32'), 'HTTP_PROXY', 'Windows has one variable for every spelling');
  assert.equal(proxyOf({ Http_Proxy: 'http://proxy:1' }, PORT, 'linux'), null, 'elsewhere only the two spellings the CLI reads count');

  // The same rule in each wrapper, over its live environment.
  if (fs.existsSync(bash)) assert.deepEqual(await posixAnswers(t, bash, 'bash-integration.bash', [...cases, ...posixCases]), [...cases, ...posixCases].map(([, expected]) => expected), 'bash');
  if (zsh) assert.deepEqual(await posixAnswers(t, zsh, 'zsh-integration.zsh', [...cases, ...posixCases]), [...cases, ...posixCases].map(([, expected]) => expected), 'zsh');
  if (process.platform === 'win32') {
    const source = fs.readFileSync(path.join(integration, 'bootstrap.ps1'), 'utf8').replace(/\r\n/g, '\n');
    const begin = source.indexOf('function global:Get-AgentrixHookProxy');
    const lines = [source.slice(begin, source.indexOf('\n}\n', begin) + 3)];
    for (const [env] of cases) {
      lines.push(...NAMES.filter(name => name === name.toUpperCase()).map(name => `[Environment]::SetEnvironmentVariable('${name}', $null)`));
      lines.push(...Object.entries(env).map(([name, value]) => `[Environment]::SetEnvironmentVariable('${name}', ${psQuote(value)})`), `'R=' + (Get-AgentrixHookProxy ${PORT})`);
    }
    const { stdout } = await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(lines.join('\n'), 'utf16le').toString('base64')], { windowsHide: true });
    assert.deepEqual([...stdout.matchAll(/^R=(.*?)\r?$/gm)].map(match => match[1] || null), cases.map(([, expected]) => expected), 'PowerShell');
  }

  // Main decides at terminal start from the environment and Claude Code's settings env, and says why.
  const eventServer = { name: 'agentrix-pipe', address: '/tmp/agentrix.sock' }, shell = { posix: true, node: '/node', helper: '/agent-event.cjs', noteFile: '/note' };
  const settings = files => file => { if (Object.hasOwn(files, file)) return JSON.stringify({ env: files[file] }); throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  const decide = (env, platform, files = {}) => terminalHooks({ port: PORT, terminalId: 't', sessionKey: 'key', eventServer, env, cwd: '/project', shell, platform, home: '/home', read: settings(files) });
  const proxied = decide({ HTTP_PROXY: 'http://proxy:1', NO_PROXY: 'localhost' }, 'win32');
  assert.equal(proxied.channel, 'command-async', 'K0b proved async command hooks silent and out of the proxy on Windows');
  assert.deepEqual({ ...proxied.channelReason, observedAt: 0 }, { code: 'term.hooks_command_proxy', source: 'hook-channel', params: { variable: 'HTTP_PROXY', source: 'environment' }, observedAt: 0 });
  assert.equal(decide({ HTTP_PROXY: 'http://proxy:1' }, 'linux').channel, 'command', 'synchronous on POSIX until a capture covers bash and zsh');
  assert.equal(decide({ ALL_PROXY: 'socks5h://proxy:1' }, 'linux').channel, 'http');
  const project = decide({}, 'linux', { '/project/.claude/settings.json': { HTTPS_PROXY: 'http://proxy:1' } });
  assert.deepEqual([project.channel, project.channelReason.params], ['command', { variable: 'HTTPS_PROXY', source: 'project' }]);
  const managed = decide({}, 'win32', { 'C:\\Program Files\\ClaudeCode\\managed-settings.json': { https_proxy: 'http://proxy:1' } });
  assert.deepEqual(managed.channelReason.params, { variable: 'HTTPS_PROXY', source: 'managed' });
  assert.equal(decide({ HTTP_PROXY: 'http://proxy:1', CLAUDE_CONFIG_DIR: '/config' }, 'linux', { '/config/settings.json': { NO_PROXY: '127.0.0.1' } }).channel, 'http',
    'a NO_PROXY in the user settings exempts the hooks too');
  assert.equal(decide({ HTTP_PROXY: 'http://proxy:1' }, 'linux', { '/project/.claude/settings.local.json': { NO_PROXY: '*' } }).channel, 'http');
  const serverless = terminalHooks({ terminalId: 't', sessionKey: 'key', eventServer, env: {}, cwd: '/project', shell, platform: 'linux', home: '/home', read: settings({}) });
  assert.deepEqual([serverless.channel, serverless.channelReason.code, serverless.settings.http], ['command', 'term.hooks_down', null]);

  // A wrapper's report only ever moves a terminal to command hooks.
  const http = decide({}, 'win32');
  const fallen = downgradeHooks(http, 'HTTPS_PROXY');
  assert.deepEqual([fallen.channel, fallen.channelReason.source, fallen.channelReason.params], ['command-async', 'wrapper', { variable: 'HTTPS_PROXY', source: 'terminal' }]);
  assert.equal(downgradeHooks(proxied, 'HTTP_PROXY'), proxied);
  assert.equal(downgradeHooks(http, 'ALL_PROXY'), http);
  assert.equal(downgradeHooks(null, 'HTTP_PROXY'), null);
});

test('the PowerShell claude wrapper passes the HTTP settings, or with a proxy set since the start the fallback, and reports it, and with none passes no --settings', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const directory = folder(t);
  const hooks = terminalHooks({ port: PORT, terminalId: 't', sessionKey: 'key', eventServer: { name: 'agentrix-pipe' }, env: {}, cwd: directory,
    shell: { posix: false, powershellPath: powershell, script: path.join(integration, 'claude-hook.ps1') }, platform: 'win32', home: directory, read: () => '{}' });
  const source = fs.readFileSync(path.join(integration, 'bootstrap.ps1'), 'utf8');
  const wrapper = source.slice(source.indexOf('function global:Get-AgentrixHookProxy'), source.indexOf('if ($global:AgentrixAgentOnly)'));
  const script = `$ProgressPreference = 'SilentlyContinue'
${wrapper}
function global:Get-AgentrixReadingNote {}
function global:Get-AgentrixCommand {}
$global:sent = @()
function global:Send-AgentrixEvent { param([string]$Type, [int]$ExitCode = 0, [string]$Agent = 'codex', [string]$Command = '') $global:sent += "$Type|$Command" }
$global:AgentrixSession = @{ hooks = (${psQuote(JSON.stringify(hooks))} | ConvertFrom-Json) }
$global:AgentrixClaudeExecutable = $null
$global:AgentrixClaudeCommand = { if ($args[0] -eq '--settings') { [IO.File]::ReadAllText($args[1]) } else { 'none:' + ($args -join ' ') } }
foreach ($name in @('HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY')) { [Environment]::SetEnvironmentVariable($name, $null) }
$plain = claude
$env:HTTP_PROXY = 'http://proxy:1'
$proxied = claude
$global:AgentrixSession.hooks.settings.fallback = ''
$bare = claude hello
@{ plain = $plain; proxied = $proxied; bare = $bare; sent = $global:sent } | ConvertTo-Json -Compress`;
  const probe = path.join(folder(t), 'probe.ps1');
  fs.writeFileSync(probe, script);
  const { stdout } = await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe],
    { windowsHide: true, env: { ...process.env, AGENTRIX_BOOTSTRAP: path.join(directory, 'session.json') } });
  const result = JSON.parse(stdout);
  assert.equal(result.plain, hooks.settings.http);
  assert.equal(result.proxied, hooks.settings.fallback);
  assert.equal(result.bare, 'none:hello', 'an empty settings value is no --settings and no empty file');
  assert.deepEqual(result.sent, ['codex-started|', 'codex-exited|', 'hook-channel|HTTP_PROXY', 'codex-started|', 'codex-exited|', 'hook-channel|HTTP_PROXY', 'codex-started|', 'codex-exited|']);
  assert.deepEqual(fs.readdirSync(directory), [], 'each launch removes its settings file');
});

for (const [kind, shell, file] of [['bash', bash, 'bash-integration.bash'], ['zsh', zsh, 'zsh-integration.zsh']]) {
  test(`the ${kind} claude wrapper passes the HTTP settings, or with a proxy set since the start the fallback, and reports it, and with none passes no --settings`, { skip: process.platform === 'win32' || !shell || !fs.existsSync(shell), timeout: 60000 }, async t => {
    const directory = folder(t), bin = path.join(directory, 'bin'), home = path.join(directory, 'home'), capture = path.join(directory, 'capture');
    for (const name of [bin, home, capture]) fs.mkdirSync(name);
    // zsh writes its reports from a subshell, so the report is awaited as an event, not after the shell exits.
    let reported;
    const report = new Promise(resolve => { reported = resolve; });
    const server = await createEventServer(event => { if (event.type === 'hook-channel') reported(event); });
    t.after(() => server.close());
    const fake = path.join(directory, 'fake.cjs');
    fs.writeFileSync(fake, `const fs = require('node:fs'), args = process.argv.slice(2); fs.writeFileSync(require('node:path').join(process.env.CAPTURE, String(fs.readdirSync(process.env.CAPTURE).length)), args.includes('--settings') ? fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8') : 'none:' + args.join(' '));`);
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(fake)} "$@"\n`, { mode: 0o755 });
    const hooks = terminalHooks({ port: PORT, terminalId: 'project', sessionKey: 'key', eventServer: server, env: {}, cwd: directory,
      shell: { posix: true, node: process.execPath, helper: path.join(integration, 'agent-event.cjs'), noteFile: '' }, platform: process.platform, home, read: () => '{}' });
    const env = { HOME: home, ZDOTDIR: home, AGENTRIX_USER_ZDOTDIR: home, PATH: `${bin}:/usr/bin:/bin`, CAPTURE: capture, TMPDIR: directory,
      AGENTRIX_SOCKET: server.address, AGENTRIX_PROJECT_ID: 'project', AGENTRIX_SESSION_KEY: 'key', AGENTRIX_NODE: process.execPath, AGENTRIX_EVENT_HELPER: path.join(integration, 'agent-event.cjs'),
      AGENTRIX_HOOK_PORT: String(PORT), AGENTRIX_HOOK_CHANNEL: hooks.channel, AGENTRIX_HOOK_SETTINGS: hooks.settings.http, AGENTRIX_HOOK_FALLBACK: hooks.settings.fallback };
    await new Promise((resolve, reject) => {
      const child = spawn(shell, ['-c', 'source "$1" zshrc; claude; export HTTP_PROXY=http://proxy:1; claude; __pg_hook_fallback=; claude hello', '_', path.join(integration, file)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let errors = ''; child.stderr.on('data', bytes => { errors += bytes; }); child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(errors)));
    });
    assert.deepEqual([0, 1, 2].map(index => fs.readFileSync(path.join(capture, String(index)), 'utf8')), [hooks.settings.http, hooks.settings.fallback, 'none:hello']);
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('-claude-settings-')), [], 'no settings file is left, and none was written empty');
    const event = await report;
    assert.deepEqual([event.command, event.agent, event.sessionKey], ['HTTP_PROXY', 'claude', 'key']);
  });
}

test('when NO_PROXY and no_proxy differ, 127.0.0.1 is exempt only if both exempt it', () => {
  for (const [env, expected] of posixCases.slice(2)) assert.equal(proxyOf(env, PORT, 'linux'), expected, JSON.stringify(env));
  assert.equal(proxyOf({ HTTP_PROXY: 'http://proxy:1', NO_PROXY: '127.0.0.1', no_proxy: '' }, PORT, 'linux'), null, 'an empty one is not set');
});

test("Agentrix adds no NO_PROXY entry anywhere but system-proxy.cjs's adoption, which is unchanged", () => {
  const writes = /\bno_proxy\b['"\]]*\s*(?:=(?![=~])|:(?!:))|SetEnvironmentVariable\(\s*['"]no_proxy|export\s+no_proxy/i;
  const offenders = [];
  const walk = folderName => {
    for (const entry of fs.readdirSync(path.join(root, folderName), { withFileTypes: true })) {
      const relative = `${folderName}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(relative); continue; }
      if (!/\.(?:cjs|mjs|js|ts|tsx|ps1|bash|zsh|sh|cmd|py)$/.test(entry.name) || relative === 'electron/system-proxy.cjs') continue;
      if (writes.test(fs.readFileSync(path.join(root, relative), 'utf8'))) offenders.push(relative);
    }
  };
  for (const top of ['electron', 'integration', 'src']) walk(top);
  assert.deepEqual(offenders, []);
  // The adoption still writes the loopback names it always wrote, and only when the user set none.
  const adopted = systemProxyEnvironment({}, ['PROXY 127.0.0.1:7897']);
  assert.deepEqual([adopted.NO_PROXY, adopted.no_proxy], ['localhost,127.0.0.1,::1', 'localhost,127.0.0.1,::1']);
  assert.equal(proxyOf(adopted, PORT, 'linux'), null, 'which keeps the hooks on HTTP');
  assert.equal(systemProxyEnvironment({ NO_PROXY: 'corp' }, ['PROXY 127.0.0.1:7897']).NO_PROXY, undefined);
});
