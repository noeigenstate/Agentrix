const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SkillsStore } = require('../electron/features/skills/store.cjs');
const { skillInstructions } = require('../electron/features/skills/delivery.cjs');

const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const user = (name, text = 'User procedure.') => `---\nname: ${name}\ndescription: Use when testing.\n---\n${text}`;
const builtin = name => `---\nname: ${name}\ndescription: Use when testing the system procedure.\ntrigger: always\nwhen: 每个任务开始前\nrequires: none\ntitle: 示例技能\nsummary: 执行系统规则。\n---\n# System procedure\n\n## When this applies\n\nUse before testing.\n\n## What to do\n\n1. Follow the procedure.\n\n## Rules\n\n- Preserve behavior.\n\n## Done when\n\n- The checks pass.\n`;
const guardMessage = name => `与系统技能「${name}」同名。要扩展它，请命名为 ${name}-<标识>，例如 ${name}-team。`;

function fixture(t, setup = () => {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-skill-replace-')));
  const project = { id: '../../unsafe/project', name: 'Synthetic project', path: path.join(root, 'project') };
  const options = { dataDir: path.join(root, 'profile'), builtinDir: path.join(root, 'builtins'), getProjects: () => [project] };
  fs.mkdirSync(project.path); put(path.join(options.builtinDir, 'standard/SKILL.md'), builtin('standard'));
  setup({ root, project, options });
  const errors = [], store = new SkillsStore({ ...options, report: error => errors.push(error) });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, project, options, errors, store, info: () => store.info(store.entry('builtin:standard')) };
}

test('identical and different same-name copies, including empty folders, move from all three locations', t => {
  const f = fixture(t, ({ project }) => {
    put(path.join(project.path, 'skills/standard/SKILL.md'), builtin('standard'));
    put(path.join(project.path, '.claude/skills/standard/SKILL.md'), user('standard', 'Different contents.'));
    fs.mkdirSync(path.join(project.path, '.codex/skills/standard'), { recursive: true });
  });
  const records = f.info().replaced;
  assert.equal(records.length, 3); assert.equal(f.errors.length, 0);
  assert.deepEqual(records.map(record => record.from).sort(), ['.claude/skills/standard', '.codex/skills/standard', 'skills/standard']);
  for (const record of records) {
    assert.equal(record.project, f.project.name); assert.equal(record.name, 'standard');
    assert.equal(path.isAbsolute(record.backup), true); assert.equal(Number.isFinite(record.at), true);
    assert.ok(path.relative(path.join(f.options.dataDir, 'skill-replaced'), record.backup).match(/^[a-f0-9]{32}[/\\]standard-/));
    assert.equal(fs.existsSync(path.join(f.project.path, record.from)), false);
    assert.equal(fs.statSync(record.backup).isDirectory(), true);
  }
  assert.equal(fs.readFileSync(path.join(records.find(record => record.from === 'skills/standard').backup, 'SKILL.md'), 'utf8'), builtin('standard'));
  assert.deepEqual(f.store.delivery(f.project).skills.map(skill => skill.id), ['builtin:standard']);
});

