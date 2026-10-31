const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const flush = () => new Promise(resolve => setImmediate(resolve));

function watcherFs(realpath = directory => directory, existsSync = () => true) {
  const watchers = [], resolved = [];
  return { watchers, resolved, fs: {
    existsSync,
    realpathSync: { native(directory) { resolved.push(directory); return realpath(directory); } },
    watch(directory, options, callback) {
      const watcher = {
        directory, options, callback, closed: false, unreffed: false,
        close() { this.closed = true; },
        unref() { this.unreffed = true; },
        on(_event, listener) { this.error = listener; return this; },
      };
      watchers.push(watcher); return watcher;
    },
  } };
}

function sessionFiles(watched) {
  const filename = require.resolve('../electron/session-files.cjs'), localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.SessionFiles = SessionFiles;', {
    module, Buffer, setTimeout, clearTimeout,
    require: name => name === 'node:fs' ? watched : localRequire(name),
  }, { filename });
  return module.exports;
}

function accountWatcher(watched, files, queue) {
  const filename = require.resolve('../electron/main.cjs'), source = fs.readFileSync(filename, 'utf8');
  const watchers = new Map();
  const watch = vm.runInNewContext(source.slice(source.indexOf('function watchClaudeAccounts()'), source.indexOf('async function refreshClaudeAccounts()')) + '\nwatchClaudeAccounts;', {
    fs: watched, path, claudeAccountWatchers: watchers, claudeAccountFiles: files, queueClaudeAccounts: queue,
  }, { filename });
  return { watch, watchers };
}

function activityMonitor(watched) {
  const filename = require.resolve('../electron/codex-activity.cjs'), localRequire = createRequire(filename);
  const module = { exports: {} }, files = sessionFiles(watched);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, process, Buffer, setTimeout, clearTimeout,
    require: name => name === 'node:fs' ? watched : name === './session-files.cjs' ? files : localRequire(name),
  }, { filename });
  return module.exports.monitorActivity;
}

test('session watchers resolve the OS directory once and keep event paths under the original directory', () => {
  const directory = path.join(os.tmpdir(), 'SESSIO~1'), canonical = path.join(os.tmpdir(), 'Session folder');
  const watched = watcherFs(() => canonical), { SessionFiles } = sessionFiles(watched.fs);
  const listing = new SessionFiles(directory);
  listing.watch(); listing.watch();
  assert.deepEqual(watched.resolved, [directory]);
  assert.equal(watched.watchers.length, 1, 'repeated listings retain their watcher');
  const [watcher] = watched.watchers;
  assert.equal(watcher.directory, canonical);
  assert.equal(watcher.options.recursive, true); assert.equal(watcher.options.persistent, false);
  const relative = path.join('2026', '10', '30', 'rollout-first.jsonl');
  watcher.callback('change', Buffer.from(relative));
  watcher.callback('rename', path.basename(canonical));
  assert.deepEqual([...listing.changed], [path.join(directory, relative), path.join(directory, path.basename(canonical))]);
  assert.equal(listing.directory, directory);
  assert.equal(listing.watcher, watcher, 'a child named after the watched folder is not its deletion');
  listing.unwatch(); assert.equal(watcher.closed, true);
});

test('session watchers fall back after native resolution fails and retry after watcher errors', () => {
  let exists = false;
  const directory = path.join(os.tmpdir(), 'SESSIO~1');
  const watched = watcherFs(() => { throw new Error('native realpath failed'); }, () => exists);
  const { SessionFiles } = sessionFiles(watched.fs), listing = new SessionFiles(directory);
  listing.watch(); assert.equal(watched.resolved.length, 0, 'a missing directory is not watched');
  exists = true; listing.watch();
  assert.equal(watched.watchers[0].directory, directory);
  watched.watchers[0].callback('change', 'rollout-first.jsonl');
  assert.deepEqual([...listing.changed], [path.join(directory, 'rollout-first.jsonl')]);
  watched.watchers[0].error(new Error('watch failed'));
  assert.equal(watched.watchers[0].closed, true); assert.equal(listing.watcher, null);
  listing.watch(); assert.equal(watched.watchers.length, 2);
  assert.equal(watched.watchers[1].directory, directory);
  listing.unwatch();
});

test('session self-deletion handles original, canonical, absolute and empty event names', () => {
  const directory = path.join(os.tmpdir(), 'SESSIO~1'), canonical = path.join(os.tmpdir(), 'Session folder');
  for (const name of [path.basename(directory), path.basename(canonical), directory, canonical, null]) {
    let exists = true;
    const watched = watcherFs(() => canonical, () => exists), { SessionFiles } = sessionFiles(watched.fs);
    const listing = new SessionFiles(directory);
    listing.watch(); listing.missed = false; exists = false;
    watched.watchers[0].callback('rename', name);
    assert.equal(listing.watcher, null, `self-deletion event: ${name}`);
    assert.equal(watched.watchers[0].closed, true); assert.equal(listing.missed, true);
    exists = true; listing.watch(); assert.equal(watched.watchers.length, 2, 'a recreated folder gets a new watcher');
    listing.unwatch();
  }
});

