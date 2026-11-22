const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

async function windowsTreeStopError() {
  if (process.platform !== 'win32') return null;
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdin.on('error', () => {});
  try {
    await once(child, 'spawn');
    const taskkill = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe');
    await promisify(execFile)(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    return null;
  } catch (error) {
    const stderr = error.stderr?.trim();
    const detail = stderr && !stderr.includes('\uFFFD') ? stderr : `exit ${error.code ?? 'unknown'}`;
    return `Windows process-tree termination is unavailable for a fixture-owned child (taskkill: ${detail})`;
  } finally {
    child.stdin.end();
    await closed;
  }
}

async function observeShellChild(t, folder, receipt) {
  const server = net.createServer(), sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  const clean = () => { for (const socket of sockets) socket.destroy(); server.close(); };
  t.signal.addEventListener('abort', clean, { once: true });
  t.after(() => { t.signal.removeEventListener('abort', clean); clean(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening', { signal: t.signal });
  const ready = once(server, 'connection', { signal: t.signal }).then(async ([socket]) => {
    const exited = new Promise(resolve => socket.once('close', resolve)).then(() => t.signal.throwIfAborted());
    void exited.catch(() => {});
    await once(socket, 'data', { signal: t.signal });
    return { exited, async write() {
      const written = once(socket, 'data', { signal: t.signal });
      socket.write('x');
      await written;
    } };
  });
  void ready.catch(() => {});

  const script = path.join(folder, 'shell-child.cjs');
  fs.writeFileSync(script, `
const fs = require('node:fs'), net = require('node:net');
const socket = net.connect(${server.address().port}, '127.0.0.1', () => {
  fs.writeFileSync(${JSON.stringify(receipt)}, String(process.pid));
  socket.write('ready');
});
socket.on('error', () => {});
socket.on('data', bytes => { fs.appendFileSync(${JSON.stringify(receipt)}, bytes); socket.write('written'); });
`);
  const shellWord = file => "'" + file.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
  return { command: `${shellWord(process.execPath)} ${shellWord(script)}`, ready, close: clean };
}

module.exports = { observeShellChild, windowsTreeStopError };
