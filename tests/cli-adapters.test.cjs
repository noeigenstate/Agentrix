const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const shared = require('../electron/features/cli-adapters/registry.mjs');

const projectionFile = path.join(__dirname, '../electron/features/cli-adapters/manifests/worker.cjs');
if (process.argv.includes('--write-worker-manifests')) {
  const rows = shared.adapters().map(({ manifest: { id, install, models } }) =>
    `  { id: ${JSON.stringify(id)}, install: { minVersion: ${JSON.stringify(install.minVersion)} }, models: { match: ${models.match} } },`);
  fs.writeFileSync(projectionFile, '// Generated from registry.mjs by node tests/cli-adapters.test.cjs --write-worker-manifests.\n' +
    'module.exports = [\n' + rows.join('\n') + '\n];\n');
}

const { adapters, adapterOf, adapterOfModel, agentOfModel, createAdapter, bindNativeAdapters } = require('../electron/features/cli-adapters/registry.cjs');
const { CAPABILITY_KEYS, UNSUPPORTED, UNVERIFIED_VERSION, support } = require('../electron/features/cli-adapters/capabilities.mjs');
const claudeRuntime = require('../electron/features/claude-runtime/adapter.cjs');
const codexRuntime = require('../electron/features/codex-runtime/adapter.cjs');
const { allowsUltracode } = require('../electron/features/skills/seat-rules.mjs');
const en = require('../electron/locales/en.json');

test('carried workers use the shared manifest projection', () => {
  const carried = require(projectionFile);
  const { workerOf } = require('../electron/features/cli-adapters/workers.cjs');
  assert.deepEqual(carried, shared.adapters().map(({ manifest: { id, install: { minVersion }, models: { match } } }) =>
    ({ id, install: { minVersion }, models: { match } })));
  assert.equal(require('../electron/features/claude-runtime/locator.cjs').REQUIRED, shared.adapterOf('claude').manifest.install.minVersion);
  for (const { id } of carried) assert.equal(adapterOf(id).worker, workerOf(id));
  assert.equal(workerOf('codex').command({}), 'native');
});

test('workers can run tests and Unity, and refuse explicit Git operations inside shell wrappers', () => {
  const { workerRefusal } = require('../electron/features/cli-adapters/workers.cjs');
  for (const readOnly of [false, true]) {
    const check = command => workerRefusal({ readOnly }, { operation: 'command', command });
    for (const command of ['git commit -m test', 'git -C "my repo" push', 'git reset HEAD --hard',
      'bash -lc "git -C nested reset --hard HEAD"', 'powershell.exe -Command "git -C nested commit -m x"',
      "pwsh -c 'git -C nested push'", 'git status && git push', "git com''mit", 'git com`mit',
      'git -c color.ui=never -C "my repo" CLEAN -fd', 'cmd /c "git restore path"', 'cmd.exe /C git stash',
      'cmd /c ""C:\\Program Files\\Git\\bin\\git.exe" clean -fd"', 'git --git-dir nested/.git restore path',
      '& "C:\\Program Files\\Git\\bin\\git.exe" checkout -- path', '/usr/bin/git checkout other', 'GIT SWITCH other',
      'git merge other', 'git rebase other', 'git cherry-pick HEAD', 'git revert HEAD', 'git update-ref refs/heads/topic HEAD',
      'git branch -f topic HEAD', 'git branch -D topic', 'git tag topic',
      'git com\\\nmit', 'git com`\r\nmit']) assert.equal(check(command), 'git_forbidden', command);
    for (const command of ['git status', 'git reset --soft HEAD~1', 'git -C nested log', 'npm test', 'Unity -batchmode -runTests',
      'pwsh -c "git -C nested status"', 'git log --grep commit', 'git diff -- docs/push.md',
      'rg "git commit"', 'rg "some text; git commit"', 'cmd /c "git log --grep commit"', 'git branch -av',
      'git reset HEAD -- --hard']) assert.equal(check(command), null, command);
  }
});

