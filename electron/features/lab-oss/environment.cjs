const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sha256, infrastructure, fatal, abort } = require('./data.cjs');
const { locked, lease } = require('./cache.cjs');

// pip's isolated option alone does not disable netrc or keyring. All installation commands also get an empty home,
// an empty netrc and no inherited Python path; no package manager setting from the owner's profile is consulted.
const PIP = [
  'import os, sys, runpy',
  'home, cache, version = sys.argv[1:4]',
  'os.environ.update(HOME=home, USERPROFILE=home, APPDATA=home, LOCALAPPDATA=home, XDG_CONFIG_HOME=home,',
  '    NETRC=os.path.join(home, ".netrc"), PIP_CONFIG_FILE=os.devnull, PYTHON_KEYRING_BACKEND="keyring.backends.null.Keyring")',
  'for key in list(os.environ):',
  '    if key.startswith(("PYTHONPATH", "PYTHONHOME", "PIP_")) and key != "PIP_CONFIG_FILE": del os.environ[key]',
  'if version: os.environ["SETUPTOOLS_SCM_PRETEND_VERSION"] = version',
  'sys.argv = ["pip", "--isolated", "--disable-pip-version-check", "--no-input", "--cache-dir", cache] + sys.argv[4:]',
  'runpy.run_module("pip", run_name="__main__")',
].join('\n');

const environmentPath = ctx => path.join(ctx.workspaceRoot, '.oss-venv');
const pythonPath = ctx => path.join(environmentPath(ctx), ctx.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const requirementsHash = entry => sha256(JSON.stringify(entry.requirements));
const cacheKey = (entry, ctx, runtime) => path.join(ctx.cacheDirectory, 'pip', requirementsHash(entry), ctx.platform + '-' + runtime);
const RUNTIME = 'import sys, platform; print(sys.implementation.name + "-" + str(sys.version_info.major) + str(sys.version_info.minor) + "-" + platform.machine())';

async function checkedExecute(ctx, file, args, options) {
  abort(ctx);
  try {
    const result = await ctx.session.execute(file, args, options);
    if (result.code !== 0) throw infrastructure('OSS Python preparation failed; see the preparation log.');
    return result;
  } catch (error) {
    if (ctx.signal?.aborted || error.fatal) throw error;
    // Do not echo pip output: a dependency may print a URL, a credential-like string or local configuration.
    throw infrastructure('OSS Python preparation failed; see the preparation log.');
  }
}

async function wheels(directory, ctx) {
  const names = (await fs.readdir(directory)).sort();
  if (!names.length || names.length > 256 || names.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9_.+-]*\.whl$/.test(name))) {
    throw infrastructure('Invalid OSS wheel cache.');
  }
  const result = [];
  for (const name of names) {
    const file = path.join(directory, name), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 256 * 1024 * 1024) {
      throw infrastructure('Invalid OSS wheel cache.');
    }
    result.push({ name, bytes: stat.size, sha256: await ctx.tools.hashFile(file) });
  }
  return result;
}

async function restoreWheels(directory, target, ctx) {
  let saved;
  try { saved = JSON.parse(await fs.readFile(path.join(directory, 'wheels.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw infrastructure('Invalid OSS wheel cache.'); }
  if (!Array.isArray(saved) || !saved.length || saved.length > 256) throw infrastructure('Invalid OSS wheel cache.');
  await fs.mkdir(target, { recursive: true });
  for (const item of saved) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.+-]*\.whl$/.test(item.name) || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw infrastructure('Invalid OSS wheel cache.');
    }
    const source = path.join(directory, 'wheels', item.name), stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes || await ctx.tools.hashFile(source) !== item.sha256) {
      throw infrastructure('OSS wheel checksum mismatch.');
    }
    await fs.copyFile(source, path.join(target, item.name));
  }
  return true;
}

