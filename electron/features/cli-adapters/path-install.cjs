const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { belowMinimum } = require('./capabilities.mjs');

function findOnPath(name, env, platform) {
  const windows = platform === 'win32';
  const folders = String(Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '').split(windows ? ';' : ':').filter(Boolean);
  const extensions = windows ? ['.exe', '.cmd', '.bat', '.ps1'] : [''];
  for (const folder of folders) {
    for (const extension of extensions) {
      try {
        const file = path.resolve(folder.replace(/"/g, ''), name + extension);
        const stat = fs.statSync(file);
        if (stat.isFile() && (windows || (stat.mode & 0o111) !== 0)) return file;
      } catch { }
    }
  }
  return null;
}

// Command Prompt and settings share this startup check without running a CLI before its first search.
const onPath = (name, env, platform = process.platform) => !!findOnPath(name, env, platform);

function probeVersion(file, env, platform, run) {
  const options = { env, timeout: 10000, maxBuffer: 65536, windowsHide: true };
  let args = ['--version'];
  if (platform === 'win32' && /\.(?:bat|cmd|ps1)$/i.test(file)) {
    options.env = { ...env, AGENTRIX_INSTALL_PROBE_FILE: file };
    file = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    args = ['-NoProfile', '-NonInteractive', '-Command', '& $env:AGENTRIX_INSTALL_PROBE_FILE --version; exit $LASTEXITCODE'];
  }
  return new Promise(resolve => {
    run(file, args, options, (error, stdout) => resolve(error ? { reason: error.killed ? 'timeout' : 'failed' } : { stdout }));
  });
}

function createPathInstall({ command, install: { versionPattern, minVersion } }, { platform = process.platform, run = execFile } = {}) {
  let last = null;
  async function locate(env = process.env) {
    const file = findOnPath(command, env, platform);
    if (!file) return last = { installed: false, version: null, file: null, reason: 'not_found' };
    const { stdout, reason } = await probeVersion(file, env, platform, run);
    const version = versionPattern.exec(String(stdout ?? ''))?.[0] ?? null;
    const versionReason = version ? (belowMinimum(version, minVersion) ? 'too_old' : null) : 'unreadable';
    return last = { installed: true, version, file, reason: reason ?? versionReason };
  }
  return { locate, refresh: locate, peek: () => last };
}

module.exports = { createPathInstall, onPath };
