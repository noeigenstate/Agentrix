const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { accountLaunch, accountEnvironment, safeAccountArgs } = require('../integration/codex-account-scope.cjs');
const { scopePathKey, usageScope } = require('../electron/features/agents/codex-account-usage.cjs');
const { shellEvent } = require('../integration/agent-event.cjs');

const benign = [[], ['-m', 'gpt-6.1-sol'], ['--model', 'gpt-test'], ['--model=gpt-test'], ['-mgpt-test'],
  ['-c', 'model_reasoning_effort=high'], ['--config=model_reasoning_effort="xhigh"'],
  ['-cservice_tier="fast"'], ['-c', "service_tier='priority'"], ['-c', 'model="gpt-test"'],
  ['-m', 'gpt-test', '-c', 'model_reasoning_effort=high', '-c', 'service_tier="fast"', 'opaque prompt'],
  ['resume', '--last'], ['resume', '12345678-1234-1234-1234-123456789abc', 'opaque prompt', '-m', 'gpt-test'],
  ['--model', 'gpt-test', 'resume', '--last', '--all'],
  ['opaque prompt mentioning -c model_provider=relay'], ['--', '--profile is literal prompt text'],
];
const unsupported = [['-m'], ['--model='], ['-m', '-c', 'model_reasoning_effort=high'], ['-c'],
  ['-c', 'model_reasoning_effort='], ['-c', 'service_tier={ base_url="other" }'],
  ['-m', 'gpt-test', '-c', 'model_provider="relay"'], ['-m', 'gpt-test', '--profile', 'work'],
  ['resume', '--last', '-c', 'cli_auth_credentials_store="keyring"'], ['-m', 'gpt-test', '-C', 'other'],
  ['-c', 'chatgpt_base_url="https://example.invalid"'], ['--config', 'model_providers.openai.base_url="other"'],
  ['-c', 'model_reasoning_effort=high\nmodel_provider=relay'], ['-m', 'gpt-test', '--unknown'],
  ['--model', 'gpt-test', '--config-dir', 'other'], ['--oss'], ['--last'], ['two', 'prompts'],
  ['resume', '--last', '--', 'a', 'b', 'c'], ['-c', 'model_reasoning_effort="unterminated'],
];

test('the complete launch argv proves only model/effort/service-tier changes, leaving prompts opaque', () => {
  benign.forEach((args, i) => assert.equal(safeAccountArgs(args), true, `benign case ${i}`));
  unsupported.forEach((args, i) => assert.equal(safeAccountArgs(args), false, `unsupported case ${i}`));
});

test('launch proof detects runtime credential/endpoint/profile/home changes without inspecting credential values', () => {
  const env = { HOME: '/h', USERPROFILE: 'C:\\Users\\fixture', CODEX_HOME: '/codex', APPDATA: '/data' };
  const baseline = accountEnvironment(env);
  assert.equal(accountLaunch(['-m', 'gpt-test'], env, baseline), 'model-only-v1');
  for (const name of ['OPENAI_API_KEY', 'CODEX_AUTH_TOKEN', 'OPENAI_BASE_URL', 'CODEX_PROFILE', 'CODEX_CONFIG_DIR', 'CODEX_MODEL_PROVIDER']) {
    const changed = { ...env };
    Object.defineProperty(changed, name, { enumerable: true, get() { throw new Error('credential values must not be inspected'); } });
    assert.equal(accountLaunch([], changed, baseline), 'unavailable');
    assert.equal(accountEnvironment(changed).overridden, true);
  }
  for (const name of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'APPDATA', 'XDG_CONFIG_HOME']) {
    assert.equal(accountLaunch([], { ...env, [name]: 'changed' }, baseline), 'unavailable');
  }
  const inherited = accountEnvironment({ ...env, OPENAI_API_KEY: 'fixture-only' });
  assert.equal(accountLaunch([], env, inherited), 'unavailable', 'removing an inherited account override is also unproven');
  assert.equal(accountLaunch([], env, undefined), 'unavailable');
  assert.equal(accountLaunch([], env, {}), 'unavailable');
  assert.equal(accountLaunch(['-m', 'gpt-test', '--profile', 'work'], env, baseline), 'unavailable');
});

test('scope helper stdin/stdout exposes only the enum, never raw argv or diagnostics', async () => {
  const env = { SystemRoot: process.env.SystemRoot || '', HOME: '/fixture' };
  for (const args of [benign[1], unsupported[6], ['opaque private fixture prompt']]) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve(__dirname, '../integration/codex-account-scope.cjs')],
        { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
      child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
      child.stdin.end(JSON.stringify({ args, baseline: accountEnvironment(env) }));
    });
    assert.equal(result.code, 0); assert.equal(result.err, '');
    assert.match(result.out, /^(model-only-v1|unavailable)$/);
  }
});

test('Windows cwd aliases compare by normalized path identity while different directories stay unavailable', () => {
  const forms = ['C:\\Work\\project', 'c:\\work\\PROJECT\\', '\\\\?\\C:\\Work\\project', 'C:/Work/parent/../project'];
  for (const form of forms) assert.equal(scopePathKey(form, 'win32'), scopePathKey(forms[0], 'win32'));
  assert.equal(scopePathKey('\\\\?\\UNC\\server\\share\\project', 'win32'), scopePathKey('\\\\server\\share\\project', 'win32'));
  assert.notEqual(scopePathKey('C:\\Work\\other', 'win32'), scopePathKey(forms[0], 'win32'));
  assert.notEqual(scopePathKey('/work/Project', 'linux'), scopePathKey('/work/project', 'linux'));
  if (process.platform === 'win32') {
    const options = { cwd: forms[0], recordedCwd: forms[2], codexHome: 'C:\\fixture', provider: 'openai', env: {}, accountLaunch: 'model-only-v1', command: '-m' };
    assert.equal(usageScope(options).reason, undefined);
    assert.equal(usageScope({ ...options, recordedCwd: 'C:\\Work\\other' }).reason, 'scope');
  }
});

test('shell event capability is enum-only and does not change first-word command detection', () => {
  const fields = ['agent-started', '1', '0', 'codex', 'true', 'false', '/fixture/home', '/fixture/project', '-m'];
  const safe = shellEvent([...fields, 'model-only-v1'], 'fixture', 'key');
  assert.equal(safe.accountLaunch, 'model-only-v1'); assert.equal(safe.command, '-m');
  for (const proof of [undefined, true, 'unavailable', 'opaque fixture input']) {
    const event = shellEvent([...fields, proof], 'fixture', 'key');
    assert.equal(event.accountLaunch, 'unavailable');
    assert.doesNotMatch(JSON.stringify(event), /opaque|args|prompt|baseline/);
  }
});
