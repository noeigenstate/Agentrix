const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { LabSession, copyHelper } = require('../electron/features/lab/session.cjs');
const os = require('node:os');

function sessionFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-detach-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = new LabSession({ labRoot: root, workspaceRoot: root, runId: 'fixture', allowDelegation: true });
  session.active = true;
  const launched = [];
  session.launchJob = (id, args, options) => new Promise(resolve => {
    const job = { id, args, options, finish: (code = 0) => {
      options.onLine(`[dispatch] ended ${id} codex model fixture · exit ${code} reason completed`); resolve({ code });
    } };
    options.signal.addEventListener('abort', () => job.finish(130), { once: true });
    launched.push(job);
  });
  return { session, root, launched };
}
async function rpc(session, root, args) {
  const socket = new EventEmitter(), messages = [];
  const closed = new Promise(resolve => socket.once('close', resolve));
  Object.assign(socket, { destroyed: false, setEncoding() {}, setTimeout() {},
    write: line => messages.push(JSON.parse(line)), end(line) {
      if (line) this.write(line); this.destroyed = true; this.emit('close');
    }, destroy() { this.destroyed = true; this.emit('close'); } });
  session.connection(socket);
  socket.emit('data', JSON.stringify({ capability: session.capability, cwd: root, args }) + '\n');
  await closed;
  return messages;
}

test('Lab helper instrumentation preserves detached ids and its authenticated meter', async t => {
  const { root } = sessionFixture(t);
  const file = await copyHelper(path.join(__dirname, '../integration/dispatch.cjs'), root);
  const source = JSON.parse(fs.readFileSync(file, 'utf8'))['dispatch.cjs'];
  assert.match(source, /const id = detached\?\.id \|\| randomUUID\(\), send = globalThis\.__AGENTRIX_LAB_SINK;/);
  assert.match(source, /\.\.\.lastRate, \.\.\.output\.usage\(\)/);
  // Invoke the real executor's execute function without starting an OS process.
  const executor = fs.readFileSync(path.join(__dirname, '../electron/features/lab/executor.cjs'), 'utf8');
  const execute = executor.slice(executor.indexOf('async function execute('), executor.indexOf("\nlet data ="));
  const events = [], context = { process: { env: {} }, meterSink: () => async value => { events.push(value); return true; },
    memoryModules: () => ({ run: async (args, deps) => {
      assert.equal(args.includes('--detach'), false); assert.equal(deps.detached.id, 'fixture-id');
      deps.detached.admitted(); await context.__AGENTRIX_LAB_SINK({ type: 'dispatch-rate', id: deps.detached.id }); return 0;
    } }) };
  vm.runInNewContext(execute, context);
  assert.equal(await context.execute({ config: { args: ['codex'], dispatchId: 'fixture-id' }, bootstrap: {}, modules: {} }), 0);
  assert.deepEqual(events.map(value => value.type), ['lab-handshake', 'dispatch-rate']);
});

test('Lab detach outlives the start RPC and wait returns its end line', async t => {
  const { session, root, launched } = sessionFixture(t);
  const receipt = await rpc(session, root, ['codex', '--detach']);
  assert.equal(receipt.at(-1).exitCode, 0);
  const [id] = session.dispatches.keys();
  assert.match(receipt[0].output, new RegExp(id));
  assert.equal(launched[0].options.signal.aborted, false, 'start socket closed, job still owned by the session');
  assert.equal(launched[0].args.includes('--detach'), false);
  assert.equal(launched[0].options.dispatchId, id);
  launched[0].finish();
  const reply = await rpc(session, root, ['wait', id]);
  assert.match(reply[0].output, new RegExp('ended ' + id));
  assert.equal(reply.at(-1).exitCode, 0);
});

test('Lab wait caps its timeout and returns 75 without stopping either parallel run', async t => {
  const { session, root, launched } = sessionFixture(t);
  await rpc(session, root, ['codex', '--detach']); await rpc(session, root, ['claude', '--detach']);
  const ids = [...session.dispatches.keys()], lines = [];
  assert.equal(session.jobs.size, 2);
  assert.throws(() => session.dispatchSelection(['wait', ...ids, '--timeout', '571']), /570/);
  let expire;
  session.schedule = (callback, ms) => { assert.equal(ms, 540000); expire = callback; return 1; };
  session.cancel = () => {};
  const waiting = session.waitDispatch(['wait', ...ids], { onLine: line => lines.push(line) });
  expire(); assert.equal((await waiting).code, 75);
  assert.equal(lines.filter(line => line.includes('still running')).length, 2);
  assert.ok(launched.every(job => !job.options.signal.aborted));
  const final = session.waitDispatch(['wait', ...ids], { onLine: line => lines.push(line) });
  launched[1].finish(2); launched[0].finish();
  assert.equal((await final).code, 0);
  assert.equal(lines.filter(line => line.includes('ended')).length, 2);
});

test('Lab stop and session cancellation end detached jobs', async t => {
  const { session, root, launched } = sessionFixture(t);
  await rpc(session, root, ['codex', '--detach']);
  const [id] = session.dispatches.keys(), reply = await rpc(session, root, ['stop', id]);
  assert.equal(reply.at(-1).exitCode, 0);
  assert.equal(launched[0].options.signal.aborted, true);
  await rpc(session, root, ['claude', '--detach']);
  session.controller.abort(); await Promise.allSettled(session.jobs);
  assert.equal(launched[1].options.signal.aborted, true);
});

test('Lab composition carries current background policy to later runs without reopening the engine', async () => {
  const file = path.join(__dirname, '../electron/features/lab/index.cjs'), native = createRequire(file), module = { exports: {} };
  const settings = { claudeBackgroundTasks: false };
  let deferred, options;
  const context = { module, process: { env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: 'inherited' }, platform: process.platform },
    setTimeout, clearTimeout, clearImmediate, require: name => name === './window.cjs'
      ? { createLabWindow: () => ({ getWindow: () => null }) } : name === './ipc.cjs'
        ? { registerLabIpc: value => { deferred = value.engine; return () => {}; } } : native(name) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  const lab = module.exports.createLab({ userData: 'fixture', root: 'fixture', getSettings: () => settings, getMainWindow: () => null,
    engineFactory: value => { options = value; return { subscribe: () => () => {}, list: () => [], close() {} }; } });
  await deferred.list();
  // runnerOptions is the same path used for the source reference and every model run.
  const engineFile = path.join(__dirname, '../electron/features/lab/engine.cjs');
  const body = fs.readFileSync(engineFile, 'utf8').match(/  runnerOptions\(lane, signal\) \{[\s\S]*?\n  \}/)[0];
  const engine = vm.runInNewContext('({' + body + '})');
  Object.assign(engine, { env: options.env, store: {}, active: null });
  const lane = { provider: {}, ctx: { cacheDirectory: 'fixture' } };
  for (const allow of [false, true, false]) {
    settings.claudeBackgroundTasks = allow;
    const env = engine.runnerOptions(lane).env;
    assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, allow ? undefined : '1');
  }
  lab.dispose();
});
