const fs = require('node:fs/promises');
const path = require('node:path');
const { abort, fatal, patchPaths } = require('./data.cjs');

const CONFIG = new Set(['pytest.ini', '.pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml']);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
};

async function physical(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== path.resolve(directory)) {
    throw fatal('An OSS integrity directory was replaced by a link.');
  }
  return path.resolve(directory);
}

// The seal and logs live outside every model write root. Nothing from the workspace supplies its own expected hashes.
async function privateFile(ctx, name) {
  const root = await physical(ctx.workspaceRoot), artifacts = await physical(ctx.artifactDirectory);
  if (inside(root, artifacts)) throw fatal('OSS integrity evidence must be outside the model workspace.');
  const file = path.join(artifacts, name), stat = await fs.lstat(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) {
    throw fatal('An OSS integrity evidence file was replaced by a link.');
  }
  return file;
}

async function save(ctx, name, value) {
  await fs.writeFile(await privateFile(ctx, name), JSON.stringify(value), { mode: 0o600 });
}

async function load(ctx, name) {
  try { return JSON.parse(await fs.readFile(await privateFile(ctx, name), 'utf8')); }
  catch (error) {
    if (ctx.signal?.aborted || error.fatal) throw error;
    throw new Error('The protected OSS preparation seal is unavailable.');
  }
}

async function walk(root, ctx, visit, { environment = false } = {}) {
  await physical(root);
  async function directory(relative) {
    abort(ctx);
    const names = (await fs.readdir(path.join(root, relative))).sort();
    for (const name of names) {
      if (!environment && ['.git', '__pycache__', '.pytest_cache'].includes(name)) continue;
      const file = relative ? relative + '/' + name : name, absolute = path.join(root, file);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        if (!environment) throw fatal('An OSS grading path is a link: ' + file);
        const target = await fs.readlink(absolute);
        if (!inside(root, await fs.realpath(absolute))) throw fatal('An OSS grading path is a link: ' + file);
        await visit(file, { type: 'link', target }, absolute);
      } else if (stat.isDirectory()) {
        await visit(file, { type: 'directory', mode: stat.mode & 0o777 }, absolute);
        await directory(file);
      } else if (stat.isFile() && stat.nlink === 1) {
        await visit(file, { type: 'file', mode: stat.mode & 0o777 }, absolute);
      } else throw fatal('An OSS grading path is not a private regular file: ' + file);
    }
  }
  await directory('');
}

async function tree(root, ctx, select, options) {
  const records = [];
  await walk(root, ctx, async (file, record, absolute) => {
    if (!select(file, record)) return;
    if (record.type === 'file') record.sha256 = await ctx.tools.hashFile(absolute);
    records.push({ file, ...record });
  }, options);
  return records;
}

function strictControl(file) {
  const name = path.posix.basename(file).toLowerCase();
  return CONFIG.has(name) || name === 'conftest.py' || name.endsWith('.pth') ||
    file.toLowerCase().split('/').some(part => /^(?:sitecustomize|usercustomize)(?:\.|$)/.test(part));
}

function control(file, fixes, plugins) {
  if (strictControl(file)) return true;
  if (fixes.includes(file)) return false;
  return plugins.has(file) || file.split('/').some(part => /^(?:tests?|testing|_pytest|pytest|pluggy)(?:\.|$)|^pytest_/.test(part));
}

async function controls(ctx, fixes, plugins = []) {
  const files = new Set(plugins);
  for (const file of plugins) {
    const parts = file.split('/'); parts.pop();
    while (parts.length) { files.add(parts.join('/') + '/__init__.py'); parts.pop(); }
  }
  return tree(path.join(ctx.workspaceRoot, 'worktree'), ctx,
    (file, record) => record.type !== 'directory' && control(file, fixes, files));
}

