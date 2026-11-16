require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { isolatedEnvironment } = require('../scripts/native-approval-probe.cjs');
const { findShell } = require('../electron/zsh-terminal.cjs');
const shim = () => require('../integration/shims/intercept.cjs');
const root = path.resolve(__dirname, '..');
const shims = path.join(root, 'integration/shims');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
function temporary(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-intercept-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}
const output = () => ({ text: '', write(value) { this.text += value; } });
// A planner's tool shell: depth zero and a bootstrap to report its row to.
const planner = { AGENTRIX_DISPATCH_DEPTH: '0', AGENTRIX_BOOTSTRAP: 'synthetic-bootstrap.json' };
// The helper arguments an intercepted call would run with, read from a dispatch that only records them.
async function dispatched(agent, args) {
  let argv = null;
  const code = await shim().intercept([agent, '--', ...args], { env: planner, stdout: output(), stderr: output(), readInput: async () => '',
    dispatch: async words => { argv = words; return 1; } });
  return { code, argv, value: flag => argv && argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null };
}
// A Git Bash on Windows, a bash or zsh elsewhere; null when this machine has none.
function shellFor(kind) {
  if (process.platform !== 'win32') return findShell(kind);
  const bash = process.env.AGENTRIX_TEST_BASH || 'C:/Program Files/Git/bin/bash.exe';
  return kind === 'bash' && fs.existsSync(bash) ? bash : null;
}
const bootstraps = () => require('../electron/features/terminal-events/bootstrap-file.cjs');
// A session's bootstrap as main writes it, with the session's private copy of the Claude Code start-up hook.
function sessionBootstrap(folder) {
  const file = path.join(folder, 'bootstrap.json');
  bootstraps().writeBootstrap({ file, eventServer: { name: 'agentrix-test-unused', address: path.join(folder, 'unused.sock') }, projectId: 't',
    projectPath: folder, sessionKey: 'k' });
  return { file, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}
const posix = file => process.platform === 'win32' ? file.replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()).replace(/\\/g, '/') : file;

test('interception maps the supported Codex options without flattening prompt or image arguments', () => {
  const options = shim().mapCommand('codex', ['exec', '-m', 'test-model', '-c', 'model_reasoning_effort="max"', '-c', 'service_tier=fast',
    '-C', 'a folder', '--image', 'a b.png', '-i=second.png', '--sandbox', 'read-only', '-o', 'answer.txt', '--', 'Keep "quotes"\nand Unicode 中文'], root);
  assert.equal(options.model, 'test-model'); assert.equal(options.effort, 'max'); assert.equal(options.fast, true);
  assert.equal(options.cwd, path.resolve(root, 'a folder')); assert.equal(options.out, path.resolve(root, 'a folder/answer.txt'));
  assert.deepEqual(options.images, [path.resolve(root, 'a folder/a b.png'), path.resolve(root, 'a folder/second.png')]);
  assert.equal(options.readOnly, true); assert.equal(options.prompt, 'Keep "quotes"\nand Unicode 中文');
  assert.equal(shim().mapCommand('codex', ['e', 'the alias'], root).prompt, 'the alias', 'codex e is codex exec');
});

test('interception maps Claude print mode and distinguishes a positional prompt from stdin', () => {
  const options = shim().mapCommand('claude', ['--print', '--model=sonnet', '--effort', 'high', '--permission-mode', 'acceptEdits', '--output-format=text', '-'], root);
  assert.equal(options.model, 'sonnet'); assert.equal(options.readOnly, false); assert.equal(options.prompt, null);
  assert.equal(shim().mapCommand('claude', ['-p', 'a prompt'], root).prompt, 'a prompt');
});

test("a call keeps its CLI's default read-only permission and writes only through the explicit write flags", async () => {
  for (const args of [['exec', 'analyse'], ['exec', '--sandbox', 'read-only', 'analyse'], ['exec', '-s=read-only', 'analyse']]) {
    const { argv, value } = await dispatched('codex', args);
    assert.equal(value('--role'), 'investigate', args.join(' ')); assert.ok(argv.includes('--read-only'), args.join(' '));
  }
  for (const args of [['exec', '--sandbox', 'workspace-write', 'build'], ['exec', '-s', 'workspace-write', 'build'], ['exec', '--full-auto', 'build']]) {
    const { argv, value } = await dispatched('codex', args);
    assert.equal(value('--role'), 'exec', args.join(' ')); assert.equal(argv.includes('--read-only'), false, args.join(' '));
  }
  for (const [args, permission, role] of [[['-p', 'analyse'], 'plan', 'investigate'], [['-p', '--permission-mode', 'default', 'analyse'], 'plan', 'investigate'],
    [['-p', '--permission-mode', 'plan', 'analyse'], 'plan', 'investigate'], [['-p', '--permission-mode=acceptEdits', 'build'], 'acceptEdits', 'exec']]) {
    const { value } = await dispatched('claude', args);
    assert.equal(value('--permission'), permission, args.join(' ')); assert.equal(value('--role'), role, args.join(' '));
  }
  for (const [agent, args] of [['codex', ['exec', '--sandbox', 'danger-full-access', 'x']], ['codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', 'x']],
    ['codex', ['exec', '--full-auto', '--sandbox', 'read-only', 'x']], ['claude', ['-p', '--permission-mode', 'bypassPermissions', 'x']],
    ['claude', ['-p', '--permission-mode', '__proto__', 'x']], ['claude', ['-p', '--dangerously-skip-permissions', 'x']]]) {
    const { code, argv } = await dispatched(agent, args);
    assert.equal(code, 2, args.join(' ')); assert.equal(argv, null, `${args.join(' ')} is wider than the helper allows`);
  }
});

