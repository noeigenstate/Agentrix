const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const REQUIRED = '2.1.317', MINIMUM = REQUIRED.split('.').map(Number), VERSION_TIMEOUT_MS = 10000, CLOSE_GRACE_MS = 1500;
const VERSION = /\b(\d+)\.(\d+)\.(\d+)\b/;
const meets = match => {
  const version = match.slice(1, 4).map(Number), first = version.findIndex((part, index) => part !== MINIMUM[index]);
  return first < 0 || version[first] > MINIMUM[first];
};
const failed = error => {
  const code = typeof error?.code === 'number' ? `exit ${error.code}` : typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : null;
  return code ? { reason: 'failed', error: code } : { reason: 'failed' };
};

// The deadline and the grace after it each wait one more turn of the event loop before they act: when the main
// process was busy past them, the exit or close already waiting to be read wins, so a CLI that answered in time is
// not taken for one that hung. The grace lets the output close; a descendant still holding it open must not hold
// the check. A version printed before the kill still counts.
function readVersion(probe, file, env, timeoutMs, graceMs) {
  return new Promise(resolve => {
    const started = Date.now();
    let child, timer, done = false, killed = false;
    const settle = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timedOut = () => ({ reason: 'timeout', elapsedMs: Date.now() - started });
    timer = setTimeout(() => setImmediate(() => {
      if (done) return;
      if (child && child.exitCode === null && child.signalCode === null) {
        killed = true;
        try { child.kill('SIGKILL'); } catch { }
      }
      timer = setTimeout(() => setImmediate(() => {
        if (done) return;
        try { child?.stdout?.destroy(); child?.stderr?.destroy(); } catch { }
        settle(killed ? timedOut() : { reason: 'unreadable' });
      }), graceMs);
    }), timeoutMs);
    try {
      child = probe(file, ['--version'], { maxBuffer: 65536, windowsHide: true, shell: false, env },
        (error, stdout) => {
          const text = String(stdout ?? '');
          settle(killed ? VERSION.test(text) ? { stdout: text } : timedOut() : error ? failed(error) : { stdout: text });
        });
    } catch (error) { settle(failed(error)); }
  });
}

// `missing` keeps its meaning for every caller: no usable native CLI. `reason` says why: `not_found`, or a file was
// found (`found`) whose version check timed out (`elapsedMs`), failed to run (`error` names how) or printed no version.
async function inspectClaudeExecutable({ env = process.env, platform = process.platform, home = os.homedir(), probe = execFile,
  timeoutMs = VERSION_TIMEOUT_MS, graceMs = CLOSE_GRACE_MS } = {}) {
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  const folders = [...(env.PATH || env.Path || '').split(path.delimiter), path.join(home, '.local/bin'), ...(platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])];
  const checked = new Set();
  let outdated = null, failure = null;
  for (const folder of new Set(folders.filter(value => value && path.isAbsolute(value)))) {
    let file;
    try {
      file = await fs.realpath(path.join(folder, name));
      if (checked.has(file) || !(await fs.stat(file)).isFile()) continue;
      await fs.access(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    } catch { continue; } // A broken candidate must not hide another installed native executable.
    checked.add(file);
    const { stdout, ...run } = await readVersion(probe, file, env, timeoutMs, graceMs);
    const match = stdout === undefined ? null : VERSION.exec(stdout);
    if (match && meets(match)) return { status: 'ok', version: match[0], required: REQUIRED, file };
    if (match) outdated ||= match[0];
    else failure ||= { reason: 'unreadable', ...run, found: file };
  }
  if (outdated) return { status: 'too_old', version: outdated, required: REQUIRED, file: null };
  return { status: 'missing', version: null, required: REQUIRED, file: null, ...(failure || { reason: 'not_found' }) };
}
async function resolveClaudeExecutable(options) {
  const result = await inspectClaudeExecutable(options);
  if (result.status === 'too_old') throw Object.assign(new Error('Claude Code 版本过低，请升级到 2.1.317 或更高'), { code: 'native_cli_required', outdated: true });
  if (result.reason && result.reason !== 'not_found') throw Object.assign(new Error('Claude Code 检查没有通过，无法通过 API 运行'), { code: 'native_cli_required', unverified: true });
  return result.file;
}
module.exports = { resolveClaudeExecutable, inspectClaudeExecutable };
