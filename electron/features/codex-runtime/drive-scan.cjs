const fs = require('node:fs/promises');
const path = require('node:path').win32;
const { execFile } = require('node:child_process');
const { variable } = require('../claude-runtime/path-env.cjs');

// The last-resort search of this machine's local drives that the Codex locator runs when its fast search found
// nothing (codex-runtime/BOUNDARY.md). It knows no install layout: the locator says which file names and which paths
// below a folder count as a hit. Windows only.
const LIMITS = Object.freeze({ depth: 4, extraDepth: 3, folders: 20000, ms: 20000, hits: 5 });
// Never descended into: the system, the recycle bin, volume metadata, Git's store, and node_modules (a package is
// probed by its path instead, so a project's thousands of folders cost one stat).
const SKIPPED = new Set(['windows', '$recycle.bin', 'system volume information', '.git', 'node_modules']);
// A drive's top folders that get at least `extraDepth` levels below them: Program Files* and tools-like ones. A user's
// AppData\Local\Programs, five levels down, is a start of its own with `extraDepth`.
const EXTRA = /^program files|^(?:tools?|bin|apps?|programs|dev|opt|portable|software)$/i;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

// The folders holding a hit, breadth first: a file named one of `names` in the folder, or a file at one of `probes`
// (path segments) below it. A folder `skipFolder(names)` refuses is neither a hit nor walked, and a link or junction is
// never walked (it may loop, or lead off the drive). The walk yields between folders and stops at its limits.
async function scanDrives({ drives, names, probes = [], skipFolder = () => false, files = fs, now = Date.now, pause = nextTurn, limits = LIMITS }) {
  const wanted = new Set(names.map(name => name.toLowerCase())), started = now(), hits = [];
  const queue = drives.map(drive => [drive, limits.depth, 0]);
  // A user's programs sit five levels down (Users\<user>\AppData\Local\Programs): each is a start of its own.
  for (const drive of drives) {
    let users = [];
    try { users = (await files.readdir(path.join(drive, 'Users'), { withFileTypes: true })).filter(entry => entry.isDirectory()); } catch { }
    queue.push(...users.map(user => [path.join(drive, 'Users', user.name, 'AppData', 'Local', 'Programs'), limits.extraDepth, 5]));
  }
  const seen = new Set();
  let visited = 0, stopped = 'done';
  while (queue.length) {
    if (visited >= limits.folders) { stopped = 'folders'; break; }
    if (now() - started >= limits.ms) { stopped = 'time'; break; }
    const [folder, left, depth] = queue.shift(), key = folder.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    await pause();
    let entries;
    try { entries = await files.readdir(folder, { withFileTypes: true }); } catch { continue; }
    visited++;
    const listed = entries.map(entry => entry.name);
    if (skipFolder(listed)) continue;
    const lower = new Set(listed.map(name => name.toLowerCase()));
    let hit = entries.some(entry => entry.isFile() && wanted.has(entry.name.toLowerCase()));
    for (const probe of probes) {
      if (hit || !lower.has(probe[0].toLowerCase())) continue;
      hit = await files.stat(path.join(folder, ...probe)).then(stat => stat.isFile(), () => false);
    }
    if (hit && hits.push(folder) >= limits.hits) { stopped = 'hits'; break; }
    if (left === 0) continue;
    for (const entry of entries) {
      const name = entry.name.toLowerCase(), child = path.join(folder, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED.has(name) || depth === 1 && name === 'microsoft' && /^programdata$/i.test(path.basename(folder))) continue;
      queue.push([child, depth === 0 && EXTRA.test(entry.name) ? Math.max(left - 1, limits.extraDepth) : left - 1, depth + 1]);
    }
  }
  return { hits, visited, stopped };
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
