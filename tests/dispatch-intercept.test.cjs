require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const shim = () => require('../integration/shims/intercept.cjs');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
function temporary(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-intercept-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}
const output = () => ({ text: '', write(value) { this.text += value; } });

test('interception maps the supported Codex options without flattening prompt or image arguments', () => {
  const options = shim().mapCommand('codex', ['exec', '-m', 'test-model', '-c', 'model_reasoning_effort="max"', '-c', 'service_tier=fast',
    '-C', 'a folder', '--image', 'a b.png', '--image=second.png', '--sandbox', 'read-only', '-o', 'answer.txt', '--', 'Keep "quotes"\nand Unicode 中文'], root);
  assert.equal(options.model, 'test-model'); assert.equal(options.effort, 'max'); assert.equal(options.fast, true);
  assert.equal(options.cwd, path.resolve(root, 'a folder')); assert.equal(options.out, path.resolve(root, 'a folder/answer.txt'));
  assert.deepEqual(options.images, [path.resolve(root, 'a folder/a b.png'), path.resolve(root, 'a folder/second.png')]);
  assert.equal(options.readOnly, true); assert.equal(options.prompt, 'Keep "quotes"\nand Unicode 中文');
});

test('interception maps Claude print mode and distinguishes a positional prompt from stdin', () => {
  const options = shim().mapCommand('claude', ['--print', '--model=sonnet', '--effort', 'high', '--permission-mode', 'acceptEdits', '--output-format=text', '-'], root);
  assert.equal(options.model, 'sonnet'); assert.equal(options.permission, 'acceptEdits'); assert.equal(options.prompt, null);
  assert.equal(shim().mapCommand('claude', ['-p', 'a prompt'], root).prompt, 'a prompt');
});

test('an unsupported option is refused by name with the equivalent command and exit code 2', async () => {
  for (const [agent, args, option] of [['codex', ['exec', '-m', 'test', '--json', 'prompt'], '--json'],
    ['claude', ['-p', '--output-format', 'stream-json', 'prompt'], '--output-format'],
    ['codex', ['exec', '--sandbox', 'danger-full-access', 'prompt'], '--sandbox'],
    ['codex', ['exec', '-m', 'one', '--model=two', 'prompt'], '--model'],
    ['codex', ['exec', '-c', 'approval_policy="never"', 'prompt'], '-c']]) {
    const stdout = output(), stderr = output();
    const code = await shim().intercept([agent, '--', ...args], { env: {}, stdout, stderr, dispatch: () => assert.fail('refused call ran') });
    assert.equal(code, 2); assert.equal(stdout.text, ''); assert.ok(stderr.text.includes(option));
    assert.match(stderr.text, /\[dispatch\] not run:.*not supported through the Agentrix dispatcher/);
    if (option === '--json') assert.match(stderr.text, /\[dispatch\] equivalent: node .*dispatch\.cjs.*codex/);
  }
  const stderr = output();
  assert.equal(await shim().intercept(['codex', '--', 'exec', '--json', '--full-auto', 'prompt'], { env: {}, stdout: output(), stderr,
    dispatch: () => assert.fail('unsupported options ran') }), 2);
  assert.doesNotMatch(stderr.text, /equivalent:/, 'more than one unmappable option has no equivalent command');
});

test('at depth one or with invalid depth a worker call is refused before stdin or dispatch', async () => {
  for (const depth of ['1', '2', '-1', 'invalid']) {
    const stderr = output();
    assert.equal(await shim().intercept(['codex', '--', 'exec', '-'], { env: { AGENTRIX_DISPATCH_DEPTH: depth }, stdout: output(), stderr,
      readInput: () => assert.fail('nested call read stdin'), dispatch: () => assert.fail('nested call ran') }), 2);
    assert.match(stderr.text, /dispatch\.intercept_nested/); assert.match(stderr.text, /delegate codex/);
  }
});

