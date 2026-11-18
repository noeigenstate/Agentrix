// Only a planner's environment has these shims on PATH: withShims puts the folder first for the Claude Code or Codex an owner
// starts and for every dispatched worker, and its hooks put it first again after the user's start-up files.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const SHIM_NAMES = ['.agentrix-shims', 'codex', 'codex.cmd', 'codex.ps1', 'claude', 'claude.cmd', 'claude.ps1'];
const ZSH_PHASES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin'];
const HOOK_FILES = ['hooks/path.sh', 'hooks/bash-env.sh', 'hooks/claude-env.sh', 'hooks/owner.sh', 'hooks/zsh/phase.zsh', ...ZSH_PHASES.map(name => `hooks/zsh/${name}`)];
const LIMIT = 4 * 1024 * 1024;
// How long Claude Code's print mode waits for a first byte of piped input before it goes on without it (2.1.325).
const CLAUDE_STDIN_WAIT = 3000;
// The CLIs' own runs that only print: a worker may still run them.
const HARMLESS = { codex: ['--version', '-V', '--help', '-h', 'help'], claude: ['--version', '-v', '--help', '-h'] };
// Codex's root options that take a value (codex --help, 0.169.0), so the subcommand after them can be found.
const CODEX_ROOT_VALUES = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image', '-m', '--model',
  '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval']);
const CODEX_EXEC_COMMANDS = ['resume', 'fork', 'review', 'help'];

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
function shimWords(source, options) {
  const next = withShims(claudeLaunchEnvironment(source), options);
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

function unsupported(option) { return Object.assign(new Error(option), { option }); }

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

// Only the documented CLI subset has a dispatcher equivalent. Everything else is refused before admission. Permissions
// follow each CLI's default: codex exec runs read-only and Claude's print mode denies edits unless a flag allows them.
function mapCommand(agent, argv, cwd = process.cwd()) {
  if (!['codex', 'claude'].includes(agent)) throw unsupported(String(agent));
  const options = { agent, model: agent === 'codex' ? 'gpt-6.1-sol' : 'sonnet', effort: 'high', fast: false,
    readOnly: true, images: [], cwd, out: null, prompt: null };
  const seen = new Set(), positional = [];
  let print = false, literal = false, refusal = null, refusalCount = 0, args = [...argv];
  const refuse = option => { refusal ||= option; refusalCount++; };
  const once = (key, option) => { if (seen.has(key)) { refuse(option); return false; } seen.add(key); return true; };
  if (agent === 'codex') {
    const { leading, command, rest } = codexCommand(argv);
    if (!['exec', 'e'].includes(command)) throw unsupported(command || 'codex (interactive)');
    // A root option is refused by its own name and place; the equivalent command maps it as if it followed exec.
    if (leading.length) refuse(`${leading[0]} before exec`);
    args = [...leading, ...rest];
  }
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (literal || token === '-' || !token.startsWith('-')) {
      if (agent === 'codex' && !literal && !positional.length && CODEX_EXEC_COMMANDS.includes(token)) refuse(`exec ${token}`);
      positional.push(token); continue;
    }
    if (token === '--') { literal = true; continue; }
    const equal = token.indexOf('='), flag = equal > 0 ? token.slice(0, equal) : token;
    const value = () => {
      const text = equal > 0 ? token.slice(equal + 1) : args[++index];
      if (typeof text !== 'string' || !text || text.startsWith('--') || text.includes('\0')) { refuse(flag); return null; }
      return text;
    };
    if (agent === 'claude' && ['-p', '--print'].includes(flag)) { if (equal > 0 || !once('print', '--print')) refuse(flag); print = true; continue; }
    if (['-m', '--model'].includes(flag) && (agent === 'codex' || flag === '--model')) {
      const text = value(); if (once('model', '--model') && text) options.model = text; continue;
    }
    if (agent === 'claude' && flag === '--effort') { const text = value(); if (once('effort', flag) && text) options.effort = text; continue; }
    if (agent === 'claude' && flag === '--permission-mode') {
      const text = value();
      if (!once('permission', flag) || !['default', 'plan', 'acceptEdits'].includes(text)) refuse(flag); else options.readOnly = text !== 'acceptEdits';
      continue;
    }
    if (agent === 'claude' && flag === '--output-format') {
      if (!once('format', flag) || value() !== 'text') refuse(flag); continue;
    }
    if (agent === 'codex' && flag === '-c') {
      const text = value(), match = text && /^\s*(model_reasoning_effort|service_tier)\s*=\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([a-zA-Z0-9_-]+))\s*$/.exec(text);
      if (!match || !once(match[1], flag)) { refuse(flag); continue; }
      const setting = match[2] ?? match[3] ?? match[4];
      if (match[1] === 'model_reasoning_effort') options.effort = setting;
      else if (setting === 'fast') options.fast = true;
      else refuse(flag);
      continue;
    }
    // Older Codex builds' --full-auto is the workspace-write sandbox.
    if (agent === 'codex' && flag === '--full-auto' && equal < 0) { if (once('sandbox', flag)) options.readOnly = false; continue; }
    if (agent === 'codex' && ['-C', '--cd', '-o', '--output-last-message', '-i', '--image', '-s', '--sandbox'].includes(flag)) {
      const text = value(); if (text === null) continue;
      if (['-i', '--image'].includes(flag)) options.images.push(text);
      else if (['-C', '--cd'].includes(flag)) { if (once('cwd', '--cd')) options.cwd = path.resolve(cwd, text); }
      else if (['-s', '--sandbox'].includes(flag)) {
        if (!once('sandbox', flag) || !['read-only', 'workspace-write'].includes(text)) refuse(flag); else options.readOnly = text === 'read-only';
      } else if (once('out', '-o')) options.out = text;
      continue;
    }
    refuse(flag);
  }
  if (agent === 'claude' && !print) refuse('claude (interactive)');
  if (positional.length > 1 || positional.some(text => text.includes('\0'))) refuse('prompt');
  if (/[\0\r\n]/.test(options.model) || options.model.length > 160) refuse('--model');
  if (!/^(?:none|minimal|low|medium|high|xhigh|max|ultra)$/.test(options.effort)) refuse(agent === 'codex' ? '-c model_reasoning_effort' : '--effort');
  options.prompt = positional[0] === '-' ? null : positional[0] ?? null;
  options.cwd = path.resolve(options.cwd);
  if (options.out) options.out = path.resolve(options.cwd, options.out);
  options.images = options.images.map(file => path.resolve(options.cwd, file));
  if (refusal) throw Object.assign(unsupported(refusal), { mapped: refusalCount === 1 ? options : undefined });
  return options;
}

