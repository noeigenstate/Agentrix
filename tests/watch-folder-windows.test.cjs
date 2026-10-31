const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// A libuv assertion aborts the process, so exercise the real alias in a child rather than the test runner.
async function liveAliasWatchers() {
  const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const nativeWatch = fs.watch, watched = [], monitors = [], watchers = new Map();
  fs.watch = (filename, options, callback) => {
    const entry = { filename, options, events: [] };
    entry.watcher = nativeWatch(filename, options, (...event) => { entry.events.push(event); callback(...event); });
    watched.push(entry); return entry.watcher;
  };
  const { rolloutFiles } = require(process.argv[1]);
  const { monitorActivity } = require(process.argv[3]);
  const root = process.argv[4], timeoutScale = Number(process.argv[5]), directory = path.join(root, 'sessions');
  const eventually = async read => {
    const deadline = Date.now() + 5000 * timeoutScale;
    while (!await read()) {
      assert.ok(Date.now() < deadline, `watcher event did not arrive within ${5000 * timeoutScale} ms`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const reported = (entry, file) => entry.events.some(([_type, name]) => String(name) === path.basename(file));
  try {
    fs.mkdirSync(directory);
    const first = path.join(directory, 'rollout-first.jsonl');
    fs.writeFileSync(first, '{}\n');
    assert.equal((await rolloutFiles(directory))[0].filename, first, 'the listing retains its 8.3 input prefix');
    const pending = rolloutFiles(directory); assert.equal(rolloutFiles(directory), pending); await pending;
    assert.equal(watched.length, 1, 'concurrent listings share a successful native watcher');
    assert.equal(watched[0].filename, fs.realpathSync.native(directory));
    const second = path.join(directory, 'rollout-second.jsonl');
    fs.writeFileSync(second, '{}\n');
    await eventually(() => reported(watched[0], second));
    await eventually(async () => (await rolloutFiles(directory)).some(file => file.filename === second));
    watched[0].events.length = 0;
    const later = new Date(Date.now() + 60000); fs.utimesSync(first, later, later);
    await eventually(() => reported(watched[0], first));
    await eventually(async () => (await rolloutFiles(directory)).find(file => file.filename === first)?.modified >= later.getTime() - 1000);
    watched[0].events.length = 0;
    fs.unlinkSync(second);
    await eventually(() => reported(watched[0], second));
    await eventually(async () => (await rolloutFiles(directory)).every(file => file.filename !== second));
    watched[0].events.length = 0;
    fs.rmSync(directory, { recursive: true });
    await eventually(() => watched[0].events.length > 0);
    await eventually(async () => (await rolloutFiles(directory)).length === 0);
    fs.mkdirSync(directory); fs.writeFileSync(second, '{}\n');
    await eventually(async () => (await rolloutFiles(directory)).some(file => file.filename === second));
    assert.equal(watched.length, 2, 'a recreated folder gets a fresh native watcher');

    const filename = process.argv[2], source = fs.readFileSync(filename, 'utf8');
    const file = path.join(root, '.claude.json'), accountIndex = watched.length; let events = 0;
    fs.writeFileSync(file, '{}');
    const watch = vm.runInNewContext(source.slice(source.indexOf('function watchClaudeAccounts()'), source.indexOf('async function refreshClaudeAccounts()')) + '\nwatchClaudeAccounts;', {
      fs, path, claudeAccountWatchers: watchers, claudeAccountFiles: () => [file], queueClaudeAccounts: () => ++events,
    }, { filename });
    watch(); watch();
    assert.equal(watched.length, accountIndex + 1, 'account terminals share one watcher');
    assert.equal(watched[accountIndex].filename, fs.realpathSync.native(root));
    assert.deepEqual([...watchers.keys()], [root], 'account ownership retains the 8.3 path');
    fs.writeFileSync(path.join(root, 'unrelated.tmp'), '{}');
    await eventually(() => reported(watched[accountIndex], path.join(root, 'unrelated.tmp')));
    assert.equal(events, 0, 'unrelated events remain filtered');
    fs.renameSync(path.join(root, 'unrelated.tmp'), file);
    await eventually(() => events > 0);
    assert.equal(watchers.size, 1, 'atomic replacement retains the directory watcher');

    for (const recursive of [true, false]) {
      const target = path.join(root, recursive ? 'activity directory' : 'activity file.jsonl');
      const record = recursive ? path.join(target, 'nested', 'rollout.jsonl') : target;
      fs.mkdirSync(path.dirname(record), { recursive: true }); fs.writeFileSync(record, 'first\n');
      const seen = [], index = watched.length;
      const monitor = monitorActivity(() => ({ filename: target, text: fs.readFileSync(record, 'utf8') }), snapshot => seen.push(snapshot), {
        watch: () => target, recursive, interval: 60000 * timeoutScale,
      });
      monitors.push(monitor);
      await eventually(() => watched.length === index + 1);
      const entry = watched[index];
      assert.equal(entry.filename, fs.realpathSync.native(target));
      assert.equal(entry.options.recursive, recursive); assert.equal(entry.options.persistent, false);
      assert.deepEqual(seen, [{ filename: target, text: 'first\n' }]);
      fs.appendFileSync(record, 'second\n');
      await eventually(() => entry.events.length > 0);
      assert.ok(entry.events.some(([_type, name]) => String(name) === (recursive ? path.join('nested', 'rollout.jsonl') : path.basename(target))));
      await eventually(() => seen.length === 2);
      assert.deepEqual(seen, [{ filename: target, text: 'first\n' }, { filename: target, text: 'first\nsecond\n' }]);
      assert.equal(watched.length, index + 1, 'the original identity keeps its canonical watcher after an event');
      monitor.stop();
    }
  } finally {
    for (const monitor of monitors) monitor.stop();
    for (const { watcher } of watched) watcher.close();
    fs.watch = nativeWatch;
  }
}

test('native watchers follow real Windows 8.3 aliases without changing caller-visible paths', { skip: process.platform !== 'win32' && 'Windows 8.3 directory aliases are required' }, async t => {
  const { timeoutScale } = await import('../scripts/wait.mjs');
  const directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'agentrix native watcher long directory '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $files = New-Object -ComObject Scripting.FileSystemObject; $folder = $files.GetFolder($env:AGENTRIX_WATCH_ALIAS_DIRECTORY); [Console]::Write(($folder.ShortPath | ConvertTo-Json -Compress))";
  const aliasResult = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, AGENTRIX_WATCH_ALIAS_DIRECTORY: directory }, encoding: 'utf8', windowsHide: true, timeout: 10000 * timeoutScale,
  });
  assert.ifError(aliasResult.error);
  assert.equal(aliasResult.status, 0, `COM ShortPath failed (${aliasResult.signal || aliasResult.status}):\n${aliasResult.stdout}\n${aliasResult.stderr}`);
  const alias = JSON.parse(aliasResult.stdout.trim());
  assert.equal(typeof alias, 'string'); assert.ok(path.isAbsolute(alias), 'COM ShortPath returns an absolute directory');
  assert.equal(fs.realpathSync.native(alias).toLowerCase(), fs.realpathSync.native(directory).toLowerCase(), 'the alias resolves to the exact test directory');
  if (path.basename(alias).toLowerCase() === path.basename(directory).toLowerCase()) {
    t.skip('the temporary volume did not provide an 8.3 alias for the new long directory'); return;
  }
  assert.match(path.basename(alias), /~/, 'COM ShortPath must provide an 8.3 alias or the unchanged long leaf');
  const child = spawnSync(process.execPath, ['-e', `(${liveAliasWatchers.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`,
    require.resolve('../electron/session-files.cjs'), require.resolve('../electron/main.cjs'), require.resolve('../electron/codex-activity.cjs'), alias, String(timeoutScale)], {
    encoding: 'utf8', windowsHide: true, timeout: 45000 * timeoutScale,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, `alias watcher child failed (${child.signal || child.status}):\n${child.stdout}\n${child.stderr}`);
});
