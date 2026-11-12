const fs = require('node:fs/promises');
const nodePath = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { mergePath, readStoredPath, variable } = require('./path-env.cjs');
const REQUIRED = '2.1.317', MINIMUM = REQUIRED.split('.').map(Number), VERSION_TIMEOUT_MS = 10000, CLOSE_GRACE_MS = 1500;
// Every `via` a found CLI can have (claude-runtime/BOUNDARY.md).
const VIAS = Object.freeze(['path', 'npm', 'platform-package', 'local-bin', 'claude-local', 'winget', 'registry-path', 'system']);
// While nothing is found, a refresh reads the stored Windows PATH at most this often.
const MISSING_REREAD_MS = 60000;
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

// One Claude Code locator per process: what the terminal runs and what the native path runs, from one search order
// (claude-runtime/BOUNDARY.md). A refresh reads the stored Windows PATH and searches; a locate only stats what the last
// search chose and searches again only when a file or the PATH changed. `--version` runs once per file, size and mtime.
function createLocator({ probe = execFile, files = fs, storedPath = readStoredPath, now = Date.now,
  timeoutMs = VERSION_TIMEOUT_MS, graceMs = CLOSE_GRACE_MS } = {}) {
  const versions = new Map();
  let stored = null, storedAt = null, last = null, running = null;

  async function search({ env, platform, arch, home }) {
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
    const read = async file => (await files.stat(file)).size <= SHIM_BYTES ? files.readFile(file, 'utf8') : '';

    // The version a file printed, run once per file, size and mtime. A check that printed none is not kept: the next
    // search tries again.
    async function version(real, stat) {
      const key = `${real}\0${stat.size}\0${stat.mtimeMs}`;
      if (versions.has(key)) return versions.get(key);
      const run = await readVersion(probe, real, env, timeoutMs, graceMs);
      if (run.stdout !== undefined && VERSION.test(run.stdout)) versions.set(key, run);
      return run;
    }
    // Found on PATH or through an npm package, as opposed to an install folder that names itself.
    const generic = via => via === 'path' || via === 'registry-path' || via === 'npm';
    // A runnable native file found through `via`; a placeholder is replaced by its platform package's copies.
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
      const { stdout, ...run } = await version(real, stat);
      const match = stdout === undefined ? null : VERSION.exec(stdout);
      if (!match) { failure ||= { reason: 'unreadable', ...run, found: real }; return; }
      found.push({ meets: meets(match), candidate: { file: real, fileShown: shown(real), version: match[0], via: generic(via) && NPM_BIN.test(real) ? 'npm' : via,
        fingerprint: { file: real, size: stat.size, mtimeMs: stat.mtimeMs, pathHash } } });
    }
    // The npm package beside a folder's shims (an npm prefix on Windows holds both) and the ones its shims name. One
    // from before the native program (bin cli.js) is older than REQUIRED by its own package.json, and is not run.
    async function packages(folder) {
      const dirs = new Set([path.join(folder, 'node_modules', '@anthropic-ai', 'claude-code')]);
      if (windows) for (const shim of ['claude.cmd', 'claude.ps1']) {
        try { for (const [, relative] of (await read(path.join(folder, shim))).matchAll(SHIM_PACKAGE)) dirs.add(path.resolve(folder, relative)); } catch { }
      }
      for (const dir of dirs) {
        try {
          await files.access(path.join(dir, 'cli.js'));
          const match = VERSION.exec(JSON.parse(await read(path.join(dir, 'package.json'))).version);
          if (match && !meets(match)) outdated ||= match[0];
        } catch { }
      }
      return [...dirs].map(dir => path.join(dir, 'bin', 'claude.exe'));
    }
    // Within a Windows folder the wrapper takes the first of claude.ps1, claude + each PATHEXT, bare claude: a shim
    // that comes first there puts its npm package before the folder's claude.exe.
    const suffixes = ['.ps1', ...(variable(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), ''];
    async function shimFirst(folder) {
      for (const suffix of suffixes) {
        try { if ((await files.stat(path.join(folder, `claude${suffix}`))).isFile()) return !/^\.(exe|com)$/i.test(suffix); } catch { }
      }
      return false;
    }
    // The search stops once the terminal's file is known and one meets REQUIRED.
    const done = () => found.some(item => item.meets);
    const pathEntries = effective.split(windows ? ';' : ':').map(entry => [entry, null]);
    for (const [entry, kind] of [...pathEntries, ...places]) {
      const folder = String(entry).trim().replace(/^"(.*)"$/, '$1'), key = windows ? folder.toUpperCase() : folder;
      if (!folder || !path.isAbsolute(folder) || folders.has(path.resolve(key))) continue;
      folders.add(path.resolve(key));
      if (!kind) pathFolders++;
      const named = places.find(([place]) => path.relative(place, folder) === '')?.[1];
      const exe = [path.join(folder, windows ? 'claude.exe' : 'claude'), kind || named || (fromStored.has(entry) ? 'registry-path' : 'path')];
      const npm = (await packages(folder)).map(file => [file, kind || named || 'npm']);
      for (const [file, via] of windows && await shimFirst(folder) ? [...npm, exe] : [exe, ...npm]) await check(file, via);
      if (done()) break;
    }
    const terminal = found[0]?.candidate ?? null, native = found.find(item => item.meets)?.candidate ?? null;
    const result = { terminal, native, pathHash, effectivePath: effective };
    if (native) return { ...result, reason: native === terminal ? null : 'cli_split_versions' };
    if (outdated || terminal) return { ...result, reason: 'too_old', version: terminal?.version || outdated };
    if (failure) return { ...result, reason: failure.reason, failure };
    return { ...result, reason: 'not_found', pathFolders, searched: places.map(([place]) => shown(place)), ...(incomplete ? { incomplete: shown(incomplete) } : {}) };
  }

  // What the last search chose is still there at the size and mtime it had.
  async function unchanged() {
    for (const candidate of new Set([last.result.terminal, last.result.native].filter(Boolean))) {
      try {
        const stat = await files.stat(candidate.file);
        if (stat.size !== candidate.fingerprint.size || stat.mtimeMs !== candidate.fingerprint.mtimeMs) return false;
      } catch { return false; }
    }
    return true;
  }
  async function answer(options, fresh) {
    if (fresh && options.platform === 'win32' && (last?.result.native || storedAt === null || now() - storedAt >= MISSING_REREAD_MS)) {
      stored = await storedPath(options.env) ?? stored; storedAt = now();
    }
    // Under the same PATH a locate keeps the last answer while its files are unchanged; nothing found stays the answer
    // until the next refresh.
    const key = JSON.stringify([options.platform, options.home, options.arch, variable(options.env, 'PATH') || '', stored]);
    if (!fresh && last?.key === key && (!last.result.terminal || await unchanged())) return last.result;
    last = { key, result: await search(options) };
    return last.result;
  }
  const normalized = ({ env = process.env, platform = process.platform, arch = process.arch, home = os.homedir() } = {}) => ({ env, platform, arch, home });
  // Calls that overlap share one search; a refresh asked for during a plain locate runs after it.
  const shared = (options, fresh) => {
    if (running && (running.fresh || !fresh)) return running.promise;
    const before = running ? running.promise.catch(() => {}) : Promise.resolve();
    const entry = { fresh, promise: before.then(() => answer(normalized(options), fresh)).finally(() => { if (running === entry) running = null; }) };
    running = entry;
    return entry.promise;
  };
  return {
    locate: options => shared(options, false),
    refresh: options => shared(options, true),
    // The last result, for synchronous readers; null before the first search.
    peek: () => last?.result ?? null,
  };
}

module.exports = { createLocator, REQUIRED, VIAS };
