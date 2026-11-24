const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { updateBootstrapLead } = require('../electron/features/terminal-events/bootstrap-file.cjs');
const exec = promisify(execFile);

const integration = path.resolve(__dirname, '../integration');

function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-wrapper-seat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const win = process.platform === 'win32';
const posixShell = name => win ? name === 'bash' && process.env.AGENTRIX_TEST_BASH
  : ['/bin', '/usr/bin'].map(dir => path.join(dir, name)).find(file => fs.existsSync(file));
const shellPath = value => win ? value.replaceAll('\\', '/') : value;
const refusal = /模型由模型路由决定，请在模型路由中更改。/;
const resumed = ['--model', 'claude-opus-5-5', '--effort', 'high', '--resume', 'fixture-session'];
const utilities = [['mcp', 'list'], ['update'], ['doctor'], ['config', 'list'], ['--version'], ['-v'], ['--help'], ['-h'], ['--resume', '--help']];
const prefixedSubcommands = [['--settings', 'owner-settings', 'mcp', 'list'], ['--debug', 'api', 'mcp', 'list']];
const utilitiesWithMarker = [['--version'], ['mcp', 'list']];
const invalidSeats = [['claude-opus&extra', 'high'], ['m'.repeat(161), 'high'], ['opus', 'High'], ['opus', 'e'.repeat(33)]];
const nextModel = 'claude-sonnet-5-5[1m]';
const background = 'claude-opus-5-5', subagent = 'claude-sonnet-5-5[1m]';
const seats = '{"researcher":{"model":"sonnet","effort":"high"}}';
const leadFormats = [[seats], [background, subagent, seats], [background, subagent], []];
const settings = mode => JSON.stringify({ hooks: { Stop: [{ fixture: mode }] }, ...(mode === 'fast' && { fastMode: true }) });
const cases = [
  ['bash-integration.bash', 'agentrix_agent() {', 'refused)'],
  ['zsh-integration.zsh', 'agentrix_agent() {', 'refused)'],
  ['bootstrap.ps1', 'function global:agentrix_agent {', "if ($route -ceq 'refused')"],
];

test('the local Claude wrappers read the lead file and refuse overrides before reporting launch', () => {
  for (const [file, start, flags] of cases) {
    const source = fs.readFileSync(path.join(integration, file), 'utf8');
    const begin = source.indexOf(start);
    const wrapper = source.slice(begin);
    assert.ok(begin >= 0, file);
    assert.match(source, /\.lead/);
    assert.match(wrapper, refusal);
    assert.ok(wrapper.indexOf(flags) >= 0 && wrapper.indexOf(flags) < wrapper.lastIndexOf('agent-started'), file);
  }
});

function ultracodeLeads(bootstrap) {
  for (const fast of [true, false]) {
    const target = bootstrap + (fast ? '.ultra-fast' : '.ultra');
    updateBootstrapLead(target, { model: nextModel, effort: 'medium', fast, seatsMap: JSON.parse(seats), ultracode: true });
    assert.equal(fs.readFileSync(target + '.lead', 'utf8'), [nextModel, 'medium', fast ? '1' : '0', seats, 'ultracode', ''].join('\n'));
  }
}

