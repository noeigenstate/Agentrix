const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { run } = require('../integration/dispatch.cjs');
const { createCodexRuntime, workerEnvironment } = require('../electron/features/codex-app-server/index.cjs');

const synthetic = { PATH: '', ANTHROPIC_API_KEY: 'synthetic-key', anthropic_auth_token: 'synthetic-token', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth',
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '123', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'synthetic-session',
  CLAUDE_CONFIG_DIR: 'synthetic-config', AGENTRIX_CONTROL_CAPABILITY: 'synthetic-control', AGENTRIX_BOOTSTRAP: 'synthetic-bootstrap' };

test('B3/M9: subscription CLI fallback gets neither API/OAuth credentials nor helper control authority', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-env-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brief = path.join(root, 'brief.md'), out = path.join(root, 'answer.md'); fs.writeFileSync(brief, 'Synthetic task');
  let stdout = '', launched = false;
  const code = await run(['claude', '--role', 'review', '--title', 'Synthetic CLI', '--model', 'synthetic-model', '--effort', 'high',
    '--permission', 'plan', '--cwd', root, '--brief', brief, '--out', out], { env: synthetic, stdout: { write: value => { stdout += value; } },
    resolveExecutable: (_agent, args) => ({ file: process.execPath, args: [path.join(__dirname, 'fixtures/codex-app-server-env.cjs'), ...args] }),
    launch: (file, args, options) => {
      launched = true; assert.deepEqual(options.env, { PATH: '', CLAUDE_CONFIG_DIR: 'synthetic-config' }); return spawn(file, args, options);
    } });
  assert.equal(code, 0); assert.equal(launched, true); assert.match(stdout, /claude-cli fallback/);
  assert.equal(synthetic.ANTHROPIC_API_KEY, 'synthetic-key', 'parent environment is never mutated');
});

test('B3/M9: an app-server launched by the native runtime gets the same scrubbed environment', async t => {
  let child, env;
  const runtime = createCodexRuntime({ resolveExecutable: async () => 'synthetic-only', spawnProcess: (_file, _args, options) => {
    env = options.env;
    return child = spawn(process.execPath, [path.join(__dirname, 'fixtures/codex-app-server.cjs')], options);
  } }).create({ cwd: os.tmpdir(), projectId: 'p', terminalId: 't', env: synthetic }, () => {});
  t.after(async () => { await runtime.close(); if (child?.exitCode == null) await new Promise(resolve => child.once('exit', resolve)); });
  await runtime.start(); assert.deepEqual(env, workerEnvironment(synthetic)); assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.AGENTRIX_BOOTSTRAP, undefined);
});
