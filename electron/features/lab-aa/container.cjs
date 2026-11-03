const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fs, failure } = require('./cache.cjs');
const { installWrappers } = require('./wrappers.cjs');

const timeout = ctx => Math.max(1, Math.min(ctx.testTimeoutMs || 120000, 20 * 60000));
async function execute(ctx, id, argv) {
  ctx.signal?.throwIfAborted();
  const result = await ctx.tools.docker.exec(id, argv, { timeoutMs: timeout(ctx) });
  ctx.signal?.throwIfAborted();
  if (!result || !Number.isInteger(result.code)) throw failure('AA 容器命令无法执行。', { infrastructure: true });
  return result;
}
async function checked(ctx, id, argv) {
  const result = await execute(ctx, id, argv);
  if (result.code !== 0) {
    await fs.mkdir(ctx.artifactDirectory, { recursive: true, mode: 0o700 });
    await fs.appendFile(path.join(ctx.artifactDirectory, 'tests.log'),
      'Container exit ' + result.code + '\n' + result.stdout + '\n' + result.stderr + '\n', { mode: 0o600 });
    throw failure('AA 容器命令执行失败。', { infrastructure: result.code === 126 || result.code === 127 });
  }
  return result;
}

async function withContainer(ctx, environment, action) {
  ctx.signal?.throwIfAborted();
  const id = await ctx.tools.docker.create({ ...environment, network: 'none' });
  let removing;
  const remove = () => removing ||= ctx.tools.docker.remove(id);
  const abort = () => { void remove().catch(() => {}); };
  ctx.signal?.addEventListener('abort', abort, { once: true });
  try { ctx.signal?.throwIfAborted(); return await action(id); }
  finally { ctx.signal?.removeEventListener('abort', abort); await remove(); }
}

// Strip privilege bits before untrusted outputs enter the separate verifier.
async function sanitize(directory) {
  let count = 0, bytes = 0;
  async function walk(file) {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory() || stat.isFile() && stat.nlink > 1) {
      throw failure('AA 输出产物包含不安全路径。');
    }
    if (++count > 100000 || (bytes += stat.size) > 5 * 1024 ** 3) throw failure('AA 输出产物超过大小限制。');
    await fs.chmod(file, stat.isDirectory() || stat.mode & 0o111 ? 0o755 : 0o644);
    if (stat.isDirectory()) for (const name of await fs.readdir(file)) await walk(path.join(file, name));
  }
  await walk(directory);
}

// Filter in the container first: excluded dependency trees must never reach the host.
const STAGE = [
  'set -eu', 'src=$1; stage=$2; shift 2',
  'if [ -L "$src" ]; then exit 72; fi',
  'if [ -d "$src" ]; then',
  '  mkdir -p "$stage"',
  '  tar -C "$src" -cf "$stage.tar" "$@" .',
  '  tar -C "$stage" -xf "$stage.tar"',
  '  rm -f "$stage.tar"',
  'else cp -p -- "$src" "$stage"; fi',
].join('\n');

async function collect(ctx, task, id) {
  for (const command of task.collect) await checked(ctx, id, ['/bin/sh', '-c', command]);
  const transfer = path.join(ctx.artifactDirectory, 'transfer-' + randomUUID());
  await fs.mkdir(transfer, { recursive: true, mode: 0o700 });
  const staging = '/tmp/agentrix-artifacts-' + randomUUID(), outputs = [];
  await checked(ctx, id, ['mkdir', '-p', staging]);
  try {
    for (const entry of ['/logs/artifacts', ...task.artifacts]) {
      const source = (typeof entry === 'string' ? entry : entry.source).replace(/\/$/, '');
      const exists = await execute(ctx, id, ['/bin/sh', '-c', 'test -e "$1" || test -L "$1"', 'aa', source]);
      if (exists.code === 1) continue;
      if (exists.code !== 0) throw failure('AA 输出产物无法读取。');
      const staged = staging + '/' + outputs.length;
      const host = path.join(transfer, String(outputs.length), path.posix.basename(source));
      await fs.mkdir(path.dirname(host), { recursive: true, mode: 0o700 });
      const excludes = typeof entry === 'string' ? [] : entry.exclude || [];
      await checked(ctx, id, ['/bin/sh', '-c', STAGE, 'aa', source, staged, ...excludes.map(value => '--exclude=' + value)]);
      await ctx.tools.docker.copyFrom(id, staged, host);
      await sanitize(host);
      outputs.push({ source, host, directory: (await fs.lstat(host)).isDirectory() });
    }
    return outputs;
  } finally { if (!ctx.signal?.aborted) await checked(ctx, id, ['rm', '-rf', staging]); }
}

