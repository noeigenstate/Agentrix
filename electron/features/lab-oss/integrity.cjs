const fs = require('node:fs/promises');
const path = require('node:path');
const { abort, fatal, patchPaths, sha256 } = require('./data.cjs');

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
    if (record.type === 'file') {
      if (!options?.environment && CONFIG.has(path.posix.basename(file).toLowerCase())) {
        const section = pytestSections(file, await fs.readFile(absolute, 'utf8'));
        if (section === null) return;
        record.sha256 = sha256(section);
      } else record.sha256 = await ctx.tools.hashFile(absolute);
    }
    records.push({ file, ...record });
  }, options);
  return records;
}

function strictControl(file) {
  const name = path.posix.basename(file).toLowerCase();
  return CONFIG.has(name) || name === 'conftest.py' || name.endsWith('.pth') ||
    file.toLowerCase().split('/').some(part => /^(?:sitecustomize|usercustomize)(?:\.|$)/.test(part));
}

// Configuration values outside pytest's own section do not control the grader. Unusual TOML forms fall back to
// whole-file verification rather than trying to implement TOML or accepting a quoted/dotted-key bypass.
function pytestSections(file, content) {
  const name = path.posix.basename(file).toLowerCase();
  if (name === 'pytest.ini' || name === '.pytest.ini') return content;
  const toml = name === 'pyproject.toml';
  if (toml && /"""|'''|^\s*\[[^\r\n]*["']|^\s*["'][^\r\n]*=|^\s*tool(?:\s*\.|\s*=)/m.test(content) ||
    !toml && /^\s+\[/m.test(content)) return content;
  const sections = [], wanted = name === 'setup.cfg' ? 'tool:pytest' : 'pytest';
  let active = false;
  for (const line of content.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/.exec(line);
    if (header) {
      const section = header[1].replace(/\s*\.\s*/g, '.').trim();
      active = toml ? section === 'tool' || section === 'tool.pytest' || section.startsWith('tool.pytest.') : section === wanted;
    }
    if (active) sections.push(line);
  }
  return sections.length ? sections.join('\n') : null;
}

function subjectPlugin(file, repo) {
  return repo === 'pytest-dev/pytest' && /^(?:src\/)?(?:_pytest|pytest)\//.test(file);
}

async function controls(ctx, plugins = []) {
  const files = new Set(plugins);
  for (const file of plugins) {
    const parts = file.split('/'); parts.pop();
    while (parts.length) { files.add(parts.join('/') + '/__init__.py'); parts.pop(); }
  }
  return tree(path.join(ctx.workspaceRoot, 'worktree'), ctx,
    (file, record) => record.type !== 'directory' && (strictControl(file) || files.has(file)));
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
  const expected = await load(ctx, 'oss-environment.json');
  await discardEnvironmentCaches(ctx, directory, expected);
  compare(expected, await tree(directory, ctx, () => true, { environment: true }),
    'OSS prepared Python environment was tampered with');
}

async function discardEnvironmentCaches(ctx, directory, expected) {
  const sealed = new Set(expected.map(record => record.file)), files = [], folders = [];
  await walk(directory, ctx, async (file, record) => {
    if (sealed.has(file)) return;
    const parts = file.split('/'), name = parts.pop(), cached = parts.includes('.pytest_cache');
    if (record.type === 'file' && (parts.at(-1) === '__pycache__' && /\.pyc$/i.test(name) ||
      cached && !/\.(?:py|pyw|pth|pyd|so|dylib|dll|exe|pyc|pyo)$/i.test(name))) files.push(file);
    if (record.type === 'directory' && (name === '__pycache__' || name === '.pytest_cache' || cached)) folders.push(file);
  }, { environment: true });
  // Remove only unsealed derived data. In particular an existing/sealed pyc remains immutable, and arbitrary new
  // source, startup code or binaries, even inside a cache directory, must still fail the complete comparison.
  for (const file of files) await fs.unlink(path.join(directory, file));
  for (const file of folders.reverse()) await fs.rmdir(path.join(directory, file)).catch(error => {
    if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  });
}

async function sealWorkspace(ctx, row) {
  const fixes = patchPaths(row.patch), plugins = (ctx.reference?.plugins || []).filter(file => !subjectPlugin(file, row.repo));
  await save(ctx, 'oss-workspace.json', { fixes, plugins, records: await controls(ctx, plugins) });
}

async function workspaceControls(ctx) {
  const seal = await load(ctx, 'oss-workspace.json');
  return controls(ctx, seal.plugins);
}

async function verifyWorkspace(ctx, reference = []) {
  const seal = await load(ctx, 'oss-workspace.json');
  // Only real controls are pinned. The subject's source, including pytest's own runner and helper modules, is
  // editable regardless of which files the reference fixed; this necessarily retains the in-process trust limit.
  compare(seal.records, await controls(ctx, seal.plugins), 'OSS repository grading controls were tampered with',
    reference.filter(record => seal.fixes.includes(record.file) && strictControl(record.file)));
}

async function trustWorkspace(ctx) {
  const seal = await load(ctx, 'oss-workspace.json');
  await save(ctx, 'oss-workspace.json', { ...seal, records: await controls(ctx, seal.plugins) });
}

async function referenceControls(ctx) {
  const seal = await load(ctx, 'oss-workspace.json'), records = await controls(ctx, seal.plugins);
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
  walk, subjectPlugin,
};
