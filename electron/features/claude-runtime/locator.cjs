const fs = require('node:fs/promises');
const nodePath = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { mergePath, readStoredPath, variable } = require('./path-env.cjs');
const REQUIRED = '2.1.317', MINIMUM = REQUIRED.split('.').map(Number), VERSION_TIMEOUT_MS = 10000, CLOSE_GRACE_MS = 1500;
// Every `via` a found CLI can have (claude-runtime/BOUNDARY.md).
const VIAS = Object.freeze(['path', 'npm', 'platform-package', 'local-bin', 'claude-local', 'winget', 'registry-path', 'system']);
// A throttled refresh (window focus) searches with the stored Windows PATH at most this often; a check that printed no
// version is trusted this long before a locate or a throttled refresh runs it again (an explicit refresh always does).
const REFRESH_MS = 60000, FAILURE_RETRY_MS = 10000;
const VERSION = /\b(\d+)\.(\d+)\.(\d+)\b/;
// npm's package ships bin/claude.exe as a shell-script placeholder of a few hundred bytes; its postinstall puts the
// native program of the platform package in its place. install.cjs tells the two apart by this size.
const STUB_BYTES = 4096, NPM_BIN = /[\\/]@anthropic-ai[\\/]claude-code[\\/]bin[\\/]claude\.exe$/i, SHIM_BYTES = 65536;
// The package a cmd-shim (claude.cmd) or its PowerShell twin (claude.ps1) runs, relative to the shim's folder: npm's
// `%dp0%\node_modules\...`, pnpm's `%~dp0\global\5\.pnpm\...\node_modules\...`, `$basedir/node_modules/...`.
const SHIM_PACKAGE = /(?:%~?dp0%?|\$basedir)[\\/]((?:[^"\r\n]*?[\\/])?node_modules[\\/]@anthropic-ai[\\/]claude-code)[\\/]/gi;
const meets = match => {
  const version = match.slice(1, 4).map(Number), first = version.findIndex((part, index) => part !== MINIMUM[index]);
  return first < 0 || version[first] > MINIMUM[first];
};
const failed = error => {
  const code = typeof error?.code === 'number' ? `exit ${error.code}` : typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : null;
  return code ? { reason: 'failed', error: code } : { reason: 'failed' };
};

// The deadline and the grace after it each wait one more turn of the event loop before they act: when the main
// process was busy past them, the exit or close already waiting to be read wins, so a CLI that answered in time is
// not taken for one that hung. The grace lets the output close; a descendant still holding it open must not hold
// the check. A version printed before the kill still counts.
function readVersion(probe, file, env, timeoutMs, graceMs) {
  return new Promise(resolve => {
    const started = Date.now();
    let child, timer, done = false, killed = false;
    const settle = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timedOut = () => ({ reason: 'timeout', elapsedMs: Date.now() - started });
    timer = setTimeout(() => setImmediate(() => {
      if (done) return;
      if (child && child.exitCode === null && child.signalCode === null) {
        killed = true;
        try { child.kill('SIGKILL'); } catch { }
      }
      timer = setTimeout(() => setImmediate(() => {
        if (done) return;
        try { child?.stdout?.destroy(); child?.stderr?.destroy(); } catch { }
        settle(killed ? timedOut() : { reason: 'unreadable' });
      }), graceMs);
    }), timeoutMs);
    try {
      child = probe(file, ['--version'], { maxBuffer: 65536, windowsHide: true, shell: false, env },
        (error, stdout) => {
          const text = String(stdout ?? '');
          settle(killed ? VERSION.test(text) ? { stdout: text } : timedOut() : error ? failed(error) : { stdout: text });
        });
    } catch (error) { settle(failed(error)); }
  });
}

// Where an install puts Claude Code besides PATH, and the `via` each folder gives: the native installer, the legacy
// local npm install, on Windows WinGet's command links (user, then machine), the system folders elsewhere.
function installFolders(env, platform, home, path) {
  const own = [[path.join(home, '.local', 'bin'), 'local-bin'], [path.join(home, '.claude', 'local'), 'claude-local']];
  if (platform !== 'win32') return [...own, ...['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map(folder => [folder, 'system'])];
  const local = variable(env, 'LOCALAPPDATA'), programs = variable(env, 'ProgramFiles');
  return [...own, ...[local && path.join(local, 'Microsoft', 'WinGet', 'Links'), programs && path.join(programs, 'WinGet', 'Links')].filter(Boolean).map(folder => [folder, 'winget'])];
}

// The native program of an npm package that skipped its postinstall (npm 12 by default, --ignore-scripts, pnpm): the
// platform package's own copy, beside the package or nested in it.
function platformCopies(dir, platform, arch, path) {
  const keys = platform === 'win32' ? (arch === 'arm64' ? ['arm64', 'x64'] : ['x64', 'arm64']).map(cpu => `win32-${cpu}`)
    : [`${platform}-${arch}`, ...(platform === 'linux' ? [`linux-${arch}-musl`] : [])];
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  return keys.flatMap(key => [path.join(path.dirname(dir), `claude-code-${key}`, name), path.join(dir, 'node_modules', '@anthropic-ai', `claude-code-${key}`, name)]);
}

// A package a shim names stays inside the shim's folder: never a UNC path, never above the folder.
function inside(folder, target, path) {
  const relative = path.relative(folder, target);
  return !/^[\\/]{2}/.test(target) && !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// The files one folder offers, in the wrapper's order, as [file, via]: its own claude(.exe) through `via`, then the
// bin/claude.exe of each npm package it holds through `packageVia`; a shim the wrapper takes before claude.exe puts
// the packages first. Nothing is read here: `packages` and `shimFirst` are what was read of the folder.
function folderCandidates(folder, { windows, path, via, packageVia, packages, shimFirst }) {
  const own = [path.join(folder, windows ? 'claude.exe' : 'claude'), via];
  const npm = packages.map(dir => [path.join(dir, 'bin', 'claude.exe'), packageVia]);
  return shimFirst ? [...npm, own] : [own, ...npm];
}

// Found on PATH or through an npm package, as opposed to an install folder that names itself.
const generic = via => via === 'path' || via === 'registry-path' || via === 'npm';

// One Claude Code locator per process: what the terminal runs and what the native path runs, from one search order
// (claude-runtime/BOUNDARY.md). A refresh reads the stored Windows PATH and searches; a throttled refresh does that at
// most once a minute; a locate keeps the last answer while it stands. `--version` runs once per file, size and mtime.
function createLocator({ probe = execFile, files = fs, storedPath = readStoredPath, now = Date.now,
  timeoutMs = VERSION_TIMEOUT_MS, graceMs = CLOSE_GRACE_MS } = {}) {
  const versions = new Map();
  let stored = null, lastFull = null, last = null, running = null, trailing = null;

  // The version a file printed, run once per file, size and mtime; one that printed none is run again after a while,
  // or at once for an explicit refresh (`retry`).
  async function version(real, stat, env, retry) {
    const key = `${real}\0${stat.size}\0${stat.mtimeMs}`, cached = versions.get(key);
    if (cached && (cached.ok || !retry && now() - cached.at < FAILURE_RETRY_MS)) return cached.run;
    const run = await readVersion(probe, real, env, timeoutMs, graceMs);
    versions.set(key, { run, ok: run.stdout !== undefined && VERSION.test(run.stdout), at: now() });
    return run;
  }
  const read = async file => (await files.stat(file)).size <= SHIM_BYTES ? files.readFile(file, 'utf8') : '';

  // What the search needs to know of one folder: the npm packages beside its shims (an npm prefix on Windows holds
  // both) and the ones its shims name, whether a shim comes before claude.exe for the wrapper, and the version of a
  // package from before the native program (bin cli.js), which is never run.
  async function readFolder(folder, { windows, path, env }) {
    const dirs = new Set([path.join(folder, 'node_modules', '@anthropic-ai', 'claude-code')]);
    let shimFirst = false, outdated = null;
    if (windows) {
      for (const shim of ['claude.cmd', 'claude.ps1']) {
        try {
          for (const [, relative] of (await read(path.join(folder, shim))).matchAll(SHIM_PACKAGE)) {
            const dir = path.resolve(folder, relative);
            if (inside(folder, dir, path)) dirs.add(dir);
          }
        } catch { }
      }
      for (const suffix of ['.ps1', ...(variable(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), '']) {
        try {
          if ((await files.stat(path.join(folder, `claude${suffix}`))).isFile()) { shimFirst = !/^\.(exe|com)$/i.test(suffix); break; }
        } catch { }
      }
    }
    for (const dir of dirs) {
      try {
        await files.access(path.join(dir, 'cli.js'));
        const match = VERSION.exec(JSON.parse(await read(path.join(dir, 'package.json'))).version);
        if (match && !meets(match)) outdated ||= match[0];
      } catch { }
    }
    return { packages: [...dirs], shimFirst, outdated };
  }

  async function search({ env, platform, arch, home }, retry) {
    const path = platform === 'win32' ? nodePath.win32 : nodePath.posix, windows = platform === 'win32';
    const shown = file => { const relative = path.relative(home, file); return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? path.join('~', relative) : file; };
    const inherited = variable(env, 'PATH') || '';
    const effective = windows && stored ? mergePath(inherited, stored, env) : inherited;
    // The entries merging added after the inherited ones came from the stored PATH alone.
    const fromStored = new Set(windows && stored ? effective.split(';').slice(mergePath(inherited, [], env).split(';').filter(Boolean).length) : []);
    const places = installFolders(env, platform, home, path);
    const pathHash = createHash('sha256').update(JSON.stringify([platform, home, effective, places])).digest('hex').slice(0, 16);
    const checked = new Set(), folders = new Set(), found = [];
    let outdated = null, failure = null, incomplete = null, pathFolders = 0;

    // A runnable native file found at `file` through `via`; npm's placeholder gives way to its platform package's copies.
    async function check(file, via) {
      let real, stat;
      try {
        real = await files.realpath(file);
        if (checked.has(real) || !(stat = await files.stat(real)).isFile()) return;
        await files.access(real, windows ? fs.constants.F_OK : fs.constants.X_OK);
      } catch { return; } // A broken candidate must not hide another installed native executable.
      checked.add(real);
      if (stat.size < STUB_BYTES && NPM_BIN.test(real)) {
        const dir = path.dirname(path.dirname(real));
        incomplete ||= dir;
        for (const copy of platformCopies(dir, platform, arch, path)) await check(copy, generic(via) ? 'platform-package' : via);
        return;
      }
      const { stdout, ...run } = await version(real, stat, env, retry);
      const match = stdout === undefined ? null : VERSION.exec(stdout);
      if (!match) { failure ||= { reason: 'unreadable', ...run, found: real }; return; }
      const kind = generic(via) && NPM_BIN.test(real) ? 'npm' : via;
      found.push({ meets: meets(match), candidate: { file: real, path: file, fileShown: shown(real), version: match[0], via: kind,
        fingerprint: { file: real, size: stat.size, mtimeMs: stat.mtimeMs, pathHash } } });
    }

    // PATH in its order, then the install folders; the search stops once one meets REQUIRED.
    for (const [entry, place] of [...effective.split(windows ? ';' : ':').map(entry => [entry, null]), ...places]) {
      const folder = String(entry).trim().replace(/^"(.*)"$/, '$1'), key = path.resolve(windows ? folder.toUpperCase() : folder);
      if (!folder || !path.isAbsolute(folder) || folders.has(key)) continue;
      folders.add(key);
      if (!place) pathFolders++;
      const named = place || places.find(([folderOf]) => path.relative(folderOf, folder) === '')?.[1];
      const facts = await readFolder(folder, { windows, path, env });
      outdated ||= facts.outdated;
      const via = named || (fromStored.has(entry) ? 'registry-path' : 'path');
      for (const [file, kind] of folderCandidates(folder, { windows, path, via, packageVia: named || 'npm', ...facts })) await check(file, kind);
      if (found.some(item => item.meets)) break;
    }

    const terminal = found[0]?.candidate ?? null, native = found.find(item => item.meets)?.candidate ?? null;
    const result = { terminal, native, pathHash, effectivePath: effective };
    if (native) return { ...result, reason: native === terminal ? null : 'cli_split_versions' };
    if (outdated || terminal) return { ...result, reason: 'too_old', version: terminal?.version || outdated };
    if (failure) return { ...result, reason: failure.reason, failure };
    return { ...result, reason: 'not_found', pathFolders, searched: places.map(([place]) => shown(place)), ...(incomplete ? { incomplete: shown(incomplete) } : {}) };
  }

  // Whether the last answer still stands for a locate: a failed check for a short while, nothing found until the next
  // refresh, a found CLI while the path it was found at still leads to the same file at the same size and mtime.
  async function stands() {
    if (last.result.failure) return now() - last.at < FAILURE_RETRY_MS;
    for (const candidate of new Set([last.result.terminal, last.result.native].filter(Boolean))) {
      try {
        if (await files.realpath(candidate.path) !== candidate.file) return false;
        const stat = await files.stat(candidate.file);
        if (stat.size !== candidate.fingerprint.size || stat.mtimeMs !== candidate.fingerprint.mtimeMs) return false;
      } catch { return false; }
    }
    return true;
  }
  async function answer(options, mode) {
    const full = mode === 'refresh' || mode === 'throttled' && (lastFull === null || now() - lastFull >= REFRESH_MS);
    if (full) {
      if (options.platform === 'win32') stored = await storedPath(options.env) ?? stored;
      lastFull = now();
    }
    const key = JSON.stringify([options.platform, options.home, options.arch, variable(options.env, 'PATH') || '', stored]);
    if (!full && last?.key === key && await stands()) return last.result;
    last = { key, result: await search(options, mode === 'refresh'), at: now() };
    return last.result;
  }
  const normalized = ({ env = process.env, platform = process.platform, arch = process.arch, home = os.homedir() } = {}) => ({ env, platform, arch, home });
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
    locate: options => shared(options, 'locate'),
    // `throttled` (window focus) searches anew at most once a minute; an explicit refresh always does.
    refresh: (options, { throttled = false } = {}) => shared(options, throttled ? 'throttled' : 'refresh'),
    // The last result, for synchronous readers; null before the first search.
    peek: () => last?.result ?? null,
  };
}

module.exports = { createLocator, REQUIRED, VIAS };
