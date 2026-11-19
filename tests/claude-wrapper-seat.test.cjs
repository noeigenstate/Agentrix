const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

function wrapper(file, start) {
  const source = fs.readFileSync(path.join(__dirname, '../integration', file), 'utf8');
  const begin = source.indexOf(start), end = source.indexOf('\n}', begin);
  assert.ok(begin >= 0 && end > begin);
  return source.slice(begin, end + 2);
}

function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-wrapper-seat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const win = process.platform === 'win32';
const refusal = /模型由模型路由决定，请在模型路由中更改。/;
const resumed = ['--model', 'claude-opus-5-5', '--effort', 'high', '--resume', 'fixture-session'];
const utilities = [['mcp', 'list'], ['update'], ['doctor'], ['config', 'list'], ['--settings', 'owner-settings', 'mcp', 'list'],
  ['--debug', 'api', 'mcp', 'list'], ['--version'], ['-v'], ['--help'], ['-h'], ['--resume', '--help']];
const invalidSeats = [['claude-opus&extra', 'high'], ['m'.repeat(161), 'high'], ['opus', 'High'], ['opus', 'e'.repeat(33)]];
const nextModel = 'claude-sonnet-5-5[1m]';
const cases = [
  ['bash-integration.bash', 'claude() {', /--model\|--model=\*\|--effort\|--effort=\*/],
  ['zsh-integration.zsh', 'claude() {', /--model\|--model=\*\|--effort\|--effort=\*/],
  ['bootstrap.ps1', 'function global:claude {', /--\(\?:model\|effort\)/],
];

test('the local Claude wrappers read the lead file and refuse overrides before reporting launch', () => {
  for (const [file, start, flags] of cases) {
    const body = wrapper(file, start);
    assert.match(body, /\.lead/);
    assert.match(body, refusal);
    assert.ok(body.search(flags) >= 0 && body.search(flags) < body.indexOf('codex-started'), file);
  }
});

function assertLaunches(output) {
  assert.deepEqual(output.match(/^STATUS=2$/gm), ['STATUS=2', 'STATUS=2']);
  const calls = output.split(/^EVENT=codex-started\n/gm).slice(1);
  assert.deepEqual(calls.map(call => [...call.matchAll(/^SETTINGS=(.*)$/gm)].map(row => row[1])),
    [['fast'], ...utilities.concat(invalidSeats).map(() => ['ordinary']), ['ordinary']]);
  assert.deepEqual(calls.map(call => [...call.matchAll(/^WORD=(.*)$/gm)].map(row => row[1])),
    [resumed, ...utilities, ...invalidSeats.map(() => []), ['--model', nextModel, '--effort', 'medium', 'Explain', 'doctor']]);
}

for (const [name, file] of [['bash', 'bash-integration.bash'], ['zsh', 'zsh-integration.zsh']]) {
  const shell = ['/bin', '/usr/bin'].map(dir => path.join(dir, name)).find(file => !win && fs.existsSync(file));
  test(`${name} Claude takes the validated seat only on conversation launches`, { skip: !shell }, async t => {
    const dir = profile(t), fake = path.join(dir, 'stand-in.sh'), script = path.join(dir, 'probe.sh');
    fs.writeFileSync(fake, '#!/bin/sh\nprintf "SETTINGS=%s\\n" "$(cat "$2")"\nshift 2\nfor word in "$@"; do printf "WORD=%s\\n" "$word"; done\n', { mode: 0o700 });
    fs.writeFileSync(script, [
      wrapper(file, 'claude() {'),
      `__pg_program() { ${name === 'zsh' ? 'reply' : '__pg_words'}=("$AGENTRIX_SEAT_STAND_IN"); }`,
      '__pg_send() { printf "EVENT=%s\\n" "$1"; }',
      '__pg_command() { :; }',
      '__pg_reading_note() { :; }',
      '__pg_hook_fallback=ordinary',
      '__pg_fast_hook_fallback=fast',
      'printf "claude-opus-5-5\\nhigh\\n1\\n" > "$AGENTRIX_BOOTSTRAP.lead"',
      'claude --model=manual; printf "STATUS=%s\\n" "$?"',
      'claude --effort low; printf "STATUS=%s\\n" "$?"',
      'claude --resume fixture-session',
      ...utilities.map(words => `claude ${words.join(' ')}`),
      ...invalidSeats.flatMap(([model, effort]) => [`printf '%s\\n' '${model}' '${effort}' 1 > "$AGENTRIX_BOOTSTRAP.lead"`, 'claude']),
      `printf '%s\\n' '${nextModel}' medium 0 > "$AGENTRIX_BOOTSTRAP.lead"`,
      'claude Explain doctor',
    ].join('\n') + '\n');
    const { stdout, stderr } = await exec(shell, [...(name === 'zsh' ? ['-f'] : ['--noprofile', '--norc']), script], {
      env: { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, AGENTRIX_SEAT_STAND_IN: fake, AGENTRIX_BOOTSTRAP: path.join(dir, 'bootstrap') },
    });
    assert.match(stderr, refusal);
    assertLaunches(stdout);
  });
}

test('PowerShell Claude takes the validated seat only on conversation launches', { skip: !win }, async t => {
  const dir = profile(t), script = path.join(dir, 'probe.ps1');
  fs.writeFileSync(script, '\uFEFF' + [
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$ErrorActionPreference = "Stop"',
    wrapper('bootstrap.ps1', 'function global:claude {'),
    'function Send-AgentrixEvent { Write-Output ("EVENT=" + $args[0]) }',
    'function Get-AgentrixCommand {}',
    'function Get-AgentrixReadingNote {}',
    'function Set-AgentrixPlanner {}',
    'function Restore-AgentrixEnvironment {}',
    '$global:AgentrixSession = @{ hooks = @{ settings = @{ fallback = "ordinary" }; fastSettings = @{ fallback = "fast" } } }',
    '$global:AgentrixClaudeExecutable = $null',
    '$global:AgentrixClaudeCommand = {',
    '  "SETTINGS=" + [IO.File]::ReadAllText($args[1])',
    '  if ($args.Length -gt 2) { $args[2..($args.Length - 1)] | ForEach-Object { "WORD=" + $_ } }',
    '  $global:LASTEXITCODE = 0',
    '}',
    '$lead = $env:AGENTRIX_BOOTSTRAP + ".lead"',
    '[IO.File]::WriteAllLines($lead, @("claude-opus-5-5", "high", "1"))',
    'claude --model=manual; "STATUS=" + $LASTEXITCODE',
    'claude --effort low; "STATUS=" + $LASTEXITCODE',
    'claude --resume fixture-session',
    ...utilities.map(words => `claude ${words.join(' ')}`),
    ...invalidSeats.flatMap(([model, effort]) => [`[IO.File]::WriteAllLines($lead, @('${model}', '${effort}', '1'))`, 'claude']),
    `[IO.File]::WriteAllLines($lead, @('${nextModel}', 'medium', '0'))`,
    'claude Explain doctor',
  ].join('\n'));
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await exec(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    env: { ...process.env, AGENTRIX_BOOTSTRAP: path.join(dir, 'bootstrap'), AGENTRIX_READING_NOTE_FILE: '' },
  });
  const output = stdout.replaceAll('\r\n', '\n');
  assert.match(output, refusal);
  assertLaunches(output);
});