test('file approval checks every path against the cwd, glob and exact skill grant', t => {
  const { workerRefusal } = require('../electron/features/cli-adapters/workers.cjs');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-worker-policy-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const allow = ['src/**'];
  const edit = (paths, scope = {}) => workerRefusal({ cwd, allow, ...scope }, { operation: 'edit', paths });
  assert.equal(edit([path.join(cwd, 'src', 'new.txt')]), null);
  assert.equal(edit(['src/new.txt'], { readOnly: true }), 'read_only');
  assert.equal(edit(['src/new.txt', '../escape.txt']), 'outside_worktree');
  assert.equal(edit(['src/new.txt', 'outside.txt']), 'outside_scope');
  assert.equal(edit([], {}), 'invalid_path');
  assert.equal(edit(['src/SKILL.md']), 'skill_not_authorized');
  assert.equal(edit(['src/SKILL.md'], { allow: ['src/SKILL.md'] }), null);
  fs.symlinkSync(path.dirname(cwd), path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(edit(['linked/escape.txt'], { allow: ['**'] }), 'outside_worktree');
});

test('a Claude print role with a result server uses a strict tool allowlist', () => {
  const { workerOf } = require('../electron/features/cli-adapters/workers.cjs');
  const worker = workerOf('claude'), server = { command: 'node', args: ['dispatch.cjs', 'mcp-role'] };
  assert.deepEqual(worker.resultServer(server), { mcpServers: { agentrix_role: server } });
  const args = worker.command({ model: 'opus', effort: 'high', permission: 'dontAsk', roleConfig: 'result-mcp.json' });
  const value = flag => args[args.indexOf(flag) + 1];
  assert.equal(value('--mcp-config'), 'result-mcp.json');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(value('--allowedTools').split(',').includes('mcp__agentrix_role__finish_role'));
  assert.ok(!value('--disallowedTools').split(',').includes('mcp__*'));
});

test('both registry entry points expose complete capability manifests', () => {
  assert.deepEqual(shared.adapters().map(({ manifest }) => manifest), adapters().map(({ manifest }) => manifest));
  assert.deepEqual(adapters().map(({ manifest }) => manifest.id), ['claude', 'codex']);
  for (const adapter of adapters()) {
    const { manifest } = adapter;
    assert.equal(adapterOf(manifest.id), adapter);
    assert.equal(shared.adapterOf(manifest.id).manifest, manifest);
    assert.deepEqual(Object.keys(manifest.supports).sort(), [...CAPABILITY_KEYS].sort());
    for (const key of CAPABILITY_KEYS) {
      const capability = manifest.supports[key];
      if (capability.unsupported) assert.equal(capability.unsupported, UNSUPPORTED[key]);
      else assert.ok(['api', 'hook', 'screen', 'arg'].includes(capability.via), `${manifest.id} ${key}`);
    }
  }
  assert.equal(adapterOf('constructor'), undefined);
  for (const reason of [...Object.values(UNSUPPORTED), UNVERIFIED_VERSION]) assert.equal(typeof en[reason], 'string', reason);
  assert.match('2.1.331 (Claude Code)', adapterOf('claude').manifest.install.versionPattern);
  assert.match('codex-cli 0.166.0', adapterOf('codex').manifest.install.versionPattern);
});

test('registry adapters expose dedicated install facets and native version floors', () => {
  for (const [id, floor] of [['claude', '2.1.317'], ['codex', '0.166.0']]) {
    const { manifest, install } = adapterOf(id);
    assert.equal(manifest.install.minVersion, floor);
    assert.equal(typeof install.locate, 'function');
    assert.equal(typeof install.refresh, 'function');
  }
});

test('native adapters use the runtime bound to their host', () => {
  const spec = { agent: 'codex' }, emit = () => {};
  const first = { create(...args) { assert.deepEqual(args, [spec, emit]); return this; } };
  const second = { create() { return this; } };
  const firstHost = bindNativeAdapters({ codex: first }), secondHost = bindNativeAdapters({ codex: second });
  const registered = adapterOf(spec.agent), bound = firstHost(spec.agent);
  assert.equal(typeof registered.native.load, 'function');
  assert.equal(bound.manifest, registered.manifest);
  assert.equal(bound.nativePolicy, registered.nativePolicy);
  assert.equal(bound.native.create(spec, emit), first);
  assert.equal(secondHost(spec.agent).native.create(spec, emit), second);
  assert.equal(firstHost(spec.agent).native.create(spec, emit), first);
});

test('install facets forward the environment and retain the locator outcomes', async () => {
  const env = { PATH: '' }, file = '/tools/cli', reason = { code: 'codex.unreadable' };
  const old = { terminal: { file, version: '2.1.300' }, reason: 'too_old' };
  const split = { ...old, native: { file: '/tools/native', version: '2.1.317' }, reason: 'cli_split_versions' };
  const stub = (initial, refreshed) => ({
    locate: async input => { assert.equal(input.env, env); return initial; },
    refresh: async () => refreshed,
  });
  const claude = claudeRuntime.createInstall(stub(old, split));
  assert.deepEqual(await claude.locate(env), { installed: true, version: '2.1.300', file, reason: 'too_old' });
  assert.deepEqual(await claude.refresh(), { installed: true, version: '2.1.300', file, reason: 'cli_split_versions' });
  const codex = codexRuntime.createInstall(stub({ file, version: null, reason }, { file, version: '0.165.0', reason: null }));
  assert.deepEqual(await codex.locate(env), { installed: true, version: null, file, reason });
  assert.deepEqual(await codex.refresh(), { installed: true, version: '0.165.0', file, reason: null });
});

test('a manifest supplies a PATH install facet when there is no dedicated locator', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-cli-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const command = 'example-cli', env = { Path: `"${dir}"` }, windows = process.platform === 'win32';
  const file = path.join(dir, command + (windows ? '.exe' : ''));
  const manifest = { id: 'example', command, install: { versionPattern: /\d+\.\d+\.\d+/, minVersion: '1.2.10' } };
  let stdout = 'Example CLI 1.2.9', error = null;
  const run = (executable, args, options, callback) => {
    assert.deepEqual([executable, args, options.env], [file, ['--version'], env]);
    callback(error, stdout);
  };
  const { install, settingsInstall } = createAdapter(manifest, undefined, { run });
  assert.deepEqual(await install.locate(env), { installed: false, version: null, file: null, reason: 'not_found' });
  fs.writeFileSync(file, '', { mode: 0o755 });
  assert.deepEqual(await install.locate(env), { installed: true, version: '1.2.9', file, reason: 'too_old' });
  stdout = 'Example CLI 1.2.10';
  const settings = settingsInstall();
  assert.equal(settings.peek(), null);
  assert.deepEqual(await settings.refresh(env), { installed: true, version: '1.2.10', file, reason: null });
  assert.equal(settings.peek().version, '1.2.10');
  stdout = 'Usage';
  assert.deepEqual(await install.refresh(env), { installed: true, version: null, file, reason: 'unreadable' });
  error = { killed: true };
  assert.deepEqual(await install.refresh(env), { installed: true, version: null, file, reason: 'timeout' });
});

