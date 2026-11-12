const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createLocator } = require('../electron/features/claude-runtime/locator.cjs');
const { inspectClaudeExecutable } = require('../electron/features/claude-sdk/executable.cjs');
const { fakeFiles, fakeProbe, NATIVE, STUB, NPM_SHIM } = require('./helpers/claude-files.cjs');

// Every case is a named layout on a fake file system with a fake probe and a fake stored PATH: no real CLI, profile or
// registry is touched, and a Windows layout runs on any host (the locator follows the platform's path rules).
const W = path.win32, P = path.posix;
const home = 'D:\\Users\\u', local = W.join(home, 'AppData', 'Local');
const required = '2.1.317';
const windowsSearched = ['~\\.local\\bin', '~\\.claude\\local', '~\\AppData\\Local\\Microsoft\\WinGet\\Links'];

test('Windows: Claude Code is found where npm, the stored PATH, the legacy local install and WinGet put it, and none found says where it looked', async () => {
  // The owner's machine: Node at D:\nodejs22 is npm's prefix, so PATH holds the shims (claude, claude.cmd) and the
  // package sits beside them, neither on C: nor under %APPDATA%\npm.
  const node = 'D:\\nodejs22', pkg = W.join(node, 'node_modules', '@anthropic-ai', 'claude-code'), bin = W.join(pkg, 'bin', 'claude.exe');
  const npm = { [W.join(node, 'claude')]: { text: '#!/bin/sh\n' }, [W.join(node, 'claude.cmd')]: { text: NPM_SHIM } };
  const reads = [];
  let ran = [];
  const inspect = (entries, { PATH = node, stored = null, arch = 'x64' } = {}) => {
    const { probe, runs } = fakeProbe(); ran = runs;
    return inspectClaudeExecutable({ env: { PATH, LOCALAPPDATA: local }, platform: 'win32', arch, home, files: fakeFiles(entries), probe,
      storedPath: async () => { reads.push('read'); return stored; } });
  };
  const ok = (file, via) => ({ status: 'ok', version: '2.1.322', required, file, via, fileShown: file.startsWith(home) ? `~${file.slice(home.length)}` : file });

  // npm with its postinstall: bin\claude.exe is the native program, found from the shim's folder and run directly.
  assert.deepEqual(await inspect({ ...npm, [bin]: { size: NATIVE } }), ok(bin, 'npm')); assert.deepEqual(ran, [bin]);
  // npm 12 skipped the postinstall: bin\claude.exe is the placeholder script, never run; the platform package's copy
  // beside it (or nested in it, for this machine's arch first) is.
  const beside = W.join(node, 'node_modules', '@anthropic-ai', 'claude-code-win32-x64', 'claude.exe');
  assert.deepEqual(await inspect({ ...npm, [bin]: { size: STUB }, [beside]: { size: NATIVE } }), ok(beside, 'platform-package')); assert.deepEqual(ran, [beside]);
  const nested = W.join(pkg, 'node_modules', '@anthropic-ai', 'claude-code-win32-arm64', 'claude.exe');
  assert.deepEqual(await inspect({ ...npm, [bin]: { size: STUB }, [beside]: { size: NATIVE }, [nested]: { size: NATIVE } }, { arch: 'arm64' }), ok(nested, 'platform-package'));
  // Without any native copy the package is named, and nothing ran.
  assert.deepEqual(await inspect({ ...npm, [bin]: { size: STUB } }), { status: 'missing', version: null, required, file: null,
    reason: 'not_found', pathFolders: 1, searched: windowsSearched, incomplete: pkg });
  assert.deepEqual(ran, []);
  // A package from before the native program (bin cli.js) is too old by its own package.json, and is not run.
  assert.deepEqual(await inspect({ ...npm, [W.join(pkg, 'cli.js')]: { text: '' }, [W.join(pkg, 'package.json')]: { text: JSON.stringify({ version: '2.1.100' }) } }),
    { status: 'too_old', version: '2.1.100', required, file: null }); assert.deepEqual(ran, []);
  // A pnpm shim runs a package elsewhere; its path is read from the shim.
  const pnpm = W.join(local, 'pnpm'), store = W.join(pnpm, 'global', '5', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  assert.deepEqual(await inspect({ [W.join(pnpm, 'claude.cmd')]: { text: '@SETLOCAL\r\n"%~dp0\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n' },
    [store]: { size: NATIVE } }, { PATH: pnpm }), ok(store, 'npm'));
  // Installed after Agentrix started: the folder is only on the stored PATH, merged after the inherited one.
  const tools = 'D:\\Tools', late = W.join(tools, 'claude.exe');
  assert.deepEqual(await inspect({ [late]: { size: NATIVE } }, { PATH: '', stored: [` ${tools} `, `${node};relative`] }), ok(late, 'registry-path'));
  // The legacy local install keeps an npm package in ~\.claude\local; the native installer's is ~\.local\bin.
  const legacy = W.join(home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  assert.deepEqual(await inspect({ [legacy]: { size: NATIVE } }, { PATH: '' }), ok(legacy, 'claude-local'));
  const native = W.join(home, '.local', 'bin', 'claude.exe');
  assert.deepEqual(await inspect({ [native]: { size: NATIVE } }, { PATH: W.join(home, '.local', 'bin') }), ok(native, 'local-bin'));
  // WinGet's command link resolves to the package it installed, which is what runs.
  const winget = W.join(local, 'Microsoft', 'WinGet', 'Packages', 'Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe', 'claude.exe');
  assert.deepEqual(await inspect({ [W.join(local, 'Microsoft', 'WinGet', 'Links', 'claude.exe')]: { link: winget }, [winget]: { size: NATIVE } }, { PATH: '' }), ok(winget, 'winget'));
  assert.deepEqual(ran, [winget]);
  // Nothing anywhere: every PATH folder counted once (inherited and stored), the install folders named with ~.
  reads.length = 0;
  assert.deepEqual(await inspect({}, { PATH: [node, tools].join(';'), stored: [node, 'D:\\Other'] }),
    { status: 'missing', version: null, required, file: null, reason: 'not_found', pathFolders: 3, searched: windowsSearched });
  assert.deepEqual([ran, reads], [[], ['read']]);
});

test('Windows: within a folder a shim that PowerShell would take first puts its npm package before claude.exe, and a broken or unreadable candidate never hides the next', async () => {
  const folder = 'D:\\bin', pkgBin = W.join(folder, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), exe = W.join(folder, 'claude.exe');
  const locate = (entries, versions = {}, env = { PATH: folder }) => {
    const { probe, runs } = fakeProbe(versions);
    return createLocator({ files: fakeFiles(entries), probe, storedPath: async () => null }).refresh({ env, platform: 'win32', arch: 'x64', home }).then(found => ({ found, runs }));
  };
  // claude.ps1 comes before every PATHEXT; .EXE comes before .CMD.
  assert.equal((await locate({ [W.join(folder, 'claude.ps1')]: { text: '$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe' }, [exe]: { size: NATIVE }, [pkgBin]: { size: NATIVE } })).found.terminal.file, pkgBin);
  assert.equal((await locate({ [W.join(folder, 'claude.cmd')]: { text: NPM_SHIM }, [exe]: { size: NATIVE }, [pkgBin]: { size: NATIVE } })).found.terminal.file, exe);
  assert.equal((await locate({ [W.join(folder, 'claude.cmd')]: { text: NPM_SHIM }, [exe]: { size: NATIVE }, [pkgBin]: { size: NATIVE } }, {}, { PATH: folder, PATHEXT: '.CMD;.EXE' })).found.terminal.file, pkgBin);
  // One that prints no version is passed over for the next, and named only when nothing else is found.
  const { found, runs } = await locate({ [exe]: { size: NATIVE }, [pkgBin]: { size: NATIVE } }, { [exe]: 'garbage' });
  assert.deepEqual([found.terminal.file, found.reason, runs], [pkgBin, null, [exe, pkgBin]]);
  const broken = await locate({ [exe]: { size: NATIVE } }, { [exe]: '' });
  assert.deepEqual([broken.found.terminal, broken.found.reason, broken.found.failure], [null, 'unreadable', { reason: 'unreadable', found: exe }]);
});

test('the terminal runs the first Claude Code found and the native path the first that meets 2.1.317: two different ones are cli_split_versions', async () => {
  const old = 'D:\\old', fresh = 'D:\\new', oldExe = W.join(old, 'claude.exe'), newExe = W.join(fresh, 'claude.exe');
  const entries = { [oldExe]: { size: NATIVE }, [newExe]: { size: NATIVE } };
  const run = (versions, PATH = [old, fresh].join(';')) => {
    const { probe, runs } = fakeProbe(versions);
    const options = { env: { PATH }, platform: 'win32', arch: 'x64', home, files: fakeFiles(entries), probe, storedPath: async () => null };
    return Promise.all([createLocator(options).refresh(options), inspectClaudeExecutable(options)]).then(([found, cli]) => ({ found, cli, runs }));
  };
  const split = await run({ [oldExe]: '2.1.300 (Claude Code)', [newExe]: '2.1.322 (Claude Code)' });
  assert.deepEqual([split.found.terminal.file, split.found.terminal.version, split.found.native.file, split.found.reason], [oldExe, '2.1.300', newExe, 'cli_split_versions']);
  assert.deepEqual(split.cli, { status: 'ok', version: '2.1.322', required, file: newExe, via: 'path', fileShown: newExe,
    notice: 'cli_split_versions', split: { terminal: { version: '2.1.300', via: 'path', fileShown: oldExe } } });
  // One that meets it is both, and the search stops there: the second is never run.
  const same = await run({ [oldExe]: '2.1.318 (Claude Code)' });
  assert.equal(same.found.native, same.found.terminal); assert.equal(same.found.reason, null); assert.deepEqual(same.runs, [oldExe, oldExe]);
  assert.deepEqual(Object.keys(same.found.native).sort(), ['file', 'fileShown', 'fingerprint', 'version', 'via']);
  assert.deepEqual(Object.keys(same.found.native.fingerprint).sort(), ['file', 'mtimeMs', 'pathHash', 'size']);
  // None meets it: too old, with the terminal's version; the terminal still has its file.
  const tooOld = await run({ [oldExe]: '2.1.300 (Claude Code)', [newExe]: '2.1.301 (Claude Code)' });
  assert.deepEqual([tooOld.found.reason, tooOld.found.native, tooOld.found.terminal.file, tooOld.cli], ['too_old', null, oldExe, { status: 'too_old', version: '2.1.300', required, file: null }]);
});

test('one fingerprint runs --version once: a locate only stats what the last search chose, and a changed file or PATH searches again', async () => {
  const folder = 'D:\\bin', exe = W.join(folder, 'claude.exe'), files = fakeFiles({ [exe]: { size: NATIVE, mtimeMs: 1 } });
  const { probe, runs } = fakeProbe(), locator = createLocator({ files, probe, storedPath: async () => null });
  const options = { env: { PATH: folder }, platform: 'win32', arch: 'x64', home };
  assert.equal(locator.peek(), null, 'nothing before the first search');
  const first = await locator.refresh(options);
  assert.deepEqual([runs.length, locator.peek()], [1, first]);
  const before = { ...files.calls };
  for (let i = 0; i < 3; i++) assert.equal(await locator.locate(options), first);
  assert.deepEqual([runs.length, files.calls.realpath, files.calls.readFile, files.calls.stat - before.stat], [1, before.realpath, before.readFile, 3], 'a locate is one stat');
  // Overlapping calls share one search.
  await Promise.all([locator.refresh(options), locator.refresh(options), locator.locate(options)]); assert.equal(runs.length, 1);
  // An update rewrote the file: it is searched for and run again, once.
  files.put(exe, { size: NATIVE + 1, mtimeMs: 2 });
  const updated = await locator.locate(options);
  assert.notEqual(updated, first); assert.equal(updated.native.fingerprint.mtimeMs, 2); assert.equal(runs.length, 2);
  await locator.locate(options); assert.equal(runs.length, 2);
  // Another PATH searches again, but the same file at the same size and mtime is not run again.
  const moved = await locator.locate({ ...options, env: { PATH: `D:\\other;${folder}` } });
  assert.notEqual(moved.native.fingerprint.pathHash, updated.native.fingerprint.pathHash); assert.equal(runs.length, 2);
  // A file gone is searched for again: nothing found.
  files.remove(exe);
  assert.equal((await locator.locate(options)).reason, 'not_found');
});

test('a refresh reads the stored Windows PATH; while nothing is found at most once a minute, and nothing found stays the answer until the next refresh', async () => {
  let clock = 0, stored = ['D:\\bin', ''];
  const later = 'D:\\later', reads = [], files = fakeFiles({}), { probe, runs } = fakeProbe();
  const locator = createLocator({ files, probe, now: () => clock, storedPath: async env => { reads.push(env.SystemRoot); return stored; } });
  const options = { env: { PATH: 'D:\\inherited', SystemRoot: 'C:\\Windows' }, platform: 'win32', arch: 'x64', home };
  assert.equal((await locator.refresh(options)).reason, 'not_found'); assert.deepEqual(reads, ['C:\\Windows']);
  // Installed into a folder already on PATH: a plain locate keeps the old answer; a refresh searches and finds it
  // without reading the stored PATH again within the minute.
  files.put(W.join('D:\\bin', 'claude.exe'), { size: NATIVE });
  assert.equal((await locator.locate(options)).reason, 'not_found');
  clock = 30000;
  assert.equal((await locator.refresh(options)).native.via, 'registry-path'); assert.equal(reads.length, 1);
  // Once found, every refresh reads it again.
  stored = [`${later};D:\\bin`, '']; files.put(W.join(later, 'claude.exe'), { size: NATIVE });
  clock = 31000;
  assert.equal((await locator.refresh(options)).native.file, W.join(later, 'claude.exe')); assert.equal(reads.length, 2);
  // Gone again: a refresh within the minute keeps the stored PATH it has, one after it reads again.
  files.remove(W.join(later, 'claude.exe')); files.remove(W.join('D:\\bin', 'claude.exe'));
  assert.equal((await locator.refresh(options)).reason, 'not_found'); assert.equal(reads.length, 3);
  stored = ['D:\\elsewhere', '']; files.put(W.join('D:\\elsewhere', 'claude.exe'), { size: NATIVE });
  clock = 60000;
  assert.equal((await locator.refresh(options)).reason, 'not_found'); assert.equal(reads.length, 3);
  clock = 91000;
  assert.equal((await locator.refresh(options)).native.file, W.join('D:\\elsewhere', 'claude.exe')); assert.equal(reads.length, 4);
  // A read that fails keeps the stored PATH read before; other platforms never read it.
  stored = null;
  assert.equal((await locator.refresh(options)).native.file, W.join('D:\\elsewhere', 'claude.exe'));
  // Nothing found is kept for the same PATH only: another PATH is another search.
  const empty = { ...options, env: { ...options.env, PATH: 'D:\\empty' } };
  files.remove(W.join('D:\\elsewhere', 'claude.exe')); files.put(W.join('D:\\moved', 'claude.exe'), { size: NATIVE });
  clock = 200000; stored = [];
  assert.equal((await locator.refresh(empty)).reason, 'not_found');
  files.put(W.join('D:\\empty', 'claude.exe'), { size: NATIVE });
  assert.equal((await locator.locate(empty)).reason, 'not_found');
  assert.equal((await locator.locate({ ...options, env: { ...options.env, PATH: 'D:\\moved' } })).native.via, 'path');
  await createLocator({ files, probe, storedPath: async () => assert.fail('only Windows stores a PATH') }).refresh({ ...options, platform: 'linux', env: { PATH: '/usr/bin' } });
  assert.ok(runs.length >= 1);
});

test('POSIX: npm, its placeholder, the native installer and the system folders, in the platform path rules on any host', async () => {
  const userHome = '/home/u', prefix = '/opt/node', pkg = P.join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code'), bin = P.join(pkg, 'bin', 'claude.exe');
  const inspect = (entries, PATH = P.join(prefix, 'bin'), arch = 'x64') => {
    const { probe } = fakeProbe();
    return inspectClaudeExecutable({ env: { PATH }, platform: 'linux', arch, home: userHome, files: fakeFiles(entries, 'linux'), probe, storedPath: async () => assert.fail('no stored PATH') });
  };
  const ok = (file, via) => ({ status: 'ok', version: '2.1.322', required, file, via, fileShown: file.startsWith(userHome) ? `~${file.slice(userHome.length)}` : file });
  const link = { [P.join(prefix, 'bin', 'claude')]: { link: bin } };
  assert.deepEqual(await inspect({ ...link, [bin]: { size: NATIVE } }), ok(bin, 'npm'));
  const copy = P.join(pkg, 'node_modules', '@anthropic-ai', 'claude-code-linux-x64-musl', 'claude');
  assert.deepEqual(await inspect({ ...link, [bin]: { size: STUB }, [copy]: { size: NATIVE } }), ok(copy, 'platform-package'));
  const own = P.join(userHome, '.local', 'bin', 'claude');
  assert.deepEqual(await inspect({ [own]: { size: NATIVE } }, '/usr/bin'), ok(own, 'local-bin'));
  assert.deepEqual(await inspect({ '/usr/local/bin/claude': { size: NATIVE } }, ''), ok('/usr/local/bin/claude', 'system'));
  assert.deepEqual((await inspect({}, '/usr/bin')).searched, ['~/.local/bin', '~/.claude/local', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']);
});
