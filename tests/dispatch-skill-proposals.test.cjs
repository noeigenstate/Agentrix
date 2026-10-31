const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkerSkillProposals } = require('../electron/features/skills/worker-proposals.cjs');
const { digest, deliveryMarker } = require('../electron/features/skills/session.cjs');

const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
function fixture(t, allow = ['skills/**']) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-skill-proposals-')));
  const options = { cwd: root, allow, out: path.join(root, 'answer.md') };
  put(path.join(root, 'skills/old/SKILL.md'), 'Existing uncommitted contents.\r\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, options, file: path.join(root, 'skills/old/SKILL.md') };
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

test('trusted delivery roots protect global and built-in skills, unrelated inherited deliveries are ignored', t => {
  const f = fixture(t), external = path.join(f.root, 'managed'), global = path.join(external, 'global/a/SKILL.md'), builtin = path.join(external, 'builtin/a/SKILL.md');
  put(global, 'Global.'); put(builtin, 'Built in.');
  const manifest = path.join(f.root, 'delivery/manifest.md'), fingerprint = digest('manifest'); put(manifest, 'Instructions.');
  put(`${manifest}.json`, JSON.stringify({ projectRoot: f.root, fingerprint, roots: [path.dirname(path.dirname(global)), path.dirname(path.dirname(builtin))] }));
  const note = path.join(f.root, 'note.txt'); put(note, `Note. ${deliveryMarker({ manifest, fingerprint })}`);
  const guard = new WorkerSkillProposals(f.options, { AGENTRIX_READING_NOTE_FILE: note }, null);
  put(global, 'Worker global.'); put(builtin, 'Worker built in.');
  assert.equal(guard.finish('managed'), 2); assert.equal(fs.readFileSync(global, 'utf8'), 'Global.'); assert.equal(fs.readFileSync(builtin, 'utf8'), 'Built in.');
  put(`${manifest}.json`, JSON.stringify({ projectRoot: path.join(f.root, 'unrelated'), fingerprint, roots: [external] }));
  const unrelated = new WorkerSkillProposals(f.options, { AGENTRIX_READING_NOTE_FILE: note }, null);
  put(global, 'Unrelated change.'); assert.equal(unrelated.finish('other'), 0);
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
