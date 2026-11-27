const { test } = require('node:test');
require('./fixtures/team-isolation.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { registerAgyWorker } = require('../electron/features/native-session/worker.cjs');
const { adapterOf, adapterOfModel } = require('../electron/features/cli-adapters/registry.cjs');
const { run } = require('../integration/dispatch.cjs');
const { temporary } = require('./helpers/agy-runtime.cjs');

function fixture({ readOnly = false, startError, saved = false } = {}) {
  const cwd = path.resolve(__dirname, '..');
  const geminiDir = path.join(cwd, 'data', 'agy', 'role'), roleResultFolder = path.join(cwd, 'role-results');
  const events = [], inputs = [], sent = Promise.withResolvers(), closing = Promise.withResolvers(), stopped = Promise.withResolvers();
  const run = { runId: 'role-run', projectId: 'project', cwd, local: true, agent: 'agy', readOnly, allow: ['allowed.txt'] };
  let request, control, emit, spec, closeCount = 0;
  registerAgyWorker({
    control: { onRequest(method, handler) { assert.equal(method, 'agy-acp.run'); request = handler; } },
    adapterOf, adapterOfModel, geminiDir,
    env: () => ({ PATH: 'synthetic', AGENTRIX_CONTROL_ADDRESS: 'private' }),
    roleResultServer(id, folder) {
      assert.equal(id, run.runId); assert.equal(folder, roleResultFolder);
      return { command: 'node', args: ['role-service'], env: { TEST: '1' } };
    },
    readRoleResult: async () => saved ? { source: 'finish-role' } : null,
    runtimeOf: async adapter => {
      assert.equal(adapter, adapterOf(run.agent));
      return { create(binding, publish) {
        spec = binding;
        emit = (type, payload) => publish({ type, payload, providerSessionId: 'provider-session', turnId: 'turn' });
        return {
          start() { if (startError) throw startError; },
          send(input) { inputs.push(input); sent.resolve(); return { status: 'queued' }; },
          async close() { closeCount++; closing.resolve(); await stopped.promise; },
        };
      } };
    },
  });
  const result = request(run, { prompt: 'Role brief', model: 'gemini-3.8-flash', effort: 'low', roleResultFolder },
    { supportsFinish: true, emit: event => events.push(event), onControl(handler) { control = handler; return () => { control = null; }; } });
  return {
    result, geminiDir, run, sent: sent.promise, closing: closing.promise, stopClosed: stopped.resolve, events, inputs,
    get spec() { return spec; }, get closeCount() { return closeCount; },
    control: message => control(message),
    complete() { emit('turn.completed', { status: 'completed' }); emit('session.state', { state: 'idle' }); },
    denial(reason) { emit('request.resolved', { resolution: 'denied', reason, action: 'write_file' }); },
  };
}

test('agy role forwards launch settings and events and closes after the finish receipt', { timeout: 5000 }, async () => {
  const f = fixture(); await f.sent;
  const { spec } = f;
  assert.equal(spec.cwd, f.run.cwd); assert.equal(spec.worktree, f.run.cwd); assert.equal(spec.geminiDir, f.geminiDir);
  assert.equal(spec.model, 'gemini-3.8-flash'); assert.equal(spec.effort, 'low');
  assert.equal(spec.readOnly, false); assert.deepEqual(spec.allow, ['allowed.txt']); assert.match(spec._meta.antigravity.systemPrompt.append, /allowed\.txt/);
  assert.deepEqual(spec.env, { PATH: 'synthetic' });
  assert.deepEqual(spec.mcpServers, [{ name: 'agentrix_role', command: 'node', args: ['role-service'], env: [{ name: 'TEST', value: '1' }] }]);
  assert.equal(f.inputs[0].text, 'Role brief');
  f.complete();
  assert.deepEqual(await f.control({ type: 'finish' }), { status: 'delivered' });
  await f.closing; f.stopClosed();
  assert.deepEqual(await f.result, { status: 'completed' }); assert.equal(f.closeCount, 1);
  assert.deepEqual(f.events.map(event => event.type), ['turn.completed', 'session.state']);
});

test('agy continues after a denial at most once and skips recovery after finish_role or an earlier continuation', { timeout: 5000 }, async () => {
  for (const [saved, allowContinuation] of [[false, true], [true, true], [false, false]]) {
    const f = fixture({ readOnly: true, saved }); await f.sent;
    f.denial('read_only');
    const denial = f.events.find(event => event.type === 'worker.refused');
    assert.deepEqual(denial.payload, { action: 'write_file', reason: 'read_only' });
    f.complete();
    const continued = !saved && allowContinuation;
    if (continued) {
      assert.deepEqual(await f.control({ type: 'finish', allowContinuation }), { status: 'queued', continued: true });
      assert.match(f.inputs[1].text, /write_file \(read_only\).*Skip this operation.*call finish_role/);
      f.denial('read_only');
      f.complete();
    }
    assert.deepEqual(await f.control({ type: 'finish', allowContinuation }), { status: 'delivered' });
    assert.equal(f.inputs.length, continued ? 2 : 1);
    f.stopClosed(); await f.result;
  }
});

test('agy role acknowledges a stop only after runtime cleanup', { timeout: 5000 }, async () => {
  const f = fixture(); await f.sent;
  let acknowledged = false;
  const receipt = f.control({ type: 'stop' }).then(value => { acknowledged = true; return value; });
  await f.closing; assert.equal(acknowledged, false);
  f.stopClosed();
  assert.equal(await receipt, 'delivered');
  assert.deepEqual(await f.result, { status: 'interrupted' }); assert.equal(f.closeCount, 1);
});

test('agy role closes the runtime and reports a start failure before sending the brief', { timeout: 5000 }, async () => {
  const error = new Error('fixture startup failure'), f = fixture({ startError: error });
  const failed = assert.rejects(f.result, candidate => candidate === error);
  await f.closing; f.stopClosed(); await failed;
  assert.equal(f.closeCount, 1); assert.deepEqual(f.inputs, []);
});

test('agy dispatch without a broker ends before locating or launching another CLI', async t => {
  const root = await temporary(t), brief = path.join(root, 'brief.md');
  await fs.writeFile(brief, 'Reply OK.');
  const events = [];
  const status = await run(['agy', '--role', 'exec', '--title', 'Missing broker', '--cwd', root, '--brief', brief,
    '--out', 'answer.md', '--model', 'gemini-3.8-flash', '--effort', 'low'],
  { env: { AGENTRIX_REMOTE_ROLE_TOOLS: '1' }, onEvent: event => events.push(event),
    locateClaude: () => assert.fail('Claude lookup'), launch: () => assert.fail('CLI launch') });
  assert.equal(status, 1);
  assert.equal(events.find(event => event.type === 'dispatch.start-failed')?.message, 'bootstrap/missing_environment');
});

test('local workers do not inherit the SSH role flag', () => {
  const { workerEnvironment } = require('../electron/features/codex-app-server/index.cjs');
  assert.deepEqual(workerEnvironment({ agentrix_remote_role_tools: '1', AGENTRIX_REMOTE_ROLE_TOOLS: '1', OTHER: 'keep' }), { OTHER: 'keep' });
});
