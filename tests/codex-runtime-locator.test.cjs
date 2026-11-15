const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { execFile } = require('node:child_process'), { promisify } = require('node:util');
const { createCodexLocator } = require('../electron/features/codex-runtime/locator.cjs');
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
function codexFiles(entries, rules = W) {
  const files = fakeFiles(entries, rules === W ? 'win32' : 'linux');
  files.readdir = async dir => {
    const names = new Set(Object.keys(entries).map(file => rules.relative(dir, file)).filter(relative => relative && !relative.startsWith('..') && !rules.isAbsolute(relative))
      .map(relative => relative.split(rules.sep)[0]));
    if (!names.size) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' });
    return [...names];
  };
  return files;
}
function windowsLocator(entries, { versions = {}, fallback = 'codex-cli 0.166.0', stored = null, now } = {}) {
  const files = codexFiles(entries), { probe, runs } = fakeProbe(versions, fallback);
  const locator = createCodexLocator({ files, probe, storedPath: async () => stored, ...(now ? { now } : {}) });
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
    [linked]: { link: store }, [stored]: { size: NATIVE } }, { PATH: pnpm })).found), { file: stored, path: W.join(pnpm, 'codex.CMD'), via: 'npm-shim', version: '0.166.0', reason: null });
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

test('a Codex that prints no version is still found and used, with why', async () => {
  const exe = 'D:\\Tools\\codex.exe', env = windowsEnv({ PATH: 'D:\\Tools' });
  let clock = 0;
  const answers = [[null, 'COPY_SAMPLE_START'], [Object.assign(new Error('x'), { code: 3 }), ''], [Object.assign(new Error('x'), { killed: true, signal: 'SIGKILL' }), ''], [null, 'codex-cli 0.169.0']];
  const runs = [], probe = (file, _args, _options, callback) => { runs.push(file); callback(...answers[runs.length - 1]); };
  const locator = createCodexLocator({ files: codexFiles({ [exe]: { size: NATIVE } }), probe, storedPath: async () => null, now: () => clock });
  const options = { env, platform: 'win32', arch: 'x64' };
  const unreadable = await locator.refresh(options);
  assert.deepEqual(picked(unreadable), { file: exe, path: exe, via: 'path', version: null, reason: 'codex.unreadable' });
  assert.equal(await locator.locate(options), unreadable, 'trusted for ten seconds by a locate');
  clock = 10000;
  const failed = await locator.locate(options);
  assert.deepEqual([failed.file, failed.reason.code, failed.reason.detail], [exe, 'codex.failed', 'exit 3']);
  assert.deepEqual(picked(await locator.refresh(options)), { file: exe, path: exe, via: 'path', version: null, reason: 'codex.timeout' }, 'an explicit refresh runs it again at once');
  assert.deepEqual(picked(await locator.refresh(options)), { file: exe, path: exe, via: 'path', version: '0.169.0', reason: null });
  assert.equal(runs.length, 4);
  // It is what the helper runs.
  assert.deepEqual(executable('codex', ['app-server'], env, unreadable.file), { file: exe, args: ['app-server'] });
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
