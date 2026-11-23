const { dispatchEnvironment } = require('./fixtures/team-isolation.cjs');
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
function sessionBootstrap(folder, mode = {}) {
  const file = path.join(folder, 'bootstrap.json');
  bootstraps().writeBootstrap({ file, eventServer: { name: 'agentrix-test-unused', address: path.join(folder, 'unused.sock') }, projectId: 't',
    projectPath: folder, sessionKey: 'k', ...mode });
  return { file, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}
const posix = file => process.platform === 'win32' ? file.replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()).replace(/\\/g, '/') : file;
// The tool server a lead's Claude Code is told to start, read back from the one word that gives it the role tools.
function toolServer(word) {
  assert.match(word, /^--mcp-config=\{/, 'the config is part of the option word, so no word after it is taken for a config');
  return JSON.parse(word.slice('--mcp-config='.length)).mcpServers.agentrix;
}

test('Claude role arguments use the carried seat reader without loading dispatch and survive a reader failure', async t => {
  const folder = temporary(t), shimFile = path.join(folder, 'shims', 'intercept.cjs');
  const helper = path.join(folder, 'dispatch.cjs'), bootstrap = path.join(folder, 'bootstrap.json');
  const seatFile = path.join(folder, 'electron', 'features', 'agents', 'call-seat.cjs');
  fs.mkdirSync(path.dirname(shimFile), { recursive: true });
  fs.mkdirSync(path.dirname(seatFile), { recursive: true });
  fs.copyFileSync(path.join(shims, 'intercept.cjs'), shimFile);
  fs.writeFileSync(helper, 'throw new Error("dispatch must not load");\n');
  fs.writeFileSync(bootstrap + '.lead', 'sonnet\nlow\n0\nnull\n');
  const { intercept } = require(shimFile);
  const env = { ...planner, AGENTRIX_BOOTSTRAP: bootstrap };
  async function launchWords() {
    let words;
    const code = await intercept(['claude', '--', 'review this'], { env, locate: async () => 'fake-claude', launch: (_file, args) => {
      words = args;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    } });
    assert.equal(code, 0);
    assert.deepEqual(words.slice(1), ['review this']);
    const [serverHelper, ...serverArgs] = toolServer(words[0]).args;
    return [fs.realpathSync.native(serverHelper), ...serverArgs];
  }
  const canonicalHelper = fs.realpathSync.native(helper);
  assert.deepEqual(await launchWords(), [canonicalHelper, 'mcp', 'claude']);
  fs.copyFileSync(path.join(root, 'electron/features/agents/call-seat.cjs'), seatFile);
  assert.deepEqual(await launchWords(), [canonicalHelper, 'mcp', 'claude', 'sonnet', 'low']);
});

test("a call without a planner's depth zero and bootstrap, or with a worker identity, is refused as nested before stdin or dispatch", async () => {
  const cases = [{}, { AGENTRIX_DISPATCH_DEPTH: '0' }, { AGENTRIX_BOOTSTRAP: 'b.json' }, ...['1', '2', '-1', '', ' 0', 'invalid'].map(depth => ({ ...planner, AGENTRIX_DISPATCH_DEPTH: depth })),
    { ...planner, AGENTRIX_RUN_ID: 'worker' }, { ...planner, AGENTRIX_RUN_PROOF: 'proof' }];
  for (const env of cases) for (const [agent, args] of [['codex', ['exec', '-']], ['claude', ['-p', 'x']], ['codex', ['mcp-server']], ['claude', ['mcp', 'serve']]]) {
    const stderr = output();
    assert.equal(await shim().intercept([agent, '--', ...args], { env, stdout: output(), stderr, readInput: () => assert.fail('nested call read stdin'),
      dispatch: () => assert.fail('nested call ran'), locate: () => assert.fail('nested call looked for a CLI') }), 2, JSON.stringify(env));
    assert.match(stderr.text, /a role cannot start another role/);
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
  // None of these opens a conversation, so none is given the role tools: the arguments reach the CLI as typed.
  for (const [agent, args] of [['codex', ['mcp-server']], ['claude', ['mcp', 'serve']], ['claude', ['--version']], ['codex', ['login', 'status']],
    ['codex', ['-m', 'x', 'login']], ['claude', ['update']], ['claude', ['--resume', '--help']]]) {
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
  // The stand-in is Node running a script file: a bare first word opens no conversation, so no role tools are added.
  const env = { ...dispatchEnvironment(), ...planner, ELECTRON_RUN_AS_NODE: '1' }, folder = temporary(t);
  fs.writeFileSync(path.join(folder, 'child.js'), 'process.exit(process.env.ELECTRON_RUN_AS_NODE ? 9 : 5)');
  assert.equal(await shim().intercept(['claude', '--', 'child.js'], { env, cwd: folder,
    stdout: output(), stderr: output(), locate: async () => process.execPath }), 5);
});

test('native mode runs a delegation on the real CLI and conductor mode refuses it; an interactive lead gets the role tools in both', async t => {
  const runs = [], launch = (file, args, options) => {
    const child = new EventEmitter(); runs.push({ file, args, options });
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  const locate = async agent => `real-${agent}`, folder = temporary(t);
  const env = mode => ({ ...planner, AGENTRIX_BOOTSTRAP: sessionBootstrap(folder, { conductor: mode === 'conductor' }).file, AGENTRIX_SHIM_NODE: 'node' });
  for (const [agent, args] of [['codex', ['exec', 'analyse']], ['claude', ['-p', 'analyse']]]) {
    runs.length = 0;
    assert.equal(await shim().intercept([agent, '--', ...args], { env: env('native'), cwd: root, stderr: output(), locate, launch }), 0);
    assert.deepEqual(runs.map(run => [run.file, run.args]), [[`real-${agent}`, args]], 'native mode is the plain CLI');
    runs.length = 0;
    const stderr = output();
    assert.equal(await shim().intercept([agent, '--', ...args], { env: env('conductor'), cwd: root, stderr, locate, launch }), 2);
    assert.equal(runs.length, 0); assert.match(stderr.text, /not run: in conductor mode a role starts with the start_role tool/);
  }
  runs.length = 0;
  await shim().intercept(['claude', '--', '--resume'], { env: env('conductor'), cwd: root, stderr: output(), locate, launch });
  const [config, ...rest] = runs[0].args;
  assert.deepEqual(rest, ['--resume']);
  const server = toolServer(config);
  assert.deepEqual([server.command, ...server.args.slice(1), server.env.ELECTRON_RUN_AS_NODE], ['node', 'mcp', 'claude', '1']);
  assert.ok(server.env.AGENTRIX_BOOTSTRAP, 'the tool server reads the session');
  runs.length = 0;
  await shim().intercept(['codex', '--', 'resume', '--last'], { env: env('conductor'), cwd: root, stderr: output(), locate, launch });
  assert.deepEqual(runs[0].args.filter((_, index) => index % 2 === 0).slice(0, 3), ['-c', '-c', '-c']);
  assert.match(runs[0].args[1], /^mcp_servers\.agentrix\.command="node"$/);
  assert.deepEqual(runs[0].args.slice(-2), ['resume', '--last']);
  for (const [agent, args] of [['codex', []], ['codex', ['-m', 'x', 'fix the test']], ['claude', []], ['claude', ['fix the test']], ['claude', ['-c']]]) {
    runs.length = 0;
    await shim().intercept([agent, '--', ...args], { env: env('native'), cwd: root, stderr: output(), locate, launch });
    assert.match(runs[0].args[0], agent === 'claude' ? /^--mcp-config=\{/ : /^-c$/, `${agent} ${args.join(' ')} opens a conversation`);
    // Claude Code's tools are one word, so a prompt right after them (claude "fix the test") stays the prompt.
    assert.deepEqual(runs[0].args.slice(agent === 'claude' ? 1 : 6), args);
  }
  runs.length = 0;
  await shim().intercept(['codex', '--', 'resume', '--last'], { env: env('native'), cwd: root, stderr: output(), locate, launch });
  assert.match(runs[0].args[1], /^mcp_servers\.agentrix\.command="node"$/, 'a lead started in native mode has the tools for a later switch');
  assert.deepEqual(runs[0].args.slice(-2), ['resume', '--last']);
});

test("one request answers a wrapper with the planner's words and, after a -- word, the role tools for a conversation; a print or utility call gets none", t => {
  const folder = temporary(t), { file } = sessionBootstrap(folder), seats = '{"developer":{"model":"m"}}';
  const owner = { ...isolatedEnvironment(folder), AGENTRIX_BOOTSTRAP: file, AGENTRIX_SEATS: seats, UNRELATED: 'stays out' };
  const ask = (words, source = owner) => {
    const result = spawnSync(process.execPath, [path.join(shims, 'intercept.cjs'), ...words], { cwd: folder, env: source, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const planner = shim().shimWords(owner, { depth: 0 }), request = ['--shim-env', 'json', '--role-tools'];
  const answer = JSON.parse(ask([...request, 'claude', 'fix the test'])), [tools, ...none] = answer.slice(planner.length + 1);
  assert.deepEqual(answer.slice(0, planner.length + 1), [...planner, '--']);
  assert.deepEqual(none, [], 'one word, so the prompt after it stays the prompt');
  assert.deepEqual(toolServer(tools), { type: 'stdio', command: process.execPath, args: [path.join(root, 'integration/dispatch.cjs'), 'mcp', 'claude'],
    env: { ELECTRON_RUN_AS_NODE: '1', AGENTRIX_BOOTSTRAP: file, AGENTRIX_SEATS: seats, AGENTRIX_DISPATCH_DEPTH: '0', AGENTRIX_SHIMS: posix(shims),
      AGENTRIX_SHIM_NODE: process.execPath, CODEX_HOME: owner.CODEX_HOME } });
  assert.deepEqual(ask(['--shim-env', '--role-tools', 'claude']).split('\0'), [...planner, '--', tools, ''], 'each word ends with NUL, so no shell splits the JSON');
  // PowerShell hands the request over in the environment, where a quoted word stays whole.
  const quoted = ask([], { ...owner, AGENTRIX_INTERCEPT_ARGV: JSON.stringify([...request, 'claude', 'say "hi" -p \\']) });
  assert.deepEqual(JSON.parse(quoted), [...planner, '--', tools]);
  const codex = JSON.parse(ask([...request, 'codex', 'resume', '--last'])).slice(planner.length + 1);
  assert.deepEqual(codex.filter((_, index) => index % 2 === 0), ['-c', '-c', '-c']);
  assert.equal(codex[1], `mcp_servers.agentrix.command=${JSON.stringify(process.execPath)}`);
  assert.equal(codex[3], `mcp_servers.agentrix.args=${JSON.stringify([path.join(root, 'integration/dispatch.cjs'), 'mcp', 'codex'])}`);
  for (const words of [['claude', '-p', 'x'], ['claude', '--print', 'x'], ['claude', '--version'], ['claude', 'mcp', 'list'], ['claude', 'update'],
    ['codex', 'exec', 'x'], ['other']]) assert.deepEqual(JSON.parse(ask([...request, ...words])), [...planner, '--'], words.join(' '));
  const { AGENTRIX_BOOTSTRAP: _, ...unbound } = owner;
  assert.equal(JSON.parse(ask([...request, 'claude'], unbound)).at(-1), '--', 'without a session there is no planner to serve');
  assert.deepEqual(JSON.parse(ask(['--shim-env', 'json'])), planner, 'a terminal opened before an update is answered as before');
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
  const owner = isolatedEnvironment(home), bootstrap = sessionBootstrap(folder, { conductor: true }).file;
  for (const name of Object.keys(owner)) if (name.toUpperCase() === 'PATH') delete owner[name];
  owner.PATH = systemPath(standin);
  const plannerEnv = shim().withShims({ ...owner, AGENTRIX_BOOTSTRAP: bootstrap }, { depth: 0 });
  const run = (env, script, login = true) => spawnSync(shellFor(kind), [login ? '-lc' : '-c', script], { cwd: folder, env, encoding: 'utf8', timeout: 30000 });
  for (const [agent, call, option] of [['codex', 'codex exec --json "analyse"', '--json'], ['claude', 'claude -p --output-format json "analyse"', '--output-format']]) {
    // Called by name: outside a planner the stand-in, inside it the shim, whatever the profile put first.
    const where = env => run(env, `command -v ${agent}`).stdout.trim();
    assert.ok(inStandIn(where(owner), folder), where(owner)); assert.ok(inShims(where(plannerEnv)), where(plannerEnv));
    const inside = run(plannerEnv, call);
    assert.equal(inside.status, 2, `${agent}: ${inside.stdout}${inside.stderr}`); assert.equal(inside.stdout, '');
    assert.match(inside.stderr, /not run: in conductor mode a role starts with the start_role tool/, option);
    const outside = run(owner, call);
    assert.equal(outside.status, 0, outside.stderr); assert.match(outside.stdout, new RegExp(`^STAND-IN ${agent} `));
  }
  // Claude Code's Bash tool: the snapshot's PATH, then CLAUDE_ENV_FILE's text, then the command.
  const tool = run(plannerEnv, `export PATH="${posix(standin)}:$PATH" && ${fs.readFileSync(plannerEnv.CLAUDE_ENV_FILE, 'utf8').trim()}\n: && claude -p --output-format json "x"`, false);
  assert.equal(tool.status, 2, tool.stdout + tool.stderr); assert.match(tool.stderr, /not run: in conductor mode a role starts with the start_role tool/);
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
const probe = `const p=require('path');process.stdout.write('PLANNER='+JSON.stringify({first:(process.env.PATH||process.env.Path).split(p.delimiter)[0],`
  + `depth:process.env.AGENTRIX_DISPATCH_DEPTH,hook:process.env.CLAUDE_ENV_FILE})+'\\nARGV='+JSON.stringify(process.argv.slice(2))+'\\n')`;
for (const kind of ['bash', 'zsh']) test(`the ${kind} terminal's PATH has no shims and the claude it starts has them first at depth zero`, {
  skip: process.platform === 'win32' ? `${kind}-integration runs in Linux and macOS terminals only` : !findShell(kind) && `${kind} is not installed here`, timeout: 60000,
}, t => {
  const folder = temporary(t), home = path.join(folder, 'home'), claude = path.join(folder, 'claude');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(folder, 'probe.cjs'), probe);
  fs.writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${path.join(folder, 'probe.cjs')}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(folder, 'event.cjs'), '');
  const { claudeEnvFile } = sessionBootstrap(folder);
  const env = { ...isolatedEnvironment(home), AGENTRIX_BOOTSTRAP: path.join(folder, 'bootstrap.json'), AGENTRIX_NODE: process.execPath,
    AGENTRIX_EVENT_HELPER: path.join(folder, 'event.cjs'), AGENTRIX_CLAUDE_EXECUTABLE: claude, AGENTRIX_DISPATCH_DEPTH: '0' };
  const script = `${kind === 'zsh' ? 'source "$1" zshrc' : 'source "$1"'}\nprintf 'SHELL=%s|%s\\n' "\${PATH%%:*}" "\${AGENTRIX_DISPATCH_DEPTH-unset}"\n`
    + `claude 'fix the test'\nclaude -p 'say "hi" \\'\nclaude --version\n__pg_node=/missing/node\nclaude 'fix it'\n`;
  const result = spawnSync(findShell(kind), [...(kind === 'bash' ? ['--noprofile', '--norc'] : ['-f']), '-c', script, kind, path.join(root, `integration/${kind}-integration.${kind}`)],
    { cwd: folder, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const [first, depth] = /SHELL=(.*)\|(.*)/.exec(result.stdout).slice(1);
  assert.notEqual(first, shims); assert.equal(depth, 'unset');
  assert.deepEqual(JSON.parse(/PLANNER=(.*)/.exec(result.stdout)[1]), { first: shims, depth: '0', hook: claudeEnvFile });
  // A conversation gets the role tools as one word, so with no settings, note or lead arguments between them the prompt is
  // still the prompt; their server gets the planner's environment. A print or utility call gets none, and when the helper
  // cannot run the CLI starts with the user's words alone.
  const [[tools, ...words], ...others] = [...result.stdout.matchAll(/ARGV=(.*)/g)].map(match => JSON.parse(match[1]));
  assert.deepEqual(words, ['fix the test']);
  const server = toolServer(tools).env;
  assert.deepEqual([server.AGENTRIX_BOOTSTRAP, server.AGENTRIX_DISPATCH_DEPTH, server.AGENTRIX_SHIMS, server.AGENTRIX_SHIM_NODE, server.AGENTRIX_SEATS],
    [env.AGENTRIX_BOOTSTRAP, '0', shims, process.execPath, 'null']);
  assert.deepEqual(others, [['-p', 'say "hi" \\'], ['--version'], ['fix it']]);
});

for (const extension of ['cmd', 'ps1']) test(`the PowerShell wrapper gives claude.${extension} one file-backed role option and restores its environment`, {
  skip: process.platform !== 'win32' && 'bootstrap.ps1 runs in Windows terminals only', timeout: 60000,
}, t => {
  const folder = temporary(t), copied = path.join(folder, 'integration'), claude = path.join(folder, `claude.${extension}`);
  const quoted = file => `'${file.replace(/'/g, "''")}'`;
  fs.mkdirSync(copied); fs.copyFileSync(path.join(root, 'integration/bootstrap.ps1'), path.join(copied, 'bootstrap.ps1'));
  // A stand-in refresh-path.ps1, so this computer's stored PATH is never read.
  fs.writeFileSync(path.join(copied, 'refresh-path.ps1'), '');
  const probeFile = path.join(folder, 'probe.cjs');
  fs.writeFileSync(probeFile, probe + `\nconst option=process.argv[2]; if (option?.startsWith('--mcp-config=')) {`
    + `console.log('CONFIG='+require('fs').readFileSync(option.slice('--mcp-config='.length)).toString('base64')); }\n`);
  fs.writeFileSync(claude, extension === 'cmd' ? `@"${process.execPath}" "${probeFile}" %*\r\n` : `& ${quoted(process.execPath)} ${quoted(probeFile)} @args\n`);
  const session = path.join(folder, 'session & tools');
  fs.mkdirSync(session);
  const { file: bootstrap, claudeEnvFile } = sessionBootstrap(session);
  const script = path.join(folder, 'probe.ps1');
  fs.writeFileSync(script, `$env:AGENTRIX_AGENT_ONLY='1'\n. ${quoted(path.join(copied, 'bootstrap.ps1'))}\n`
    + `function global:Send-AgentrixEvent {}\n`
    + `function Show { Write-Output ("SHELL=" + ($env:Path -split ';')[0] + "|" + $(if ($env:AGENTRIX_DISPATCH_DEPTH) { $env:AGENTRIX_DISPATCH_DEPTH } else { 'unset' })) }\n`
    + `Show\nclaude 'fix the test'\nclaude 'check my config' --mcp-config own.json\nclaude -p 'print this'\nclaude --version\nShow\n`);
  const env = { ...isolatedEnvironment(folder), AGENTRIX_BOOTSTRAP: bootstrap, AGENTRIX_CLAUDE_EXECUTABLE: claude,
    AGENTRIX_DISPATCH_DEPTH: '0', PSModuleAnalysisCachePath: path.join(folder, 'module-cache') };
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { cwd: folder, env, encoding: 'utf8', timeout: 45000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const shells = [...result.stdout.matchAll(/SHELL=(.*)\|(.*)/g)].map(match => [match[1].trim(), match[2].trim()]);
  assert.equal(shells.length, 2, result.stdout);
  for (const [first, depth] of shells) { assert.notEqual(first.toLowerCase(), shims.toLowerCase()); assert.equal(depth, 'unset'); }
  const planned = JSON.parse(/PLANNER=(.*)/.exec(result.stdout)[1]);
  assert.equal(planned.first.toLowerCase(), shims.toLowerCase()); assert.equal(planned.depth, '0'); assert.equal(planned.hook, claudeEnvFile);
  const [[option, ...prompt], [second, ...words], ...others] = [...result.stdout.matchAll(/ARGV=(.*)/g)].map(match => JSON.parse(match[1]));
  assert.deepEqual(prompt, ['fix the test']);
  assert.deepEqual(words, ['check my config', '--mcp-config', 'own.json']);
  assert.deepEqual(others, [['-p', 'print this'], ['--version']]);
  for (const word of [option, second]) {
    assert.match(word, /^--mcp-config=/);
    const file = word.slice('--mcp-config='.length);
    assert.equal(path.dirname(file), session);
    assert.equal(fs.existsSync(file), false, 'a completed launch removes its config');
  }
  assert.notEqual(option, second);
  const inline = spawnSync(process.execPath, [path.join(shims, 'intercept.cjs'), '--shim-env', 'json', '--role-tools', 'claude', 'fix the test'],
    { env: { ...env, AGENTRIX_SEATS: 'null' }, encoding: 'utf8' });
  assert.equal(inline.status, 0, inline.stderr);
  const expected = JSON.parse(inline.stdout).at(-1).slice('--mcp-config='.length);
  const configs = [...result.stdout.matchAll(/CONFIG=(.*)/g)].map(match => Buffer.from(match[1], 'base64'));
  assert.deepEqual(configs, [Buffer.from(expected), Buffer.from(expected)]);
});

// A stand-in claude.exe, which Windows PowerShell compiles: only an executable is started with exact arguments. Each run
// adds a line to the log beside it: its depth, then each argument in Base64.
const standInSource = `using System; using System.IO; using System.Text;
static class StandIn { static int Main(string[] args) {
  var line = new StringBuilder(Environment.GetEnvironmentVariable("AGENTRIX_DISPATCH_DEPTH"));
  foreach (var arg in args) line.Append(' ').Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(arg)));
  File.AppendAllText(System.Reflection.Assembly.GetExecutingAssembly().Location + ".log", line + "\\n");
  return 0; } }`;
test('the claude.exe the PowerShell wrapper starts for a conversation gets the role tools; a print or utility call gets none, and a helper that cannot run still launches', {
  skip: process.platform !== 'win32' && 'bootstrap.ps1 runs in Windows terminals only', timeout: 90000 }, t => {
  const folder = temporary(t), copied = path.join(folder, 'integration'), claude = path.join(folder, 'claude.exe'), script = path.join(folder, 'probe.ps1');
  const quoted = file => `'${file.replace(/'/g, "''")}'`;
  fs.mkdirSync(copied); fs.copyFileSync(path.join(root, 'integration/bootstrap.ps1'), path.join(copied, 'bootstrap.ps1'));
  // A stand-in refresh-path.ps1, so this computer's stored PATH is never read.
  fs.writeFileSync(path.join(copied, 'refresh-path.ps1'), '');
  fs.writeFileSync(path.join(folder, 'stand-in.cs'), standInSource);
  const { file: bootstrap } = sessionBootstrap(folder), seats = '{"developer":{"model":"m"}}';
  fs.writeFileSync(script, '﻿' + [`$env:AGENTRIX_AGENT_ONLY='1'`,
    `Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath ${quoted(path.join(folder, 'stand-in.cs'))}) -OutputAssembly ${quoted(claude)} -OutputType ConsoleApplication`,
    `. ${quoted(path.join(copied, 'bootstrap.ps1'))}`, 'function global:Send-AgentrixEvent {}',
    // Before the lead file: no settings, note or lead arguments stand between the role tools and the prompt.
    `claude 'fix the test'`, `[IO.File]::WriteAllLines($env:AGENTRIX_BOOTSTRAP + '.lead', @('sonnet', 'high', '0', '${seats}'))`,
    `claude 'say "hi" \\' --mcp-config own.json`, `claude -p 'say "hi"'`, 'claude --version', 'claude mcp list',
    `$global:AgentrixSession.nodePath = 'missing-node.exe'`, 'claude again', ''].join('\n'));
  const env = { ...isolatedEnvironment(folder), AGENTRIX_BOOTSTRAP: bootstrap, AGENTRIX_CLAUDE_EXECUTABLE: claude, PSModuleAnalysisCachePath: path.join(folder, 'module-cache') };
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { cwd: folder, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const runs = fs.readFileSync(claude + '.log', 'utf8').trimEnd().split('\n').map(line => line.split(' ').map((word, index) => index ? Buffer.from(word, 'base64').toString() : word));
  assert.equal(runs.length, 6, result.stdout + result.stderr);
  const [[first, bare, ...prompt], [depth, tools, ...words], ...others] = runs, lead = ['--model', 'sonnet', '--effort', 'high'];
  // One word, so the prompt right after it is still the prompt; the user's own --mcp-config stays where it was typed.
  assert.deepEqual([first, toolServer(bare).env.AGENTRIX_SEATS, prompt], ['0', 'null', ['fix the test']]);
  assert.deepEqual([depth, words], ['0', [...lead, 'say "hi" \\', '--mcp-config', 'own.json']]);
  const server = toolServer(tools);
  assert.deepEqual([server.command, server.args], [process.execPath, [path.join(root, 'integration/dispatch.cjs'), 'mcp', 'claude', 'sonnet', 'high']]);
  assert.deepEqual(server.env, { ELECTRON_RUN_AS_NODE: '1', AGENTRIX_BOOTSTRAP: bootstrap, AGENTRIX_SEATS: seats, AGENTRIX_DISPATCH_DEPTH: '0', AGENTRIX_SHIMS: posix(shims),
    AGENTRIX_SHIM_NODE: process.execPath, CODEX_HOME: env.CODEX_HOME });
  assert.deepEqual(others, [['0', ...lead, '-p', 'say "hi"'], ['0', '--version'], ['0', 'mcp', 'list'], ['', ...lead, 'again']]);
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
  const folder = fs.realpathSync(temporary(t)), home = path.join(folder, 'home');
  const log = path.join(folder, 'ran.log'), user = path.join(folder, 'user-env.sh');
  fs.mkdirSync(home); fs.writeFileSync(user, `echo user >> "${posix(log)}"\n`);
  const a = shimCopy(folder, 'a'), b = shimCopy(folder, 'b');
  const outer = a.module.withShims({ ...isolatedEnvironment(home), BASH_ENV: posix(user), ZDOTDIR: 'user-zdotdir' }, { depth: 0 });
  const inner = b.module.withShims(outer, { depth: 1, runId: 'w', proof: 'p' });
  assert.equal(inner.BASH_ENV, `${posix(b.folder)}/hooks/bash-env.sh`);
  assert.equal(inner.AGENTRIX_SHIM_USER_BASH_ENV, posix(user), "the other folder's hook is not saved as the user's");
  assert.equal(inner.AGENTRIX_SHIM_USER_ZDOTDIR, 'user-zdotdir');
  // A Unix socket on stdin can make Bash take its remote-shell startup path and skip BASH_ENV.
  const run = env => spawnSync(shellFor('bash'), ['-c', 'printf "%s" "${PATH%%:*}"'], {
    cwd: folder, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000,
  });
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
  assert.equal(env.CLAUDE_ENV_FILE, claudeEnvFile); assert.ok(outside(shims, claudeEnvFile), `${claudeEnvFile} is outside ${shims}`);
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
// Whether a resolved file is in this test's stand-in folder, however the shell spells the path (Git Bash may say /tmp/…).
const inStandIn = (file, folder) => file.replaceAll(path.win32.sep, '/').toLowerCase().includes('/' + path.basename(folder).toLowerCase() + '/stand-in/');
// Whether a shell resolved a name to the repository's shim folder, by its last two folder names: the shell may spell the
// drive or a short (8.3) name its own way.
const inShims = file => path.dirname(file.replaceAll(path.win32.sep, '/')).toLowerCase().endsWith('/integration/shims');
// Whether file lies outside folder, across drives and short (8.3) names: both resolved by the native realpath first.
function outside(folder, file) {
  const relative = path.relative(fs.realpathSync.native(folder), fs.realpathSync.native(file));
  return relative.startsWith('..') || path.isAbsolute(relative);
}
// System folders only, so a CLI called by name can only be the stand-in (or, in a planner, the shim).
function systemPath(standin) {
  if (process.platform !== 'win32') return [standin, '/usr/bin', '/bin'].join(':');
  const root = process.env.SystemRoot;
  return [standin, path.join(root, 'System32'), root, path.join(root, 'System32/WindowsPowerShell/v1.0')].join(';');
}
test("an owner's ! command in a native Codex session runs the real CLI: the line ownerShellCommand puts first takes the planner's shims out in the thread's shell", { timeout: 120000 }, t => {
  const { ownerShellCommand } = require('../electron/shared/agentrix-shims.cjs');
  const folder = temporary(t), home = path.join(folder, 'home'), standin = path.join(folder, 'stand-in'), user = path.join(folder, 'user-env.sh');
  fs.mkdirSync(home); fs.mkdirSync(standin); fs.writeFileSync(user, ':\n');
  fs.writeFileSync(path.join(standin, 'claude'), '#!/bin/sh\necho "STAND-IN claude $*"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(standin, 'claude.cmd'), '@echo STAND-IN claude %*\r\n');
  const owner = isolatedEnvironment(home);
  for (const name of Object.keys(owner)) if (name.toUpperCase() === 'PATH') delete owner[name];
  owner.PATH = systemPath(standin); owner.BASH_ENV = posix(user);
  const planner = shim().withShims({ ...owner, AGENTRIX_BOOTSTRAP: sessionBootstrap(folder, { conductor: true }).file }, { depth: 0 });
  assert.ok(shells().length, 'a shell to run the owner command in');
  for (const shell of shells()) {
    const powershell = shell.kind === 'powershell', kind = powershell ? 'powershell' : 'posix';
    // Before anything runs by name: behind the line, claude resolves to the stand-in.
    const resolved = shell.run(ownerShellCommand(powershell ? '(Get-Command claude).Source' : 'command -v claude', planner, kind), planner, folder);
    const where = resolved.stdout.trim().toLowerCase();
    assert.ok(inStandIn(where, folder), `${shell.kind} resolves claude to the stand-in: ${resolved.stdout}${resolved.stderr}`);
    const typed = powershell ? `claude -p --output-format json 'it''s x'; Write-Output "D=$env:AGENTRIX_DISPATCH_DEPTH B=$env:BASH_ENV"`
      : `claude -p --output-format json "it's x"; echo "D=\${AGENTRIX_DISPATCH_DEPTH-} B=\${BASH_ENV-}"`;
    const result = shell.run(ownerShellCommand(typed, planner, kind), planner, folder);
    assert.equal(result.status, 0, `${shell.kind}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^STAND-IN claude -p --output-format json .*it's x/m, shell.kind);
    assert.ok(result.stdout.split(/\r?\n/).includes(`D= B=${posix(user)}`), `${shell.kind} drops the depth and gives the user's BASH_ENV back: ${result.stdout}`);
    if (powershell) {
      // Constrained Language Mode: the line is skipped without error text, and the command still runs.
      const constrained = shell.run('$ExecutionContext.SessionState.LanguageMode = "ConstrainedLanguage"; ' + ownerShellCommand('Write-Output "ran"', planner, kind), planner, folder);
      assert.equal(constrained.status, 0); assert.equal(constrained.stderr, ''); assert.match(constrained.stdout, /^ran/m);
      continue;
    }
    const planned = shell.run(typed, planner, folder);
    // Without the line the same text is a planner's call: the shim refuses it and no stand-in runs.
    assert.doesNotMatch(planned.stdout, /STAND-IN/, shell.kind); assert.match(planned.stderr, /not run: in conductor mode a role starts with the start_role tool/, shell.kind);
  }
  assert.equal(ownerShellCommand('claude -p x', { PATH: 'tools' }, 'posix'), 'claude -p x', 'a session without shims runs the text as typed');
});

test('the owner-command line goes only to a shell it is written for: fish, cmd and an unknown login shell run the text as typed', () => {
  const { ownerShell, ownerShellCommand } = require('../electron/shared/agentrix-shims.cjs');
  const posixOf = (shell, env = {}) => ownerShell({ platform: 'linux', env, userShell: () => shell });
  for (const shell of ['/bin/bash', '/bin/zsh', '/bin/sh', '/usr/bin/dash', '/bin/ksh', '/opt/homebrew/bin/zsh']) assert.equal(posixOf(shell), 'posix', shell);
  for (const shell of ['/usr/bin/fish', '/opt/homebrew/bin/nu', '', null, undefined]) assert.equal(posixOf(shell), null, String(shell));
  assert.equal(ownerShell({ platform: 'darwin', env: {}, userShell: () => { throw new Error('no passwd entry'); } }), null);
  // A set SHELL must agree with passwd, in case Codex reads that one instead.
  assert.equal(posixOf('/bin/zsh', { SHELL: '/opt/homebrew/bin/fish' }), null, 'passwd zsh, SHELL fish');
  assert.equal(posixOf('/bin/zsh', { SHELL: '/bin/bash' }), 'posix');
  assert.equal(posixOf('/usr/bin/fish', { SHELL: '/bin/zsh' }), null, 'passwd fish, SHELL zsh');
  // PowerShell counts only where Codex looks for it: on the session's PATH.
  const system32 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
  const windows = (files, PATH = 'C:\\Tools') => ownerShell({ platform: 'win32', env: { SystemRoot: 'C:\\Windows', Path: PATH }, exists: file => files.includes(file) });
  assert.equal(windows([]), null, 'cmd only');
  assert.equal(windows([`${system32}\\powershell.exe`]), null, "System32's powershell.exe off the PATH is not enough");
  assert.equal(windows([`${system32}\\powershell.exe`], `C:\\Tools;${system32}`), 'powershell');
  assert.equal(windows(['C:\\PowerShell\\7\\pwsh.exe'], 'C:\\Tools;"C:\\PowerShell\\7"'), 'powershell');
  const planner = { AGENTRIX_SHIMS: '/agentrix/shims' };
  for (const shell of [null, 'fish', 'cmd']) assert.equal(ownerShellCommand('claude -p x', planner, shell), 'claude -p x', String(shell));
  assert.notEqual(ownerShellCommand('claude -p x', planner, 'posix'), 'claude -p x');
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
