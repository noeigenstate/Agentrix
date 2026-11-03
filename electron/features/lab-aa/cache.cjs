const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const fs = (process.versions.electron ? require('original-fs') : require('node:fs')).promises;

const fingerprint = value => createHash('sha256').update(value).digest('hex');
const failure = (message, flags = {}) => Object.assign(new Error(message), flags);
const relativePath = file => typeof file === 'string' && /^[a-zA-Z0-9_.\-/]+$/.test(file) &&
  !file.startsWith('/') && file.split('/').every(part => part && part !== '.' && part !== '..');

async function directory(root, relative = '') {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  let current = root;
  for (const part of ['', ...relative.split('/').filter(Boolean)]) {
    current = path.join(current, part);
    await fs.mkdir(current, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('AA 缓存包含不安全路径。', { fatal: true });
  }
  return current;
}

async function bytes(file, expected) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size !== expected.bytes) throw new Error();
  const data = await fs.readFile(file);
  if (fingerprint(data) !== expected.sha256) throw new Error();
  return data;
}

function createCache(manifest) {
  const hash = fingerprint(JSON.stringify(manifest)), pending = new Map();
  const root = ctx => path.join(ctx.cacheDirectory, hash);
  const location = (ctx, task, file) => path.join(root(ctx), task.id, file.path);
  async function read(ctx, task, file) {
    await directory(ctx.cacheDirectory, hash + '/' + task.id + '/' + path.posix.dirname(file.path));
    try { return await bytes(location(ctx, task, file), file); }
    catch { throw failure('AA 任务数据缺失或校验失败。'); }
  }
  async function fetchFile(ctx, task, file) {
    const target = location(ctx, task, file);
    if (pending.has(target)) return pending.get(target);
    const operation = (async () => {
      await directory(ctx.cacheDirectory, hash + '/' + task.id + '/' + path.posix.dirname(file.path));
      const stat = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)) {
        throw failure('AA 缓存包含不安全路径。', { fatal: true });
      }
      if (stat && await bytes(target, file).then(() => true, () => false)) return;
      const temporary = target + '.' + randomUUID() + '.download';
      try {
        const url = 'https://raw.githubusercontent.com/harbor-framework/terminal-bench/' +
          manifest.source.revision + '/tasks/' + task.item + '/' + file.path;
        await ctx.tools.download(url, temporary, {
          signal: ctx.signal, hosts: ['raw.githubusercontent.com'], sha256: file.sha256, maxBytes: file.bytes,
        });
        await bytes(temporary, file);
        await fs.chmod(temporary, file.executable ? 0o700 : 0o600);
        await fs.rename(temporary, target);
      } catch (error) {
        if (error.fatal || ctx.signal?.aborted) throw error;
        throw failure('AA 任务下载或校验失败。', { infrastructure: true });
      } finally { await fs.rm(temporary, { force: true }); }
    })();
    pending.set(target, operation);
    try { await operation; } finally { pending.delete(target); }
  }
  async function fetch(ctx, tasks) {
    const jobs = tasks.flatMap(task => task.files.map(file => () => fetchFile(ctx, task, file)));
    for (let i = 0; i < jobs.length; i += 4) {
      ctx.signal?.throwIfAborted();
      const results = await Promise.allSettled(jobs.slice(i, i + 4).map(job => job()));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
  }
  async function guard(ctx, tasks) {
    const check = async () => {
      try {
        for (const task of tasks) for (const file of task.files) await read(ctx, task, file);
      } catch { throw failure('AA 参考数据在运行期间发生变化。', { fatal: true }); }
    };
    await check();
    return { protectedPaths: [ctx.cacheDirectory], check };
  }
  return { hash, root, location, read, fetch, guard };
}

module.exports = { fs, fingerprint, failure, relativePath, directory, createCache };
