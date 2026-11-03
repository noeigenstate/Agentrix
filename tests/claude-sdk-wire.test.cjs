const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const vm = require('node:vm');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createSdkLoader } = require('../electron/features/claude-sdk/runtime.cjs');
const { fixtureProcesses } = require('./fixtures/claude-sdk-processes.cjs');
let sdkModule = process.env.AGENTRIX_TEST_SDK_MODULE;
try { sdkModule ||= require.resolve('@anthropic-ai/claude-agent-sdk'); } catch { }
function isolatedSdk(scope) {
  const resources = path.join(scope.directory, 'resources');
  const entry = path.join(resources, 'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.copyFileSync(sdkModule, entry);
  // Deliberately no peer packages: exercise the actual packaged entry's runtime import closure.
  return createSdkLoader({ packaged: true, resourcesPath: resources });
}
test('B3 the real SDK launches a fake native CLI whose helper, hook, MCP and transcript contain no key', { skip: !sdkModule && 'SDK dependency is not installed in this isolated worktree', timeout: 30000 }, async t => {
  const scope = fixtureProcesses(t, 'agx-sdk-wire-'), { directory } = scope;
  const loadSdk = isolatedSdk(scope);
  const { prepareProviders } = await import('../scripts/native-session-smoke.mjs');
  const { bin, cli } = await prepareProviders(directory);
  const home = path.join(directory, 'home'), config = path.join(home, 'claude');
  fs.mkdirSync(config, { recursive: true });
  const env = { PATH: bin, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config,
    AGENTRIX_FAKE_NODE: process.execPath, AGENTRIX_FAKE_CLI: cli, AGENTRIX_FAKE_OUTPUT: directory,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
  let wireFailure = ''; const stderr = [];
  const factory = createClaudeRuntime({ directory: path.join(directory, 'records'),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).reverse(), decryptString: value => Buffer.from(value).reverse().toString() },
    loadSdk: async () => {
      const sdk = await loadSdk();
      return { query(spec) {
        const query = sdk.query({ ...spec, options: { ...spec.options, stderr: text => stderr.push(text),
          spawnClaudeCodeProcess: scope.sdkSpawn.bind(scope) } });
        return { close: () => query.close(), interrupt: () => query.interrupt(), async *[Symbol.asyncIterator]() {
          try { yield* query; } catch (error) { wireFailure = error.message; throw error; }
        } };
      } };
    }, resolveExecutable: async () => path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude') });
  scope.defer(() => factory.close());
  const key = 'sk-ant-api03-actual-sdk-offline-fixture-never-real'; factory.credentials.save(key);
  const events = [], session = factory.create({ agent: 'claude', owner: 'dispatch', allow: ['**'], cwd: directory, projectId: 'p', terminalId: 't', runtimeSessionId: randomUUID(), env, monthlyBudgetUsd: 10 }, event => events.push(event));
  await session.start(); await session.send({ clientMessageId: randomUUID(), text: 'first' });
  const deadline = Date.now() + 15000;
  while (!events.some(event => event.type === 'turn.completed') && Date.now() < deadline) {
    if (session.snapshot().state === 'failed') assert.fail(('Real SDK wire failed: ' + wireFailure + '\n' + stderr.join('')).replaceAll(key, '<secret>'));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(events.some(event => event.type === 'turn.completed' && event.payload.status === 'completed'));
  await session.close();
  const wire = fs.readFileSync(path.join(directory, 'claude-wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(wire.some(row => row.control === 'initialize'));
  assert.ok(wire.some(row => row.childResults?.length === 3));
  assert.ok(wire.filter(row => row.childResults).every(row => row.childResults.every(child => child.keyPresent === false)));
  for (const relative of fs.readdirSync(home, { recursive: true })) {
    const file = path.join(home, relative); if (fs.statSync(file).isFile()) assert.ok(!fs.readFileSync(file).includes(Buffer.from(key)), relative);
  }
});
test('N2 a real SDK owner query keeps its fake native process alive across idle turns', {
  skip: !sdkModule && 'SDK dependency is not installed in this isolated worktree', timeout: 30000,
}, async t => {
  const scope = fixtureProcesses(t, 'agx-owner-wire-'), { directory } = scope;
  const loadSdk = isolatedSdk(scope);
  const { prepareProviders } = await import('../scripts/native-session-smoke.mjs');
  const { bin, cli } = await prepareProviders(directory);
  const config = path.join(directory, 'claude'); fs.mkdirSync(config);
  const factory = createClaudeRuntime({ directory: path.join(directory, 'records'),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).reverse(), decryptString: value => Buffer.from(value).reverse().toString() },
    loadSdk: async () => {
      const sdk = await loadSdk();
      return { query: spec => sdk.query({ ...spec, options: { ...spec.options, spawnClaudeCodeProcess: scope.sdkSpawn.bind(scope) } }) };
    },
    resolveExecutable: async () => path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude') });
  scope.defer(() => factory.close());
  factory.credentials.save('sk-ant-api03-owner-wire-fixture-never-real');
  const env = { PATH: bin, HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: config,
    AGENTRIX_FAKE_NODE: process.execPath, AGENTRIX_FAKE_CLI: cli, AGENTRIX_FAKE_OUTPUT: directory,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
  const session = factory.create({ agent: 'claude', owner: 'gui', cwd: directory, env, projectId: 'p', terminalId: 't',
    runtimeSessionId: randomUUID(), monthlyBudgetUsd: 10 }, () => {});
  await session.start();
  const wire = () => fs.readFileSync(path.join(directory, 'claude-wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (let count = 1; count <= 2; count++) {
    await session.send({ clientMessageId: randomUUID(), text: 'first' });
    const deadline = Date.now() + 10000;
    while ((session.snapshot().state !== 'idle' || factory.usage.summary().monthUsdMicros !== count * 10000) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(session.snapshot().state, 'idle');
    assert.equal(factory.usage.available(10), 10000000 - count * 10000);
    const spawned = wire().filter(row => row.spawn); assert.equal(spawned.length, 1);
    assert.equal(spawned[0].scrub, false); assert.doesNotThrow(() => process.kill(spawned[0].pid, 0));
  }
  assert.ok(wire().filter(row => row.childResults).every(row => row.childResults.every(child => child.keyPresent)));
  await session.close();
});

test('B3 installed Claude scrub implementation removes API credentials only when its real switch is enabled', {
  skip: !process.env.AGENTRIX_TEST_CLAUDE_BINARY && 'offline installed-binary probe is opt-in',
}, () => {
  const binary = fs.readFileSync(process.env.AGENTRIX_TEST_CLAUDE_BINARY).toString('latin1');
  const predicate = binary.slice(binary.indexOf('function Ff(){let e=O.scrubEnabledLatched;'), binary.indexOf('var N=[".env"'));
  const start = binary.indexOf('function Wo(e){let n=l.of(U().host)');
  const body = binary.slice(start, binary.indexOf('function D0n()', start));
  const table = /var to=(\[[^\]]*\])/.exec(binary);
  assert.ok(table && predicate.startsWith('function Ff()') && body.endsWith('return d}'), 'installed offline baseline changed; inspect before updating the probe');
  const protectedNames = JSON.parse(table[1]).flatMap(name => [name, `INPUT_${name}`]);
  assert.ok(protectedNames.includes('ANTHROPIC_API_KEY'));
  function scrub(enabled) {
    const env = { PATH: '/fake/bin', ANTHROPIC_API_KEY: 'synthetic-only', ...(enabled ? { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } : {}) };
    const context = { process: { env }, O: { setScrubEnabledLatched(value) { this.scrubEnabledLatched = value; } },
      Oe: value => ['1', 'true'].includes(value), qo: value => value === '0', i: {},
      l: { of: () => ({ settingsEnvForChildren: {} }) }, U: () => ({ host: 'offline' }),
      cQt: () => ({}), x: new Set(), b9e: () => false, Bft: () => [], vys: () => [], mEs: () => [], uQt: () => false,
      w: new Set(), jut: [], fM: () => false, _E: {}, F: () => false, k: () => false, B8: (_object, name) => name,
      vuo: () => [], h: () => false, Fde: name => name.toUpperCase(), _uo: () => false, We: () => new Set(protectedNames),
      X0t: () => [], SG: Symbol(), WDn: /never-match/, zDn: () => false, Suo: () => false, GQt: () => true };
    // Run the installed predicate and child-env implementation, with unrelated host integrations disabled.
    return vm.runInNewContext(predicate + '\n(' + body + ')()', context, { timeout: 1000 });
  }
  assert.equal(scrub(false).ANTHROPIC_API_KEY, 'synthetic-only');
  assert.equal(scrub(true).ANTHROPIC_API_KEY, undefined);
  assert.equal(scrub(true).PATH, '/fake/bin');
});
test('M12 the real Codex adapter discovers and speaks to the compiled fake app-server executable', { timeout: 15000 }, async t => {
  const scope = fixtureProcesses(t, 'agx-codex-wire-'), { directory } = scope;
  const { prepareProviders } = await import('../scripts/native-session-smoke.mjs');
  const { bin, cli } = await prepareProviders(directory);
  const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
  const events = [], env = { PATH: bin, HOME: directory, USERPROFILE: directory, CODEX_HOME: directory,
    AGENTRIX_FAKE_NODE: process.execPath, AGENTRIX_FAKE_CLI: cli, AGENTRIX_FAKE_OUTPUT: directory,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
  const session = createCodexRuntime({ spawnProcess: scope.spawn }).create({ agent: 'codex', cwd: directory, env, projectId: 'p', terminalId: 't', runtimeSessionId: randomUUID(), effort: 'high', fast: true }, event => events.push(event));
  scope.defer(() => session.close()); await session.start();
  const account = await session.readAccount(); assert.equal(account.kind, 'subscription');
  assert.ok(!JSON.stringify(account).includes('private-offline-fixture'));
  assert.equal((await session.send({ clientMessageId: randomUUID(), text: 'first' })).status, 'delivered');
  const deadline = Date.now() + 3000;
  while (!events.some(event => event.type === 'turn.completed') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(events.some(event => event.type === 'item.upsert' && event.payload.content.text === 'PACKAGED_CODEX_OK'));
  assert.ok(events.some(event => event.type === 'turn.completed' && event.payload.status === 'completed'));
  await session.close();
});
