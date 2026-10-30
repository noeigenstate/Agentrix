const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { repoFiles, snapshot, changedBetween, boundariesFor } = require('../electron/boundaries.cjs');

function repository(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-boundaries-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'src'));
  for (const file of ['a.js', 'b.js']) fs.writeFileSync(path.join(directory, 'src', file), 'base\n');
  fs.writeFileSync(path.join(directory, 'src/BOUNDARY.md'), '# Boundary: Src\n\n## Owns\n- `src/**`\n');
  const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'ignore', windowsHide: true });
  git('init', '-q'); git('add', '-A'); git('-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-qm', 'base');
  return { directory, git };
}

test('cached repository listings preserve boundary and snapshot behavior without reading cwd again', t => {
  const { directory } = repository(t), repo = repoFiles(directory), missing = path.join(directory, 'missing');
  assert.deepEqual(boundariesFor(missing, ['src/**'], repo), boundariesFor(directory, ['src/**']));
  assert.equal(snapshot(missing), null);
  const cached = snapshot(missing, repo), ordinary = snapshot(directory);
  assert.equal(cached.root, ordinary.root); assert.equal(cached.head, ordinary.head); assert.deepEqual(cached.files, ordinary.files);
  assert.deepEqual(changedBetween(cached, ordinary), []);
});

test('snapshots retain staged working-tree untracked and rename status without changing file deltas', t => {
  const { directory, git } = repository(t);
  git('mv', 'src/a.js', 'src/renamed file.js');
  fs.writeFileSync(path.join(directory, 'src/b.js'), 'staged\n'); git('add', 'src/b.js');
  fs.writeFileSync(path.join(directory, 'src/b.js'), 'working\n');
  fs.writeFileSync(path.join(directory, 'new.txt'), 'new\n');
  const before = snapshot(directory);
  assert.deepEqual(before.status, [
    { status: 'MM', file: 'src/b.js' },
    { status: 'R ', file: 'src/renamed file.js', source: 'src/a.js' },
    { status: '??', file: 'new.txt' },
  ]);
  assert.deepEqual(changedBetween(before, { ...before, status: [] }), [], 'status metadata does not become a file change');
  fs.writeFileSync(path.join(directory, 'src/b.js'), 'changed again\n');
  assert.deepEqual(changedBetween(before, snapshot(directory, repoFiles(directory))), ['src/b.js']);
});

test('boundary helpers keep their existing outside-git results', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-no-boundary-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(repoFiles(directory), null); assert.equal(snapshot(directory), null);
  assert.deepEqual(boundariesFor(directory, ['**']), []);
});
