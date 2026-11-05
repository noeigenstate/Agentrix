const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { run } = require('../integration/dispatch.cjs');
const { createDispatchControl } = require('../electron/features/agents/dispatch-control.cjs');
const { apiEnvironment } = require('../electron/features/claude-sdk/credentials.cjs');

for (const scenario of ['native', 'no_environment', 'missing_address', 'invalid_json', 'missing_file', 'missing_capability', 'missing_session_key', 'rejected_registration', 'dead_address']) {
  test(`helper startup diagnoses ${scenario} without exposing bootstrap paths or credentials`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-dispatch-startup-')), lifetime = resources(t);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const control = createDispatchControl({ resolveRun: auth => auth.capability === 'synthetic-capability'
      ? { runId: auth.runId, projectId: 'p', agent: 'codex', cwd: root, allow: [], readOnly: true } : null });
    const { address } = await control.listen(); lifetime.defer('close control', () => control.close());
    const config = path.join(root, 'bootstrap-private.json'), brief = path.join(root, 'brief.md'), out = path.join(root, 'out.md');
    const fixture = path.join(root, 'fixture.json'), sessionId = randomUUID();
    fs.writeFileSync(brief, 'Synthetic task');
    fs.writeFileSync(fixture, JSON.stringify({ sessionId, lines: [
      { record: { type: 'thread.started', thread_id: sessionId } },
      { rollout: { type: 'session_meta', payload: { id: sessionId } } },
      { rollout: { type: 'turn_context', payload: { model: 'synthetic-model', effort: 'high', service_tier: 'fast' } } },
      { record: { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } } },
    ] }));
    const bootstrap = { controlAddress: scenario === 'dead_address' ? address + '-absent' : address, projectId: 'p',
      sessionKey: 'synthetic-private-key', controlCapability: 'synthetic-capability' };
    if (scenario === 'missing_address') delete bootstrap.controlAddress;
    if (scenario === 'missing_capability') delete bootstrap.controlCapability;
    if (scenario === 'missing_session_key') delete bootstrap.sessionKey;
    if (scenario === 'rejected_registration') bootstrap.controlCapability = 'synthetic-stale-capability';
    if (scenario !== 'missing_file') fs.writeFileSync(config, scenario === 'invalid_json' ? '{' : JSON.stringify(bootstrap));
    let stdout = '', launches = 0;
    const code = await run(['codex', '--role', 'review', '--title', 'Synthetic startup', '--model', 'synthetic-model', '--effort', 'high',
      '--fast', '--read-only', '--cwd', root, '--brief', brief, '--out', out], {
      env: { PATH: '', HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
        AGENTRIX_SDK_PARENT: '1', ANTHROPIC_API_KEY: 'synthetic-injected',
        ...(scenario === 'no_environment' ? {} : { AGENTRIX_BOOTSTRAP: config }),
        SYNTHETIC_CODEX_MODE: 'missing-steer', DISPATCH_FIXTURE: fixture, DISPATCH_CAPTURE: path.join(root, 'capture.json') },
      stdout: { write: value => { stdout += value; } },
      resolveExecutable: (_agent, args) => ({ file: process.execPath, args: [path.join(__dirname, 'fixtures',
        args[0] === 'app-server' ? 'codex-app-server.cjs' : 'dispatch-worker.cjs'), ...args] }),
      launch: (file, args, options) => { launches++; return lifetime.child(spawn(file, args, options)); },
    });
    assert.equal(code, 1, stdout);
    const transport = stdout.split('\n').filter(line => line.includes('failed to start'));
    assert.equal(transport.length, 1, 'one startup failure regardless of control availability');
    assert.ok(transport[0].includes('capability_probe/rpc_-32601'), transport[0]);
    assert.equal(transport[0].includes(root), false); assert.equal(transport[0].includes('synthetic-private-key'), false);
    assert.equal(launches, 1); assert.doesNotMatch(stdout, /fallback/);

  });
}

test('a GUI Claude SDK planner passes its bootstrap to the helper and its CLI fallback uses the inherited default config', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-gui-bootstrap-')), lifetime = resources(t);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const control = createDispatchControl({ resolveRun: auth => auth.sessionKey === 'synthetic-session' && auth.capability === 'synthetic-capability'
    ? { runId: auth.runId, projectId: 'p', agent: 'claude', cwd: root, allow: [], readOnly: true } : null });
  const { address } = await control.listen(); lifetime.defer('close control', () => control.close());
  let brokerCalls = 0, launched = false, stdout = '';
  control.onRequest('claude-sdk.run', async (_run, _payload, stream) => {
    brokerCalls++; stream.emit({ type: 'path.changed', payload: { selected: 'terminal', reason: 'synthetic_fallback' } });
  });
  const bootstrap = path.join(root, 'bootstrap.json'), brief = path.join(root, 'brief.md'), out = path.join(root, 'out.md');
  fs.writeFileSync(bootstrap, JSON.stringify({ controlAddress: address, projectId: 'p', sessionKey: 'synthetic-session', controlCapability: 'synthetic-capability' }));
  fs.writeFileSync(brief, 'Synthetic task');
  const env = apiEnvironment({ PATH: '', HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, 'codex'), AGENTRIX_BOOTSTRAP: bootstrap }, 'sk-ant-api03-gui-offline-only', 'gui');
  assert.equal(env.AGENTRIX_BOOTSTRAP, bootstrap); assert.equal(Object.hasOwn(env, 'CLAUDE_CONFIG_DIR'), false);
  const code = await run(['claude', '--role', 'review', '--title', 'Synthetic GUI worker', '--model', 'synthetic-model', '--effort', 'high',
    '--permission', 'plan', '--cwd', root, '--brief', brief, '--out', out], {
    env, stdout: { write: value => { stdout += value; } },
    resolveExecutable: (_agent, args) => ({ file: process.execPath, args: [path.join(__dirname, 'fixtures/codex-app-server-env.cjs'), ...args] }),
    launch: (file, args, options) => {
      launched = true; assert.equal(Object.hasOwn(options.env, 'CLAUDE_CONFIG_DIR'), false);
      assert.equal(options.env.HOME, root); assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(options.env.AGENTRIX_BOOTSTRAP, undefined);
      return lifetime.child(spawn(file, args, options));
    },
  });
  assert.equal(code, 0); assert.equal(brokerCalls, 1); assert.equal(launched, true);
  assert.match(stdout, /claude-cli fallback: synthetic_fallback/); assert.doesNotMatch(stdout, /bootstrap\/missing_environment/);
});