test('the first matching model rule preserves existing seat ownership', () => {
  for (const model of ['opus', 'sonnet-5', 'haiku', 'fable', 'claude-opus-5-5']) assert.equal(agentOfModel(model), 'claude');
  for (const model of ['gpt-6.2-sol', 'third-party-model', 'Claude-opus', '']) assert.equal(agentOfModel(model), 'codex');
});

test('model defaults preserve effort order and restrict Ultracode to eligible leads', () => {
  for (const [model, agent, efforts, ultracode] of [
    ['fable', 'claude', ['low', 'medium', 'high', 'xhigh', 'max'], true],
    ['third-party-model', 'codex', ['low', 'medium', 'high', 'xhigh'], false],
  ]) {
    const adapter = adapterOfModel(model);
    assert.equal(adapter, adapterOf(agent));
    assert.equal(adapter.manifest, shared.adapterOfModel(model).manifest);
    assert.deepEqual(adapter.manifest.models.efforts, efforts);
    assert.equal(allowsUltracode(model, true), ultracode);
    assert.equal(allowsUltracode(model, false), false);
  }
});

test('support reports the implementation channel or an explicit unsupported reason', () => {
  const { manifest: claude } = adapterOf('claude'), { manifest: codex } = adapterOf('codex');
  assert.deepEqual(support(claude, 'terminal'), { ok: true, via: 'arg' });
  assert.deepEqual(support(claude, 'messageNote'), { ok: true, via: 'hook' });
  assert.deepEqual(support(codex, 'ssh.native', '0.166.0'), { ok: true, via: 'api' });
  assert.deepEqual(support(claude, 'ssh.native'), { ok: false, reason: UNSUPPORTED['ssh.native'] });
  assert.deepEqual(support(codex, 'terminal'), { ok: false, reason: UNSUPPORTED.terminal });
  assert.deepEqual(support({ supports: { native: true } }, 'native'), { ok: true });
  assert.deepEqual(support({ supports: {} }, 'resume'), { ok: false, reason: UNSUPPORTED.resume });
});

