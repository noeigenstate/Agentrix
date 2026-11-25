// Only a planner's environment has these shims on PATH: withShims puts the folder first for the Claude Code or Codex an owner
// starts and for every dispatched worker, and its hooks put it first again after the user's start-up files.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const SHIM_NAMES = ['.agentrix-shims', 'codex', 'codex.cmd', 'codex.ps1', 'claude', 'claude.cmd', 'claude.ps1'];
const ZSH_PHASES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin'];
const HOOK_FILES = ['hooks/path.sh', 'hooks/bash-env.sh', 'hooks/claude-env.sh', 'hooks/owner.sh', 'hooks/terminal-wire.sh',
  'hooks/zsh/phase.zsh', ...ZSH_PHASES.map(name => `hooks/zsh/${name}`)];
const sourceAdapters = path.resolve(__dirname, '../../electron/features/cli-adapters');
const terminalSource = path.join(sourceAdapters, 'terminal.cjs');
const packagedRuntime = path.resolve(__dirname, '../electron');
const runtimeRoot = fs.existsSync(packagedRuntime) ? packagedRuntime : path.resolve(__dirname, '../../electron');
const wire = () => require(path.join(runtimeRoot, 'features/agents/dispatch-events.cjs'));

function sourceWords() {
  const { adapters } = require(path.join(sourceAdapters, 'registry.mjs'));
  return Object.fromEntries(adapters().map(({ manifest }) => [manifest.id, manifest.words]));
}

let facets;
function carriedEnvelope() {
  const packaged = path.resolve(__dirname, '../electron/shims/launchers.cjs');
  return fs.existsSync(packaged) ? packaged : path.join(__dirname, 'launchers.cjs');
}

function terminalFacets() {
  if (facets) return facets;
  if (fs.existsSync(terminalSource)) return facets = require(terminalSource).terminalAdapters(sourceWords());
  return facets = require(carriedEnvelope()).terminal;
}

function shimFiles() {
  // The SSH carrier accepts CJS modules only. Its launcher envelope is the same files, never a second implementation.
  if (!fs.existsSync(path.join(__dirname, 'codex'))) return require(carriedEnvelope());
  return Object.fromEntries(SHIM_NAMES.map(name => [name, fs.readFileSync(path.join(__dirname, name), 'utf8')]));
}

// The start-up hooks a packaged app installs beside the launchers. SSH shims are deferred, so they are not carried.
function hookFiles() { return Object.fromEntries(HOOK_FILES.map(name => [name, fs.readFileSync(path.join(__dirname, name), 'utf8')])); }

function runtimeFiles() {
  const intercept = fs.readFileSync(__filename, 'utf8');
  if (!fs.existsSync(terminalSource)) return { 'shims/intercept.cjs': intercept, 'shims/launchers.cjs': fs.readFileSync(carriedEnvelope(), 'utf8') };
  const words = sourceWords(), source = fs.readFileSync(terminalSource, 'utf8');
  const { claudeWire } = require(terminalSource);
  const envelope = [
    'const terminalWire = ' + JSON.stringify({ format: 'agentrix.terminal-wire', version: 1, words, claude: claudeWire }) + ';',
    'const terminalModule = { exports: {} };',
    '(function (module) {',
    source,
    '})(terminalModule);',
    'module.exports = ' + JSON.stringify(shimFiles()) + ';',
    'Object.defineProperty(module.exports, "terminal", { value: terminalModule.exports.terminalAdapters(terminalWire.words) });',
    '',
  ].join('\n');
  return { 'shims/intercept.cjs': intercept, 'shims/launchers.cjs': envelope };
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
    const session = nested && source.CLAUDE_ENV_FILE || readBootstrap(source.AGENTRIX_BOOTSTRAP)?.value.claudeEnvFile;
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

function readBootstrap(file, format = 'agentrix.bootstrap') {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return wire().readEnvelope(text, { format });
  } catch { return undefined; }
}

// What withShims changes, as words for env(1): -u NAME or NAME=VALUE. A shell wrapper starts one planner with them.
const shimWords = (source, options) => envWords(envChanges(source, withShims(claudeLaunchEnvironment(source), options)));
const envWords = ({ unset, env }) => [...unset.flatMap(name => ['-u', name]), ...Object.entries(env).map(([name, value]) => `${name}=${value}`)];
function envChanges(source, next) {
  return { unset: Object.keys(source).filter(name => !Object.hasOwn(next, name)),
    env: Object.fromEntries(Object.entries(next).filter(([name, value]) => source[name] !== value)) };
}