test('account watchers keep original ownership and name filters when the OS directory is resolved', () => {
  const directory = path.join(os.tmpdir(), 'ACCOUN~1'), canonical = path.join(os.tmpdir(), 'Account folder');
  const watched = watcherFs(() => canonical);
  let files = [path.join(directory, '.claude.json'), path.join(directory, 'claude-quota.json')], queued = 0;
  const runtime = accountWatcher(watched.fs, () => files, () => ++queued);
  runtime.watch(); runtime.watch();
  assert.deepEqual(watched.resolved, [directory]); assert.equal(watched.watchers.length, 1);
  assert.deepEqual([...runtime.watchers.keys()], [directory]);
  const [watcher] = watched.watchers, entry = runtime.watchers.get(directory);
  assert.equal(watcher.directory, canonical); assert.equal(watcher.options.persistent, false); assert.equal(watcher.unreffed, true);
  assert.deepEqual([...entry.names], ['.claude.json', 'claude-quota.json']);
  watcher.callback('rename', '.claude.json'); watcher.callback('change', Buffer.from('claude-quota.json'));
  watcher.callback('rename', 'atomic.tmp'); watcher.callback('change', null);
  assert.equal(queued, 3, 'matching and unnamed events refresh accounts; unrelated names do not');
  files = [path.join(directory, '.claude.json')]; runtime.watch();
  watcher.callback('rename', 'claude-quota.json'); assert.equal(queued, 3, 'a retained watcher uses the updated name set');
  files = []; runtime.watch();
  assert.equal(watcher.closed, true); assert.equal(runtime.watchers.size, 0);
  watcher.callback('rename', '.claude.json'); assert.equal(queued, 3, 'closed watchers cannot queue work');
  files = [path.join(directory, '.claude.json')]; runtime.watch();
  const replacement = runtime.watchers.get(directory);
  watcher.error(new Error('late error'));
  assert.equal(runtime.watchers.get(directory), replacement, 'a stale error cannot discard the current owner');
  watched.watchers[1].error(new Error('watch failed')); assert.equal(runtime.watchers.size, 0);
  runtime.watch(); assert.equal(watched.watchers.length, 3, 'watcher errors are retried');
  files = []; runtime.watch();
});

test('account watchers fall back to original directories when native resolution throws or is unavailable', () => {
  const directory = path.join(os.tmpdir(), 'ACCOUN~1');
  for (const available of [true, false]) {
    const watched = watcherFs(() => { throw new Error('native realpath failed'); });
    if (!available) delete watched.fs.realpathSync;
    let queued = 0;
    const runtime = accountWatcher(watched.fs, () => [path.join(directory, '.claude.json')], () => ++queued);
    runtime.watch();
    assert.equal(watched.watchers.length, 1); assert.equal(watched.watchers[0].directory, directory);
    assert.deepEqual([...runtime.watchers.keys()], [directory]);
    watched.watchers[0].callback('rename', '.claude.json'); assert.equal(queued, 1);
    watched.watchers[0].error(new Error('done'));
  }
});

test('account watchers resolve the nearest existing parent and move ownership when the child appears', () => {
  const directory = path.join(os.tmpdir(), 'ACCOUN~1'), canonical = path.join(os.tmpdir(), 'Account folder');
  const pulse = path.join(directory, '.codepulse'); let exists = false, queued = 0;
  const watched = watcherFs(folder => folder === directory ? canonical : path.join(canonical, '.codepulse'), folder => folder !== pulse || exists);
  const runtime = accountWatcher(watched.fs, () => [path.join(pulse, 'claude-quota.json')], () => ++queued);
  runtime.watch();
  assert.equal(watched.watchers[0].directory, canonical);
  assert.deepEqual([...runtime.watchers.keys()], [directory]);
  watched.watchers[0].callback('rename', '.codepulse'); assert.equal(queued, 1);
  exists = true; runtime.watch();
  assert.equal(watched.watchers[0].closed, true);
  assert.equal(watched.watchers[1].directory, path.join(canonical, '.codepulse'));
  assert.deepEqual([...runtime.watchers.keys()], [pulse]);
  watched.watchers[0].callback('rename', '.codepulse'); assert.equal(queued, 1);
  watched.watchers[1].callback('rename', 'claude-quota.json'); assert.equal(queued, 2);
  watched.watchers[1].error(new Error('done'));
});

