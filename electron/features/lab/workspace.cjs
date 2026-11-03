const { fs, removePath, cloneMode } = require('./disk.cjs');
const path = require('node:path');
const { command, git, aborted } = require('./process.cjs');
const { safePath } = require('./history.cjs');

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

async function ownerState(projectPath) {
  const [head, refs, status, common, objects, worktrees] = await Promise.all([
    git(projectPath, ['rev-parse', 'HEAD']),
    git(projectPath, ['for-each-ref', '--format=%(refname) %(objectname)']),
    git(projectPath, ['status', '--porcelain=v1', '--untracked-files=all']),
    git(projectPath, ['rev-parse', '--git-common-dir']),
    git(projectPath, ['count-objects', '-v']),
    git(projectPath, ['worktree', 'list', '--porcelain', '-z']),
  ]);
  return {
    head, refs, status, objects, worktrees,
    common: await fs.realpath(path.resolve(projectPath, common.trim())),
  };
}

async function assertOwner(projectPath, before) {
  const after = await ownerState(projectPath);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    const error = new Error('The original project changed during the lab run. The experiment has been halted.');
    error.ownerChanged = true;
    error.ownerAfter = after;
    throw error;
  }
  return after;
}

async function validateLinks(directory, root) {
  root ||= await fs.realpath(directory);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await fs.realpath(file);
      if (!inside(root, target)) throw new Error('A snapshot or dependency link escapes the isolated workspace.');
    } else if (entry.isDirectory()) await validateLinks(file, root);
  }
}

async function copyDependencies(projectPath, destination, signal, { electronDist = false } = {}) {
  const original = path.join(projectPath, 'node_modules');
  const stat = await fs.stat(original).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat?.isDirectory()) return null;
  if (await fs.stat(destination).catch(() => null)) { await validateLinks(destination); return null; }
  const source = await fs.realpath(original);
  let copied = false;
  if (process.platform === 'darwin') {
    await fs.mkdir(destination, { recursive: true });
    const entries = await fs.readdir(source, { withFileTypes: true });
    const electron = !electronDist && entries.find(entry => entry.name === 'electron' && entry.isDirectory());
    const roots = entries.filter(entry => entry !== electron).map(entry => path.join(source, entry.name));
    const batches = [[roots, destination]];
    if (electron) {
      const packageRoot = path.join(source, electron.name), target = path.join(destination, electron.name);
      await fs.mkdir(target);
      const metadata = (await fs.readdir(packageRoot)).filter(name => name !== 'dist').map(name => path.join(packageRoot, name));
      batches.push([metadata, target]);
    }
    copied = true;
    for (const [files, target] of batches) if (files.length) {
      const result = await command('/bin/cp', ['-cR', ...files, target], { signal, timeoutMs: 5 * 60000 });
      if (result.code !== 0) { copied = false; break; }
    }
  }
  if (!copied) {
    await removePath(destination);
    await fs.cp(source, destination, {
      recursive: true, dereference: false, verbatimSymlinks: true, mode: cloneMode,
      filter(file) {
        const relative = path.relative(source, file).split(path.sep).join('/');
        return electronDist || !/(?:^|\/)electron\/dist(?:\/|$)/.test(relative);
      },
    });
  }
  aborted(signal);
  await validateLinks(destination);
  return source;
}

async function archiveSnapshot(projectPath, revision, destination, { signal, dependencies = true, electronDist = false } = {}) {
  aborted(signal);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  const archive = destination + '.tar';
  try {
    const names = (await git(projectPath, ['ls-tree', '-rz', '--name-only', revision], { signal })).split('\0').filter(Boolean);
    if (names.some(file => !safePath(file))) throw new Error('The project archive contains an unsafe path.');
    await git(projectPath, ['archive', '--format=tar', '--output', archive, revision], { signal });
    const extracted = await command('tar', ['-xf', archive, '-C', destination], { signal, timeoutMs: 120000 });
    if (extracted.code !== 0) throw new Error('Could not extract the project snapshot.');
    await validateLinks(destination);
    const dependencySource = dependencies
      ? await copyDependencies(projectPath, path.join(destination, 'node_modules'), signal, { electronDist }) : null;
    return { files: names, dependencySource };
  } finally { await removePath(archive); }
}

