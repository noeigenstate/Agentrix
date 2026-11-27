const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { SHIM_MARKER } = require('../../shared/agentrix-shims.cjs');
const { workerManifest } = require('../cli-adapters/workers.cjs');

const run = promisify(execFile);
const UPDATE_KEY = 'AGY_CLI_DISABLE_AUTO_UPDATE';
const { minVersion } = workerManifest('agy').install;
const versionOf = stdout => stdout?.match(/\b\d+\.\d+\.\d+\b/)?.[0] || null;
const older = version => {
  if (!version) return false;
  const actual = version.split('.').map(Number), minimum = minVersion.split('.').map(Number);
  return actual.every(Number.isSafeInteger) && (actual[0] - minimum[0] || actual[1] - minimum[1] || actual[2] - minimum[2]) < 0;
};
function cliEnvironment(env) {
  const inherited = Object.entries(env).filter(([key]) => key.toUpperCase() !== UPDATE_KEY);
  return { ...Object.fromEntries(inherited), [UPDATE_KEY]: 'true' };
}

function locateAgy(env = process.env) {
  const windows = process.platform === 'win32';
  const name = windows ? 'agy.exe' : 'agy';
  const value = key => Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1];
  const folders = (value('PATH') || '').split(path.delimiter).filter(Boolean);
  if (windows && value('LOCALAPPDATA')) folders.push(path.join(value('LOCALAPPDATA'), 'agy', 'bin'));
  if (!windows) folders.push(path.join(value('HOME') || os.homedir(), '.local', 'bin'));
  for (const folder of folders) {
    const directory = path.resolve(folder.replace(/^"(.*)"$/, '$1'));
    if (fs.existsSync(path.join(directory, SHIM_MARKER))) continue;
    const file = path.join(directory, name);
    try {
      const real = fs.realpathSync.native(file);
      if (fs.existsSync(path.join(path.dirname(real), SHIM_MARKER)) || !fs.statSync(real).isFile()) continue;
      fs.accessSync(real, windows ? fs.constants.F_OK : fs.constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

async function inspectAgy(env = process.env) {
  const file = locateAgy(env);
  if (!file) return { installed: false, version: null, file, reason: 'not_found' };
  const { stdout } = await run(file, ['--version'], { env: cliEnvironment(env), windowsHide: true, timeout: 10000, maxBuffer: 65536 }).catch(() => ({}));
  const version = versionOf(stdout);
  const reason = !version ? 'unreadable' : older(version) ? 'too_old' : null;
  return { installed: true, version, file, reason };
}

async function supportedExecutable(env, inspect = inspectAgy) {
  const { file, version } = await inspect(env);
  if (older(version)) {
    const code = 'agy_cli_outdated';
    throw Object.assign(new Error(`Antigravity CLI ${version} requires an upgrade to ${minVersion} or later.`), { code });
  }
  return file;
}

module.exports = { cliEnvironment, inspectAgy, locateAgy, supportedExecutable, versionOf, older };
