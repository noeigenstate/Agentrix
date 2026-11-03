const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { daemonSocketPaths, sandboxProfile, cleanEnvironment } = require('../electron/features/lab/sandbox.cjs');
const { command } = require('../electron/features/lab/process.cjs');

async function temporary(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lab-socket-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function profileAt(root, deniedSockets) {
  return sandboxProfile({ labRoot: root, readRoots: [root], writeRoots: [root], protectedPaths: [], deniedSockets });
}

function assertDenied(profile, file, filter) {
  assert.ok(profile.includes(`(remote unix-socket (${filter} ${JSON.stringify(file)}))`), `missing socket deny for ${file}`);
  assert.ok(profile.split('\n').some(line => line.startsWith('(deny file-read* ') && line.includes(`(subpath ${JSON.stringify(file)})`)), `missing file deny for ${file}`);
}

test('macOS profile denies daemon socket connections and file reads for every path family without blocking all Unix sockets', async t => {
  const root = await temporary(t), home = path.join(root, 'home');
  const custom = path.join(root, 'custom "daemon".sock');
  const profile = profileAt(root, daemonSocketPaths(home, { DOCKER_HOST: `unix://${custom}` }));
  const outbound = profile.split('\n').filter(line => line.startsWith('(deny network-outbound ')).join('\n');
  for (const file of ['/var/run/docker.sock', '/private/var/run/docker.sock', path.join(home, '.docker/run/docker.sock'), custom]) {
    assertDenied(profile, file, 'path-literal');
    assert.ok(outbound.includes(`(remote unix-socket (path-literal ${JSON.stringify(file)}))`));
  }
  for (const file of [
    ...['.docker/desktop', 'Library/Containers/com.docker.docker', '.colima', '.orbstack', '.rd', '.lima', '.local/share/containers'].map(dir => path.join(home, dir)),
    '/var/run/podman', '/private/var/run/podman',
  ]) {
    assertDenied(profile, file, 'subpath');
    assert.ok(outbound.includes(`(remote unix-socket (subpath ${JSON.stringify(file)}))`));
  }
  assert.doesNotMatch(profile, /\(deny network\*|\(remote unix-socket\)|\(remote unix-socket \(subpath "\/"\)\)/);
  assert.doesNotMatch(outbound, /mDNSResponder/);
  const defaults = profileAt(root);
  assertDenied(defaults, path.join(os.homedir(), '.docker/run/docker.sock'), 'path-literal');
});

test('daemon socket denies include resolved aliases and missing sockets under linked parents', async t => {
  const root = await temporary(t), home = path.join(root, 'home'), target = path.join(root, 'daemon');
  await fs.mkdir(home); await fs.mkdir(target);
  const alias = path.join(home, '.docker');
  await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const custom = path.join(alias, 'custom.sock');
  const profile = profileAt(root, daemonSocketPaths(home, { DOCKER_HOST: `unix://${custom}` }));
  assertDenied(profile, path.join(target, 'run/docker.sock'), 'path-literal');
  assertDenied(profile, path.join(target, 'desktop'), 'subpath');
  assertDenied(profile, path.join(target, 'custom.sock'), 'path-literal');
  assertDenied(profile, custom, 'path-literal');
  assert.deepEqual(daemonSocketPaths(home, { DOCKER_HOST: 'tcp://example.invalid:2375' }), daemonSocketPaths(home, {}));
});

test('sandbox-exec refuses denied Unix socket connections while allowing the lab channel', {
  skip: process.platform !== 'darwin' ? 'macOS sandbox-exec and Unix sockets are required' : false,
  timeout: 20000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/lab-sb-')), servers = [];
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await fs.rm(root, { recursive: true, force: true });
  });
  const denied = path.join(root, 'd/s'), allowed = path.join(root, 'channel');
  await fs.mkdir(path.dirname(denied));
  for (const address of [denied, allowed]) {
    const server = net.createServer(socket => socket.end());
    servers.push(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
  }
  const client = `const net = require('node:net');
    Promise.all(JSON.parse(process.argv[1]).map(address => new Promise(resolve => {
      const socket = net.connect(address);
      socket.setTimeout(2000, () => { socket.destroy(); resolve('TIMEOUT'); });
      socket.once('connect', () => { socket.end(); resolve('connected'); });
      socket.once('error', error => resolve(error.code));
    }))).then(results => console.log(JSON.stringify(results)));`;
  for (const [filter, file] of [['path-literal', denied], ['subpath', path.dirname(denied)]]) {
    const profile = profileAt(root, [...daemonSocketPaths(path.join(root, 'home'), {}), { path: file, filter }]);
    const run = value => command('/usr/bin/sandbox-exec', ['-p', value, process.execPath, '-e', client, JSON.stringify([denied, allowed])], {
      env: cleanEnvironment(process.env), cwd: root, timeoutMs: 5000,
    });
    // File-read denies alone must not explain the refused connect.
    const control = await run(profile.replace(/^\(deny network-outbound .*\)\n/m, ''));
    assert.equal(control.code, 0, control.stderr);
    assert.deepEqual(JSON.parse(control.stdout), ['connected', 'connected']);
    const blocked = await run(profile);
    assert.equal(blocked.code, 0, blocked.stderr);
    const results = JSON.parse(blocked.stdout);
    assert.ok(['EPERM', 'EACCES'].includes(results[0]), JSON.stringify(results));
    assert.equal(results[1], 'connected');
  }
});
