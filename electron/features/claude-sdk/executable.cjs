const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
async function resolveClaudeExecutable({ env = process.env, platform = process.platform, home = os.homedir(), probe = execFile } = {}) {
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  const folders = [...(env.PATH || env.Path || '').split(path.delimiter), path.join(home, '.local/bin'), ...(platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])];
  let outdated = false;
  for (const folder of new Set(folders.filter(value => value && path.isAbsolute(value)))) {
    try {
      const file = await fs.realpath(path.join(folder, name));
      if (!(await fs.stat(file)).isFile()) continue;
      await fs.access(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      const version = await new Promise((resolve, reject) => probe(file, ['--version'], { timeout: 4000, maxBuffer: 4096, windowsHide: true, shell: false, env }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      const match = /\b2\.(\d+)\.(\d+)\b/.exec(version);
      if (match && (Number(match[1]) > 1 || Number(match[1]) === 1 && Number(match[2]) >= 317)) return file;
      if (/\b\d+\.\d+\.\d+\b/.test(version)) outdated = true;
    } catch { /* A broken candidate must not hide another installed native executable. */ }
  }
  if (outdated) throw Object.assign(new Error('Claude Code 版本过低，请升级到 2.1.317 或更高'), { code: 'native_cli_required', outdated: true });
  return null;
}
module.exports = { resolveClaudeExecutable };
