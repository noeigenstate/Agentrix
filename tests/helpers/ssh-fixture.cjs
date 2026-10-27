const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { Server, utils } = require('ssh2');
const { listDirectory, readProjectFile, saveProjectFile, resolveProjectPath } = require('../../electron/project-files.cjs');
const { readGitRaw } = require('../../electron/project-git.cjs');

async function createSSHFixture({ password = false, unknownHost = false, nativeWorker = process.platform !== 'win32' } = {}) {
  const prefix = path.join(os.tmpdir(), 'agentrix-ssh-test-');
  const directory = await fs.mkdtemp(prefix);
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const clientKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const userKey = utils.parseKey(clientKey);
  const identity = path.join(directory, 'identity');
  await fs.writeFile(identity, clientKey, { mode: 0o600 });
  if (process.platform === 'win32') execFileSync('icacls.exe', [identity, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN || '.'}\\${os.userInfo().username}:(F)`], { windowsHide: true, stdio: 'pipe' });
  const project = path.join(directory, '项目 with spaces');
  const home = path.join(directory, 'home');
  await fs.mkdir(project); await fs.mkdir(home);
  await fs.mkdir(path.join(home, 'bin'));
  await fs.writeFile(path.join(home, '.bashrc'), 'export PATH="$HOME/bin:$PATH"\nPS1="SSH_TEST> "\n');
  const secret = '测试口令-' + randomBytes(12).toString('hex');
  const connections = new Set(); const children = new Set();
  let workers = 0;
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
          const child = spawn('/bin/sh', ['-c', info.command], { cwd: project, env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex') }, stdio: ['pipe', 'pipe', 'pipe'] });
          children.add(child);
          channel.pipe(child.stdin); child.stdout.pipe(channel, { end: false }); child.stderr.pipe(channel.stderr, { end: false });
          child.stdin.on('error', () => {}); channel.on('error', () => {});
          child.on('close', code => { children.delete(child); try { channel.exit(code || 0); channel.end(); } catch { } });
          channel.on('close', () => child.kill());
        } else {
          // Windows exercises the real OpenSSH transport and askpass, while
          // Linux CI executes the actual Python worker and remote PTY.
          // Each terminal is a channel of the one worker (remote-connection.cjs), named in every message both ways.
          let buffer = ''; let started = false;
          const send = (name, value) => channel.write('PGW1 ' + JSON.stringify({ ...value, channel: name }) + '\n');
          const request = async message => {
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
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const knownHosts = path.join(directory, 'known_hosts');
  const key = utils.parseKey(hostKey);
  await fs.writeFile(knownHosts, unknownHost ? '' : `[127.0.0.1]:${port} ${key.type} ${key.getPublicSSH().toString('base64')}\n`);
  const configFile = path.join(directory, 'config');
  const quoted = value => '"' + value.replace(/\\/g, '/') + '"';
  await fs.writeFile(configFile, `Host fixture\n  HostName 127.0.0.1\n  Port ${port}\n  User fixture\n  IdentityFile ${quoted(identity)}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${quoted(knownHosts)}\n  StrictHostKeyChecking ${unknownHost ? 'ask' : 'yes'}\n  LogLevel ERROR\n`);
  return { directory, home, project, secret, configFile, knownHosts,
    // How many SSH connections started a worker.
    get workers() { return workers; },
    async close() {
      const stopped = [...children].map(child => new Promise(resolve => {
        child.once('close', resolve);
        child.kill();
      }));
      for (const connection of connections) connection.end();
      await Promise.all([...stopped, new Promise(resolve => server.close(resolve))]);
      if (!path.resolve(directory).startsWith(prefix)) throw new Error('Unsafe test cleanup path');
      // The PTY shell can finish flushing history just after its worker exits.
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

module.exports = { createSSHFixture };
