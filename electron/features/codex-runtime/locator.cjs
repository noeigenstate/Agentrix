const fs = require('node:fs/promises');
const nodePath = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { mergePath, readStoredPath, variable } = require('../claude-runtime/path-env.cjs');
const { reason } = require('../../shared/reason.cjs');
const { SHIM_MARKER } = require('../../shared/agentrix-shims.cjs');
// Every `via` a found Codex can have (codex-runtime/BOUNDARY.md).
const VIAS = Object.freeze(['path', 'npm-shim', 'npm-vendor', 'npm-hoisted', 'npm-prefix', 'registry-path', 'official-installer', 'winget', 'system']);
const VERSION = /\b\d+\.\d+\.\d+(?:-[\w.]+)?/, VERSION_TIMEOUT_MS = 10000, SHIM_BYTES = 65536, SOURCE = 'codex-runtime locator';
// A throttled refresh (window focus) searches with the stored Windows PATH at most this often.
const REFRESH_MS = 60000;
// How many folders below vendor/<triple> a package's program is looked for when no known layout holds it.
const VENDOR_DEPTH = 3;
// The Windows CPUs npm ships a platform package for, and the target triple of each one's binary.
const TRIPLES = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' };
// The package a shim runs, relative to the shim's folder: npm's `%dp0%\node_modules\@openai\codex` (a global prefix) or
// `$basedir/../@openai/codex` (a project's node_modules\.bin), pnpm's `%~dp0\global\5\node_modules\@openai\codex`.
const SHIM_PACKAGE = /(?:%~?dp0%?|\$basedir)[\\/]((?:[^"\r\n%$]*?[\\/])?@openai[\\/]codex)[\\/]bin[\\/]codex\.js/gi;

// What `codex --version` printed, or why it printed none. Its input is closed at once, so a stand-in that reads it ends.
function readVersion(probe, file, env) {
  return new Promise(resolve => {
    const settle = (error, stdout) => {
      const version = VERSION.exec(String(stdout ?? ''))?.[0];
      if (version) return resolve({ version });
      if (error?.killed) return resolve({ failure: 'timeout' });
      if (!error) return resolve({ failure: 'unreadable' });
      const code = typeof error.code === 'number' ? `exit ${error.code}` : /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : null;
      resolve(code ? { failure: 'failed', detail: code } : { failure: 'failed' });
    };
    try { probe(file, ['--version'], { timeout: VERSION_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 65536, windowsHide: true, shell: false, env }, settle)?.stdin?.end(); }
    catch (error) { settle(error); }
  });
}

// npm's global prefix, read without running npm: NPM_CONFIG_PREFIX, else `prefix=` in the user's .npmrc (${NAME} and a
// leading ~ expanded as npm does), then on Windows npm's default %APPDATA%\npm. A prefix may be on any drive.
async function npmPrefixes({ env, platform, home }, files, path) {
  let prefix = variable(env, 'NPM_CONFIG_PREFIX');
  const config = variable(env, 'NPM_CONFIG_USERCONFIG') || home && path.join(home, '.npmrc');
  if (!prefix && config) try { prefix = /^[ \t]*prefix[ \t]*=[ \t]*(.*?)[ \t]*$/m.exec(await files.readFile(config, 'utf8'))?.[1]; } catch { }
  const configured = prefix?.replace(/^(["'])(.*)\1$/, '$2').replace(/\$\{([^}]+)\}/g, (whole, name) => variable(env, name) ?? whole)
    .replace(/^~(?=$|[\\/])/, home || '~');
  const fallback = platform === 'win32' && variable(env, 'APPDATA');
  return [configured, fallback && path.join(fallback, 'npm')].filter(folder => folder && path.isAbsolute(folder));
}

// Where Codex installs besides PATH, as [folder, via], in search order: npm's global prefix (its shims and packages on
// Windows, its bin elsewhere), then on Windows the official installer and WinGet's command links (user, then machine),
// elsewhere the system folders.
function installFolders({ env, platform }, prefixes, path) {
  const npm = prefixes.map(prefix => [platform === 'win32' ? prefix : path.join(prefix, 'bin'), 'npm-prefix']);
  if (platform !== 'win32') return [...npm, ...['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map(folder => [folder, 'system'])];
  const local = variable(env, 'LOCALAPPDATA'), programs = variable(env, 'ProgramFiles');
  return [...npm, local && [path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin'), 'official-installer'],
    ...[local && path.join(local, 'Microsoft', 'WinGet', 'Links'), programs && path.join(programs, 'WinGet', 'Links')].filter(Boolean).map(folder => [folder, 'winget'])].filter(Boolean);
}

// The native program of an npm package of Codex, as [file, layout], this machine's CPU first: where its bin/codex.js
// looks (the platform package nested in it, then hoisted beside it, then its own vendor folder), then 0.46's single
// package, vendor/<triple>/codex/codex.exe.
function packageBinaries(dir, arch, path) {
  return (arch === 'arm64' ? ['arm64', 'x64'] : ['x64', 'arm64']).flatMap(cpu => {
    const binary = ['vendor', TRIPLES[cpu], 'bin', 'codex.exe'];
    return [[path.join(dir, 'node_modules', '@openai', `codex-win32-${cpu}`, ...binary), 'npm-vendor'],
      [path.join(path.dirname(dir), `codex-win32-${cpu}`, ...binary), 'npm-hoisted'],
      [path.join(dir, ...binary), 'npm-vendor'], [path.join(dir, 'vendor', TRIPLES[cpu], 'codex', 'codex.exe'), 'npm-vendor']];
  });
}

// A package a shim names, and where a link takes it, stays inside the shim's folder (for node_modules\.bin, the
// node_modules it sits in): never above it, and never a UNC path unless the folder itself is on that share (a mapped
// drive's real path is one).
function inside(folder, target, path) {
  const root = path.basename(folder).toLowerCase() === '.bin' ? path.dirname(folder) : folder, relative = path.relative(root, target);
  const unc = file => /^[\\/]{2}/.test(file);
  return (!unc(target) || unc(root)) && !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// One Codex locator per process, for the terminal, the dispatch helper and native mode alike (codex-runtime/BOUNDARY.md).
// A refresh reads the stored Windows PATH and searches; a throttled refresh does that at most once a minute; a locate
// keeps the last answer while it stands. `--version` runs once per file, size and mtime.
function createCodexLocator({ probe = execFile, files = fs, storedPath = readStoredPath, readNpmPrefix, now = Date.now } = {}) {
  const versions = new Map();
  let stored = null, lastFull = null, last = null, running = null, trailing = null;

  // The version a file printed, run once per file, size and mtime. One that printed none is run again only by a search
  // a refresh started (`retry`): the check never changes which file runs, and a hanging Codex must not gain a process
  // on every locate.
  async function version(real, stat, env, retry) {
    const key = `${real}\0${stat.size}\0${stat.mtimeMs}`, cached = versions.get(key);
    if (cached && (cached.version || !retry)) return cached;
    const run = await readVersion(probe, real, env);
    versions.set(key, run);
    return run;
  }
  const present = file => files.stat(file).then(stat => stat.isFile(), () => false);
  const read = async file => (await files.stat(file)).size <= SHIM_BYTES ? files.readFile(file, 'utf8') : '';
  // A runnable file behind `file`, followed through links; a broken candidate never hides the next.
  async function runnable(file, windows) {
    try {
      const real = await files.realpath(file), stat = await files.stat(real);
      if (!stat.isFile()) return null;
      await files.access(real, windows ? fs.constants.F_OK : fs.constants.X_OK);
      return { real, stat };
    } catch { return null; }
  }
  // codex.exe in `folder` or at most VENDOR_DEPTH folders below it: a package's program after a layout change no
  // table knows yet.
  async function moved(folder, path, depth = 0) {
    let names;
    try { names = await files.readdir(folder); } catch { return []; }
    const program = name => name.toLowerCase() === 'codex.exe', found = names.filter(program).map(name => path.join(folder, name));
    if (depth < VENDOR_DEPTH) for (const name of names.filter(name => !program(name))) found.push(...await moved(path.join(folder, name), path, depth + 1));
    return found;
  }

  async function search({ env, platform, arch, home, prefer }, retry) {
    const windows = platform === 'win32', path = windows ? nodePath.win32 : nodePath.posix;
    const shown = file => { const relative = home && path.relative(home, file); return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? path.join('~', relative) : file; };
    const inherited = variable(env, 'PATH') || '';
    const effective = windows && stored ? mergePath(inherited, stored, env) : inherited;
    // The entries merging added after the inherited ones came from the stored PATH alone.
    const fromStored = new Set(windows && stored ? effective.split(';').slice(mergePath(inherited, [], env).split(';').filter(Boolean).length) : []);
    const places = installFolders({ env, platform }, await (readNpmPrefix ?? (options => npmPrefixes(options, files, path)))({ env, platform, home }), path);
    const pathHash = createHash('sha256').update(JSON.stringify([platform, home, effective, places, prefer ?? null])).digest('hex').slice(0, 16);
    const searched = places.map(([place]) => shown(place)), folders = new Set();
    let pathFolders = 0, incomplete = null;

    // What one folder offers, in the wrapper's order, as [file, via, path] (`path` is what a terminal is told: the shim
    // the wrapper takes, or the file itself), and the npm packages it holds or its shims run, each with the
    // vendor/<triple> folders its layouts name as [folder, via]. `only` limits the folder to one of its files. A shim
    // the wrapper takes before codex.exe puts its packages first. WinGet's links folder offers its package's own
    // program before the link, which may be a link or a launcher. `within` is where the folder really is.
    async function offered(folder, via, only) {
      if (!windows) return { candidates: [[only ?? path.join(folder, 'codex'), via, only ?? path.join(folder, 'codex')]], packages: [] };
      const names = only ? [only] : ['.ps1', ...(variable(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), ''].map(suffix => path.join(folder, `codex${suffix}`));
      const native = name => /\.(exe|com)$/i.test(name);
      let first = null;
      for (const name of names) if (await present(name)) { first = name; break; }
      const packages = new Map(only && native(only) ? [] : [[path.join(folder, 'node_modules', '@openai', 'codex'), null]]);
      for (const name of names.filter(name => !native(name))) {
        let text = '';
        try { text = await read(name); } catch { }
        for (const [, relative] of text.matchAll(SHIM_PACKAGE)) {
          const dir = path.resolve(folder, relative);
          if (inside(folder, dir, path) && !packages.has(dir)) packages.set(dir, 'npm-shim');
        }
      }
      const shim = first && !native(first) ? first : null, npm = [], kept = [];
      const within = await files.realpath(folder).catch(() => folder);
      // A package behind a link (pnpm's store) finds its platform package beside where it really is, which stays
      // inside where the folder really is (a junction such as nvm-windows' moves both).
      for (const [dir, shimVia] of packages) {
        const real = await files.realpath(dir).catch(() => dir);
        if (!inside(within, real, path)) continue;
        const layouts = packageBinaries(real, arch, path).map(([file, layout]) => [file, via ?? shimVia ?? layout, shim ?? file]);
        npm.push(...layouts);
        kept.push({ dir, vendors: [...new Map(layouts.map(([file, layoutVia]) => [path.dirname(path.dirname(file)), layoutVia]))] });
      }
      const own = (only ? [only] : [path.join(folder, 'codex.exe')]).filter(native).map(file => [file, via, file]);
      let winget = [];
      if (via === 'winget') {
        const packageRoot = path.join(path.dirname(folder), 'Packages'), link = own[0]?.[0];
        const at = link && await present(link) ? link : null;
        try {
          winget = (await files.readdir(packageRoot)).filter(name => /^OpenAI\.Codex_/i.test(name))
            .flatMap(name => [...Object.values(TRIPLES).map(triple => `codex-${triple}.exe`), 'codex.exe'].map(file => path.join(packageRoot, name, file)))
            .map(file => [file, via, at ?? file]);
        } catch { }
      }
      return { candidates: [...winget, ...(shim ? [...npm, ...own] : [...own, ...npm])], packages: kept, shim, within };
    }

    // The preferred file first (the terminal's choice, for the helper), then PATH in its order, then the install folders.
    const queue = [...(prefer ? [[path.dirname(prefer), null, prefer]] : []), ...effective.split(windows ? ';' : ':').map(entry => [entry, null]), ...places];
    for (const [entry, place, only] of queue) {
      const folder = String(entry).trim().replace(/^"(.*)"$/, '$1'), key = path.resolve(windows ? folder.toUpperCase() : folder);
      if (!folder || !path.isAbsolute(folder) || !only && folders.has(key)) continue;
      if (!only) { folders.add(key); if (!place) pathFolders++; }
      if (await present(path.join(folder, SHIM_MARKER))) continue;
      // A PATH folder that is an install folder takes its name; npm's prefix on PATH is told by its layout instead.
      const named = place || places.find(([placeFolder, via]) => via !== 'npm-prefix' && path.relative(placeFolder, folder) === '')?.[1];
      const { candidates, packages, shim, within } = await offered(folder, named ?? null, only);
      // The answer for a candidate that runs; one a vendor tree turned up must really be where the folder is.
      const take = async ([file, layoutVia, at], confined) => {
        const found = await runnable(file, windows);
        if (!found || confined && !inside(within, found.real, path)) return null;
        const run = await version(found.real, found.stat, env, retry);
        return { file: found.real, path: at, fileShown: shown(found.real), version: run.version ?? null,
          via: layoutVia ?? (fromStored.has(entry) ? 'registry-path' : 'path'),
          fingerprint: { file: found.real, size: found.stat.size, mtimeMs: found.stat.mtimeMs, pathHash },
          reason: run.version ? null : reason(`codex.${run.failure}`, { source: SOURCE, ...(run.detail ? { detail: run.detail } : {}) }),
          searched, pathFolders };
      };
      for (const candidate of candidates) { const result = await take(candidate); if (result) return result; }
      // An npm package whose program no known layout holds: its vendor trees, before it is called incomplete.
      for (const { dir, vendors } of packages) {
        if (!await present(path.join(dir, 'bin', 'codex.js'))) continue;
        for (const [vendor, layoutVia] of vendors) for (const file of await moved(vendor, path)) {
          const result = await take([file, layoutVia, shim ?? file], true);
          if (result) return result;
        }
        incomplete ??= dir;
      }
    }
    return { file: null, path: null, fileShown: null, version: null, via: null, fingerprint: null, searched, pathFolders,
      reason: incomplete ? reason('codex.incomplete', { source: SOURCE, detail: shown(incomplete) })
        : reason('codex.not_found', { source: SOURCE, params: { pathFolders, searched: searched.join('; ') } }) };
  }

  // Whether the last answer still stands for a locate: nothing found until the next refresh; a found file, with or
  // without a version, while its `path` still leads where it led (a shim to itself, a link to the file) and the file
  // keeps its size and mtime. Windows paths compare as Windows does, whatever their letter case.
  async function stands() {
    const { result, leads, windows } = last;
    if (!result.file) return true;
    try {
      const real = await files.realpath(result.path), stat = await files.stat(result.file);
      const same = windows ? nodePath.win32.relative(real, leads) === '' : real === leads;
      return same && stat.size === result.fingerprint.size && stat.mtimeMs === result.fingerprint.mtimeMs;
    } catch { return false; }
  }
  async function answer(options, mode) {
    const full = mode === 'refresh' || mode === 'throttled' && (lastFull === null || now() - lastFull >= REFRESH_MS);
    if (full) {
      if (options.platform === 'win32') stored = await storedPath(options.env) ?? stored;
      lastFull = now();
    }
    const key = JSON.stringify([options.platform, options.home, options.arch, variable(options.env, 'PATH') || '', stored, options.prefer ?? null]);
    if (!full && last?.key === key && await stands()) return last.result;
    const result = await search(options, full);
    // Where `path` leads now, through a junction such as nvm-windows' C:\Program Files\nodejs, is what stands means.
    const leads = result.path && await files.realpath(result.path).catch(() => null);
    last = { key, result, leads, windows: options.platform === 'win32' };
    return result;
  }
  const normalized = ({ env = process.env, platform = process.platform, arch = process.arch, home, prefer } = {}) =>
    ({ env, platform, arch, home: home ?? variable(env, platform === 'win32' ? 'USERPROFILE' : 'HOME') ?? null, prefer });
  const start = (options, mode) => {
    const entry = { promise: answer(normalized(options), mode).finally(() => { if (running === entry) running = null; }) };
    running = entry;
    return entry.promise;
  };
  // Calls that overlap share one search; a refresh asked for while one runs is done once after it, however many ask.
  function shared(options, mode) {
    if (!running) return start(options, mode);
    if (mode !== 'refresh') return running.promise;
    return trailing ||= running.promise.catch(() => {}).then(() => { trailing = null; return start(options, 'refresh'); });
  }
  return {
    // `prefer`: a file to try before the search (the dispatch helper's AGENTRIX_CODEX_EXECUTABLE).
    locate: options => shared(options, 'locate'),
    // `throttled` (window focus) searches anew at most once a minute; an explicit refresh always does.
    refresh: (options, { throttled = false } = {}) => shared(options, throttled ? 'throttled' : 'refresh'),
    // The last result, for synchronous readers; null before the first search.
    peek: () => last?.result ?? null,
  };
}

// The locator of a process no host injects one into: the dispatch helper, or a runtime built without a resolver.
const processLocator = createCodexLocator();
// The Codex file to run in this environment, or null: what this process's locator found.
const codexExecutable = async (env = process.env, platform = process.platform) => (await processLocator.locate({ env, platform })).file;

module.exports = { createCodexLocator, processLocator, codexExecutable, packageBinaries, VIAS };