test('activity monitors resolve file and recursive directory watches and debounce actual callbacks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const recursive of [false, true]) {
    const file = path.join(os.tmpdir(), 'ACTIVI~1', recursive ? 'sessions' : 'rollout.jsonl');
    const canonical = path.join(os.tmpdir(), 'Activity folder', path.basename(file));
    const watched = watcherFs(() => canonical), seen = [];
    let revision = 0, reads = 0;
    const monitor = activityMonitor(watched.fs)(() => { ++reads; return { filename: file, revision }; }, snapshot => seen.push(snapshot), {
      watch: () => file, recursive, interval: 10000,
    });
    t.after(() => monitor.stop()); await flush();
    const [watcher] = watched.watchers;
    assert.deepEqual(watched.resolved, [file]);
    assert.equal(watcher.directory, canonical);
    assert.equal(watcher.options.recursive, recursive); assert.equal(watcher.options.persistent, false);
    ++revision;
    watcher.callback('change', Buffer.from('rollout.jsonl')); watcher.callback('rename', 'rollout.jsonl');
    t.mock.timers.tick(24); await flush(); assert.equal(reads, 1);
    t.mock.timers.tick(1); await flush();
    assert.equal(reads, 2, 'the watcher burst causes one read before the fallback interval');
    assert.deepEqual(seen, [{ filename: file, revision: 0 }, { filename: file, revision: 1 }]);
    await monitor.poll();
    assert.equal(seen.length, 2, 'unchanged snapshots stay deduplicated');
    assert.equal(watched.watchers.length, 1, 'the original watched identity retains its watcher');
    assert.deepEqual(watched.resolved, [file], 'the retained watch is not resolved on every poll');
    monitor.stop(); assert.equal(watcher.closed, true);
  }
});

test('activity monitors retain original file paths when native resolution fails or is unavailable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const file = path.join(os.tmpdir(), 'ACTIVI~1', 'rollout.jsonl');
  for (const unavailable of ['throws', 'native', 'realpathSync']) {
    const watched = watcherFs(() => { throw new Error('native realpath failed'); });
    if (unavailable === 'native') delete watched.fs.realpathSync.native;
    if (unavailable === 'realpathSync') delete watched.fs.realpathSync;
    let revision = 0; const seen = [];
    const monitor = activityMonitor(watched.fs)(() => ({ filename: file, revision }), snapshot => seen.push(snapshot), { watch: () => file, interval: 10000 });
    t.after(() => monitor.stop()); await flush();
    assert.equal(watched.watchers[0].directory, file);
    ++revision; watched.watchers[0].callback('change', 'rollout.jsonl');
    t.mock.timers.tick(25); await flush();
    assert.deepEqual(seen, [{ filename: file, revision: 0 }, { filename: file, revision: 1 }]);
    monitor.stop();
  }
});

test('activity monitor ownership follows original identities and stop cancels queued watcher reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = path.join(os.tmpdir(), 'ACTIVI~1'), canonical = path.join(os.tmpdir(), 'Activity folder');
  const watched = watcherFs(() => canonical);
  let target = original, reads = 0;
  const monitor = activityMonitor(watched.fs)(() => ({ reads: ++reads }), () => {}, { watch: () => target, interval: 1000 });
  t.after(() => monitor.stop()); await flush();
  target = canonical; await monitor.poll();
  assert.equal(watched.watchers[0].closed, true);
  assert.equal(watched.watchers.length, 2, 'distinct caller identities replace a watcher even when both resolve to the same path');
  assert.deepEqual(watched.resolved, [original, canonical]);
  target = null; await monitor.poll(); assert.equal(watched.watchers[1].closed, true);
  target = original; await monitor.poll();
  assert.equal(watched.watchers.length, 3);
  const current = watched.watchers[2], beforeStop = reads;
  current.callback('change', null); monitor.stop();
  assert.equal(current.closed, true);
  t.mock.timers.tick(1000); await flush();
  current.callback('change', null); t.mock.timers.tick(1000); await flush();
  assert.equal(reads, beforeStop, 'neither queued nor late events can read after stop');
});

test('activity polling remains active after a native watcher throws or emits an error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const throws of [false, true]) {
    const watched = watcherFs(), seen = [];
    let attempts = 0, revision = 0;
    const watch = watched.fs.watch;
    watched.fs.watch = (...args) => { ++attempts; if (throws) throw new Error('watch unavailable'); return watch(...args); };
    const monitor = activityMonitor(watched.fs)(() => ({ revision }), snapshot => seen.push(snapshot.revision), {
      watch: () => path.join(os.tmpdir(), 'ACTIVI~1'), interval: 1000,
    });
    t.after(() => monitor.stop()); await flush();
    if (!throws) { watched.watchers[0].error(new Error('watch failed')); assert.equal(watched.watchers[0].closed, true); }
    ++revision; t.mock.timers.tick(1000); await flush();
    assert.deepEqual(seen, [0, 1], 'polling recovers changes even without a watcher');
    assert.equal(attempts, 1, 'unchanged watched identities retain the existing retry semantics');
    monitor.stop();
  }
});
