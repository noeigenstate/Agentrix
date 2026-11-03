const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const native = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { copyDependencies, cleanupWorktrees } = require('../electron/features/lab/workspace.cjs');
const { removePath } = require('../electron/features/lab/disk.cjs');
const { pruneCache } = require('../electron/features/lab/disk.cjs');
const { recoverRuns } = require('../electron/features/lab/session.cjs');
const { randomUUID } = require('node:crypto');

async function temporary(t) {
  const base = process.platform === 'darwin' ? path.join(os.homedir(), '.ctmp') : os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'lab-disk-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 }));
  return root;
}

test('Electron workspace removal uses original-fs so a physical ASAR is not mistaken for a virtual directory', async t => {
  const root = await temporary(t), resources = path.join(root, 'Electron.app/Contents/Resources');
  await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(path.join(resources, 'default_app.asar'), Buffer.from('opaque physical archive'));
  let originalCalls = 0, patchedCalls = 0, options;
  const original = {
    constants: native.constants, promises: { ...fs, async rm(file, value) {
      originalCalls++; options = value; return fs.rm(file, value);
    } },
  };
  const patched = { constants: native.constants, promises: { ...fs, async rm() {
    patchedCalls++;
    throw Object.assign(new Error('archive-aware removal left default_app.asar behind'), { code: 'ENOTEMPTY' });
  } } };
  await assert.rejects(patched.promises.rm(root), { code: 'ENOTEMPTY' });
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../electron/features/lab/disk.cjs'), 'utf8'), {
    module, process: { versions: { electron: 'fixture' } },
    require: name => {
      if (name === 'original-fs') return original;
      if (name === 'node:fs') return patched;
      if (name === 'node:path') return path;
      throw new Error('Unexpected module ' + name);
    },
  });
  await module.exports.removePath(root);
  assert.equal(originalCalls, 1); assert.equal(patchedCalls, 1);
  assert.ok(options.maxRetries > 0); assert.ok(options.retryDelay > 0);
  assert.equal(await fs.stat(root).catch(() => null), null);
});

