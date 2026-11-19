const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const integration = path.resolve(__dirname, '../integration');

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
const background = 'claude-opus-5-5', subagent = 'claude-sonnet-5-5[1m]';
const operationCases = [
  [[background, subagent, 'ANTHROPIC_BASE_URL=unexpected'], [background, subagent]],
  [['', subagent], ['inherited', subagent]],
  [['unsafe&word', subagent], ['inherited', subagent]],
  [[background, 'm'.repeat(161)], [background, 'unset']],
];
const cases = [
  ['bash-integration.bash', 'claude() {', /--model\|--model=\*\|--effort\|--effort=\*/],
  ['zsh-integration.zsh', 'claude() {', /--model\|--model=\*\|--effort\|--effort=\*/],
  ['bootstrap.ps1', 'function global:claude {', /--\(\?:model\|effort\)/],
];

test('the local Claude wrappers read the lead file and refuse overrides before reporting launch', () => {
  for (const [file, start, flags] of cases) {
    const source = fs.readFileSync(path.join(integration, file), 'utf8');
    const begin = source.indexOf(start);
    const wrapper = source.slice(begin);
    assert.ok(begin >= 0, file);
    assert.match(source, /\.lead/);
    assert.match(wrapper, refusal);
    assert.ok(wrapper.search(flags) >= 0 && wrapper.search(flags) < wrapper.indexOf('codex-started'), file);
  }
});

function assertLaunches(output) {
  assert.deepEqual(output.match(/^STATUS=2$/gm), ['STATUS=2', 'STATUS=2']);
  const calls = output.split(/^CALL\n/gm).slice(1);
  assert.deepEqual(calls.map(call => [...call.matchAll(/^SETTINGS=(.*)$/gm)].map(row => row[1])),
    [['fast'], ...utilities.concat(invalidSeats).map(() => ['ordinary']), ['ordinary'], ...operationCases.map(() => ['ordinary']), ['ordinary']]);
  assert.deepEqual(calls.map(call => [...call.matchAll(/^WORD=(.*)$/gm)].map(row => row[1])),
    [resumed, ...utilities, ...invalidSeats.map(() => []), ['--model', nextModel, '--effort', 'medium', 'Explain', 'doctor'],
      ...operationCases.map(() => ['--model', nextModel, '--effort', 'medium']), ['--version']]);
  const env = calls.map(call => /^ENV=(.*)$/m.exec(call)?.[1]);
  assert.deepEqual(env, [
    ...Array(2 + utilities.length + invalidSeats.length).fill('inherited|unset|unset|unset'),
    ...operationCases.map(([, values]) => [...values, 'unset', 'unset'].join('|')),
    'inherited|unset|unset|unset',
  ]);
  assert.match(output, /^RESTORED=inherited\|unset$/m);
}

for (const [name, file] of [['bash', 'bash-integration.bash'], ['zsh', 'zsh-integration.zsh']]) {
  const shell = ['/bin', '/usr/bin'].map(dir => path.join(dir, name)).find(file => !win && fs.existsSync(file));
  test(`${name} Claude takes the validated seat only on conversation launches`, { skip: !shell }, async t => {
    const dir = profile(t), fake = path.join(dir, 'stand-in.sh'), script = path.join(dir, 'probe.sh');
    const bootstrap = path.join(dir, 'bootstrap');
    fs.writeFileSync(bootstrap, '{}');
    fs.writeFileSync(fake, [
      '#!/bin/sh', 'printf "CALL\\nSETTINGS=%s\\n" "$(cat "$2")"',
      'printf "ENV=%s|%s|%s|%s\\n" "${ANTHROPIC_DEFAULT_HAIKU_MODEL-unset}" "${CLAUDE_CODE_SUBAGENT_MODEL-unset}" \\',
      '  "${CLAUDE_CODE_SUBAGENT_MODEL_FORCE-unset}" "${ANTHROPIC_BASE_URL-unset}"',
      'shift 2', 'for word in "$@"; do printf "WORD=%s\\n" "$word"; done', '',
    ].join('\n'), { mode: 0o700 });
    fs.writeFileSync(script, [
      'source "$AGENTRIX_TEST_INTEGRATION" zshrc',
      'printf "claude-opus-5-5\\nhigh\\n1\\n" > "$AGENTRIX_BOOTSTRAP.lead"',
      'claude --model=manual; printf "STATUS=%s\\n" "$?"',
      'claude --effort low; printf "STATUS=%s\\n" "$?"',
      'claude --resume fixture-session',
      ...utilities.map(words => `claude ${words.join(' ')}`),
      ...invalidSeats.flatMap(([model, effort]) => [`printf '%s\\n' '${model}' '${effort}' 1 > "$AGENTRIX_BOOTSTRAP.lead"`, 'claude']),
      `printf '%s\\n' '${nextModel}' medium 0 > "$AGENTRIX_BOOTSTRAP.lead"`,
      'claude Explain doctor',
      ...operationCases.flatMap(([lines]) => [
        `printf '%s\\n' '${nextModel}' medium 0 ${lines.map(line => "'" + line + "'").join(' ')} > "$AGENTRIX_BOOTSTRAP.lead"`, 'claude',
      ]),
      `printf '%s\\n' '${nextModel}' medium 0 '${background}' '${subagent}' > "$AGENTRIX_BOOTSTRAP.lead"`,
      'claude --version',
      'printf "RESTORED=%s|%s\\n" "${ANTHROPIC_DEFAULT_HAIKU_MODEL-unset}" "${CLAUDE_CODE_SUBAGENT_MODEL-unset}"',
    ].join('\n') + '\n');
    const { stdout, stderr } = await exec(shell, [...(name === 'zsh' ? ['-f'] : ['--noprofile', '--norc']), script], {
      cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: dir, ZDOTDIR: dir, TMPDIR: dir, AGENTRIX_NODE: '/usr/bin/true',
        AGENTRIX_TEST_INTEGRATION: path.join(integration, file), AGENTRIX_CLAUDE_EXECUTABLE: fake, AGENTRIX_CODEX_EXECUTABLE: fake,
        AGENTRIX_BOOTSTRAP: bootstrap, AGENTRIX_SOCKET: path.join(dir, 'unused.sock'),
        AGENTRIX_HOOK_FALLBACK: 'ordinary', AGENTRIX_FAST_HOOK_FALLBACK: 'fast', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'inherited' },
    });
    assert.match(stderr, refusal);
    assertLaunches(stdout);
  });
}

