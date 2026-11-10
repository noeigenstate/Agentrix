const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFile } = require('node:child_process'), { promisify } = require('node:util');
const { createEventServer } = require('../electron/events.cjs');
const { isolatedEnvironment } = require('../scripts/native-approval-probe.cjs');
const { timeoutScale } = require('../scripts/wait.mjs');
const exec = promisify(execFile), integration = path.resolve(__dirname, '../integration');
const argv = ['resume', '11111111-1111-4111-8111-111111111111', '-m', 'fixture', '中文 "quotes" \\ end'];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-wrapper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('PowerShell native wrapper preserves empty and quoted argv and returns without an executable',
  { skip: process.platform !== 'win32', timeout: 15000 * timeoutScale }, async t => {
    const root = fixture(t), script = path.join(root, 'wrapper.ps1');
    const source = fs.readFileSync(path.join(integration, 'bootstrap.ps1'), 'utf8');
    const begin = source.indexOf('function global:codex {');
    // Windows PowerShell writes stdout in the console's code page (437 on an English system, 936 on a Chinese one), which
    // cannot carry every argument: the request leaves as base64 of its UTF-8 JSON.
    fs.writeFileSync(script, '\ufeff' + source.slice(begin, source.indexOf('\n# Claude Code reports each turn', begin)) + `
function global:Send-AgentrixEvent {
    param($Type, [string[]]$Arguments)
    $request = @{ type=$Type; args=@($Arguments) } | ConvertTo-Json -Compress
    Write-Output ('REQUEST=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($request)))
}
$values=ConvertFrom-Json $env:WRAPPER_ARGS
codex @values
Write-Output 'SHELL_RETURNED'
`);
    for (const args of [[], argv]) {
      const result = await exec(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
        { env: { ...isolatedEnvironment(root), WRAPPER_ARGS: JSON.stringify(args) }, windowsHide: true, timeout: 5000 * timeoutScale });
      assert.equal(result.stderr, ''); assert.match(result.stdout, /SHELL_RETURNED/);
      const request = result.stdout.split(/\r?\n/).find(line => line.startsWith('REQUEST=')).slice(8);
      assert.deepEqual(JSON.parse(Buffer.from(request, 'base64').toString()), { type: 'codex-started', args });
    }
  });

test('PowerShell and the cmd shim request native Codex, preserve argv, return to the shell and never run its executable',
  { skip: process.platform !== 'win32', timeout: 30000 * timeoutScale }, async t => {
    const root = fixture(t), marker = path.join(root, 'executed'), events = [], server = await createEventServer(event => events.push(event));
    t.after(() => server.close());
    fs.writeFileSync(path.join(root, 'codex.cmd'), '@echo off\r\necho EXTERNAL_ONLY>"%WRAPPER_MARKER%"\r\n');
    const bootstrap = path.join(root, 'bootstrap.json');
    fs.writeFileSync(bootstrap, JSON.stringify({ projectPath: root, projectId: 't', sessionKey: 'key', pipeName: server.name }));
    const env = { ...isolatedEnvironment(root), AGENTRIX_BOOTSTRAP: bootstrap, WRAPPER_MARKER: marker,
      PATH: root + path.delimiter + process.env.PATH, PSModuleAnalysisCachePath: path.join(root, 'module-cache') };
    delete env.Path;
    const script = path.join(root, 'probe.ps1');
    fs.writeFileSync(script, `$env:AGENTRIX_AGENT_ONLY='1'\n. '${integration.replace(/'/g, "''")}\\bootstrap.ps1'\n$values=ConvertFrom-Json $env:WRAPPER_ARGS\ncodex @values\nWrite-Output 'SHELL_RETURNED'\n`);
    const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    for (const args of [[], argv, ['--profile', 'other']]) {
      const result = await exec(shell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
        { cwd: root, env: { ...env, WRAPPER_ARGS: JSON.stringify(args) }, windowsHide: true, timeout: 8000 * timeoutScale });
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /SHELL_RETURNED/); assert.match(result.stdout, /原生模式/);
      assert.equal(fs.existsSync(marker), false);
      assert.deepEqual(events.filter(event => event.type === 'codex-started').at(-1)?.args, args, JSON.stringify(events));
    }
    await exec(shell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(integration, 'agent.ps1'), 'codex', ...argv],
      { cwd: root, env, windowsHide: true, timeout: 8000 * timeoutScale });
    assert.deepEqual(events.filter(event => event.type === 'codex-started').at(-1).args, argv);
    assert.equal(events.some(event => event.type === 'codex-exited'), false, 'no terminal Codex invocation or fabricated completion');
    assert.equal(fs.existsSync(marker), false);
    await exec(process.env.ComSpec, ['/d', '/c', 'codex'], { cwd: root, env, windowsHide: true });
    assert.equal(fs.existsSync(marker), true, 'outside an injected shell the executable is unchanged');
  });

for (const kind of ['bash', 'zsh']) {
  const shell = kind === 'bash' && process.env.AGENTRIX_TEST_BASH || (process.platform === 'win32' ? kind === 'bash' && 'C:/Program Files/Git/bin/bash.exe' : `/bin/${kind}`);
  test(`${kind} wrapper includes alias options in its native request without executing the alias`,
    { skip: !shell || !fs.existsSync(shell), timeout: 15000 * timeoutScale }, async t => {
      const root = fixture(t), source = fs.readFileSync(path.join(integration, kind === 'bash' ? 'bash-integration.bash' : 'zsh-integration.zsh'), 'utf8').replace(/\r\n/g, '\n');
      const wrapper = source.slice(source.indexOf('codex() {'), source.indexOf('\n# Claude Code reports each turn', source.indexOf('codex() {')));
      const jsonStart = source.indexOf('__pg_json() {'), jsonEnd = source.indexOf('\n}', jsonStart) + 2;
      const probe = path.join(root, 'probe.sh');
      fs.writeFileSync(probe, `${source.slice(jsonStart, jsonEnd)}\n${wrapper}\n` +
        `__pg_program() { ${kind === 'bash' ? '__pg_words' : 'reply'}=(/never/executed --model alias-model); }\n` +
        `__pg_send() { printf 'REQUEST=%s\\n' "$6"; }\ncodex "$@"\nprintf 'SHELL_RETURNED\\n'\n`);
      const result = await exec(shell, [kind === 'bash' ? '--noprofile' : '-f', ...(kind === 'bash' ? ['--norc'] : []), probe.replace(/\\/g, '/'), ...argv],
        { cwd: root, windowsHide: true, timeout: 10000 * timeoutScale });
      assert.match(result.stdout, /SHELL_RETURNED/);
      assert.deepEqual(JSON.parse(result.stdout.split(/\r?\n/).find(line => line.startsWith('REQUEST=')).slice(8)), ['--model', 'alias-model', ...argv]);
    });
}
