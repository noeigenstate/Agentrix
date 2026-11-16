require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixtureProcesses } = require('./fixtures/claude-sdk-processes.cjs');
const entry = path.resolve(__dirname, '../integration/shims/intercept.cjs');

test('installed launchers preserve quoted Unicode arguments and stdin through the host shells', { timeout: 30000 }, async t => {
  const scope = fixtureProcesses(t, 'agx-intercept-shells-'), folder = scope.directory;
  // A stand-in entrypoint records what the actual shell launcher delivered; no installed provider is invoked.
  fs.writeFileSync(path.join(folder, 'intercept.cjs'), `const args=process.env.AGENTRIX_INTERCEPT_ARGV?JSON.parse(process.env.AGENTRIX_INTERCEPT_ARGV):process.argv.slice(2);
const chunks=[];process.stdin.on('data',part=>chunks.push(part));process.stdin.on('end',()=>process.stdout.write(JSON.stringify({args,input:Buffer.concat(chunks).toString('base64'),cwd:process.cwd()})));`);
  fs.writeFileSync(path.join(folder, 'invoke.ps1'), 'param([string]$Launcher)\nSet-Location -LiteralPath $PSScriptRoot\n$words = ConvertFrom-Json $env:AGENTRIX_TEST_LAUNCHER_WORDS\n& $Launcher @words\nexit $LASTEXITCODE\n');
  const words = ['exec', '-m', 'test', 'keep "quoted" words', 'Unicode 中文'];
  const inputs = [Buffer.from('input "quotes" 中文\n'), Buffer.from('mixed\r\nline\nwithout a final newline 中文'), Buffer.from([0, 255, 195, 40, 13, 10, 0, 10])];
  const suffixes = process.platform === 'win32' ? ['.ps1', '.cmd'] : [''];
  for (const agent of ['codex', 'claude']) for (const suffix of suffixes) for (const input of inputs) {
    const file = path.join(folder, agent + suffix);
    fs.copyFileSync(path.join(path.dirname(entry), agent + suffix), file);
    const env = { ...process.env, AGENTRIX_SHIM_NODE: process.execPath, AGENTRIX_TEST_LAUNCHER_WORDS: JSON.stringify(words) };
    delete env.AGENTRIX_INTERCEPT_ARGV;
    let command, args, windowsVerbatimArguments = false;
    if (suffix === '.ps1') {
      command = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
      args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(folder, 'invoke.ps1'), file];
    } else if (suffix === '.cmd') {
      command = process.env.ComSpec; windowsVerbatimArguments = true;
      args = ['/d', '/s', '/c', `""${file}" exec -m test "keep \\"quoted\\" words" "Unicode 中文""`];
    } else { command = '/bin/sh'; args = [file, ...words]; }
    const child = scope.spawn(command, args, { cwd: suffix === '.ps1' ? path.dirname(folder) : folder, env, windowsVerbatimArguments, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    child.stdin.end(input);
    assert.equal(await scope.wait(completed, `${agent}${suffix} launcher`), 0, stderr);
    const expectedCwd = fs.realpathSync.native(folder);
    const received = JSON.parse(stdout);
    assert.deepEqual({ ...received, cwd: fs.realpathSync.native(received.cwd) }, { args: [agent, '--', ...words], input: input.toString('base64'), cwd: expectedCwd }, `${agent}${suffix} preserves stdin bytes and cwd`);
  }
});

// CI supplies an isolated authenticated profile and explicitly opts into a real provider request. Never run by default.
for (const agent of ['codex', 'claude']) test(`real ${agent} interception preserves stdin, final stdout and exit status`, {
  skip: process.env.AGENTRIX_INTERCEPT_REAL_CLI !== agent, timeout: 180000,
}, async t => {
  assert.ok(process.env[agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'], 'CI must supply its isolated authenticated profile');
  const scope = fixtureProcesses(t, 'agx-intercept-real-'), cwd = scope.directory;
  const env = { ...process.env, AGENTRIX_DISPATCH_DEPTH: '0', ELECTRON_RUN_AS_NODE: '1' };
  for (const name of ['AGENTRIX_BOOTSTRAP', 'AGENTRIX_RUN_ID', 'AGENTRIX_RUN_PROOF', 'AGENTRIX_INTERCEPT_ARGV']) delete env[name];
  const args = agent === 'codex' ? ['exec', '-m', process.env.AGENTRIX_INTERCEPT_MODEL || 'gpt-6.1-sol', '--sandbox', 'read-only', '-o', 'answer.txt', '-']
    : ['-p', '--model', process.env.AGENTRIX_INTERCEPT_MODEL || 'sonnet', '--output-format', 'text', '-'];
  const child = scope.spawn(process.execPath, [entry, agent, '--', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  child.stdin.end('Reply with exactly F1_INTERCEPT_OK. The instruction contains "quoted words" and Unicode 中文.\n');
  assert.equal(await completed, 0, stderr);
  assert.match(stdout, /F1_INTERCEPT_OK/); assert.doesNotMatch(stdout, /\[dispatch\]/);
  assert.match(stderr, /\[dispatch\] started /); assert.match(stderr, /\[dispatch\] ended /);
  if (agent === 'codex') assert.equal(fs.readFileSync(path.join(cwd, 'answer.txt'), 'utf8'), stdout);
});
