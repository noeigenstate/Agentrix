const fs = require('node:fs/promises');
const { realpathSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { command, gitEnvironment } = require('./process.cjs');

// Inherited shell variables can contain credentials under arbitrary names. Jobs receive only process essentials.
const INHERITED_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME', 'TZ',
  'TERM', 'COLORTERM', 'COLUMNS', 'LINES', 'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE',
  'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  '__CF_USER_TEXT_ENCODING', 'SECURITYSESSIONID', 'XPC_FLAGS', 'XPC_SERVICE_NAME',
]);

function cleanEnvironment(environment = process.env) {
  return gitEnvironment(Object.fromEntries(Object.entries(environment).filter(([key]) => INHERITED_ENV.has(key.toUpperCase()))));
}

async function requireIsolation(options) {
  if (process.platform === 'win32') return require('./sandbox-win32.cjs').requireIsolation(options);
  if (process.platform !== 'darwin') {
    throw new Error('Secure lab execution is unavailable on this platform. No workers were started.');
  }
  const probe = await command('/usr/bin/sandbox-exec', [
    '-p', '(version 1) (allow default) (deny process-info* (target others))', '/usr/bin/true',
  ]);
  if (probe.code !== 0) throw new Error('Secure lab execution is unavailable. No workers were started.');
}

const subpath = file => '(subpath ' + JSON.stringify(file) + ')';
const deniedOutside = (root, allowed) => '(require-all ' + subpath(root) + ' ' +
  allowed.map(file => '(require-not ' + subpath(file) + ')').join(' ') + ')';

function daemonSocketPaths(home = os.homedir(), environment = process.env) {
  const host = environment.DOCKER_HOST;
  const sockets = ['/var/run/docker.sock', '/private/var/run/docker.sock', path.join(home, '.docker/run/docker.sock')];
  if (typeof host === 'string' && host.startsWith('unix://') && host.length > 7) sockets.push(path.resolve(host.slice(7)));
  const directories = [
    ...['.docker/desktop', 'Library/Containers/com.docker.docker', '.colima', '.orbstack', '.rd', '.lima', '.local/share/containers'].map(file => path.join(home, file)),
    '/var/run/podman', '/private/var/run/podman',
  ];
  return [...sockets.map(file => ({ path: file, filter: 'path-literal' })),
    ...directories.map(file => ({ path: file, filter: 'subpath' }))];
}

function socketPathAliases(file) {
  let parent = file;
  const suffix = [];
  for (;;) {
    try { return [...new Set([file, path.join(realpathSync.native(parent), ...suffix)])]; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = path.dirname(parent);
      if (next === parent) return [file];
      suffix.unshift(path.basename(parent)); parent = next;
    }
  }
}

function sandboxProfile({
  labRoot, readRoots, writeRoots, protectedPaths, credentialPaths = [], deniedExecutables = [],
  codexSource, sharedAuth, network = true, ipcPaths = [], deniedSockets = daemonSocketPaths(),
}) {
  const blocked = protectedPaths.map(subpath).join(' ');
  const credentialBlocks = credentialPaths.map(subpath).join(' ');
  const executableBlocks = deniedExecutables.map(file => '(literal ' + JSON.stringify(file) + ')').join(' ');
  const socketFiles = new Set(), socketConnects = new Set();
  for (const { path: file, filter } of deniedSockets) for (const alias of socketPathAliases(file)) {
    socketFiles.add(subpath(alias));
    socketConnects.add('(remote unix-socket (' + filter + ' ' + JSON.stringify(alias) + '))');
  }
  const writes = [...writeRoots, '/dev/null'];
  const writeFilter = '(require-all ' + subpath('/') + ' ' +
    writes.map(file => '(require-not ' + subpath(file) + ')').join(' ') +
    (sharedAuth ? ' (require-not (literal ' + JSON.stringify(sharedAuth) + '))' : '') + ')';
  const codexRead = codexSource && '(require-all ' + subpath(codexSource) +
    (sharedAuth ? ' (require-not (literal ' + JSON.stringify(sharedAuth) + '))' : '') + ')';
  return [
    '(version 1)', '(allow default)',
    '(deny process-info* (target others))',
    '(deny signal (require-not (target same-sandbox)))',
    ...(!network ? ['(deny network*)', ...ipcPaths
      .map(file => '(allow network-outbound (remote unix-socket ' + subpath(file) + '))')] : []),
    '(deny file-read-data ' + deniedOutside(labRoot, readRoots) + ')',
    ...(codexRead ? ['(deny file-read-data ' + codexRead + ')'] : []),
    ...(blocked ? ['(deny file-read* ' + blocked + ')'] : []),
    ...(credentialBlocks ? ['(deny file-read* ' + credentialBlocks + ')'] : []),
    // AF_UNIX connect is checked as network-outbound, independently of file-read permissions.
    ...(socketConnects.size ? [
      '(deny file-read* ' + [...socketFiles].join(' ') + ')',
      '(deny network-outbound ' + [...socketConnects].join(' ') + ')',
    ] : []),
    ...(executableBlocks ? [
      '(deny file-read* ' + executableBlocks + ')',
      '(deny process-exec ' + executableBlocks + ')',
    ] : []),
    '(deny file-write* ' + writeFilter + (blocked ? ' ' + blocked : '') + ')',
  ].join('\n');
}