test('PowerShell Claude takes the validated seat only on conversation launches', { skip: !win }, async t => {
  const dir = profile(t), script = path.join(dir, 'probe.ps1'), fake = path.join(dir, 'stand-in.ps1'), bootstrap = path.join(dir, 'bootstrap');
  const wrapper = path.join(dir, 'bootstrap.ps1');
  fs.copyFileSync(path.join(integration, 'bootstrap.ps1'), wrapper);
  fs.writeFileSync(path.join(dir, 'refresh-path.ps1'), '# Keep the fixture PATH isolated.\n');
  fs.writeFileSync(bootstrap, JSON.stringify({ hooks: { settings: { fallback: 'ordinary' }, fastSettings: { fallback: 'fast' } } }));
  fs.writeFileSync(fake, [
    '"CALL"',
    '  "SETTINGS=" + [IO.File]::ReadAllText($args[1])',
    '  $background = $env:ANTHROPIC_DEFAULT_HAIKU_MODEL',
    '  $subagent = if ($env:CLAUDE_CODE_SUBAGENT_MODEL) { $env:CLAUDE_CODE_SUBAGENT_MODEL } else { "unset" }',
    '  $force = if ($env:CLAUDE_CODE_SUBAGENT_MODEL_FORCE) { $env:CLAUDE_CODE_SUBAGENT_MODEL_FORCE } else { "unset" }',
    '  $base = if ($env:ANTHROPIC_BASE_URL) { $env:ANTHROPIC_BASE_URL } else { "unset" }',
    '  "ENV=$background|$subagent|$force|$base"',
    '  if ($args.Length -gt 2) { $args[2..($args.Length - 1)] | ForEach-Object { "WORD=" + $_ } }',
    '  $global:LASTEXITCODE = 0',
  ].join('\n'));
  fs.writeFileSync(script, '\uFEFF' + [
    '. $env:AGENTRIX_TEST_INTEGRATION',
    'function global:Send-AgentrixEvent {}',
    '$ErrorActionPreference = "Stop"',
    '$lead = $env:AGENTRIX_BOOTSTRAP + ".lead"',
    '[IO.File]::WriteAllLines($lead, @("claude-opus-5-5", "high", "1"))',
    'claude --model=manual; "STATUS=" + $LASTEXITCODE',
    'claude --effort low; "STATUS=" + $LASTEXITCODE',
    'claude --resume fixture-session',
    ...utilities.map(words => `claude ${words.join(' ')}`),
    ...invalidSeats.flatMap(([model, effort]) => [`[IO.File]::WriteAllLines($lead, @('${model}', '${effort}', '1'))`, 'claude']),
    `[IO.File]::WriteAllLines($lead, @('${nextModel}', 'medium', '0'))`,
    'claude Explain doctor',
    ...operationCases.flatMap(([lines]) => [
      `[IO.File]::WriteAllLines($lead, @('${nextModel}', 'medium', '0', ${lines.map(line => "'" + line + "'").join(', ')}))`, 'claude',
    ]),
    `[IO.File]::WriteAllLines($lead, @('${nextModel}', 'medium', '0', '${background}', '${subagent}'))`,
    'claude --version',
    '$subagent = if ($env:CLAUDE_CODE_SUBAGENT_MODEL) { $env:CLAUDE_CODE_SUBAGENT_MODEL } else { "unset" }',
    '"RESTORED=$env:ANTHROPIC_DEFAULT_HAIKU_MODEL|$subagent"',
  ].join('\n'));
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await exec(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    cwd: dir, env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: path.dirname(shell), USERPROFILE: dir, TEMP: dir, TMP: dir, AGENTRIX_AGENT_ONLY: '1',
      AGENTRIX_TEST_INTEGRATION: wrapper, AGENTRIX_BOOTSTRAP: bootstrap, AGENTRIX_CLAUDE_EXECUTABLE: fake,
      AGENTRIX_CODEX_EXECUTABLE: fake, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'inherited' },
  });
  const output = stdout.replaceAll('\r\n', '\n');
  assert.match(output, refusal);
  assertLaunches(output);
});
