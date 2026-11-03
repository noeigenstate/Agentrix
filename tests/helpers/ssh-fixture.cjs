const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const execute = require('node:util').promisify(require('node:child_process').execFile);
const { Server, utils } = require('ssh2');
const { listDirectory, readProjectFile, saveProjectFile, resolveProjectPath } = require('../../electron/project-files.cjs');
const { readGitRaw } = require('../../electron/project-git.cjs');

function deadline(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

async function processTree(pid, known = []) {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,comm='], { timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
  const rows = stdout.trim().split('\n').map(line => {
    const [, id, parent, group, state, name] = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line) || [];
    return { pid: Number(id), parent: Number(parent), group: Number(group), state,
      name: path.basename(name || '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 32) };
  });
  const ids = new Set([pid, ...known]);
  // The shell may already have exited while Python holds its stdio and process group alive.
  for (const row of rows) if (row.group === pid) ids.add(row.pid);
  let count;
  do { count = ids.size; for (const row of rows) if (ids.has(row.parent)) ids.add(row.pid); } while (count !== ids.size);
  return rows.filter(row => ids.has(row.pid) && !row.state.startsWith('Z'));
}

// Each native fixture worker owns a POSIX process group. Snapshot before signalling its shell: Python's PTY
// children can create their own sessions, and killing just the shell loses their ancestry while they retain stdio.
class SSHWorker {
  constructor(child, diagnostic = () => {}, { graceMs = 500, timeoutMs = 2000 } = {}) {
    this.child = child; this.diagnostic = diagnostic; this.graceMs = graceMs; this.timeoutMs = timeoutMs;
    this.stdoutBytes = 0; this.stderrBytes = 0;
    child.stdout?.on('data', chunk => { this.stdoutBytes += chunk.length; });
    child.stderr?.on('data', chunk => { this.stderrBytes += chunk.length; });
    this.closed = new Promise(resolve => child.once('close', () => { this.didClose = true; resolve(); }));
    child.on('error', error => diagnostic('[ssh-fixture] worker error code=' + (/^E[A-Z0-9_]+$/.test(error.code) ? error.code : 'EIO')));
  }
  close() { return this.closing ||= this.stop(); }
  async stop() {
    const { child, diagnostic, graceMs, timeoutMs } = this;
    if (this.didClose) return;
    const pid = child.pid;
    let rows = [], scanFailure;
    const denied = new Set();
    const signal = (id, value) => {
      if (!Number.isInteger(id) || id === 0 || Math.abs(id) === process.pid) return;
      try { process.kill(id, value); } catch (error) {
        if (!['ESRCH', 'EPERM'].includes(error.code)) throw error;
        // macOS may deny a stale group or zombie. Only close + the final ps scan can establish it has exited.
        if (error.code === 'EPERM' && !denied.has(id)) {
          denied.add(id);
          if (denied.size <= 8) diagnostic(`[ssh-fixture] cleanup signal denied pid=${id} signal=${value} code=EPERM`);
        }
      }
    };
    if (process.platform !== 'win32' && pid) {
      // Freeze parents before the final scan so cleanup cannot race another descendant spawn.
      signal(-pid, 'SIGSTOP');
      try {
        rows = await processTree(pid);
        for (const row of rows) signal(row.pid, 'SIGSTOP');
        rows = await processTree(pid, rows.map(row => row.pid));
      } catch (error) { scanFailure = error; }
      for (const row of [...rows].reverse()) signal(row.pid, 'SIGTERM');
      signal(-pid, 'SIGTERM');
      for (const row of rows) signal(row.pid, 'SIGCONT');
      signal(-pid, 'SIGCONT');
    } else child.kill();
    let forced = false;
    try { await deadline(this.closed, graceMs, 'grace expired'); }
    catch { forced = true; }
    if (forced) diagnostic(`[ssh-fixture] cleanup force pid=${pid || 0} stdoutBytes=${this.stdoutBytes} stderrBytes=${this.stderrBytes}`);
    // Kill the saved PTY descendants even if the shell exited first; closing stdout is part of reaping the worker.
    if (process.platform === 'win32' && pid) {
      if (forced) await execute('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 1500 }).catch(error => {
        if (!this.didClose) throw new Error('SSH fixture taskkill failed for pid=' + pid + ' code=' + (Number.isInteger(error.code) ? error.code : 'EIO'));
      });
    } else {
      for (const row of [...rows].reverse()) {
        diagnostic(`[ssh-fixture] cleanup reap pid=${row.pid} name=${row.name}`);
        signal(row.pid, 'SIGKILL');
      }
      signal(-pid, 'SIGKILL');
    }
    try { await deadline(this.closed, timeoutMs, 'SSH fixture worker did not close: pid=' + (pid || 0) +
      ' exitCode=' + child.exitCode + ' signal=' + child.signalCode + ' stdoutBytes=' + this.stdoutBytes + ' stderrBytes=' + this.stderrBytes); }
    catch (error) {
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      throw error;
    }
    if (process.platform !== 'win32' && pid) {
      const end = Date.now() + timeoutMs, ids = [...rows.map(row => row.pid), ...[...denied].filter(id => id > 0)];
      let live;
      do {
        live = await processTree(pid, ids);
        if (!live.length) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < end);
      if (live.length) throw new Error('SSH fixture descendants did not exit: ' + live.map(row => `pid=${row.pid} name=${row.name} state=${row.state}`).join(', '));
    }
    if (scanFailure) throw new Error('SSH fixture process-tree scan failed for pid=' + pid + ': ' +
      (scanFailure.killed ? 'deadline exceeded' : 'process listing unavailable'));
  }
}

async function createSSHFixture({ password = false, unknownHost = false, nativeWorker = process.platform !== 'win32',
  diagnostic = () => {}, claudeAccount = { state: 'skipped', reason: 'credentials' } } = {}) {
  const prefix = path.join(os.tmpdir(), 'agentrix-ssh-test-');
  const directory = await fs.mkdtemp(prefix);
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const clientKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const userKey = utils.parseKey(clientKey);
  const identity = path.join(directory, 'identity');
  await fs.writeFile(identity, clientKey, { mode: 0o600 });
  if (process.platform === 'win32') execFileSync('icacls.exe', [identity, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN || '.'}\\${os.userInfo().username}:(F)`], { windowsHide: true, stdio: 'pipe', timeout: 5000 });
  const project = path.join(directory, '项目 with spaces');
  const home = path.join(directory, 'home');
  await fs.mkdir(project); await fs.mkdir(home);
  await fs.mkdir(path.join(home, 'bin'));
  await fs.writeFile(path.join(home, '.bashrc'), 'export PATH="$HOME/bin:$PATH"\nPS1="SSH_TEST> "\n');
  const secret = '测试口令-' + randomBytes(12).toString('hex');
  const connections = new Set(), sockets = new Set(), children = new Set(), failures = [];
  let workers = 0, closing;
  const server = new Server({ hostKeys: [hostKey] }, client => {
    connections.add(client);
    client.on('error', () => {});
    client.on('close', () => connections.delete(client));
    client.on('authentication', context => {
      if (context.username !== 'fixture') return context.reject();
      if (password) { if (context.method === 'password' && context.password === secret) context.accept(); else context.reject(['password']); return; }
      if (context.method === 'publickey' && context.key.data.equals(userKey.getPublicSSH()) && (!context.signature || userKey.verify(context.blob, context.signature, context.hashAlgo) === true)) context.accept();
      else context.reject(['publickey']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (accept, _reject, info) => {
        const channel = accept();
        workers++;
        if (nativeWorker) {
          const child = spawn('/bin/sh', ['-c', info.command], { cwd: project, env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'),
            CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(home, '.claude') },
            detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
          const worker = new SSHWorker(child, diagnostic); children.add(worker);
          diagnostic('[ssh-fixture] worker spawned pid=' + child.pid);
          channel.pipe(child.stdin); child.stdout.pipe(channel, { end: false }); child.stderr.pipe(channel.stderr, { end: false });
          child.stdin.on('error', () => {}); channel.on('error', () => {});
          // Retain the record until fixture teardown: close may fire while its descendant reaper still runs.
          child.on('close', code => { try { channel.exit(code || 0); channel.end(); } catch { } });
          channel.on('close', () => { void worker.close().catch(error => { failures.push(error); diagnostic(error.message); }); });
        } else {
          // Windows exercises the real OpenSSH transport and askpass, while
          // Linux CI executes the actual Python worker and remote PTY.
          // Each terminal is a channel of the one worker (remote-connection.cjs), named in every message both ways.
          let buffer = ''; let started = false;
          const send = (name, value) => channel.write('PGW1 ' + JSON.stringify({ ...value, channel: name }) + '\n');
          const request = async message => {
            if (message.op === 'claude-account') return claudeAccount;
            const local = { path: project };
            if (message.op === 'directory') return listDirectory(local, message.path, message.offset || 0);
            if (message.op === 'git') return readGitRaw(project, message.action, message.value);
            if (message.op === 'preview') return readProjectFile(local, message.path, message.page || 0);
            if (message.op === 'save-file') return saveProjectFile(local, message.path, message.page || 0, message.revision, Buffer.from(message.data, 'base64').toString('utf8'));
            if (message.op === 'stat') {
              const filename = await resolveProjectPath(local, message.path);
              const info = await fs.stat(filename);
              return { size: info.size, file: info.isFile(), directory: info.isDirectory(), realPath: path.relative(await fs.realpath(project), filename).replace(/\\/g, '/') };
            }
            if (message.op === 'read') {
              const filename = await resolveProjectPath(local, message.path);
              const handle = await fs.open(filename, 'r');
              try { const bytes = Buffer.alloc(message.length); const { bytesRead } = await handle.read(bytes, 0, bytes.length, message.offset); return bytes.subarray(0, bytesRead).toString('base64'); }
              finally { await handle.close(); }
            }
            return null;
          };
          channel.on('data', chunk => {
            buffer += chunk.toString();
            let at;
            while ((at = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
              if (!started) { started = true; continue; }
              const message = JSON.parse(line), name = message.channel;
              if (message.op === 'open') {
                send(name, { type: 'ready', info: { root: '/srv/fixture', branch: 'main', platform: 'linux' } });
                send(name, { type: 'event', event: { type: 'shell-prompt', projectId: message.projectId, sessionKey: message.token, sequence: 1, codexAvailable: true } });
              } else if (message.op === 'input') send(name, { type: 'data', data: message.data });
              else if (message.id) request(message).then(value => send(name, { type: 'response', id: message.id, ok: true, value }), error => send(name, { type: 'response', id: message.id, ok: false, error: error.message }));
            }
          });
          // The worker ends with its input, once the last terminal is closed.
          channel.on('end', () => { try { channel.exit(0); channel.end(); } catch { } });
        }
      });
    }));
  });
  // Track transports before SSH authentication, so a peer that never handshakes cannot hold close() forever.
  const listener = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    server.injectSocket(socket);
  });
  const close = () => {
    return closing ||= (async () => {
      const errors = [], active = [...children];
      diagnostic(`[ssh-fixture] cleanup begin workers=${active.length} connections=${connections.size}`);
      const stopped = Promise.allSettled(active.map(worker => worker.close()));
      const serverClosed = new Promise(resolve => listener.close(resolve));
      for (const connection of connections) connection.end();
      try { await deadline(serverClosed, 500, 'SSH fixture clients did not disconnect'); }
      catch {
        diagnostic('[ssh-fixture] cleanup force connections=' + sockets.size);
        for (const socket of sockets) socket.destroy();
      }
      try { await deadline(serverClosed, 1500, 'SSH fixture server did not close: connections=' + connections.size); }
      catch (error) { listener.unref(); errors.push(error); }
      for (const result of await stopped) if (result.status === 'rejected') errors.push(result.reason);
      errors.push(...failures.filter(error => !errors.includes(error)));
      if (!path.resolve(directory).startsWith(prefix)) throw new Error('Unsafe test cleanup path');
      try { if (!errors.length) await deadline(fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), 3000, 'SSH fixture directory cleanup exceeded 3000ms'); }
      catch (error) { errors.push(error); }
      diagnostic('[ssh-fixture] cleanup complete failures=' + errors.length);
      if (errors.length) throw new AggregateError(errors, 'SSH fixture cleanup failed: ' + errors.map(error => error.message).join('; '));
    })();
  };

  try {
    await deadline(new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); }),
      3000, 'SSH fixture listener did not start');
    diagnostic('[ssh-fixture] listening');
    const port = listener.address().port;
    const knownHosts = path.join(directory, 'known_hosts');
    const key = utils.parseKey(hostKey);
    await fs.writeFile(knownHosts, unknownHost ? '' : `[127.0.0.1]:${port} ${key.type} ${key.getPublicSSH().toString('base64')}\n`);
    const configFile = path.join(directory, 'config');
    const quoted = value => '"' + value.replace(/\\/g, '/') + '"';
    await fs.writeFile(configFile, `Host fixture\n  HostName 127.0.0.1\n  Port ${port}\n  User fixture\n  IdentityFile ${quoted(identity)}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${quoted(knownHosts)}\n  StrictHostKeyChecking ${unknownHost ? 'ask' : 'yes'}\n  LogLevel ERROR\n`);
    return { directory, home, project, secret, configFile, knownHosts, port,
      // How many SSH connections started a worker.
      get workers() { return workers; },
      snapshot() {
        return { connections: connections.size, transports: sockets.size, workers: workers, active: [...children].filter(worker => !worker.didClose).slice(0, 8).map(worker => ({
          pid: worker.child.pid || 0, exitCode: worker.child.exitCode, signal: worker.child.signalCode,
          stdoutBytes: worker.stdoutBytes, stderrBytes: worker.stderrBytes,
        })) };
      },
      close,
    };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "SSH fixture setup and cleanup failed."); }
    throw error;
  }
}

module.exports = { createSSHFixture, SSHWorker };
