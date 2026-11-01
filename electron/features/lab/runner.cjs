const fs = require('node:fs/promises');
const path = require('node:path');
const { git, command, aborted } = require('./process.cjs');
const { LabUsage, phaseEvidence } = require('./usage.cjs');
const { dispatch } = require('./dispatch.cjs');
const { gradeTests, gradeReview } = require('./grading.cjs');
const { safePath } = require('./history.cjs');

const inside = (root, target) => target !== root && !path.relative(root, target).startsWith('..') && !path.isAbsolute(path.relative(root, target));

async function prepareWorktree(projectPath, directory, task, signal) {
  aborted(signal);
  const repository = path.join(directory, 'repository.git'), cwd = path.join(directory, 'worktree');
  const objects = path.resolve(projectPath, (await git(projectPath, ['rev-parse', '--git-path', 'objects'], { signal })).trim());
  // Private refs and team journals, shared read-only objects: no experimental worker writes the owner's Git metadata.
  await git(directory, ['init', '--bare', ...(task.base.length === 64 ? ['--object-format=sha256'] : []), repository], { signal });
  await fs.writeFile(path.join(repository, 'objects/info/alternates'), (await fs.realpath(objects)) + '\n');
  const hooks = path.join(repository, 'lab-hooks'); await fs.mkdir(hooks);
  for (const name of ['pre-commit', 'pre-push']) await fs.writeFile(path.join(hooks, name), '#!/bin/sh\necho "Virtual Lab: commits and pushes are disabled" >&2\nexit 1\n', { mode: 0o700 });
  await git(directory, ['--git-dir', repository, 'config', 'core.hooksPath', hooks], { signal });
  await git(directory, ['--git-dir', repository, 'update-ref', 'refs/heads/lab-base', task.base], { signal });
  await git(directory, ['--git-dir', repository, 'symbolic-ref', 'HEAD', 'refs/heads/lab-base'], { signal });
  await git(directory, ['--git-dir', repository, 'worktree', 'add', '--detach', cwd, task.base], { signal });
  const dependencies = path.join(projectPath, 'node_modules');
  if (await fs.stat(dependencies).then(stat => stat.isDirectory(), error => { if (error.code === 'ENOENT') return false; throw error; })) {
    const link = path.join(cwd, 'node_modules');
    if (!await fs.lstat(link).catch(() => null)) await fs.symlink(await fs.realpath(dependencies), link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return { repository, cwd, marker: await fs.readFile(path.join(cwd, '.git'), 'utf8'), real: await fs.realpath(cwd) };
}

async function verifyWorktree(workspace, base, signal) {
  if (!(await fs.lstat(workspace.cwd)).isDirectory() || await fs.realpath(workspace.cwd) !== workspace.real ||
    await fs.readFile(path.join(workspace.cwd, '.git'), 'utf8') !== workspace.marker ||
    (await git(workspace.cwd, ['rev-parse', 'HEAD'], { signal })).trim() !== base) throw new Error('实验模型改变了运行仓库，请查看日志。');
}

async function captureDiff(cwd, base, signal) {
  let diff = await git(cwd, ['diff', '--binary', '--no-ext-diff', '--no-textconv', base, '--'], { signal });
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], { signal })).split('\0')
    .filter(file => file && file !== 'node_modules' && !file.startsWith('node_modules/'));
  if (untracked.length > 200) throw new Error('实验新增文件超过数量限制。');
  for (const file of untracked) {
    if (!safePath(file)) throw new Error('实验新增文件路径无效。');
    const result = await command('git', ['diff', '--no-index', '--binary', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file], { cwd, signal });
    if (result.code !== 0 && result.code !== 1) throw new Error('无法保存实验改动。');
    diff += result.stdout;
    if (Buffer.byteLength(diff) > 8 * 1024 * 1024) throw new Error('实验改动超过大小限制。');
  }
  return diff;
}

