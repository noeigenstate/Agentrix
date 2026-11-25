const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const { readGitRaw, parseStatus, parseHistory, parseFiles, parseDiff, ProjectGit, gitEnvironment } = require('../electron/project-git.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-git-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase()); assert.ok(path.basename(root).startsWith('agentrix-git-')); await fs.rm(root, { recursive: true, force: true }); });
  const dir = path.join(root, '项目 repo'); await fs.mkdir(dir);
  const git = async (...args) => (await exec('git', ['-C', dir, ...args], { env: gitEnvironment(), windowsHide: true, encoding: 'utf8', timeout: 10000 })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test 用户'); await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  const write = async (name, value) => { await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await fs.writeFile(path.join(dir, name), value); };
  const status = async (directory = dir) => parseStatus(await readGitRaw(directory, 'status'));
  const history = async (directory = dir, offset = 0) => parseHistory(await readGitRaw(directory, 'history', offset), offset);
  return { dir, root, git, write, status, history };
}

test('D5 an unborn Git branch has empty history', async t => {
  const { dir } = await fixture(t);
  assert.deepEqual(await readGitRaw(dir, 'history', 0), { repository: true, prefix: '', output: '' });
});
test('Git status distinguishes stages, worktree edits, renames, deletions and Unicode untracked files', async t => {
  const f = await fixture(t);
  assert.equal((await f.status()).unborn, true); assert.deepEqual((await f.history()).commits, []);
  for (const name of ['修改.txt', 'delete.txt', 'old name.txt', 'sub/inner.txt', 'outside.txt']) await f.write(name, `${name} initial\n`);
  await f.write('.gitignore', 'ignored/\n*.log\n'); await f.git('add', '.'); await f.git('commit', '-m', '首次提交 中文');
  await f.write('修改.txt', 'staged\n'); await f.git('add', '修改.txt'); await f.write('修改.txt', 'staged + unstaged\n');
  await fs.unlink(path.join(f.dir, 'delete.txt')); await f.git('mv', 'old name.txt', 'new name.txt');
  await f.write('new 文件 [1].txt', 'untracked'); await f.write('ignored/cache.log', 'ignored'); await f.write('sub/inner.txt', 'inside'); await f.write('outside.txt', 'outside');
  const indexBefore = await fs.readFile(path.join(f.dir, '.git/index'));
  const state = await f.status();
  assert.equal(state.branch, 'main'); assert.equal(state.repository, true); assert.equal(state.total, 6);
  assert.deepEqual(state.files.find(file => file.path === '修改.txt'), { path: '修改.txt', index: 'M', worktree: 'M', originalPath: null, submodule: false, conflict: false, untracked: false });
  assert.equal(state.files.find(file => file.path === 'delete.txt').worktree, 'D');
  assert.equal(state.files.find(file => file.path === 'new name.txt').originalPath, 'old name.txt');
  assert.equal(state.files.find(file => file.path === 'new 文件 [1].txt').untracked, true);
  assert.ok(!state.files.some(file => file.path.includes('ignored')));
  assert.deepEqual(await fs.readFile(path.join(f.dir, '.git/index')), indexBefore, 'background status does not rewrite the index');
  assert.deepEqual((await f.status(path.join(f.dir, 'sub'))).files.map(file => file.path), ['inner.txt']);
  await f.git('add', '.'); await f.git('commit', '-m', '第二次提交'); await f.git('config', 'diff.relative', 'true');
  const log = await f.history(); assert.equal(log.commits.length, 2); assert.equal(log.commits[0].subject, '第二次提交'); assert.equal(log.commits[0].author, 'Test 用户');
  const files = parseFiles(await readGitRaw(f.dir, 'files', log.commits[0].hash));
  assert.ok(files.files.some(file => file.path === 'new name.txt' && file.status === 'R' && file.originalPath === 'old name.txt'));
  assert.deepEqual(parseFiles(await readGitRaw(path.join(f.dir, 'sub'), 'files', log.commits[0].hash)).files.map(file => file.path), ['inner.txt']);
  assert.equal((await f.status()).total, 0);
  await f.git('checkout', '--detach'); assert.equal((await f.status()).detached, true);
});
test('Git history carries actual merge parents and commit file changes, and status reports conflicts', async t => {
  const f = await fixture(t); await f.write('conflict.txt', 'base\n'); await f.git('add', '.'); await f.git('commit', '-m', 'base');
  const initial = (await f.history()).commits[0];
  assert.equal(parseFiles(await readGitRaw(f.dir, 'files', initial.hash)).files[0].status, 'A');
  await f.git('checkout', '-b', 'feature'); await f.write('feature.txt', 'feature'); await f.git('add', '.'); await f.git('commit', '-m', 'feature');
  await f.git('checkout', 'main'); await f.write('main.txt', 'main'); await f.git('add', '.'); await f.git('commit', '-m', 'main');
  await f.git('merge', '--no-ff', 'feature', '-m', 'merge feature');
  const merged = (await f.history()).commits[0]; assert.equal(merged.parents.length, 2);
  assert.deepEqual(parseFiles(await readGitRaw(f.dir, 'files', merged.hash)).files.map(file => file.path), ['feature.txt']);
  await f.git('checkout', 'feature'); await f.write('conflict.txt', 'feature change\n'); await f.git('add', '.'); await f.git('commit', '-m', 'conflict on feature');
  await f.git('checkout', 'main'); await f.write('conflict.txt', 'main change\n'); await f.git('add', '.'); await f.git('commit', '-m', 'conflict on main');
  await assert.rejects(f.git('merge', 'feature'));
  const status = await f.status(); assert.equal(status.conflicts, 1); assert.equal(status.files.find(file => file.path === 'conflict.txt').conflict, true);
});
test('Git supports linked worktrees and branch tracking without fetching, and rejects unsafe revisions', async t => {
  const f = await fixture(t); await f.write('a.txt', 'a'); await f.git('add', '.'); await f.git('commit', '-m', 'first');
  await f.git('branch', 'upstream'); await f.git('branch', '--set-upstream-to=upstream');
  await f.write('a.txt', 'b'); await f.git('commit', '-am', 'ahead');
  const status = await f.status(); assert.equal(status.ahead, 1); assert.equal(status.behind, 0);
  const linked = path.join(f.root, 'linked'); await f.git('worktree', 'add', '-b', 'linked', linked);
  await fs.writeFile(path.join(linked, 'a.txt'), 'linked edit'); assert.equal((await f.status(linked)).branch, 'linked');
  const empty = path.join(f.root, 'plain'); await fs.mkdir(empty); assert.equal((await f.status(empty)).repository, false);
  await assert.rejects(readGitRaw(f.dir, 'files', '--output=oops'));
  await assert.rejects(readGitRaw(f.dir, 'history', -1));
  const cleaned = gitEnvironment({ GIT_DIR: 'wrong', GIT_INDEX_FILE: 'wrong', PATH: 'keep', CUSTOM: 'keep' });
  assert.equal(cleaned.GIT_DIR, undefined); assert.equal(cleaned.CUSTOM, 'keep'); assert.equal(cleaned.GIT_OPTIONAL_LOCKS, '0');
});
test('concurrent Git requests share one read and release failed or completed requests', async () => {
  let calls = 0, release;
  const reader = new ProjectGit(() => ({ request: async () => { calls++; await new Promise(resolve => { release = resolve; }); return { repository: true, prefix: '', output: '# branch.head main\0' }; } }));
  const project = { id: 'ssh', path: '/project', kind: 'ssh' };
  const a = reader.read(project, 'status'), b = reader.read(project, 'status');
  assert.equal(calls, 1); release(); await Promise.all([a, b]);
  const c = reader.read(project, 'status'); assert.equal(calls, 2); release(); await c;
});

test('signed commits remain machine-readable when user config enables signature verification', async t => {
  const f = await fixture(t); await f.write('signed.txt', 'signed change'); await f.git('add', '.');
  const tree = await f.git('write-tree');
  const raw = `tree ${tree}\nauthor Test <test@example.invalid> 1700000000 +0000\ncommitter Test <test@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n invalid-test-signature\n -----END PGP SIGNATURE-----\n\nsigned fixture\n`;
  const object = path.join(f.root, 'signed-commit'); await fs.writeFile(object, raw);
  const hash = await f.git('hash-object', '-t', 'commit', '-w', object); await f.git('update-ref', 'refs/heads/main', hash);
  await f.git('config', 'log.showSignature', 'true');
  const history = await f.history(); assert.equal(history.commits[0].hash, hash); assert.equal(history.commits[0].subject, 'signed fixture');
  assert.deepEqual(parseFiles(await readGitRaw(f.dir, 'files', hash)).files.map(file => file.path), ['signed.txt']);
});

test('history pages include empty commits and graph lanes follow real parents', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 42; index++) await f.git('commit', '--allow-empty', '-m', `empty ${index}`);
  const first = await f.history(), second = await f.history(f.dir, first.nextOffset);
  assert.equal(first.commits.length, 40); assert.equal(first.nextOffset, 40); assert.equal(second.commits.length, 2); assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.commits, ...second.commits].map(commit => commit.hash)).size, 42);
  const { commitGraph, gitDecorations } = await import('../src/features/git/git-status.ts');
  const commit = (hash, parents) => ({ hash, parents, subject: '', author: '', date: '', refs: '' });
  const graph = commitGraph([commit('merge', ['main', 'feature']), commit('main', ['base']), commit('feature', ['base']), commit('base', []), commit('unrelated', [])]);
  assert.equal(graph.rows[0].edges.length, 2); assert.equal(graph.rows[0].incoming, false);
  assert.equal(graph.rows[1].incoming, true); assert.equal(graph.rows[1].color, graph.rows[0].color);
  assert.equal(graph.rows[3].after, 0); assert.equal(graph.rows[4].incoming, false);
  const decorations = gitDecorations({ files: [
    { path: 'src/a.txt', index: 'D', worktree: '.', conflict: false, untracked: false },
    { path: 'src/a.txt', index: '?', worktree: '?', conflict: false, untracked: true },
  ] });
  assert.equal(decorations.get('src').count, 1);
});

