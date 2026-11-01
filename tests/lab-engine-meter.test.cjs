const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { LabSession } = require('../electron/features/lab/session.cjs');
const { LabUsage } = require('../electron/features/lab/usage.cjs');
const { meterSink } = require('../electron/features/lab/meter-sink.cjs');

const isolatedTest = (name, run) => test(name, {
  skip: process.platform !== 'darwin' ? 'macOS filesystem isolation is required' : false,
}, run);

async function pipeline(t, helperSource) {
  const base = process.platform === 'darwin' ? path.join(os.homedir(), '.ctmp') : os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'lab-meter-'));
  const labRoot = path.join(root, 'long-profile-'.repeat(10), 'lab'), runId = randomUUID();
  const directory = path.join(labRoot, randomUUID(), 'runs', runId), artifacts = path.join(directory, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const helper = helperSource ? path.join(root, 'helper.cjs') : undefined;
  if (helper) await fs.writeFile(helper, helperSource);
  const session = new LabSession({
    directory, labRoot, workspaceRoot: path.join(directory, 'workspaces'), runId, helper,
    nodePath: process.execPath, protectedPaths: helper ? [helper] : [],
    env: { ...process.env, CODEX_HOME: path.join(root, 'fake-codex'), CLAUDE_CONFIG_DIR: path.join(root, 'fake-claude') },
  });
  const usage = new LabUsage({
    directory: artifacts, privateDirectory: session.privateDirectory, socketDirectory: labRoot,
    runId, project: { id: 'pipeline' }, prices: {},
  });
  session.usage = usage;
  t.after(async () => {
    try { await session.close(); }
    finally {
      try { await usage.close(); }
      finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 8 }); }
    }
  });
  await session.start(); await usage.start();
  return { root, session, usage, artifacts };
}

isolatedTest('long run paths keep RPC and meter sockets distinct and the real sandboxed meter handshake works', async t => {
  const { session, usage, artifacts } = await pipeline(t);
  const rpc = session.channel.address, meter = usage.address;
  const rpcPhysical = await fs.realpath(rpc), meterPhysical = await fs.realpath(meter);
  assert.notEqual(rpcPhysical, meterPhysical);
  assert.ok(Buffer.byteLength(rpc) <= 100); assert.ok(Buffer.byteLength(meter) <= 100);
  assert.ok(session.server.listening); assert.ok(usage.server.listening);
  const sink = meterSink(JSON.parse(await fs.readFile(usage.bootstrap, 'utf8')));
  assert.equal(await sink({ type: 'lab-handshake' }), true);
  const result = await session.execute(process.execPath, ['-e', "process.stdout.write('pipeline-ready');"], {
    cwd: session.workspaceRoot, log: path.join(artifacts, 'pipeline.log'),
  });
  assert.equal(result.code, 0); assert.equal(result.stdout, 'pipeline-ready');
  assert.equal(session.modelStarted, false); assert.equal(usage.calls.size, 0);
  await session.close();
  assert.equal(await sink({ type: 'lab-handshake' }), true);
  assert.equal(await fs.lstat(path.dirname(rpc)).catch(() => null), null);
  assert.equal(await fs.stat(rpcPhysical).catch(() => null), null);
  assert.ok(await fs.stat(meterPhysical));
  await usage.close();
  assert.equal(await fs.lstat(path.dirname(meter)).catch(() => null), null);
  assert.equal(await fs.stat(meterPhysical).catch(() => null), null);
});

isolatedTest('only a spawned fake model sets the trusted model-start flag, even with no metering records', async t => {
  const { session, usage, artifacts } = await pipeline(t, `
    module.exports.run = async (args, { env, launch }) => {
      const child = launch(process.execPath, ['-e', 'process.stdout.write("fake-model-ready");'], {
        cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
      return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    };
  `);
  const result = await session.root(['codex'], { cwd: session.workspaceRoot, log: path.join(artifacts, 'helper.log') });
  assert.equal(result.code, 0); assert.match(result.stdout, /fake-model-ready/);
  assert.equal(session.modelStarted, true); assert.equal(usage.calls.size, 0);
});

isolatedTest('helper stdout cannot fake a model start and a spawn failure does not count as a started model', async t => {
  const { session, usage, artifacts } = await pipeline(t, `
    module.exports.run = async (args, { env, launch }) => {
      console.log('{"type":"lab-model-started"}');
      const child = launch(require('node:path').join(process.cwd(), 'missing-model'), [], {
        cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      return new Promise(resolve => child.once('error', () => resolve(1)));
    };
  `);
  const result = await session.root(['codex'], { cwd: session.workspaceRoot, log: path.join(artifacts, 'helper.log') });
  assert.equal(result.code, 1); assert.equal(session.modelStarted, false); assert.equal(usage.calls.size, 0);
});
