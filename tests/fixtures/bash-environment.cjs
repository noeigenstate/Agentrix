const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const missingTmpWarning = 'bash.exe: warning: could not find /tmp, please create!\n';
function bashEnvironment(root, { missingTmp = false } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC)$/i.test(name)));
  const tmp = path.join(root, 'shell-temp'); fs.mkdirSync(tmp, { recursive: true });
  Object.assign(env, { HOME: root, USERPROFILE: root, TEMP: tmp, TMP: tmp, TMPDIR: tmp, LC_ALL: 'C', GIT_CEILING_DIRECTORIES: root });
  if (process.platform !== 'win32') return env;
  const git = execFileSync('git', ['--exec-path'], { env, windowsHide: true, encoding: 'utf8' }).trim();
  const source = path.resolve(git, '../../../usr/bin'), runtime = path.join(root, 'bash-runtime'), bin = path.join(runtime, 'usr/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(runtime, 'etc'));
  fs.writeFileSync(path.join(runtime, 'etc/fstab'), 'none / cygdrive binary,posix=0,noacl,user 0 0\n');
  // Keep the runner's real Bash, but own its MSYS root and /tmp. Copy runtime
  // dependencies too: the fixture must work across installed Git distributions.
  for (const name of fs.readdirSync(source).filter(name => name === 'bash.exe' || /^msys-.*\.dll$/i.test(name))) {
    fs.copyFileSync(path.join(source, name), path.join(bin, name));
  }
  if (!missingTmp) fs.mkdirSync(path.join(runtime, 'tmp'));
  env.CLAUDE_CODE_GIT_BASH_PATH = path.join(bin, 'bash.exe');
  const pathName = Object.keys(env).find(name => name.toUpperCase() === 'PATH') || 'PATH';
  env[pathName] = source + path.delimiter + (env[pathName] || '');
  return env;
}
module.exports = { bashEnvironment, missingTmpWarning };
