const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { execFile } = require('node:child_process'), { promisify } = require('node:util');
const { createCodexLocator } = require('../electron/features/codex-runtime/locator.cjs');
const { scanDrives, LIMITS } = require('../electron/features/codex-runtime/drive-scan.cjs');
const { codexState } = require('../electron/agents.cjs');
const { locateCodex, executable } = require('../integration/dispatch.cjs');
const { fakeFiles, fakeProbe } = require('./helpers/claude-files.cjs');
const { isolatedEnvironment } = require('../scripts/native-approval-probe.cjs');
const { timeoutScale } = require('../scripts/wait.mjs');
const layouts = require('./fixtures/real-cli/codex-layouts.json');

// Every Windows case is a layout K0b captured from real npm installs (tests/fixtures/real-cli/codex-layouts.json), or a
// shape it marks synthetic, laid out on a fake file system with a fake probe and a fake stored PATH: no real Codex,
// profile or registry is touched, and a Windows layout runs on any host (the locator follows the platform's path rules).
const W = path.win32, P = path.posix, NATIVE = 180000000;
const home = 'C:\\Users\\u', local = W.join(home, 'AppData', 'Local'), roaming = W.join(home, 'AppData', 'Roaming');
const windowsSearched = ['~\\AppData\\Roaming\\npm', '~\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin', '~\\AppData\\Local\\Microsoft\\WinGet\\Links'];

// One captured install under `root`: its shims with the text npm wrote, each program at a native size, the rest empty.
function install(name, root) {
  const { files, shims } = layouts.installs[name];
  return Object.fromEntries([...new Set([...files, ...Object.keys(shims)])].map(file =>
    [W.join(root, ...file.split('/')), Object.hasOwn(shims, file) ? { text: shims[file] } : file.endsWith('.exe') ? { size: NATIVE } : { text: '' }]));
}
const exeOf = (name, root) => W.join(root, ...layouts.installs[name].exe.split('/'));
const versionOf = name => /\d+\.\d+\.\d+/.exec(layouts.installs[name].codexExeVersion)[0];

// fakeFiles with a directory listing, which WinGet's packages folder needs.
// A folder is every path above an entry; an entry marked `junction` is a folder that is a link (a scan never enters it).
// `reads` counts the folders listed.
function codexFiles(entries, rules = W) {
  const files = fakeFiles(entries, rules === W ? 'win32' : 'linux');
  files.reads = 0;
  files.readdir = async (dir, options) => {
    const names = new Map();
    for (const relative of Object.keys(entries).map(file => rules.relative(dir, file)).filter(relative => relative && !relative.startsWith('..') && !rules.isAbsolute(relative))) {
      const [name, ...rest] = relative.split(rules.sep);
      names.set(name, names.get(name) || rest.length > 0);
    }
    if (!names.size) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' });
    files.reads++;
    const link = name => !!Object.entries(entries).find(([file, entry]) => entry.junction && rules.relative(rules.join(dir, name), file) === '');
    return options?.withFileTypes ? [...names].map(([name, folder]) => ({ name, isDirectory: () => folder, isFile: () => !folder, isSymbolicLink: () => link(name) })) : [...names.keys()];
  };
  files.opendir = async dir => {
    const listed = await files.readdir(dir, { withFileTypes: true });
    let next = 0;
    return { read: async () => listed[next++] ?? null, close: async () => {} };
  };
  return files;
}
function windowsLocator(entries, { versions = {}, fallback = 'codex-cli 0.166.0', stored = null, registered = null, now, ...rest } = {}) {
  const files = codexFiles(entries), { probe, runs } = fakeProbe(versions, fallback);
  const locator = createCodexLocator({ files, probe, storedPath: async () => stored, registry: async () => registered, ...(now ? { now } : {}), ...rest });
  return { locator, runs, files };
}
const windowsEnv = env => ({ USERPROFILE: home, LOCALAPPDATA: local, APPDATA: roaming, PATH: '', ...env });
async function find(entries, env = {}, options) {
  const { locator, runs } = windowsLocator(entries, options);
  return { found: await locator.refresh({ env: windowsEnv(env), platform: 'win32', arch: 'x64' }), runs };
}
const shownOf = file => file.startsWith(home) ? `~${file.slice(home.length)}` : file;
const picked = ({ file, path, via, version, reason }) => ({ file, path, via, version, reason: reason?.code ?? null });