for (const type of process.platform === 'win32' ? ['junction', 'dir'] : ['dir']) test(`${type} same-name links move as links and leave their targets intact`, t => {
  const f = fixture(t), target = path.join(f.root, 'target'), link = path.join(f.project.path, '.claude/skills/standard');
  put(path.join(target, 'SKILL.md'), 'Target must survive.'); fs.mkdirSync(path.dirname(link), { recursive: true });
  try { fs.symlinkSync(target, link, type); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Directory symlink privilege unavailable'); return; } throw error; }
  f.store.refresh();
  assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
  assert.equal(fs.lstatSync(f.info().replaced[0].backup).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'Target must survive.');
});

test('linked skill parents are never followed into another project', t => {
  const f = fixture(t), target = path.join(f.root, 'outside'), link = path.join(f.project.path, '.codex');
  put(path.join(target, 'skills/standard/SKILL.md'), 'Outside copy.');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  f.store.refresh();
  assert.equal(fs.readFileSync(path.join(target, 'skills/standard/SKILL.md'), 'utf8'), 'Outside copy.');
  assert.deepEqual(f.info().replaced, []);
});

test('project metadata polling never reads through a leaf link or a linked .claude parent', async t => {
  const f = fixture(t), target = path.join(f.root, 'target'), parent = path.join(f.project.path, '.claude');
  put(path.join(target, 'skills/standard/SKILL.md'), 'Outside metadata.');
  fs.symlinkSync(target, parent, process.platform === 'win32' ? 'junction' : 'dir');
  const { projectSkillSignature } = require('../electron/features/skills/project-skills.cjs');
  const readdir = fs.promises.readdir;
  t.mock.method(fs.promises, 'readdir', (file, ...args) => {
    if (file.startsWith(parent)) throw new Error('Must not traverse a linked project parent');
    return readdir(file, ...args);
  });
  assert.equal(await projectSkillSignature(path.join(parent, 'skills')), 'linked parent');
  const link = path.join(f.project.path, 'skills/standard'); fs.mkdirSync(path.dirname(link));
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const signature = await projectSkillSignature(path.dirname(link));
  assert.match(signature, /standard.*link/);
});

test('replacement history persists, caps at the latest 20, and never removes old backups', t => {
  const f = fixture(t), backups = [];
  for (let i = 0; i < 23; i++) {
    put(path.join(f.project.path, 'skills/standard/asset.txt'), String(i)); f.store.refresh();
    backups.push(f.info().replaced[0].backup);
  }
  assert.equal(f.info().replaced.length, 20);
  assert.equal(fs.readFileSync(path.join(f.info().replaced[0].backup, 'asset.txt'), 'utf8'), '22');
  assert.equal(new Set(backups).size, 23); assert.ok(backups.every(file => fs.existsSync(file)));
  f.store.close(); const reopened = new SkillsStore(f.options); t.after(() => reopened.close());
  assert.deepEqual(reopened.info(reopened.entry('builtin:standard')).replaced, f.info().replaced);
});

test('cross-volume replacement copies the whole folder before removing the original', t => {
  const f = fixture(t), copy = path.join(f.project.path, 'skills/standard');
  put(path.join(copy, 'nested/asset.txt'), 'Cross-volume contents.');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, ...args) => {
    if (from === copy) throw Object.assign(new Error('Synthetic volume boundary'), { code: 'EXDEV' });
    return rename(from, ...args);
  });
  f.store.refresh();
  assert.equal(fs.existsSync(copy), false); assert.equal(f.errors.length, 0);
  assert.equal(fs.readFileSync(path.join(f.info().replaced[0].backup, 'nested/asset.txt'), 'utf8'), 'Cross-volume contents.');
});

test('move failures leave the copy, report once, and do not suppress the built-in', t => {
  const f = fixture(t), copy = path.join(f.project.path, 'skills/standard');
  put(path.join(copy, 'SKILL.md'), user('standard'));
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, ...args) => {
    if (from === copy) throw Object.assign(new Error('Synthetic locked copy'), { code: 'EPERM' });
    return rename(from, ...args);
  });
  for (let i = 0; i < 3; i++) f.store.refresh();
  assert.equal(f.errors.length, 1); assert.deepEqual(f.info().replaced, []);
  assert.equal(fs.existsSync(copy), true);
  assert.deepEqual(f.store.delivery(f.project).skills.map(skill => skill.id), ['builtin:standard']);
  mock.mock.restore(); f.store.refresh(); assert.equal(f.info().replaced.length, 1);
});

test('a linked backup root cannot redirect a replacement or create folders in its target', t => {
  const f = fixture(t), target = path.join(f.root, 'outside-backups'); fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(f.options.dataDir, 'skill-replaced'), process.platform === 'win32' ? 'junction' : 'dir');
  put(path.join(f.project.path, 'skills/standard/SKILL.md'), user('standard'));
  f.store.refresh(); f.store.refresh();
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.existsSync(path.join(f.project.path, 'skills/standard/SKILL.md')), true);
  assert.equal(f.errors.length, 1); assert.deepEqual(f.info().replaced, []);
});

