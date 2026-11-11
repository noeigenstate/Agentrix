require('./fixtures/team-isolation.cjs');
const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { run } = require('../integration/dispatch.cjs');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');

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
  assert.equal(code, 0); assert.equal(launched, true); assert.match(stdout, /claude-cli fallback/);
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