test('an unsupported option is refused by name with the equivalent command and exit code 2', async () => {
  for (const [agent, args, option] of [['codex', ['exec', '-m', 'test', '--json', 'prompt'], '--json'],
    ['claude', ['-p', '--output-format', 'stream-json', 'prompt'], '--output-format'],
    ['codex', ['exec', '--sandbox', 'danger-full-access', 'prompt'], '--sandbox'],
    ['codex', ['exec', '-m', 'one', '--model=two', 'prompt'], '--model'],
    ['codex', ['exec', '-c', 'approval_policy="never"', 'prompt'], '-c'],
    ['codex', ['-m', 'test', 'exec', 'prompt'], '-m before exec'],
    ['codex', ['exec', 'resume', '--last'], 'exec resume']]) {
    const stdout = output(), stderr = output();
    const code = await shim().intercept([agent, '--', ...args], { env: planner, stdout, stderr, dispatch: () => assert.fail('refused call ran') });
    assert.equal(code, 2); assert.equal(stdout.text, ''); assert.ok(stderr.text.includes(`not run: ${option} is not supported`), stderr.text);
    assert.match(stderr.text, /\[dispatch\] not run:.*not supported through the Agentrix dispatcher/);
    if (['--json', '-m before exec'].includes(option)) assert.match(stderr.text, /\[dispatch\] equivalent: node .*dispatch\.cjs.*codex.*"--model" "test"/);
  }
  const stderr = output();
  assert.equal(await shim().intercept(['codex', '--', 'exec', '--json', '--ephemeral', 'prompt'], { env: planner, stdout: output(), stderr,
    dispatch: () => assert.fail('unsupported options ran') }), 2);
  assert.doesNotMatch(stderr.text, /equivalent:/, 'more than one unmappable option has no equivalent command');
});

test("a call without a planner's depth zero and bootstrap, or with a worker identity, is refused as nested before stdin or dispatch", async () => {
  const cases = [{}, { AGENTRIX_DISPATCH_DEPTH: '0' }, { AGENTRIX_BOOTSTRAP: 'b.json' }, ...['1', '2', '-1', '', ' 0', 'invalid'].map(depth => ({ ...planner, AGENTRIX_DISPATCH_DEPTH: depth })),
    { ...planner, AGENTRIX_RUN_ID: 'worker' }, { ...planner, AGENTRIX_RUN_PROOF: 'proof' }];
  for (const env of cases) for (const [agent, args] of [['codex', ['exec', '-']], ['claude', ['-p', 'x']], ['codex', ['mcp-server']], ['claude', ['mcp', 'serve']]]) {
    const stderr = output();
    assert.equal(await shim().intercept([agent, '--', ...args], { env, stdout: output(), stderr, readInput: () => assert.fail('nested call read stdin'),
      dispatch: () => assert.fail('nested call ran'), locate: () => assert.fail('nested call looked for a CLI') }), 2, JSON.stringify(env));
    assert.match(stderr.text, /dispatch\.intercept_nested/); assert.match(stderr.text, new RegExp(`delegate ${agent}`));
  }
});

