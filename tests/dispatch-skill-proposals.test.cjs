const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WorkerSkillProposals } = require('../electron/features/skills/worker-proposals.cjs');
const { digest, deliveryMarker } = require('../electron/features/skills/session.cjs');

const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
function fixture(t, allow = ['skills/**'], linked = true) {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-skill-proposals-')));
  const main = path.join(parent, 'main'); fs.mkdirSync(main);
  const git = args => execFileSync('git', args, { cwd: main, stdio: 'ignore', windowsHide: true });
  git(['init']); put(path.join(main, 'skills/old/SKILL.md'), 'Existing uncommitted contents.\r\n');
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Fixture']);
  const root = linked ? path.join(parent, 'worker') : main;
  if (linked) git(['worktree', 'add', '-qb', 'worker', root]);
  const options = { cwd: root, allow, out: path.join(root, 'answer.md') };
  put(path.join(root, 'skills/old/SKILL.md'), 'Existing uncommitted contents.\r\n');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { root, main, parent, options, file: path.join(root, 'skills/old/SKILL.md') };
}

test('broad scope restores edited/new/deleted skills and preserves worker versions beside the answer', t => {
  const f = fixture(t);
  const removed = path.join(f.root, 'skills/removed/SKILL.md'), added = path.join(f.root, 'skills/new/SKILL.md');
  put(removed, 'Original removed file.');
  const guard = new WorkerSkillProposals(f.options, {}, null);
  put(f.file, 'Worker version.'); fs.unlinkSync(removed); put(added, 'New skill.');
  assert.equal(guard.finish('run'), 3); assert.equal(guard.finish('run'), 3, 'recovery is idempotent');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Existing uncommitted contents.\r\n');
  assert.equal(fs.readFileSync(removed, 'utf8'), 'Original removed file.'); assert.equal(fs.existsSync(added), false);
  const folder = `${f.options.out}.skill-proposals-run`, { proposals } = JSON.parse(fs.readFileSync(path.join(folder, 'index.json')));
  assert.deepEqual(proposals.map(p => p.operation).sort(), ['create', 'delete', 'edit']);
  assert.ok(proposals.some(p => p.content && fs.readFileSync(path.join(folder, p.content), 'utf8') === 'Worker version.'));
});

test('only a literal approved SKILL.md path can remain changed', t => {
  const f = fixture(t, ['skills/old/SKILL.md', 'skills/*/SKILL.md']);
  const other = path.join(f.root, 'skills/other/SKILL.md'); put(other, 'Other original.');
  const guard = new WorkerSkillProposals(f.options, {}, null);
  put(f.file, 'Approved.'); put(other, 'Unapproved.');
  assert.equal(guard.finish('run'), 1); assert.equal(fs.readFileSync(f.file, 'utf8'), 'Approved.');
  assert.equal(fs.readFileSync(other, 'utf8'), 'Other original.');
});

test('concurrent owner edits to global and built-in skills are report-only, unrelated inherited deliveries are ignored', t => {
  const f = fixture(t), external = path.join(f.root, 'managed'), global = path.join(external, 'global/a/SKILL.md'), builtin = path.join(external, 'builtin/a/SKILL.md');
  put(global, 'Global.'); put(builtin, 'Built in.');
  const manifest = path.join(f.root, 'delivery/manifest.md'), fingerprint = digest('manifest'); put(manifest, 'Instructions.');
  put(`${manifest}.json`, JSON.stringify({ projectRoot: f.root, fingerprint, roots: [path.dirname(path.dirname(global)), path.dirname(path.dirname(builtin))] }));
  const note = path.join(f.root, 'note.txt'); put(note, `Note. ${deliveryMarker({ manifest, fingerprint })}`);
  const guard = new WorkerSkillProposals(f.options, { AGENTRIX_READING_NOTE_FILE: note }, null);
  put(global, 'Owner saved global.'); put(builtin, 'App updated built in.');
  assert.equal(guard.finish('managed'), 2); assert.equal(fs.readFileSync(global, 'utf8'), 'Owner saved global.'); assert.equal(fs.readFileSync(builtin, 'utf8'), 'App updated built in.');
  const { proposals } = JSON.parse(fs.readFileSync(`${f.options.out}.skill-proposals-managed/index.json`));
  assert.ok(proposals.every(p => !p.restored && p.note === 'changed during the run, author unknown'));
  assert.deepEqual(proposals.map(p => fs.readFileSync(`${f.options.out}.skill-proposals-managed/${p.content}`, 'utf8')).sort(), ['App updated built in.', 'Owner saved global.']);
  put(`${manifest}.json`, JSON.stringify({ projectRoot: path.join(f.root, 'unrelated'), fingerprint, roots: [external] }));
  const unrelated = new WorkerSkillProposals(f.options, { AGENTRIX_READING_NOTE_FILE: note }, null);
  put(global, 'Unrelated change.'); assert.equal(unrelated.finish('other'), 0);
});

