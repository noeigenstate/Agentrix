import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const runPattern = /^(.+)-(\d+)$/;

function validateKeep(keep) {
  if (!Number.isInteger(keep) || keep < 1) throw new RangeError('keep must be a positive integer');
}

async function outputDirectory(root, create = false) {
  const directory = path.resolve(root, '.test-output');
  if (create) await fs.mkdir(directory, { recursive: true });
  try {
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('.test-output must be a real directory');
    return directory;
  } catch (error) {
    if (error.code === 'ENOENT' && !create) return null;
    throw error;
  }
}

async function folders(directory) {
  return (await fs.readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => {
      const match = runPattern.exec(entry.name);
      return { name: entry.name, family: match?.[1], timestamp: match ? BigInt(match[2]) : null };
    });
}

function newestFirst(a, b) {
  return a.timestamp > b.timestamp ? -1 : a.timestamp < b.timestamp ? 1 : a.name.localeCompare(b.name);
}

// Measure file contents without reading them or following links to other profiles.
async function sizeOf(target) {
  try {
    const entry = await fs.lstat(target);
    if (entry.isSymbolicLink()) return 0;
    if (!entry.isDirectory()) return entry.size;
    let bytes = 0;
    for (const child of await fs.readdir(target)) bytes += await sizeOf(path.join(target, child));
    return bytes;
  } catch { return 0; }
}

async function removeFolders(directory, entries) {
  const result = { removed: [], bytesFreed: 0 };
  for (const entry of entries) {
    const target = path.resolve(directory, entry.name);
    // Check the final absolute target before every recursive deletion.
    if (path.dirname(target) !== directory) throw new Error('Cleanup target must be inside .test-output');
    try {
      const current = await fs.lstat(target);
      if (!current.isDirectory() || current.isSymbolicLink()) continue;
      const bytes = await sizeOf(target);
      await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
      result.removed.push({ path: target, bytes });
      result.bytesFreed += bytes;
    } catch { /* A running Electron may hold the profile open; retry on the next run. */ }
  }
  return result;
}

// Async; root is a repository root, overridable for tests. Locked old runs may remain.
export async function testRun(name, { keep = 3, root = process.env.AGENTRIX_TEST_OUTPUT_ROOT || repoRoot } = {}) {
  validateKeep(keep);
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\0:]/.test(name)) {
    throw new TypeError('name must be a single folder name');
  }
  const directory = await outputDirectory(root, true);
  const older = (await folders(directory)).filter(entry => entry.family === name).sort(newestFirst);
  let timestamp = BigInt(Date.now()), output;
  // Stay newer than retained runs if calls share a millisecond or the clock moves back.
  if (older[0]?.timestamp >= timestamp) timestamp = older[0].timestamp + 1n;
  // An exclusive mkdir also keeps two calls in the same millisecond distinct.
  for (;;) {
    output = path.join(directory, `${name}-${timestamp}`);
    try { await fs.mkdir(output); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; timestamp += 1n; }
  }
  await removeFolders(directory, older.slice(keep - 1));
  return output;
}

// Default: retain three runs per family. An age cutoff removes matching runs older
// than that many days instead. all removes every real folder, including non-run names.
export async function pruneTestOutput({ root = repoRoot, keep = 3, olderThanDays, all = false } = {}) {
  validateKeep(keep);
  if (olderThanDays !== undefined && (!Number.isFinite(olderThanDays) || olderThanDays < 0)) {
    throw new RangeError('olderThanDays must be a non-negative number');
  }
  const directory = await outputDirectory(root);
  if (!directory) return { removed: [], bytesFreed: 0 };
  const entries = await folders(directory);
  if (all) return removeFolders(directory, entries);
  const runs = entries.filter(entry => entry.family !== undefined);
  if (olderThanDays !== undefined) {
    const cutoff = BigInt(Math.trunc(Date.now() - olderThanDays * 86400000));
    return removeFolders(directory, runs.filter(entry => entry.timestamp < cutoff));
  }
  const families = new Map();
  for (const entry of runs) {
    if (!families.has(entry.family)) families.set(entry.family, []);
    families.get(entry.family).push(entry);
  }
  const stale = [...families.values()].flatMap(family => family.sort(newestFirst).slice(keep));
  return removeFolders(directory, stale);
}