async function saveWheels(directory, source, ctx) {
  const records = await wheels(source, ctx), temporary = path.join(directory, randomUUID());
  await fs.mkdir(path.join(temporary, 'wheels'), { recursive: true });
  try {
    for (const item of records) await fs.copyFile(path.join(source, item.name), path.join(temporary, 'wheels', item.name));
    await fs.writeFile(path.join(temporary, 'wheels.json'), JSON.stringify(records), { mode: 0o600 });
    const destination = path.resolve(directory, 'wheels'), relative = path.relative(path.resolve(ctx.cacheDirectory), destination);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw infrastructure('Invalid OSS wheel cache path.');
    // A crash can leave a wheel directory without its final index. No reader accepts that incomplete entry.
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(path.join(temporary, 'wheels'), path.join(directory, 'wheels'));
    // The index is published last; readers can never observe half a wheel set.
    await fs.rename(path.join(temporary, 'wheels.json'), path.join(directory, 'wheels.json'));
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

async function prepareEnvironment(entry, cwd, ctx, python) {
  const home = path.join(ctx.workspaceRoot, '.pip-home'), temporary = path.join(ctx.workspaceRoot, '.pip-cache');
  const wheelhouse = path.join(ctx.workspaceRoot, '.oss-wheels'), log = path.join(ctx.artifactDirectory, 'prepare.log');
  for (const folder of [home, temporary, wheelhouse, ctx.artifactDirectory]) await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(home, '.netrc'), '', { mode: 0o600 });
  const base = python || { file: ctx.platform === 'win32' ? 'python' : 'python3', args: [] };
  await checkedExecute(ctx, base.file, [...(base.args || []), '-I', '-m', 'venv', '--copies', environmentPath(ctx)], {
    cwd, timeoutMs: 120000, log, network: false,
  });
  const runtime = (await checkedExecute(ctx, pythonPath(ctx), ['-I', '-c', RUNTIME], {
    cwd, timeoutMs: 10000, log, network: false,
  })).stdout.trim();
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runtime)) throw infrastructure('Invalid OSS Python runtime identity.');
  const directory = cacheKey(entry, ctx, runtime);
  // A private baseline intentionally has no upstream tags. pytest uses setuptools-scm, so supply its manifest version
  // instead of accidentally generating 0.1 (which fails pytest's own minversion checks before collecting any tests).
  const version = entry.repo === 'pytest-dev/pytest' ? entry.version : '';
  const pip = (args, network) => checkedExecute(ctx, pythonPath(ctx), ['-I', '-c', PIP, home, temporary, version, ...args], {
    cwd, timeoutMs: 10 * 60000, log, network,
  });
  await locked(path.dirname(directory), ctx, () => lease(directory, async () => {
    const hit = await restoreWheels(directory, wheelhouse, ctx);
    if (!hit) {
      await pip(['wheel', '--only-binary=:all:', '--wheel-dir', wheelhouse, ...entry.requirements.packages], true);
      await wheels(wheelhouse, ctx);
    }
    await pip(['install', '--no-index', '--find-links', wheelhouse, ...entry.requirements.packages], true);
    if (entry.requirements.installEditable) {
      await pip(['install', '--no-index', '--no-deps', '--no-build-isolation', '--editable', cwd], true);
    }
    if (!hit) await saveWheels(directory, wheelhouse, ctx);
  }));
}

async function finalizeWorkspace(workspace, ctx) {
  const git = path.join(workspace.cwd, '.git');
  if (workspace.gitDirectory !== git || workspace.real !== workspace.cwd ||
    await fs.realpath(workspace.cwd) !== workspace.real || await fs.realpath(git) !== git ||
    !(await fs.lstat(git)).isDirectory() || (await fs.lstat(git)).isSymbolicLink()) {
    throw fatal('OSS preparation changed the isolated Git directory.');
  }
  const exclude = (await fs.readdir(workspace.cwd, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isDirectory() && (entry.name === '__pycache__' || entry.name.endsWith('.egg-info')))
    .map(entry => path.relative(workspace.cwd, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
  // Editable installs can generate source version files. Take the baseline after preparation so they do not appear
  // as model edits. The snapshot's Git directory is private and contains no upstream history.
  await fs.rm(git, { recursive: true, force: true });
  return ctx.tools.files(workspace.cwd, { signal: ctx.signal, exclude: [...exclude, '.pytest_cache'] });
}

module.exports = { prepareEnvironment, finalizeWorkspace, requirementsHash, pythonPath, environmentPath, cacheKey };
