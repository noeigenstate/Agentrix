const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

function fixtureProcesses(t, prefix = 'agx-sdk-process-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix)), children = new Set(), cleanup = [];
  function force(child) {
    if (child.pid && (process.platform === 'win32' ? child.exitCode === null && child.signalCode === null : !child.fixtureClosed)) {
      try {
        if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'),
          ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', timeout: 3000 });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch { } }
    }
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
  }
  const abort = () => { for (const child of children) force(child); };
  t.signal.addEventListener('abort', abort, { once: true });
  async function wait(task, label, milliseconds = 5000) {
    let timer, abort;
    try {
      return await Promise.race([task, new Promise((_, reject) => {
        abort = () => reject(new Error(`Offline fixture aborted: ${label}`));
        if (t.signal.aborted) return abort();
        t.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error(`Offline fixture timed out: ${label} (${milliseconds}ms)`)), milliseconds);
      })]);
    } finally { clearTimeout(timer); t.signal.removeEventListener('abort', abort); }
  }
  t.after(async () => {
    const failures = [];
    // Cleanup itself has a deadline and still reaps processes when a runtime close rejects or stalls.
    for (const close of cleanup) {
      try { await wait(close(), 'runtime cleanup'); } catch (error) { failures.push(error.message); }
    }
    abort();
    for (const child of children) {
      const deadline = Date.now() + 3000;
      while (!child.fixtureClosed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      if (!child.fixtureClosed) failures.push(`Offline fixture did not close: pid=${child.pid || 'unspawned'}`);
    }
    t.signal.removeEventListener('abort', abort);
    try { await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (error) { failures.push(`Offline fixture directory cleanup: ${error.code}`); }
    if (failures.length) throw new Error(failures.join('; '));
  });
  return { directory, wait, defer: close => cleanup.push(close),
    spawn(command, args, options = {}) {
      const child = spawn(command, args, { ...options, detached: process.platform !== 'win32', windowsHide: true });
      children.add(child); child.once('close', () => { child.fixtureClosed = true; });
      child.on('error', () => {});
      if (t.signal.aborted) force(child);
      return child;
    },
    sdkSpawn(options) {
      return this.spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal,
        stdio: ['pipe', 'pipe', 'pipe'] });
    },
  };
}
module.exports = { fixtureProcesses };
