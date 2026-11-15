const fs = require('node:fs/promises');
const path = require('node:path').win32;
const { execFile } = require('node:child_process');
const { variable } = require('../claude-runtime/path-env.cjs');

// The last-resort search of this machine's local drives that the Codex locator runs when its fast search found
// nothing (codex-runtime/BOUNDARY.md). It knows no install layout: the locator says which file names and which paths
// below a folder count as a candidate, and `accept` decides whether one is Codex. Windows only.
const LIMITS = Object.freeze({ depth: 4, extraDepth: 5, programsDepth: 3, folders: 20000, entries: 5000, ms: 20000, tries: 20 });
// Never descended into: the system, the recycle bin, volume metadata, Git's store, node_modules (a package is probed by
// its path instead, so a project's thousands of folders cost one stat), downloads, and test output and fixtures, where
// stand-ins and copies of other programs sit.
const SKIPPED = new Set(['windows', '$recycle.bin', 'system volume information', '.git', 'node_modules', 'downloads', '.test-output', 'tests', 'fixtures']);
// A drive's top folders that get `extraDepth` levels below them: Program Files* and tools-like ones.
const EXTRA = /^program files|^(?:tools?|bin|apps?|programs|dev|opt|portable|software)$/i;
const TIMEOUT = Symbol('timeout');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const timer = ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });

// Breadth first, the folders holding a candidate: a file named one of `names` in the folder, or a file at one of
// `probes` (path segments) below it, which in a project (a folder with a package.json) is that project's own
// dependency and no candidate. Each candidate goes to `accept`; the first value it gives ends the walk. A folder
// `skipFolder(names)` refuses, one of `skipPaths` (the temporary folder), a user's AppData\Local\Temp, and a link or
// junction are never walked. The walk yields before each folder and stops at its limits: folders listed, entries read
// from one folder, candidates tried, and `ms` on `wait`, against which every listing, stat and `accept` is raced, so
// a drive that never answers ends it too.
async function scanDrives({ drives, names, probes = [], accept, skipFolder = () => false, skipPaths = [], files = fs, now = Date.now, pause = nextTurn, wait = timer, limits = LIMITS }) {
  const wanted = new Set(names.map(name => name.toLowerCase())), skipped = new Set(skipPaths.filter(Boolean).map(folder => path.resolve(folder).toUpperCase()));
  const started = now(), deadline = wait(limits.ms).then(() => TIMEOUT), within = promise => Promise.race([promise, deadline]);
  // A folder's entries, at most `limits.entries` of them, or null when it cannot be read, or TIMEOUT.
  async function listing(folder) {
    let dir;
    try { dir = await within(files.opendir(folder)); } catch { return null; }
    if (dir === TIMEOUT) return TIMEOUT;
    const entries = [];
    try {
      while (entries.length < limits.entries) {
        const entry = await within(dir.read());
        if (entry === TIMEOUT) return TIMEOUT;
        if (!entry) break;
        entries.push(entry);
      }
    } catch { } finally { dir.close().catch(() => {}); }
    return entries;
  }
  const queue = drives.map(drive => [drive, limits.depth, 0]);
  // A user's programs sit five levels down (Users\<user>\AppData\Local\Programs): each is a start of its own.
  for (const drive of drives) {
    const users = await listing(path.join(drive, 'Users'));
    if (users === TIMEOUT) return { hit: null, visited: 0, tried: 0, stopped: 'time' };
    queue.push(...(users ?? []).filter(user => user.isDirectory() && !user.isSymbolicLink())
      .map(user => [path.join(drive, 'Users', user.name, 'AppData', 'Local', 'Programs'), limits.programsDepth, 5]));
  }
  const seen = new Set();
  let visited = 0, tried = 0;
  const end = (stopped, hit = null) => ({ hit, visited, tried, stopped });
  while (queue.length) {
    if (visited >= limits.folders) return end('folders');
    if (now() - started >= limits.ms) return end('time');
    const [folder, left, depth] = queue.shift(), key = folder.toUpperCase();
    if (seen.has(key) || skipped.has(key)) continue;
    seen.add(key);
    await pause();
    const entries = await listing(folder);
    if (entries === TIMEOUT) return end('time');
    if (!entries) continue;
    visited++;
    const listed = entries.map(entry => entry.name);
    if (skipFolder(listed)) continue;
    const lower = new Set(listed.map(name => name.toLowerCase()));
    let candidate = entries.some(entry => entry.isFile() && wanted.has(entry.name.toLowerCase()));
    for (const probe of lower.has('package.json') ? [] : probes) {
      if (candidate || !lower.has(probe[0].toLowerCase())) continue;
      const stat = await within(files.stat(path.join(folder, ...probe))).catch(() => null);
      if (stat === TIMEOUT) return end('time');
      candidate = !!stat?.isFile();
    }
    if (candidate) {
      tried++;
      const hit = await within(Promise.resolve().then(() => accept(folder))).catch(() => null);
      if (hit === TIMEOUT) return end('time');
      if (hit) return end('hit', hit);
      if (tried >= limits.tries) return end('tries');
    }
    if (left === 0) continue;
    for (const entry of entries) {
      const name = entry.name.toLowerCase(), parent = path.basename(folder).toLowerCase();
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED.has(name) || name === 'temp' && parent === 'local' || name === 'microsoft' && depth === 1 && parent === 'programdata') continue;
      queue.push([path.join(folder, entry.name), depth === 0 && EXTRA.test(entry.name) ? limits.extraDepth : left - 1, depth + 1]);
    }
  }
  return end('done');
}

// This machine's local fixed drives (no network, removable or optical drive), as roots such as C:\, read through the
// PowerShell of the environment's own SystemRoot (an environment without one reads none); a failed read gives the
// system drive alone.
function fixedDrives(env, { run = execFile, timeoutMs = 10000 } = {}) {
  const root = variable(env, 'SystemRoot');
  if (!root) return Promise.resolve([]);
  const fallback = [`${(variable(env, 'SystemDrive') || path.parse(root).root).replace(/[\\/]+$/, '')}\\`];
  const script = "(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $_.DeviceID }) -join ';'";
  return new Promise(resolve => {
    try {
      run(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: timeoutMs, env }, (error, stdout) => {
          const drives = error ? [] : String(stdout).trim().split(';').filter(drive => /^[A-Za-z]:$/.test(drive)).map(drive => `${drive.toUpperCase()}\\`);
          resolve(drives.length ? drives : fallback);
        });
    } catch { resolve(fallback); }
  });
}

module.exports = { scanDrives, fixedDrives, LIMITS };
