// What a dispatched worker may change and what it must know: globs, a project's BOUNDARY.md files, and the files a
// worker changed in its git working tree. Plain Node: the dispatch helper carries it (integration/dispatch.cjs RUNTIME_FILES).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const posix = file => file.split(path.sep).join('/');

// `*` stays within a name, `**` crosses folders (the BOUNDARY.md and --allow syntax).
function globRegExp(glob) {
  const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '(?:.*/)?');
  return new RegExp(`^${source.replace(/\(\?:\.\*\/\)\?$/, '.*')}$`);
}
const matches = (globs, file) => globs.some(glob => globRegExp(glob).test(file));

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });

// The repo-relative files git sees in cwd's repository (tracked and untracked, not ignored); null outside git.
function repoFiles(cwd) {
  try {
    const root = git(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
    const files = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString('utf8').split('\0').filter(Boolean);
    return { root, files };
  } catch { return null; }
}

// Content hashes of dirty files for change checks, plus their status for the worker's repository brief.
// A precomputed repository listing supplies the root without another Git lookup.
function snapshot(cwd, repo) {
  let root = repo?.root;
  try { root ||= git(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trim(); } catch { return null; }
  const head = (() => { try { return git(root, ['rev-parse', 'HEAD']).toString('utf8').trim(); } catch { return null; } })();
  const dirty = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).toString('utf8').split('\0').filter(Boolean);
  const files = new Map(), statuses = [];
  for (let i = 0; i < dirty.length; i++) {
    const entry = dirty[i], status = entry.slice(0, 2), file = entry.slice(3);
    const source = status[0] === 'R' || status[0] === 'C' ? dirty[++i] : undefined;
    let hash = 'deleted';
    try { hash = createHash('sha1').update(fs.readFileSync(path.join(root, file))).digest('hex'); } catch {}
    files.set(file, hash);
    statuses.push({ status, file, ...(source ? { source } : {}) });
  }
  return { root, head, files, status: statuses };
}

// Files changed between two snapshots of the same working tree (commits made in between count by their diff).
function changedBetween(before, after) {
  if (!before || !after || before.root !== after.root) return null;
  const changed = new Set();
  for (const [file, hash] of after.files) if (before.files.get(file) !== hash) changed.add(file);
  for (const file of before.files.keys()) if (!after.files.has(file)) changed.add(file);
  if (before.head && after.head && before.head !== after.head) {
    try { for (const file of git(after.root, ['diff', '--name-only', '-z', before.head, after.head]).toString('utf8').split('\0').filter(Boolean)) changed.add(file); } catch {}
  }
  return [...changed].sort();
}

// A BOUNDARY.md's Owns globs (the full format is checked by the project's own tests).
function ownsOf(text) {
  const start = text.indexOf('\n## Owns');
  if (start < 0) return [];
  const end = text.indexOf('\n## ', start + 1);
  return [...text.slice(start, end < 0 ? undefined : end).matchAll(/^- `([^`]+)`/gm)].map(match => match[1]);
}

// The BOUNDARY.md files of the modules owning any file the worker may change, with their text.
function boundariesFor(cwd, allow, repo = repoFiles(cwd)) {
  if (!repo || !allow.length) return [];
  const allowed = repo.files.filter(file => matches(allow, file));
  return repo.files.filter(file => path.posix.basename(file) === 'BOUNDARY.md').flatMap(file => {
    let text;
    try { text = fs.readFileSync(path.join(repo.root, file), 'utf8'); } catch { return []; }
    const owns = ownsOf(text);
    return allowed.some(item => matches(owns, item)) ? [{ file, text }] : [];
  });
}

module.exports = { globRegExp, matches, posix, repoFiles, snapshot, changedBetween, ownsOf, boundariesFor };
