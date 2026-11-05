const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const WINDOWS_DIAGNOSTIC_EVENTS = new Set([
  ...['cleanup lease lock', 'cleanup launcher exit', 'cleanup ACL', 'run lease lock', 'identity', 'root preflight',
    'profile ACL', 'ancestor metadata ACL', 'root ACL', 'pipe ACL', 'stdio', 'attributes', 'process creation',
    'protected paths', 'worker resume', 'worker running', 'stdio drain', 'launcher release', 'frame read', 'frame parsed']
    .map(stage => 'stage ' + stage),
  'frame chars=#', 'preflight objects=#', 'preflight complete objects=#', 'cleanup objects=#', 'cleanup complete objects=#',
  'worker created pid=#', 'worker exited code=#', 'payload write begin', 'payload write closed',
  'payload write failed hresult=#', 'control cancelled', 'stdout first bytes=#', 'stdout closed', 'stderr first bytes=#', 'stderr closed',
  'host spawned pid=#', 'host frame queued bytes=#', 'host frame written', 'host cancel EOF', 'host closed code=#',
  'host preparation begin', 'host ready=# elevated=#', 'executor entry', 'executor input wait',
  'executor input first bytes=#', 'executor input end chars=#', 'executor payload parsed', 'executor child spawned pid=#',
  'executor child exit code=#', 'executor complete code=#', 'executor execute failed',
  'executor stdio setup', 'executor stdio ready', 'executor spawn begin', 'executor spawn returned',
  'host pipes ready count=#', 'host pipes closed',
]);

// CI diagnostics contain fixed stage names and numeric counters, never argv, environment or worker output.
function windowsDiagnostics() {
  if (process.platform !== 'win32' || !process.env?.AGENTRIX_LAB_ISOLATED_HOST || process.env.AGENTRIX_LAB_TEST_PREPARE_HOST !== '1') return null;
  let tail = '', emitted = 0, relayEmitted = 0;
  const recent = [], recentRelays = [];
  return {
    feed(chunk) {
      tail += String(chunk);
      for (let index; (index = tail.indexOf('\n')) !== -1;) {
        const line = tail.slice(0, index).replace(/\r$/, ''); tail = tail.slice(index + 1);
        if (!line.startsWith('[lab-win32] ')) continue;
        const event = line.slice(12).replace(/ ms=\d+$/, '').replace(/=(?:-?\d+|null)(?= |$)/g, '=#');
        if (/^host relay pipe=# id=# stage=(?:queue|start|reply|release|wait|cancel|error) phase=(?:queued|active|reply) code=(?:OK|E[A-Z0-9_]{1,31}) active=# queued=#$/.test(event)) {
          recentRelays.push(line); if (recentRelays.length > 8) recentRelays.shift();
          if (relayEmitted++ < 256) console.error(line);
          continue;
        }
        if (!WINDOWS_DIAGNOSTIC_EVENTS.has(event) &&
          !/^executor child error code=(?:E[A-Z0-9_]{1,31}|UNKNOWN)$/.test(event) &&
          !/^host pipe setup error phase=(?:namespace|listen|launch) code=E[A-Z0-9_]{1,31} errno=#$/.test(event) &&
          !/^executor launch error phase=(?:stdio|spawn) code=E[A-Z0-9_]{1,31} errno=#$/.test(event)) continue;
        recent.push(line); if (recent.length > 8) recent.shift();
        if (emitted++ < 128) console.error(line);
      }
      if (tail.length > 4096) tail = tail.slice(-4096);
    },
    summary: () => [...recentRelays, ...recent].join('\n'),
  };
}

function gitEnvironment(environment = process.env) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (name.startsWith('GIT_') || name === 'SSH_AUTH_SOCK' || name === 'SSH_AGENT_PID') delete env[key];
  }
  return {
    ...env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_ASKPASS: process.platform === 'win32' ? 'false' : '/usr/bin/false',
  };
}

async function markedPids(marker, job) {
  if (!/^[a-f0-9-]{36}$/.test(marker)) throw new Error('Invalid lab process marker.');
  if (process.platform === 'win32') return require('./sandbox-win32.cjs').markedPids(marker, job);
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
  if (process.platform === 'win32') return require('./sandbox-win32.cjs').killMarked(marker, { job });
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

async function processTree(pid, known, group, timeout) {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { timeout, maxBuffer: 4 * 1024 * 1024 });
  const rows = stdout.trim() ? stdout.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw new Error('Invalid process listing.');
    return { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), state: match[4] };
  }) : [];
  const found = new Set([pid, ...known]);
  if (group) for (const row of rows) if (row.group === pid) found.add(row.pid);
  let previous;
  do { previous = found.size; for (const row of rows) if (found.has(row.parent)) found.add(row.pid); } while (previous !== found.size);
  return rows.filter(row => found.has(row.pid) && row.pid !== process.pid && !/^[ZX]/.test(row.state));
}

