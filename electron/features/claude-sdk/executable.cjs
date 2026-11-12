const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const REQUIRED = '2.1.317', MINIMUM = REQUIRED.split('.').map(Number), VERSION_TIMEOUT_MS = 10000, CLOSE_GRACE_MS = 1500, STORED_PATH_TIMEOUT_MS = 5000;
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
const variable = (env, name) => env[name] ?? Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];

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

// The PATH Windows keeps for new processes (machine, then user), read with the call refresh-path.ps1 makes for
// terminals, so a CLI installed after Agentrix started is found without a restart. Nothing is written. It runs the
// PowerShell of the environment's own SystemRoot (an environment without one reads nothing); base64 keeps a non-ASCII
// folder intact whatever the console code page. A read that fails or takes too long only adds no folders.
function readStoredPath(env, platform, timeoutMs = STORED_PATH_TIMEOUT_MS) {
  const root = variable(env, 'SystemRoot');
  if (platform !== 'win32' || !root) return Promise.resolve([]);
  const script = "$p=foreach($s in 'Machine','User'){try{[Environment]::ExpandEnvironmentVariables([string][Environment]::GetEnvironmentVariable('Path',$s))}catch{}};"
    + "[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($p -join ';'))))";
  return new Promise(resolve => {
    try {
      execFile(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: timeoutMs, env }, (error, stdout) => resolve(error ? [] : Buffer.from(String(stdout).trim(), 'base64').toString('utf8').split(';')));
    } catch { resolve([]); }
  });
}

// Where an install puts Claude Code besides PATH: the native installer, the legacy local npm install, and on Windows
// WinGet's command links (user, then machine); the system folders elsewhere.
function installFolders(env, platform, home) {
  const own = [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local')];
  if (platform !== 'win32') return [...own, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  const local = variable(env, 'LOCALAPPDATA'), programs = variable(env, 'ProgramFiles');
  return [...own, local && path.join(local, 'Microsoft', 'WinGet', 'Links'), programs && path.join(programs, 'WinGet', 'Links')].filter(Boolean);
}

// The native program of an npm package that skipped its postinstall (npm 12 by default, --ignore-scripts, pnpm): the
// platform package's own copy, beside the package or nested in it.
function platformCopies(dir, platform, arch) {
  const keys = platform === 'win32' ? (arch === 'arm64' ? ['arm64', 'x64'] : ['x64', 'arm64']).map(cpu => `win32-${cpu}`)
    : [`${platform}-${arch}`, ...(platform === 'linux' ? [`linux-${arch}-musl`] : [])];
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  return keys.flatMap(key => [path.join(path.dirname(dir), `claude-code-${key}`, name), path.join(dir, 'node_modules', '@anthropic-ai', `claude-code-${key}`, name)]);
}

// `missing` keeps its meaning for every caller: no usable native CLI. `reason` says why: `not_found`, or a file was
// found (`found`) whose version check timed out (`elapsedMs`), failed to run (`error` names how) or printed no version.
// A `not_found` also says where it looked: how many PATH folders (inherited and stored) and the install folders by
// name, home written as ~; `incomplete` names an npm package found without its native program.
async function inspectClaudeExecutable({ env = process.env, platform = process.platform, arch = process.arch, home = os.homedir(), probe = execFile,
  storedPath = readStoredPath, files = fs, timeoutMs = VERSION_TIMEOUT_MS, graceMs = CLOSE_GRACE_MS } = {}) {
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  const shown = file => { const relative = path.relative(home, file); return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? path.join('~', relative) : file; };
  const places = installFolders(env, platform, home), checked = new Set(), folders = new Set();
  let outdated = null, failure = null, incomplete = null, pathFolders = 0;
  async function check(file) {
    let real, stat;
    try {
      real = await files.realpath(file);
      if (checked.has(real) || !(stat = await files.stat(real)).isFile()) return null;
      await files.access(real, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    } catch { return null; } // A broken candidate must not hide another installed native executable.
    checked.add(real);
    if (stat.size < STUB_BYTES && NPM_BIN.test(real)) {
      const dir = path.dirname(path.dirname(real));
      incomplete ||= dir;
      for (const copy of platformCopies(dir, platform, arch)) { const result = await check(copy); if (result) return result; }
      return null;
    }
    const { stdout, ...run } = await readVersion(probe, real, env, timeoutMs, graceMs);
    const match = stdout === undefined ? null : VERSION.exec(stdout);
    if (match && meets(match)) return { status: 'ok', version: match[0], required: REQUIRED, file: real };
    if (match) outdated ||= match[0];
    else failure ||= { reason: 'unreadable', ...run, found: real };
    return null;
  }
  const read = async file => (await files.stat(file)).size <= SHIM_BYTES ? files.readFile(file, 'utf8') : '';
  // The npm package a folder holds (an npm prefix on Windows holds its shims and node_modules side by side) and the
  // ones its shims run. A package from before the native program (bin cli.js) is older than REQUIRED: its
  // package.json says which version, and nothing is run.
  async function packageFiles(folder) {
    const dirs = new Set([path.join(folder, 'node_modules', '@anthropic-ai', 'claude-code')]);
    if (platform === 'win32') for (const shim of ['claude.cmd', 'claude.ps1']) {
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
  // The stored PATH comes last: it costs a PowerShell start, so it is read only when nothing before gave a usable CLI.
  for (const [counted, list] of [[true, () => (variable(env, 'PATH') || '').split(path.delimiter)], [false, () => places], [true, () => storedPath(env, platform)]]) {
    for (const entry of await list()) {
      const folder = String(entry).trim().replace(/^"(.*)"$/, '$1');
      if (!folder || !path.isAbsolute(folder) || folders.has(path.resolve(folder))) continue;
      folders.add(path.resolve(folder));
      if (counted) pathFolders++;
      for (const file of [path.join(folder, name), ...await packageFiles(folder)]) {
        const result = await check(file);
        if (result) return result;
      }
    }
  }
  if (outdated) return { status: 'too_old', version: outdated, required: REQUIRED, file: null };
  if (failure) return { status: 'missing', version: null, required: REQUIRED, file: null, ...failure };
  return { status: 'missing', version: null, required: REQUIRED, file: null, reason: 'not_found', pathFolders, searched: places.map(shown),
    ...(incomplete ? { incomplete: shown(incomplete) } : {}) };
}
async function resolveClaudeExecutable(options) {
  const result = await inspectClaudeExecutable(options);
  if (result.status === 'too_old') throw Object.assign(new Error('Claude Code 版本过低，请升级到 2.1.317 或更高'), { code: 'native_cli_required', outdated: true });
  if (result.reason && result.reason !== 'not_found') throw Object.assign(new Error('Claude Code 检查没有通过，无法通过 API 运行'), { code: 'native_cli_required', unverified: true });
  return result.file;
}
module.exports = { resolveClaudeExecutable, inspectClaudeExecutable };
