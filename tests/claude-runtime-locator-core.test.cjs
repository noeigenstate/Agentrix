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
  assert.deepEqual(Object.keys(same.found.native).sort(), ['file', 'fileShown', 'fingerprint', 'path', 'version', 'via']);
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
  assert.deepEqual([runs.length, files.calls.realpath - before.realpath, files.calls.readFile, files.calls.stat - before.stat], [1, 3, before.readFile, 3],
    'a locate is one realpath and one stat');
  // A refresh runs the search again, but not the version check of a file it already checked.
  await locator.refresh(options); assert.equal(runs.length, 1);
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

test('a refresh reads the stored Windows PATH and searches; a throttled one does so at most once a minute, and nothing found stays the answer until a refresh', async () => {
  let clock = 0, stored = ['D:\\bin', ''];
  const reads = [], files = fakeFiles({}), { probe } = fakeProbe();
  const locator = createLocator({ files, probe, now: () => clock, storedPath: async env => { reads.push(env.SystemRoot); return stored; } });
  const options = { env: { PATH: 'D:\\inherited', SystemRoot: 'C:\\Windows' }, platform: 'win32', arch: 'x64', home };
  const focus = () => locator.refresh(options, { throttled: true });
  assert.equal((await locator.refresh(options)).reason, 'not_found'); assert.deepEqual(reads, ['C:\\Windows']);
  // Installed into a folder only the stored PATH has: a locate and a focus within the minute keep the old answer; an
  // explicit refresh (the connection test, an install) finds it at once.
  files.put(W.join('D:\\bin', 'claude.exe'), { size: NATIVE });
  assert.equal((await locator.locate(options)).reason, 'not_found');
  clock = 30000;
  assert.equal((await focus()).reason, 'not_found'); assert.equal(reads.length, 1);
  assert.equal((await locator.refresh(options)).native.via, 'registry-path'); assert.equal(reads.length, 2);
  // Found or not, a focus searches anew only a minute after the last full search.
  stored = ['D:\\later;D:\\bin', '']; files.put(W.join('D:\\later', 'claude.exe'), { size: NATIVE });
  clock = 60000;
  assert.equal((await focus()).native.file, W.join('D:\\bin', 'claude.exe')); assert.equal(reads.length, 2);
  clock = 90000;
  assert.equal((await focus()).native.file, W.join('D:\\later', 'claude.exe')); assert.equal(reads.length, 3);
  // A read that fails keeps the stored PATH read before; other platforms never read it.
  stored = null;
  assert.equal((await locator.refresh(options)).native.file, W.join('D:\\later', 'claude.exe')); assert.equal(reads.length, 4);
  // Nothing found is kept for the same PATH only: another PATH is another search.
  const empty = { ...options, env: { ...options.env, PATH: 'D:\\empty' } };
  stored = [];
  assert.equal((await locator.refresh(empty)).reason, 'not_found');
  files.put(W.join('D:\\empty', 'claude.exe'), { size: NATIVE });
  assert.equal((await locator.locate(empty)).reason, 'not_found');
  assert.equal((await locator.locate({ ...options, env: { ...options.env, PATH: 'D:\\later' } })).native.via, 'path');
  await createLocator({ files, probe, storedPath: async () => assert.fail('only Windows stores a PATH') }).refresh({ ...options, platform: 'linux', env: { PATH: '/usr/bin' } });
});

