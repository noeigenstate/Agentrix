require('./fixtures/team-isolation.cjs');
const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { run } = require('../integration/dispatch.cjs');
const { projectTeam } = require('../electron/features/team/team.cjs');

async function until(predicate) {
  for (let n = 0; n < 600; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Synthetic scope fixture timed out');
}
function boardEvent(t, kind) {
  const watch = fs.watch;
  t.mock.method(fs, 'watch', (directory, listener) => {
    const handle = watch(directory, listener);
    queueMicrotask(() => {
      if (kind === 'replaced') {
        const stat = fs.statSync;
        t.mock.method(fs, 'statSync', (file, options) => {
          const value = stat(file, options);
          return file === directory && options?.bigint ? { ...value, ino: value.ino + 1n } : value;
        });
      }
      listener('change', kind === 'unknown' ? 'gone-peer.json' : kind === 'nameless' ? undefined : path.basename(directory));
    });
    return handle;
  });
}
function fixture(t) {
  const lifetime = resources(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agx-scope-'))), main = path.join(root, 'main'), linked = path.join(root, 'linked');
  fs.mkdirSync(main); fs.writeFileSync(path.join(main, '.gitignore'), '.dispatch/\n');
  for (const name of ['a', 'b']) { fs.mkdirSync(path.join(main, name)); fs.writeFileSync(path.join(main, name, 'base.txt'), 'original'); }
  fs.mkdirSync(path.join(main, 'skills/sample'), { recursive: true });
  fs.writeFileSync(path.join(main, 'skills/sample/SKILL.md'), 'Original skill.');
  const git = args => execFileSync('git', args, { cwd: main, stdio: 'ignore', windowsHide: true });
  git(['init', '-q']); git(['add', '-A']); git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Synthetic fixture']);
  git(['worktree', 'add', '-qb', 'synthetic-linked', linked]);
  const workers = [];
  lifetime.defer('finish scope helpers', async () => {
    for (const worker of workers) { fs.writeFileSync(worker.writeGate, 'go'); fs.writeFileSync(worker.release, 'done'); }
    await Promise.allSettled(workers.map(worker => worker.result));
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  function start(name, allow, writes, cwd = linked) {
    const base = path.join(root, randomUUID()), brief = base + '.md', configFile = base + '.json';
    const config = { sessionId: randomUUID(), writes: writes.map(([file, text]) => [path.join(cwd, file), text]),
      writeGate: base + '.write', written: base + '.written', release: base + '.release' };
    fs.writeFileSync(brief, 'Synthetic task'); fs.writeFileSync(configFile, JSON.stringify(config));
    fs.mkdirSync(path.join(cwd, '.dispatch'), { recursive: true });
    let stdout = '';
    const result = run(['claude', '--role', 'exec', '--title', name, '--model', 'synthetic-model', '--effort', 'high', '--permission', 'acceptEdits',
      '--cwd', cwd, '--brief', brief, '--out', path.join(cwd, '.dispatch', name + '.md'), '--allow', allow, '--skip-meeting', 'Synthetic scope regression'], {
      env: { PATH: '', DISPATCH_SCOPE_FIXTURE: configFile }, stdout: { write: text => { stdout += text; } },
      resolveExecutable: () => ({ file: process.execPath, args: [path.join(__dirname, 'fixtures/codex-app-server-scope.cjs')] }),
      launch: (file, args, options) => lifetime.child(spawn(file, args, options)),
    });
    const worker = { ...config, result, stdout: () => stdout }; workers.push(worker); return worker;
  }
  return { root, main, linked, start };
}

for (const aliasPeer of [false, true]) test('N1: disjoint workers sharing a linked worktree preserve each other even after the peer finishes'
  + (aliasPeer ? ' (Windows short-path canonicalization)' : ''), { timeout: 20000 }, async t => {
  const f = fixture(t), x = f.start('x', 'a/**', [['a/base.txt', 'worker X edit'], ['a/new.txt', 'worker X new']]);
  await until(() => x.stdout().includes('[dispatch] started'));
  let cwd = f.linked;
  if (aliasPeer) {
    cwd = path.join(f.root, 'LINKED~1');
    fs.symlinkSync(f.linked, cwd, process.platform === 'win32' ? 'junction' : 'dir');
    // Reproduce fs.realpathSync retaining an 8.3-style alias while native expands it.
    const original = fs.realpathSync;
    const unresolved = (file, ...args) => path.resolve(file) === cwd ? cwd : original(file, ...args);
    unresolved.native = original.native;
    t.mock.method(fs, 'realpathSync', unresolved);
    assert.notEqual(fs.realpathSync(cwd), fs.realpathSync.native(cwd));
  }
  const y = f.start('y', 'b/**', [['b/base.txt', 'worker Y edit'], ['b/new.txt', 'worker Y new']], cwd);
  await until(() => y.stdout().includes('[dispatch] started'));
  fs.writeFileSync(x.writeGate, 'go'); fs.writeFileSync(y.writeGate, 'go');
  await until(() => fs.existsSync(x.written) && fs.existsSync(y.written));
  fs.writeFileSync(y.release, 'done'); assert.equal(await y.result, 0);
  assert.match(y.stdout(), /OUT OF SCOPE: a\/base.txt, a\/new.txt.*left live/);
  assert.equal(fs.readFileSync(path.join(f.linked, 'a/base.txt'), 'utf8'), 'worker X edit');
  assert.equal(fs.readFileSync(path.join(f.linked, 'a/new.txt'), 'utf8'), 'worker X new');
  fs.writeFileSync(x.release, 'done'); assert.equal(await x.result, 0);
  assert.match(x.stdout(), /OUT OF SCOPE: b\/base.txt, b\/new.txt.*left live/);
  assert.equal(fs.readFileSync(path.join(f.linked, 'b/base.txt'), 'utf8'), 'worker Y edit');
  assert.equal(fs.readFileSync(path.join(f.linked, 'b/new.txt'), 'utf8'), 'worker Y new');
});

test('skill proposal restoration remains active when N1 leaves a peer ordinary edit live', { timeout: 20000 }, async t => {
  const f = fixture(t), x = f.start('x', 'a/**', [['a/base.txt', 'peer edit'], ['a/new.txt', 'peer new file']]);
  await until(() => x.stdout().includes('[dispatch] started'));
  const y = f.start('skill-worker', 'skills/**', [['skills/sample/SKILL.md', 'Unapproved worker proposal.']]);
  await until(() => y.stdout().includes('[dispatch] started'));
  fs.writeFileSync(x.writeGate, 'go'); fs.writeFileSync(y.writeGate, 'go');
  await until(() => fs.existsSync(x.written) && fs.existsSync(y.written));
  fs.writeFileSync(y.release, 'done'); assert.equal(await y.result, 0);
  assert.match(y.stdout(), /OUT OF SCOPE: a\/base.txt, a\/new.txt.*left live/);
  assert.match(y.stdout(), /1 skill proposals restored and awaiting the lead/);
  assert.equal(fs.readFileSync(path.join(f.linked, 'skills/sample/SKILL.md'), 'utf8'), 'Original skill.');
  const proposal = fs.readdirSync(path.join(f.linked, '.dispatch')).find(name => name.startsWith('skill-worker.md.skill-proposals-'));
  assert.equal(fs.readFileSync(path.join(f.linked, '.dispatch', proposal, '1.SKILL.md'), 'utf8'), 'Unapproved worker proposal.');
  assert.equal(fs.readFileSync(path.join(f.linked, 'a/base.txt'), 'utf8'), 'peer edit');
  assert.equal(fs.readFileSync(path.join(f.linked, 'a/new.txt'), 'utf8'), 'peer new file');
  fs.writeFileSync(x.release, 'done'); assert.equal(await x.result, 0);
});

for (const main of [false, true]) test(`N1: exclusive scope violations are quarantined only in a linked worktree (main=${main})`, { timeout: 15000 }, async t => {
  const f = fixture(t), cwd = main ? f.main : f.linked;
  if (!main) boardEvent(t, 'self'); // macOS also reports an event for the watched directory's own inode.
  const worker = f.start('exclusive', 'a/**', [['b/base.txt', 'worker violation'], ['b/new.txt', 'new worker violation']], cwd);
  fs.writeFileSync(worker.writeGate, 'go'); fs.writeFileSync(worker.release, 'done');
  assert.equal(await worker.result, 0); assert.match(worker.stdout(), /OUT OF SCOPE/);
  assert.equal(fs.readFileSync(path.join(cwd, 'b/base.txt'), 'utf8'), main ? 'worker violation' : 'original');
  if (main) assert.equal(fs.readFileSync(path.join(cwd, 'b/new.txt'), 'utf8'), 'new worker violation');
  else {
    const quarantine = worker.stdout().match(/quarantined scope changes: (.*?) ·/)[1];
    assert.equal(fs.readFileSync(path.join(quarantine, 'b/base.txt'), 'utf8'), 'worker violation');
    assert.equal(fs.readFileSync(path.join(quarantine, 'b/new.txt'), 'utf8'), 'new worker violation');
    assert.equal(fs.existsSync(path.join(cwd, 'b/new.txt')), false); assert.match(worker.stdout(), /restored 2/);
  }
});

for (const kind of ['unknown', 'nameless', 'replaced']) test(`N1: ${kind} board evidence still prevents restoration`, async t => {
  const f = fixture(t); boardEvent(t, kind);
  const worker = f.start('uncertain-event', 'a/**', [['b/base.txt', 'unattributed edit']]);
  fs.writeFileSync(worker.writeGate, 'go'); fs.writeFileSync(worker.release, 'done');
  assert.equal(await worker.result, 0); assert.match(worker.stdout(), /OUT OF SCOPE: .*left live/);
  assert.equal(fs.readFileSync(path.join(f.linked, 'b/base.txt'), 'utf8'), 'unattributed edit');
});

test('L4: an owner edit in an exclusive worktree is preserved before restoring the dirty start snapshot', async t => {
  const f = fixture(t), file = path.join(f.linked, 'b/base.txt');
  fs.writeFileSync(file, 'Owner draft before dispatch.');
  const worker = f.start('owner-edit', 'a/**', [['b/base.txt', 'Worker violation.']]);
  fs.writeFileSync(worker.writeGate, 'go'); await until(() => fs.existsSync(worker.written));
  fs.writeFileSync(file, 'Owner edit during dispatch.'); fs.writeFileSync(worker.release, 'done');
  assert.equal(await worker.result, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Owner draft before dispatch.');
  const quarantine = worker.stdout().match(/quarantined scope changes: (.*?) ·/)[1];
  assert.equal(fs.readFileSync(path.join(quarantine, 'b/base.txt'), 'utf8'), 'Owner edit during dispatch.');
  assert.match(worker.stdout(), /restored 1 out-of-scope paths/);
});

test('L4: backup failure leaves the current bytes live instead of overwriting them', async t => {
  const f = fixture(t), file = path.join(f.linked, 'b/base.txt');
  const worker = f.start('backup-failure', 'a/**', [['b/base.txt', 'Current owner bytes.']]);
  fs.writeFileSync(worker.writeGate, 'go'); await until(() => fs.existsSync(worker.written));
  // Use an actual filesystem collision: Windows may give one file both an 8.3 and a long
  // path, so a rename mock comparing path strings can silently miss the backup operation.
  const blocker = path.join(projectTeam(f.linked).directory, 'scope-quarantine');
  fs.writeFileSync(blocker, 'Synthetic backup path blocker.', { flag: 'wx' });
  fs.writeFileSync(worker.release, 'done'); assert.equal(await worker.result, 0);
  assert.match(worker.stdout(), /scope restore failed: .*scope-quarantine/);
  assert.match(worker.stdout(), /OUT OF SCOPE: b\/base.txt/);
  assert.doesNotMatch(worker.stdout(), /restored 1 out-of-scope paths/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Current owner bytes.');
  assert.equal(fs.readFileSync(blocker, 'utf8'), 'Synthetic backup path blocker.');
  assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.startsWith('.dispatch-restore-')), false);
});

test('N1: unavailable board history makes a linked worktree report-only', { timeout: 15000 }, async t => {
  const f = fixture(t);
  t.mock.method(fs, 'watch', () => { throw new Error('Synthetic watcher unavailable'); });
  const worker = f.start('uncertain', 'a/**', [['b/base.txt', 'uncertain author edit'], ['b/new.txt', 'uncertain author new']]);
  fs.writeFileSync(worker.writeGate, 'go'); fs.writeFileSync(worker.release, 'done');
  assert.equal(await worker.result, 0); assert.match(worker.stdout(), /OUT OF SCOPE: .*left live/);
  assert.equal(fs.readFileSync(path.join(f.linked, 'b/base.txt'), 'utf8'), 'uncertain author edit');
  assert.equal(fs.readFileSync(path.join(f.linked, 'b/new.txt'), 'utf8'), 'uncertain author new');
});
