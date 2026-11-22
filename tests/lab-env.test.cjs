const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { LabSession, copyHelper } = require('../electron/features/lab/session.cjs');
const { workerArguments } = require('../electron/features/lab/dispatch.cjs');
const { argumentsOf } = require('../integration/dispatch.cjs');
const os = require('node:os');

test('a routing file in a Lab worktree leaves the worker specs unchanged', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-project-routing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const specs = () => [['sol', false], ['opus', false], ['sol', true]].map(([arm, review]) => {
    const args = workerArguments({ arm, review, cwd: root, brief: 'brief.md', out: 'out.md', helper: 'dispatch.cjs' });
    return argumentsOf(args.slice(1), {});
  });
  const before = specs(), directory = path.join(root, '.agentrix');
  fs.mkdirSync(directory);
  const seat = { model: 'haiku', effort: 'low', fast: false };
  fs.writeFileSync(path.join(directory, 'routing.json'), JSON.stringify({
    format: 'agentrix-routing', version: 1, roles: { orchestrator: seat, developer: seat, reviewer: seat },
  }));
  assert.deepEqual(specs(), before);
});

function sessionFixture(t) {
  // This fixture bypasses LabSession.start(), which normally resolves the workspace root.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lab-detach-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = new LabSession({ labRoot: root, workspaceRoot: root, runId: 'fixture', allowDelegation: true });
  session.active = true;
  const launched = [];
  session.launchJob = (id, args, options) => new Promise(resolve => {
    const job = { id, args, options, settle: (code = 0) => resolve({ code }), finish: (code = 0) => {
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

async function detach(session, root, agent) {
  const receipt = await rpc(session, root, [agent, '--detach']);
  assert.equal(receipt.at(-1).exitCode, 0, receipt.map(message => message.output).join(''));
  return receipt;
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
  const receipt = await detach(session, root, 'codex');
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

test('Lab wait delivers the live session start once across timeouts and retains request receipts', async t => {
  const { session, root, launched } = sessionFixture(t);
  await detach(session, root, 'codex');
  const [id] = session.dispatches.keys(), job = launched[0], lines = [];
  let expire;
  session.schedule = callback => { expire = callback; return 1; };
  session.cancel = () => {};
  const first = session.waitDispatch(['wait', id], { onLine: line => lines.push(line) });
  const start = `[dispatch] started ${id} codex model fixture · pid 7 session X`;
  job.options.onLine(start);
  assert.deepEqual(lines, [start], 'the lead receives the session id before the worker ends');
  job.options.onLine(`[dispatch] request ${id} question-1 approval opened: fixture`);
  assert.match(lines[1], /request .*approval opened/);
  expire(); assert.equal((await first).code, 75);
  assert.equal(session.dispatches.get(id).listeners.size, 0);
  const second = session.waitDispatch(['wait', id], { onLine: line => lines.push(line) });
  job.finish(); assert.equal((await second).code, 0);
  assert.equal(lines.filter(line => line.startsWith('[dispatch] started ')).length, 1);
  assert.match(lines.at(-1), new RegExp('ended ' + id));
});

for (const kind of ['failed to start', 'failed:']) test(`Lab wait preserves ${kind} admission diagnostics in its fallback end`, async t => {
  const { session, root, launched } = sessionFixture(t);
  await detach(session, root, 'claude');
  const [id] = session.dispatches.keys(), job = launched[0];
  const failure = kind === 'failed:' ? '[dispatch] failed: invalid --model argument'
    : `[dispatch] failed to start ${id}: worker runtime unavailable`;
  job.options.onLine(failure);
  job.options.onLine('[dispatch] request: permission is needed to continue');
  job.settle(1);
  const reply = await rpc(session, root, ['wait', id]);
  const lines = reply.filter(value => value.output).map(value => value.output.trim());
  assert.equal(lines[0], failure);
  assert.match(lines[1], /request: permission is needed/);
  assert.ok(lines[2].startsWith(`[dispatch] ended ${id} `));
  assert.ok(lines[2].includes(failure), 'the fallback end retains the actionable refusal');
  assert.equal(reply.at(-1).exitCode, 0, 'wait reports completion; the worker exit code is in its end line');
});

test('Lab detached receipts are bounded while the lead is away', async t => {
  const { session, root, launched } = sessionFixture(t);
  await detach(session, root, 'claude');
  const [id] = session.dispatches.keys(), job = launched[0], entry = session.dispatches.get(id);
  for (let n = 0; n < 30; n++) job.options.onLine(`[dispatch] request ${id} ${n} ` + 'x'.repeat(10000));
  assert.equal(entry.messages.length, 16);
  assert.ok(entry.messages.every(line => line.length === 4096));
  job.finish(); await entry.done;
});

test('Lab wait reports unknown ids and still completes known runs with exit 1', async t => {
  const { session, root, launched } = sessionFixture(t);
  await detach(session, root, 'codex');
  const [id] = session.dispatches.keys(); launched[0].finish();
  const reply = await rpc(session, root, ['wait', 'unknown-run', id, '--cwd', root]);
  assert.match(reply[0].output, /unknown run unknown-run/);
  assert.match(reply[1].output, new RegExp('ended ' + id));
  assert.equal(reply.at(-1).exitCode, 1);
});

test('Lab stop accepts its documented reason and keeps option validation strict', async t => {
  const { session, root, launched } = sessionFixture(t);
  await detach(session, root, 'claude');
  const [id] = session.dispatches.keys(), reason = 'Owner stopped this review';
  const reply = await rpc(session, root, ['stop', id, '--reason', reason, '--cwd', root, '--no-resume']);
  assert.equal(reply.at(-1).exitCode, 0);
  assert.equal(launched[0].options.signal.reason, reason);
  assert.throws(() => session.dispatchSelection(['stop', id, '--reason']), /Missing/);
  assert.throws(() => session.dispatchSelection(['wait', id, '--reason', reason]), /option/);
});

test('Lab wait caps its timeout and returns 75 without stopping either parallel run', async t => {
  const { session, root, launched } = sessionFixture(t);
  await detach(session, root, 'codex'); await detach(session, root, 'claude');
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
  await detach(session, root, 'codex');
  const [id] = session.dispatches.keys(), reply = await rpc(session, root, ['stop', id]);
  assert.equal(reply.at(-1).exitCode, 0);
  assert.equal(launched[0].options.signal.aborted, true);
  await detach(session, root, 'claude');
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