test('a failed check is trusted for ten seconds: a locate after that searches and runs the CLI again', async () => {
  let clock = 0, answer = null;
  const exe = 'D:\\bin\\claude.exe', files = fakeFiles({ [exe]: { size: NATIVE } }), runs = [];
  // The first check hangs (a timeout); the next prints the version.
  const probe = (file, _args, _options, callback) => { runs.push(file); if (answer) callback(null, answer); return { exitCode: null, signalCode: null, kill() { callback(Object.assign(new Error('killed'), { signal: 'SIGKILL' }), ''); } }; };
  const locator = createLocator({ files, probe, now: () => clock, storedPath: async () => null, timeoutMs: 5, graceMs: 5 });
  const options = { env: { PATH: 'D:\\bin' }, platform: 'win32', arch: 'x64', home };
  const first = await locator.refresh(options);
  assert.deepEqual([first.reason, first.failure.found, runs.length], ['timeout', exe, 1]);
  answer = '2.1.322 (Claude Code)';
  clock = 9999;
  assert.equal(await locator.locate(options), first); assert.equal(runs.length, 1);
  clock = 10000;
  assert.equal((await locator.locate(options)).native.file, exe); assert.equal(runs.length, 2);
  // Within ten seconds a refresh trusts the failed check too: the file is not run again until then.
  answer = null; files.put(exe, { size: NATIVE, mtimeMs: 2 });
  clock = 20000; assert.equal((await locator.refresh(options)).reason, 'timeout'); assert.equal(runs.length, 3);
  answer = '2.1.322 (Claude Code)';
  clock = 25000; assert.equal((await locator.refresh(options)).reason, 'timeout'); assert.equal(runs.length, 3);
  clock = 30000; assert.equal((await locator.refresh(options)).reason, null); assert.equal(runs.length, 4);
});

test('a refresh asked for while one runs is done once after it, however many ask, and a refresh after a running locate follows it', async () => {
  const exe = 'D:\\bin\\claude.exe', files = fakeFiles({ [exe]: { size: NATIVE } }), { probe } = fakeProbe();
  let reads = 0;
  const locator = createLocator({ files, probe, storedPath: async () => { reads++; return null; } });
  const options = { env: { PATH: 'D:\\bin' }, platform: 'win32', arch: 'x64', home };
  const searches = () => files.calls.realpath;
  await Promise.all([locator.refresh(options), locator.refresh(options), locator.refresh(options), locator.locate(options)]);
  assert.equal(reads, 2, 'the first refresh and one trailing refresh');
  const before = searches();
  const [locate, refresh] = await Promise.all([locator.locate(options), locator.refresh(options)]);
  assert.equal(reads, 3); assert.notEqual(locate, refresh, 'the refresh searched again after the locate'); assert.deepEqual(locate, refresh);
  assert.ok(searches() > before);
});

test('a CLI behind a link is told to the terminal by the link, and an update that moves the link is followed', async () => {
  const links = W.join(local, 'Microsoft', 'WinGet', 'Links'), link = W.join(links, 'claude.exe');
  const v1 = W.join(local, 'WinGet', 'Packages', 'v1', 'claude.exe'), v2 = W.join(local, 'WinGet', 'Packages', 'v2', 'claude.exe');
  const files = fakeFiles({ [link]: { link: v1 }, [v1]: { size: NATIVE }, [v2]: { size: NATIVE } }), { probe } = fakeProbe({ [v1]: '2.1.318', [v2]: '2.1.322' });
  const locator = createLocator({ files, probe, storedPath: async () => null });
  const options = { env: { PATH: '', LOCALAPPDATA: local }, platform: 'win32', arch: 'x64', home };
  const first = await locator.refresh(options);
  assert.deepEqual([first.terminal.path, first.terminal.file, first.terminal.version], [link, v1, '2.1.318']);
  files.put(link, { link: v2 });
  const moved = await locator.locate(options);
  assert.deepEqual([moved.terminal.path, moved.terminal.file, moved.terminal.version], [link, v2, '2.1.322']);
});

test('a shim names a package only inside its own folder: never a UNC path, never above the folder', async () => {
  const folder = 'D:\\tools\\npm', outside = 'D:\\tools\\evil\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  const unc = '\\\\server\\share\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  const shim = text => ({ [W.join(folder, 'claude.cmd')]: { text } });
  const locate = entries => createLocator({ files: fakeFiles(entries), probe: fakeProbe().probe, storedPath: async () => null })
    .refresh({ env: { PATH: folder }, platform: 'win32', arch: 'x64', home });
  assert.equal((await locate({ ...shim('"%dp0%\\..\\evil\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*'), [outside]: { size: NATIVE } })).reason, 'not_found');
  assert.equal((await locate({ ...shim('"%dp0%\\\\server\\share\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*'), [unc]: { size: NATIVE } })).reason, 'not_found');
  const inner = W.join(folder, 'global', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  assert.equal((await locate({ ...shim('"%~dp0\\global\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*'), [inner]: { size: NATIVE } })).native.file, inner);
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
