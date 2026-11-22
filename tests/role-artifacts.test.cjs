const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRoleArtifacts, stampRoleArtifacts, trackRoleProcess, sweepRoleArtifacts, RETENTION, ORPHAN_RETENTION } = require('../integration/role-artifacts.cjs');
const { createRoleTools } = require('../integration/role-tools.cjs');
const { startDetached } = require('../integration/dispatch.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agx-artifacts-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'temp');
  await fs.mkdir(root);
  return { directory, root };
}

test('role cleanup protects live folders and retained unread answers, and caps read answers oldest first', async t => {
  const { root } = await fixture(t);
  const now = RETENTION * 2;
  const active = await createRoleArtifacts(root);
  const [expired, unread, oldestRead, newestRead] = await Promise.all(Array.from({ length: 4 }, () => createRoleArtifacts(root)));
  for (const [role, ended] of [[expired, now - RETENTION], [unread, now - 3], [oldestRead, now - 2], [newestRead, now - 1]]) {
    await stampRoleArtifacts(role, 'ended', ended);
  }
  await stampRoleArtifacts(oldestRead, 'read');
  await stampRoleArtifacts(newestRead, 'read');
  await sweepRoleArtifacts(root, { now, maxFolders: 3 });
  assert.deepEqual((await fs.readdir(root)).sort(), [active, unread, newestRead].map(role => path.basename(role.folder)).sort());
});

test('cleanup ignores unmarked folders and junctions, and backs off a locked artifact across sweeps', async t => {
  const { directory, root } = await fixture(t);
  const outside = await createRoleArtifacts(directory);
  await stampRoleArtifacts(outside, 'ended', 1);
  const log = path.join(outside.folder, 'untouched.log');
  await fs.writeFile(log, 'outside the sweep');
  const directoryLink = path.join(root, 'agentrix-role-linked');
  await fs.symlink(outside.folder, directoryLink, process.platform === 'win32' ? 'junction' : 'dir');
  const legacy = path.join(root, 'agentrix-role-legacy');
  await fs.mkdir(legacy);
  const ended = await createRoleArtifacts(root);
  await stampRoleArtifacts(ended, 'ended', 1);
  await fs.mkdir(path.join(ended.folder, 'nested'));
  await fs.symlink(outside.folder, path.join(ended.folder, 'nested', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const now = RETENTION + 1;
  await sweepRoleArtifacts(root, { now, remove: async () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); } });
  assert.ok((await fs.stat(ended.folder)).isDirectory());
  await sweepRoleArtifacts(root, { now });
  assert.ok((await fs.stat(ended.folder)).isDirectory());
  await sweepRoleArtifacts(root, { now: now + 60000 });
  assert.deepEqual((await fs.readdir(root)).sort(), [legacy, directoryLink].map(folder => path.basename(folder)).sort());
  assert.equal(await fs.readFile(log, 'utf8'), 'outside the sweep');
});

test('the cleanup limit counts removals, and old marked folders survive while their recorded process is alive', async t => {
  const { root } = await fixture(t);
  const roles = await Promise.all(Array.from({ length: 34 }, () => createRoleArtifacts(root)));
  for (const [index, role] of roles.entries()) {
    await fs.writeFile(path.join(role.folder, 'answer.md'), 'answer');
    await stampRoleArtifacts(role, 'ended', index + 1);
  }
  const live = await createRoleArtifacts(root), unstarted = await createRoleArtifacts(root);
  trackRoleProcess(live, process.pid);
  const now = Date.now() + ORPHAN_RETENTION + 1000;
  let failures = 0;
  await sweepRoleArtifacts(root, { now, remove: async (file, options) => {
    if (path.dirname(file) === roles[0].folder) { failures++; throw new Error('locked'); }
    await fs.rm(file, options);
  } });
  assert.deepEqual((await fs.readdir(root)).sort(), [roles[0], roles[33], live, unstarted].map(role => path.basename(role.folder)).sort());
  await sweepRoleArtifacts(root, { now, remove: async (file, options) => {
    assert.notEqual(path.dirname(file), roles[0].folder);
    await fs.rm(file, options);
  } });
  assert.equal(failures, 1);
  assert.deepEqual((await fs.readdir(root)).sort(), [roles[0], live].map(role => path.basename(role.folder)).sort());
});