function assertLaunches(output, utilitySeats = 'null') {
  assert.deepEqual(output.match(/^STATUS=2$/gm), ['STATUS=2', 'STATUS=2']);
  const calls = output.split(/^CALL\n/gm).slice(1);
  const modes = ['fast', ...utilities.map(() => 'ordinary'), ...prefixedSubcommands.map(() => 'fast'),
    ...invalidSeats.map(() => 'ordinary'), 'ordinary', ...leadFormats.map(() => 'ordinary'), 'ordinary'];
  const ordinary = JSON.parse(settings('ordinary')), fast = JSON.parse(settings('fast'));
  const expectedSettings = [...modes.map(mode => JSON.parse(settings(mode))), { ...fast, ultracode: true }, { ...ordinary, ultracode: true },
    ...utilitiesWithMarker.map(() => ordinary), ordinary];
  assert.deepEqual(calls.map(call => JSON.parse(/^SETTINGS=(.*)$/m.exec(call)[1])), expectedSettings);
  const next = ['--model', nextModel, '--effort', 'medium'];
  assert.deepEqual(calls.map(call => [...call.matchAll(/^WORD=(.*)$/gm)].map(row => row[1])),
    [resumed, ...utilities, ...prefixedSubcommands.map(words => [...resumed.slice(0, 4), ...words]),
      ...invalidSeats.map(() => []), [...next, 'Explain', 'doctor'],
      ...leadFormats.map(() => next), ['--version'], next, next, ...utilitiesWithMarker, next]);
  const env = calls.map(call => /^ENV=(.*)$/m.exec(call)?.[1]);
  assert.deepEqual(env, expectedSettings.map(() => 'inherited|unset|unset|unset'));
  const maps = calls.map(call => /^SEATS=(.*)$/m.exec(call)?.[1]);
  assert.deepEqual(maps.slice(modes.length - 1 - leadFormats.length, modes.length - 1), [seats, seats, 'null', 'null']);
  assert.deepEqual(maps.slice(modes.length), [seats, seats, ...utilitiesWithMarker.map(() => utilitySeats), seats]);
  assert.match(output, /^RESTORED=inherited\|unset$/m);
}

