const fs = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const OUTPUT_LIMIT = 8 * 1024 * 1024;

function aborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('实验已停止。'), { name: 'AbortError' });
}

async function descendants(pid) {
  if (process.platform === 'win32') return [];
  try {
    const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 2000, maxBuffer: 2 * 1024 * 1024 });
    const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)), found = new Set([pid]);
    let previous;
    do { previous = found.size; for (const [child, parent] of rows) if (found.has(parent)) found.add(child); } while (previous !== found.size);
    return [...found].filter(child => child !== pid);
  } catch { return []; }
}

// Dispatch detaches its model process. Killing only the helper's process group leaves nested workers alive.
async function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await execute('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 5000 }).catch(() => child.kill());
    return;
  }
  const children = await descendants(child.pid);
  for (const pid of [...children.reverse(), child.pid]) { try { process.kill(pid, 'SIGSTOP'); } catch {} }
  // Freeze the known parents before the second scan, so they cannot start more children during cleanup.
  const all = new Set([...children, ...await descendants(child.pid), child.pid]);
  for (const pid of [...all].reverse()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

async function command(file, args, { cwd, env = process.env, signal, timeoutMs = 30000, log, onLine, maxOutput = OUTPUT_LIMIT } = {}) {
  aborted(signal);
  const output = log ? await fs.open(log, 'w', 0o600) : null;
  let child, timer, stopping = null, failure = null, stdout = '', stderr = '', bytes = 0;
  const stop = error => { failure ||= error; stopping ||= stopTree(child); };
  const abort = () => stop(Object.assign(new Error('实验已停止。'), { name: 'AbortError' }));
  try {
    child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    const closed = new Promise(resolve => {
      child.once('error', error => { failure ||= error; });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => stop(new Error('实验运行超时。')), timeoutMs);
    let writes = Promise.resolve();
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8');
      let tail = '';
      stream.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxOutput) { stop(new Error('实验日志超过大小限制。')); return; }
        if (key === 'stdout') stdout += chunk; else stderr += chunk;
        if (output) writes = writes.then(() => output.write(chunk)).catch(error => { stop(error); });
        if (!onLine) return;
        tail += chunk;
        const lines = tail.split('\n'); tail = lines.pop();
        for (const line of lines) { try { onLine(line); } catch (error) { stop(error); } }
      });
      stream.on('end', () => { if (tail && onLine) { try { onLine(tail); } catch (error) { stop(error); } } });
    }
    const result = await closed;
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    await stopping; await writes;
    if (failure) throw failure;
    return { ...result, stdout, stderr };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    await stopping; await output?.close();
  }
}

async function git(cwd, args, options) {
  const result = await command('git', ['-c', 'core.hooksPath=', ...args], { cwd, ...options });
  if (result.code !== 0) throw new Error(`Git: ${result.stderr.trim().slice(0, 500) || result.code}`);
  return result.stdout;
}

module.exports = { command, git, aborted, stopTree };
