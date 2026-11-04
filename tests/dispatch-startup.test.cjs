const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { run } = require('../integration/dispatch.cjs');
const { createDispatchControl } = require('../electron/features/agents/dispatch-control.cjs');

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
    assert.equal(code, 0, stdout);
    const transport = stdout.split('\n').filter(line => line.includes(' fallback:'));
    assert.equal(transport.length, 1, 'report the first cause, not a second control failure caused by cleanup');
    const reason = { native: 'capability_probe/rpc_-32601', no_environment: 'bootstrap/missing_environment',
      missing_address: 'bootstrap/missing_address', invalid_json: 'bootstrap/invalid_json', missing_file: 'bootstrap/ENOENT',
      missing_capability: 'bootstrap/missing_capability', missing_session_key: 'bootstrap/missing_session_key',
      rejected_registration: 'control_register/registration_closed', dead_address: 'control_connect/' }[scenario];
    assert.ok(transport[0].includes(reason), transport[0]);
    assert.equal(transport[0].includes(root), false); assert.equal(transport[0].includes('synthetic-private-key'), false);
    assert.equal(launches, scenario === 'native' ? 2 : 1);
  });
}
