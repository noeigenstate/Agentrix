const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const MAX_OUTPUT = 1024 * 1024, MAX_FILES = 5000, PAGE_SIZE = 40;
const FORMAT = '%H%x00%P%x00%an%x00%aI%x00%D%x00%s';

function gitEnvironment(source = process.env) {
  const env = { ...source, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' };
  for (const key of Object.keys(env)) if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key.toUpperCase())) delete env[key];
  return env;
}
// A path inside the project, as the window names files: forward slashes, relative, no parent steps.
function validatePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\\]/.test(value) || value.startsWith('/') || /^[a-z]:/i.test(value) || value.split('/').includes('..')) throw new Error('无效的文件路径。');
}
function validateQuery(action, value) {
  if (!['status', 'history', 'files', 'diff', 'apply'].includes(action)) throw new Error('无效的 Git 请求。');
  if (action === 'history' && (!Number.isInteger(value) || value < 0 || value > 100000)) throw new Error('无效的历史页码。');
  if (action === 'files' && (typeof value !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value))) throw new Error('无效的提交标识。');
  if (action === 'diff') { if (!value || typeof value !== 'object') throw new Error('无效的 Git 请求。'); validatePath(value.path); }
  if (action === 'apply' && (!value || typeof value !== 'object' || typeof value.patch !== 'string' || !value.patch || value.patch.length > MAX_OUTPUT)) throw new Error('无效的补丁。');
}
async function readGitRaw(directory, action, value) {
  validateQuery(action, value);
  // input: text for git's standard input (a patch). exitCodes: codes besides 0 whose output is still wanted.
  const run = async (args, { input, exitCodes = [] } = {}) => {
    try {
      const child = exec('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'color.ui=false', '-c', 'i18n.logOutputEncoding=UTF-8', '-C', directory, ...args], { env: gitEnvironment(), windowsHide: true, encoding: 'utf8', timeout: 8000, maxBuffer: MAX_OUTPUT });
      if (input !== undefined) { child.child.stdin.on('error', () => {}); child.child.stdin.end(input); }
      return (await child).stdout;
    } catch (error) {
      if (exitCodes.includes(error.code) && typeof error.stdout === 'string') return error.stdout;
      if (error.code === 'ENOENT') throw new Error('未找到 Git，请先安装 Git 并重新打开应用。');
      if (error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Git 读取超时或结果过大，请缩小项目范围后重试。');
      throw new Error(String(error.stderr || error.message).trim().slice(0, 600));
    }
  };
  try {
    const prefix = (await run(['rev-parse', '--show-prefix'])).replace(/\r?\n$/, '');
    if (action === 'status') return { repository: true, prefix, output: await run(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=none', '--', '.']) };
    if (action === 'diff') {
      const options = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '-U3'];
      // An untracked file has nothing in the index to compare with; against nothing it is one added hunk.
      // Run from the top of the repository so its header names the file as every other patch does.
      if (value.untracked) {
        const top = (await run(['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
        return { repository: true, prefix, output: await run(['-C', top, 'diff', '--no-index', ...options, '--', '/dev/null', prefix + value.path], { exitCodes: [1] }) };
      }
      return { repository: true, prefix, output: await run(['diff', ...(value.staged ? ['--cached'] : []), ...options, '--', value.path]) };
    }
    if (action === 'apply') {
      await run(['apply', ...(value.reverse ? ['-R'] : []), ...(value.cached ? ['--cached'] : []), '--whitespace=nowarn', '-'], { input: value.patch });
      return { repository: true, prefix, output: '' };
    }
    if (action === 'history') {
      let output;
      try { output = await run(['log', '--topo-order', '-z', `--format=${FORMAT}`, `--max-count=${PAGE_SIZE + 1}`, `--skip=${value}`, ...(prefix ? ['--full-history', '--', '.'] : ['--'])]); }
      catch (error) { if (/does not have any commits yet|your current branch.*does not have/i.test(error.message)) output = ''; else throw error; }
      return { repository: true, prefix, output };
    }
    const parents = (await run(['show', '-s', '--format=%P', `${value}^{commit}`, '--'])).trim().split(/\s+/).filter(Boolean);
    const args = parents.length
      ? ['diff', '--no-relative', '--name-status', '-z', '--no-ext-diff', '--no-textconv', '-M', parents[0], value, '--', '.']
      : ['diff-tree', '--root', '--no-relative', '--no-commit-id', '-r', '--name-status', '-z', '--no-ext-diff', '--no-textconv', value, '--', '.'];
    return { repository: true, prefix, output: await run(args) };
  } catch (error) {
    if (/not a git repository|must be run in a work tree/i.test(error.message)) return { repository: false, prefix: '', output: '' };
    throw error;
  }
}
function scopedPath(value, prefix) {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return null;
  const relative = value.slice(prefix.length);
  if (!relative || relative.length > 4096 || relative.startsWith('/') || relative.split('/').includes('..')) return null;
  return relative;
}
function change(path, index, worktree, originalPath = null, submodule = false) {
  const conflict = index === 'U' || worktree === 'U' || ['AA', 'DD'].includes(index + worktree);
  return { path, index, worktree, originalPath, submodule, conflict, untracked: index === '?' };
}
function parseStatus(raw) {
  const result = { repository: raw.repository, branch: '', head: '', detached: false, unborn: false, upstream: null, ahead: null, behind: null, files: [], total: 0, staged: 0, unstaged: 0, conflicts: 0, truncated: false };
  const tokens = raw.output.split('\0'), paths = new Set();
  for (let at = 0; at < tokens.length; at++) {
    const line = tokens[at]; if (!line) continue;
    if (line.startsWith('# ')) {
      if (line.startsWith('# branch.oid ')) { result.head = line.slice(13); result.unborn = result.head === '(initial)'; }
      if (line.startsWith('# branch.head ')) { result.branch = line.slice(14); result.detached = result.branch === '(detached)'; }
      if (line.startsWith('# branch.upstream ')) result.upstream = line.slice(18);
      const tracking = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (tracking) { result.ahead = Number(tracking[1]); result.behind = Number(tracking[2]); }
      continue;
    }
    let file;
    if (line.startsWith('? ')) {
      const name = scopedPath(line.slice(2), raw.prefix);
      if (name) file = change(name, '?', '?');
    } else if (/^[12u] /.test(line)) {
      const fieldCount = line[0] === '1' ? 8 : line[0] === '2' ? 9 : 10;
      let cursor = 0;
      for (let count = 0; count < fieldCount; count++) { cursor = line.indexOf(' ', cursor); if (cursor < 0) throw new Error('无法解析 Git 状态。'); cursor++; }
      const fields = line.slice(0, cursor - 1).split(' '), original = line[0] === '2' ? tokens[++at] : null;
      const name = scopedPath(line.slice(cursor), raw.prefix), oldName = original ? scopedPath(original, raw.prefix) : null;
      if (name) file = change(name, fields[1][0], fields[1][1], oldName, fields[2][0] === 'S');
      else if (oldName) file = change(oldName, 'D', '.');
    } else if (!line.startsWith('! ')) throw new Error('无法解析 Git 状态。');
    if (!file) continue;
    paths.add(file.path);
    if (file.conflict) result.conflicts++;
    else {
      if (!file.untracked && file.index !== '.') result.staged++;
      if (file.untracked || file.worktree !== '.') result.unstaged++;
    }
    if (result.files.length < MAX_FILES) result.files.push(file); else result.truncated = true;
  }
  result.total = paths.size;
  return result;
}
function parseHistory(raw, skip) {
  const fields = raw.output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 6) throw new Error('无法解析 Git 历史。');
  const commits = [];
  for (let index = 0; index < fields.length; index += 6) {
    const [hash, parents, author, date, refs, subject] = fields.slice(index, index + 6);
    if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(hash)) throw new Error('无法解析 Git 提交。');
    commits.push({ hash, parents: parents.split(' ').filter(Boolean), author, date, refs, subject });
  }
  return { commits: commits.slice(0, PAGE_SIZE), nextOffset: commits.length > PAGE_SIZE && skip + PAGE_SIZE <= 100000 ? skip + PAGE_SIZE : null };
}
function parseFiles(raw) {
  const tokens = raw.output.split('\0'), files = []; let total = 0;
  for (let index = 0; index < tokens.length && tokens[index]; index++) {
    const code = tokens[index], first = tokens[++index];
    const renamed = /^[RC]/.test(code), target = renamed ? tokens[++index] : first;
    const name = scopedPath(target, raw.prefix), oldName = renamed ? scopedPath(first, raw.prefix) : null;
    if (!name && !oldName) continue;
    total++;
    if (files.length < MAX_FILES) files.push({ path: name || oldName, status: name ? code[0] : 'D', originalPath: oldName });
  }
  return { files, total, truncated: total > MAX_FILES };
}
// git diff of one file as hunks the window shows and applies one at a time; each hunk carries a patch
// of its own (the file header and that hunk). text is false when the file is not UTF-8 text, whose
// patch could not be rebuilt from decoded text.
function parseDiff(raw) {
  const result = { repository: raw.repository, binary: false, text: !raw.output.includes('\uFFFD'), added: 0, removed: 0, hunks: [], patch: raw.output };
  const lines = raw.output.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const header = [];
  let hunk = null;
  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!range) throw new Error('无法解析 Git 差异。');
      hunk = { header: line, oldStart: Number(range[1]), oldLines: range[2] === undefined ? 1 : Number(range[2]), newStart: Number(range[3]), newLines: range[4] === undefined ? 1 : Number(range[4]), lines: [], patch: '' };
      result.hunks.push(hunk);
    } else if (!hunk) {
      header.push(line);
      if (/^Binary files .* differ$/.test(line)) result.binary = true;
    } else if (line.startsWith('\\')) hunk.lines.push({ type: '\\', text: line.slice(2) });
    else {
      const type = line[0] === '+' ? '+' : line[0] === '-' ? '-' : ' ';
      if (type === '+') result.added++; else if (type === '-') result.removed++;
      hunk.lines.push({ type, text: line.slice(1) });
    }
  }
  for (const item of result.hunks) item.patch = [...header, item.header, ...item.lines.map(line => (line.type === '\\' ? '\\ ' : line.type) + line.text)].join('\n') + '\n';
  return result;
}
class ProjectGit {
  constructor(remote) { this.remote = remote; this.pending = new Map(); }
  async read(project, action, value) {
    validateQuery(action, value);
    const key = JSON.stringify([project.id, project.path, action, value]);
    if (this.pending.has(key)) return this.pending.get(key);
    const task = (async () => {
      const raw = project.kind === 'ssh'
        ? await this.remote(project.id).request('git', { action, value })
        : await readGitRaw(project.path, action, value);
      switch (action) {
        case 'status': return parseStatus(raw);
        case 'history': return parseHistory(raw, value);
        case 'files': return parseFiles(raw);
        case 'diff': return parseDiff(raw);
        default: return { applied: raw.repository };
      }
    })();
    this.pending.set(key, task);
    try { return await task; } finally { if (this.pending.get(key) === task) this.pending.delete(key); }
  }
}
module.exports = { ProjectGit, readGitRaw, parseStatus, parseHistory, parseFiles, parseDiff, gitEnvironment };
