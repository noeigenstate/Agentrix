const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createLocator } = require('../electron/features/claude-runtime/locator.cjs');
const { fakeFiles, fakeProbe, NATIVE, STUB, NPM_SHIM } = require('./helpers/claude-files.cjs');

// The install layouts a machine can have, one named test each per platform, through the locator's public API only.
// Every layout lives on a fake file system with a fake probe and a fake stored PATH, in the path rules of the platform
// it simulates, so both run on any host and no real CLI, profile or registry is touched. `--version` counts and the
// cache belong to claude-runtime-locator-core.test.cjs.
const OLD = '2.1.300 (Claude Code)', NEW = '2.1.322 (Claude Code)';

// A platform's world: where things sit, and the layouts as { entries, PATH, file, via }. `file` is the program the
// layout ends up running, `via` the way it was found.
const worlds = {
  win32: (() => {
    const W = path.win32, home = 'C:\\Users\\u', local = W.join(home, 'AppData', 'Local'), prefix = 'C:\\nodejs';
    const pkg = W.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code'), bin = W.join(pkg, 'bin', 'claude.exe');
    const shims = { [W.join(prefix, 'claude')]: { text: '#!/bin/sh\n' }, [W.join(prefix, 'claude.cmd')]: { text: NPM_SHIM } };
    const own = W.join(home, '.local', 'bin', 'claude.exe'), beside = W.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code-win32-x64', 'claude.exe');
    const links = W.join(local, 'Microsoft', 'WinGet', 'Links', 'claude.exe'), packaged = W.join(local, 'Microsoft', 'WinGet', 'Packages', 'Anthropic.ClaudeCode', 'claude.exe');
    return {
      platform: 'win32', arch: 'x64', home, shown: file => file.replace(home, '~'), env: PATH => ({ PATH, LOCALAPPDATA: local }),
      searched: ['~\\.local\\bin', '~\\.claude\\local', '~\\AppData\\Local\\Microsoft\\WinGet\\Links'],
      npm: { entries: { ...shims, [bin]: { size: NATIVE } }, PATH: prefix, file: bin, via: 'npm' },
      localBin: { entries: { [own]: { size: NATIVE } }, PATH: 'C:\\Windows', file: own, via: 'local-bin' },
      placeholder: { entries: { ...shims, [bin]: { size: STUB }, [beside]: { size: NATIVE } }, PATH: prefix, file: beside, via: 'platform-package', stub: bin },
      stubOnly: { entries: { ...shims, [bin]: { size: STUB } }, PATH: prefix, },
      system: { entries: { [links]: { link: packaged }, [packaged]: { size: NATIVE } }, PATH: '', file: packaged, via: 'winget', name: 'WinGet' },
      late: { folder: 'C:\\Tools', file: 'C:\\Tools\\claude.exe', via: 'registry-path' },
      pkg,
    };
  })(),
  linux: (() => {
    const P = path.posix, home = '/home/u', prefix = '/opt/node', pkg = P.join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code'), bin = P.join(pkg, 'bin', 'claude.exe');
    const link = { [P.join(prefix, 'bin', 'claude')]: { link: bin } }, own = P.join(home, '.local', 'bin', 'claude');
    const beside = P.join(path.posix.dirname(pkg), 'claude-code-linux-x64', 'claude');
    return {
      platform: 'linux', arch: 'x64', home, shown: file => file.replace(home, '~'), env: PATH => ({ PATH }),
      searched: ['~/.local/bin', '~/.claude/local', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'],
      npm: { entries: { ...link, [bin]: { size: NATIVE } }, PATH: P.join(prefix, 'bin'), file: bin, via: 'npm' },
      localBin: { entries: { [own]: { size: NATIVE } }, PATH: '/usr/bin', file: own, via: 'local-bin' },
      placeholder: { entries: { ...link, [bin]: { size: STUB }, [beside]: { size: NATIVE } }, PATH: P.join(prefix, 'bin'), file: beside, via: 'platform-package', stub: bin },
      stubOnly: { entries: { ...link, [bin]: { size: STUB } }, PATH: P.join(prefix, 'bin') },
      system: { entries: { '/usr/local/bin/claude': { size: NATIVE } }, PATH: '', file: '/usr/local/bin/claude', via: 'system', name: 'the system folders' },
      late: { folder: '/srv/tools', file: '/srv/tools/claude', via: 'path' },
      pkg,
    };
  })(),
};

// A locator over one layout: a new instance per test, its probe answering `versions` (file → output; the default is a
// current CLI), and the stored Windows PATH `stored` (null when it cannot be read).
function machine(world, { entries = {}, versions = {}, stored = null } = {}) {
  const files = fakeFiles(entries, world.platform), { probe, runs } = fakeProbe(versions, NEW), reads = [];
  const locator = createLocator({ probe, files, storedPath: async () => { reads.push(1); return stored; }, timeoutMs: 50, graceMs: 50 });
  const options = PATH => ({ env: world.env(PATH), platform: world.platform, arch: world.arch, home: world.home });
  return { files, runs, reads, locator, locate: PATH => locator.locate(options(PATH)), refresh: PATH => locator.refresh(options(PATH)) };
}
// What a found CLI reads as in the connection test: its file, version, way and file shown with home as ~.
const described = (world, file, via, version = '2.1.322') => ({ file, version, via, fileShown: world.shown(file) });
const pick = ({ file, version, via, fileShown }) => ({ file, version, via, fileShown });

for (const world of Object.values(worlds)) {
  const at = `${world.platform}: `;

  test(`${at}npm alone: the terminal and the native path run npm's program`, async () => {
    const { npm } = world, m = machine(world, { entries: npm.entries });
    const found = await m.locate(npm.PATH);
    assert.deepEqual([found.reason, found.terminal === found.native], [null, true]);
    assert.deepEqual(pick(found.native), described(world, npm.file, 'npm'));
    assert.deepEqual(m.runs, [npm.file]);
  });

  test(`${at}~/.local/bin alone: found by its own folder, home written as ~`, async () => {
    const { localBin } = world, m = machine(world, { entries: localBin.entries });
    const found = await m.locate(localBin.PATH);
    assert.equal(found.reason, null);
    assert.deepEqual(pick(found.terminal), described(world, localBin.file, 'local-bin'));
    assert.ok(found.terminal.fileShown.startsWith('~'));
  });

  test(`${at}npm and ~/.local/bin both there: PATH order decides, and one current program is both the terminal's and the native path's`, async () => {
    const { npm, localBin } = world, entries = { ...npm.entries, ...localBin.entries };
    const first = machine(world, { entries }), a = await first.locate(npm.PATH);
    assert.equal(a.native.file, npm.file);
    assert.deepEqual([a.reason, a.terminal === a.native], [null, true]);
    assert.deepEqual(first.runs, [npm.file], 'the search ends at the first that meets the minimum');
    // With npm off PATH the native installer's file is the one.
    const second = machine(world, { entries }), b = await second.locate(localBin.PATH);
    assert.deepEqual([b.reason, b.native.file, b.native.via], [null, localBin.file, 'local-bin']);
  });

  test(`${at}too old: nothing meets 2.1.317, so no native file and the terminal's version is told`, async () => {
    const { npm, localBin } = world, m = machine(world, { entries: { ...npm.entries, ...localBin.entries }, versions: { [npm.file]: OLD, [localBin.file]: '2.1.301 (Claude Code)' } });
    const found = await m.locate(npm.PATH);
    assert.deepEqual([found.reason, found.native, found.version, found.terminal.file, found.terminal.version], ['too_old', null, '2.1.300', npm.file, '2.1.300']);
    assert.deepEqual(m.runs, [npm.file, localBin.file], 'every install is asked before it is called too old');
  });

  test(`${at}npm's placeholder bin/claude.exe is never run: the platform package's copy is, and without one the package is named`, async () => {
    const { placeholder, stubOnly } = world, m = machine(world, { entries: placeholder.entries });
    const found = await m.locate(placeholder.PATH);
    assert.deepEqual(pick(found.native), described(world, placeholder.file, 'platform-package'));
    assert.deepEqual(m.runs, [placeholder.file]);
    const none = machine(world, { entries: stubOnly.entries }), missing = await none.locate(stubOnly.PATH);
    assert.deepEqual([missing.reason, missing.terminal, missing.native, missing.pathFolders], ['not_found', null, null, 1]);
    assert.equal(missing.incomplete, world.shown(world.pkg), 'the package that has no native program');
    assert.deepEqual([missing.searched, none.runs], [world.searched, []]);
  });

  test(`${at}${world.system.name}: a file only the install folders have is found with its own way`, async () => {
    const { system } = world, m = machine(world, { entries: system.entries });
    const found = await m.locate(system.PATH);
    assert.equal(found.reason, null);
    assert.deepEqual(pick(found.native), described(world, system.file, system.via));
    assert.deepEqual(m.runs, [system.file], 'a link runs the program it leads to');
  });

  test(`${at}installed while Agentrix runs: not seen by a locate that found nothing, found by the next refresh`, async () => {
    // Windows: the folder is only on the stored PATH. POSIX: it is on PATH, the file not there yet.
    const { late } = world, windows = world.platform === 'win32', PATH = windows ? '' : late.folder;
    const m = machine(world, { stored: windows ? [late.folder] : null });
    assert.equal((await m.locate(PATH)).reason, 'not_found');
    m.files.put(late.file, { size: NATIVE });
    assert.equal((await m.locate(PATH)).reason, 'not_found', 'a locate under an unchanged PATH keeps what it found');
    const found = await m.refresh(PATH);
    assert.deepEqual([found.reason, found.native.file, found.native.via], [null, late.file, late.via]);
    assert.equal(m.reads.length, windows ? 1 : 0, 'only Windows reads its stored PATH, and only the refresh does');
  });

  test(`${at}the terminal's program is too old and another install meets the minimum: cli_split_versions with both described`, async () => {
    const { npm, localBin } = world, m = machine(world, { entries: { ...npm.entries, ...localBin.entries }, versions: { [npm.file]: OLD, [localBin.file]: NEW } });
    const found = await m.locate(npm.PATH);
    assert.equal(found.reason, 'cli_split_versions');
    assert.notEqual(found.terminal, found.native);
    assert.deepEqual(pick(found.terminal), described(world, npm.file, 'npm', '2.1.300'));
    assert.deepEqual(pick(found.native), described(world, localBin.file, 'local-bin'));
    assert.deepEqual(Object.keys(found.native.fingerprint).sort(), ['file', 'mtimeMs', 'pathHash', 'size']);
    assert.deepEqual(m.runs, [npm.file, localBin.file]);
  });

  test(`${at}the split goes when the terminal's install is upgraded: one file again, no reason`, async () => {
    const { npm, localBin } = world, versions = { [npm.file]: OLD, [localBin.file]: NEW }, m = machine(world, { entries: { ...npm.entries, ...localBin.entries }, versions });
    assert.equal((await m.locate(npm.PATH)).reason, 'cli_split_versions');
    versions[npm.file] = NEW; m.files.put(npm.file, { size: NATIVE, mtimeMs: 2 });
    const found = await m.locate(npm.PATH);
    assert.deepEqual([found.reason, found.terminal === found.native, found.native.file, found.native.version], [null, true, npm.file, '2.1.322']);
  });
}
