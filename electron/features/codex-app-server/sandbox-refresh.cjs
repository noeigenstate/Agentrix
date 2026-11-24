const fs = require('node:fs/promises');
const path = require('node:path');
const { homedir } = require('node:os');
const { setTimeout: sleep } = require('node:timers/promises');
const { sameDirectory } = require('../../session-files.cjs');

const REFRESH_LIMIT = 15 * 60_000;
const ROLE_LIMIT = 8 * 60_000;
const PROBE_LIMIT = 5000;
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
    if (message.endsWith('applying read ACLs')) latest = { at, status: 'running' };
    else if (latest?.status === 'running') latest = { at, status: message.endsWith('errors') ? 'failed' : 'complete' };
  }
  return latest;
}

async function roleRefreshPending(home, now = Date.now()) {
  const since = now - REFRESH_LIMIT;
  const [latest, marker] = await Promise.all([
    readRefresh(home, now - 24 * 60 * 60_000, now), fs.stat(path.join(home, '.sandbox', 'setup_marker.json')).catch(() => null),
  ]);
  // A new marker covers the gap before the first command starts the background worker.
  const running = latest?.status === 'running' && latest.at >= since;
  const hint = marker?.mtimeMs >= since && (latest?.status !== 'complete' || latest.at < Math.floor(marker.mtimeMs));
  return { running, pending: running || hint };
}

function sandboxCwd(rpc, cwd, env, sandbox = { type: 'readOnly', networkAccess: false }, deadline = PROBE_LIMIT, requestOptions) {
  // cmd, not PowerShell: a sandbox whose temp folder is read-only puts PowerShell in constrained language mode, where
  // it can call no .NET method and the probe fails although the sandbox works. Code page 65001 keeps the path UTF-8.
  const cmd = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  return rpc.request('command/exec', { cwd, sandboxPolicy: sandbox, timeoutMs: deadline,
    command: [cmd, '/d', '/c', 'chcp 65001>nul & cd'],
  }, deadline, requestOptions);
}

async function verifyRoleCwd({ rpc, cwd, env, home, sandbox, onWait, assertOpen, translate }, {
  now = Date.now, pause = sleep, refresh = roleRefreshPending, matches = sameDirectory, limit = ROLE_LIMIT,
} = {}) {
  const started = now(), until = started + limit;
  let actual, evidence, announced = false, probed = false, sawGrant = false;
  while (now() < until) {
    evidence = await refresh(home, now());
    assertOpen();
    if (evidence.pending && !announced) {
      announced = true;
      onWait?.(translate(WAIT_MESSAGE));
    }
    sawGrant ||= evidence.running;
    const deadline = sawGrant ? until : Math.min(until, started + 20_000);
    if (probed && now() >= deadline) break;
    if (!probed || !evidence.running) {
      const result = await sandboxCwd(rpc, cwd, env, sandbox, Math.max(1, Math.min(PROBE_LIMIT, deadline - now()))).catch(error => ({ error }));
      assertOpen();
      const code = result?.error?.code;
      if ([-32601, -32602, 'closed', 'disconnected', 'process_exited'].includes(code)) break;
      probed = true;
      const reported = result?.exitCode === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
      if (path.win32.isAbsolute(reported) && !/[\r\n]/.test(reported)) {
        actual = reported;
        if (!evidence.running && matches(actual, cwd)) {
          evidence = await refresh(home, now());
          assertOpen();
          if (!evidence.running) return;
          sawGrant = true;
        }
      }
    }
    const remaining = (sawGrant ? until : deadline) - now();
    if (remaining <= 0) break;
    await pause(Math.min(2000, remaining));
  }
  if (evidence?.running) throw Object.assign(new Error(translate('Codex 沙箱授权仍在进行，通常需要几分钟。请稍后重试。')), { code: 'sandbox_refresh_pending' });
  const message = translate('Codex 沙箱尚未确认角色的工作目录。预期：{expected}。实际：{actual}。请稍后重试。')
    .replace(/\{(expected|actual)\}/g, (_, key) => key === 'expected' ? cwd : actual || translate('未知'));
  throw Object.assign(new Error(message), { code: 'sandbox_cwd_unverified' });
}

module.exports = { ELEVATED_SANDBOX_CONFIG, ELEVATED_SANDBOX_ARGS, REFRESH_LIMIT, ROLE_LIMIT, WAIT_MESSAGE, readRefresh, sandboxHome, sandboxCwd, verifyRoleCwd };