async function channelAddress(directory, prefix) {
  const name = prefix + '-' + require('node:crypto').randomUUID().slice(0, 8);
  if (process.platform === 'win32') {
    return { address: '\\\\.\\pipe\\LOCAL\\agentrix-lab-' + name, async close() {} };
  }
  let address = path.join(directory, name), alias = null;
  if (Buffer.byteLength(address) > 100) {
    const temporary = process.platform === 'darwin' ? path.join(os.homedir(), '.ctmp') : os.tmpdir();
    await fs.mkdir(temporary, { recursive: true });
    alias = path.join(temporary, name);
    await fs.symlink(await fs.realpath(directory), alias, 'dir');
    address = path.join(alias, name);
  }
  return {
    address,
    async close() {
      await fs.rm(address, { force: true });
      if (alias) await fs.unlink(alias);
    },
  };
}

function gitCredentialPaths(home = os.homedir()) {
  return [
    path.join(home, '.ssh'), path.join(home, '.config/gh'), path.join(home, '.git-credentials'),
    path.join(home, '.gitconfig'), path.join(home, '.config/git'),
  ];
}

async function physicalPath(file) {
  try { return await fs.realpath(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    return parent === file ? file : path.join(await physicalPath(parent), path.basename(file));
  }
}

async function credentialAccess(environment = process.env, credentials = true) {
  const codexSource = await physicalPath(environment.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const candidate = path.join(codexSource, 'auth.json');
  const sharedAuth = credentials && await fs.stat(candidate).then(stat => stat.isFile(), error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }) ? await fs.realpath(candidate) : null;
  if (process.platform !== 'win32') return { codexSource, sharedAuth };
  const claudeSource = await physicalPath(environment.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  const claudeFile = path.join(claudeSource, '.credentials.json');
  const claudeAuth = credentials && await fs.stat(claudeFile).then(stat => stat.isFile(), error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }) ? await fs.realpath(claudeFile) : null;
  return { codexSource, sharedAuth, claudeSource, claudeAuth };
}

async function gitCredentialHelpers() {
  const result = await command('git', ['--exec-path'], { timeoutMs: 5000 });
  if (result.code !== 0) throw new Error('Could not locate the Git credential helper for isolation.');
  const names = process.platform === 'win32'
    ? ['git-credential-manager.exe', 'git-credential-manager-core.exe', 'git-credential-wincred.exe']
    : ['git-credential-osxkeychain'];
  return Promise.all(names.map(name => physicalPath(path.join(result.stdout.trim(), name))));
}

async function linkCredential(source, target, { platform = process.platform, files = fs } = {}) {
  try { await files.symlink(source, target); }
  catch (error) {
    if (platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    // A hard link shares the file without copying its contents. Cross-volume links deliberately fail closed.
    await files.link(source, target);
  }
}

async function cliHomes(environment = process.env, directory, credentials = true, access) {
  const env = cleanEnvironment(environment);
  const home = os.homedir(), codex = path.join(directory, 'codex'), claude = path.join(directory, 'claude');
  access ||= await credentialAccess(environment, credentials);
  for (const [source, target, files] of [
    [environment?.CODEX_HOME || path.join(home, '.codex'), codex, ['config.toml']],
    [environment?.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), claude, ['settings.json']],
  ]) {
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    for (const file of credentials ? files : []) {
      await fs.copyFile(path.join(source, file), path.join(target, file)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  if (credentials && access.sharedAuth) {
    await linkCredential(access.sharedAuth, path.join(codex, 'auth.json'));
  }
  if (credentials && access.claudeAuth) await linkCredential(access.claudeAuth, path.join(claude, '.credentials.json'));
  const secure = environment?.CLAUDE_SECURESTORAGE_CONFIG_DIR ??
    environment?.CLAUDE_CONFIG_DIR ?? '';
  const temporary = path.join(directory, 'tmp');
  await fs.mkdir(temporary, { recursive: true });
  const search = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[search] = String(env[search] || '').split(path.delimiter).filter(path.isAbsolute).join(path.delimiter);
  return {
    ...env, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: credentials && process.platform !== 'win32' ? secure : claude, ELECTRON_RUN_AS_NODE: '1',
    TMPDIR: temporary, TMP: temporary, TEMP: temporary, XDG_CACHE_HOME: temporary,
    ...(process.platform === 'win32' ? {
      HOME: directory, USERPROFILE: directory, APPDATA: path.join(directory, 'AppData/Roaming'),
      LOCALAPPDATA: path.join(directory, 'AppData/Local'),
      HOMEDRIVE: path.parse(directory).root.slice(0, 2), HOMEPATH: directory.slice(path.parse(directory).root.length - 1),
    } : {}),
  };
}

module.exports = {
  cleanEnvironment, requireIsolation, sandboxProfile, channelAddress, cliHomes,
  credentialAccess, gitCredentialPaths, gitCredentialHelpers, physicalPath, linkCredential, daemonSocketPaths,
};