async function prepareWorktree(projectPath, directory, task, signal, { electronDist = false } = {}) {
  let cwd = path.join(directory, 'worktree');
  const snapshot = await archiveSnapshot(projectPath, task.base, cwd, { signal, electronDist });
  cwd = await fs.realpath(cwd);
  await git(cwd, ['init', '--initial-branch=lab-base'], { signal });
  for (let offset = 0; offset < snapshot.files.length; offset += 100) {
    await git(cwd, ['add', '-f', '--', ...snapshot.files.slice(offset, offset + 100)], { signal });
  }
  await fs.writeFile(path.join(cwd, '.git/info/exclude'), 'node_modules\n');
  const tree = (await git(cwd, ['write-tree'], { signal })).trim();
  const baseline = (await git(cwd, [
    '-c', 'user.name=Virtual Lab', '-c', 'user.email=lab@localhost',
    'commit-tree', tree, '-m', 'Isolated starting snapshot',
  ], { signal })).trim();
  await git(cwd, ['update-ref', 'refs/heads/lab-base', baseline], { signal });
  const hooks = path.join(cwd, '.git/lab-hooks');
  await fs.mkdir(hooks);
  for (const name of ['pre-commit', 'pre-push']) {
    await fs.writeFile(path.join(hooks, name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  }
  await git(cwd, ['config', 'core.hooksPath', hooks], { signal });
  return { ...snapshot, cwd, baseline, real: await fs.realpath(cwd), gitDirectory: path.join(cwd, '.git') };
}

async function verifyWorktree(workspace, signal) {
  const directory = path.join(workspace.cwd, '.git');
  if (!(await fs.lstat(workspace.cwd)).isDirectory() || await fs.realpath(workspace.cwd) !== workspace.real ||
    !(await fs.lstat(directory)).isDirectory() ||
    await fs.stat(path.join(directory, 'objects/info/alternates')).catch(() => null) ||
    !inside(directory, await fs.realpath(path.join(directory, 'objects'))) ||
    (await git(workspace.cwd, ['rev-parse', 'HEAD'], { signal })).trim() !== workspace.baseline) {
    throw new Error('实验模型改变了运行仓库，请查看日志。');
  }
}

function projectFile(file, tracked, referenceFiles) {
  if (file === 'node_modules' || file.startsWith('node_modules/')) return false;
  if (tracked.has(file) || referenceFiles.includes(file)) return true;
  if (/(?:^|\/)(?:plan|minutes|ledger|summary|review|issues|findings|notes)(?:[.-].*)?\.(?:md|json|jsonl|log)$/i.test(file)) {
    return false;
  }
  if (!file.includes('/')) return /\.(?:[cm]?[jt]sx?|py|rs|go|c|cpp|h|java|swift)$/.test(file);
  return [...tracked].some(name => name.startsWith(file.split('/')[0] + '/'));
}

async function captureDiff(workspace, referenceFiles = [], signal) {
  const { cwd, baseline } = workspace;
  const tracked = new Set(workspace.files);
  const changes = (await git(cwd, ['diff', '--name-only', '-z', baseline], { signal })).split('\0').filter(Boolean);
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], { signal })).split('\0').filter(Boolean);
  if (untracked.length > 200) throw new Error('实验新增文件超过数量限制。');
  const selected = [...new Set([...changes, ...untracked])].filter(file => projectFile(file, tracked, referenceFiles));
  if (selected.some(file => !safePath(file))) throw new Error('实验新增文件路径无效。');
  const trackedChanges = selected.filter(file => tracked.has(file));
  let diff = trackedChanges.length ? await git(cwd, [
    'diff', '--binary', '--no-ext-diff', '--no-textconv', baseline, '--', ...trackedChanges,
  ], { signal }) : '';
  for (const file of selected.filter(file => !tracked.has(file))) {
    const result = await command('git', [
      'diff', '--no-index', '--binary', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file,
    ], { cwd, signal });
    if (result.code !== 0 && result.code !== 1) throw new Error('无法保存实验改动。');
    diff += result.stdout;
    if (Buffer.byteLength(diff) > 8 * 1024 * 1024) throw new Error('实验改动超过大小限制。');
  }
  return diff;
}

async function cleanupWorktrees(directory) {
  // Archives have private Git metadata; removing a run never invokes an owner's Git repository.
  for (const name of ['worktree', 'workers', 'workspaces', 'repository.git', 'runtime']) {
    await removePath(path.join(directory, name));
  }
}

module.exports = {
  inside, ownerState, assertOwner, archiveSnapshot, copyDependencies,
  prepareWorktree, verifyWorktree, captureDiff, cleanupWorktrees,
};
