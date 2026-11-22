const fs = require('node:fs/promises');
const path = require('node:path');
const { homedir } = require('node:os');
const { setTimeout: sleep } = require('node:timers/promises');
const { sameDirectory } = require('../../session-files.cjs');

const REFRESH_LIMIT = 15 * 60_000;
const ROLE_LIMIT = 20_000;
const LOG_TAIL = 256 * 1024;
const ELEVATED_SANDBOX_CONFIG = { 'windows.sandbox': 'elevated', 'features.prefer_mxc': false };
const ELEVATED_SANDBOX_ARGS = Object.entries(ELEVATED_SANDBOX_CONFIG).flatMap(([key, value]) => ['-c', `${key}=${value}`]);
const WAIT_MESSAGE = '正在完成 Codex 沙箱授权，约需几分钟。';
const READ_ACL = /\[(\d{4}-\d\d-\d\dT[^\]\r\n]+)\] (read-acl-only mode: applying read ACLs|read ACL run completed(?: with errors)?)(?=[:\r\n]|$)/g;

function sandboxHome(env, fallback) {
  return env.CODEX_HOME || fallback || path.win32.join(env.USERPROFILE || env.HOME || homedir(), '.codex');
}

async function logTail(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const bytes = Buffer.alloc(Math.min(size, LOG_TAIL));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, size - bytes.length);
    return bytes.toString('utf8', 0, bytesRead);
  } catch { return ''; }
  finally { await handle?.close(); }
}

async function readRefresh(home, since, now = Date.now()) {
  const folder = path.join(home, '.sandbox');
  const dates = [...new Set([since, now].map(time => new Date(time).toISOString().slice(0, 10)))];
  const logs = await Promise.all(dates.map(date => logTail(path.join(folder, `sandbox.${date}.log`))));
  let latest = null;
  for (const log of logs) for (const [, time, message] of log.matchAll(READ_ACL)) {
    const at = Date.parse(time);
    if (!Number.isFinite(at) || at < since || at > now || at < (latest?.at ?? 0)) continue;
    latest = { at, status: message.endsWith('applying read ACLs') ? 'running' : message.endsWith('errors') ? 'failed' : 'complete' };
  }
  return latest;
}

async function roleRefreshPending(home, now = Date.now()) {
  const since = now - REFRESH_LIMIT;
  const [latest, marker] = await Promise.all([
    readRefresh(home, now - 24 * 60 * 60_000, now), fs.stat(path.join(home, '.sandbox', 'setup_marker.json')).catch(() => null),
  ]);
  // A new marker covers the gap before the first command starts the background worker.
  return latest?.status === 'running' || latest?.status === 'failed'
    || !!(marker?.mtimeMs >= since && (latest?.status !== 'complete' || latest.at < Math.floor(marker.mtimeMs)));
}

function sandboxCwd(rpc, cwd, env, sandbox = { type: 'readOnly', networkAccess: false }, deadline = 5000) {
  const powershell = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return rpc.request('command/exec', { cwd, sandboxPolicy: sandbox, timeoutMs: deadline,
    command: [powershell, '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Write([Environment]::CurrentDirectory)'],
  }, deadline);
}

async function verifyRoleCwd({ rpc, cwd, env, home, sandbox, onWait, assertOpen, translate }, {
  now = Date.now, pause = sleep, pending = roleRefreshPending, matches = sameDirectory, limit = ROLE_LIMIT,
} = {}) {
  if (!await pending(home, now())) return;
  assertOpen();
  onWait?.(translate(WAIT_MESSAGE));
  const until = now() + limit;
  let actual;
  while (now() < until) {
    assertOpen();
    const result = await sandboxCwd(rpc, cwd, env, sandbox, Math.max(1, Math.min(5000, until - now()))).catch(error => ({ error }));
    assertOpen();
    // A timed-out request may still be running in Codex. Avoid starting a second copy.
    if (result?.error?.uncertain || [-32601, -32602].includes(result?.error?.code)) break;
    const reported = result?.exitCode === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
    if (path.win32.isAbsolute(reported) && !/[\r\n]/.test(reported)) {
      actual = reported;
      if (matches(actual, cwd)) return;
    }
    if (now() < until) await pause(Math.min(2000, until - now()));
  }
  const message = translate('Codex 沙箱尚未确认角色的工作目录。预期：{expected}。实际：{actual}。请稍后重试。')
    .replace(/\{(expected|actual)\}/g, (_, key) => key === 'expected' ? cwd : actual || translate('未知'));
  throw Object.assign(new Error(message), { code: 'sandbox_cwd_unverified' });
}

module.exports = { ELEVATED_SANDBOX_CONFIG, ELEVATED_SANDBOX_ARGS, REFRESH_LIMIT, WAIT_MESSAGE, readRefresh, sandboxHome, sandboxCwd, verifyRoleCwd };