for (const [name, file] of [['bash', 'bash-integration.bash'], ['zsh', 'zsh-integration.zsh']]) {
  const shell = posixShell(name);
  test(`${name} Claude takes the validated seat only on conversation launches`, { skip: !shell }, async t => {
    const dir = profile(t), fake = path.join(dir, 'stand-in.sh'), script = path.join(dir, 'probe.sh');
    const bootstrap = path.join(dir, 'bootstrap');
    fs.writeFileSync(bootstrap, '{}');
    ultracodeLeads(bootstrap);
    fs.writeFileSync(fake, [
      '#!/bin/sh', 'IFS= read -r settings < "$2" || :', 'printf "CALL\\nSETTINGS=%s\\n" "$settings"',
      'printf "ENV=%s|%s|%s|%s\\n" "${ANTHROPIC_DEFAULT_HAIKU_MODEL-unset}" "${CLAUDE_CODE_SUBAGENT_MODEL-unset}" \\',
      '  "${CLAUDE_CODE_SUBAGENT_MODEL_FORCE-unset}" "${ANTHROPIC_BASE_URL-unset}"',
      'printf "SEATS=%s\\n" "$AGENTRIX_SEATS"',
      'shift 2', 'for word in "$@"; do printf "WORD=%s\\n" "$word"; done', '',
    ].join('\n'), { mode: 0o700 });
    fs.writeFileSync(script, [
      'source "$AGENTRIX_TEST_INTEGRATION" zshrc',
      'printf "claude-opus-5-5\\nhigh\\n1\\n" > "$AGENTRIX_BOOTSTRAP.lead"',
      'claude --model=manual; printf "STATUS=%s\\n" "$?"',
      'claude --effort low; printf "STATUS=%s\\n" "$?"',
      'claude --resume fixture-session',
      ...[...utilities, ...prefixedSubcommands].map(words => `claude ${words.join(' ')}`),
      ...invalidSeats.flatMap(([model, effort]) => [`printf '%s\\n' '${model}' '${effort}' 1 > "$AGENTRIX_BOOTSTRAP.lead"`, 'claude']),
      `printf '%s\\n' '${nextModel}' medium 0 > "$AGENTRIX_BOOTSTRAP.lead"`,
      'claude Explain doctor',
      ...leadFormats.flatMap(lines => [
        `printf '%s\\n' '${nextModel}' medium 0${lines.map(line => " '" + line + "'").join('')} > "$AGENTRIX_BOOTSTRAP.lead"`, 'claude',
      ]),
      `printf '%s\\n' '${nextModel}' medium 0 '${background}' '${subagent}' > "$AGENTRIX_BOOTSTRAP.lead"`,
      'claude --version',
      'printf "conductor\\n" > "$AGENTRIX_BOOTSTRAP.mode"',
      'cp "$AGENTRIX_BOOTSTRAP.ultra-fast.lead" "$AGENTRIX_BOOTSTRAP.lead"; claude',
      'cp "$AGENTRIX_BOOTSTRAP.ultra.lead" "$AGENTRIX_BOOTSTRAP.lead"; claude',
      ...utilitiesWithMarker.map(words => `claude ${words.join(' ')}`),
      'printf "native\\n" > "$AGENTRIX_BOOTSTRAP.mode"; claude',
      'printf "RESTORED=%s|%s\\n" "${ANTHROPIC_DEFAULT_HAIKU_MODEL-unset}" "${CLAUDE_CODE_SUBAGENT_MODEL-unset}"',
    ].join('\n') + '\n');
    const { stdout, stderr } = await exec(shell, [...(name === 'zsh' ? ['-f'] : ['--noprofile', '--norc']), shellPath(script)], {
      cwd: dir, timeout: win ? 240000 : 15000, env: {
        PATH: '/usr/bin:/bin', HOME: shellPath(dir), ZDOTDIR: shellPath(dir), TMPDIR: shellPath(dir), AGENTRIX_NODE: shellPath(process.execPath),
        AGENTRIX_TEST_INTEGRATION: shellPath(path.join(integration, file)), AGENTRIX_CLAUDE_EXECUTABLE: shellPath(fake), AGENTRIX_CODEX_EXECUTABLE: shellPath(fake),
        AGENTRIX_BOOTSTRAP: shellPath(bootstrap), AGENTRIX_SOCKET: shellPath(path.join(dir, 'unused.sock')),
        AGENTRIX_HOOK_FALLBACK: settings('ordinary'), AGENTRIX_FAST_HOOK_FALLBACK: settings('fast'), ANTHROPIC_DEFAULT_HAIKU_MODEL: 'inherited' },
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
  fs.writeFileSync(bootstrap, JSON.stringify({ nodePath: process.execPath, hooks: { settings: { fallback: settings('ordinary') }, fastSettings: { fallback: settings('fast') } } }));
  ultracodeLeads(bootstrap);
  fs.writeFileSync(fake, [
    '"CALL"',
    '  "SETTINGS=" + [IO.File]::ReadAllText($args[1])',
    '  $background = $env:ANTHROPIC_DEFAULT_HAIKU_MODEL',
    '  $subagent = if ($env:CLAUDE_CODE_SUBAGENT_MODEL) { $env:CLAUDE_CODE_SUBAGENT_MODEL } else { "unset" }',
    '  $force = if ($env:CLAUDE_CODE_SUBAGENT_MODEL_FORCE) { $env:CLAUDE_CODE_SUBAGENT_MODEL_FORCE } else { "unset" }',
    '  $base = if ($env:ANTHROPIC_BASE_URL) { $env:ANTHROPIC_BASE_URL } else { "unset" }',
    '  "ENV=$background|$subagent|$force|$base"',
    '  "SEATS=$env:AGENTRIX_SEATS"',
    '  if ($args.Length -gt 2) { $args[2..($args.Length - 1)] | ForEach-Object { "WORD=" + $_ } }',
    '  $global:LASTEXITCODE = 0',
  ].join('\n'));
  fs.writeFileSync(script, '\uFEFF' + [
    '. $env:AGENTRIX_TEST_INTEGRATION',
    `$global:AgentrixIntercept = '${path.join(integration, 'shims/intercept.cjs').replaceAll("'", "''")}'`,
    'function global:Send-AgentrixEvent {}',
    '$ErrorActionPreference = "Stop"',
    '$lead = $env:AGENTRIX_BOOTSTRAP + ".lead"',
    '[IO.File]::WriteAllLines($lead, @("claude-opus-5-5", "high", "1"))',
    'claude --model=manual; "STATUS=" + $LASTEXITCODE',
    'claude --effort low; "STATUS=" + $LASTEXITCODE',
    'claude --resume fixture-session',
    ...[...utilities, ...prefixedSubcommands].map(words => `claude ${words.join(' ')}`),
    ...invalidSeats.flatMap(([model, effort]) => [`[IO.File]::WriteAllLines($lead, @('${model}', '${effort}', '1'))`, 'claude']),
    `[IO.File]::WriteAllLines($lead, @('${nextModel}', 'medium', '0'))`,
    'claude Explain doctor',
    ...leadFormats.flatMap(lines => [
      `[IO.File]::WriteAllLines($lead, @('${nextModel}', 'medium', '0'${lines.map(line => ", '" + line + "'").join('')}))`, 'claude',
    ]),
    `[IO.File]::WriteAllLines($lead, @('${nextModel}', 'medium', '0', '${background}', '${subagent}'))`,
    'claude --version',
    '[IO.File]::WriteAllLines($env:AGENTRIX_BOOTSTRAP + ".mode", @("conductor"))',
    '[IO.File]::Copy($env:AGENTRIX_BOOTSTRAP + ".ultra-fast.lead", $lead, $true); claude',
    '[IO.File]::Copy($env:AGENTRIX_BOOTSTRAP + ".ultra.lead", $lead, $true); claude',
    ...utilitiesWithMarker.map(words => `claude ${words.join(' ')}`),
    '[IO.File]::WriteAllLines($env:AGENTRIX_BOOTSTRAP + ".mode", @("native")); claude',
    '$subagent = if ($env:CLAUDE_CODE_SUBAGENT_MODEL) { $env:CLAUDE_CODE_SUBAGENT_MODEL } else { "unset" }',
    '"RESTORED=$env:ANTHROPIC_DEFAULT_HAIKU_MODEL|$subagent"',
  ].join('\n'));
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await exec(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    cwd: dir, env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: path.dirname(shell), PATHEXT: '.COM;.EXE;.BAT;.CMD',
      USERPROFILE: dir, TEMP: dir, TMP: dir, AGENTRIX_AGENT_ONLY: '1',
      AGENTRIX_TEST_INTEGRATION: wrapper, AGENTRIX_BOOTSTRAP: bootstrap, AGENTRIX_CLAUDE_EXECUTABLE: fake,
      AGENTRIX_CODEX_EXECUTABLE: fake, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'inherited' },
  });
  const output = stdout.replaceAll('\r\n', '\n');
  assert.match(output, refusal);
  assertLaunches(output, '');
});

// Native mode: the lead is the plain CLI, so the owner's own --model and --effort reach it; conductor mode still refuses them.
const modeLines = (write, call) => [write('conductor'), call, write('native'), call];
const assertModes = output => {
  assert.equal((output.match(refusal) ?? []).length, 1, 'conductor mode refuses the override once');
  const calls = output.split(/^CALL\n/gm).slice(1);
  assert.equal(calls.length, 1, 'native mode launches');
  assert.deepEqual([...calls[0].matchAll(/^WORD=(.*)$/gm)].map(row => row[1]), ['--effort', 'low']);
};

for (const [name, file] of [['bash', 'bash-integration.bash'], ['zsh', 'zsh-integration.zsh']]) {
  const shell = posixShell(name);
  test(`${name} Claude passes the owner's --model and --effort only in native mode`, { skip: !shell }, async t => {
    const dir = profile(t), fake = path.join(dir, 'stand-in.sh'), script = path.join(dir, 'probe.sh'), bootstrap = path.join(dir, 'bootstrap');
    fs.writeFileSync(bootstrap, '{}');
    fs.writeFileSync(bootstrap + '.lead', '');
    fs.writeFileSync(fake, ['#!/bin/sh', 'printf "CALL\n"', 'shift 2', 'for word in "$@"; do printf "WORD=%s\n" "$word"; done', ''].join('\n'), { mode: 0o700 });
    fs.writeFileSync(script, ['source "$AGENTRIX_TEST_INTEGRATION" zshrc',
      ...modeLines(mode => `printf '${mode}\n' > "$AGENTRIX_BOOTSTRAP.mode"`, 'claude --effort low 2>&1')].join('\n') + '\n');
    const { stdout } = await exec(shell, [...(name === 'zsh' ? ['-f'] : ['--noprofile', '--norc']), shellPath(script)], {
      cwd: dir, timeout: 15000, env: {
        PATH: '/usr/bin:/bin', HOME: shellPath(dir), ZDOTDIR: shellPath(dir), TMPDIR: shellPath(dir), AGENTRIX_NODE: shellPath(process.execPath),
        AGENTRIX_TEST_INTEGRATION: shellPath(path.join(integration, file)), AGENTRIX_CLAUDE_EXECUTABLE: shellPath(fake), AGENTRIX_CODEX_EXECUTABLE: shellPath(fake),
        AGENTRIX_BOOTSTRAP: shellPath(bootstrap), AGENTRIX_SOCKET: shellPath(path.join(dir, 'unused.sock')), AGENTRIX_HOOK_FALLBACK: 'ordinary' },
    });
    assertModes(stdout);
  });
}

test('PowerShell Claude passes the owner\'s --model and --effort only in native mode', { skip: !win }, async t => {
  const dir = profile(t), script = path.join(dir, 'probe.ps1'), fake = path.join(dir, 'stand-in.ps1'), bootstrap = path.join(dir, 'bootstrap');
  const wrapper = path.join(dir, 'bootstrap.ps1');
  fs.copyFileSync(path.join(integration, 'bootstrap.ps1'), wrapper);
  fs.writeFileSync(path.join(dir, 'refresh-path.ps1'), '# Keep the fixture PATH isolated.\n');
  fs.writeFileSync(bootstrap, JSON.stringify({ nodePath: process.execPath, hooks: { settings: { fallback: 'ordinary' } } }));
  fs.writeFileSync(bootstrap + '.lead', '');
  fs.writeFileSync(fake, ['"CALL"', '  if ($args.Length -gt 2) { $args[2..($args.Length - 1)] | ForEach-Object { "WORD=" + $_ } }', '  $global:LASTEXITCODE = 0'].join('\n'));
  fs.writeFileSync(script, '\uFEFF' + ['. $env:AGENTRIX_TEST_INTEGRATION', `$global:AgentrixIntercept = '${path.join(integration, 'shims/intercept.cjs').replaceAll("'", "''")}'`,
    'function global:Send-AgentrixEvent {}', '$ErrorActionPreference = "Stop"',
    ...modeLines(mode => `[IO.File]::WriteAllText($env:AGENTRIX_BOOTSTRAP + '.mode', "${mode}\`n")`, 'claude --effort low')].join('\n'));
  const shell = path.join(process.env.SystemRoot || 'C:\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await exec(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    cwd: dir, env: { SystemRoot: process.env.SystemRoot || 'C:\Windows', PATH: path.dirname(shell), PATHEXT: '.COM;.EXE;.BAT;.CMD',
      USERPROFILE: dir, TEMP: dir, TMP: dir, AGENTRIX_AGENT_ONLY: '1',
      AGENTRIX_TEST_INTEGRATION: wrapper, AGENTRIX_BOOTSTRAP: bootstrap, AGENTRIX_CLAUDE_EXECUTABLE: fake, AGENTRIX_CODEX_EXECUTABLE: fake },
  });
  assertModes(stdout.replaceAll('\r\n', '\n'));
});
