const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const OUTPUT_LIMIT = 8 * 1024 * 1024;

async function markedPids(marker, job) {
  if (!/^[a-f0-9-]{36}$/.test(marker)) throw new Error('Invalid lab process marker.');
  if (process.platform === 'darwin') {
    const env = { ...process.env };
    delete env.AGENTRIX_LAB_RUN; delete env.AGENTRIX_LAB_JOB;
    const { stdout } = await execute('/bin/ps', ['eww', '-axo', 'pid=,command='], {
      timeout: 5000, maxBuffer: 32 * 1024 * 1024, env,
    });
    const match = new RegExp('(?:^|\\s)AGENTRIX_LAB_RUN=' + marker + '(?:\\s|$)');
    const ownJob = job ? new RegExp('(?:^|\\s)AGENTRIX_LAB_JOB=' + job + '(?:\\s|$)') : null;
    return stdout.split('\n').filter(line => match.test(line) && (!ownJob || ownJob.test(line)))
      .map(line => Number(/^\s*(\d+)/.exec(line)?.[1])).filter(Boolean);
  }
  if (process.platform === 'linux') {
    const pids = [];
    for (const name of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const environment = await fs.readFile(path.join('/proc', name, 'environ'), 'utf8');
        const entries = environment.split('\0');
        if (entries.includes('AGENTRIX_LAB_RUN=' + marker) && (!job || entries.includes('AGENTRIX_LAB_JOB=' + job))) {
          pids.push(Number(name));
        }
      } catch (error) {
        if (!['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes(error.code)) throw error;
      }
    }
    return pids;
  }
  throw new Error('Reliable lab process isolation is unavailable on this platform.');
}

async function killMarked(marker, { exclude = [], job } = {}) {
  const ignored = new Set([process.pid, ...exclude]);
  for (let pass = 0; pass < 20; pass++) {
    const pids = (await markedPids(marker, job)).filter(pid => !ignored.has(pid));
    if (!pids.length) return;
    for (const pid of pids) {
      try { process.kill(pid, 'SIGSTOP'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Could not stop every process of the lab run.');
}

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

async function command(file, args, {
  cwd, env = process.env, signal, timeoutMs = 30000, log, onLine, maxOutput = OUTPUT_LIMIT, ipc = false,
  raw = false,
} = {}) {
  aborted(signal);
  const output = log ? await fs.open(log, 'w', 0o600) : null;
  let child, timer, stopping = null, failure = null, stdout = '', stderr = '', bytes = 0;
  const binary = [];
  const stop = error => { failure ||= error; stopping ||= stopTree(child); };
  const abort = () => stop(Object.assign(new Error('实验已停止。'), { name: 'AbortError' }));
  try {
    child = spawn(file, args, {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
      windowsHide: true, detached: ipc && process.platform !== 'win32',
    });
    const closed = new Promise(resolve => {
      child.once('error', error => { failure ||= error; });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => stop(new Error('实验运行超时。')), timeoutMs);
    let writes = Promise.resolve();
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      if (!raw || key === 'stderr') stream.setEncoding('utf8');
      let tail = '';
      stream.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxOutput) { stop(new Error('实验日志超过大小限制。')); return; }
        if (key === 'stdout') { if (raw) binary.push(chunk); else stdout += chunk; }
        else stderr += chunk;
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
    return { ...result, stdout: raw ? Buffer.concat(binary) : stdout, stderr };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    await stopping; await output?.close();
    // A trusted host owns its process group. This also catches children that replace their environment.
    if (ipc && child?.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}

async function git(cwd, args, options) {
  const env = {
    ...(options?.env || process.env), GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
  const unsafe = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|TEMPLATE_DIR|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/;
  for (const key of Object.keys(env)) if (unsafe.test(key)) {
    delete env[key];
  }
  const result = await command('git', [
    '--no-optional-locks', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args,
  ], { cwd, ...options, env });
  if (result.code !== 0) throw new Error(`Git: ${result.stderr.trim().slice(0, 500) || result.code}`);
  return result.stdout;
}

module.exports = { command, git, aborted, stopTree, markedPids, killMarked };
