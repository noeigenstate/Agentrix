const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFile } = require('node:child_process'), { promisify } = require('node:util');
const { isolatedEnvironment } = require('../scripts/native-approval-probe.cjs');
const { timeoutScale } = require('../scripts/wait.mjs');
const exec = promisify(execFile), integration = path.resolve(__dirname, '../integration');

// Which Claude Code a terminal's wrapper runs: the user's alias, then AGENTRIX_CLAUDE_EXECUTABLE (main's locator) while
// that file is there, then the wrapper's own PATH search. Only stand-in files are named; nothing is run.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wrapper-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}
const slashes = file => file.replace(/\\/g, '/');

for (const kind of ['bash', 'zsh']) {
  const shell = kind === 'bash' && process.env.AGENTRIX_TEST_BASH || (process.platform === 'win32' ? kind === 'bash' && 'C:/Program Files/Git/bin/bash.exe' : `/bin/${kind}`);
  test(`${kind} wrapper runs the user's alias first, then the Claude Code Agentrix chose while it exists, then the first on PATH`, { skip: !shell || !fs.existsSync(shell), timeout: 60000 * timeoutScale }, async t => {
    const root = fixture(t), bin = path.join(root, 'bin'), chosen = path.join(root, 'chosen', 'claude');
    for (const file of [path.join(bin, 'claude'), path.join(bin, 'codex'), chosen]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); }
    const source = fs.readFileSync(path.join(integration, `${kind}-integration.${kind}`), 'utf8').replace(/\r\n/g, '\n');
    const begin = source.indexOf('__pg_program() {'), program = source.slice(begin, source.indexOf('\n}\n', begin) + 3);
    const probe = path.join(root, 'probe.sh'), words = kind === 'bash' ? '"${__pg_words[@]}"' : '"${reply[@]}"';
    const alias = kind === 'bash' ? '[[ -n $PROBE_ALIAS ]] && __pg_alias_claude=$PROBE_ALIAS\n' : 'typeset -gA __pg_aliases\n[[ -n $PROBE_ALIAS ]] && __pg_aliases[claude]=$PROBE_ALIAS\n';
    fs.writeFileSync(probe, `${alias}${program}for name in claude codex; do __pg_program $name && printf 'WORDS=%s\\n' "$(printf '%s|' ${words})" || printf 'WORDS=none\\n'; done\n`);
    const run = async (hint, aliasWords = '') => {
      const env = { ...process.env, PATH: `${slashes(bin)}:/usr/bin:/bin`, PROBE_ALIAS: aliasWords, AGENTRIX_CLAUDE_EXECUTABLE: hint };
      const { stdout } = await exec(shell, [...(kind === 'bash' ? ['--noprofile', '--norc'] : ['-f']), slashes(probe)], { cwd: root, env, windowsHide: true, timeout: 10000 * timeoutScale });
      return [...stdout.matchAll(/WORDS=(.*)/g)].map(match => match[1]);
    };
    const [, codex] = await run(slashes(chosen));
    assert.deepEqual(await run(slashes(chosen)), [`${slashes(chosen)}|`, codex], 'the chosen file, and codex is not touched');
    assert.equal((await run(slashes(chosen), `${slashes(path.join(bin, 'claude'))} --model opus`))[0], `${slashes(path.join(bin, 'claude'))}|--model|opus|`, 'the alias wins');
    assert.match((await run(slashes(path.join(root, 'gone', 'claude'))))[0], /bin\/claude\|$/, 'a chosen file that is gone falls back to PATH');
    assert.match((await run(''))[0], /bin\/claude\|$/);
  });
}

test('PowerShell wrapper runs the Claude Code Agentrix chose while it exists, and otherwise maps the first claude on PATH to its npm package', { skip: process.platform !== 'win32', timeout: 60000 * timeoutScale }, async t => {
  const root = fixture(t), bin = path.join(root, 'nodejs22'), native = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  const chosen = path.join(root, 'chosen', 'claude.exe');
  for (const file of [path.join(bin, 'claude.cmd'), native, chosen]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); }
  const bootstrap = path.join(root, 'bootstrap.json'), script = path.join(root, 'probe.ps1');
  fs.writeFileSync(bootstrap, JSON.stringify({ projectPath: root, projectId: 't', sessionKey: 'key', pipeName: 'unused' }));
  fs.writeFileSync(script, `$env:AGENTRIX_AGENT_ONLY='1'\n. '${integration.replace(/'/g, "''")}\\bootstrap.ps1'\nWrite-Output "CLAUDE=$global:AgentrixClaudeCommand|$global:AgentrixClaudeExecutable"\n`);
  // The stored PATH the terminal merges is a stand-in (refresh-path.ps1's AGENTRIX_TEST_STORED_PATH): this computer's
  // registry is never read.
  const run = async (hint, PATH = `${bin};${path.join(process.env.SystemRoot, 'System32')}`, stored = { Machine: '', User: '' }) => {
    const env = { ...isolatedEnvironment(root), AGENTRIX_BOOTSTRAP: bootstrap, PATH, AGENTRIX_CLAUDE_EXECUTABLE: hint,
      AGENTRIX_TEST_STORED_PATH: JSON.stringify(stored), PSModuleAnalysisCachePath: path.join(root, 'module-cache') };
    delete env.Path;
    const { stdout } = await exec(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { cwd: root, env, windowsHide: true, timeout: 20000 * timeoutScale });
    // PowerShell spells the extension as PATHEXT does.
    return /CLAUDE=(.*)/.exec(stdout)[1].trim().toLowerCase();
  };
  const own = `${path.join(bin, 'claude.cmd')}|${native}`.toLowerCase();
  assert.equal(await run(chosen), `${chosen}|${chosen}`.toLowerCase());
  assert.equal(await run(path.join(root, 'gone', 'claude.exe')), own);
  assert.equal(await run(''), own);
  // A folder only the stored PATH has is searched after the inherited ones, as a terminal opened after an install sees it.
  assert.equal(await run('', path.join(process.env.SystemRoot, 'System32'), { Machine: '', User: bin }), own);
  assert.equal(await run('', path.join(process.env.SystemRoot, 'System32')), '|');
});