test('a file\'s changes come as hunks that can be kept (staged) or reverted one at a time, also from a subfolder', async t => {
  const f = await fixture(t);
  const lines = count => Array.from({ length: count }, (_, index) => `line ${index}`);
  await f.write('sub/notes.txt', lines(20).join('\n') + '\n'); await f.write('image.bin', Buffer.from([0, 1, 2, 255]));
  await f.git('add', '.'); await f.git('commit', '-m', '基础');
  await f.write('sub/notes.txt', lines(20).map((line, index) => index === 2 ? 'LINE 2' : index === 15 ? 'LINE 15' : line).join('\n') + '\n');
  await f.write('sub/new.txt', '新文件\n'); await f.write('image.bin', Buffer.from([0, 1, 2, 254]));
  const sub = path.join(f.dir, 'sub');
  const diff = parseDiff(await readGitRaw(sub, 'diff', { path: 'notes.txt' }));
  assert.equal(diff.hunks.length, 2); assert.equal(diff.added, 2); assert.equal(diff.removed, 2); assert.equal(diff.text, true);
  assert.deepEqual(diff.hunks[0].lines.filter(line => line.type !== ' ').map(line => line.type + line.text), ['-line 2', '+LINE 2']);
  assert.equal(diff.hunks[1].oldStart, 13);
  await readGitRaw(sub, 'apply', { patch: diff.hunks[0].patch, reverse: true });
  assert.equal((await fs.readFile(path.join(sub, 'notes.txt'), 'utf8')).split('\n')[2], 'line 2', 'the first hunk is undone in the working tree');
  const rest = parseDiff(await readGitRaw(sub, 'diff', { path: 'notes.txt' }));
  assert.equal(rest.hunks.length, 1);
  await readGitRaw(sub, 'apply', { patch: rest.hunks[0].patch, cached: true });
  assert.equal(parseDiff(await readGitRaw(sub, 'diff', { path: 'notes.txt' })).hunks.length, 0, 'a kept hunk leaves the working tree list');
  assert.equal(parseDiff(await readGitRaw(sub, 'diff', { path: 'notes.txt', staged: true })).hunks.length, 1, 'and is staged');
  const fresh = parseDiff(await readGitRaw(sub, 'diff', { path: 'new.txt', untracked: true }));
  assert.equal(fresh.hunks.length, 1); assert.equal(fresh.hunks[0].lines[0].text, '新文件');
  await readGitRaw(sub, 'apply', { patch: fresh.patch, cached: true });
  assert.ok((await f.status()).files.find(file => file.path === 'sub/new.txt').index === 'A', 'a kept new file is added');
  await readGitRaw(sub, 'apply', { patch: fresh.patch, cached: true, reverse: true }); await readGitRaw(sub, 'apply', { patch: fresh.patch, reverse: true });
  await assert.rejects(fs.stat(path.join(sub, 'new.txt')), 'a reverted new file is removed');
  assert.equal(parseDiff(await readGitRaw(f.dir, 'diff', { path: 'image.bin' })).binary, true);
  await assert.rejects(readGitRaw(sub, 'diff', { path: '../notes.txt' }), /无效的文件路径/);
  await assert.rejects(readGitRaw(sub, 'apply', { patch: '' }), /无效的补丁/);
});