// Dispatch detaches its model process. Killing only the helper's process group leaves nested workers alive.
async function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.labRun) {
      if (child.connected) await new Promise(resolve => child.send({ type: 'lab-stop' }, () => resolve()));
      await killMarked(child.labRun, { job: child.labJob });
      return; // The guardian exits after the launcher; taskkill would interrupt its lease handoff.
    }
    await execute('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 5000 }).catch(() => child.kill());
    return;
  }
  const end = Date.now() + 2000, known = new Set([child.pid]);
  let live = [], denied = false;
  const failure = reason => Object.assign(new Error(`Lab process cleanup failed for pid=${child.pid}: ${reason}` +
    (denied ? ' (signal EPERM)' : '') + live.slice(0, 8).map(row => `; pid=${row.pid} pgid=${row.group} state=${row.state}`).join('')),
  { code: 'ERR_LAB_PROCESS_REAP', infrastructure: true, fatal: true });
  const signal = (pid, value) => {
    try { process.kill(pid, value); } catch (error) {
      if (!['ESRCH', 'EPERM'].includes(error.code)) throw error;
      // A denied stale group or zombie is possible on macOS. Only the subsequent ps scan establishes exit.
      if (error.code === 'EPERM') denied = true;
    }
  };
  const scan = async () => {
    const remaining = end - Date.now();
    if (remaining <= 0) throw failure('reap deadline exceeded');
    try { live = await processTree(child.pid, known, child.labGroup, Math.min(1000, remaining)); }
    catch { throw failure('process state could not be verified'); }
    for (const row of live) known.add(row.pid);
  };
  try {
    if (child.labGroup) signal(-child.pid, 'SIGSTOP');
    await scan();
    for (const row of live) signal(row.pid, 'SIGSTOP');
    // Keep identities across scans: detached descendants can change parent and group as their launcher exits.
    await scan();
    for (const pid of [...known].reverse()) signal(pid, 'SIGKILL');
    if (child.labGroup) signal(-child.pid, 'SIGKILL');
    for (;;) {
      await scan();
      if (!live.length) return;
      for (const row of live) signal(row.pid, 'SIGKILL');
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, end - Date.now()))));
    }
  } catch (error) {
    // Even a failed state scan must not leave the known workers frozen.
    for (const pid of [...known, ...(child.labGroup ? [-child.pid] : [])]) { try { signal(pid, 'SIGKILL'); } catch {} }
    throw error;
  }
}

async function command(file, args, {
  cwd, env = process.env, signal, timeoutMs = 30000, log, onLine, maxOutput = OUTPUT_LIMIT, ipc = false,
  raw = false, onMessage, stdin, windowsVerbatimArguments = false,
} = {}) {
  aborted(signal);
  if (stdin !== undefined && ((typeof stdin !== 'string' && !Buffer.isBuffer(stdin)) || Buffer.byteLength(stdin) > OUTPUT_LIMIT)) {
    throw new Error('Invalid lab process input.');
  }
  env = gitEnvironment(env);
  const diagnostics = ipc && env.AGENTRIX_LAB_RUN ? windowsDiagnostics() : null;
  if (diagnostics) env.AGENTRIX_LAB_DIAGNOSTICS = '1';
  const output = log ? await fs.open(log, 'w', 0o600) : null;
  let child, timer, stopping = null, failure = null, stdout = '', stderr = '', bytes = 0;
  const binary = [];
  let rejectCleanup;
  const cleanupFailure = new Promise((resolve, reject) => { rejectCleanup = reject; });
  const stop = error => {
    failure ||= error;
    stopping ||= stopTree(child).catch(error => {
      failure = error; rejectCleanup(error);
      if (child.connected) child.disconnect();
      child.unref?.();
    }).finally(() => {
      // A failed reap remains a failure, but an inherited descriptor must not hold this promise forever.
      child.stdout?.destroy(); child.stderr?.destroy();
    });
  };
  const abort = () => stop(Object.assign(new Error('实验已停止。'), { name: 'AbortError' }));
  try {
    child = spawn(file, args, {
      cwd, env, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
      windowsHide: true, windowsVerbatimArguments, detached: ipc && process.platform !== 'win32',
    });
    child.labGroup = ipc && process.platform !== 'win32';
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
    if (ipc && process.platform === 'win32' && env.AGENTRIX_LAB_RUN) {
      child.labRun = env.AGENTRIX_LAB_RUN; child.labJob = env.AGENTRIX_LAB_JOB;
    }
    if (onMessage) child.on('message', message => { try { onMessage(message); } catch (error) { stop(error); } });
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
        if (key === 'stderr') diagnostics?.feed(chunk);
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
    const result = await Promise.race([closed, cleanupFailure]);
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    await stopping; await writes;
    if (failure) {
      if (diagnostics?.summary()) failure.message += '\n' + diagnostics.summary();
      throw failure;
    }
    return { ...result, stdout: raw ? Buffer.concat(binary) : stdout, stderr };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    await stopping; await output?.close();
    // A trusted host owns its process group. This also catches children that replace their environment.
    if (ipc && child?.pid && process.platform !== 'win32' && !stopping) await stopTree(child);
  }
}

async function git(cwd, args, options) {
  const result = await command('git', [
    '--no-optional-locks', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false',
    ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []), ...args,
  ], { cwd, ...options });
  if (result.code !== 0) throw new Error(`Git: ${result.stderr.trim().slice(0, 500) || result.code}`);
  return result.stdout;
}

module.exports = { command, git, gitEnvironment, aborted, stopTree, markedPids, killMarked, windowsDiagnostics };
