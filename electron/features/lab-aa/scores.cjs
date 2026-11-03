const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fs, directory } = require('./cache.cjs');
const MODEL_SLUGS = { opus: 'claude-opus-5-5', sol: 'gpt-6-1-sol', sonnet: 'claude-sonnet-5-5' };
const snapshotFile = ctx => path.join(ctx.cacheDirectory, 'aa-scores.json');

function snapshot(value) {
  const asOf = typeof value?.asOf === 'number' ? new Date(value.asOf).toISOString() : value?.asOf;
  if (typeof asOf !== 'string' || !Number.isFinite(Date.parse(asOf))) throw new Error();
  const values = {};
  for (const [arm, slug] of Object.entries(MODEL_SLUGS)) {
    const score = value.values?.[slug];
    if (Number.isFinite(score) && score >= 0 && score <= 1) values[slug] = score;
  }
  return { asOf, values };
}

async function refreshScores(ctx) {
  try {
    const key = ctx.credential();
    if (!key) return;
    const result = snapshot(await ctx.tools.aaScores({ key, benchmark: 'terminal-bench-4', signal: ctx.signal }));
    await directory(ctx.cacheDirectory);
    const target = snapshotFile(ctx), stat = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)) return;
    const temporary = target + '.' + randomUUID() + '.tmp';
    try { await fs.writeFile(temporary, JSON.stringify(result), { mode: 0o600 }); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }); }
  } catch {
    // References are optional. A dated previous snapshot may remain, but API errors and credentials never leave main.
  }
}

async function published(ctx) {
  try {
    if (!ctx.credential()) return null;
    await directory(ctx.cacheDirectory);
    const file = snapshotFile(ctx), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 16384) return null;
    const value = snapshot(JSON.parse(await fs.readFile(file, 'utf8'))), values = {};
    for (const [arm, slug] of Object.entries(MODEL_SLUGS)) if (value.values[slug] !== undefined) values[arm] = value.values[slug];
    if (!Object.keys(values).length) return null;
    return {
      label: ctx.t('Artificial Analysis 参考分数'), url: 'https://artificialanalysis.ai/', asOf: value.asOf,
      harness: 'AA / Terminal-Bench 4.0', comparable: false,
      note: ctx.t('本轮仅运行单容器、无 GPU 子集，执行框架不同，参考分数不可直接比较。'), values,
    };
  } catch { return null; }
}

module.exports = { refreshScores, published };
