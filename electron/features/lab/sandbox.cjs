const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { command, gitEnvironment } = require('./process.cjs');

function cleanEnvironment(environment = process.env) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (/^(?:AGENTRIX_|GIT_|NODE_TEST_|NODE_OPTIONS$|NODE_PATH$|LD_|DYLD_)/.test(key)) delete env[key];
  }
  return gitEnvironment(env);
}

async function requireIsolation() {
  if (process.platform !== 'darwin' || !process.allowedNodeEnvironmentFlags.has('--disable-sigusr1')) {
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

function sandboxProfile({
  labRoot, readRoots, writeRoots, protectedPaths, credentialPaths = [], deniedExecutables = [],
  codexSource, sharedAuth,
}) {
  const blocked = protectedPaths.map(subpath).join(' ');
  const credentialBlocks = credentialPaths.map(subpath).join(' ');
  const executableBlocks = deniedExecutables.map(file => '(literal ' + JSON.stringify(file) + ')').join(' ');
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
    '(deny file-read-data ' + deniedOutside(labRoot, readRoots) + ')',
    ...(codexRead ? ['(deny file-read-data ' + codexRead + ')'] : []),
    ...(blocked ? ['(deny file-read* ' + blocked + ')'] : []),
    ...(credentialBlocks ? ['(deny file-read* ' + credentialBlocks + ')'] : []),
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
    return { address: '\\\\.\\pipe\\agentrix-lab-' + name, async close() {} };
  }
  let address = path.join(directory, name), alias = null;
  if (Buffer.byteLength(address) > 100) {
    const temporary = process.platform === 'darwin' ? path.join(os.homedir(), '.ctmp') : os.tmpdir();
    await fs.mkdir(temporary, { recursive: true });
    alias = path.join(temporary, name);
    await fs.symlink(await fs.realpath(directory), alias, 'dir');
    address = path.join(alias, 'socket');
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
  return { codexSource, sharedAuth };
}

async function gitCredentialHelpers() {
  const result = await command('git', ['--exec-path'], { timeoutMs: 5000 });
  if (result.code !== 0) throw new Error('Could not locate the Git credential helper for isolation.');
  return [await physicalPath(path.join(result.stdout.trim(), 'git-credential-osxkeychain'))];
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
    await fs.symlink(access.sharedAuth, path.join(codex, 'auth.json'));
  }
  const secure = environment?.CLAUDE_SECURESTORAGE_CONFIG_DIR ??
    environment?.CLAUDE_CONFIG_DIR ?? '';
  const temporary = path.join(directory, 'tmp');
  await fs.mkdir(temporary, { recursive: true });
  const search = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[search] = String(env[search] || '').split(path.delimiter).filter(path.isAbsolute).join(path.delimiter);
  if (!credentials) {
    for (const key of Object.keys(env)) if (/(?:API_KEY|OAUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete env[key];
  }
  return {
    ...env, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: credentials ? secure : claude, ELECTRON_RUN_AS_NODE: '1',
    TMPDIR: temporary, TMP: temporary, TEMP: temporary, XDG_CACHE_HOME: temporary,
  };
}

module.exports = {
  cleanEnvironment, requireIsolation, sandboxProfile, channelAddress, cliHomes,
  credentialAccess, gitCredentialPaths, gitCredentialHelpers, physicalPath,
};
