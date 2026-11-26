const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WorkerSkillProposals } = require('../electron/features/skills/worker-proposals.cjs');
const { digest, deliveryMarker } = require('../electron/features/skills/session.cjs');

const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const archived = guard => JSON.parse(fs.readFileSync(guard.details.indexPath, 'utf8')).proposals;
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
  t.after(async () => { await fs.promises.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const env = { AGENTRIX_DATA_DIR: path.join(parent, 'profile') };
  return { root, main, parent, options, env, file: path.join(root, 'skills/old/SKILL.md') };
}

test('broad scope restores edited/new/deleted skills and archives worker versions outside the checkout', t => {
  const f = fixture(t);
  const removed = path.join(f.root, 'skills/removed/SKILL.md'), added = path.join(f.root, 'skills/new/SKILL.md');
  put(removed, 'Original removed file.');
  const guard = new WorkerSkillProposals(f.options, f.env, null);
  put(f.file, 'Worker version.'); fs.unlinkSync(removed); put(added, 'New skill.');
  assert.equal(guard.finish('run'), 3); assert.equal(guard.finish('run'), 3, 'recovery is idempotent');
  assert.equal(guard.restoredCount, 3);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Existing uncommitted contents.\r\n');
  assert.equal(fs.readFileSync(removed, 'utf8'), 'Original removed file.'); assert.equal(fs.existsSync(added), false);
  const proposals = archived(guard);
  assert.ok(guard.details.indexPath.startsWith(f.env.AGENTRIX_DATA_DIR + path.sep));
  assert.deepEqual(proposals.map(({ operation, text }) => [operation, text]).sort(),
    [['create', 'New skill.'], ['delete', 'Original removed file.'], ['edit', 'Worker version.']]);
  assert.deepEqual(proposals.map(p => p.operation).sort(), ['create', 'delete', 'edit']);
  assert.ok(proposals.some(p => p.operation === 'edit' && fs.readFileSync(p.savedPath, 'utf8') === 'Worker version.'));
});

test('only a literal approved SKILL.md path can remain changed', t => {
  const f = fixture(t, ['skills/old/SKILL.md', 'skills/*/SKILL.md']);
  const other = path.join(f.root, 'skills/other/SKILL.md'); put(other, 'Other original.');
  const guard = new WorkerSkillProposals(f.options, f.env, null);
  put(f.file, 'Approved.'); put(other, 'Unapproved.');
  assert.equal(guard.finish('run'), 1); assert.equal(fs.readFileSync(f.file, 'utf8'), 'Approved.');
  assert.equal(fs.readFileSync(other, 'utf8'), 'Other original.');
});

for (const allow of [['skills/**'], ['skills/standard/SKILL.md']]) test(`same-name user skill proposals are rejected with ${allow[0]} while preserving their versions`, t => {
  const f = fixture(t, allow), builtinRoot = path.join(f.parent, 'builtins'), globalRoot = path.join(f.parent, 'global');
  put(path.join(builtinRoot, 'standard/SKILL.md'), 'System rules.');
  const manifest = path.join(f.root, 'delivery/manifest.md'), fingerprint = digest('reserved-names'); put(manifest, 'Instructions.');
  put(`${manifest}.json`, JSON.stringify({ projectRoot: f.root, fingerprint, roots: [builtinRoot, globalRoot], builtinRoot, builtinNames: ['standard'] }));
  const guard = new WorkerSkillProposals(f.options, { ...f.env, AGENTRIX_READING_NOTE: `Note. ${deliveryMarker({ manifest, fingerprint })}` }, null);
  const collision = path.join(f.root, 'skills/standard/SKILL.md');
  put(collision, '---\nname: standard\ndescription: A collision.\n---\nWorker text.');
  assert.equal(guard.finish('collision'), 1);
  const proposals = archived(guard);
  assert.equal(proposals[0].rejected, true);
  assert.equal(proposals[0].error, '与系统技能「standard」同名。要扩展它，请命名为 standard-<标识>，例如 standard-team。');
  assert.equal(fs.existsSync(collision), false);
  assert.match(fs.readFileSync(proposals[0].savedPath, 'utf8'), /Worker text/);
  assert.ok(guard.notes.has(proposals[0].error));
});

test('the user-name guard does not reject an explicitly approved shipped skill source', t => {
  const f = fixture(t, ['resources/skills/standard/SKILL.md']), file = path.join(f.root, 'resources/skills/standard/SKILL.md');
  put(file, '---\nname: standard\n---\nOriginal system source.');
  const builtinRoot = path.join(f.parent, 'shipped'), globalRoot = path.join(f.parent, 'global');
  const manifest = path.join(f.root, 'delivery/manifest.md'), fingerprint = digest('system-source'); put(manifest, 'Instructions.');
  put(`${manifest}.json`, JSON.stringify({ projectRoot: f.root, fingerprint, roots: [builtinRoot, globalRoot], builtinRoot, builtinNames: ['standard'] }));
  const guard = new WorkerSkillProposals(f.options, { ...f.env, AGENTRIX_READING_NOTE: `Note. ${deliveryMarker({ manifest, fingerprint })}` });
  put(file, '---\nname: standard\n---\nApproved system update.');
  assert.equal(guard.finish('system'), 0);
  assert.match(fs.readFileSync(file, 'utf8'), /Approved system update/);
});

test('an approved user skill with a case-changed or escaped built-in name is still rejected', t => {
  const f = fixture(t, ['skills/old/SKILL.md', 'skills/other/SKILL.md']);
  const builtinRoot = path.join(f.parent, 'shipped');
  const manifest = path.join(f.root, 'delivery/manifest.md'), fingerprint = digest('escaped-names'); put(manifest, 'Instructions.');
  put(`${manifest}.json`, JSON.stringify({ projectRoot: f.root, fingerprint, roots: [builtinRoot], builtinRoot, builtinNames: ['standard'] }));
  const guard = new WorkerSkillProposals(f.options, { ...f.env, AGENTRIX_READING_NOTE: `Note. ${deliveryMarker({ manifest, fingerprint })}` });
  put(f.file, '---\nname: Standard\n---\nChanged.');
  const other = path.join(f.root, 'skills/other/SKILL.md');
  put(other, '---\nname: "\\u0073tandard"\n---\nChanged.');
  assert.equal(guard.finish('names'), 2);
  const proposals = archived(guard);
  assert.ok(proposals.every(proposal => proposal.rejected && proposal.restored));
  assert.equal(fs.existsSync(other), false);
});

test('concurrent owner edits to global and built-in skills are report-only, unrelated inherited deliveries are ignored', t => {
  const f = fixture(t), external = path.join(f.root, 'managed'), global = path.join(external, 'global/a/SKILL.md'), builtin = path.join(external, 'builtin/a/SKILL.md');
  put(global, 'Global.'); put(builtin, 'Built in.');
  const manifest = path.join(f.root, 'delivery/manifest.md'), fingerprint = digest('manifest'); put(manifest, 'Instructions.');
  put(`${manifest}.json`, JSON.stringify({ projectRoot: f.root, fingerprint, roots: [path.dirname(path.dirname(global)), path.dirname(path.dirname(builtin))] }));
  const note = path.join(f.root, 'note.txt'); put(note, `Note. ${deliveryMarker({ manifest, fingerprint })}`);
  const guard = new WorkerSkillProposals(f.options, { ...f.env, AGENTRIX_READING_NOTE_FILE: note }, null);
  put(global, 'Owner saved global.'); put(builtin, 'App updated built in.');
  assert.equal(guard.finish('managed'), 2); assert.equal(fs.readFileSync(global, 'utf8'), 'Owner saved global.'); assert.equal(fs.readFileSync(builtin, 'utf8'), 'App updated built in.');
  assert.equal(guard.restoredCount, 0);
  const proposals = archived(guard);
  assert.ok(proposals.every(p => !p.restored && p.note === 'changed during the run, author unknown'));
  assert.deepEqual(proposals.map(p => fs.readFileSync(p.savedPath, 'utf8')).sort(), ['App updated built in.', 'Owner saved global.']);
  put(`${manifest}.json`, JSON.stringify({ projectRoot: path.join(f.root, 'unrelated'), fingerprint, roots: [external] }));
  const unrelated = new WorkerSkillProposals(f.options, { ...f.env, AGENTRIX_READING_NOTE_FILE: note }, null);
  put(global, 'Unrelated change.'); assert.equal(unrelated.finish('other'), 0);
});

test('concurrent lead edits in a shared checkout are preserved and reported with unknown authorship', t => {
  const f = fixture(t, ['skills/**'], false), guard = new WorkerSkillProposals(f.options, f.env);
  put(f.file, 'Lead live version.');
  assert.equal(guard.finish('shared'), 1);
  assert.equal(guard.restoredCount, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Lead live version.');
  const proposals = archived(guard);
  assert.equal(proposals[0].note, 'changed during the run, author unknown');
  assert.equal(proposals[0].restored, false);
  assert.equal(fs.readFileSync(proposals[0].savedPath, 'utf8'), 'Lead live version.');
});

test('mixed project proposals and managed changes count only the restored versions as awaiting the lead', t => {
  const f = fixture(t), managed = path.join(f.parent, 'managed'), global = path.join(managed, 'sample/SKILL.md');
  put(global, 'Owner original.');
  const manifest = path.join(f.root, 'delivery/manifest.md'), fingerprint = digest('mixed'); put(manifest, 'Instructions.');
  put(`${manifest}.json`, JSON.stringify({ projectRoot: f.root, fingerprint, roots: [managed] }));
  const guard = new WorkerSkillProposals(f.options, { ...f.env, AGENTRIX_READING_NOTE: `Note. ${deliveryMarker({ manifest, fingerprint })}` });
  put(f.file, 'Worker proposal.'); put(global, 'Owner live change.');
  assert.equal(guard.finish('mixed'), 2);
  assert.equal(guard.restoredCount, 1);
  assert.equal(guard.finish('mixed') - guard.restoredCount, 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Existing uncommitted contents.\r\n');
  assert.equal(fs.readFileSync(global, 'utf8'), 'Owner live change.');
});

test('snapshot size limits degrade to report-only and preserve large proposals without blocking a worker', t => {
  const f = fixture(t); put(f.file, 'x'.repeat(512 * 1024 + 1));
  const guard = new WorkerSkillProposals(f.options, f.env);
  put(f.file, 'y'.repeat(512 * 1024 + 1));
  assert.equal(guard.finish('large'), 1);
  assert.match([...guard.notes].join(), /report-only: snapshot limits exceeded/);
  assert.equal(fs.readFileSync(f.file, 'utf8')[0], 'y');
  const [proposal] = archived(guard);
  assert.equal(fs.statSync(proposal.savedPath).size, 512 * 1024 + 1);
  assert.equal(proposal.text, 'y'.repeat(2048));
  assert.equal(proposal.truncated, true);
});

test('skill scans skip node_modules and .git, directory limits leave live files untouched', t => {
  const f = fixture(t);
  for (const name of ['node_modules', '.git']) put(path.join(f.root, 'skills', name, 'ignored/SKILL.md'), 'Ignored.');
  const realReaddir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (folder, options) => folder === path.join(f.root, 'skills')
    ? [...realReaddir(folder, options), ...Array.from({ length: 8193 }, (_, i) => ({ name: `missing-${i}`, isDirectory: () => true, isSymbolicLink: () => false }))]
    : realReaddir(folder, options));
  const guard = new WorkerSkillProposals(f.options, f.env);
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
  const guard = new WorkerSkillProposals(f.options, f.env, null);
  fs.unlinkSync(f.file); fs.symlinkSync(target, f.file);
  assert.equal(guard.finish('symlink'), 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Untouched target.');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Existing uncommitted contents.\r\n');
  const proposals = archived(guard);
  assert.equal(proposals[0].symlink, target); assert.equal(proposals[0].content, undefined);
});

test('proposal storage uses the local bootstrap profile and the remote account home for SSH', t => {
  const f = fixture(t);
  const profile = path.join(f.parent, 'profile'), home = path.join(f.parent, 'home');
  const env = { AGENTRIX_BOOTSTRAP: path.join(profile, 'runtime-abc123', 'terminal.json'), HOME: home, USERPROFILE: home };
  put(env.AGENTRIX_BOOTSTRAP, '{}');
  fs.mkdirSync(home);
  for (const [variables, expected] of [[env, profile], [{ ...env, AGENTRIX_BOOTSTRAP: '', AGENTRIX_DATA_DIR: f.root }, path.join(home, '.agentrix')],
    [{ ...env, AGENTRIX_REMOTE_ROLE_TOOLS: '1' }, path.join(home, '.agentrix')]]) {
    const guard = new WorkerSkillProposals(f.options, variables, null);
    put(f.file, 'Worker proposal.');
    assert.equal(guard.finish('storage'), 1);
    assert.ok(guard.details.indexPath.startsWith(path.join(expected, 'skill-proposals') + path.sep));
  }
  assert.equal(fs.existsSync(path.join(f.root, 'skill-proposals')), false);
});

test('the archive keeps only the 20 newest batches for each project', t => {
  const f = fixture(t, ['skills/**'], false), other = fixture(t, ['skills/**'], false);
  const save = (fixture, version) => {
    const guard = new WorkerSkillProposals(fixture.options, f.env, null);
    put(fixture.file, version);
    assert.equal(guard.finish(version), 1);
    return guard.details.indexPath;
  };
  const separate = save(other, 'Other project');
  const indexes = [];
  for (let n = 0; n <= 20; n++) {
    const index = save(f, `Version ${n}`);
    const time = new Date(Date.now() - (21 - n) * 1000);
    fs.utimesSync(index, time, time);
    indexes.push(index);
  }
  assert.equal(fs.existsSync(indexes[0]), false);
  for (const index of [...indexes.slice(1), separate]) assert.ok(fs.existsSync(index), index);
});