test("at depth zero a call that is not a delegation runs the real CLI with this process's streams and exit status; a worker runs only version and help", async t => {
  const runs = [];
  const launch = (file, args, options) => {
    const child = new EventEmitter(); runs.push({ file, args, options });
    queueMicrotask(() => child.emit('exit', 7, null));
    return child;
  };
  const locate = async agent => `real-${agent}`;
  for (const [agent, args] of [['codex', ['mcp-server']], ['claude', ['mcp', 'serve']], ['claude', ['--version']], ['codex', ['login', 'status']],
    ['codex', []], ['codex', ['-m', 'x', 'resume', '--last']], ['claude', ['--resume']]]) {
    runs.length = 0;
    const env = { ...planner, ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' };
    assert.equal(await shim().intercept([agent, '--', ...args], { env, cwd: root, stdout: output(), stderr: output(), locate, launch,
      dispatch: () => assert.fail('a pass-through ran the helper') }), 7, `${agent} ${args.join(' ')}`);
    assert.deepEqual(runs.map(run => [run.file, run.args, run.options.stdio, run.options.cwd]), [[`real-${agent}`, args, 'inherit', root]]);
    assert.equal(runs[0].options.env.KEEP, 'yes'); assert.equal(runs[0].options.env.ELECTRON_RUN_AS_NODE, undefined, 'the launcher\'s Node switch stays behind');
  }
  for (const [agent, word] of [['codex', '--version'], ['codex', 'help'], ['claude', '-v'], ['claude', '--help']]) {
    runs.length = 0;
    assert.equal(await shim().intercept([agent, '--', word], { env: { AGENTRIX_DISPATCH_DEPTH: '1', AGENTRIX_RUN_ID: 'w', AGENTRIX_RUN_PROOF: 'p' },
      stdout: output(), stderr: output(), locate, launch }), 7);
    assert.deepEqual(runs[0].args, [word]);
  }
  const missing = output();
  assert.equal(await shim().intercept(['claude', '--', '--version'], { env: planner, stdout: output(), stderr: missing, locate: async () => null,
    launch: () => assert.fail('a bare claude was launched') }), 127);
  assert.match(missing.text, /claude was not found outside the Agentrix shim folder/);
  // A real child: inherited streams and its own exit status, without the launcher's ELECTRON_RUN_AS_NODE.
  const env = { ...process.env, ...planner, ELECTRON_RUN_AS_NODE: '1' };
  assert.equal(await shim().intercept(['claude', '--', '-e', 'process.exit(process.env.ELECTRON_RUN_AS_NODE ? 9 : 5)'], { env, cwd: temporary(t),
    stdout: output(), stderr: output(), locate: async () => process.execPath }), 5);
});

test('piped input joins a prompt argument as each CLI joins it', async () => {
  const brief = async (agent, args, piped) => {
    let text = null, asked;
    await shim().intercept([agent, '--', ...args], { env: planner, stdout: output(), stderr: output(), readInput: async options => { asked = options; return piped; },
      dispatch: async argv => { text = fs.readFileSync(argv[argv.indexOf('--brief') + 1], 'utf8'); return 1; } });
    return { text, asked };
  };
  assert.equal((await brief('codex', ['exec', 'analyse this'], 'log line\n')).text, 'analyse this\n\n<stdin>\nlog line\n</stdin>');
  assert.equal((await brief('codex', ['exec', 'analyse this'], 'no newline')).text, 'analyse this\n\n<stdin>\nno newline\n</stdin>');
  assert.equal((await brief('codex', ['exec', 'analyse this'], '')).text, 'analyse this');
  assert.equal((await brief('codex', ['exec', '-'], 'the whole brief')).text, 'the whole brief');
  const claude = await brief('claude', ['-p', 'analyse this'], 'log line\n');
  assert.equal(claude.text, 'analyse this\nlog line\n'); assert.deepEqual(claude.asked, { wait: 3000 }, 'Claude Code waits 3 s for a first piped byte');
  assert.equal((await brief('claude', ['-p', 'analyse this'], '')).text, 'analyse this');
  assert.deepEqual((await brief('claude', ['-p'], 'only piped')).asked, {});
});

test('a rerouted stdin call uses the helper, declares intercepted, and prints only its final message', async t => {
  const cwd = temporary(t), stdout = output(), stderr = output(); let called = 0;
  const code = await shim().intercept(['codex', '--', 'exec', '-m', 'test', '-o', 'answer.txt', '-'], {
    cwd, env: { ...planner, AGENTRIX_LEAD_MODE: 'forged' }, stdout, stderr, readInput: async () => 'line one\nline two',
    dispatch: async (argv, deps) => {
      called++; assert.equal(deps.source, 'intercepted'); assert.equal(deps.stdout, stderr);
      assert.equal(argv[0], 'codex'); const value = flag => argv[argv.indexOf(flag) + 1];
      assert.equal(fs.readFileSync(value('--brief'), 'utf8'), 'line one\nline two');
      assert.equal(value('--cwd'), cwd); assert.equal(argv.includes('--allow'), false);
      deps.stdout.write('[dispatch] started synthetic\n'); fs.writeFileSync(value('--out'), 'Only the final answer.\n'); return 0;
    },
  });
  assert.equal(code, 0); assert.equal(called, 1); assert.equal(stdout.text, 'Only the final answer.\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'answer.txt'), 'utf8'), stdout.text);
  assert.match(stderr.text, /started synthetic/);
  assert.deepEqual(fs.readdirSync(cwd), ['answer.txt'], 'private brief, log and result files are cleaned');
});

test("helper failures become exit one and cannot mix dispatch reports into stdout; a failed cleanup keeps a printed answer's exit zero", async t => {
  const stdout = output(), stderr = output();
  assert.equal(await shim().intercept(['claude', '--', '-p', 'prompt'], { cwd: temporary(t), env: planner, stdout, stderr, readInput: async () => '',
    dispatch: async (_argv, deps) => { deps.stdout.write('[dispatch] failed to start synthetic\n'); return 37; } }), 1);
  assert.equal(stdout.text, ''); assert.match(stderr.text, /failed to start/);
  const answered = output(), reports = output(), remove = fs.rmSync;
  t.mock.method(fs, 'rmSync', (folder, options) => {
    if (path.basename(folder).startsWith('agentrix-intercept-')) { remove(folder, options); throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }
    return remove(folder, options);
  });
  assert.equal(await shim().intercept(['claude', '--', '-p', 'prompt'], { env: planner, stdout: answered, stderr: reports, readInput: async () => '',
    dispatch: async argv => { fs.writeFileSync(argv[argv.indexOf('--out') + 1], 'The answer.\n'); return 0; } }), 0);
  assert.equal(answered.text, 'The answer.\n'); assert.match(reports.text, /intercept cleanup failed/);
});

test('withShims preserves the caller environment and sets one PATH, depth and opaque run identity', () => {
  const before = { Path: 'real-tools', PATH: 'duplicate', AGENTRIX_RUN_ID: 'old', AGENTRIX_RUN_PROOF: 'old-proof' };
  const next = shim().withShims(before, { depth: 1, runId: 'worker-id', proof: 'opaque-proof' });
  assert.equal(before.Path, 'real-tools'); assert.equal(next.AGENTRIX_DISPATCH_DEPTH, '1');
  assert.equal(next.AGENTRIX_RUN_ID, 'worker-id'); assert.equal(next.AGENTRIX_RUN_PROOF, 'opaque-proof');
  assert.equal(Object.keys(next).filter(key => key.toUpperCase() === 'PATH').length, 1);
  assert.equal(next.Path.split(path.delimiter)[0], shims);
  const owner = shim().withShims(next, { depth: 0 });
  assert.equal(owner.AGENTRIX_RUN_ID, undefined); assert.equal(owner.AGENTRIX_RUN_PROOF, undefined);
  assert.equal(owner.Path.split(path.delimiter).filter(folder => folder === shims).length, 1);
});

test("withShims adds start-up hooks that run the user's own first and never chain to themselves", () => {
  const first = shim().withShims({ PATH: 'tools', BASH_ENV: 'user-bash-env', ZDOTDIR: 'user-zdotdir' }, { depth: 0 });
  assert.equal(first.AGENTRIX_SHIMS, posix(shims));
  assert.equal(first.BASH_ENV, `${posix(shims)}/hooks/bash-env.sh`); assert.equal(first.AGENTRIX_SHIM_USER_BASH_ENV, 'user-bash-env');
  assert.equal(first.ZDOTDIR, `${posix(shims)}/hooks/zsh`); assert.equal(first.AGENTRIX_SHIM_USER_ZDOTDIR, 'user-zdotdir');
  assert.equal(first.CLAUDE_ENV_FILE, undefined, 'without a session there is no Claude Code hook, and never the installed one');
  const worker = shim().withShims(first, { depth: 1, runId: 'w', proof: 'p' });
  assert.equal(worker.AGENTRIX_SHIM_USER_BASH_ENV, 'user-bash-env', 'a worker keeps the owner\'s hook, not Agentrix\'s own');
  assert.equal(worker.AGENTRIX_SHIM_USER_ZDOTDIR, 'user-zdotdir');
  for (const file of ['hooks/path.sh', 'hooks/bash-env.sh', 'hooks/claude-env.sh', 'hooks/zsh/phase.zsh', 'hooks/zsh/.zshenv', 'hooks/zsh/.zlogin']) {
    assert.ok(fs.existsSync(path.join(shims, file)), file);
  }
  const words = shim().shimWords({ PATH: 'tools', AGENTRIX_RUN_ID: 'stale', KEEP: 'same' }, { depth: 0 });
  assert.deepEqual(words.slice(0, 2), ['-u', 'AGENTRIX_RUN_ID']);
  assert.ok(words.includes(`PATH=${[shims, 'tools'].join(path.delimiter)}`)); assert.ok(words.includes('AGENTRIX_DISPATCH_DEPTH=0'));
  assert.equal(words.some(word => word.startsWith('KEEP=')), false, 'only what changes is named');
});

// G13. Codex runs tool commands through bash -lc or zsh -lc, and Claude Code's Bash tool restores a snapshot of the PATH the
// user's start-up files built; a profile that puts a real CLI folder first must not win inside a planner.
for (const kind of ['bash', 'zsh']) test(`G13: through a real ${kind} login shell whose profile puts a stand-in CLI first, a planner's codex exec and claude -p reach the intercept path while the same call outside a planner runs the stand-in`, {
  skip: !shellFor(kind) && `${kind} is not installed here`, timeout: 60000,
}, t => {
  const folder = temporary(t), home = path.join(folder, 'home'), standin = path.join(folder, 'stand-in');
  fs.mkdirSync(home); fs.mkdirSync(standin);
  for (const agent of ['codex', 'claude']) fs.writeFileSync(path.join(standin, agent), `#!/bin/sh\necho "STAND-IN ${agent} $*"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, kind === 'bash' ? '.bash_profile' : '.zprofile'), `export PATH="${posix(standin)}:$PATH"\n`);
  const owner = isolatedEnvironment(home), bootstrap = sessionBootstrap(folder).file;
  const plannerEnv = shim().withShims({ ...owner, AGENTRIX_BOOTSTRAP: bootstrap }, { depth: 0 });
  const run = (env, script, login = true) => spawnSync(shellFor(kind), [login ? '-lc' : '-c', script], { cwd: folder, env, encoding: 'utf8', timeout: 30000 });
  for (const [agent, call, option] of [['codex', 'codex exec --json "analyse"', '--json'], ['claude', 'claude -p --output-format json "analyse"', '--output-format']]) {
    const inside = run(plannerEnv, call);
    assert.equal(inside.status, 2, `${agent}: ${inside.stdout}${inside.stderr}`); assert.equal(inside.stdout, '');
    assert.match(inside.stderr, new RegExp(`not run: ${option} is not supported through the Agentrix dispatcher`));
    const outside = run(owner, call);
    assert.equal(outside.status, 0, outside.stderr); assert.match(outside.stdout, new RegExp(`^STAND-IN ${agent} `));
  }
  // Claude Code's Bash tool: the snapshot's PATH, then CLAUDE_ENV_FILE's text, then the command.
  const tool = run(plannerEnv, `export PATH="${posix(standin)}:$PATH" && ${fs.readFileSync(plannerEnv.CLAUDE_ENV_FILE, 'utf8').trim()}\n: && claude -p --output-format json "x"`, false);
  assert.equal(tool.status, 2, tool.stdout + tool.stderr); assert.match(tool.stderr, /not run: --output-format is not supported/);
});

test('bootstrap names the executable shim folder for terminal and native owner sessions', t => {
  const file = path.join(temporary(t), 'bootstrap.json');
  require('../electron/features/terminal-events/bootstrap-file.cjs').writeBootstrap({ file, eventServer: { name: 'test-pipe', address: '/test-pipe' },
    projectId: 'test', projectPath: root, sessionKey: 'synthetic' });
  const bootstrap = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(bootstrap.shims, shims); assert.equal(bootstrap.nodePath, process.execPath);
});

test('a native owner receives shim depth zero while account reads remain without interception', t => {
  const folder = temporary(t), { file: bootstrapFile, claudeEnvFile } = sessionBootstrap(folder);
  const { nativeEnvironment } = require('../electron/features/native-session/host-inputs.cjs').createHostInputs({
    withoutAppImage: env => env, createTerminalEnvironment: (_env, bootstrap) => require('../electron/terminal-env.cjs').createTerminalEnvironment({
      PATH: 'tools', AGENTRIX_RUN_ID: 'stale', AGENTRIX_RUN_PROOF: 'stale' }, bootstrap),
  });
  const env = nativeEnvironment(bootstrapFile, 'test-codex-home');
  assert.equal(env.PATH.split(path.delimiter)[0], shims);
  assert.equal(env.AGENTRIX_DISPATCH_DEPTH, '0'); assert.equal(env.AGENTRIX_RUN_ID, undefined); assert.equal(env.CODEX_HOME, 'test-codex-home');
  assert.equal(env.CLAUDE_ENV_FILE, claudeEnvFile);
  assert.equal(nativeEnvironment('').AGENTRIX_DISPATCH_DEPTH, undefined);
  // The owner's own ! commands: the same session env without the shims.
  const owner = nativeEnvironment(bootstrapFile, 'test-codex-home', { planner: false });
  assert.deepEqual(Object.keys(owner).filter(key => /^(?:AGENTRIX_(?:SHIM|DISPATCH_DEPTH|RUN_)|BASH_ENV$|CLAUDE_ENV_FILE$|ZDOTDIR$)/.test(key)), []);
  assert.equal(owner.PATH, 'tools'); assert.equal(owner.CODEX_HOME, 'test-codex-home');
});

test('interactive wrappers read bootstrap shims, keep real CLI lookup outside that folder, and give the shims only to the Claude Code they start', () => {
  for (const name of ['integration/bootstrap.ps1', 'integration/bash-integration.bash', 'integration/zsh-integration.zsh']) {
    const text = read(name);
    assert.match(text, /\.shims|\[.?shims.?\]/); assert.match(text, /--shim-env/);
    assert.match(text, /\.agentrix-shims|__pg_shims/, `${name} excludes shims when an owner wrapper resolves the CLI`);
    assert.doesNotMatch(text, /export PATH=|\$env:Path\s*=/, `${name} leaves the terminal's own PATH alone`);
  }
});

// The terminal's own PATH stays clean; only the Claude Code its wrapper starts is a planner.
const probe = `const p=require('path');process.stdout.write('PLANNER='+JSON.stringify({first:(process.env.PATH||process.env.Path).split(p.delimiter)[0],depth:process.env.AGENTRIX_DISPATCH_DEPTH,hook:process.env.CLAUDE_ENV_FILE})+'\\n')`;
for (const kind of ['bash', 'zsh']) test(`the ${kind} terminal's PATH has no shims and the claude it starts has them first at depth zero`, {
  skip: process.platform === 'win32' ? `${kind}-integration runs in Linux and macOS terminals only` : !findShell(kind) && `${kind} is not installed here`, timeout: 60000,
}, t => {
  const folder = temporary(t), home = path.join(folder, 'home'), claude = path.join(folder, 'claude');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(folder, 'probe.cjs'), probe);
  fs.writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${path.join(folder, 'probe.cjs')}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(folder, 'event.cjs'), '');
  const { claudeEnvFile } = sessionBootstrap(folder);
  const env = { ...isolatedEnvironment(home), AGENTRIX_BOOTSTRAP: path.join(folder, 'bootstrap.json'), AGENTRIX_NODE: process.execPath,
    AGENTRIX_EVENT_HELPER: path.join(folder, 'event.cjs'), AGENTRIX_CLAUDE_EXECUTABLE: claude, AGENTRIX_DISPATCH_DEPTH: '0' };
  const script = `${kind === 'zsh' ? 'source "$1" zshrc' : 'source "$1"'}\nprintf 'SHELL=%s|%s\\n' "\${PATH%%:*}" "\${AGENTRIX_DISPATCH_DEPTH-unset}"\nclaude -p x\n`;
  const result = spawnSync(findShell(kind), [...(kind === 'bash' ? ['--noprofile', '--norc'] : ['-f']), '-c', script, kind, path.join(root, `integration/${kind}-integration.${kind}`)],
    { cwd: folder, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const [first, depth] = /SHELL=(.*)\|(.*)/.exec(result.stdout).slice(1);
  assert.notEqual(first, shims); assert.equal(depth, 'unset');
  assert.deepEqual(JSON.parse(/PLANNER=(.*)/.exec(result.stdout)[1]), { first: shims, depth: '0', hook: claudeEnvFile });
});

test("the PowerShell terminal's PATH has no shims and the claude it starts has them first at depth zero, put back once it exits", { skip: process.platform !== 'win32' && 'bootstrap.ps1 runs in Windows terminals only', timeout: 60000 }, t => {
  const folder = temporary(t), copied = path.join(folder, 'integration'), claude = path.join(folder, 'claude.cmd');
  const quoted = file => `'${file.replace(/'/g, "''")}'`;
  fs.mkdirSync(copied); fs.copyFileSync(path.join(root, 'integration/bootstrap.ps1'), path.join(copied, 'bootstrap.ps1'));
  // A stand-in refresh-path.ps1, so this computer's stored PATH is never read.
  fs.writeFileSync(path.join(copied, 'refresh-path.ps1'), '');
  fs.writeFileSync(path.join(folder, 'probe.cjs'), probe);
  fs.writeFileSync(claude, `@"${process.execPath}" "${path.join(folder, 'probe.cjs')}"\r\n`);
  const { claudeEnvFile } = sessionBootstrap(folder);
  const script = path.join(folder, 'probe.ps1');
  fs.writeFileSync(script, `$env:AGENTRIX_AGENT_ONLY='1'\n. ${quoted(path.join(copied, 'bootstrap.ps1'))}\nfunction Show { Write-Output ("SHELL=" + ($env:Path -split ';')[0] + "|" + $(if ($env:AGENTRIX_DISPATCH_DEPTH) { $env:AGENTRIX_DISPATCH_DEPTH } else { 'unset' })) }\nShow\nclaude -p x\nShow\n`);
  const env = { ...isolatedEnvironment(folder), AGENTRIX_BOOTSTRAP: path.join(folder, 'bootstrap.json'), AGENTRIX_CLAUDE_EXECUTABLE: claude,
    AGENTRIX_DISPATCH_DEPTH: '0', PSModuleAnalysisCachePath: path.join(folder, 'module-cache') };
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { cwd: folder, env, encoding: 'utf8', timeout: 45000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const shells = [...result.stdout.matchAll(/SHELL=(.*)\|(.*)/g)].map(match => [match[1].trim(), match[2].trim()]);
  assert.equal(shells.length, 2, result.stdout);
  for (const [first, depth] of shells) { assert.notEqual(first.toLowerCase(), shims.toLowerCase()); assert.equal(depth, 'unset'); }
  const planned = JSON.parse(/PLANNER=(.*)/.exec(result.stdout)[1]);
  assert.equal(planned.first.toLowerCase(), shims.toLowerCase()); assert.equal(planned.depth, '0'); assert.equal(planned.hook, claudeEnvFile);
});

// Two Agentrix installs: copies of the shim folder, as beta beside stable or a GUI check that a worker launches has.
function shimCopy(folder, name) {
  const target = path.join(folder, name);
  for (const file of [...Object.keys(shim().shimFiles()), 'intercept.cjs', ...Object.keys(shim().hookFiles())]) {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true }); fs.copyFileSync(path.join(shims, file), path.join(target, file));
  }
  return { folder: target, module: require(path.join(target, 'intercept.cjs')) };
}

test("a planner inside another Agentrix's planner keeps the user's own hooks: bash runs the user's BASH_ENV once and never a hook as the user's", {
  skip: !shellFor('bash') && 'bash is not installed here', timeout: 60000,
}, t => {
  const folder = temporary(t), home = path.join(folder, 'home'), log = path.join(folder, 'ran.log'), user = path.join(folder, 'user-env.sh');
  fs.mkdirSync(home); fs.writeFileSync(user, `echo user >> "${posix(log)}"\n`);
  const a = shimCopy(folder, 'a'), b = shimCopy(folder, 'b');
  const outer = a.module.withShims({ ...isolatedEnvironment(home), BASH_ENV: posix(user), ZDOTDIR: 'user-zdotdir' }, { depth: 0 });
  const inner = b.module.withShims(outer, { depth: 1, runId: 'w', proof: 'p' });
  assert.equal(inner.BASH_ENV, `${posix(b.folder)}/hooks/bash-env.sh`);
  assert.equal(inner.AGENTRIX_SHIM_USER_BASH_ENV, posix(user), "the other folder's hook is not saved as the user's");
  assert.equal(inner.AGENTRIX_SHIM_USER_ZDOTDIR, 'user-zdotdir');
  const run = env => spawnSync(shellFor('bash'), ['-c', 'printf "%s" "${PATH%%:*}"'], { cwd: folder, env, encoding: 'utf8', timeout: 30000 });
  const result = run(inner);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, posix(b.folder));
  assert.equal(fs.readFileSync(log, 'utf8'), 'user\n');
  // A "user" hook that is an Agentrix hook, this folder's own or the other's, is never sourced, so bash cannot recurse.
  fs.rmSync(log);
  for (const hook of [inner.BASH_ENV, outer.BASH_ENV]) {
    const looped = run({ ...inner, AGENTRIX_SHIM_USER_BASH_ENV: hook });
    assert.equal(looped.status, 0, looped.stderr); assert.equal(looped.stdout, posix(b.folder)); assert.equal(fs.existsSync(log), false);
  }
});

