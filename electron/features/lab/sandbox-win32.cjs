const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const preparation = require('./sandbox-win32-preparation.cjs');
const { windowsDiagnostics } = require('./process.cjs');
const source = require('./sandbox-win32-native.cjs') + preparation.nativeSource;
const exec = promisify(execFile);
const runs = new Map();
let executable, executableHash, preparing;
const prepareHost = preparation.createHostPreparation();

const infrastructure = message => Object.assign(new Error(message), { infrastructure: true });
const contained = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

async function native(args, options = {}) {
  if (!executable) throw infrastructure('Windows lab isolation has not been initialized.');
  const diagnostics = windowsDiagnostics();
  try {
    const running = exec(executable, args, {
      windowsHide: true, timeout: args[0] === 'clean' ? 0 : 10000, maxBuffer: 1024 * 1024,
      ...(diagnostics ? { env: { ...process.env, AGENTRIX_LAB_DIAGNOSTICS: '1' } } : {}), ...options,
    });
    if (diagnostics) running.child?.stderr?.on('data', chunk => diagnostics.feed(chunk));
    return await running;
  } catch {
    const error = infrastructure('Windows lab isolation could not complete its operation.');
    if (diagnostics?.summary()) error.message += '\n' + diagnostics.summary();
    throw error;
  }
}

async function initialize({ directory } = {}) {
  if (!directory || !path.isAbsolute(directory)) throw infrastructure('Windows lab isolation requires a private lab directory.');
  if (preparing) await preparing;
  const root = path.join(await fs.realpath(directory), 'private', '.win32-runtime');
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 20);
  const binary = path.join(root, 'launcher-' + hash + '.exe');
  if (executable === binary && await fs.readFile(binary).then(bytes =>
    createHash('sha256').update(bytes).digest('hex') === executableHash, () => false)) return executable;
  preparing = (async () => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if (!contained(await fs.realpath(directory), await fs.realpath(root))) throw infrastructure('The Windows lab runtime directory is linked outside the lab.');
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const input = path.join(root, randomUUID() + '.cs'), output = path.join(root, randomUUID() + '.exe');
    try {
      await fs.writeFile(input, source, { mode: 0o600 });
      await exec(compiler, ['/nologo', '/optimize+', '/target:exe', '/reference:System.Web.Extensions.dll', '/out:' + output, input], {
        windowsHide: true, timeout: 30000, maxBuffer: 65536,
        env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', TEMP: root, TMP: root },
      });
      const digest = createHash('sha256').update(await fs.readFile(output)).digest('hex');
      await fs.rename(output, binary).catch(async error => {
        if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
        const existing = await fs.readFile(binary).catch(() => null);
        if (!existing || createHash('sha256').update(existing).digest('hex') !== digest) throw error;
      });
      executable = binary; executableHash = digest;
      return binary;
    } catch (error) {
      if (error.infrastructure) throw error;
      const failure = infrastructure(preparation.ISOLATION_ERROR);
      failure.compiler = String(error.stdout || '').replaceAll(input, '<launcher-source>').slice(0, 4096);
      throw failure;
    } finally { await fs.rm(input, { force: true }); await fs.rm(output, { force: true }); }
  })();
  try { return await preparing; } finally { preparing = null; }
}

async function hostState(options) {
  await initialize(options);
  const { stdout } = await native(['host-ready']);
  const state = JSON.parse(stdout);
  if (typeof state.ready !== 'boolean' || typeof state.elevated !== 'boolean') throw infrastructure(preparation.ISOLATION_ERROR);
  return state;
}

async function requireIsolation(options = {}) {
  await initialize(options);
  const diagnostics = windowsDiagnostics();
  const prepare = elevate => {
    diagnostics?.feed('[lab-win32] host preparation begin\n');
    const call = preparation.prepCommand(executable, executableHash, { elevate });
    return exec(call.file, call.args, call.options);
  };
  await prepareHost({
    verify: async () => {
      const state = await hostState(options);
      diagnostics?.feed(`[lab-win32] host ready=${Number(state.ready)} elevated=${Number(state.elevated)}\n`);
      return state;
    }, prompt: options.prompt !== false && !process.env.NODE_TEST_CONTEXT,
    prepare: () => prepare(false), elevate: () => prepare(true),
  });
}

function register(runId, directory) { runs.set(runId, directory); }

async function markedPids(runId, job) {
  const { stdout } = await native(['list', runId, ...(job ? [job] : [])]);
  const pids = JSON.parse(stdout);
  if (!Array.isArray(pids) || pids.some(pid => !Number.isInteger(pid) || pid <= 0)) throw infrastructure('Invalid Windows lab process list.');
  return pids;
}

async function killMarked(runId, { job } = {}) {
  await native(['kill', runId, ...(job ? [job] : [])]);
  const directory = runs.get(runId);
  if (directory) await release(directory, job);
}

async function release(directory, job) {
  const names = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.acl\.json$/.test(name) || (job && name !== job + '.acl.json')) continue;
    await native(['clean', path.join(directory, name)]);
  }
}

async function resolveExecutable(file, env = process.env) {
  const search = Object.keys(env).find(key => key.toLowerCase() === 'path');
  const candidates = path.isAbsolute(file) ? [file] : String(env[search] || '').split(path.delimiter)
    .filter(path.isAbsolute).flatMap(root => path.extname(file) ? [path.join(root, file)] :
      ['.exe', '.com', '.cmd'].map(extension => path.join(root, file + extension)));
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(error => {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      throw error;
    });
    if (stat?.isFile()) return fs.realpath(candidate);
  }
  throw infrastructure('A required Windows lab executable is unavailable.');
}

async function runtimeRoots({ nodePath, env, command, protectedPaths = [] }) {
  const files = new Set([nodePath, ...(command ? [await resolveExecutable(command.file, env)] : [])]);
  for (const name of ['python', 'python3', 'git', 'codex', 'claude']) {
    try { files.add(await resolveExecutable(name, env)); } catch (error) { if (!error.infrastructure) throw error; }
  }
  const roots = [];
  const system = path.resolve(process.env.SystemRoot || 'C:\\Windows');
  for (const file of files) {
    let root = path.dirname(await fs.realpath(file));
    // Git for Windows keeps its DLLs and Unix tools beside cmd/, in the same installation.
    if (path.basename(file).toLowerCase() === 'git.exe' && ['cmd', 'bin'].includes(path.basename(root).toLowerCase())) root = path.dirname(root);
    if (contained(system, root)) continue;
    if (root === path.parse(root).root || root.toLowerCase() === path.resolve(os.homedir()).toLowerCase() ||
      protectedPaths.some(blocked => contained(root, blocked) || contained(blocked, root))) {
      throw infrastructure('A Windows lab runtime overlaps a protected path.');
    }
    roots.push(root);
  }
  return [...new Set(roots)];
}

module.exports = { initialize, hostState, requireIsolation, register, markedPids, killMarked, release, resolveExecutable, runtimeRoots, contained,
  get executable() { return executable; } };