function helperPath() {
  // Local source/packaged shims are beside dispatch.cjs; a carried shim module is under electron/shims.
  return path.resolve(__dirname, fs.existsSync(path.join(__dirname, '../dispatch.cjs')) ? '../dispatch.cjs' : '../../dispatch.cjs');
}

// A read-only call investigates; one its flags let write executes.
function helperArguments(options, brief, out) {
  return [options.agent, '--role', options.readOnly ? 'investigate' : 'exec', '--title', `Intercepted ${options.agent} call`, '--model', options.model,
    '--effort', options.effort, '--cwd', options.cwd, '--brief', brief, '--out', out,
    ...(options.agent === 'claude' ? ['--permission', options.readOnly ? 'plan' : 'acceptEdits'] : [
      ...(options.fast ? ['--fast'] : []), ...(options.readOnly ? ['--read-only'] : []), ...options.images.flatMap(file => ['--image', file]),
    ])];
}

// Piped input, at most 4 MiB. With `wait`, no byte within that many ms means none is coming.
function stdinText({ wait } = {}) {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, timer;
    const finish = (error, text) => {
      clearTimeout(timer); process.stdin.off('data', take).off('end', end).off('error', finish);
      if (error || text === '') process.stdin.destroy();
      if (error) reject(error); else resolve(text ?? Buffer.concat(chunks).toString('utf8'));
    };
    const take = chunk => { clearTimeout(timer); size += chunk.length; if (size > LIMIT) finish(new Error('stdin exceeds 4 MiB')); else chunks.push(chunk); };
    const end = () => finish();
    process.stdin.on('data', take).once('end', end).once('error', finish);
    if (wait) timer = setTimeout(() => finish(null, ''), wait);
  });
}

// A prompt argument with piped input, joined as each CLI joins them: codex exec appends a <stdin> block (0.169.0), Claude
// Code's print mode a new line (2.1.325).
function withPiped(agent, prompt, piped) {
  if (agent === 'claude') return [prompt, piped].filter(Boolean).join('\n');
  return piped.trim() ? `${prompt}\n\n<stdin>\n${piped}${piped.endsWith('\n') ? '' : '\n'}</stdin>` : prompt;
}