test("an owner terminal started inside a planner has no shim variables and the user's own BASH_ENV, ZDOTDIR and CLAUDE_ENV_FILE back", t => {
  const { createTerminalEnvironment } = require('../electron/terminal-env.cjs'), { zshEnvironment } = require('../electron/zsh-terminal.cjs');
  const { file } = sessionBootstrap(temporary(t));
  const user = { PATH: ['tools', 'more-tools'].join(path.delimiter), BASH_ENV: 'user-bash-env', ZDOTDIR: 'user-zdotdir', CLAUDE_ENV_FILE: 'user-claude-env' };
  const planner = shim().withShims(shim().withShims({ ...user, AGENTRIX_BOOTSTRAP: file }, { depth: 0 }), { depth: 1, runId: 'w', proof: 'p' });
  const terminal = createTerminalEnvironment(planner, 'next-bootstrap.json');
  assert.deepEqual(Object.keys(terminal).filter(key => /^AGENTRIX_(?:SHIM|DISPATCH_DEPTH|RUN_)/.test(key)), []);
  for (const [key, value] of Object.entries(user)) assert.equal(terminal[key], value, key);
  assert.equal(zshEnvironment(terminal, { folder: 'agentrix-zsh-stubs' }).AGENTRIX_USER_ZDOTDIR, 'user-zdotdir');
  const none = createTerminalEnvironment(shim().withShims({ PATH: 'tools' }, { depth: 0 }), 'next-bootstrap.json');
  assert.deepEqual(['BASH_ENV', 'ZDOTDIR', 'CLAUDE_ENV_FILE'].filter(key => key in none), [], 'hooks the user never had are gone');
});