function compare(expected, actual, label, allowed = []) {
  const before = new Map(expected.map(record => [record.file, JSON.stringify(record)]));
  const after = new Map(actual.map(record => [record.file, JSON.stringify(record)]));
  const exceptions = new Map(allowed.map(record => [record.file, record.value === null ? undefined : JSON.stringify(record.value)]));
  for (const file of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(file) === after.get(file) || exceptions.has(file) && exceptions.get(file) === after.get(file)) continue;
    const reason = !before.has(file) ? 'added' : !after.has(file) ? 'removed' : 'changed';
    throw new Error(label + ': ' + JSON.stringify(file) + ' (' + reason + ').');
  }
}

async function sealEnvironment(ctx, directory) {
  await save(ctx, 'oss-environment.json', await tree(directory, ctx, () => true, { environment: true }));
}

async function verifyEnvironment(ctx, directory) {
  compare(await load(ctx, 'oss-environment.json'), await tree(directory, ctx, () => true, { environment: true }),
    'OSS prepared Python environment was tampered with');
}

async function sealWorkspace(ctx, row) {
  const fixes = patchPaths(row.patch), plugins = ctx.reference?.plugins || [];
  await save(ctx, 'oss-workspace.json', { fixes, plugins, records: await controls(ctx, fixes, plugins) });
}

async function workspaceControls(ctx) {
  const seal = await load(ctx, 'oss-workspace.json');
  return controls(ctx, seal.fixes, seal.plugins);
}

async function verifyWorkspace(ctx, reference = []) {
  const seal = await load(ctx, 'oss-workspace.json');
  // Only a control actually changed by the pinned reference may use its validated reference bytes. In particular,
  // pytest's own source fixes remain editable, while its other plugins and runner files are preparation-pinned.
  compare(seal.records, await controls(ctx, seal.fixes, seal.plugins), 'OSS repository grading controls were tampered with',
    reference.filter(record => seal.fixes.includes(record.file) && strictControl(record.file)));
}

async function trustWorkspace(ctx) {
  const seal = await load(ctx, 'oss-workspace.json');
  await save(ctx, 'oss-workspace.json', { ...seal, records: await controls(ctx, seal.fixes, seal.plugins) });
}

async function referenceControls(ctx) {
  const seal = await load(ctx, 'oss-workspace.json'), records = await controls(ctx, seal.fixes, seal.plugins);
  return seal.fixes.filter(strictControl).map(file => ({ file, value: records.find(record => record.file === file) || null }));
}

async function verifyControls(ctx, expected) {
  compare(expected, await workspaceControls(ctx), 'OSS grading controls changed while tests were running');
}

async function discardBytecode(ctx) {
  const root = path.join(ctx.workspaceRoot, 'worktree');
  // -B prevents new bytecode, but Python can still read model-written .pyc files. Remove every such file first,
  // without following links, including caches of conftest and startup modules that are restored from source.
  await physical(root);
  async function directory(folder) {
    for (const name of await fs.readdir(folder)) {
      abort(ctx);
      if (name === '.git') continue;
      const file = path.join(folder, name), stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw fatal('An OSS bytecode path is a link.');
      if (stat.isDirectory()) await directory(file);
      else if (/\.py[co]$/i.test(name)) {
        if (!path.relative(root, folder).split(path.sep).includes('__pycache__')) {
          throw new Error('Model-written sourceless Python bytecode was found: ' + JSON.stringify(path.relative(root, file)));
        }
        await fs.unlink(file);
      }
    }
  }
  await directory(root);
}

async function rejectReports(ctx) {
  for (const name of await fs.readdir(ctx.workspaceRoot)) {
    if (name.startsWith('.oss-junit-')) {
      throw new Error('A model-written OSS JUnit report was found; filesystem reports are never grading evidence.');
    }
    if (strictControl(name)) throw new Error('A model-written Python or pytest startup file was found outside the repository: ' + JSON.stringify(name));
  }
}

async function logError(ctx, label, error) {
  await fs.appendFile(await privateFile(ctx, label + '.log'), '\n[OSS grading integrity] ' + error.message + '\n', { mode: 0o600 });
}

module.exports = {
  sealEnvironment, verifyEnvironment, sealWorkspace, verifyWorkspace, trustWorkspace, workspaceControls,
  referenceControls, verifyControls, discardBytecode, rejectReports, logError,
};
