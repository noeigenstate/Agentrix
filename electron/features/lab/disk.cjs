// Lab data and dependency trees are physical files, including *.asar. Never use Electron's archive-aware fs here.
const disk = process.versions.electron ? require('original-fs') : require('node:fs');
const fs = disk.promises;
const path = require('node:path');
const REMOVE_OPTIONS = Object.freeze({ recursive: true, force: true, maxRetries: 8, retryDelay: 75 });

async function removePath(file) {
  try { await fs.rm(file, REMOVE_OPTIONS); }
  catch (error) { error.infrastructure = true; throw error; }
}

const contains = (root, file) => {
  const relative = path.relative(root, file);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

// Entries at source/category/key are indivisible (a Git mirror or a dependency hash). Never follow a cache link.
async function pruneCache(directory, { limitBytes = 5 * 1024 ** 3, inUse = [] } = {}) {
  const root = path.resolve(directory), entries = [];
  const measure = async file => {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return { bytes: stat.size, time: stat.mtimeMs };
    if (!stat.isDirectory()) return { bytes: stat.size, time: stat.mtimeMs };
    const children = await Promise.all((await fs.readdir(file)).map(name => measure(path.join(file, name))));
    return { bytes: children.reduce((n, item) => n + item.bytes, 0),
      time: Math.max(stat.mtimeMs, ...children.map(item => item.time)) };
  };
  const collect = async (folder, depth) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory() && depth < 2) await collect(file, depth + 1);
      else entries.push({ file, ...await measure(file) });
    }
  };
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('实验缓存目录无效。');
    await collect(root, 0);
  } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  let bytes = entries.reduce((n, item) => n + item.bytes, 0);
  for (const entry of entries.sort((a, b) => a.time - b.time)) {
    if (bytes <= limitBytes) break;
    if (inUse.some(file => contains(path.resolve(file), entry.file) || contains(entry.file, path.resolve(file)))) continue;
    if (!contains(root, entry.file) || entry.file === root) throw new Error('实验缓存路径无效。');
    await removePath(entry.file); bytes -= entry.bytes;
  }
  if (bytes > limitBytes) throw Object.assign(new Error('实验缓存已达到 5 GB 上限。'), { infrastructure: true });
  return bytes;
}

module.exports = { fs, removePath, pruneCache, cloneMode: disk.constants.COPYFILE_FICLONE };
