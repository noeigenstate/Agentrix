const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { LabSession } = require('../electron/features/lab/session.cjs');
const { sandboxProfile } = require('../electron/features/lab/sandbox.cjs');
const { command, gitEnvironment } = require('../electron/features/lab/process.cjs');

async function fixture(t, Constructor = LabSession) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lab-session-')));
  const workspaceRoot = path.join(root, 'workspaces'); await fs.mkdir(workspaceRoot);
  const session = new Constructor({ directory: root, labRoot: root, workspaceRoot, runId: randomUUID(), hostPrompt: false });
  t.after(async () => { await session.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { root, session, workspaceRoot };
}

function request(descriptor, body, raw) {
  const config = JSON.parse(descriptor);
  return new Promise((resolve, reject) => {
    const socket = net.connect(config.address); let text = '';
    socket.setEncoding('utf8'); socket.setTimeout(3000, () => socket.destroy(new Error('fixture timeout')));
    socket.on('connect', () => socket.write(raw ?? JSON.stringify({ capability: config.capability, ...body }) + '\n'));
    socket.on('data', chunk => { text += chunk; });
    socket.on('error', reject);
    socket.on('close', () => { try { resolve(text ? JSON.parse(text) : null); } catch (error) { reject(error); } });
  });
}

test('trusted process input reaches the child for docker exec without entering the output log', async t => {
  const { root } = await fixture(t), log = path.join(root, 'process.log');
  const result = await command(process.execPath, ['-e',
    "let n=0;process.stdin.on('data',b=>n+=b.length);process.stdin.on('end',()=>console.log(n));"],
  { stdin: 'synthetic input', log, env: require('../electron/features/lab/sandbox.cjs').cleanEnvironment() });
  assert.equal(result.code, 0); assert.equal(result.stdout.trim(), '15');
  assert.doesNotMatch(await fs.readFile(log, 'utf8'), /synthetic input/);
  assert.equal(gitEnvironment({ git_config_count: '1', ssh_auth_sock: 'fixture' }).git_config_count, undefined);
});

test('execute defaults to offline for every call and never retains a preparation allowance', async t => {
  const { session, workspaceRoot } = await fixture(t), calls = [];
  session.launch = async (args, options) => { calls.push(options); return { code: 0, stdout: 'fixture', stderr: '' }; };
  for (const options of [{}, { network: true }, {}]) await session.execute('fixture', ['argument'], { cwd: workspaceRoot, ...options });
  assert.deepEqual(calls.map(call => call.network), [false, true, false]);
  assert.deepEqual(calls[0].command, { file: 'fixture', args: ['argument'] });
  for (const network of ['true', 1, null]) await assert.rejects(session.execute('fixture', [], { cwd: workspaceRoot, network }), /Invalid/);
  await assert.rejects(session.execute('fixture', ['bad\0argument'], { cwd: workspaceRoot }), /Invalid/);
});

test('isolation refusal occurs before servers, launch jobs or model workers exist', async t => {
  const filename = path.resolve(__dirname, '../electron/features/lab/session.cjs'), requireAt = createRequire(filename);
  const isolated = { exports: {} }; let launches = 0;
  vm.runInNewContext(syncFs.readFileSync(filename, 'utf8'), { module: isolated, __dirname: path.dirname(filename),
    require: name => name === './sandbox.cjs' ? { ...requireAt(name), requireIsolation: async () => {
      throw Object.assign(new Error('Windows 安全实验执行不可用，未启动工作者。'), { infrastructure: true });
    } } : requireAt(name), AbortController, AbortSignal, process, Buffer, setTimeout, clearTimeout });
  const { session } = await fixture(t, isolated.exports.LabSession);
  session.launch = async () => { launches++; };
  await assert.rejects(session.start(), /Windows 安全实验执行不可用/);
  assert.equal(launches, 0); assert.equal(session.jobs.size, 0); assert.equal(session.server, undefined);
});

test('the broker forwards argv, input and the bounded timeout only for its active run', async t => {
  const { session } = await fixture(t), calls = []; session.active = true;
  await session.broker(async (body, { signal }) => { calls.push(body); assert.equal(signal.aborted, false);
    return { code: 7, stdout: body.stdin, stderr: 'fixture error' }; });
  const result = await request(session.brokerEnvironment, { argv: ['printf', 'a b', 'line\nbreak'], stdin: 'input', timeoutMs: 1000 });
  assert.deepEqual(result, { code: 7, stdout: 'input', stderr: 'fixture error' });
  assert.deepEqual(calls, [{ argv: ['printf', 'a b', 'line\nbreak'], stdin: 'input', timeoutMs: 1000 }]);
  session.active = false;
  assert.equal((await request(session.brokerEnvironment, { argv: ['ignored'] })).code, 125);
  assert.equal(calls.length, 1);
});

test('foreign capabilities, invalid bounds and oversized frames cannot reach the broker handler', async t => {
  const { session } = await fixture(t); session.active = true; let calls = 0;
  await session.broker(async () => { calls++; return { code: 0, stdout: '', stderr: '' }; });
  const invalid = [{ capability: 'foreign', argv: ['x'] }, { argv: [] }, { argv: ['bad\0argument'] },
    { argv: Array(257).fill('x') }, { argv: ['x'], timeoutMs: 0 }, { argv: ['x'], timeoutMs: 1200001 },
    { argv: ['x'], stdin: 'x'.repeat(128 * 1024 + 1) }];
  for (const body of invalid) assert.equal((await request(session.brokerEnvironment, body)).code, 125);
  assert.equal(await request(session.brokerEnvironment, {}, 'x'.repeat(256 * 1024 + 1) + '\n').catch(() => null), null);
  assert.equal(calls, 0);
});

test('broker failures redact handler details and preserve an infrastructure failure for the run', async t => {
  const { session } = await fixture(t); session.active = true;
  await session.broker(async () => { throw Object.assign(new Error('synthetic private diagnostic'), { infrastructure: true }); });
  const result = await request(session.brokerEnvironment, { argv: ['fixture'] });
  assert.equal(result.code, 125); assert.doesNotMatch(JSON.stringify(result), /private diagnostic/);
  assert.equal(session.brokerFailure.infrastructure, true);
});

test('a broker capability belongs to one run and is rejected by another run', async t => {
  const first = (await fixture(t)).session, second = (await fixture(t)).session;
  first.active = second.active = true; let calls = 0;
  await first.broker(async () => ({ code: 0, stdout: '', stderr: '' }));
  await second.broker(async () => { calls++; return { code: 0, stdout: '', stderr: '' }; });
  const capability = JSON.parse(first.brokerEnvironment).capability;
  assert.equal((await request(second.brokerEnvironment, { capability, argv: ['fixture'] })).code, 125);
  assert.equal(calls, 0);
});

test('the broker admits at most four concurrent handler operations', async t => {
  const { session } = await fixture(t); session.active = true;
  const release = []; let started;
  const full = new Promise(resolve => { started = resolve; });
  await session.broker(async () => new Promise(resolve => {
    release.push(() => resolve({ code: 0, stdout: '', stderr: '' }));
    if (release.length === 4) started();
  }));
  const running = Array.from({ length: 4 }, () => request(session.brokerEnvironment, { argv: ['fixture'] }));
  await full;
  assert.equal((await request(session.brokerEnvironment, { argv: ['fifth'] })).code, 125);
  assert.equal(release.length, 4);
  release.forEach(finish => finish());
  assert.ok((await Promise.all(running)).every(result => result.code === 0));
});

test('broker timeout aborts the handler and replies without waiting for an ignored signal', async t => {
  const { session } = await fixture(t); session.active = true; let release, signal;
  await session.broker(async (body, options) => { signal = options.signal;
    return new Promise(resolve => { release = () => resolve({ code: 0, stdout: '', stderr: '' }); }); });
  const result = await request(session.brokerEnvironment, { argv: ['fixture'], timeoutMs: 30 });
  assert.equal(result.code, 125); assert.equal(signal.aborted, true); release();
});

test('closing the run aborts in-flight broker work and retires its endpoint', async t => {
  const { session } = await fixture(t); session.active = true; let started, wasAborted = false;
  const entered = new Promise(resolve => { started = resolve; });
  await session.broker(async (body, { signal }) => { started(); return new Promise(resolve => {
    signal.addEventListener('abort', () => { wasAborted = true; resolve({ code: 1, stdout: '', stderr: '' }); }, { once: true });
  }); });
  const descriptor = session.brokerEnvironment, waiting = request(descriptor, { argv: ['fixture'] }).catch(() => null);
  await entered; await session.close(); await waiting;
  assert.equal(wasAborted, true); assert.equal(session.brokerWork.size, 0);
  await assert.rejects(request(descriptor, { argv: ['late'] }));
});

test('oversized broker output is refused instead of reaching the model', async t => {
  const { session } = await fixture(t); session.active = true;
  await session.broker(async () => ({ code: 0, stdout: 'x'.repeat(8 * 1024 * 1024 + 1), stderr: '' }));
  assert.deepEqual(await request(session.brokerEnvironment, { argv: ['fixture'] }),
    { code: 125, stdout: '', stderr: 'Lab broker command failed.' });
});

test('a handler that refuses cancellation cannot cause live workspace cleanup', { timeout: 5000 }, async t => {
  const { session, workspaceRoot } = await fixture(t); session.active = true; let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  await fs.writeFile(path.join(workspaceRoot, 'still-live'), 'fixture');
  await session.broker(async () => { entered(); return new Promise(resolve => { release = () => resolve({ code: 0, stdout: '', stderr: '' }); }); });
  const waiting = request(session.brokerEnvironment, { argv: ['fixture'] }).catch(() => null);
  await started;
  await assert.rejects(session.close(), { fatal: true, infrastructure: true });
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'still-live'), 'utf8'), 'fixture');
  release(); await waiting;
});