test('Windows: Codex is found through a codex.cmd shim, a nested or hoisted npm package, an npm prefix on another drive, the stored PATH, the official installer and WinGet; none found says where it looked', async () => {
  // A global npm install on D: (npm 10 and 11, an in-place upgrade, the 0.46 single package): PowerShell takes codex.ps1
  // first, so its package's own program runs, nested in it, and the terminal is told the shim.
  const prefix = 'D:\\nodejs';
  for (const name of ['npm10-global-0.166.0', 'npm10-global-0.169.0', 'npm11-global-0.166.0', 'npm10-global-upgrade-0.46.0-to-0.166.0', 'npm10-global-legacy-0.46.0']) {
    const { found, runs } = await find(install(name, prefix), { PATH: prefix }, { versions: { [exeOf(name, prefix)]: layouts.installs[name].codexExeVersion } });
    assert.deepEqual(picked(found), { file: exeOf(name, prefix), path: W.join(prefix, 'codex.ps1'), via: 'npm-vendor', version: versionOf(name), reason: null }, name);
    assert.deepEqual(runs, [exeOf(name, prefix)], `${name}: only the program ran, never a shim`);
    assert.equal(found.fileShown, exeOf(name, prefix));
  }
  // The platform package asked for beside the main one is hoisted to the top node_modules.
  const hoisted = 'npm10-global-hoisted-0.166.0';
  assert.deepEqual(picked((await find(install(hoisted, prefix), { PATH: prefix })).found), { file: exeOf(hoisted, prefix), path: W.join(prefix, 'codex.ps1'), via: 'npm-hoisted', version: '0.166.0', reason: null });
  // A project's own install (npm install --prefix): its node_modules\.bin shims name the package in the node_modules
  // they sit in; the platform package is hoisted beside it.
  const project = 'E:\\work\\tool', bin = W.join(project, 'node_modules', '.bin');
  for (const name of ['npm-prefix-0.166.0', 'npm-prefix-0.169.0']) {
    assert.deepEqual(picked((await find(install(name, project), { PATH: bin }, { fallback: layouts.installs[name].codexExeVersion })).found),
      { file: exeOf(name, project), path: W.join(bin, 'codex.ps1'), via: 'npm-shim', version: versionOf(name), reason: null }, name);
  }
  // Without codex.ps1 the wrapper takes the shim PATHEXT names first.
  const cmdOnly = install('npm11-global-0.166.0', prefix);
  delete cmdOnly[W.join(prefix, 'codex.ps1')];
  assert.equal((await find(cmdOnly, { PATH: prefix, PATHEXT: '.CMD;.EXE' })).found.path, W.join(prefix, 'codex.CMD'), 'spelled as PATHEXT spells it, as PowerShell does');
  // npm's global prefix on another drive, not on PATH: read from the user's .npmrc (or NPM_CONFIG_PREFIX), never by running npm.
  const other = 'E:\\npm-global', global = install('npm11-global-0.166.0', other);
  assert.deepEqual(picked((await find({ ...global, [W.join(home, '.npmrc')]: { text: 'registry=https://registry.npmjs.org/\r\nprefix = E:\\npm-global\r\n' } })).found),
    { file: exeOf('npm11-global-0.166.0', other), path: W.join(other, 'codex.ps1'), via: 'npm-prefix', version: '0.166.0', reason: null });
  assert.equal((await find(global, { NPM_CONFIG_PREFIX: '${CODEX_DRIVE}\\npm-global', CODEX_DRIVE: 'E:' })).found.via, 'npm-prefix');
  assert.equal((await find(install('npm11-global-0.166.0', W.join(roaming, 'npm')))).found.via, 'npm-prefix', "npm's default prefix, %APPDATA%\\npm");
  // Installed after Agentrix started: the folder is only on the stored PATH. An npm prefix there is told by its layout,
  // a plain codex.exe by the stored PATH.
  const late = 'D:\\nodejs22';
  assert.deepEqual(picked((await find(install('npm10-global-0.169.0', late), { PATH: 'C:\\Windows' }, { stored: ['', late], fallback: 'codex-cli 0.169.0' })).found),
    { file: exeOf('npm10-global-0.169.0', late), path: W.join(late, 'codex.ps1'), via: 'npm-vendor', version: '0.169.0', reason: null });
  const tools = 'D:\\Tools', plain = W.join(tools, 'codex.exe');
  assert.deepEqual(picked((await find({ [plain]: { size: NATIVE } }, { PATH: 'C:\\Windows' }, { stored: [` ${tools} `, ''] })).found), { file: plain, path: plain, via: 'registry-path', version: '0.166.0', reason: null });
  assert.equal((await find({ [plain]: { size: NATIVE } }, { PATH: tools })).found.via, 'path');
  // The official installer's folder (synthetic shape), off PATH or on it.
  const { root: installed, files: [program] } = layouts.synthetic['official-installer'];
  const installer = W.join(installed.replace('%LOCALAPPDATA%', local), ...program.split('/'));
  for (const PATH of ['', W.dirname(installer)]) assert.deepEqual(picked((await find({ [installer]: { size: NATIVE } }, { PATH })).found), { file: installer, path: installer, via: 'official-installer', version: '0.166.0', reason: null });
  // WinGet (synthetic, from its manifest): the package folder holds codex-x86_64-pc-windows-msvc.exe and Links an alias,
  // which is a link to it or a launcher; either way the package's own program runs and the terminal is told the alias.
  const winget = layouts.synthetic.winget, links = W.join(local, 'Microsoft', 'WinGet', 'Links'), alias = W.join(links, winget.linkFiles[0]);
  const packaged = W.join(local, 'Microsoft', 'WinGet', 'Packages', winget.packageFolderPattern, winget.packageFiles[0]);
  for (const aliasEntry of [{ link: packaged }, { size: 4096 }]) {
    assert.deepEqual(picked((await find({ [alias]: aliasEntry, [packaged]: { size: NATIVE } }, { PATH: links })).found), { file: packaged, path: alias, via: 'winget', version: '0.166.0', reason: null });
  }
  assert.deepEqual(picked((await find({ [packaged]: { size: NATIVE } })).found), { file: packaged, path: packaged, via: 'winget', version: '0.166.0', reason: null }, 'no alias: the package folder');
  // pnpm (synthetic): its shim names the package in its global store, which links to where the platform package sits beside it.
  const pnpm = W.join(local, 'pnpm'), linked = W.join(pnpm, 'global', '5', 'node_modules', '@openai', 'codex'), store = W.join(pnpm, 'global', '5', 'node_modules', '.pnpm', '@openai+codex@0.166.0', 'node_modules', '@openai', 'codex');
  const stored = W.join(W.dirname(store), 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  assert.deepEqual(picked((await find({ [W.join(pnpm, 'codex.cmd')]: { text: '@SETLOCAL\r\n"%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n' },
    [linked]: { link: store }, [stored]: { size: NATIVE } }, { PATH: pnpm })).found), { file: stored, path: W.join(pnpm, 'codex.CMD'), via: 'pnpm', version: '0.166.0', reason: null });
  // A shim names a package only inside its own folder (a .bin shim: the node_modules it sits in), never above it.
  const nested = ['node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'];
  const away = W.join('D:\\other', 'node_modules', '@openai', 'codex', ...nested), above = W.join('D:\\work', '@openai', 'codex', ...nested);
  for (const [folder, text] of [['D:\\bin', '"%dp0%\\..\\other\\node_modules\\@openai\\codex\\bin\\codex.js" %*'], ['D:\\work\\node_modules\\.bin', '"%dp0%\\..\\..\\@openai\\codex\\bin\\codex.js" %*']]) {
    assert.equal((await find({ [W.join(folder, 'codex.cmd')]: { text }, [away]: { size: NATIVE }, [above]: { size: NATIVE } }, { PATH: folder })).found.file, null, text);
  }
  // A broken candidate never hides the next.
  const broken = install('npm11-global-0.166.0', prefix);
  delete broken[exeOf('npm11-global-0.166.0', prefix)];
  assert.equal((await find({ ...broken, [plain]: { size: NATIVE } }, { PATH: `${prefix};${tools}` })).found.file, plain);
  // npm's package without its program (an install that skipped the platform package) says it is incomplete, and nothing ran.
  const { found: incomplete, runs } = await find(broken, { PATH: prefix });
  assert.deepEqual([incomplete.file, incomplete.reason.code, incomplete.reason.detail, runs], [null, 'codex.incomplete', W.join(prefix, 'node_modules', '@openai', 'codex'), []]);
  // Nothing anywhere: every PATH folder counted once (inherited and stored), the install folders named with ~.
  const { found: none } = await find({}, { PATH: `${prefix};${tools}` }, { stored: [prefix, 'D:\\More'] });
  assert.deepEqual([none.file, none.path, none.via, none.version, none.searched, none.pathFolders], [null, null, null, null, windowsSearched, 3]);
  assert.deepEqual([none.reason.code, none.reason.params], ['codex.not_found', { pathFolders: 3, searched: windowsSearched.join('; ') }]);
});

test('POSIX: Codex is found on PATH, in npm\'s prefix bin and the system folders, in the platform path rules on any host', async () => {
  const locate = async (entries, env) => (await createCodexLocator({ files: codexFiles(entries, P), probe: fakeProbe({}, 'codex-cli 0.166.0').probe })
    .locate({ env: { HOME: '/home/u', PATH: '', ...env }, platform: 'linux', arch: 'x64' }));
  const link = '/home/u/.npm-global/bin/codex', script = '/home/u/.npm-global/lib/node_modules/@openai/codex/bin/codex.js';
  const npm = { [link]: { link: script }, [script]: { text: '#!/usr/bin/env node' } };
  assert.deepEqual(picked(await locate(npm, { PATH: '/home/u/.npm-global/bin' })), { file: script, path: link, via: 'path', version: '0.166.0', reason: null });
  assert.deepEqual(picked(await locate(npm, { NPM_CONFIG_PREFIX: '~/.npm-global' })), { file: script, path: link, via: 'npm-prefix', version: '0.166.0', reason: null });
  assert.equal((await locate({ '/usr/local/bin/codex': { size: NATIVE } })).via, 'system');
  const none = await locate({});
  assert.deepEqual([none.reason.code, none.searched], ['codex.not_found', ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']]);
});

test('one fingerprint runs --version once', async () => {
  const name = 'npm11-global-0.166.0', prefix = 'D:\\nodejs', exe = exeOf(name, prefix), env = windowsEnv({ PATH: prefix });
  const { locator, runs, files } = windowsLocator(install(name, prefix));
  const options = { env, platform: 'win32', arch: 'x64' };
  const first = await locator.refresh(options);
  assert.equal((await locator.locate(options)), first, 'a locate keeps the answer while the file stands');
  await locator.refresh(options);
  await locator.locate({ ...options, env: { ...env, PATH: `D:\\Empty;${prefix}` } });
  assert.deepEqual(runs, [exe], 'a refresh and another PATH search again, but the same file is not run again');
  assert.equal(locator.peek().fingerprint.file, exe);
  // An update writes a new program: it is run once more.
  files.put(exe, { size: NATIVE + 1, mtimeMs: 2 });
  assert.equal((await locator.locate(options)).fingerprint.size, NATIVE + 1);
  assert.deepEqual(runs, [exe, exe]);
});

test('a locate keeps the answer when PATH spells its folder in another case or reaches it through a junction', async () => {
  // nvm-windows puts C:\Program Files\nodejs on PATH as a junction to the active version; PATH may spell it in any case.
  const name = 'npm11-global-0.166.0', nodejs = 'C:\\Program Files\\nodejs', shim = W.join(nodejs, 'codex.ps1');
  const options = { env: windowsEnv({ PATH: nodejs.toLowerCase() }), platform: 'win32', arch: 'x64' };
  for (const junction of [{}, { link: W.join(roaming, 'nvm', 'v22.11.0', 'codex.ps1') }]) {
    const entries = install(name, nodejs), text = entries[shim].text;
    entries[shim] = { text, ...junction };
    const { locator, files } = windowsLocator(entries);
    const found = await locator.refresh(options);
    assert.equal(found.file, exeOf(name, nodejs));
    assert.equal(await locator.locate(options), found, `the answer stands, not searched again (${junction.link ?? 'case'})`);
    // A shim that now leads elsewhere is searched again.
    files.put(shim, { text, link: 'D:\\Elsewhere\\codex.ps1' });
    assert.notEqual(await locator.locate(options), found);
  }
});

test("a package a link takes elsewhere on this machine is followed; one really on another share is never run", async () => {
  const prefix = 'D:\\nodejs', pnpm = W.join(local, 'pnpm'), nested = ['node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'];
  const npmShim = { [W.join(prefix, 'codex.cmd')]: { text: '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*' } };
  const pnpmShim = { [W.join(pnpm, 'codex.cmd')]: { text: '"%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*' } };
  const cases = [[prefix, npmShim, W.join(prefix, 'node_modules', '@openai', 'codex'), 'npm-vendor'], [pnpm, pnpmShim, W.join(pnpm, 'global', '5', 'node_modules', '@openai', 'codex'), 'pnpm']];
  // A local folder's package that a link (a junction, npm link) takes elsewhere on the machine runs; one it takes to a
  // share is passed over, and Codex is then not found rather than incomplete.
  for (const [folder, shims, dir, via] of cases) for (const target of ['D:\\elsewhere\\codex', W.join(W.dirname(folder), 'codex'), '\\\\server\\share\\codex']) {
    const program = W.join(target, ...nested), { found, runs } = await find({ ...shims, [dir]: { link: target }, [program]: { size: NATIVE } }, { PATH: folder });
    if (target.startsWith('\\\\')) assert.deepEqual([found.file, found.reason.code, runs], [null, 'codex.not_found', []], `${dir} -> ${target}`);
    else assert.deepEqual(picked(found), { file: program, path: W.join(folder, 'codex.CMD'), via, version: '0.166.0', reason: null }, `${dir} -> ${target}`);
  }
  // npm's globals moved off C: by a junction, %APPDATA%\npm\node_modules -> D:\npm\node_modules: on PATH, or npm's
  // default prefix off it.
  const name = 'npm11-global-0.166.0', moved = 'D:\\npm', globals = W.join(roaming, 'npm'), entries = install(name, moved);
  for (const shim of Object.keys(layouts.installs[name].shims)) { entries[W.join(globals, shim)] = entries[W.join(moved, shim)]; delete entries[W.join(moved, shim)]; }
  entries[W.join(globals, 'node_modules', '@openai', 'codex')] = { link: W.join(moved, 'node_modules', '@openai', 'codex') };
  for (const PATH of [globals, '']) {
    assert.deepEqual(picked((await find(entries, { PATH })).found), { file: exeOf(name, moved), path: W.join(globals, 'codex.ps1'), via: PATH ? 'npm-vendor' : 'npm-prefix', version: '0.166.0', reason: null }, PATH || 'off PATH');
  }
  // nvm-windows: the folder on PATH is a junction, and so is where its package really is.
  const nvm = W.join(roaming, 'nvm', 'v22.11.0'), program = W.join(nvm, 'node_modules', '@openai', 'codex', ...nested);
  const { found } = await find({ ...npmShim, [prefix]: { link: nvm }, [W.join(prefix, 'node_modules', '@openai', 'codex')]: { link: W.join(nvm, 'node_modules', '@openai', 'codex') }, [program]: { size: NATIVE } }, { PATH: prefix });
  assert.deepEqual(picked(found), { file: program, path: W.join(prefix, 'codex.CMD'), via: 'npm-vendor', version: '0.166.0', reason: null });
  // A folder on a share (on PATH as such, or a mapped drive whose real path is the share) runs its own package there;
  // a link from it to another share is refused.
  const share = '\\\\server\\share\\npm', onShare = W.join(share, 'node_modules', '@openai', 'codex'), shareShim = { [W.join(share, 'codex.cmd')]: npmShim[W.join(prefix, 'codex.cmd')] };
  assert.equal((await find({ ...shareShim, [W.join(onShare, ...nested)]: { size: NATIVE } }, { PATH: share })).found.file, W.join(onShare, ...nested));
  const mapped = 'Z:\\npm', mappedShim = { [W.join(mapped, 'codex.cmd')]: npmShim[W.join(prefix, 'codex.cmd')] };
  for (const [target, runs] of [[onShare, true], ['\\\\other\\share\\codex', false]]) {
    const program = W.join(target, ...nested);
    const { found } = await find({ ...mappedShim, [mapped]: { link: share }, [W.join(mapped, 'node_modules', '@openai', 'codex')]: { link: target }, [program]: { size: NATIVE } }, { PATH: mapped });
    assert.equal(found.file, runs ? program : null, `${mapped} (really ${share}) -> ${target}`);
  }
});

test("a package whose program moved to a layout no table knows is found in its vendor tree, within bounds and off foreign shares", async () => {
  // Codex once moved vendor/<triple>/codex/codex.exe to vendor/<triple>/bin/codex.exe; a later move is still found.
  const prefix = 'D:\\nodejs', moved = (name, ...parts) => {
    const entries = install(name, prefix), exe = exeOf(name, prefix);
    delete entries[exe];
    return { entries, file: W.join(W.dirname(W.dirname(exe)), ...parts) };
  };
  for (const [name, via] of [['npm11-global-0.166.0', 'npm-vendor'], ['npm10-global-hoisted-0.166.0', 'npm-hoisted']]) {
    const { entries, file } = moved(name, 'newdir', 'codex.exe');
    assert.deepEqual(picked((await find({ ...entries, [file]: { size: NATIVE } }, { PATH: prefix })).found), { file, path: W.join(prefix, 'codex.ps1'), via, version: '0.166.0', reason: null }, name);
  }
  const deepest = moved('npm11-global-0.166.0', 'a', 'b', 'c', 'codex.exe');
  assert.equal((await find({ ...deepest.entries, [deepest.file]: { size: NATIVE } }, { PATH: prefix })).found.file, deepest.file, 'three folders below');
  // Without a shim the terminal is told the program itself.
  const bare = moved('npm11-global-0.166.0', 'newdir', 'codex.exe');
  for (const shim of ['codex', 'codex.cmd', 'codex.ps1']) delete bare.entries[W.join(prefix, shim)];
  assert.equal((await find({ ...bare.entries, [bare.file]: { size: NATIVE } }, { PATH: prefix })).found.path, bare.file);
  // A link from there elsewhere on this machine is followed; deeper than three folders, or really on a share, is not
  // run: the package is incomplete.
  const deeper = moved('npm11-global-0.166.0', 'a', 'b', 'c', 'd', 'codex.exe'), linked = moved('npm11-global-0.166.0', 'newdir', 'codex.exe');
  const elsewhere = 'D:\\elsewhere\\codex.exe';
  assert.equal((await find({ ...linked.entries, [linked.file]: { link: elsewhere }, [elsewhere]: { size: NATIVE } }, { PATH: prefix })).found.file, elsewhere);
  for (const [entries, label] of [[{ ...deeper.entries, [deeper.file]: { size: NATIVE } }, 'four folders below'],
    [{ ...linked.entries, [linked.file]: { link: '\\\\server\\share\\codex.exe' }, '\\\\server\\share\\codex.exe': { size: NATIVE } }, 'a share']]) {
    const { found, runs } = await find(entries, { PATH: prefix });
    assert.deepEqual([found.file, found.reason.code, runs], [null, 'codex.incomplete', []], label);
  }
});

test('each other installer is found after WinGet, with its own via, and the search names only the folders that are there', async () => {
  const nestedExe = ['node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'];
  const name = 'npm11-global-0.166.0', data = 'C:\\ProgramData', plain = file => ({ [file]: { size: NATIVE } });
  const npmAt = root => ({ entries: install(name, root), file: exeOf(name, root) });
  const ext = (editor, version, platform = 'windows-x86_64') => W.join(home, editor, 'extensions', `openai.chatgpt-${version}-win32-x64`, 'bin', platform, 'codex.exe');
  const nvm = W.join(roaming, 'nvm'), newer = npmAt(W.join(nvm, 'v22.11.0')), older = npmAt(W.join(nvm, 'v20.1.0'));
  const pnpmHome = 'D:\\pnpm', linked = W.join(pnpmHome, 'global', '5', 'node_modules', '@openai', 'codex'), pnpmExe = W.join(linked, ...nestedExe);
  const cases = [
    ['scoop app', plain(W.join(home, 'scoop', 'apps', 'codex', 'current', 'codex.exe')), {}, 'scoop'],
    ['scoop shim', plain(W.join(home, 'scoop', 'shims', 'codex.exe')), {}, 'scoop'],
    ['SCOOP', plain('D:\\scoop\\shims\\codex.exe'), { SCOOP: 'D:\\scoop' }, 'scoop'],
    ['scoop global', plain(W.join(data, 'scoop', 'shims', 'codex.exe')), { ProgramData: data }, 'scoop'],
    ['SCOOP_GLOBAL', plain('D:\\apps\\scoop\\shims\\codex.exe'), { SCOOP_GLOBAL: 'D:\\apps\\scoop' }, 'scoop'],
    ['chocolatey', plain(W.join(data, 'chocolatey', 'bin', 'codex.exe')), {}, 'chocolatey'],
    ['ChocolateyInstall', plain('D:\\choco\\bin\\codex.exe'), { ChocolateyInstall: 'D:\\choco' }, 'chocolatey'],
    ['volta', plain(W.join(local, 'Volta', 'bin', 'codex.exe')), {}, 'volta'],
    ['VOLTA_HOME', plain('D:\\volta\\bin\\codex.exe'), { VOLTA_HOME: 'D:\\volta' }, 'volta'],
    ['bun bin', plain(W.join(home, '.bun', 'bin', 'codex.exe')), {}, 'bun'],
    ['bun global', { ...npmAt(W.join(home, '.bun', 'install', 'global')).entries }, {}, 'bun', exeOf(name, W.join(home, '.bun', 'install', 'global'))],
    ['PNPM_HOME', { [W.join(pnpmHome, 'codex.cmd')]: { text: '"%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*' }, [pnpmExe]: { size: NATIVE } }, { PNPM_HOME: pnpmHome }, 'pnpm', pnpmExe],
    ['yarn global', npmAt(W.join(local, 'Yarn', 'Data', 'global')).entries, {}, 'yarn', exeOf(name, W.join(local, 'Yarn', 'Data', 'global'))],
    ['nvm versions, newest first', { ...older.entries, ...newer.entries }, { NVM_HOME: nvm }, 'nvm', newer.file],
    ['NVM_SYMLINK first', { ...older.entries, ...npmAt('C:\\Program Files\\nodejs').entries }, { NVM_HOME: nvm, NVM_SYMLINK: 'C:\\Program Files\\nodejs' }, 'nvm', exeOf(name, 'C:\\Program Files\\nodejs')],
    ['fnm', npmAt(W.join(roaming, 'fnm', 'node-versions', 'v22.11.0', 'installation')).entries, {}, 'fnm', exeOf(name, W.join(roaming, 'fnm', 'node-versions', 'v22.11.0', 'installation'))],
    ['FNM_DIR', npmAt('D:\\fnm\\node-versions\\v22.11.0\\installation').entries, { FNM_DIR: 'D:\\fnm' }, 'fnm', exeOf(name, 'D:\\fnm\\node-versions\\v22.11.0\\installation')],
    ['VS Code extension, newest first', { ...plain(ext('.vscode', '0.4.9')), ...plain(ext('.vscode', '0.4.12')) }, {}, 'vscode-extension', ext('.vscode', '0.4.12')],
    ['this CPU first', { ...plain(ext('.vscode', '0.4.12', 'windows-aarch64')), ...plain(ext('.vscode', '0.4.12')) }, {}, 'vscode-extension', ext('.vscode', '0.4.12')],
    ['Cursor', plain(ext('.cursor', '0.4.12')), {}, 'vscode-extension'],
    ['Windsurf', plain(ext('.windsurf', '0.4.12')), {}, 'vscode-extension'],
  ];
  for (const [label, entries, env, via, file = Object.keys(entries)[0]] of cases) {
    const { found, runs } = await find(entries, env);
    assert.deepEqual([found.file, found.via, runs], [file, via, [file]], label);
  }
  // The registry: App Paths names a file, an Uninstall entry the folder Codex was installed in (or its bin).
  for (const [registered, file] of [[{ files: ['E:\\Codex\\codex.exe'], folders: [] }, 'E:\\Codex\\codex.exe'], [{ files: [], folders: ['F:\\Apps\\OpenAI Codex'] }, 'F:\\Apps\\OpenAI Codex\\bin\\codex.exe']]) {
    assert.deepEqual(picked((await find(plain(file), {}, { registered })).found), { file, path: file, via: 'registry', version: '0.166.0', reason: null });
  }
  // After WinGet: its package wins over Scoop's; the folders that are there join the searched places.
  const winget = W.join(local, 'Microsoft', 'WinGet', 'Packages', layouts.synthetic.winget.packageFolderPattern, layouts.synthetic.winget.packageFiles[0]);
  assert.equal((await find({ ...plain(winget), ...plain(W.join(home, 'scoop', 'shims', 'codex.exe')) })).found.via, 'winget');
  const { found: none } = await find({ [W.join(home, 'scoop', 'shims', 'other.exe')]: { size: 1 } });
  assert.deepEqual(none.searched, [...windowsSearched, '~\\scoop\\shims']);
});

// A fake drive scan over the fake files: its walk is drive-scan.cjs's own, its turns are free, its deadlines never come
// unless a test brings them, and `scanned` counts runs. `told()` resolves when a scan next tells the settings.
const never = () => new Promise(() => {});
function scanning(entries, { store = null, now, drives = ['C:\\', 'E:\\'], versions, scan, ...rest } = {}) {
  let tell;
  const scanned = [], told = () => new Promise(resolve => { tell = resolve; });
  const { locator, files, runs } = windowsLocator(entries, { store, now, versions, wait: never, changed: () => tell?.(), ...rest,
    scan: walk => { scanned.push(walk); return (scan ?? (options => scanDrives({ ...options, drives, files, pause: async () => {}, wait: never })))(walk); } });
  return { locator, files, runs, scanned, told };
}
const memory = (value = null) => { const store = { value, read: () => store.value, write: next => { store.value = next; } }; return store; };
const scanOptions = { env: windowsEnv(), platform: 'win32', arch: 'x64' };

test('a Codex off PATH and every known place is found by a background scan of the local drives, kept, and found first from the store on the next start', async () => {
  const exe = 'E:\\my tools\\codex\\codex.exe', entries = { [exe]: { size: NATIVE } }, store = memory();
  const first = scanning(entries, { store }), told = first.told();
  const before = await first.locator.refresh(scanOptions);
  assert.deepEqual([before.file, before.reason.code, before.scan], [null, 'codex.not_found', 'running'], 'the fast answer comes at once, saying a scan runs');
  await told;
  const hit = first.locator.peek();
  assert.deepEqual(picked(hit), { file: exe, path: exe, via: 'drive-scan', version: '0.166.0', reason: null });
  assert.equal(await first.locator.locate(scanOptions), hit, 'the hit stands for a locate');
  assert.deepEqual(store.value, { file: exe, path: exe, size: NATIVE, mtimeMs: 1 });
  // The next start searches the kept hit's folder before any scan.
  const second = scanning(entries, { store });
  assert.deepEqual(picked(await second.locator.refresh(scanOptions)), picked(hit));
  assert.deepEqual([second.scanned.length, second.runs], [0, [exe]]);
  // An npm package off PATH is found by its prefix, and its own program runs; a project's own dependency is not taken.
  const name = 'npm11-global-0.166.0', prefix = 'E:\\my tools\\npm', npm = scanning(install(name, prefix)), npmTold = npm.told();
  await npm.locator.refresh(scanOptions); await npmTold;
  assert.deepEqual(picked(npm.locator.peek()), { file: exeOf(name, prefix), path: W.join(prefix, 'codex.ps1'), via: 'drive-scan', version: '0.166.0', reason: null });
  const project = 'E:\\work\\app', pinned = scanning({ ...install(name, project), [W.join(project, 'package.json')]: { text: '{}' } }), pinnedTold = pinned.told();
  await pinned.locator.refresh(scanOptions); await pinnedTold;
  assert.deepEqual([pinned.locator.peek().file, pinned.locator.peek().scan, pinned.runs], [null, 'done', []]);
});

test("only a file whose --version reads as Codex's is taken from a scan or the registry; a stand-in's folder is skipped and the next candidate wins", async () => {
  const other = 'E:\\a\\codex.exe', real = 'E:\\b\\codex.exe', marked = 'D:\\x\\bin\\codex.exe', output = 'D:\\agentrix\\.test-output\\run\\bin\\codex.exe';
  const entries = { [other]: { size: NATIVE }, [real]: { size: NATIVE }, [marked]: { size: NATIVE }, 'D:\\x\\bin\\.agentrix-stand-in': { text: '' }, [output]: { size: NATIVE } };
  const view = scanning(entries, { drives: ['D:\\', 'E:\\'], versions: { [other]: 'other-tool 1.2.3', [real]: 'codex-cli 0.170.0' } }), told = view.told();
  await view.locator.refresh(scanOptions); await told;
  assert.deepEqual(picked(view.locator.peek()), { file: real, path: real, via: 'drive-scan', version: '0.170.0', reason: null });
  assert.deepEqual(view.runs, [other, real], 'the stand-ins never ran; the other program ran once and was passed over');
  // The registry: read only once every other place found nothing, and its file taken only when it reads as Codex.
  let reads = 0;
  const registry = async () => { reads++; return { files: [other], folders: [] }; };
  const viaRegistry = windowsLocator({ [other]: { size: NATIVE } }, { versions: { [other]: 'other-tool 1.2.3' }, registry });
  assert.equal((await viaRegistry.locator.refresh(scanOptions)).file, null, 'a registry hit that is not Codex is not taken');
  assert.equal(reads, 1);
  const onPath = windowsLocator({ 'D:\\Tools\\codex.exe': { size: NATIVE } }, { registry });
  assert.equal((await onPath.locator.refresh({ ...scanOptions, env: windowsEnv({ PATH: 'D:\\Tools' }) })).via, 'path');
  assert.equal(reads, 1, 'Codex found elsewhere: the registry is never read');
});

test('a kept hit updated in place stays found; one that is gone is dropped and the drives are scanned at once', async () => {
  const exe = 'E:\\my tools\\codex\\codex.exe', kept = { file: exe, path: exe, size: NATIVE, mtimeMs: 1 };
  const store = memory({ ...kept }), updated = scanning({ [exe]: { size: NATIVE + 1, mtimeMs: 2 } }, { store });
  assert.deepEqual(picked(await updated.locator.refresh(scanOptions)), { file: exe, path: exe, via: 'drive-scan', version: '0.166.0', reason: null });
  assert.deepEqual([updated.scanned.length, store.value], [0, { ...kept, size: NATIVE + 1, mtimeMs: 2 }], 'found again in its folder and kept anew');
  // Gone: dropped, and a scan begins at once, however recent the last one was.
  const goneStore = memory({ ...kept }), gone = scanning({}, { store: goneStore, now: () => 0 }), told = gone.told();
  assert.equal((await gone.locator.refresh(scanOptions)).scan, 'running');
  await told;
  assert.deepEqual([gone.scanned.length, gone.locator.peek().scan, goneStore.value], [1, 'done', { emptyAt: 0 }]);
});

test("the drives are scanned by themselves at most once a day, the last empty scan's time kept across starts, and at once when asked", async () => {
  let clock = 0;
  const store = memory(), now = () => clock, first = scanning({}, { store, now });
  let told = first.told();
  await first.locator.refresh(scanOptions); await told;
  assert.deepEqual([first.scanned.length, store.value], [1, { emptyAt: 0 }]);
  // The next start, an hour later: no scan, and the answer still says every drive was searched.
  clock = 3600000;
  const next = scanning({}, { store, now });
  assert.equal((await next.locator.refresh(scanOptions)).scan, 'done');
  clock += 60000;
  assert.equal((await next.locator.refresh(scanOptions, { throttled: true })).scan, 'done', 'nor on focus');
  told = next.told();
  assert.equal((await next.locator.refresh(scanOptions, { scan: true })).scan, 'running', 'asked for (after an install): at once');
  await told;
  // A day after that scan, the next start scans by itself.
  clock += 24 * 3600000;
  const later = scanning({}, { store, now });
  told = later.told();
  assert.equal((await later.locator.refresh(scanOptions)).scan, 'running');
  await told;
  assert.deepEqual([next.scanned.length, later.scanned.length], [1, 1]);
});

test('a scan that never ends is stopped by its deadline, and the settings leave the scanning state', async () => {
  let deadline;
  const view = scanning({}, { scan: never, wait: () => new Promise(resolve => { deadline = resolve; }) }), told = view.told();
  assert.equal((await view.locator.refresh(scanOptions)).scan, 'running');
  deadline();
  await told;
  assert.deepEqual(codexState(view.locator.peek()), { installed: false, reason: view.locator.peek().reason, scan: 'done' });
  // The walk races every listing against its own deadline: a drive whose folder never opens, or never reads, ends it.
  for (const files of [{ opendir: never }, { opendir: async () => ({ read: never, close: async () => {} }) }]) {
    let due;
    const walk = scanDrives({ names: ['codex.exe'], accept: async () => null, drives: ['C:\\'], files, pause: async () => {}, wait: () => new Promise(resolve => { due = resolve; }) });
    due();
    assert.equal((await walk).stopped, 'time');
  }
});

test("a scan that settles while a foreground search runs wins over that search's empty answer", async () => {
  const exe = 'E:\\my tools\\codex\\codex.exe';
  let open, storedRead = 0, release;
  const gate = new Promise(resolve => { open = resolve; }), held = new Promise(resolve => { release = resolve; });
  const view = scanning({ [exe]: { size: NATIVE } }, { scan: walk => gate.then(() => walk.accept('E:\\my tools\\codex')).then(hit => ({ hit })),
    storedPath: () => (storedRead++ === 0 ? Promise.resolve(null) : held) });
  const told = view.told();
  await view.locator.refresh(scanOptions);
  const second = view.locator.refresh(scanOptions);
  open(); await told;
  assert.equal(view.locator.peek().file, exe);
  release(null);
  assert.deepEqual([(await second).file, view.locator.peek().file, view.scanned.length], [exe, exe, 1]);
});

test('the drive scan keeps to its depth, skips what it must, and stops at its folder, try and time caps, yielding between folders', async () => {
  const at = (...parts) => W.join('C:\\', ...parts), exe = (...parts) => ({ [at(...parts, 'codex.exe')]: { size: 1 } }), npm = (...parts) => ({ [at(...parts, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]: { text: '' } });
  const entries = {
    ...exe('a', 'b', 'c', 'd'), ...exe('a', 'b', 'c', 'd', 'e'), ...exe('Program Files', 'A', 'B', 'C', 'D', 'E'), ...exe('Program Files', 'A', 'B', 'C', 'D', 'E', 'F'), ...exe('tools', 'a', 'b', 'c', 'd', 'e'),
    ...exe('Users', 'u', 'AppData', 'Local', 'Programs', 'x', 'y', 'z'), ...exe('Users', 'u', 'AppData', 'Local', 'Programs', 'x', 'y', 'z', 'w'),
    ...exe('Windows', 'System32'), ...exe('$Recycle.Bin'), ...exe('System Volume Information'), ...exe('ProgramData', 'Microsoft'), ...exe('ProgramData', 'Other'),
    ...exe('repo', '.git'), ...exe('proj', 'node_modules', 'tool'), ...exe('Downloads'), ...exe('repo', 'tests'), ...exe('repo', 'fixtures'), ...exe('repo', '.test-output'),
    ...exe('tools', 'x', 'AppData', 'Local', 'Temp'), ...exe('tools', 'scratch'), ...npm('npm'), ...npm('proj'), [at('proj', 'package.json')]: { text: '{}' },
    ...exe('Agentrix', 'shims'), [at('Agentrix', 'shims', '.agentrix-shims')]: { text: '' }, [at('loop')]: { junction: true }, ...exe('loop', 'inside'),
  };
  const files = codexFiles(entries), turns = [], offered = [], limits = { ...LIMITS };
  const walk = { names: ['codex.exe'], probes: [['node_modules', '@openai', 'codex', 'bin', 'codex.js']], skipFolder: names => names.includes('.agentrix-shims'), skipPaths: [at('tools', 'scratch')],
    drives: ['C:\\'], files, accept: async folder => { offered.push(folder); return null; } };
  const { stopped, visited } = await scanDrives({ ...walk, pause: async () => { turns.push(1); }, wait: never, limits: { ...limits, tries: 50 } });
  assert.deepEqual(offered.sort(), [at('a', 'b', 'c', 'd'), at('npm'), at('Program Files', 'A', 'B', 'C', 'D', 'E'), at('ProgramData', 'Other'), at('tools', 'a', 'b', 'c', 'd', 'e'),
    at('Users', 'u', 'AppData', 'Local', 'Programs', 'x', 'y', 'z')].sort());
  assert.equal(stopped, 'done');
  assert.ok(turns.length >= visited && visited > 0, 'it yields before each folder');
  // Rejected candidates do not end the walk: the first accepted one does, however many came before it.
  let tries = 0;
  const accepted = await scanDrives({ ...walk, accept: async folder => (++tries === 6 ? folder : null), pause: async () => {}, wait: never });
  assert.deepEqual([accepted.stopped, accepted.tried, !!accepted.hit], ['hit', 6, true]);
  // The caps: the candidates it may try, the folders it may list, and the time it may take on the injected clock.
  assert.deepEqual((({ stopped: s, tried }) => [s, tried])(await scanDrives({ ...walk, pause: async () => {}, wait: never, limits: { ...limits, tries: 2 } })), ['tries', 2]);
  const capped = await scanDrives({ ...walk, pause: async () => {}, wait: never, limits: { ...limits, folders: 3 } });
  assert.deepEqual([capped.stopped, capped.visited], ['folders', 3]);
  let clock = 0;
  const timed = await scanDrives({ ...walk, now: () => clock, pause: async () => { clock += 1000; }, wait: never, limits: { ...limits, ms: 5000 } });
  assert.deepEqual([timed.stopped, timed.visited], ['time', 5]);
  // A folder lists at most `entries` of its entries.
  const many = codexFiles(Object.fromEntries(Array.from({ length: 30 }, (_, index) => [at('big', `d${String(index).padStart(2, '0')}`, 'codex.exe'), { size: 1 }])));
  const seen = [];
  await scanDrives({ ...walk, files: many, accept: async folder => { seen.push(folder); return null; }, pause: async () => {}, wait: never, limits: { ...limits, entries: 10, tries: 50 } });
  assert.equal(seen.length, 10);
});

test('the drive scan walks a real folder tree, never through a link', async t => {
  if (process.platform !== 'win32') return t.skip('the scan is Windows only');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scan-')), junction = path.join(root, 'loop');
  t.after(() => { try { fs.rmdirSync(junction); } catch { } fs.rmSync(root, { recursive: true, force: true }); });
  for (const folder of ['tools\\codex', 'away\\deep']) fs.mkdirSync(path.join(root, folder), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'codex', 'codex.exe'), ''); fs.writeFileSync(path.join(root, 'away', 'deep', 'codex.exe'), '');
  fs.symlinkSync(path.join(root, 'away'), junction, 'junction');
  const offered = [];
  await scanDrives({ names: ['codex.exe'], drives: [root], accept: async folder => { offered.push(folder); return null; }, wait: never, limits: { ...LIMITS, depth: 2 } });
  assert.deepEqual(offered.sort(), [path.join(root, 'away', 'deep'), path.join(root, 'tools', 'codex')].sort(), 'the junction to away is not walked a second time');
});

test('a Codex that prints no version is still found and used, with why', async () => {
  const exe = 'D:\\Tools\\codex.exe', env = windowsEnv({ PATH: 'D:\\Tools' });
  let clock = 0;
  const answers = [[null, 'COPY_SAMPLE_START'], [Object.assign(new Error('x'), { code: 3 }), ''], [Object.assign(new Error('x'), { killed: true, signal: 'SIGKILL' }), ''], [null, 'codex-cli 0.169.0']];
  const runs = [], probe = (file, _args, _options, callback) => { runs.push(file); callback(...answers[runs.length - 1]); };
  const locator = createCodexLocator({ files: codexFiles({ [exe]: { size: NATIVE } }), probe, storedPath: async () => null, now: () => clock });
  const options = { env, platform: 'win32', arch: 'x64' };
  const unreadable = await locator.refresh(options);
  assert.deepEqual(picked(unreadable), { file: exe, path: exe, via: 'path', version: null, reason: 'codex.unreadable' });
  // The check never changes which file runs, so a locate keeps it however long: main's native starts, usage reads and
  // account reads never give a hanging Codex another process.
  for (clock of [10000, 30000, 600000]) assert.equal(await locator.locate(options), unreadable, `kept by a locate at ${clock} ms`);
  assert.equal(runs.length, 1);
  // A refresh runs it again: an explicit one at once, window focus once its minute is up.
  const failed = await locator.refresh(options);
  assert.deepEqual([failed.file, failed.reason.code, failed.reason.detail], [exe, 'codex.failed', 'exit 3']);
  assert.equal(await locator.refresh(options, { throttled: true }), failed, 'focus within the minute answers as a locate');
  clock += 60000;
  assert.deepEqual(picked(await locator.refresh(options, { throttled: true })), { file: exe, path: exe, via: 'path', version: null, reason: 'codex.timeout' });
  assert.deepEqual(picked(await locator.refresh(options)), { file: exe, path: exe, via: 'path', version: '0.169.0', reason: null });
  assert.equal(runs.length, 4);
  // It is what the helper runs.
  assert.deepEqual(executable('codex', ['app-server'], env, unreadable.file), { file: exe, args: ['app-server'] });
});

test('peek() says the file chosen while a slow --version runs, with no reason yet, and an answer that stands keeps its own', async () => {
  // Each check waits until the test answers it (Defender scanning a cold codex.exe can take longer than main's gate).
  const exe = 'D:\\Tools\\codex.exe', options = { env: windowsEnv({ PATH: 'D:\\Tools' }), platform: 'win32', arch: 'x64' };
  let started;
  const check = () => new Promise(resolve => { started = resolve; });
  const locator = createCodexLocator({ files: codexFiles({ [exe]: { size: NATIVE } }), probe: (_file, _args, _options, done) => started(done), storedPath: async () => null });
  let checking = check();
  const first = locator.refresh(options), answerFirst = await checking;
  assert.deepEqual(picked(locator.peek()), { file: exe, path: exe, via: 'path', version: null, reason: null }, 'known before its version');
  assert.equal(locator.locate(options), first, 'a locate meanwhile shares the search');
  answerFirst(null, '');
  const unreadable = await first;
  assert.deepEqual([locator.peek(), unreadable.reason.code], [unreadable, 'codex.unreadable']);
  // A refresh runs the check again: the answer for the same file stands, reason and all, until the check settles.
  checking = check();
  const second = locator.refresh(options), answerSecond = await checking;
  assert.equal(locator.peek(), unreadable);
  answerSecond(null, 'codex-cli 0.170.0');
  assert.deepEqual(picked(await second), { file: exe, path: exe, via: 'path', version: '0.170.0', reason: null });
  assert.equal(locator.peek(), await second);
});

test('each place a search looked is said once', async () => {
  // The user's .npmrc names npm's default prefix, %APPDATA%\npm, as well.
  const { found } = await find({ [W.join(home, '.npmrc')]: { text: `prefix=${W.join(roaming, 'npm')}\n` } });
  assert.deepEqual([found.searched, found.reason.params.searched], [windowsSearched, windowsSearched.join('; ')]);
});

test('the terminal, the helper and native mode get the same file', async () => {
  // Main's locator finds an npm install; a local terminal is told the shim (main.cjs's own code, run here).
  const name = 'npm11-global-0.166.0', prefix = 'D:\\nodejs', entries = { ...install(name, prefix), 'D:\\Elsewhere\\codex.exe': { size: NATIVE } };
  const main = windowsLocator(entries).locator, found = await main.refresh({ env: windowsEnv({ PATH: prefix }), platform: 'win32', arch: 'x64' });
  const terminal = told({ kind: 'local' }, main);
  assert.equal(terminal.AGENTRIX_CODEX_EXECUTABLE, W.join(prefix, 'codex.ps1'));
  // The dispatch helper, a process of its own started from that terminal, runs the same program, even where its own
  // PATH would find another Codex first.
  const helper = windowsLocator(entries).locator;
  const asWindows = { locate: options => helper.locate({ ...options, platform: 'win32', arch: 'x64' }) };
  assert.equal(await locateCodex({ ...windowsEnv({ PATH: 'D:\\Elsewhere' }), ...terminal }, asWindows), found.file);
  assert.equal(await locateCodex(windowsEnv({ PATH: 'D:\\Elsewhere' }), asWindows), 'D:\\Elsewhere\\codex.exe', 'untold, the helper searches');
  // Native mode, the account reads and the usage inputs resolve through main's one locator, to its file.
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  assert.match(source, /const codexExecutable = \(\) => codexLocator\.locate\(\)\.then\(found => found\.file\);/);
  assert.match(source, /createCodexRuntime\(\{ resolveExecutable: codexExecutable,/);
  assert.match(source, /readCodexAccount\(\{ \.\.\.options, resolveExecutable: codexExecutable \}\)/);
  assert.match(source, /resetClient: \{ rpcFactory: createResetRpc, resolveExecutable: codexExecutable \}/);
  assert.match(source, /checkClaude, codexExecutable,/, 'host-inputs reads the usage inputs through it');
  assert.equal((source.match(/createCodexLocator\(/g) ?? []).length, 1, 'main keeps one Codex locator');
});

// What main's startTerminal tells a terminal of `project` about Codex, by running main.cjs's own lines.
function told(project, locator) {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const start = source.indexOf('const codexPath ='), end = source.indexOf('env.AGENTRIX_CODEX_EXECUTABLE = codexPath;');
  assert.ok(start > 0 && end > start, 'the injection in startTerminal is found');
  const env = {};
  vm.runInContext(source.slice(start, source.indexOf('\n', end)), vm.createContext({ project, env, codexLocator: locator }));
  return env;
}

test("an SSH terminal is never told this machine's Codex", async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  assert.equal((source.match(/AGENTRIX_CODEX_EXECUTABLE\s*=/g) ?? []).length, 1, 'one place sets it');
  const locator = { peek: () => ({ file: 'D:\\npm\\node_modules\\x\\codex.exe', path: 'D:\\npm\\codex.ps1' }) };
  assert.equal(told({ kind: 'ssh' }, locator).AGENTRIX_CODEX_EXECUTABLE, undefined, 'an SSH project runs the server’s own');
  assert.equal(told({ kind: 'local' }, locator).AGENTRIX_CODEX_EXECUTABLE, 'D:\\npm\\codex.ps1', 'a local one is told where it was found');
  assert.equal(told({ kind: 'local' }, { peek: () => null }).AGENTRIX_CODEX_EXECUTABLE, undefined, 'nothing found, nothing told');
  assert.equal(told({ kind: 'local' }, { peek: () => ({ file: null, path: null }) }).AGENTRIX_CODEX_EXECUTABLE, undefined);
});

// Which Codex a terminal's wrapper runs: the user's alias, then AGENTRIX_CODEX_EXECUTABLE while that file is there, then
// the wrapper's own PATH search. Only stand-in files are named; nothing is run.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-wrapper-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}
const exec = promisify(execFile), integration = path.resolve(__dirname, '../integration'), slashes = file => file.replace(/\\/g, '/');
for (const kind of ['bash', 'zsh']) {
  const shell = kind === 'bash' && process.env.AGENTRIX_TEST_BASH || (process.platform === 'win32' ? kind === 'bash' && 'C:/Program Files/Git/bin/bash.exe' : `/bin/${kind}`);
  test(`${kind} wrapper runs the Codex Agentrix chose while it exists, and otherwise the first on PATH`, { skip: !shell || !fs.existsSync(shell), timeout: 60000 * timeoutScale }, async t => {
    const root = fixture(t), bin = path.join(root, 'bin'), chosen = path.join(root, 'chosen', 'codex');
    for (const file of [path.join(bin, 'claude'), path.join(bin, 'codex'), chosen]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); }
    const source = fs.readFileSync(path.join(integration, `${kind}-integration.${kind}`), 'utf8').replace(/\r\n/g, '\n');
    const begin = source.indexOf('__pg_program() {'), program = source.slice(begin, source.indexOf('\n}\n', begin) + 3);
    const probe = path.join(root, 'probe.sh'), words = kind === 'bash' ? '"${__pg_words[@]}"' : '"${reply[@]}"';
    fs.writeFileSync(probe, `${kind === 'zsh' ? 'typeset -gA __pg_aliases\n' : ''}${program}for name in codex claude; do __pg_program $name && printf 'WORDS=%s\\n' "$(printf '%s|' ${words})" || printf 'WORDS=none\\n'; done\n`);
    const run = async hint => {
      const env = { ...process.env, PATH: `${slashes(bin)}:/usr/bin:/bin`, AGENTRIX_CODEX_EXECUTABLE: hint, AGENTRIX_CLAUDE_EXECUTABLE: '' };
      const { stdout } = await exec(shell, [...(kind === 'bash' ? ['--noprofile', '--norc'] : ['-f']), slashes(probe)], { cwd: root, env, windowsHide: true, timeout: 10000 * timeoutScale });
      return [...stdout.matchAll(/WORDS=(.*)/g)].map(match => match[1]);
    };
    const [, claude] = await run('');
    assert.deepEqual(await run(slashes(chosen)), [`${slashes(chosen)}|`, claude], 'the chosen file, and claude is not touched');
    assert.match((await run(slashes(path.join(root, 'gone', 'codex'))))[0], /bin\/codex\|$/, 'a chosen file that is gone falls back to PATH');
    assert.match((await run(''))[0], /bin\/codex\|$/);
  });
}

test('PowerShell wrapper runs the Codex Agentrix chose while it exists, and otherwise the first codex on PATH', { skip: process.platform !== 'win32', timeout: 60000 * timeoutScale }, async t => {
  const root = fixture(t), bin = path.join(root, 'nodejs'), chosen = path.join(root, 'chosen', 'codex.ps1');
  for (const file of [path.join(bin, 'codex.cmd'), chosen]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); }
  const bootstrap = path.join(root, 'bootstrap.json'), script = path.join(root, 'probe.ps1'), copied = path.join(root, 'integration');
  fs.writeFileSync(bootstrap, JSON.stringify({ projectPath: root, projectId: 't', sessionKey: 'key', pipeName: 'unused' }));
  // bootstrap.ps1 loads refresh-path.ps1 from its own folder: its copy here reads an empty stored PATH, so this
  // computer's registry is never read.
  const quoted = file => `'${file.replace(/'/g, "''")}'`;
  fs.mkdirSync(copied); fs.copyFileSync(path.join(integration, 'bootstrap.ps1'), path.join(copied, 'bootstrap.ps1'));
  fs.writeFileSync(path.join(copied, 'refresh-path.ps1'), `. ${quoted(path.join(integration, 'refresh-path.ps1'))} -ReadPath { param($Scope) '' }\n`);
  fs.writeFileSync(script, `$env:AGENTRIX_AGENT_ONLY='1'\n. ${quoted(path.join(copied, 'bootstrap.ps1'))}\nWrite-Output "CODEX=$global:AgentrixCodexCommand"\n`);
  const run = async hint => {
    const env = { ...isolatedEnvironment(root), AGENTRIX_BOOTSTRAP: bootstrap, PATH: `${bin};${path.join(process.env.SystemRoot, 'System32')}`,
      AGENTRIX_CODEX_EXECUTABLE: hint, PSModuleAnalysisCachePath: path.join(root, 'module-cache') };
    delete env.Path;
    const { stdout } = await exec(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { cwd: root, env, windowsHide: true, timeout: 20000 * timeoutScale });
    // PowerShell spells the extension as PATHEXT does.
    return /CODEX=(.*)/.exec(stdout)[1].trim().toLowerCase();
  };
  assert.equal(await run(chosen), chosen.toLowerCase());
  assert.equal(await run(path.join(root, 'gone', 'codex.exe')), path.join(bin, 'codex.cmd').toLowerCase());
  assert.equal(await run(''), path.join(bin, 'codex.cmd').toLowerCase());
});
