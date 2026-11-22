const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRoleArtifacts, stampRoleArtifacts, sweepRoleArtifacts, RETENTION } = require('../integration/role-artifacts.cjs');
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

test('cleanup ignores unmarked folders and junctions, and retries a locked artifact next time', async t => {
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
  await fs.symlink(outside.folder, path.join(ended.folder, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  const now = RETENTION + 1;
  await sweepRoleArtifacts(root, { now, remove: async () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); } });
  assert.ok((await fs.stat(ended.folder)).isDirectory());
  await sweepRoleArtifacts(root, { now });
  assert.deepEqual((await fs.readdir(root)).sort(), [legacy, directoryLink].map(folder => path.basename(folder)).sort());
  assert.equal(await fs.readFile(log, 'utf8'), 'outside the sweep');
});

test('a successful role_result makes the retained answer eligible for the count cap', async t => {
  const { directory, root } = await fixture(t);
  const bootstrap = path.join(directory, 'boot.json');
  await fs.writeFile(bootstrap + '.mode', 'conductor');
  await fs.writeFile(bootstrap + '.seats', JSON.stringify({ developer: { model: 'opus', effort: 'high' } }));
  const now = RETENTION * 2;
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
  await sweepRoleArtifacts(root, { now, maxFolders: 0 });
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal((await tools.role_result({ id })).answer, null);
});

test('a detached launch rejected before a helper exists can expire without a receipt', async t => {
  const { root } = await fixture(t);
  const roleArtifacts = await createRoleArtifacts(root);
  await assert.rejects(startDetached(['codex', '--detach'], { env: {}, roleArtifacts, launch: () => assert.fail('invalid launch') }));
  await sweepRoleArtifacts(root, { now: Date.now() + RETENTION });
  assert.deepEqual(await fs.readdir(root), []);
});