test('shared temp cleanup refuses a foreign owner or writable mode and checks mode again before removal', { skip: !process.getuid }, async t => {
  const { root } = await fixture(t);
  const [unsafe, changed] = await Promise.all([createRoleArtifacts(root), createRoleArtifacts(root)]);
  for (const role of [unsafe, changed]) await stampRoleArtifacts(role, 'ended', 1);
  await fs.chmod(unsafe.folder, 0o722);
  const getuid = process.getuid;
  t.mock.method(process, 'getuid', () => getuid() + 1);
  await sweepRoleArtifacts(root, { now: RETENTION + 1 });
  assert.ok((await fs.stat(changed.folder)).isDirectory());
  t.mock.restoreAll();
  await fs.writeFile(path.join(changed.folder, 'answer.md'), 'answer');
  await sweepRoleArtifacts(root, { now: RETENTION + 1, remove: async (file, options) => {
    assert.equal(path.dirname(file), changed.folder);
    await fs.rm(file, options);
    await fs.chmod(changed.folder, 0o722);
  } });
  assert.ok((await fs.stat(unsafe.folder)).isDirectory());
  assert.ok((await fs.stat(changed.folder)).isDirectory());
});

for (const expired of [false, true]) test(`role_result explains removal by ${expired ? 'age' : 'the folder cap'}`, async t => {
  const { directory, root } = await fixture(t);
  const bootstrap = path.join(directory, 'boot.json');
  await fs.writeFile(bootstrap + '.mode', 'conductor');
  await fs.writeFile(bootstrap + '.seats', JSON.stringify({ developer: { model: 'opus', effort: 'high' } }));
  let now = Date.now();
  const { tools } = createRoleTools({ env: { AGENTRIX_BOOTSTRAP: bootstrap }, cwd: directory, tempRoot: root, now: () => now,
    engine: async (args, { stdout, roleArtifacts }) => {
      if (args.includes('--detach')) {
        await fs.writeFile(path.join(roleArtifacts.folder, 'answer.md'), 'result');
        await stampRoleArtifacts(roleArtifacts, 'ended', now - 1);
        stdout.write('[dispatch] started synthetic claude\n');
      } else stdout.write('[dispatch] ended synthetic exit 0\n');
    } });
  const { id } = await tools.start_role({ seat: 'developer', title: 'Read files', brief: 'Read the docs', readOnly: true });
  await sweepRoleArtifacts(root, { now, maxFolders: 0 });
  assert.equal((await fs.readdir(root)).length, 1);
  assert.equal((await tools.role_result({ id })).answer, 'result');
  if (expired) now += RETENTION + 1000;
  await sweepRoleArtifacts(root, { now, maxFolders: expired ? 256 : 0 });
  assert.deepEqual(await fs.readdir(root), []);
  const removed = await tools.role_result({ id });
  assert.equal(removed.answer, expired ? 'Answer removed by cleanup after 7 days.' : 'Answer removed by cleanup to make room for newer role folders.');
  assert.equal(removed.answerRemoved, true);
});

test('a detached launch rejected before a helper exists can expire without a receipt', async t => {
  const { root } = await fixture(t);
  const roleArtifacts = await createRoleArtifacts(root);
  await assert.rejects(startDetached(['codex', '--detach'], { env: {}, roleArtifacts, launch: () => assert.fail('invalid launch') }));
  await sweepRoleArtifacts(root, { now: Date.now() + RETENTION });
  assert.deepEqual(await fs.readdir(root), []);
});
