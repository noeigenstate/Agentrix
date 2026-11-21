// Only a planner's environment has these shims on PATH: withShims puts the folder first for the Claude Code or Codex an owner
// starts and for every dispatched worker, and its hooks put it first again after the user's start-up files.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const SHIM_NAMES = ['.agentrix-shims', 'codex', 'codex.cmd', 'codex.ps1', 'claude', 'claude.cmd', 'claude.ps1'];
const ZSH_PHASES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin'];
const HOOK_FILES = ['hooks/path.sh', 'hooks/bash-env.sh', 'hooks/claude-env.sh', 'hooks/owner.sh', 'hooks/zsh/phase.zsh', ...ZSH_PHASES.map(name => `hooks/zsh/${name}`)];
// The CLIs' own runs that only print: a worker may still run them.
const HARMLESS = { codex: ['--version', '-V', '--help', '-h', 'help'], claude: ['--version', '-v', '--help', '-h'] };
// Codex's root options that take a value (codex --help, 0.169.0), so the subcommand after them can be found.
const CODEX_ROOT_VALUES = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image', '-m', '--model',
  '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval']);

function shimFiles() {
  // The SSH carrier accepts CJS modules only. Its launcher envelope is the same files, never a second implementation.
  if (!fs.existsSync(path.join(__dirname, 'codex'))) return require('./launchers.cjs');
  return Object.fromEntries(SHIM_NAMES.map(name => [name, fs.readFileSync(path.join(__dirname, name), 'utf8')]));
}

// The start-up hooks a packaged app installs beside the launchers. SSH shims are deferred, so they are not carried.
function hookFiles() { return Object.fromEntries(HOOK_FILES.map(name => [name, fs.readFileSync(path.join(__dirname, name), 'utf8')])); }

function runtimeFiles() {
  return { 'shims/intercept.cjs': fs.readFileSync(__filename, 'utf8'),
    'shims/launchers.cjs': `module.exports = ${JSON.stringify(shimFiles())};\n` };
}

// A folder as a POSIX shell names it: Git Bash spells C:\x as /c/x.
const shellFolder = folder => process.platform === 'win32' ? folder.replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()).replace(/\\/g, '/') : folder;

function withShims(source, { depth, runId, proof }) {
  if (!Number.isSafeInteger(depth) || depth < 0) throw new Error('Invalid dispatch depth');
  const env = { ...source }, key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') || 'PATH';
  const inherited = env[key] || '';
  for (const name of Object.keys(env)) if (name.toUpperCase() === 'PATH' || /^AGENTRIX_(?:DISPATCH_DEPTH|RUN_ID|RUN_PROOF|SHIM_NODE)$/i.test(name)) delete env[name];
  // SSH shims are deferred: a carried module without an installed marker never changes a remote worker's PATH.
  const installed = fs.existsSync(path.join(__dirname, '.agentrix-shims'));
  const same = folder => process.platform === 'win32' ? path.resolve(folder.replace(/^"|"$/g, '')).toLowerCase() === __dirname.toLowerCase() : folder === __dirname;
  env[key] = installed ? [__dirname, ...inherited.split(path.delimiter).filter(folder => !same(folder))].join(path.delimiter) : inherited;
  env.AGENTRIX_DISPATCH_DEPTH = String(depth);
  env.AGENTRIX_SHIM_NODE = process.execPath;
  if (depth > 0) { env.AGENTRIX_RUN_ID = runId; env.AGENTRIX_RUN_PROOF = proof; }
  if (installed && fs.existsSync(path.join(__dirname, 'hooks/zsh/.zshenv'))) {
    // Login shells (Codex's bash -lc and zsh -lc) and Claude Code's shell snapshot rebuild PATH from the user's start-up
    // files, which may put a real CLI first. Each hook runs the user's own one first, then puts the shims first again.
    // Inside a planner, this Agentrix's or another's, the incoming hooks are Agentrix's: the user's own stay where the
    // first one saved them, so no hook is ever saved as the user's and sourced by itself.
    const nested = source.AGENTRIX_SHIMS !== undefined, shell = shellFolder(__dirname);
    // CLAUDE_ENV_FILE is the session's private copy (bootstrap-file.cjs), never an installed file: Claude Code lets
    // SessionStart hooks append to it.
    const session = nested && source.CLAUDE_ENV_FILE || bootstrapField(source.AGENTRIX_BOOTSTRAP, 'claudeEnvFile');
    env.AGENTRIX_SHIMS = shell;
    for (const [name, file] of [['BASH_ENV', `${shell}/hooks/bash-env.sh`], ['CLAUDE_ENV_FILE', session], ['ZDOTDIR', `${shell}/hooks/zsh`]]) {
      const saved = `AGENTRIX_SHIM_USER_${name}`;
      if (!nested && !shimHook(source[name])) { if (source[name]) env[saved] = source[name]; else delete env[saved]; }
      if (file) env[name] = file;
    }
  }
  return env;
}

