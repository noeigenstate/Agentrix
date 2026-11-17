require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Load the real Team with private fs wrappers and a clock advanced only by the retry wait; no Git or child processes.
function fixture(t, { platform = 'win32', errorAt = () => null, advance = 25, writeError } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'team-lock-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, 'agentrix', 'lock'), calls = { opens: 0, waits: 0, stats: 0, renames: 0, actions: 0 };
  let now = 0;
  const injected = { ...fs,
    openSync(file, flags, ...args) {
      if (file === lock) {
        assert.equal(flags, 'wx');
        const code = errorAt(++calls.opens);
        if (code) throw Object.assign(new Error('Injected exclusive-open failure'), { code });
      }
      return fs.openSync(file, flags, ...args);
    },
    statSync(...args) { calls.stats++; return fs.statSync(...args); },
    renameSync(...args) { calls.renames++; return fs.renameSync(...args); },
    writeFileSync(...args) { if (writeError) throw writeError; return fs.writeFileSync(...args); },
  };
  const file = path.resolve(__dirname, '../electron/features/team/team.cjs'), localRequire = createRequire(file), loaded = { exports: {} };
  const replacements = {
    'node:fs': injected,
    'node:child_process': { execFileSync: () => assert.fail('lock unit tests must not run Git') },
    'node:timers/promises': { setTimeout: async ms => {
      assert.equal(ms, 25); assert.ok(++calls.waits <= 601, 'retries must be bounded'); now += advance;
    } },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module: loaded, require: name => replacements[name] || localRequire(name), process: { platform, env: {} }, Date: { now: () => now },
  }, { filename: file });
  const team = loaded.exports.teamAt(root, root, true);
  return { team, lock, calls, action: () => { calls.actions++; return 'admitted'; } };
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`Windows lock open retries ${code} until acquisition and runs the action once`, async t => {
    const f = fixture(t, { errorAt: attempt => attempt <= 3 ? code : null });
    assert.equal(await f.team.locked(f.action), 'admitted');
    assert.deepEqual(f.calls, { opens: 4, waits: 3, stats: 0, renames: 0, actions: 1 });
    assert.equal(fs.existsSync(f.lock), false, 'the acquired lock is released');
  });

  test(`Windows lock open ${code} stops at the existing 15 s deadline`, async t => {
    const f = fixture(t, { errorAt: () => code, advance: 5001 });
    await assert.rejects(f.team.locked(f.action), /Team admission lock is busy; retry the dispatch/);
    assert.deepEqual(f.calls, { opens: 3, waits: 3, stats: 0, renames: 0, actions: 0 });
    assert.equal(fs.existsSync(f.lock), false);
  });

  test(`non-Windows lock open ${code} remains an immediate failure`, async t => {
    const f = fixture(t, { platform: 'linux', errorAt: () => code });
    await assert.rejects(f.team.locked(f.action), error => error.code === code);
    assert.deepEqual(f.calls, { opens: 1, waits: 0, stats: 0, renames: 0, actions: 0 });
  });
}

test('unrelated Windows lock open errors are not retried', async t => {
  const f = fixture(t, { errorAt: () => 'EIO' });
  await assert.rejects(f.team.locked(f.action), error => error.code === 'EIO');
  assert.equal(f.calls.opens, 1); assert.equal(f.calls.waits, 0); assert.equal(f.calls.actions, 0);
});

test('a Windows permission failure writing an acquired lock is not retried as contention', async t => {
  const error = Object.assign(new Error('Lock token write denied'), { code: 'EPERM' });
  const f = fixture(t, { writeError: error });
  await assert.rejects(f.team.locked(f.action), failure => failure === error);
  assert.equal(f.calls.opens, 1); assert.equal(f.calls.waits, 0); assert.equal(f.calls.actions, 0);
});