test("a planner's CLAUDE_ENV_FILE is the session's private copy: appending to it leaves the installed hook as it was, and it goes with the session", t => {
  const folder = temporary(t), installed = path.join(shims, 'hooks/claude-env.sh'), original = fs.readFileSync(installed);
  const { file, claudeEnvFile } = sessionBootstrap(folder);
  const env = shim().withShims({ PATH: 'tools', AGENTRIX_BOOTSTRAP: file }, { depth: 0 });
  assert.equal(env.CLAUDE_ENV_FILE, claudeEnvFile); assert.match(path.relative(shims, claudeEnvFile), /^\.\./);
  assert.deepEqual(fs.readFileSync(claudeEnvFile), original);
  if (process.platform !== 'win32') assert.equal(fs.statSync(claudeEnvFile).mode & 0o777, 0o600);
  fs.appendFileSync(env.CLAUDE_ENV_FILE, 'export FROM_A_SESSION_START_HOOK=1\n');
  assert.deepEqual(fs.readFileSync(installed), original);
  assert.equal(shim().withShims(env, { depth: 1, runId: 'w', proof: 'p' }).CLAUDE_ENV_FILE, claudeEnvFile, "a worker keeps its planner's copy");
  bootstraps().removeBootstrap(file);
  assert.deepEqual([file, claudeEnvFile].filter(name => fs.existsSync(name)), []);
});

