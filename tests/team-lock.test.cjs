const { loadWithStubs } = require('./helpers/load-with-stubs.cjs');
require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Load the real Team with private fs wrappers and a clock advanced only by the retry wait; no Git or child processes.
function fixture(t, { platform = 'win32', errorAt = () => null, advance = 25, markerError } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'team-lock-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, 'agentrix', 'lock'), calls = { markers: 0, waits: 0, renames: 0, actions: 0 };
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const injected = { ...fs,
    openSync(file, flags, ...args) {
      if (!path.dirname(file).startsWith(lock + '.')) return fs.openSync(file, flags, ...args);
      assert.equal(flags, 'wx');
      calls.markers++;
      if (markerError) throw markerError;
      return fs.openSync(file, flags, ...args);
    },
    renameSync(from, to) {
      assert.equal(to, lock);
      assert.equal(fs.readdirSync(from).length, 1, 'publication requires an owner marker');
      const code = errorAt(++calls.renames);
      if (code) throw Object.assign(new Error('Injected lock publication failure'), { code });
      return fs.renameSync(from, to);
    },
  };
  const replacements = {
    'node:fs': injected,
    'node:process': { platform, pid: process.pid, env: {} },
    'node:child_process': { execFileSync: () => assert.fail('lock unit tests must not run Git') },
    'node:timers/promises': { setTimeout: async ms => {
      assert.equal(ms, 25); assert.ok(++calls.waits <= 601, 'retries must be bounded'); t.mock.timers.tick(advance);
    } },
  };
  const { teamAt } = loadWithStubs(require.resolve('../electron/features/team/team.cjs'), (name, load) => replacements[name] ?? load(name));
  const team = teamAt(root, root, true);
  return { team, calls, action: () => {
    calls.actions++; assert.equal(fs.readdirSync(lock).length, 1);
    return 'admitted';
  }, assertReleased: () => assert.deepEqual(fs.readdirSync(path.dirname(lock)).filter(name => name.startsWith('lock')), []) };
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`Windows lock publication retries ${code} until acquisition and runs the action once`, async t => {
    const f = fixture(t, { errorAt: attempt => attempt <= 3 ? code : null });
    assert.equal(await f.team.locked(f.action), 'admitted');
    assert.deepEqual(f.calls, { markers: 1, waits: 3, renames: 4, actions: 1 });
    f.assertReleased();
  });

  test(`Windows lock publication ${code} stops at the existing 15 s deadline`, async t => {
    const f = fixture(t, { errorAt: () => code, advance: 5001 });
    await assert.rejects(f.team.locked(f.action), /Team lock is busy/);
    assert.deepEqual(f.calls, { markers: 1, waits: 3, renames: 3, actions: 0 });
    f.assertReleased();
  });

  test(`non-Windows lock publication ${code} remains an immediate failure`, async t => {
    const f = fixture(t, { platform: 'linux', errorAt: () => code });
    await assert.rejects(f.team.locked(f.action), error => error.code === code);
    assert.deepEqual(f.calls, { markers: 1, waits: 0, renames: 1, actions: 0 });
    f.assertReleased();
  });
}

test('unrelated Windows lock publication errors are not retried', async t => {
  const f = fixture(t, { errorAt: () => 'EIO' });
  await assert.rejects(f.team.locked(f.action), error => error.code === 'EIO');
  assert.deepEqual(f.calls, { markers: 1, waits: 0, renames: 1, actions: 0 });
  f.assertReleased();
});

test('a Windows permission failure creating a lock owner marker is not retried as contention', async t => {
  const error = Object.assign(new Error('Lock token write denied'), { code: 'EPERM' });
  const f = fixture(t, { markerError: error });
  await assert.rejects(f.team.locked(f.action), failure => failure === error);
  assert.deepEqual(f.calls, { markers: 1, waits: 0, renames: 0, actions: 0 });
  f.assertReleased();
});