// Wrappers call this immediately before each Claude launch, including terminals opened before a Settings change.
function claudeLaunchEnvironment(source) {
  const next = { ...source };
  for (const name of Object.keys(next)) if (name.toUpperCase() === 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS') delete next[name];
  const policy = source.AGENTRIX_BOOTSTRAP && source.AGENTRIX_BOOTSTRAP + '.background.json';
  const allow = (policy && fs.existsSync(policy) ? readBootstrap(policy, 'agentrix.background-policy')
    : readBootstrap(source.AGENTRIX_BOOTSTRAP))?.value.claudeBackgroundTasks;
  if (allow !== true) next.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  return next;
}

function helperPath() {
  // Local source/packaged shims are beside dispatch.cjs; a carried shim module is under electron/shims.
  return path.resolve(__dirname, fs.existsSync(path.join(__dirname, '../dispatch.cjs')) ? '../dispatch.cjs' : '../../dispatch.cjs');
}

// A planner: the owner's own Claude Code or Codex, at depth zero with a bootstrap to report its rows to. Anything less fails
// closed as nested.
const planner = env => env.AGENTRIX_DISPATCH_DEPTH === '0' && !env.AGENTRIX_RUN_ID && !env.AGENTRIX_RUN_PROOF && !!env.AGENTRIX_BOOTSTRAP;
const locateCli = (agent, env) => require(helperPath())[agent === 'codex' ? 'locateCodex' : 'locateClaude'](env);
function sessionMode(env) {
  if (!env.AGENTRIX_BOOTSTRAP) return 'native';
  try {
    return wire().readSessionMode(fs.readFileSync(env.AGENTRIX_BOOTSTRAP + '.mode.env', 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      try { return fs.readFileSync(env.AGENTRIX_BOOTSTRAP + '.mode', 'utf8').trim(); } catch { return 'native'; }
    }
    // An unreadable or unsupported mode cannot authorize shell delegation.
    return 'conductor';
  }
}

// The lead session gets the role tools, which the worker engine serves over MCP stdio and refuses in native mode: a
// session started in native mode has them when the owner switches it to conductor mode.
function roleToolArgs(agent, env) {
  const helper = helperPath(), command = env.AGENTRIX_SHIM_NODE || process.execPath;
  const roleTools = terminalFacets()[agent].roleTools;
  let lead;
  if (roleTools.lead) {
    try {
      const installed = path.join(path.dirname(helper), 'electron');
      const runtime = fs.existsSync(installed) ? installed : path.resolve(path.dirname(helper), '../electron');
      const { claudeLeadSeat } = require(path.join(runtime, 'features/agents/call-seat.cjs'));
      lead = claudeLeadSeat(env.AGENTRIX_BOOTSTRAP);
    } catch {
      // The role tools can still read the lead sidecar when a role starts.
    }
  }
  const args = [helper, 'mcp', agent, ...(lead ? [lead.model, lead.effort] : [])];
  const serverEnv = { ELECTRON_RUN_AS_NODE: '1', ...Object.fromEntries(Object.entries(env)
    .filter(([name]) => /^(AGENTRIX_(BOOTSTRAP|SEATS|DISPATCH_DEPTH|SHIMS|SHIM_NODE)|CODEX_HOME)$/.test(name))) };
  return roleTools.args({ command, args, env: serverEnv });
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
  const adapter = Object.hasOwn(terminalFacets(), agent) ? terminalFacets()[agent] : null;
  if (!planner(env) || !adapter) {
    if (args.length === 1 && adapter?.words.harmless.includes(args[0])) return passThrough(agent, args, { env, cwd, stderr, locate, launch });
    stderr.write('[agentrix] not run: a role cannot start another role\n');
    return 2;
  }
  const { delegates, converses } = adapter.terminal;
  const delegation = delegates(args);
  if (sessionMode(env) === 'conductor' && delegation) {
    stderr.write('[agentrix] not run: in conductor mode a role starts with the start_role tool, not with codex or claude from the shell\n');
    return 2;
  }
  // Native mode runs a delegation on the real CLI, as it was before Agentrix; a lead's conversation gets the role tools in both modes.
  return passThrough(agent, converses(args) && !delegation ? [...roleToolArgs(agent, env), ...args] : args, { env, cwd, stderr, locate, launch });
}

// Both terminal protocols give the MCP server the same environment as its planner.
function plannerLaunch(source, agent, args) {
  const next = withShims(claudeLaunchEnvironment(source), { depth: 0 });
  const terminal = Object.hasOwn(terminalFacets(), agent) && terminalFacets()[agent].terminal;
  const tools = planner(next) && terminal?.converses?.(args) && !terminal.delegates?.(args);
  return { ...envChanges(source, next), roleTools: tools ? roleToolArgs(agent, next) : [] };
}

function terminalLaunch(source, agent, action, mode, args, lookup = id => Object.hasOwn(terminalFacets(), id) ? terminalFacets()[id] : undefined,
  legacy = false) {
  const adapter = lookup(agent), terminal = adapter?.terminal;
  if (!terminal) throw new Error('Unknown terminal adapter');
  const remote = mode === 'remote';
  if (action === 'classify') {
    const classified = terminal.classify?.(args, { native: mode === 'native', remote, alias: remote ? undefined : source.AGENTRIX_LAUNCH_ALIAS });
    const words = adapter.manifest?.words ?? adapter.words;
    const route = classified ?? (words?.utilities.includes(args[0]) ? 'passthrough' : terminal.redirect ?? 'conversation');
    return legacy ? route : wire().writeKeyValue({ format: 'agentrix.launch-route', version: '1', route });
  }
  if (terminal.redirect) throw new Error('Terminal launch redirects to ' + terminal.redirect);
  const { AGENTRIX_LAUNCH_MODEL: model, AGENTRIX_LAUNCH_EFFORT: effort,
    AGENTRIX_LAUNCH_NOTE: note, AGENTRIX_LAUNCH_SETTINGS: file, AGENTRIX_LAUNCH_ROLE: role, AGENTRIX_LAUNCH_ROLE_ERROR: roleError } = source;
  const { unset, env, roleTools } = mode === 'shims' ? plannerLaunch(source, agent, args) : { unset: [], env: {}, roleTools: remote && role ? [role] : [] };
  const { argv } = terminal.launch({ roleTools, seat: { model, effort }, note, roleError: remote ? roleError : undefined, hooks: { file }, remote });
  if (legacy) {
    const words = [...envWords({ unset, env }), '--', ...argv];
    return action === 'json' ? JSON.stringify(words) : nulWords(words);
  }
  if (action === 'json') return JSON.stringify({ v: 1, type: 'launch.words', unset, env, argv });
  return nulWords(['format=agentrix.launch-words', 'version=1', ...unset.map(name => 'unset=' + name),
    ...Object.entries(env).map(([name, value]) => `env=${name}=${value}`), ...argv.map(word => 'arg=' + word)]);
}

const nulWords = words => words.map(word => word + '\0').join('');

module.exports = { intercept, terminalLaunch, withShims, shimWords, shimFiles, hookFiles, runtimeFiles };

if (require.main === module) {
  let argv = process.argv.slice(2);
  if (!argv.length && process.env.AGENTRIX_INTERCEPT_ARGV) {
    try { argv = JSON.parse(process.env.AGENTRIX_INTERCEPT_ARGV); } catch { argv = []; }
  }
  delete process.env.AGENTRIX_INTERCEPT_ARGV;
  if (!Array.isArray(argv) || !argv.every(word => typeof word === 'string')) argv = [];
  if (argv[0] === '--bootstrap-shims') {
    const file = process.env.AGENTRIX_BOOTSTRAP;
    const bootstrap = file ? readBootstrap(file) : null;
    if (file && !bootstrap) process.exitCode = 1;
    else process.stdout.write(bootstrap?.value.shims || '');
  } else if (argv[0] === '--launch') {
    const [, agent, action, mode, ...args] = argv;
    // Terminals already open across an in-place update still send the original launch request.
    const legacy = process.env.AGENTRIX_LAUNCH_WIRE !== '1' && readBootstrap(process.env.AGENTRIX_BOOTSTRAP)?.legacy === true;
    delete process.env.AGENTRIX_LAUNCH_WIRE;
    process.stdout.write(terminalLaunch(process.env, agent, action, mode, args, undefined, legacy));
  } else if (argv[0] === '--shim-env') {
    // Remove next version, once old terminal wrappers are gone.
    // --shim-env [json] [--role-tools <agent> <the user's arguments>]: NUL-terminated words, or JSON. A terminal opened
    // before an update still asks without --role-tools, for the planner's words alone.
    const json = argv[1] === 'json', [flag, agent, ...args] = argv.slice(json ? 2 : 1);
    const plan = flag === '--role-tools' && plannerLaunch(process.env, agent, args);
    const words = plan ? [...envWords(plan), '--', ...plan.roleTools] : shimWords(process.env, { depth: 0 });
    process.stdout.write(json ? JSON.stringify(words) : nulWords(words));
  } else intercept(argv).then(code => { process.exitCode = code; });
}
