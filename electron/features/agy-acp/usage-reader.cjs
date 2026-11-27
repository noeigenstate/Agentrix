const { spawn } = require('node:child_process');
const { stopProcess } = require('../codex-app-server/index.cjs');
const { cliEnvironment, locateAgy, versionOf, older } = require('./locator.cjs');

const MAX_OUTPUT = 256 * 1024;
const minutesByWindow = new Map([['5h', 300], ['weekly', 10080]]);
const isUsageGroup = id => typeof id === 'string' && /^(?:gemini|3p|group-[1-8])$/.test(id);

function parseWindows(stdout) {
  const reply = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  const command = reply?.command;
  if (reply?.status !== 'SUCCESS' || reply.num_turns !== 0 || command?.name !== 'usage' || !Array.isArray(command.data?.groups)) return [];
  const limits = [];
  for (const [index, group] of command.data.groups.slice(0, 8).entries()) {
    if (!Array.isArray(group?.buckets)) continue;
    for (const bucket of group.buckets.slice(0, 8)) {
      const remaining = bucket?.remaining_fraction;
      if (!Number.isFinite(remaining) || remaining < 0 || remaining > 1) continue;
      const reset = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN;
      const id = (typeof bucket.id === 'string' && /^(gemini|3p)-(?:weekly|5h)$/.exec(bucket.id)?.[1]) || `group-${index + 1}`;
      limits.push({ id, minutes: minutesByWindow.get(bucket.window) ?? null,
        percent: Number(((1 - remaining) * 100).toFixed(6)), resetsAt: Number.isFinite(reset) && reset > 0 ? reset : null });
    }
  }
  // The dashboard chooses the longest window. Put the fullest group first at each duration.
  return limits.sort((a, b) => (a.minutes ?? -1) - (b.minutes ?? -1) || b.percent - a.percent);
}

async function runCli(file, args, { env, cwd, signal, timeoutMs, spawnProcess, stopChild }) {
  if (signal?.aborted) return null;
  const child = spawnProcess(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' });
  let deadline, abort;
  try {
    return await new Promise(resolve => {
      const chunks = [];
      let size = 0;
      abort = () => resolve(null);
      child.on('error', abort);
      child.stdout.on('error', abort);
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_OUTPUT) { abort(); return; }
        chunks.push(chunk);
      });
      child.once('close', code => resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null));
      deadline = setTimeout(abort, timeoutMs);
      deadline.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
    // The POSIX process group remains addressable even if the CLI exited first.
    if (process.platform !== 'win32' && child.pid && (child.exitCode != null || child.signalCode != null)) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    await stopChild(child);
  }
}

async function readUsageWindows({ env = process.env, cwd, signal, timeoutMs = 10000,
  locate = locateAgy, spawnProcess = spawn, stopChild = stopProcess } = {}) {
  let limits = [];
  try {
    const file = locate(env);
    if (file && !signal?.aborted) {
      const options = { env: cliEnvironment(env), cwd, signal, timeoutMs, spawnProcess, stopChild };
      const version = versionOf(await runCli(file, ['--version'], options));
      if (version && !older(version)) {
        const reply = await runCli(file, ['-p', '/usage', '--output-format', 'json'], options);
        if (reply && !signal?.aborted) limits = parseWindows(reply);
      }
    }
  } catch { /* The CLI's errors and raw output may contain account information. */ }
  return limits;
}

module.exports = { readUsageWindows, isUsageGroup };