// Whether a hook value lies in an Agentrix shim folder (<shims>/hooks/<file> or <shims>/hooks/zsh).
const shimHook = value => !!value && fs.existsSync(path.join(path.dirname(path.dirname(process.platform === 'win32'
  ? value.replace(/^\/([A-Za-z])(?=\/)/, '$1:') : value)), '.agentrix-shims'));

function bootstrapField(file, name) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))[name]; } catch { return undefined; }
}

// What withShims changes, as words for env(1): -u NAME or NAME=VALUE. A shell wrapper starts one planner with them.
const shimWords = (source, options) => envWords(source, withShims(claudeLaunchEnvironment(source), options));
function envWords(source, next) {
  return [...Object.keys(source).filter(name => !(name in next)).flatMap(name => ['-u', name]),
    ...Object.entries(next).filter(([name, value]) => source[name] !== value).map(([name, value]) => `${name}=${value}`)];
}

// Wrappers call this immediately before each Claude launch, including terminals opened before a Settings change.
function claudeLaunchEnvironment(source) {
  const next = { ...source };
  for (const name of Object.keys(next)) if (name.toUpperCase() === 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS') delete next[name];
  const policy = source.AGENTRIX_BOOTSTRAP && source.AGENTRIX_BOOTSTRAP + '.background.json';
  const allow = policy && fs.existsSync(policy) ? bootstrapField(policy, 'claudeBackgroundTasks')
    : bootstrapField(source.AGENTRIX_BOOTSTRAP, 'claudeBackgroundTasks');
  if (allow !== true) next.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  return next;
}

// The Codex subcommand after the root options, and those options.
function codexCommand(argv) {
  let index = 0;
  while (index < argv.length && /^-./.test(argv[index]) && argv[index] !== '--') index += !argv[index].includes('=') && CODEX_ROOT_VALUES.has(argv[index]) ? 2 : 1;
  return { leading: argv.slice(0, index), command: argv[index], rest: argv.slice(index + 1) };
}

// A planner's delegation: codex exec (alias e), or Claude Code's print mode.
function delegates(agent, argv) {
  if (agent === 'codex') return ['exec', 'e'].includes(codexCommand(argv).command);
  const end = argv.indexOf('--');
  return (end < 0 ? argv : argv.slice(0, end)).some(token => token === '-p' || token === '--print');
}

// A call that opens the conversation itself: no version or help word, and no subcommand but Codex's resume and fork. A
// first word with spaces is the prompt; any other bare first word is taken as a subcommand, whatever the CLI version.
function converses(agent, argv) {
  if (argv.some(token => HARMLESS[agent].includes(token))) return false;
  const first = agent === 'codex' ? codexCommand(argv).command : argv[0];
  return first === undefined || /\s/.test(first) || (agent === 'codex' ? ['resume', 'fork'].includes(first) : first.startsWith('-'));
}

function helperPath() {
  // Local source/packaged shims are beside dispatch.cjs; a carried shim module is under electron/shims.
  return path.resolve(__dirname, fs.existsSync(path.join(__dirname, '../dispatch.cjs')) ? '../dispatch.cjs' : '../../dispatch.cjs');
}

// A planner: the owner's own Claude Code or Codex, at depth zero with a bootstrap to report its rows to. Anything less fails
// closed as nested.
const planner = env => env.AGENTRIX_DISPATCH_DEPTH === '0' && !env.AGENTRIX_RUN_ID && !env.AGENTRIX_RUN_PROOF && !!env.AGENTRIX_BOOTSTRAP;
const locateCli = (agent, env) => require(helperPath())[agent === 'codex' ? 'locateCodex' : 'locateClaude'](env);
const sessionMode = env => { try { return fs.readFileSync(env.AGENTRIX_BOOTSTRAP + '.mode', 'utf8').trim(); } catch { return 'native'; } };

// The lead session gets the role tools, which the worker engine serves over MCP stdio and refuses in native mode: a
// session started in native mode has them when the owner switches it to conductor mode.
function roleToolArgs(agent, env) {
  const command = env.AGENTRIX_SHIM_NODE || process.execPath, args = [helperPath(), 'mcp'];
  const serverEnv = { ELECTRON_RUN_AS_NODE: '1', ...Object.fromEntries(Object.entries(env)
    .filter(([name]) => /^(AGENTRIX_(BOOTSTRAP|SEATS|DISPATCH_DEPTH|SHIMS|SHIM_NODE)|CODEX_HOME)$/.test(name))) };
  // One word: --mcp-config takes several values, and as a word of its own it would take the user's prompt for another.
  if (agent === 'claude') return ['--mcp-config=' + JSON.stringify({ mcpServers: { agentrix: { type: 'stdio', command, args, env: serverEnv } } })];
  const toml = value => JSON.stringify(value);
  return ['-c', `mcp_servers.agentrix.command=${toml(command)}`, '-c', `mcp_servers.agentrix.args=${toml(args)}`,
    '-c', `mcp_servers.agentrix.env={${Object.entries(serverEnv).map(([name, value]) => `${name}=${toml(value)}`).join(', ')}}`];
}

// Not a delegation: the real CLI, found outside the shim folder, runs with this process's streams and its exit status.
async function passThrough(agent, args, { env, cwd, stderr, locate, launch }) {
  const file = await Promise.resolve().then(() => locate(agent, env)).catch(() => null);
  if (!file) { stderr.write(`[dispatch] not run: ${agent} was not found outside the Agentrix shim folder\n`); return 127; }
  // The launcher set this only to run Node; a CLI that starts an Electron app must not inherit it.
  const childEnv = agent === 'claude' ? claudeLaunchEnvironment(env) : { ...env }; delete childEnv.ELECTRON_RUN_AS_NODE;
  return new Promise(resolve => {
    const child = launch(file, args, { cwd, env: childEnv, stdio: 'inherit' });
    // Ctrl+C reaches the child from the terminal; a signal sent to this process alone is passed on.
    const handlers = { SIGINT: () => {}, SIGTERM: () => child.kill('SIGTERM'), SIGHUP: () => child.kill('SIGHUP') };
    const done = code => { for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler); resolve(code); };
    for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
    child.once('error', () => { stderr.write(`[dispatch] not run: ${agent} could not start\n`); done(127); });
    child.once('exit', (code, signal) => done(code ?? 128 + (os.constants.signals[signal] || 0)));
  });
}