test('extensions keep their contents and follow the longest matching base in local and SSH delivery', async t => {
  const f = fixture(t, ({ options, project }) => {
    put(path.join(options.builtinDir, 'standard-code/SKILL.md'), builtin('standard-code'));
    put(path.join(project.path, 'skills/standard-code-team/SKILL.md'), user('standard-code-team'));
  });
  await f.store.save(null, { name: 'standard-brand', description: 'Brand additions.', text: 'Brand rules.', scope: 'global', projectId: null });
  const extension = f.store.list().find(skill => skill.name === 'standard-code-team');
  assert.equal(extension.extends, 'standard-code'); assert.deepEqual(extension.replaced, []);
  assert.equal(fs.existsSync(extension.path), true); assert.deepEqual(f.info().replaced, []);
  for (const remote of [false, true]) {
    const delivery = f.store.delivery(f.project, remote), names = delivery.skills.map(skill => skill.name);
    assert.equal(names.indexOf('standard-brand'), names.indexOf('standard') + 1);
    if (!remote) assert.equal(names.indexOf('standard-code-team'), names.indexOf('standard-code') + 1);
    const instructions = remote ? delivery.bundle.instructions : skillInstructions(delivery);
    assert.ok(instructions.includes("follow standard first, then this extension's additions; where they conflict, the system skill wins."));
    assert.ok(instructions.includes('When creating a user skill, never reuse a built-in name'));
  }
});

test('SSH never bundles an extension whose system base was omitted by the size limit', async t => {
  const f = fixture(t, ({ options }) => {
    put(path.join(options.builtinDir, 'a-large/SKILL.md'), builtin('a-large') + 'x'.repeat(420 * 1024));
    put(path.join(options.builtinDir, 'standard/SKILL.md'), builtin('standard') + 'x'.repeat(120 * 1024));
  });
  await f.store.save(null, { name: 'standard-team', description: 'Team additions.', text: 'Team rules.', scope: 'global', projectId: null });
  const delivery = f.store.delivery(f.project, true);
  assert.deepEqual(delivery.skills.map(skill => skill.name), ['a-large']);
  assert.match(delivery.bundle.instructions, /2 enabled skills were omitted/);
});

test('save, rename, import and pending worker proposals refuse a built-in name with the exact message', async t => {
  const f = fixture(t), draft = { name: 'standard', description: 'Collision.', text: 'Text.', scope: 'global', projectId: null };
  for (const scope of ['global', 'project']) await assert.rejects(f.store.save(null, { ...draft, scope, projectId: scope === 'project' ? f.project.id : null }), { message: guardMessage('standard') });
  const saved = await f.store.save(null, { ...draft, name: 'other' });
  await assert.rejects(f.store.save(saved.id, draft), { message: guardMessage('standard') });
  const imported = path.join(f.root, 'imported'); put(path.join(imported, 'SKILL.md'), user('standard'));
  await assert.rejects(f.store.import(imported, 'global', null), { message: guardMessage('standard') });
  put(f.store.pendingPath(f.store.entry(saved.id)), user('standard'));
  const original = f.store.read(saved.id).text;
  assert.throws(() => f.store.resolveChange(saved.id, true), { message: guardMessage('standard') });
  assert.equal(f.store.read(saved.id).text, original);
});

test('a legacy global collision stays available for renaming but never overrides the built-in', async t => {
  const f = fixture(t, ({ options }) => put(path.join(options.dataDir, 'skills/standard/SKILL.md'), user('standard', 'Legacy global contents.')));
  assert.ok(f.store.list().some(skill => skill.id === 'user:standard'));
  assert.deepEqual(f.store.delivery(f.project).skills.map(skill => skill.id), ['builtin:standard']);
  assert.deepEqual(f.store.delivery(f.project, true).skills.map(skill => skill.id), ['builtin:standard']);
  const renamed = await f.store.save('user:standard', { name: 'standard-team', description: 'Migrated additions.', text: f.store.read('user:standard').text, scope: 'global', projectId: null });
  assert.equal(renamed.extends, 'standard'); assert.match(f.store.read(renamed.id).text, /Legacy global contents/);
  assert.deepEqual(f.info().replaced, [], 'only project copies are automatically moved');
});