test('reference and run workspace cleanup share physical removal and do not follow dependency links', async t => {
  const root = await temporary(t), owner = path.join(root, 'owner');
  await fs.mkdir(owner); await fs.writeFile(path.join(owner, 'keep.txt'), 'owner data');
  for (const name of ['reference', 'run']) {
    const directory = path.join(root, name), resources = path.join(directory, 'workspaces/worktree/fixture.app/Resources');
    await fs.mkdir(resources, { recursive: true });
    await fs.writeFile(path.join(resources, 'default_app.asar'), 'physical archive');
    await fs.symlink(owner, path.join(directory, 'workspaces/worktree/node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir');
    await cleanupWorktrees(directory);
    assert.equal(await fs.stat(path.join(directory, 'workspaces')).catch(() => null), null);
  }
  assert.equal(await fs.readFile(path.join(owner, 'keep.txt'), 'utf8'), 'owner data');
});

test('dependency copies retain Node package metadata, skip Electron distribution and preserve internal bin links', async t => {
  const root = await temporary(t), project = path.join(root, 'project'), source = path.join(project, 'node_modules');
  await fs.mkdir(path.join(source, 'electron/dist/Electron.app/Contents/Resources'), { recursive: true });
  await fs.mkdir(path.join(source, '.bin'));
  await fs.mkdir(path.join(source, 'fixture-pkg'));
  await fs.writeFile(path.join(source, 'electron/dist/Electron.app/Contents/Resources/default_app.asar'), 'large unused archive');
  await fs.writeFile(path.join(source, 'electron/package.json'), '{"name":"electron"}');
  await fs.writeFile(path.join(source, 'electron/index.js'), 'module.exports = "fixture";');
  await fs.writeFile(path.join(source, 'fixture-pkg/cli.cjs'), 'module.exports = 1;');
  const binTarget = path.join('..', 'fixture-pkg', 'cli.cjs');
  try { await fs.symlink(binTarget, path.join(source, '.bin/fixture')); }
  catch (error) { if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows file-symlink privilege is unavailable'); return; }
  const destination = path.join(root, 'workspace/node_modules');
  await copyDependencies(project, destination);
  assert.equal(await fs.stat(path.join(destination, 'electron/dist')).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(destination, 'electron/package.json'), 'utf8'), '{"name":"electron"}');
  assert.equal(await fs.readFile(path.join(destination, 'electron/index.js'), 'utf8'), 'module.exports = "fixture";');
  assert.equal(await fs.readlink(path.join(source, '.bin/fixture')), binTarget);
  assert.equal(await fs.readlink(path.join(destination, '.bin/fixture')), binTarget);
  assert.equal(path.isAbsolute(binTarget), false);
  await fs.writeFile(path.join(destination, 'fixture-pkg/cli.cjs'), 'module.exports = 2;');
  assert.equal(await fs.readFile(path.join(source, 'fixture-pkg/cli.cjs'), 'utf8'), 'module.exports = 1;');
  await removePath(destination);
});

test('startup removes a stale reference ASAR tree even if its session manifest was already removed', {
  skip: !['darwin', 'linux'].includes(process.platform) ? 'POSIX process recovery is required' : false,
}, async t => {
  const root = await temporary(t), id = randomUUID();
  const reference = path.join(root, 'references', id);
  const resources = path.join(reference, 'workspaces/worktree/node_modules/electron/dist/fixture.app/Resources');
  await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(path.join(resources, 'default_app.asar'), 'physical archive');
  await recoverRuns(root);
  assert.equal(await fs.stat(reference).catch(() => null), null);
});

test('an unavailable APFS clone falls back to a private copy without Electron distribution or partial copy files', async t => {
  const root = await temporary(t), source = path.join(root, 'project/node_modules');
  await fs.mkdir(path.join(source, 'electron/dist'), { recursive: true });
  await fs.mkdir(path.join(source, 'fixture-pkg')); await fs.mkdir(path.join(source, '.bin'));
  await fs.writeFile(path.join(source, 'electron/dist/unused'), 'runtime');
  await fs.writeFile(path.join(source, 'electron/package.json'), '{"name":"electron"}');
  await fs.writeFile(path.join(source, 'fixture-pkg/cli.cjs'), 'module.exports = 1;');
  const binTarget = path.join('..', 'fixture-pkg', 'cli.cjs');
  try { await fs.symlink(binTarget, path.join(source, '.bin/fixture')); }
  catch (error) { if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows file-symlink privilege is unavailable'); return; }
  const file = path.join(__dirname, '../electron/features/lab/workspace.cjs'), module = { exports: {} };
  const localRequire = createRequire(file);
  let cloneCalls = 0;
  vm.runInNewContext(await fs.readFile(file, 'utf8'), {
    module, process: { platform: 'darwin' },
    require(name) {
      if (name !== './process.cjs') return localRequire(name);
      return { ...localRequire(name), async command(file, args) {
        assert.equal(file, '/bin/cp'); cloneCalls++;
        await fs.writeFile(path.join(args.at(-1), 'partial-copy'), 'incomplete');
        return { code: 1 };
      } };
    },
  });
  const destination = path.join(root, 'workspace/node_modules');
  await module.exports.copyDependencies(path.dirname(source), destination);
  assert.equal(cloneCalls, 1);
  assert.equal(await fs.stat(path.join(destination, 'partial-copy')).catch(() => null), null);
  assert.equal(await fs.stat(path.join(destination, 'electron/dist')).catch(() => null), null);
  assert.equal(await fs.readlink(path.join(source, '.bin/fixture')), binTarget);
  assert.equal(await fs.readlink(path.join(destination, '.bin/fixture')), binTarget);
  assert.equal(path.isAbsolute(binTarget), false);
  await fs.writeFile(path.join(destination, 'fixture-pkg/cli.cjs'), 'module.exports = 2;');
  assert.equal(await fs.readFile(path.join(source, 'fixture-pkg/cli.cjs'), 'utf8'), 'module.exports = 1;');
});

test('cache eviction removes the oldest whole entry, preserves active hashes and never follows links', async t => {
  const root = await temporary(t), cache = path.join(root, 'cache'), owner = path.join(root, 'owner');
  const old = path.join(cache, 'oss/pip/old'), active = path.join(cache, 'oss/pip/active'), newer = path.join(cache, 'aa/tasks/new');
  for (const folder of [old, active, newer, owner]) await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(old, 'wheel'), '1234567890'); await fs.writeFile(path.join(active, 'wheel'), '1234567890');
  await fs.writeFile(path.join(newer, 'task'), '1234567890'); await fs.writeFile(path.join(owner, 'keep'), 'owner data');
  await fs.symlink(owner, path.join(cache, 'history'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.utimes(path.join(old, 'wheel'), new Date(1000), new Date(1000)); await fs.utimes(old, new Date(1000), new Date(1000));
  await fs.utimes(path.join(active, 'wheel'), new Date(2000), new Date(2000)); await fs.utimes(active, new Date(2000), new Date(2000));
  const remaining = await pruneCache(cache, { limitBytes: 20, inUse: [active] });
  assert.ok(remaining <= 20); assert.equal(await fs.stat(old).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(active, 'wheel'), 'utf8'), '1234567890');
  assert.equal(await fs.readFile(path.join(owner, 'keep'), 'utf8'), 'owner data');
  await assert.rejects(pruneCache(cache, { limitBytes: 1, inUse: [active] }), error => error.infrastructure === true);
});
