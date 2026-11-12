const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');

test('N5: a read-only meeting resumes writable for dispatch execution; owner and read-only sessions retain their policies', async t => {
  const lifetime = resources(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-resume-policy-'));
  const policyFile = path.join(root, 'policy.json');
  const factory = createCodexRuntime({ resolveExecutable: async () => 'synthetic-only', spawnProcess: (_file, _args, options) =>
    lifetime.child(spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], { ...options,
      env: { ...options.env, SYNTHETIC_CODEX_MODE: 'sandbox-persist', SYNTHETIC_POLICY_FILE: policyFile } })) });
  lifetime.defer('remove fixture', () => fs.rmSync(root, { recursive: true, force: true }));
  async function open(spec) {
    const session = factory.create({ cwd: root, projectId: 'p', terminalId: 't', providerSessionId: 'same-thread', env: { PATH: '', CODEX_HOME: path.join(root, 'home') }, ...spec }, () => {});
    lifetime.defer('close runtime', () => session.close());
    await session.resume(); return session;
  }
  const meeting = await open({ owner: 'dispatch', roundtable: true });
  assert.equal(meeting.threadResponse.sandbox.type, 'readOnly'); await meeting.close();
  const execution = await open({ owner: 'dispatch' });
  assert.equal(execution.threadResponse.sandbox.type, 'workspaceWrite');
  await execution.send({ clientMessageId: 'write', text: 'Synthetic write permission check' });
  assert.equal(fs.readFileSync(path.join(root, 'synthetic-write-proof.txt'), 'utf8'), 'workspace-write');
  await execution.close();
  for (const spec of [{ owner: 'dispatch', readOnly: true }, { owner: 'dispatch', roundtable: true }]) {
    const readonly = await open(spec); assert.equal(readonly.threadResponse.sandbox.type, 'readOnly'); await readonly.close();
  }
  const owner = await open({ owner: 'gui', permissions: 'config' });
  assert.equal(owner.threadResponse.sandbox.type, 'readOnly', 'an owner resume under "config" does not override its stored read-only policy');
  await owner.close();
});

test('a GUI Codex planner retains only its bootstrap for authenticated dispatch; workers strip it', async t => {
  const lifetime = resources(t), received = [];
  const factory = createCodexRuntime({ resolveExecutable: async () => 'synthetic-only', spawnProcess: (_file, _args, options) => {
    received.push(options.env);
    return lifetime.child(spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], options));
  } });
  for (const owner of ['gui', 'dispatch']) {
    const runtime = factory.create({ owner, projectId: 'p', terminalId: owner, cwd: os.tmpdir(), env: { PATH: '',
      AGENTRIX_BOOTSTRAP: '/synthetic/project-bootstrap', AGENTRIX_SESSION_KEY: 'synthetic-private', AGENTRIX_CONTROL: 'synthetic-private' } }, () => {});
    lifetime.defer('close runtime', () => runtime.close()); await runtime.start(); await runtime.close();
    assert.equal(received.at(-1).AGENTRIX_BOOTSTRAP, owner === 'gui' ? '/synthetic/project-bootstrap' : undefined);
    assert.equal(received.at(-1).AGENTRIX_SESSION_KEY, undefined); assert.equal(received.at(-1).AGENTRIX_CONTROL, undefined);
  }
});