test('support refuses versions older than the verified range and flags newer ones', () => {
  const { manifest: claude } = adapterOf('claude');
  const screen = { ok: true, via: 'screen' };
  const unverified = { ok: false, reason: UNVERIFIED_VERSION, params: { cli: claude.label } };
  for (const key of ['liveModel', 'liveEffort', 'fast', 'ultracode']) {
    for (const version of [undefined, '2.1.317', '2.1.331', '2.1.331+build.1']) assert.deepEqual(support(claude, key, version), screen);
    assert.deepEqual(support(claude, key, '2.1.332'), { ...screen, unverified: true });
    for (const version of ['2.1.316', '2.1.331-beta.1', 'invalid']) assert.deepEqual(support(claude, key, version), unverified);
  }
  const fixture = { ...claude, supports: { liveModel: { via: 'screen', verified: ['2.1.9', '2.1.11'] } } };
  for (const version of ['2.1.9', '2.1.10', '2.1.11']) assert.deepEqual(support(fixture, 'liveModel', version), screen);
  assert.deepEqual(support(fixture, 'liveModel', '2.1.8'), unverified);
  assert.deepEqual(support(fixture, 'liveModel', '2.1.12'), { ...screen, unverified: true });
  assert.deepEqual(support(claude, 'native', '2.1.332'), { ok: true, via: 'api' });
});

test('terminal hooks and local transcript records come from the registered CLI', () => {
  const claude = adapterOf('claude'), codex = adapterOf('codex');
  const hooks = claude.events.hooks;
  assert.equal(codex.events?.hooks, undefined);
  assert.equal(hooks.signal('Notification', { notification_type: 'idle_prompt' }).activity, null);
  assert.equal(hooks.signal('StopFailure', {}).activity.state, 'failed');
  assert.equal(hooks.signal('SubagentStart', { agent_id: 'child' }).subagent.agentId, 'child');

  const usage = { output_tokens: 8 };
  const reply = claude.transcript.record({ type: 'assistant', message: { model: 'opus', usage, stop_reason: 'end_turn' } });
  assert.equal(reply.settings.model, 'opus');
  assert.equal(reply.usage, usage);
  assert.equal(reply.done, true);

  const timestamp = '2026-01-01T00:00:00.000Z';
  const evt = codex.transcript.record({ type: 'event_msg', timestamp, payload: { type: 'turn_aborted', turn_id: 'turn' } });
  assert.deepEqual(evt, { state: 'interrupted', done: true, turnId: 'turn', at: Date.parse(timestamp) });
});