test('a terminal switched to native mode gets the planner env of a native session started directly, and the owner env for ! commands', t => {
  const { defineMain } = require('./helpers/main-modules.cjs');
  const folder = temporary(t), { file } = sessionBootstrap(folder);
  const context = defineMain({ process, sessions: new Map([['t', { sessionId: 's' }]]), nativeSpecs: new Map(), disposeTerminal() {},
    eventServer: { name: 'agentrix-test-unused', address: path.join(folder, 'unused.sock') }, controlAddress: null, withoutAppImage: env => env,
    createTerminalEnvironment: require('../electron/terminal-env.cjs').createTerminalEnvironment }, 'activateNative', 'observeSwitchTerminal', 'nativeEnvironment', 'writeBootstrap');
  const spec = { terminalId: 't', sessionId: 's', bootstrapFile: file, cwd: folder, sessionKey: 'k', env: { PATH: 'terminal-usage-env' } };
  context.activateNative(spec, null, {});
  const first = env => (env.PATH || env.Path).split(path.delimiter)[0];
  assert.equal(first(spec.env), shims); assert.equal(spec.env.AGENTRIX_DISPATCH_DEPTH, '0');
  assert.notEqual(first(spec.shellEnv), shims); assert.equal(spec.shellEnv.AGENTRIX_DISPATCH_DEPTH, undefined);
});

