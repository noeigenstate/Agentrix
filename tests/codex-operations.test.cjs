const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const os = require('node:os');
const path = require('node:path');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { cleanCodexConfig } = require('../electron/features/agents/dispatch-control.cjs');

const threadId = '11111111-1111-4111-8111-111111111111';
const review = { review_model: 'gpt-6.3-sol' };
const base = { model_reasoning_effort: 'high' };
const writable = { 'windows.sandbox': 'unelevated' };

function session(t, { platform = 'linux', permissions = 'full', config = review, reject, requiresUnelevated = false, kind, allowFreshResume } = {}) {
  const wire = [], events = [], cwd = process.cwd();
  function spawn() {
    const child = new EventEmitter();
    child.remote = kind === 'ssh';
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
    child.stdin = new Writable({ write(bytes, _encoding, done) {
      const { id, method, params } = JSON.parse(bytes.toString());
      if (id == null) return done();
      let result = {};
      const send = reply => queueMicrotask(() => child.stdout.write(JSON.stringify({ id, ...reply }) + '\n'));
      if (method === 'initialize') result = { userAgent: 'codex/0.167.0' };
      if (['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(method) && !params.threadId) {
        send({ error: { code: -32602, message: 'Missing thread ID' } }); return done();
      }
      if (['thread/start', 'thread/resume'].includes(method)) {
        wire.push({ method, params });
        const error = reject?.(params, method);
        if (error) { send({ error }); return done(); }
        const type = requiresUnelevated && params.config?.['windows.sandbox'] !== 'unelevated' ? 'readOnly'
          : params.sandbox === 'workspace-write' ? 'workspaceWrite' : 'dangerFullAccess';
        result = { thread: { id: params.threadId || threadId, status: { type: 'idle' } }, cwd: params.cwd,
          sandbox: { type }, approvalPolicy: params.approvalPolicy, approvalsReviewer: 'user' };
      }
      if (method === 'thread/turns/list') result = { data: [] };
      send({ result }); done();
    } });
    return child;
  }
  const runtime = createCodexRuntime({ platform, spawnProcess: spawn, resolveExecutable: () => 'synthetic',
    launchRemote: async () => ({ cwd, child: spawn(), hosts: [] }) });
  const env = { CODEX_HOME: path.join(os.tmpdir(), 'agx-operation-config-fixture'), PATH: '' };
  const run = runtime.create({ owner: 'gui', cwd, env, kind, projectId: 'p', terminalId: 't', providerSessionId: threadId,
    operations: { config }, effort: 'high', permissions, allowFreshResume }, event => events.push(event));
  t.after(() => run.close());
  const receipt = () => events.find(event => event.type === 'routing.updated')?.payload.operations;
  return { run, wire, receipt };
}

test('Codex start and SSH resume pass exactly the configured operation keys and preserve seat config', async t => {
  const config = { 'memories.extract_model': 'gpt-mini', 'memories.consolidation_model': 'gpt-mini', ...review };
  const local = session(t, { config });
  await local.run.start();
  assert.deepEqual(local.wire.map(row => row.params.config), [{ ...config, ...base }]);
  assert.deepEqual(local.receipt(), { applied: Object.keys(config), refused: [] });
  await local.run.close();

  const remote = session(t, { config, kind: 'ssh' });
  await remote.run.resume();
  assert.equal(remote.wire[0].method, 'thread/resume');
  assert.deepEqual(remote.wire[0].params.config, { ...config, ...base });
  assert.equal(remote.wire[0].params.excludeTurns, true);
});

test('a definite Codex operation refusal retries once without the keys and reports the bounded reason', async t => {
  const reason = 'Unsupported operation setting ' + 'x'.repeat(220);
  const fixture = session(t, { reject: params => params.config.review_model && { code: -32602, message: reason } });
  await fixture.run.start();
  assert.deepEqual(fixture.wire.map(row => row.params.config), [{ ...review, ...base }, base]);
  assert.deepEqual(fixture.receipt(), { applied: [], refused: [{ key: 'review_model', reason: reason.slice(0, 200) }] });
});

test('Codex unelevated retry keeps accepted operations and does not restore refused ones', async t => {
  const windows = { platform: 'win32', permissions: 'ask', requiresUnelevated: true };
  const accepted = session(t, windows);
  await accepted.run.start();
  assert.deepEqual(accepted.wire.map(row => row.params.config), [{ ...review, ...base }, { ...review, ...base, ...writable }]);
  await accepted.run.close();

  const refusal = { code: -32602, message: 'Unsupported operation setting' };
  const refused = session(t, { ...windows, reject: params => params.config.review_model && refusal });
  await refused.run.start();
  assert.deepEqual(refused.wire.map(row => row.params.config), [{ ...review, ...base }, base, { ...base, ...writable }]);
  assert.deepEqual(refused.receipt(), { applied: [], refused: [{ key: 'review_model', reason: refusal.message }] });
});

test('failed Codex fallback preserves the original rejection, and missing threads do not retry operation keys', async t => {
  const fixture = session(t, { reject: params => ({ code: -32000, message: params.config.review_model ? 'first rejection' : 'second rejection' }) });
  await assert.rejects(fixture.run.start(), { serverMessage: 'first rejection' });
  assert.equal(fixture.wire.length, 2);
  const missing = session(t, { reject: () => ({ code: -32600, message: 'no rollout found for thread id ' + threadId }) });
  await assert.rejects(missing.run.resume(), { missingThread: true });
  assert.deepEqual(missing.wire.map(row => row.params.config), [{ ...review, ...base }]);
});

test('native Codex and dispatch control admit the same five validated operation keys', async t => {
  const valid = { ...review, 'agents.default_subagent_model': 'gpt-mini', 'agents.default_subagent_reasoning_effort': 'xhigh',
    'memories.extract_model': 'gpt-mini', 'memories.consolidation_model': 'gpt-mini' };
  for (const [config, expected] of [
    [{ ...review, 'windows.sandbox': 'unelevated' }, undefined], [valid, valid],
    [{ review_model: '-invalid' }, undefined], [{ review_model: 'x'.repeat(161) }, undefined],
    [{ 'agents.default_subagent_reasoning_effort': 'very high' }, undefined],
    [{ 'memories.extract_model': ['gpt-mini'] }, undefined], [[review], undefined], [{}, undefined],
  ]) {
    const fixture = session(t, { config });
    await fixture.run.start();
    assert.deepEqual(fixture.wire.map(row => row.params.config), [{ ...expected, ...base }]);
    assert.deepEqual(fixture.receipt(), expected && { applied: Object.keys(expected), refused: [] });
    assert.deepEqual(cleanCodexConfig(config), expected);
    await fixture.run.close();
  }
});

test('a missing thread after Codex rejects operation keys can resume fresh without those keys', async t => {
  const reason = 'Unsupported operation setting';
  const fixture = session(t, { allowFreshResume: true, reject: (params, method) => method === 'thread/resume' && (params.config.review_model
    ? { code: -32602, message: reason } : { code: -32600, message: 'no rollout found for thread id ' + threadId }) });
  await fixture.run.resume();
  assert.deepEqual(fixture.wire.map(({ method }) => method), ['thread/resume', 'thread/resume', 'thread/start']);
  assert.deepEqual(fixture.wire.map(({ params }) => params.config), [{ ...review, ...base }, base, base]);
  assert.deepEqual(fixture.receipt(), { applied: [], refused: [{ key: 'review_model', reason }] });
});