// A planner: the owner's own Claude Code or Codex, at depth zero with a bootstrap to report its rows to. Anything less fails
// closed as nested.
const planner = env => env.AGENTRIX_DISPATCH_DEPTH === '0' && !env.AGENTRIX_RUN_ID && !env.AGENTRIX_RUN_PROOF && !!env.AGENTRIX_BOOTSTRAP;
const locateCli = (agent, env) => require(helperPath())[agent === 'codex' ? 'locateCodex' : 'locateClaude'](env);

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

async function intercept(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, readInput = stdinText, dispatch,
  locate = locateCli, launch = spawn } = {}) {
  const [agent, ...rest] = argv, args = rest[0] === '--' ? rest.slice(1) : rest;
  if (!planner(env)) {
    if (args.length === 1 && HARMLESS[agent]?.includes(args[0])) return passThrough(agent, args, { env, cwd, stderr, locate, launch });
    stderr.write(`[dispatch] not run: dispatch.intercept_nested\n[dispatch] request: node ${JSON.stringify(helperPath())} delegate ${agent === 'claude' ? 'claude' : 'codex'} --title <one-line> --model <model> --brief <file> --out <file>\n`);
    return 2;
  }
  if (['codex', 'claude'].includes(agent) && !delegates(agent, args)) return passThrough(agent, args, { env, cwd, stderr, locate, launch });
  let options;
  try { options = mapCommand(agent, args, cwd); }
  catch (error) {
    const option = String(error.option || 'arguments').replace(/[\r\n\0]/g, ' ').slice(0, 160);
    stderr.write(`[dispatch] not run: ${option} is not supported through the Agentrix dispatcher\n`);
    if (error.mapped) stderr.write(`[dispatch] equivalent: node ${JSON.stringify(helperPath())} ${helperArguments(error.mapped, '<brief.md>', '<answer.md>').map(word => JSON.stringify(word)).join(' ')}\n`);
    return 2;
  }
  let directory, code = 1;
  try {
    const piped = await readInput(options.prompt !== null && agent === 'claude' ? { wait: CLAUDE_STDIN_WAIT } : {});
    const prompt = options.prompt === null ? piped : withPiped(agent, options.prompt, piped);
    if (typeof prompt !== 'string' || Buffer.byteLength(prompt) > LIMIT || !prompt.trim()) throw new Error('a non-empty prompt of at most 4 MiB is required');
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-intercept-'));
    const brief = path.join(directory, 'brief.md'), out = path.join(directory, 'answer.md');
    fs.writeFileSync(brief, prompt, { mode: 0o600 });
    const run = dispatch || require(helperPath()).run;
    const result = await run(helperArguments(options, brief, out), { env, stdout: stderr, source: 'intercepted' });
    if (fs.existsSync(out)) {
      const answer = fs.readFileSync(out);
      if (options.out) fs.writeFileSync(options.out, answer);
      stdout.write(answer);
    } else if (result === 0) throw new Error('intercept_result_missing');
    code = result === 0 ? 0 : 1;
  } catch (error) {
    // No stack, argv or environment on the reporting channel: a provider or filesystem error may carry credentials.
    const name = typeof error.code === 'string' && /^[A-Z_0-9]{1,40}$/.test(error.code) ? error.code : 'intercept_failed';
    stderr.write(`[dispatch] not run: ${name}\n`);
  }
  // A leftover private folder is reported; the answer already printed keeps its exit status.
  if (directory) try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch { stderr.write('[dispatch] intercept cleanup failed\n'); }
  return code;
}

if (require.main === module && process.argv[2] === '--shim-env') {
  // An owner's wrapper asks for the words that make the Claude Code it starts a planner: NUL-terminated, or JSON.
  const words = shimWords(process.env, { depth: 0 });
  process.stdout.write(process.argv[3] === 'json' ? JSON.stringify(words) : words.map(word => word + '\0').join(''));
} else if (require.main === module) {
  let argv = process.argv.slice(2);
  if (!argv.length && process.env.AGENTRIX_INTERCEPT_ARGV) {
    try { argv = JSON.parse(process.env.AGENTRIX_INTERCEPT_ARGV); } catch { argv = []; }
  }
  delete process.env.AGENTRIX_INTERCEPT_ARGV;
  intercept(Array.isArray(argv) && argv.every(word => typeof word === 'string') ? argv : []).then(code => { process.exitCode = code; });
}
module.exports = { mapCommand, intercept, withShims, shimWords, shimFiles, hookFiles, runtimeFiles };
