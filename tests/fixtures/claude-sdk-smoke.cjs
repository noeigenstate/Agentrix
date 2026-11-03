// Lifecycle controls for the isolated desktop smoke, including a main process that stops answering IPC.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const clean = value => String(value).replace(/sk-ant-[\w-]+/g, '<offline-key>');

function offlineStorage({ safeStorage }) {
  // Never consult Keychain/DPAPI, even when the OS reports that encryption is available.
  Object.assign(safeStorage, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test-only',
    encryptString: value => Buffer.from(value).reverse(), decryptString: value => Buffer.from(value).reverse().toString() });
}
function allowSmokeQuit({ dialog }) {
  // Match mac-smoke: only this test instance may answer the macOS running-terminals quit confirmation.
  dialog.showMessageBox = async () => ({ response: 1 });
}
function createSmokeStages({ timeoutMs = 20000, totalMs = 150000, log = line => fs.writeSync(1, line + '\n'), fatal = () => process.exit(1) } = {}) {
  let current = 'initialization', output, runtime, child, closed = false, failed;
  const history = [], tail = [];
  function write(text) {
    const line = clean(`[native-smoke] ${text}`); log(line);
    if (output) fs.appendFileSync(path.join(output, 'stages.log'), line + '\n');
  }
  function status() {
    const providers = {};
    for (const provider of ['claude', 'codex']) {
      try {
        const rows = fs.readFileSync(path.join(runtime, `${provider}-wire.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        providers[provider] = rows.slice(-12).map(row => Object.fromEntries(['pid', 'parentPid', 'node', 'spawn', 'exit', 'code', 'control', 'rpc', 'user'].filter(key => key in row).map(key => [key, row[key]])));
        const processes = [...new Set(rows.filter(row => row.spawn).map(row => row.pid))].map(pid => {
          try { process.kill(pid, 0); return { pid, state: 'alive' }; } catch (error) { return { pid, state: error.code === 'ESRCH' ? 'gone' : error.code }; }
        });
        providers[provider] = { processes, wire: providers[provider] };
      } catch { providers[provider] = 'no wire records'; }
    }
    return { stage: current, firstFailure: failed, lastCompleted: history.at(-1), electron: child ? { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, closed } : null, providers, tail };
  }
  function dump(reason) {
    const snapshot = status();
    const pids = [child?.pid, ...Object.values(snapshot.providers).flatMap(value => value.processes?.map(item => item.pid) || [])].filter(Number.isSafeInteger);
    if (process.platform !== 'win32' && pids.length) {
      const ps = spawnSync('/bin/ps', ['-p', [...new Set(pids)].join(','), '-o', 'pid=,ppid=,stat=,comm='], { encoding: 'utf8', timeout: 2000, maxBuffer: 16384 });
      snapshot.ps = { status: ps.status, error: ps.error?.code, output: ps.stdout };
    }
    write(`DIAGNOSTICS ${reason} ${JSON.stringify(snapshot)}`);
  }
  function force() {
    // Own only the Electron child returned by this launch; never kill by application name.
    if (!child?.pid || closed || child.exitCode !== null || child.signalCode !== null) return;
    write(`FORCE owned Electron pid=${child.pid}`);
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000, stdio: 'ignore' });
    else child.kill('SIGKILL');
  }
  const watchdog = setTimeout(() => { try { dump('overall deadline exceeded'); force(); } finally { fatal(); } }, totalMs);
  return {
    history, dump, force,
    output(directory) { output = directory; }, runtime(directory) { runtime = directory; },
    attach(app) {
      child = app.process(); child.once('close', () => { closed = true; write(`Electron closed code=${child.exitCode} signal=${child.signalCode}`); });
      for (const name of ['stdout', 'stderr']) child[name]?.on('data', data => {
        const text = clean(data.toString()).slice(-2048); tail.push({ [name]: text }); if (tail.length > 8) tail.shift();
        write(`Electron ${name}: ${text.trim()}`);
      });
      write(`Electron launched pid=${child.pid}`);
    },
    async run(label, action, milliseconds = timeoutMs) {
      const previous = current, started = Date.now(); let timer;
      current = label; write(`START ${label}`);
      try {
        const value = await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Stage timed out after ${milliseconds}ms: ${label}`)), milliseconds);
        })]);
        history.push({ stage: label, status: 'ok', ms: Date.now() - started }); write(`OK ${label} ms=${Date.now() - started}`); return value;
      } catch (error) {
        failed ||= label; history.push({ stage: label, status: 'failed', ms: Date.now() - started });
        dump(clean(error.message)); throw error;
      } finally { clearTimeout(timer); current = previous; }
    },
    dispose() { clearTimeout(watchdog); },
  };
}
async function closeSmokeApplication(app, stages, timeoutMs = 8000) {
  if (!app) return;
  const child = app.process();
  try {
    await stages.run('exit: allow isolated quit confirmation', () => app.evaluate(allowSmokeQuit), 3000);
    await stages.run('exit: close Electron and its transport', () => app.close(), timeoutMs);
    if (child.exitCode === null && child.signalCode === null) throw new Error('Electron close returned before its process exited');
  } catch (error) { stages.dump('application cleanup failed'); stages.force(); throw error; }
}
module.exports = { createSmokeStages, closeSmokeApplication, offlineStorage };
