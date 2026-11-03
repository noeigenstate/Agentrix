// The guardian holds the native launcher's lifetime outside LPAC. No private payload is put in argv or a public file.
const fs = require('node:fs');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

async function createPipeRelays(addresses, namespace, failed = () => {}) {
  if (!Array.isArray(addresses) || addresses.length > 8 || new Set(addresses).size !== addresses.length ||
    !/^\\\\\.\\pipe\\Sessions\\\d+\\AppContainerNamedObjects\\S-1-15-2(?:-\d+){7}\\$/.test(namespace)) {
    throw new Error('Invalid Windows lab pipe namespace.');
  }
  const relays = [], pipes = [];
  const close = () => Promise.all(relays.map(relay => new Promise(resolve => {
    relay.closed = true;
    relay.server.close(resolve); for (const socket of relay.sockets) socket.destroy();
  })));
  try {
    for (const address of addresses) {
      const match = /^\\\\\.\\pipe\\LOCAL\\(agentrix-lab-[a-zA-Z0-9-]{1,128})$/.exec(address);
      if (!match) throw new Error('Invalid Windows lab pipe address.');
      const sockets = new Set(), active = new Set(), pending = [], target = namespace + match[1];
      const relay = { sockets, closed: false };
      const drain = () => {
        while (!relay.closed && active.size < 8 && pending.length) {
          const socket = pending.shift();
          if (socket.destroyed) continue;
          active.add(socket);
          const upstream = net.connect({ path: address, allowHalfOpen: true });
          sockets.add(upstream);
          let remaining = 2;
          for (const [local, peer] of [[socket, upstream], [upstream, socket]]) {
            local.on('error', () => { local.destroy(); peer.destroy(); });
            local.once('close', () => {
              sockets.delete(local);
              if (!local.readableEnded) peer.destroy();
              if (--remaining === 0) { active.delete(socket); drain(); }
            });
          }
          upstream.setTimeout(30 * 60000, () => upstream.destroy());
          // Named pipes can retain their writable half after EOF. Retire both handles once the reply drains.
          upstream.once('end', () => { socket.end(() => socket.destroy()); upstream.destroy(); });
          socket.pipe(upstream); upstream.pipe(socket, { end: false });
        }
      };
      const server = net.createServer({ allowHalfOpen: true }, socket => {
        sockets.add(socket); socket.pause(); socket.on('error', () => {});
        socket.setTimeout(30 * 60000, () => socket.destroy());
        socket.once('close', () => {
          sockets.delete(socket);
          const index = pending.indexOf(socket); if (index !== -1) pending.splice(index, 1);
        });
        pending.push(socket); drain();
      });
      relay.server = server; relays.push(relay);
      // The native launcher applies this job's user/package DACL and low label before resuming its worker.
      server.on('error', failed);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(target, resolve); });
      pipes.push(target);
    }
    return { pipes, close };
  } catch (error) { await close(); throw error; }
}

async function runGuardian() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const modules = config.helper ? JSON.parse(fs.readFileSync(config.helper, 'utf8')) : null;
  const bootstrap = process.env.AGENTRIX_BOOTSTRAP ? JSON.parse(fs.readFileSync(process.env.AGENTRIX_BOOTSTRAP, 'utf8')) : null;
  const marker = '\x1e' + randomUUID() + '\x1f';
  const diagnostic = process.env.AGENTRIX_LAB_DIAGNOSTICS === '1';
  const trace = message => { if (diagnostic) process.stderr.write('[lab-win32] host ' + message + '\n'); };
  let child, cancelled = false, pipeFailure = false, relays, stage = 'namespace';
  // EOF cancels even a launcher that has not created its Job yet. Let it release handles before ACL recovery.
  const stop = () => { cancelled = true; trace('cancel EOF'); child?.stdin.end(); };
  process.once('disconnect', stop);
  process.on('message', message => { if (message?.type === 'lab-stop') stop(); });
  process.channel?.unref();
  try {
    if (config.windows.pipes?.length) {
      const namespace = execFileSync(config.windows.executable, ['pipe-namespace', config.windows.runId, config.windows.job],
        { windowsHide: true, timeout: 5000, maxBuffer: 4096, encoding: 'utf8' }).trim();
      stage = 'listen';
      relays = await createPipeRelays(config.windows.pipes, namespace, () => { pipeFailure = true; stop(); });
      trace('pipes ready count=' + relays.pipes.length);
    }
    if (cancelled) { await relays?.close(); process.exitCode = 125; return; }
    stage = 'launch';
    const env = { ...process.env };
    delete env.AGENTRIX_BOOTSTRAP; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const isolatedEnvironment = Object.fromEntries([
      'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
      'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
    ].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
    child = spawn(config.windows.executable, ['run'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.once('spawn', () => trace('spawned pid=' + child.pid));
    child.stdout.pipe(process.stdout);
    let tail = '', started = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      tail += chunk;
      const index = tail.indexOf(marker);
      if (index !== -1) {
        tail = tail.slice(0, index) + tail.slice(index + marker.length);
        if (!started && process.connected) process.send({ type: 'lab-model-started' }, () => {});
        started = true;
      }
      // Keep only an actual marker prefix; retaining an arbitrary tail delays short errors and stage lines.
      let held = Math.min(tail.length, marker.length - 1);
      while (held && !marker.startsWith(tail.slice(-held))) held--;
      const end = tail.length - held;
      process.stderr.write(tail.slice(0, end)); tail = tail.slice(end);
    });
    child.stderr.once('end', () => { if (tail) process.stderr.write(tail); });
    child.stdin.on('error', () => {});
    const frame = JSON.stringify({
      ...config.windows, ...(relays ? { pipes: relays.pipes } : {}),
      file: process.execPath, args: [config.executor], cwd: config.cwd, env,
      input: JSON.stringify({ config: { ...config, startMarker: marker, isolatedEnvironment }, bootstrap, modules }),
    }) + '\n';
    trace('frame queued bytes=' + Buffer.byteLength(frame));
    child.stdin.write(frame, 'utf8', () => trace('frame written'));
    child.once('error', () => { console.error('Windows lab launcher could not start.'); process.exitCode = 125; });
    child.once('close', code => {
      trace('closed code=' + code);
      void Promise.resolve(relays?.close()).then(() => {
        trace('pipes closed'); process.exitCode = pipeFailure ? 125 : code ?? 125;
      }, () => { process.exitCode = 125; });
    });
  } catch (error) {
    const code = /^E[A-Z0-9_]{1,31}$/.test(error.code) ? error.code : 'EIO';
    trace('pipe setup error phase=' + stage + ' code=' + code + ' errno=' + (Number.isInteger(error.errno) ? error.errno : 0));
    await relays?.close();
    throw error;
  }
}

module.exports = { createPipeRelays, runGuardian };
if (require.main === module) void runGuardian().catch(() => {
  console.error('Windows lab pipe setup failed.'); process.exitCode = 125;
});
