const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { git } = require('../electron/features/lab/process.cjs');
const {
  archiveSnapshot, prepareWorktree, ownerState, assertOwner, verifyWorktree, captureDiff,
} = require('../electron/features/lab/workspace.cjs');
const tools = require('../electron/features/lab/sources/tools.cjs');

async function temporary(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lab-workspace-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 }));
  return root;
}

async function repository(root) {
  const project = path.join(root, 'source project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'src/value.py'), 'value = 1\n');
  await fs.writeFile(path.join(project, 'payload.bin'), Buffer.from([0, 255, 128, 13, 10]));
  await fs.writeFile(path.join(project, 'script.sh'), '#!/bin/sh\nprintf fixture\n');
  await git(project, ['init', '--initial-branch=main']);
  await git(project, ['-c', 'core.autocrlf=false', 'add', '.']);
  await git(project, ['update-index', '--chmod=+x', 'script.sh']);
  await git(project, ['-c', 'user.name=Lab fixture', '-c', 'user.email=lab@example.invalid',
    'commit', '-m', 'Synthetic workspace']);
  return { project, revision: (await git(project, ['rev-parse', 'HEAD'])).trim() };
}

test('real Git archives prepare history and bare OSS snapshots on Windows and POSIX', async t => {
  const root = await temporary(t), { project, revision } = await repository(root);
  const mirror = path.join(root, 'oss mirror.git');
  await git(root, ['clone', '--bare', '--no-hardlinks', '--', project, mirror]);
  const before = await ownerState(project), mirrorBefore = await git(mirror, ['show-ref']);
  for (const source of ['history', 'oss']) {
    const directory = path.join(root, source + ' 空格 run');
    const workspace = source === 'history'
      ? await prepareWorktree(project, directory, { base: revision })
      : await tools.snapshot(mirror, directory, revision);
    assert.equal(workspace.cwd, await fs.realpath(path.join(directory, 'worktree')));
    assert.deepEqual(workspace.files.slice().sort(), ['payload.bin', 'script.sh', 'src/value.py']);
    assert.equal(await fs.readFile(path.join(workspace.cwd, 'src/value.py'), 'utf8'), 'value = 1\n');
    assert.deepEqual(await fs.readFile(path.join(workspace.cwd, 'payload.bin')), Buffer.from([0, 255, 128, 13, 10]));
    if (process.platform !== 'win32') assert.ok((await fs.stat(path.join(workspace.cwd, 'script.sh'))).mode & 0o111);
    assert.equal(await fs.stat(workspace.cwd + '.tar').catch(() => null), null);
    assert.equal(await fs.stat(path.join(workspace.gitDirectory, 'objects/info/alternates')).catch(() => null), null);
    assert.equal((await git(workspace.cwd, ['rev-list', '--all', '--count'])).trim(), '1');
    await verifyWorktree(workspace);
    assert.equal(await captureDiff(workspace), '');
    await fs.writeFile(path.join(workspace.cwd, 'src/value.py'), 'value = 2\n');
    assert.match(await captureDiff(workspace), /\+value = 2/);
  }
  await assertOwner(project, before); assert.equal(await git(mirror, ['show-ref']), mirrorBefore);
});

test('archive destinations resolve against the caller even with a relative path and trailing separator', async t => {
  const root = await temporary(t), { project, revision } = await repository(root);
  const previous = process.cwd();
  try {
    process.chdir(root);
    const snapshot = await archiveSnapshot(project, revision, 'relative snapshot' + path.sep, { dependencies: false });
    assert.ok(snapshot.files.includes('src/value.py'));
    assert.equal(await fs.readFile(path.join(root, 'relative snapshot/src/value.py'), 'utf8'), 'value = 1\n');
    assert.equal(await fs.stat(path.join(root, 'relative snapshot.tar')).catch(() => null), null);
  } finally { process.chdir(previous); }
});

const directoryLink = (target, link) => fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

async function excludedFolders(root, cwd) {
  const toolchain = path.join(root, 'toolchain');
  await fs.mkdir(toolchain); await fs.writeFile(path.join(toolchain, 'python'), 'synthetic runtime');
  for (const name of ['.oss-venv', 'generated/cache']) {
    const directory = path.join(cwd, name);
    await fs.mkdir(directory, { recursive: true });
    await directoryLink(toolchain, path.join(directory, 'runtime'));
  }
}

test('files skips excluded venv and nested cache directories before walking or validating their contents', async t => {
  const root = await temporary(t), cwd = path.join(root, 'workspace');
  await fs.mkdir(path.join(cwd, 'src'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'src/value.py'), 'value = 1\n');
  await fs.writeFile(path.join(cwd, '.oss-venv-not-excluded.py'), 'value = 2\n');
  await excludedFolders(root, cwd);
  const readdir = fs.readdir;
  t.mock.method(fs, 'readdir', async (directory, ...args) => {
    assert.ok(!['.oss-venv', 'generated/cache'].includes(path.relative(cwd, directory).split(path.sep).join('/')),
      'excluded directories must never be read');
    return readdir(directory, ...args);
  });
  const workspace = await tools.files(cwd, { exclude: ['.oss-venv', 'generated/cache'] });
  assert.deepEqual(workspace.files.sort(), ['.oss-venv-not-excluded.py', 'src/value.py']);
  assert.equal((await git(cwd, ['ls-files', '-z'])).split('\0').filter(Boolean).length, 2);
  assert.equal(await git(cwd, ['status', '--porcelain']), '');
  await fs.writeFile(path.join(cwd, '.oss-venv/generated.py'), 'ignored = True\n');
  assert.equal(await captureDiff(workspace), '');
});

test('snapshot forwards exclusions to link validation, tracked files and the private baseline', async t => {
  const root = await temporary(t), { project, revision } = await repository(root);
  const directory = path.join(root, 'run'), cwd = path.join(directory, 'worktree');
  await fs.mkdir(cwd, { recursive: true }); await excludedFolders(root, cwd);
  const workspace = await tools.snapshot(project, directory, revision, { exclude: ['.oss-venv', 'generated/cache', 'payload.bin'] });
  assert.deepEqual(workspace.files.sort(), ['script.sh', 'src/value.py']);
  assert.equal((await git(cwd, ['ls-files', '-z'])).split('\0').filter(Boolean).length, 2);
  assert.equal(await git(cwd, ['status', '--porcelain']), '');
  assert.equal(await captureDiff(workspace), '');
  await verifyWorktree(workspace);
});

test('exclusions keep rejecting non-excluded escaping links and excluded root links', async t => {
  const root = await temporary(t), cwd = path.join(root, 'workspace'), outside = path.join(root, 'outside');
  await fs.mkdir(cwd); await fs.mkdir(outside);
  await directoryLink(outside, path.join(cwd, 'escape'));
  await assert.rejects(tools.files(cwd, { exclude: ['.oss-venv'] }), /link escapes/);
  await fs.unlink(path.join(cwd, 'escape'));
  await directoryLink(outside, path.join(cwd, '.oss-venv'));
  await assert.rejects(tools.files(cwd, { exclude: ['.oss-venv'] }), /link escapes/);
  assert.equal(await fs.stat(path.join(cwd, '.git')).catch(() => null), null);
});

test('snapshot still rejects escaping links and removes its archive after validation fails', async t => {
  const root = await temporary(t), { project, revision } = await repository(root);
  const directory = path.join(root, 'run'), cwd = path.join(directory, 'worktree');
  await fs.mkdir(cwd, { recursive: true });
  await directoryLink(project, path.join(cwd, 'escape'));
  await assert.rejects(tools.snapshot(project, directory, revision, { exclude: ['.oss-venv'] }), /link escapes/);
  assert.equal(await fs.stat(cwd + '.tar').catch(() => null), null);
  assert.equal(await fs.stat(path.join(cwd, '.git')).catch(() => null), null);
});

test('files preserves internal links without traversing a linked directory twice', async t => {
  const root = await temporary(t), cwd = path.join(root, 'workspace');
  await fs.mkdir(path.join(cwd, 'src'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'src/value.py'), 'value = 1\n');
  await directoryLink(path.join(cwd, 'src'), path.join(cwd, 'linked-src'));
  const workspace = await tools.files(cwd);
  assert.deepEqual(workspace.files.sort(), ['linked-src', 'src/value.py']);
  assert.equal(await fs.realpath(path.join(cwd, 'linked-src')), await fs.realpath(path.join(cwd, 'src')));
});