async function cleanupWorktrees(directory) {
  directory = await fs.realpath(directory);
  const repository = path.join(directory, 'repository.git');
  if (!await fs.stat(repository).catch(() => null)) return;
  const listing = await git(directory, ['--git-dir', repository, 'worktree', 'list', '--porcelain']);
  for (const line of listing.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const cwd = line.slice(9);
    if (cwd === repository) continue;
    if (!inside(directory, cwd)) throw new Error('实验 worktree 超出了运行目录。');
    const dependencies = path.join(cwd, 'node_modules');
    if ((await fs.lstat(dependencies).catch(() => null))?.isSymbolicLink()) {
      if (process.platform === 'win32') await fs.rmdir(dependencies);
      else await fs.unlink(dependencies);
    }
    await git(directory, ['--git-dir', repository, 'worktree', 'remove', '--force', '--force', cwd]);
  }
  await fs.rm(repository, { recursive: true, force: true });
}

async function runTask({ project, task, run, directory, socketDirectory, helper, prices, records, signal, changed,
  nodePath = process.execPath, env = process.env, timeoutMs = 20 * 60000, testTimeoutMs = 120000, reviewTimeoutMs = 5 * 60000 }) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const artifacts = path.join(directory, 'artifacts'); await fs.mkdir(artifacts, { mode: 0o700 });
  const usage = new LabUsage({ directory: artifacts, socketDirectory, project, prices, records, changed });
  let workspace, result = {}, failure = null, captured = false;
  const control = new AbortController(), abort = () => control.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) control.abort();
  const deadline = setTimeout(() => control.abort(), timeoutMs);
  try {
    workspace = await prepareWorktree(project.path, directory, task, control.signal);
    await usage.start();
    await dispatch({ arm: run.arm, cwd: workspace.cwd, directory: artifacts, helper, nodePath, env, usage, task, signal: control.signal, timeoutMs });
    await verifyWorktree(workspace, task.base, control.signal);
    const diff = await captureDiff(workspace.cwd, task.base, control.signal);
    await fs.writeFile(path.join(artifacts, 'change.patch'), diff, { mode: 0o600 });
    captured = true;
    Object.assign(result, await gradeTests({ projectPath: project.path, cwd: workspace.cwd, task, directory: artifacts, signal: control.signal,
      nodePath, env, timeoutMs: testTimeoutMs }));
    result.reviewIssues = await gradeReview({ task, diff, directory: artifacts, helper, nodePath, env, usage, signal: control.signal, timeoutMs: reviewTimeoutMs });
  } catch (error) {
    failure = error;
    // Preserve even a partial implementation after worker failure, stop or timeout, before its worktree is removed.
    if (workspace && !captured) {
      try {
        await verifyWorktree(workspace, task.base);
        const diff = await captureDiff(workspace.cwd, task.base);
        await fs.writeFile(path.join(artifacts, 'change.patch'), diff, { mode: 0o600 });
      } catch {}
    }
  } finally {
    clearTimeout(deadline); signal.removeEventListener('abort', abort);
    // All spawned commands have drained their process trees before this point.
    try {
      await usage.close();
      const measurements = usage.measurements();
      result.costUsd = measurements.costUsd; result.outputTokens = measurements.outputTokens;
      if (run.arm === 'orchestrated') {
        const journal = await fs.readFile(path.join(directory, 'repository.git/agentrix/journal.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
        const entries = journal.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        Object.assign(result, phaseEvidence(entries, measurements.calls));
      }
      await fs.writeFile(path.join(artifacts, 'measurements.json'), JSON.stringify({ ...measurements, ...result }), { mode: 0o600 });
      if (run.arm === 'orchestrated') {
        const journal = path.join(directory, 'repository.git/agentrix/journal.jsonl');
        await fs.copyFile(journal, path.join(artifacts, 'journal.jsonl')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    } catch (error) { failure ||= error; }
    try { await cleanupWorktrees(directory); } catch (error) { failure ||= error; }
  }
  if (signal.aborted) result.state = 'stopped';
  else if (failure) { result.state = 'error'; result.error = control.signal.aborted ? '实验运行超时。' : String(failure.message || failure).slice(0, 1000); }
  else result.state = result.testsTotal > 0 && result.testsPassed === result.testsTotal ? 'passed' : 'failed';
  return result;
}

module.exports = { runTask, prepareWorktree, verifyWorktree, captureDiff, cleanupWorktrees };