test('macOS enforces an offline grade after a network-enabled preparation job', {
  skip: process.platform !== 'darwin' ? 'macOS Seatbelt runtime is required' : false,
}, async t => {
  const { root, session, workspaceRoot } = await fixture(t);
  session.nodePath = process.execPath; session.protectedPaths = [];
  session.env = { ...require('../electron/features/lab/sandbox.cjs').cleanEnvironment(),
    CODEX_HOME: path.join(root, 'synthetic-codex'), CLAUDE_CONFIG_DIR: path.join(root, 'synthetic-claude') };
  await session.start();
  const server = net.createServer(socket => socket.end('fixture')); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const code = `const net=require('node:net');const c=net.connect(${server.address().port},'127.0.0.1');
    c.setTimeout(1000,()=>c.destroy());c.once('connect',()=>{console.log('allowed');c.destroy()});c.on('error',()=>console.log('denied'));`;
  for (const network of [false, true, false]) {
    const result = await session.execute(session.nodePath, ['-e', code], { cwd: workspaceRoot, timeoutMs: 5000, network });
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim(), network ? 'allowed' : 'denied');
  }
});

test('offline macOS profiles allow only the explicitly admitted Unix IPC endpoints', () => {
  const options = { labRoot: '/fixture/lab', readRoots: ['/fixture/lab/workspace'], writeRoots: ['/fixture/lab/workspace'],
    protectedPaths: ['/fixture/protected'], ipcPaths: ['/fixture/lab/broker.sock'] };
  const offline = sandboxProfile({ ...options, network: false }), online = sandboxProfile({ ...options, network: true });
  assert.match(offline, /\(deny network\*\)/);
  assert.ok(offline.includes('(allow network-outbound (remote unix-socket (subpath "/fixture/lab/broker.sock")))'));
  assert.doesNotMatch(offline, /remote ip|network-inbound/);
  assert.doesNotMatch(online, /deny network\*/);
  assert.match(online, /deny file-read\*/);
});