test('a rerouted stdin call uses the helper, declares intercepted, and prints only its final message', async t => {
  const cwd = temporary(t), stdout = output(), stderr = output(); let called = 0;
  const code = await shim().intercept(['codex', '--', 'exec', '-m', 'test', '-o', 'answer.txt', '-'], {
    cwd, env: { AGENTRIX_DISPATCH_DEPTH: '0', AGENTRIX_LEAD_MODE: 'forged' }, stdout, stderr, readInput: async () => 'line one\nline two',
    dispatch: async (argv, deps) => {
      called++; assert.equal(deps.source, 'intercepted'); assert.equal(deps.stdout, stderr);
      assert.equal(argv[0], 'codex'); const value = flag => argv[argv.indexOf(flag) + 1];
      assert.equal(fs.readFileSync(value('--brief'), 'utf8'), 'line one\nline two');
      assert.equal(value('--cwd'), cwd); assert.equal(argv.includes('--allow'), false);
      deps.stdout.write('[dispatch] started synthetic\n'); fs.writeFileSync(value('--out'), 'Only the final answer.\n'); return 0;
    },
  });
  assert.equal(code, 0); assert.equal(called, 1); assert.equal(stdout.text, 'Only the final answer.\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'answer.txt'), 'utf8'), stdout.text);
  assert.match(stderr.text, /started synthetic/);
  assert.deepEqual(fs.readdirSync(cwd), ['answer.txt'], 'private brief, log and result files are cleaned');
});

test('helper failures become exit one and cannot mix dispatch reports into stdout', async t => {
  const stdout = output(), stderr = output();
  assert.equal(await shim().intercept(['claude', '--', '-p', 'prompt'], { cwd: temporary(t), env: {}, stdout, stderr,
    dispatch: async (_argv, deps) => { deps.stdout.write('[dispatch] failed to start synthetic\n'); return 37; } }), 1);
  assert.equal(stdout.text, ''); assert.match(stderr.text, /failed to start/);
});

test('withShims preserves the caller environment and sets one PATH, depth and opaque run identity', () => {
  const before = { Path: 'real-tools', PATH: 'duplicate', AGENTRIX_RUN_ID: 'old', AGENTRIX_RUN_PROOF: 'old-proof' };
  const next = shim().withShims(before, { depth: 1, runId: 'worker-id', proof: 'opaque-proof' });
  assert.equal(before.Path, 'real-tools'); assert.equal(next.AGENTRIX_DISPATCH_DEPTH, '1');
  assert.equal(next.AGENTRIX_RUN_ID, 'worker-id'); assert.equal(next.AGENTRIX_RUN_PROOF, 'opaque-proof');
  assert.equal(Object.keys(next).filter(key => key.toUpperCase() === 'PATH').length, 1);
  assert.equal(next.Path.split(path.delimiter)[0], path.join(root, 'integration/shims'));
  const owner = shim().withShims(next, { depth: 0 });
  assert.equal(owner.AGENTRIX_RUN_ID, undefined); assert.equal(owner.AGENTRIX_RUN_PROOF, undefined);
  assert.equal(owner.Path.split(path.delimiter).filter(folder => folder === path.join(root, 'integration/shims')).length, 1);
});

test('bootstrap names the executable shim folder for terminal and native owner sessions', t => {
  const file = path.join(temporary(t), 'bootstrap.json');
  require('../electron/features/terminal-events/bootstrap-file.cjs').writeBootstrap({ file, eventServer: { name: 'test-pipe', address: '/test-pipe' },
    projectId: 'test', projectPath: root, sessionKey: 'synthetic' });
  const bootstrap = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(bootstrap.shims, path.join(root, 'integration/shims')); assert.equal(bootstrap.nodePath, process.execPath);
});

test('a native owner receives shim depth zero while account reads remain without interception', t => {
  const folder = temporary(t), bootstrapFile = path.join(folder, 'bootstrap.json');
  fs.writeFileSync(bootstrapFile, JSON.stringify({ shims: path.join(root, 'integration/shims') }));
  const { nativeEnvironment } = require('../electron/features/native-session/host-inputs.cjs').createHostInputs({
    withoutAppImage: env => env, createTerminalEnvironment: (_env, bootstrap) => ({ PATH: 'tools', AGENTRIX_BOOTSTRAP: bootstrap,
      AGENTRIX_RUN_ID: 'stale', AGENTRIX_RUN_PROOF: 'stale' }),
  });
  const env = nativeEnvironment(bootstrapFile, 'test-codex-home');
  assert.equal(env.PATH.split(path.delimiter)[0], path.join(root, 'integration/shims'));
  assert.equal(env.AGENTRIX_DISPATCH_DEPTH, '0'); assert.equal(env.AGENTRIX_RUN_ID, undefined); assert.equal(env.CODEX_HOME, 'test-codex-home');
  assert.equal(nativeEnvironment('').AGENTRIX_DISPATCH_DEPTH, undefined);
});

test('interactive wrappers read bootstrap shims and keep real CLI lookup outside that folder', () => {
  for (const name of ['integration/bootstrap.ps1', 'integration/bash-integration.bash', 'integration/zsh-integration.zsh']) {
    const text = read(name);
    assert.match(text, /AGENTRIX_DISPATCH_DEPTH/); assert.match(text, /AGENTRIX_SHIM_NODE/);
    assert.match(text, /\.shims|\[.?shims.?\]/);
    assert.match(text, /\.agentrix-shims|__pg_shims/, `${name} excludes shims when an owner wrapper resolves the CLI`);
  }
});
