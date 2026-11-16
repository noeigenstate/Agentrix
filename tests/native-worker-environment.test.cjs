require('./fixtures/team-isolation.cjs');
const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { run } = require('../integration/dispatch.cjs');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { registerClaudeWorker } = require('../electron/features/native-session/worker.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');

test('Claude worker registration preserves the authenticated lead mode and client identity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-lead-mode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = 'sk-ant-api03-synthetic-worker-credential';
  for (const leadMode of ['native', 'terminal', 'codex']) for (const claudePath of ['api-only', 'api-then-terminal', 'terminal-only']) {
    const directory = path.join(root, leadMode, claudePath), fake = fakeSdk(), events = [];
    const claude = createClaudeRuntime({ directory, safeStorage: { isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    loadSdk: async () => fake.sdk, resolveExecutable: async () => process.execPath });
    claude.credentials.save(key);
    const ownerEnv = { PATH: '', ANTHROPIC_API_KEY: 'synthetic-owner-key', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-owner-oauth',
      CLAUDE_CODE_ENTRYPOINT: 'synthetic-owner-entrypoint', claude_code_entrypoint: 'synthetic-owner-entrypoint',
      AGENTRIX_BOOTSTRAP: 'synthetic-bootstrap', AGENTRIX_CONTROL_CAPABILITY: 'synthetic-control', AGENTRIX_SESSION_KEY: 'synthetic-session' };
    const original = { ...ownerEnv }; let handler;
    registerClaudeWorker({ control: { onRequest(_name, fn) { handler = fn; } }, claude, settings: () => ({ claudePath }), env: () => ownerEnv });
    const binding = { runId: `${leadMode}-${claudePath}`, projectId: 'terminal', agent: 'claude', cwd: root, worktree: root,
      readOnly: true, allow: ['docs/**'], leadMode };
    try {
      await handler(binding, { prompt: 'Synthetic task', model: 'fake' }, { emit: event => events.push(event), onControl: () => () => {} });
      const terminal = leadMode === 'terminal' || leadMode === 'codex' && claudePath === 'terminal-only';
      assert.equal(fake.calls.length, terminal ? 0 : 1, `${leadMode} / ${claudePath}`);
      if (terminal) {
        assert.equal(events.length, 1); assert.equal(events[0].type, 'path.changed'); assert.equal(events[0].payload.selected, 'terminal');
        assert.equal(events[0].payload.reason, leadMode === 'terminal' ? 'terminal lead (subscription)' : 'terminal_selected');
      } else {
        const env = fake.calls[0].options.env;
        assert.equal(env.ANTHROPIC_API_KEY, key); assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
        assert.ok(!Object.keys(env).some(name => /^CLAUDE_CODE_ENTRYPOINT$|^AGENTRIX_(?:BOOTSTRAP|CONTROL|CAPABILITY|.*SESSION_KEY)/i.test(name)));
        assert.equal(env.AGENTRIX_SDK_PARENT, '1'); assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
        assert.ok(events.some(event => event.type === 'turn.completed'));
      }
      assert.deepEqual(ownerEnv, original); assert.ok(!JSON.stringify(events).includes(key));
      await assert.rejects(handler(binding, { prompt: 'Synthetic task', leadMode: 'forged' }, { emit() {}, onControl() {} }));
    } finally { await claude.close(); }
  }
});

test('a native Claude lead never falls back to subscription when startup cannot use the API', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-native-lead-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const keyReady of [false, true]) {
    const fake = fakeSdk(), events = []; let handler;
    const claude = createClaudeRuntime({ directory: path.join(root, String(keyReady)), safeStorage: { isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    loadSdk: async () => fake.sdk, resolveExecutable: async () => null });
    if (keyReady) claude.credentials.save('sk-ant-api03-synthetic-native-credential');
    registerClaudeWorker({ control: { onRequest(_name, fn) { handler = fn; } }, claude,
      settings: () => ({ claudePath: 'api-then-terminal' }), env: () => ({ PATH: '' }) });
    try {
      await assert.rejects(handler({ runId: 'native-worker', projectId: 'terminal', cwd: root, readOnly: true, allow: [], leadMode: 'native' },
        { prompt: 'Synthetic task' }, { emit: event => events.push(event), onControl: () => () => {} }));
      assert.equal(fake.calls.length, 0); assert.ok(!events.some(event => event.type === 'path.changed'));
    } finally { await claude.close(); }
  }
});

