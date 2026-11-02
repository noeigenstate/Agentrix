const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TASK_ID } = require('../lab/sources/contract.cjs');

const sha256 = value => createHash('sha256').update(value).digest('hex');
const digest = value => /^[a-f0-9]{64}$/.test(value);
const infrastructure = message => Object.assign(new Error(message), { infrastructure: true });
const fatal = message => Object.assign(new Error(message), { fatal: true });
const abort = ctx => ctx.signal?.throwIfAborted();
const taskDirectory = (ctx, entry) => path.join(ctx.cacheDirectory, 'tasks', entry.id);
const mirrorDirectory = (ctx, entry) => path.join(ctx.cacheDirectory, 'git', entry.id + '.git');

function testPath(nodeid) {
  if (typeof nodeid !== 'string' || /[\0\r\n]/.test(nodeid)) throw new Error('Invalid OSS test id.');
  const file = nodeid.split('::')[0];
  if (!file.endsWith('.py') || file.startsWith('-') || !safePath(file)) throw new Error('Invalid OSS test path.');
  return file;
}

function safePath(file) {
  return typeof file === 'string' && !!file && !/[\\:\0-\x1f]/.test(file) && !file.startsWith('/') &&
    file.split('/').every(part => part && !['.', '..', '.git'].includes(part));
}

function validateManifest(input) {
  const manifest = structuredClone(input);
  if (!manifest || typeof manifest.version !== 'string' || !Array.isArray(manifest.tasks) || !manifest.tasks.length) {
    throw new Error('Invalid OSS manifest.');
  }
  const ids = new Set();
  for (const entry of manifest.tasks) {
    if (!TASK_ID.test(entry.id) || !entry.id.startsWith('oss-') || ids.has(entry.id) ||
      !/^[\w.-]+\/[\w.-]+$/.test(entry.repo) || !/^[a-f0-9]{40}$/.test(entry.base) ||
      typeof entry.instance !== 'string' || typeof entry.title !== 'string' || typeof entry.license !== 'string' ||
      !/^\d+(?:\.\d+){0,2}$/.test(entry.version) ||
      entry.url !== 'https://github.com/' + entry.repo + '.git' ||
      !/^https:\/\/datasets-server\.huggingface\.co\/rows\?/.test(entry.row?.url) || !digest(entry.row?.sha256) ||
      !Number.isInteger(entry.row?.bytes) || entry.row.bytes < 1 || entry.row.bytes > 8 * 1024 * 1024 ||
      !['problem_statement', 'patch', 'test_patch'].every(key => digest(entry.sha256?.[key])) ||
      !Array.isArray(entry.requirements?.packages) || !entry.requirements.packages.length ||
      entry.requirements.packages.some(spec => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*(?:\[[a-zA-Z0-9_,.-]+\])?==[a-zA-Z0-9_.+-]+$/.test(spec))) {
      throw new Error('Invalid OSS manifest entry.');
    }
    ids.add(entry.id);
    if (![entry.FAIL_TO_PASS, entry.PASS_TO_PASS].every(list => Array.isArray(list) && list.length)) {
      throw new Error('Both OSS test groups must be non-empty.');
    }
    const tests = [...entry.FAIL_TO_PASS, ...entry.PASS_TO_PASS];
    tests.forEach(testPath);
    if (new Set(tests).size !== tests.length) throw new Error('Duplicate OSS tests.');
  }
  return manifest;
}

function patchPaths(patch) {
  const paths = new Set();
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!header || !safePath(header[1]) || !safePath(header[2])) throw new Error('Unsafe OSS patch path.');
    }
    if (!line.startsWith('--- ') && !line.startsWith('+++ ')) continue;
    const file = line.slice(4);
    if (file === '/dev/null') continue;
    if (!/^[ab]\//.test(file) || !safePath(file.slice(2))) throw new Error('Unsafe OSS patch path.');
    paths.add(file.slice(2));
  }
  if (!paths.size || /^(?:GIT binary patch|Binary files |(?:old|new|new file|deleted file) mode 120000|rename |copy )/m.test(patch)) {
    throw new Error('Unsupported OSS patch.');
  }
  return [...paths].sort();
}

function readRow(raw, entry) {
  if (sha256(raw) !== entry.row.sha256 || raw.length !== entry.row.bytes) throw infrastructure('OSS task checksum mismatch.');
  let envelope;
  try { envelope = JSON.parse(raw); } catch { throw infrastructure('Invalid OSS dataset response.'); }
  const item = envelope?.rows?.[0], row = item?.row;
  if (!Array.isArray(envelope?.rows) || envelope.rows.length !== 1 || item.truncated_cells?.length || !row || row.instance_id !== entry.instance ||
    row.repo !== entry.repo || row.base_commit !== entry.base) throw infrastructure('OSS dataset identity mismatch.');
  for (const key of ['problem_statement', 'patch', 'test_patch']) {
    if (typeof row[key] !== 'string' || !row[key].trim() || sha256(row[key]) !== entry.sha256[key]) {
      throw infrastructure('OSS task material checksum mismatch.');
    }
  }
  for (const key of ['FAIL_TO_PASS', 'PASS_TO_PASS']) {
    let tests;
    try { tests = JSON.parse(row[key]); } catch { throw infrastructure('Invalid OSS dataset test list.'); }
    if (JSON.stringify(tests) !== JSON.stringify(entry[key])) throw infrastructure('OSS dataset test list mismatch.');
  }
  patchPaths(row.patch); patchPaths(row.test_patch);
  return row;
}

async function cachedRow(ctx, entry, optional = false) {
  abort(ctx);
  try { return readRow(await fs.readFile(path.join(taskDirectory(ctx, entry), 'row.json')), entry); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error.code) throw infrastructure('OSS task cache is unavailable.');
    throw error;
  }
}

// Check each component before main writes grading material into a model-owned tree. Unlink files before replacing
// them so a hard link cannot turn a restoration into a write to another file.
async function replaceFile(root, file, content) {
  if (!safePath(file)) throw fatal('An OSS grading path escapes the workspace.');
  const real = await fs.realpath(root);
  if (path.resolve(root) !== real) throw fatal('The OSS workspace was replaced by a link.');
  let directory = real;
  for (const part of file.split('/').slice(0, -1)) {
    directory = path.join(directory, part);
    const stat = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw fatal('An OSS grading directory is a link.');
    if (!stat) await fs.mkdir(directory);
  }
  const destination = path.join(real, file), stat = await fs.lstat(destination).catch(error => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw fatal('An OSS grading file is a link.');
  await fs.rm(destination, { force: true });
  if (content !== null) await fs.writeFile(destination, content, { mode: 0o600, flag: 'wx' });
}

module.exports = {
  sha256, infrastructure, fatal, abort, taskDirectory, mirrorDirectory, testPath, safePath,
  validateManifest, patchPaths, readRow, cachedRow, replaceFile,
};