test('concurrent lead edits in a shared checkout are preserved and reported with unknown authorship', t => {
  const f = fixture(t, ['skills/**'], false), guard = new WorkerSkillProposals(f.options, {});
  put(f.file, 'Lead live version.');
  assert.equal(guard.finish('shared'), 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Lead live version.');
  const { proposals } = JSON.parse(fs.readFileSync(`${f.options.out}.skill-proposals-shared/index.json`));
  assert.equal(proposals[0].note, 'changed during the run, author unknown');
  assert.equal(proposals[0].restored, false);
  assert.equal(fs.readFileSync(`${f.options.out}.skill-proposals-shared/${proposals[0].content}`, 'utf8'), 'Lead live version.');
});

test('snapshot size limits degrade to report-only and preserve large proposals without blocking a worker', t => {
  const f = fixture(t); put(f.file, 'x'.repeat(512 * 1024 + 1));
  const guard = new WorkerSkillProposals(f.options, {});
  put(f.file, 'y'.repeat(512 * 1024 + 1));
  assert.equal(guard.finish('large'), 1);
  assert.match([...guard.notes].join(), /report-only: snapshot limits exceeded/);
  assert.equal(fs.readFileSync(f.file, 'utf8')[0], 'y');
  assert.equal(fs.statSync(`${f.options.out}.skill-proposals-large/1.SKILL.md`).size, 512 * 1024 + 1);
});

test('skill scans skip node_modules and .git, directory limits leave live files untouched', t => {
  const f = fixture(t);
  for (const name of ['node_modules', '.git']) put(path.join(f.root, 'skills', name, 'ignored/SKILL.md'), 'Ignored.');
  const realReaddir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (folder, options) => folder === path.join(f.root, 'skills')
    ? [...realReaddir(folder, options), ...Array.from({ length: 8193 }, (_, i) => ({ name: `missing-${i}`, isDirectory: () => true, isSymbolicLink: () => false }))]
    : realReaddir(folder, options));
  const guard = new WorkerSkillProposals(f.options, {});
  put(f.file, 'Live change.');
  for (const name of ['node_modules', '.git']) put(path.join(f.root, 'skills', name, 'ignored/SKILL.md'), 'Still ignored.');
  assert.equal(guard.finish('directories'), 1);
  assert.match([...guard.notes].join(), /report-only/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Live change.');
});

test('a worker symlink proposal never reads or overwrites its target and the original skill is restored', t => {
  const f = fixture(t), target = path.join(f.root, 'outside.txt'), probe = path.join(f.root, 'symlink-probe');
  put(target, 'Untouched target.');
  try { fs.symlinkSync(target, probe); fs.unlinkSync(probe); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('File symlink privilege unavailable'); return; } throw error; }
  const guard = new WorkerSkillProposals(f.options, {}, null);
  fs.unlinkSync(f.file); fs.symlinkSync(target, f.file);
  assert.equal(guard.finish('symlink'), 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Untouched target.');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Existing uncommitted contents.\r\n');
  const { proposals } = JSON.parse(fs.readFileSync(`${f.options.out}.skill-proposals-symlink/index.json`));
  assert.equal(proposals[0].symlink, target); assert.equal(proposals[0].content, undefined);
});