async function intercept(argv, { env = process.env, cwd = process.cwd(), stderr = process.stderr, locate = locateCli, launch = spawn } = {}) {
  const [agent, ...rest] = argv, args = rest[0] === '--' ? rest.slice(1) : rest;
  if (!planner(env)) {
    if (args.length === 1 && HARMLESS[agent]?.includes(args[0])) return passThrough(agent, args, { env, cwd, stderr, locate, launch });
    stderr.write('[agentrix] not run: a role cannot start another role\n');
    return 2;
  }
  const conductor = sessionMode(env) === 'conductor';
  if (conductor && delegates(agent, args)) {
    stderr.write('[agentrix] not run: in conductor mode a role starts with the start_role tool, not with codex or claude from the shell\n');
    return 2;
  }
  // Native mode runs a delegation on the real CLI, as it was before Agentrix; a lead's conversation gets the role tools in both modes.
  return passThrough(agent, converses(agent, args) && !delegates(agent, args) ? [...roleToolArgs(agent, env), ...args] : args, { env, cwd, stderr, locate, launch });
}

// What an owner's wrapper starts its CLI with, from one request: the planner's env(1) words, a "--" word, then the arguments
// that give the planner's conversation the role tools, whose server runs with that same environment. A delegation and a
// call that opens no conversation get none, by the rule intercept follows.
function launchWords(source, agent, args) {
  const next = withShims(claudeLaunchEnvironment(source), { depth: 0 });
  const tools = planner(next) && Object.hasOwn(HARMLESS, agent) && converses(agent, args) && !delegates(agent, args);
  return [...envWords(source, next), '--', ...(tools ? roleToolArgs(agent, next) : [])];
}

if (require.main === module) {
  let argv = process.argv.slice(2);
  if (!argv.length && process.env.AGENTRIX_INTERCEPT_ARGV) {
    try { argv = JSON.parse(process.env.AGENTRIX_INTERCEPT_ARGV); } catch { argv = []; }
  }
  delete process.env.AGENTRIX_INTERCEPT_ARGV;
  if (!Array.isArray(argv) || !argv.every(word => typeof word === 'string')) argv = [];
  if (argv[0] === '--shim-env') {
    // --shim-env [json] [--role-tools <agent> <the user's arguments>]: NUL-terminated words, or JSON. A terminal opened
    // before an update still asks without --role-tools, for the planner's words alone.
    const json = argv[1] === 'json', [flag, agent, ...args] = argv.slice(json ? 2 : 1);
    const words = flag === '--role-tools' ? launchWords(process.env, agent, args) : shimWords(process.env, { depth: 0 });
    process.stdout.write(json ? JSON.stringify(words) : words.map(word => word + '\0').join(''));
  } else intercept(argv).then(code => { process.exitCode = code; });
}
module.exports = { intercept, withShims, shimWords, shimFiles, hookFiles, runtimeFiles };
