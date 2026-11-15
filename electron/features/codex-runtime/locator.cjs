const fs = require('node:fs/promises');
const nodePath = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { mergePath, readStoredPath, variable } = require('../claude-runtime/path-env.cjs');
const { reason } = require('../../shared/reason.cjs');
const { SHIM_MARKER, STAND_IN_MARKER } = require('../../shared/agentrix-shims.cjs');
// Every `via` a found Codex can have (codex-runtime/BOUNDARY.md).
const VIAS = Object.freeze(['path', 'npm-shim', 'npm-vendor', 'npm-hoisted', 'npm-prefix', 'registry-path', 'official-installer', 'winget', 'system',
  'scoop', 'chocolatey', 'volta', 'bun', 'pnpm', 'yarn', 'nvm', 'fnm', 'vscode-extension', 'registry', 'drive-scan']);
const VERSION = /\b\d+\.\d+\.\d+(?:-[\w.]+)?/, VERSION_TIMEOUT_MS = 10000, SHIM_BYTES = 65536, SOURCE = 'codex-runtime locator';
// A throttled refresh (window focus) searches with the stored Windows PATH at most this often. While nothing is found,
// the local drives are scanned by themselves at most once a day (the last empty scan's time is kept across starts), and
// a scan settles within SCAN_DEADLINE_MS whatever a drive does.
const REFRESH_MS = 60000, SCAN_MS = 24 * 3600000, SCAN_DEADLINE_MS = 30000;
// What the drive scan counts as a candidate: a codex.exe in a folder, or npm's package below it (the folder is its prefix).
const SCAN_HITS = { names: ['codex.exe'], probes: [['node_modules', '@openai', 'codex', 'bin', 'codex.js']] };
// A file only a scan or the registry named is Codex only when its --version reads as Codex's own: any program may be
// called codex.exe, and Agentrix's own stand-ins print a version too (they are skipped by STAND_IN_MARKER).
const STRICT = new Set(['drive-scan', 'registry']), CODEX_OUTPUT = /^codex(?:-cli)? \d+\.\d+\.\d+/m;
// How many folders below vendor/<triple> a package's program is looked for when no known layout holds it.
const VENDOR_DEPTH = 3;
// The Windows CPUs npm ships a platform package for, and the target triple of each one's binary.
const TRIPLES = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' };
// The package a shim runs, relative to the shim's folder: npm's `%dp0%\node_modules\@openai\codex` (a global prefix) or
// `$basedir/../@openai/codex` (a project's node_modules\.bin), pnpm's `%~dp0\global\5\node_modules\@openai\codex`.
const SHIM_PACKAGE = /(?:%~?dp0%?|\$basedir)[\\/]((?:[^"\r\n%$]*?[\\/])?@openai[\\/]codex)[\\/]bin[\\/]codex\.js/gi;

// What `codex --version` printed, or why it printed none, and whether it read as Codex's own (`codex`). Its input is
// closed at once, so a stand-in that reads it ends.
function readVersion(probe, file, env) {
  return new Promise(resolve => {
    const settle = (error, stdout) => {
      const version = VERSION.exec(String(stdout ?? ''))?.[0];
      if (version) return resolve({ version, codex: CODEX_OUTPUT.test(String(stdout)) });
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

// Names in version order, newest first, by the numbers in them (v22.11.0, openai.chatgpt-0.4.12-win32-x64).
const newestFirst = names => names.map(name => [name, (name.match(/\d+/g) ?? []).map(Number)])
  .sort(([, a], [, b]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return (b[i] ?? -1) - (a[i] ?? -1); return 0; })
  .map(([name]) => name);

// Where other installers put Codex on Windows, searched after WinGet, as [folder, via, file?], and only those that are
// there, so the search says where it really looked: Scoop's app and shims (user, then global), Chocolatey's and Volta's
// shims, Bun's bin and global packages, pnpm's home, Yarn's bin and global packages, nvm-windows' active link and each
// version (newest first), fnm's versions, and the codex.exe the OpenAI extension of VS Code and its forks bundles
// (newest first, this CPU's first).
async function managerFolders({ env, home, arch }, files, path) {
  const at = (base, ...parts) => (base ? path.join(base, ...parts) : null);
  const list = async dir => { try { return (await files.readdir(dir)).map(String); } catch { return null; } };
  const below = async (dir, pattern, ...rest) => newestFirst(((dir && await list(dir)) ?? []).filter(name => pattern.test(name))).map(name => path.join(dir, name, ...rest));
  const local = variable(env, 'LOCALAPPDATA'), data = variable(env, 'ProgramData') || 'C:\\ProgramData';
  const fnm = variable(env, 'FNM_DIR') || at(variable(env, 'APPDATA'), 'fnm'), cpu = arch === 'arm64' ? /aarch64|arm64/i : /x86_64|x64/i;
  const editors = [];
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    for (const extension of await below(at(home, editor, 'extensions'), /^openai\.chatgpt-\d/i, 'bin')) {
      const platforms = await below(extension, /^windows-/i);
      editors.push(...[...platforms.filter(dir => cpu.test(path.basename(dir))), ...platforms.filter(dir => !cpu.test(path.basename(dir)))].map(dir => [dir, 'vscode-extension']));
    }
  }
  const candidates = [
    ...[variable(env, 'SCOOP') || at(home, 'scoop'), variable(env, 'SCOOP_GLOBAL') || at(data, 'scoop')].flatMap(root => [[at(root, 'apps', 'codex', 'current'), 'scoop'], [at(root, 'shims'), 'scoop']]),
    [at(variable(env, 'ChocolateyInstall') || at(data, 'chocolatey'), 'bin'), 'chocolatey'], [at(variable(env, 'VOLTA_HOME') || at(local, 'Volta'), 'bin'), 'volta'],
    [at(home, '.bun', 'bin'), 'bun'], [at(home, '.bun', 'install', 'global'), 'bun'], [variable(env, 'PNPM_HOME') || at(local, 'pnpm'), 'pnpm'],
    [at(local, 'Yarn', 'bin'), 'yarn'], [at(local, 'Yarn', 'Data', 'global'), 'yarn'],
    [variable(env, 'NVM_SYMLINK'), 'nvm'], ...(await below(variable(env, 'NVM_HOME'), /^v\d/i)).map(dir => [dir, 'nvm']),
    ...(await below(at(fnm, 'node-versions'), /^v\d/i, 'installation')).map(dir => [dir, 'fnm']), ...editors,
  ].filter(([folder]) => folder && path.isAbsolute(folder));
  const there = await Promise.all(candidates.map(async ([folder]) => await list(folder) !== null));
  return candidates.filter((_, index) => there[index]);
}
// The places the registry names, searched only when every other place found nothing: App Paths' file, and an
// Uninstall entry's folder and its bin.
const registryFolders = registered => [...(registered?.files ?? []).map(file => [nodePath.win32.dirname(file), 'registry', file]),
  ...(registered?.folders ?? []).flatMap(folder => [[folder, 'registry'], [nodePath.win32.join(folder, 'bin'), 'registry']])];

// What the registry names for Codex: App Paths' codex.exe (user, then machine) and the InstallLocation of each
// Uninstall entry whose DisplayName mentions Codex, read through the PowerShell of the environment's own SystemRoot
// (an environment without one reads nothing), as readStoredPath reads the stored PATH. Nothing is written; a read that
// fails or takes too long gives null.
function readRegistry(env, { run = execFile, timeoutMs = 5000 } = {}) {
  const root = variable(env, 'SystemRoot');
  if (!root) return Promise.resolve(null);
  const script = "$o=@();foreach($h in 'HKCU','HKLM'){try{$v=(Get-ItemProperty -LiteralPath \"$($h):\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\codex.exe\" -ErrorAction Stop).'(default)';if($v){$o+='file'+[char]9+$v}}catch{}};"
    + "foreach($k in 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'){"
    + "Get-ItemProperty -Path $k -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -match 'codex' -and $_.InstallLocation}|ForEach-Object{$o+='folder'+[char]9+$_.InstallLocation}};"
    + "[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($o -join [char]0))))";
  return new Promise(resolve => {
    try {
      run(nodePath.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: timeoutMs, env }, (error, stdout) => {
        if (error) return resolve(null);
        const found = { files: [], folders: [] };
        for (const line of Buffer.from(String(stdout).trim(), 'base64').toString('utf8').split('\0')) {
          const [kind, raw] = line.split('\t'), value = raw?.trim().replace(/^"(.*)"$/, '$1');
          if (value && nodePath.win32.isAbsolute(value) && (kind === 'file' || kind === 'folder')) found[`${kind}s`].push(value);
        }
        resolve(found);
      });
    } catch { resolve(null); }
  });
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

// The share (\\server\share\) a path is on, or null for a local one.
const shareOf = (file, path) => (/^[\\/]{2}/.test(file) ? path.parse(path.resolve(file)).root.toLowerCase() : null);
// A package a shim names stays inside the shim's folder (for node_modules\.bin, the node_modules it sits in): never
// above it, and never a UNC path unless the folder itself is on that share. This is the guard: whoever can plant a
// link in the folder can as well write its shim.
function inside(folder, target, path) {
  const root = path.basename(folder).toLowerCase() === '.bin' ? path.dirname(folder) : folder, relative = path.relative(root, target);
  return (!shareOf(target, path) || !!shareOf(root, path)) && !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
// Where a link really leads may be anywhere on this machine (npm's globals moved to D: by a junction, `npm link`), but
// not onto a share unless the folder really is on that same share (a mapped drive).
const onShareOf = (folder, real, path) => !shareOf(real, path) || shareOf(real, path) === shareOf(folder, path);

// Main's one Codex locator serves the terminal and native mode alike; the dispatch helper builds its own
// (codex-runtime/BOUNDARY.md). A refresh reads the stored Windows PATH and searches; a throttled refresh does that at
// most once a minute; a locate keeps the last answer while it stands. `--version` runs once per file, size and mtime.
// Main alone gives `scan` (drive-scan.cjs's walk of the local drives), `store` (where a hit, or the time of the last
// empty scan, is kept across starts) and `changed` (told when a background scan changed the answer); without them
// nothing is scanned. `wait(ms)` is the scan's deadline timer.
function createCodexLocator({ probe = execFile, files = fs, storedPath = readStoredPath, registry = readRegistry, readNpmPrefix, now = Date.now,
  scan = null, store = null, changed = () => {}, wait = ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); }) } = {}) {
  const versions = new Map();
  let stored = null, registered = null, lastFull = null, last = null, latest = null, running = null, trailing = null;
  // The running scan, when this process last began one, and how many scans settled with what last (a hit or null).
  let scanning = null, scannedAt = null, scansSettled = 0, scanAnswer = null;
  const save = value => Promise.resolve().then(() => store?.write(value)).catch(() => {});
  const keep = found => save({ file: found.file, path: found.path, size: found.fingerprint.size, mtimeMs: found.fingerprint.mtimeMs });

  // The version a file printed, run once per file, size and mtime. One that printed none is run again only by a search
  // a refresh started (`retry`): the check never changes which file runs, and a hanging Codex must not gain a process
  // on every locate. `starting` is told just before the check runs.
  async function version(real, stat, env, retry, starting) {
    const key = `${real}\0${stat.size}\0${stat.mtimeMs}`, cached = versions.get(key);
    if (cached && (cached.version || !retry)) return cached;
    starting();
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

  // `found` is told the file chosen, without its version, while a check runs: what a terminal is told need not wait
  // for a slow `--version` (Defender scanning a cold codex.exe). `entries`, as [folder, via, file?], replaces the
  // search order: the folders a drive scan or the store gave.
  async function search({ env, platform, arch, home, prefer }, retry, found, entries = null) {
    const windows = platform === 'win32', path = windows ? nodePath.win32 : nodePath.posix;
    const shown = file => { const relative = home && path.relative(home, file); return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? path.join('~', relative) : file; };
    const inherited = variable(env, 'PATH') || '';
    const effective = windows && stored ? mergePath(inherited, stored, env) : inherited;
    // The entries merging added after the inherited ones came from the stored PATH alone.
    const fromStored = new Set(windows && stored ? effective.split(';').slice(mergePath(inherited, [], env).split(';').filter(Boolean).length) : []);
    const places = [...installFolders({ env, platform }, await (readNpmPrefix ?? (options => npmPrefixes(options, files, path)))({ env, platform, home }), path),
      ...(windows ? await managerFolders({ env, home, arch }, files, path) : [])];
    const pathHash = createHash('sha256').update(JSON.stringify([platform, home, effective, places, prefer ?? null])).digest('hex').slice(0, 16);
    // An npm prefix the .npmrc names may be %APPDATA%\npm as well: each place is said once.
    const searched = [...new Set(places.map(([place]) => shown(place)))], folders = new Set();
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
      // A package behind a link (pnpm's store, a junction to D:\npm\node_modules) finds its platform package beside
      // where it really is. One really on a share the folder is not on is passed over, and so is not incomplete either.
      for (const [dir, shimVia] of packages) {
        const real = await files.realpath(dir).catch(() => dir);
        if (!onShareOf(within, real, path)) continue;
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
    const queue = entries ?? [...(prefer ? [[path.dirname(prefer), null, prefer]] : []), ...effective.split(windows ? ';' : ':').map(entry => [entry, null]), ...places];
    for (const [entry, place, only] of queue) {
      const folder = String(entry).trim().replace(/^"(.*)"$/, '$1'), key = path.resolve(windows ? folder.toUpperCase() : folder);
      if (!folder || !path.isAbsolute(folder) || !only && folders.has(key)) continue;
      if (!only) { folders.add(key); if (!place) pathFolders++; }
      if (await present(path.join(folder, SHIM_MARKER))) continue;
      // A PATH folder that is an install folder takes its name; npm's prefix on PATH is told by its layout instead.
      const named = place || places.find(([placeFolder, via]) => via !== 'npm-prefix' && path.relative(placeFolder, folder) === '')?.[1];
      const { candidates, packages, shim, within } = await offered(folder, named ?? null, only);
      // The answer for a candidate that runs (told to `found` without a version while its check runs); one a vendor
      // tree turned up is not really on a share the folder is not on. A scan's or the registry's candidate is the
      // answer only once its --version reads as Codex's, so it is never told before.
      const take = async ([file, layoutVia, at], confined) => {
        const program = await runnable(file, windows), strict = STRICT.has(layoutVia);
        if (!program || confined && !onShareOf(within, program.real, path)) return null;
        const said = run => ({ file: program.real, path: at, fileShown: shown(program.real), version: run.version ?? null,
          via: layoutVia ?? (fromStored.has(entry) ? 'registry-path' : 'path'),
          fingerprint: { file: program.real, size: program.stat.size, mtimeMs: program.stat.mtimeMs, pathHash },
          reason: run.failure ? reason(`codex.${run.failure}`, { source: SOURCE, ...(run.detail ? { detail: run.detail } : {}) }) : null,
          searched, pathFolders });
        const run = await version(program.real, program.stat, env, retry, strict ? () => {} : () => found(said({})));
        return strict && !run.codex ? null : said(run);
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
  // Nothing found on Windows. The kept hit's folder is searched again as a scan's would be, so an in-place update keeps
  // Codex found (and kept anew); nothing that runs there drops it and scans at once. Otherwise a scan of the local
  // drives (`due`, which the caller starts once the answer is kept) begins when none runs and one was asked for
  // (`scan`), or a full search finds the last one (this process's, or the empty one the store keeps) a day old or
  // none at all. The answer says whether a scan is running or has looked everywhere.
  async function unfound(options, mode, full, chosen, result) {
    const kept = await Promise.resolve().then(() => store?.read()).catch(() => null);
    let dropped = false;
    if (kept?.path) {
      const again = await search(options, full, chosen, [[nodePath.win32.dirname(kept.path), 'drive-scan']]);
      if (again.file) {
        if (again.file !== kept.file || again.fingerprint.size !== kept.size || again.fingerprint.mtimeMs !== kept.mtimeMs) await keep(again);
        return { result: again, due: false };
      }
      await save(null);
      dropped = true;
    }
    const lastScan = scannedAt ?? (typeof kept?.emptyAt === 'number' ? kept.emptyAt : null);
    const due = !scanning && (dropped || mode === 'scan' || full && (lastScan === null || now() - lastScan >= SCAN_MS));
    const scanState = due || scanning ? 'running' : lastScan !== null ? 'done' : null;
    return { result: scanState ? { ...result, scan: scanState } : result, due };
  }
  // The walk offers each candidate folder to the same search as any folder, with via `drive-scan`; the first that
  // runs as Codex ends it, becomes the answer while nothing else was found meanwhile, and is kept, and an empty scan
  // keeps its time. The scan settles by SCAN_DEADLINE_MS whatever a drive does, and `changed` is told.
  function driveScan(options) {
    scannedAt = now();
    const accept = folder => search(options, true, () => {}, [[folder, 'drive-scan']]).then(found => found.file ? found : null);
    const walk = Promise.resolve().then(() => scan({ ...SCAN_HITS, accept, skipFolder: names => names.includes(SHIM_MARKER) || names.includes(STAND_IN_MARKER) }));
    return Promise.race([walk.then(({ hit }) => hit ?? null), wait(SCAN_DEADLINE_MS).then(() => null)]).catch(() => null)
      .then(async found => {
        scanning = null; scansSettled++; scanAnswer = found;
        await (found ? keep(found) : save({ emptyAt: now() }));
        if (!last || last.result.file) return;
        last = found ? { ...last, result: found, leads: await files.realpath(found.path).catch(() => null) } : { ...last, result: { ...last.result, scan: 'done' } };
        latest = last.result;
        changed();
      });
  }
  async function answer(options, mode) {
    const full = mode === 'refresh' || mode === 'scan' || mode === 'throttled' && (lastFull === null || now() - lastFull >= REFRESH_MS);
    const windows = options.platform === 'win32', settledBefore = scansSettled;
    if (full) {
      if (windows) stored = await storedPath(options.env) ?? stored;
      lastFull = now();
    }
    const key = JSON.stringify([options.platform, options.home, options.arch, variable(options.env, 'PATH') || '', stored, options.prefer ?? null]);
    if (!full && last?.key === key && await stands()) return last.result;
    // A file chosen while its check runs is what peek() says, unless it already says that file: a terminal restored at
    // start-up is told it, and an answer that stands keeps its version and reason until the check settles.
    const chosen = found => { if (latest?.file !== found.file || latest?.path !== found.path) latest = found; };
    let result = await search(options, full, chosen), due = false;
    // The registry is read, by a full search, only once every other place found nothing.
    if (!result.file && windows) {
      if (full) registered = await registry(options.env) ?? registered;
      const named = registryFolders(registered);
      const viaRegistry = named.length ? await search(options, full, chosen, named) : null;
      if (viaRegistry?.file) result = viaRegistry;
    }
    if (!result.file && windows && scan) {
      ({ result, due } = await unfound(options, mode, full, chosen, result));
      // A scan that settled while this answer was made wins: its hit, or that it looked everywhere.
      if (!result.file && scansSettled !== settledBefore) { due = false; result = scanAnswer ?? { ...result, scan: 'done' }; }
    }
    // Where `path` leads now, through a junction such as nvm-windows' C:\Program Files\nodejs, is what stands means.
    const leads = result.path && await files.realpath(result.path).catch(() => null);
    last = { key, result, leads, windows };
    latest = result;
    if (due) scanning = driveScan(options);
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
    if (mode !== 'refresh' && mode !== 'scan') return running.promise;
    return trailing ||= running.promise.catch(() => {}).then(() => { trailing = null; return start(options, mode); });
  }
  return {
    // `prefer`: a file to try before the search (the dispatch helper's AGENTRIX_CODEX_EXECUTABLE).
    locate: options => shared(options, 'locate'),
    // `throttled` (window focus) searches anew at most once a minute; an explicit refresh always does, and with `scan`
    // (asked for by the user, as after an install) also scans the drives at once when nothing is found.
    refresh: (options, { throttled = false, scan: scanNow = false } = {}) => shared(options, scanNow ? 'scan' : throttled ? 'throttled' : 'refresh'),
    // The last result, for synchronous readers, or the file a first search chose while its check runs; null before.
    peek: () => latest,
  };
}

// The locator of a process no host injects one into: a codex-app-server runtime built without a resolver. (The
// dispatch helper builds its own, helperLocator in integration/dispatch.cjs.)
const processLocator = createCodexLocator();
// The Codex file to run in this environment, or null: what this process's locator found.
const codexExecutable = async (env = process.env, platform = process.platform) => (await processLocator.locate({ env, platform })).file;

module.exports = { createCodexLocator, processLocator, codexExecutable, packageBinaries, VIAS };