function reward(data, json) {
  let value;
  if (json) value = JSON.parse(data)?.reward;
  else {
    if (!/^[01](?:\.0+)?$/.test(data.trim())) throw new Error();
    value = Number(data.trim());
  }
  if (value !== 0 && value !== 1) throw new Error();
  return value;
}

function createRuntime(cache) {
  const running = new WeakMap();
  async function gradeContainer(task, ctx, id) {
    const outputs = await collect(ctx, task, id);
    ctx = { ...ctx, testTimeoutMs: Math.min(timeout(ctx), task.verifierTimeoutSec * 1000) };
    return withContainer(ctx, task.verifier, async verifier => {
      await checked(ctx, verifier, ['mkdir', '-p', '/logs/verifier', '/tests']);
      await checked(ctx, verifier, ['rm', '-f', '/logs/verifier/reward.json', '/logs/verifier/reward.txt']);
      for (const output of outputs) {
        await checked(ctx, verifier, ['mkdir', '-p', path.posix.dirname(output.source)]);
        // Copy a directory to its parent to overlay its contents without adding a nested directory or deleting verifier files.
        await ctx.tools.docker.copyTo(verifier, output.host, output.directory ? path.posix.dirname(output.source) : output.source);
      }
      const script = task.files.find(file => file.path === 'tests/test.sh');
      await cache.read(ctx, task, script);
      await ctx.tools.docker.copyTo(verifier, cache.location(ctx, task, script), '/tests/test.sh');
      const result = await execute(ctx, verifier, ['/bin/bash', '/tests/test.sh']);
      const evidence = path.join(ctx.artifactDirectory, 'tests.log');
      await fs.writeFile(evidence, result.stdout + '\n' + result.stderr, { mode: 0o600 });
      if (result.code === 126 || result.code === 127) throw failure('AA 验证器未正常完成。', { infrastructure: true });
      let score;
      for (const format of ['json', 'txt']) {
        const source = '/logs/verifier/reward.' + format;
        const exists = await execute(ctx, verifier, ['test', '-f', source]);
        if (exists.code === 1) continue;
        if (exists.code !== 0) throw failure('AA 评分证据缺失或无效。');
        const file = path.join(ctx.artifactDirectory, 'reward-' + randomUUID() + '.' + format);
        await ctx.tools.docker.copyFrom(verifier, source, file);
        try {
          const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error();
          score = reward(await fs.readFile(file, 'utf8'), format === 'json');
        } catch { throw failure('AA 评分证据缺失或无效。'); }
        break;
      }
      if (score === undefined) throw failure('AA 评分证据缺失或无效。');
      // Some upstream verifiers exit 1 for a completed failing suite. That is a task failure when reward=0.
      if (result.code !== 0 && !(result.code === 1 && score === 0)) throw failure('AA 验证器未正常完成。');
      return { testsPassed: null, testsTotal: null, score, passed: score === 1, evidence };
    });
  }
  async function prepare(task, ctx) {
    if (running.has(ctx)) throw failure('AA 运行已经准备完成。');
    await cache.read(ctx, task, task.files.find(file => file.path === 'instruction.md'));
    const cwd = path.join(ctx.workspaceRoot, 'task-' + randomUUID());
    await fs.mkdir(cwd, { mode: 0o700 });
    await installWrappers(cwd, ctx.session.nodePath);
    const workspace = await ctx.tools.files(cwd, { signal: ctx.signal });
    const id = await ctx.tools.docker.create({ ...task.environment, network: 'none' });
    try { ctx.signal?.throwIfAborted(); }
    catch (error) { await ctx.tools.docker.remove(id); throw error; }
    running.set(ctx, { task: task.id, id });
    return { ...workspace, container: { id } };
  }
  async function reference(task, ctx) {
    return withContainer(ctx, task.environment, async id => {
      for (const file of task.files) await cache.read(ctx, task, file);
      await checked(ctx, id, ['rm', '-rf', '/solution']);
      await ctx.tools.docker.copyTo(id, path.dirname(cache.location(ctx, task, task.files.find(file => file.path === 'solution/solve.sh'))), '/solution');
      await checked(ctx, id, ['/bin/bash', '/solution/solve.sh']);
      const grade = await gradeContainer(task, ctx, id);
      if (!grade.passed) throw failure('AA 参考解未通过任务验证。');
      return { diffFiles: [], score: grade.score, manifest: cache.hash };
    });
  }
  async function grade(task, ctx) {
    const run = running.get(ctx);
    if (!run || run.task !== task.id) throw failure('AA 运行尚未准备完成。');
    running.delete(ctx);
    return gradeContainer(task, ctx, run.id);
  }
  return { prepare, reference, grade };
}

module.exports = { createRuntime, reward };