// An owner's ! command in a native Codex session: thread/shellCommand runs the text in the thread's shell, started by an
// app-server with the planner's env, the way Codex does (POSIX shells with -lc, PowerShell with -Command).
const shells = () => [
  ...['bash', 'zsh'].filter(kind => shellFor(kind)).map(kind => ({ kind, run: (text, env, cwd) => spawnSync(shellFor(kind), ['-lc', text], { cwd, env, encoding: 'utf8', timeout: 30000 }) })),
  ...(process.platform === 'win32' ? [{ kind: 'powershell', run: (text, env, cwd) => spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', text], { cwd, env, encoding: 'utf8', timeout: 30000, windowsHide: true }) }] : []),
];
test("an owner's ! command in a native Codex session runs the real CLI: the line ownerShellCommand puts first takes the planner's shims out in the thread's shell", { timeout: 120000 }, t => {
  const { ownerShellCommand } = require('../electron/shared/agentrix-shims.cjs');
  const folder = temporary(t), home = path.join(folder, 'home'), standin = path.join(folder, 'stand-in'), user = path.join(folder, 'user-env.sh');
  fs.mkdirSync(home); fs.mkdirSync(standin); fs.writeFileSync(user, ':\n');
  fs.writeFileSync(path.join(standin, 'claude'), '#!/bin/sh\necho "STAND-IN claude $*"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(standin, 'claude.cmd'), '@echo STAND-IN claude %*\r\n');
  const owner = isolatedEnvironment(home), key = Object.keys(owner).find(name => name.toUpperCase() === 'PATH');
  // The stand-in comes first on the owner's PATH, so no installed CLI can answer; the planner's shims go before it.
  owner[key] = [standin, owner[key]].join(path.delimiter); owner.BASH_ENV = posix(user);
  const planner = shim().withShims({ ...owner, AGENTRIX_BOOTSTRAP: sessionBootstrap(folder).file }, { depth: 0 });
  assert.ok(shells().length, 'a shell to run the owner command in');
  for (const shell of shells()) {
    const powershell = shell.kind === 'powershell';
    const typed = powershell ? `claude -p --output-format json 'it''s x'; Write-Output "D=$env:AGENTRIX_DISPATCH_DEPTH B=$env:BASH_ENV"`
      : `claude -p --output-format json "it's x"; echo "D=\${AGENTRIX_DISPATCH_DEPTH-} B=\${BASH_ENV-}"`;
    const result = shell.run(ownerShellCommand(typed, planner, powershell ? 'win32' : 'posix'), planner, folder);
    assert.equal(result.status, 0, `${shell.kind}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^STAND-IN claude -p --output-format json .*it's x/m, shell.kind);
    assert.ok(result.stdout.split(/\r?\n/).includes(`D= B=${posix(user)}`), `${shell.kind} drops the depth and gives the user's BASH_ENV back: ${result.stdout}`);
    if (powershell) continue;
    const planned = shell.run(typed, planner, folder);
    // Without the line the same text is a planner's call: the shim refuses it and no stand-in runs.
    assert.doesNotMatch(planned.stdout, /STAND-IN/, shell.kind); assert.match(planned.stderr, /not run: --output-format is not supported/, shell.kind);
  }
  assert.equal(ownerShellCommand('claude -p x', { PATH: 'tools' }), 'claude -p x', 'a session without shims runs the text as typed');
});

test("a hook skips a user's file only when it is an Agentrix hook by where it is, not for its first line alone", { skip: !shellFor('bash') && 'bash is not installed here', timeout: 60000 }, t => {
  const folder = temporary(t), log = path.join(folder, 'ran.log'), copy = path.join(folder, 'session-claude-env.sh'), own = path.join(folder, 'own.sh');
  const marked = path.join(folder, 'marked'), inShims = path.join(marked, 'hooks', 'mine.sh');
  fs.mkdirSync(path.dirname(inShims), { recursive: true }); fs.writeFileSync(path.join(marked, '.agentrix-shims'), '');
  for (const file of [own, copy, inShims]) fs.writeFileSync(file, `# Agentrix hook lookalike\necho ${path.basename(file)} >> "${posix(log)}"\n`);
  const source = file => spawnSync(shellFor('bash'), ['--noprofile', '--norc', '-c', `__agx_user="${posix(file)}"; . "${posix(path.join(shims, 'hooks/path.sh'))}"`],
    { cwd: folder, env: { ...isolatedEnvironment(folder), AGENTRIX_SHIMS: '' }, encoding: 'utf8', timeout: 30000 });
  for (const file of [own, copy, inShims]) assert.equal(source(file).status, 0);
  assert.equal(fs.readFileSync(log, 'utf8'), 'own.sh\n', "the user's own file runs whatever its first line; a session copy and a file in a shim folder never do");
});

test('withoutShims also puts back a hook variable that still names an Agentrix hook after AGENTRIX_SHIMS was lost', t => {
  const { withoutShims } = require('../electron/shared/agentrix-shims.cjs');
  const { claudeEnvFile } = sessionBootstrap(temporary(t));
  const lost = { PATH: 'tools', BASH_ENV: `${posix(shims)}/hooks/bash-env.sh`, AGENTRIX_SHIM_USER_BASH_ENV: 'user-bash-env', ZDOTDIR: `${posix(shims)}/hooks/zsh`,
    CLAUDE_ENV_FILE: claudeEnvFile };
  const clean = withoutShims(lost);
  assert.equal(clean.BASH_ENV, 'user-bash-env'); assert.equal('ZDOTDIR' in clean, false); assert.equal('CLAUDE_ENV_FILE' in clean, false);
  assert.equal('AGENTRIX_SHIM_USER_BASH_ENV' in clean, false);
  assert.deepEqual(withoutShims({ BASH_ENV: 'user-bash-env', ZDOTDIR: 'user-zdotdir' }), { BASH_ENV: 'user-bash-env', ZDOTDIR: 'user-zdotdir' }, "the user's own values stay");
});