const synthetic = { PATH: '', ANTHROPIC_API_KEY: 'synthetic-key', anthropic_auth_token: 'synthetic-token', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth',
  CLAUDE_CODE_ENTRYPOINT: 'agentrix-sdk', claude_code_entrypoint: 'agentrix-sdk',
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '123', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'synthetic-session',
  CLAUDE_CONFIG_DIR: 'synthetic-config', AGENTRIX_CONTROL_CAPABILITY: 'synthetic-control', AGENTRIX_BOOTSTRAP: 'synthetic-bootstrap' };

for (const sdkParent of [false, true]) test(`N5: CLI preserves owner authentication and strips only marked SDK authentication (marked=${sdkParent})`, async t => {
  const lifetime = resources(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-env-test-'));
  t.after(async () => { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const brief = path.join(root, 'brief.md'), out = path.join(root, 'answer.md'); fs.writeFileSync(brief, 'Synthetic task');
  let stdout = '', launched = false;
  const code = await run(['claude', '--role', 'review', '--title', 'Synthetic CLI', '--model', 'synthetic-model', '--effort', 'high',
    '--permission', 'plan', '--cwd', root, '--brief', brief, '--out', out], { env: { ...synthetic, ...(sdkParent ? { AGENTRIX_SDK_PARENT: '1' } : {}) }, stdout: { write: value => { stdout += value; } },
    resolveExecutable: (_agent, args) => ({ file: process.execPath, args: [path.join(__dirname, 'fixtures/codex-app-server-env.cjs'), ...args] }),
    launch: (file, args, options) => {
      launched = true;
      const expected = sdkParent ? { PATH: '', CLAUDE_CONFIG_DIR: 'synthetic-config' } : { ...synthetic };
      delete expected.AGENTRIX_CONTROL_CAPABILITY; delete expected.AGENTRIX_BOOTSTRAP;
      delete expected.CLAUDE_CODE_ENTRYPOINT; delete expected.claude_code_entrypoint;
      assert.deepEqual(options.env, expected); return lifetime.child(spawn(file, args, options));
    } });
  assert.equal(code, 0); assert.equal(launched, true); assert.match(stdout, /claude-cli:/);
  assert.equal(synthetic.ANTHROPIC_API_KEY, 'synthetic-key', 'parent environment is never mutated');
});

for (const sdkParent of [false, true]) test(`N5: native Codex retains owner variables outside an SDK parent (marked=${sdkParent})`, async t => {
  const lifetime = resources(t); let env;
  const runtime = createCodexRuntime({ resolveExecutable: async () => 'synthetic-only', spawnProcess: (_file, _args, options) => {
    env = options.env;
    return lifetime.child(spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], options));
  } }).create({ cwd: os.tmpdir(), projectId: 'p', terminalId: 't', env: { ...synthetic, ...(sdkParent ? { AGENTRIX_SDK_PARENT: '1' } : {}) } }, () => {});
  lifetime.defer('close runtime', () => runtime.close());
  await runtime.start();
  assert.equal(env.ANTHROPIC_API_KEY, sdkParent ? undefined : synthetic.ANTHROPIC_API_KEY);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, sdkParent ? undefined : synthetic.CLAUDE_CODE_OAUTH_TOKEN);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, sdkParent ? undefined : '1');
  assert.equal(env.AGENTRIX_BOOTSTRAP, undefined); assert.equal(env.AGENTRIX_SDK_PARENT, undefined);
});
