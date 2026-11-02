const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { abort, taskDirectory, mirrorDirectory, readRow, cachedRow, fatal } = require('./data.cjs');

const locks = new Map();

async function locked(key, ctx, action) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const current = previous.then(() => gate);
  locks.set(key, current);
  let cancelled;
  const cancellation = new Promise((resolve, reject) => {
    cancelled = () => reject(ctx.signal.reason || new Error('OSS preparation stopped.'));
    ctx.signal?.addEventListener('abort', cancelled, { once: true });
  });
  try {
    abort(ctx);
    await Promise.race([previous, cancellation]);
    abort(ctx);
    return await action();
  } finally {
    ctx.signal?.removeEventListener('abort', cancelled);
    release();
    // Keep the predecessor in the chain when a queued waiter aborts, without delaying that waiter's cancellation.
    void current.then(() => { if (locks.get(key) === current) locks.delete(key); });
  }
}

// L1's cache eviction must treat an entry with .in-use children as leased. The cache is never an allowed sandbox root.
async function lease(directory, action) {
  const marker = path.join(directory, '.in-use', randomUUID());
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, '', { flag: 'wx', mode: 0o600 });
  try { return await action(); }
  finally {
    await fs.rm(marker, { force: true });
    await fs.rmdir(path.dirname(marker)).catch(error => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    });
  }
}

async function fetchTask(entry, ctx) {
  const directory = taskDirectory(ctx, entry);
  return locked(directory, ctx, () => lease(directory, async () => {
    const row = await cachedRow(ctx, entry, true);
    if (!row) {
      const temporary = path.join(directory, randomUUID() + '.download');
      try {
        await ctx.tools.download(entry.row.url, temporary, {
          signal: ctx.signal, hosts: ['datasets-server.huggingface.co'],
          sha256: entry.row.sha256, maxBytes: entry.row.bytes,
        });
        readRow(await fs.readFile(temporary), entry);
        await fs.rename(temporary, path.join(directory, 'row.json'));
      } finally { await fs.rm(temporary, { force: true }); }
    }
    const material = row || await cachedRow(ctx, entry);
    for (const [name, content, expected] of [
      ['tests.patch', material.test_patch, entry.sha256.test_patch], ['fix.patch', material.patch, entry.sha256.patch],
    ]) {
      const destination = path.join(directory, name);
      const existing = await ctx.tools.hashFile(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing === expected) continue;
      const temporary = path.join(directory, randomUUID() + '.patch');
      try {
        await fs.writeFile(temporary, content, { mode: 0o600 }); await fs.rename(temporary, destination);
      } finally { await fs.rm(temporary, { force: true }); }
    }
    const mirror = mirrorDirectory(ctx, entry);
    await fs.mkdir(path.dirname(mirror), { recursive: true });
    await ctx.tools.fetchCommit(entry.url, entry.base, mirror, { signal: ctx.signal, hosts: ['github.com'] });
    const actual = (await ctx.tools.git(mirror, ['rev-parse', '--verify', entry.base + '^{commit}'], { signal: ctx.signal })).trim();
    if (actual !== entry.base) throw fatal('OSS base commit identity mismatch.');
  }));
}

async function guard(entries, ctx) {
  const files = entries.flatMap(entry => [
    [path.join(taskDirectory(ctx, entry), 'row.json'), entry.row.sha256],
    [path.join(taskDirectory(ctx, entry), 'tests.patch'), entry.sha256.test_patch],
    [path.join(taskDirectory(ctx, entry), 'fix.patch'), entry.sha256.patch],
  ]);
  const check = async () => {
    abort(ctx);
    for (const [file, expected] of files) {
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || await ctx.tools.hashFile(file) !== expected) {
          throw fatal('OSS cached grading material changed.');
        }
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        throw fatal('OSS cached grading material changed.');
      }
    }
    for (const entry of entries) {
      try {
        const commit = (await ctx.tools.git(mirrorDirectory(ctx, entry), ['rev-parse', '--verify', entry.base + '^{commit}'], {
          signal: ctx.signal,
        })).trim();
        if (commit !== entry.base) throw fatal('OSS cached base commit changed.');
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        throw fatal('OSS cached base commit changed.');
      }
    }
  };
  await check();
  return { protectedPaths: [ctx.cacheDirectory], check };
}

module.exports = { fetchTask, guard, locked, lease };
