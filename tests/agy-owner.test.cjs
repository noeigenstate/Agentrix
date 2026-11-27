const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createAgyRuntime } = require('../electron/features/agy-acp/index.cjs');
const { historyDirectory } = require('../electron/features/agy-acp/history.cjs');
const { supportedExecutable } = require('../electron/features/agy-acp/locator.cjs');
const { adapterOf } = require('../electron/features/cli-adapters/registry.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { choosePath } = require('../electron/features/native-session/routing.cjs');
const { createNativeUsage } = require('../electron/features/native-session/agent-usage.cjs');
const { WorkspaceStore, cleanSettings } = require('../electron/state.cjs');
const { registerWorkspaceIpc } = require('../electron/features/workspace/ipc.cjs');
const { temporary, recordEvents, fakeProcess } = require('./helpers/agy-runtime.cjs');

const agy = 'agy', neon = 'gemini-4-neon', flash = 'gemini-3.8-flash';
const modelIds = [neon, 'gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', flash,
  'agy:claude-opus-5-5', 'agy:claude-sonnet-5-5', 'agy:gpt-oss-120b-medium'];
const sessionId = '670f1895-da18-4940-b596-4e80e0c3c387';
const done = events => events.wait(event => event.type === 'turn.completed');
const approval = events => events.wait(event => event.type === 'request.opened');
const send = (runtime, text) => runtime.send({ clientMessageId: randomUUID(), text });

async function fixture(t, options = {}) {
  const cwd = await temporary(t), geminiDir = path.join(cwd, 'private-profile'), trace = path.join(cwd, 'protocol.jsonl');
  const { scenario = 'owner', ...injected } = options;
  const factory = createAgyRuntime({ resolveExecutable: () => 'fake-agy', spawnProcess: fakeProcess(trace, scenario), ...injected });
  const spec = { owner: 'gui', agent: agy, projectId: 'project', terminalId: 'terminal', runtimeSessionId: randomUUID(),
    cwd, geminiDir, model: flash, effort: 'low' };
  const events = recordEvents();
  const log = async () => (await fs.promises.readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { spec, events, factory, log };
}

test('agy owner uses its isolated test profile and reports the effective model, context and turn usage', { timeout: 10000 }, async t => {
  const { spec, events, factory, log } = await fixture(t);
  const adapter = adapterOf(agy);
  const context = adapter.nativePolicy.ownerContext({ context: 'Use the project routing guide.',
    roleServer: { command: 'node', args: ['role-tools'], env: { EXAMPLE: 'yes' } } }, adapter);
  const runtime = factory.create({ ...spec, ...context }, events.emit);
  try {
    assert.deepEqual(await runtime.start(), { providerSessionId: sessionId });
    assert.equal(runtime.modelOptions().effort, 'low');
    const finished = done(events);
    await send(runtime, 'OK');
    assert.equal((await finished).payload.tokens.output, 66);
    const usage = createNativeUsage(agy);
    events.all.forEach(event => usage.apply(event));
    assert.partialDeepStrictEqual(usage.snapshot(), { provider: 'Google Antigravity', model: flash,
      context: { used: 10220, window: 1048576 }, round: { input: 20250, cached: 15976, output: 66 } });
    assert.ok(events.all.every(event => event.provider === agy && event.transport === 'agy-acp'));
    assert.equal(choosePath({ agent: agy, claudePath: 'terminal-only' }).path, 'native');
    const rows = await log(), launch = rows[0].launch, open = rows.find(row => row.method === 'session/new');
    assert.deepEqual([launch.acp, launch.flag, launch.autoUpdate], ['acp', '--gemini-dir', 'true']);
    assert.equal(fs.realpathSync.native(launch.profile), fs.realpathSync.native(spec.geminiDir));
    assert.deepEqual(open.params._meta, context._meta);
    assert.deepEqual(open.params.mcpServers, context.mcpServers);
  } finally { await runtime.close(); }
});

test('agy owner history filters every page by cwd and replays messages without starting a turn', { timeout: 10000 }, async t => {
  const { spec, events, factory, log } = await fixture(t);
  assert.equal(historyDirectory('/C:/Project', 'win32'), 'C:/Project');
  assert.equal(historyDirectory('C:/Project', 'win32'), 'C:/Project');
  assert.equal(historyDirectory('relative', 'win32'), null);
  assert.deepEqual(await factory.history(spec), [{ id: sessionId, title: 'Previous session', at: Date.parse('2026-11-26T16:36:09Z') }]);
  const runtime = factory.create({ ...spec, providerSessionId: sessionId, _meta: { antigravity: { systemPrompt: { append: 'Original note' } } } }, events.emit);
  try {
    await runtime.resume();
    const messages = runtime.snapshot().events.filter(event => event.type === 'item.upsert');
    assert.deepEqual(messages.map(event => [event.payload.kind, event.payload.content.text, event.replay]),
      [['user-message', 'Previous question', true], ['agent-message', 'Previous answer', true]]);
    assert.ok(events.all.filter(event => event.type.startsWith('item.')).every(event => event.replay));
    assert.ok(!events.all.some(event => event.type.startsWith('turn.')));
    const rows = await log(), applied = rows.filter(row => row.method === 'session/set_config_option').map(row => [row.params.configId, row.params.value]);
    assert.deepEqual(applied, [['model', flash], ['thought_level', 'low']]);
    assert.equal(rows.filter(row => row.method === 'session/load').length, 1);
    assert.ok(!rows.some(row => row.method === 'session/prompt' || row.method === 'session/resume'));
  } finally { await runtime.close(); }
});

test('agy owner models change on the same session and restore from the workspace setting', { timeout: 10000 }, async t => {
  const { spec, events, factory, log } = await fixture(t);
  const file = path.join(spec.cwd, 'workspace.json'), store = new WorkspaceStore(file);
  const { project } = store.add(spec.cwd);
  const id = project.id, settings = { get: () => ({ claudePath: 'terminal-only' }) };
  const restore = () => store.findTerminal(id).record.restore;
  const router = createRouter({ settings, agy: factory, claude: { usage: { summary: () => ({}) } }, emit: events.emit,
    resolveSpec: () => ({ ...spec, terminalId: id, projectId: id, ...(restore()?.nativeModelOptions || {}), providerSessionId: restore()?.threadId }),
    saveSession: (_, saved) => store.setRestore(id, { agent: saved.agent, threadId: saved.providerSessionId, nativeTransport: 'agy-acp' }),
    saveModelOptions: (_, nativeModelOptions) => store.setRestore(id, { nativeModelOptions }) });
  try {
    const { runtimeSessionId } = await router.start(id, { agent: agy });
    const changed = await router.applyRouting(id, { model: neon, effort: 'xhigh' });
    assert.partialDeepStrictEqual(changed, { model: neon, effort: 'xhigh' });
    assert.deepEqual(changed.models.map(option => option.value), modelIds);
    assert.ok(changed.efforts.some(option => option.value === 'xhigh'));
    await assert.rejects(router.applyRouting(id, { model: 'gemini-unknown', effort: 'low' }), { code: 'agy_invalid_model' });
    assert.equal(router.snapshot(id).runtimeSessionId, runtimeSessionId);
    assert.partialDeepStrictEqual(restore(), { agent: agy, nativeTransport: 'agy-acp', threadId: sessionId,
      nativeModelOptions: { model: neon, effort: 'xhigh' } });
    store.flushRestore();
    assert.deepEqual(new WorkspaceStore(file).findTerminal(id).record.restore.nativeModelOptions, { model: neon, effort: 'xhigh' });
    await router.stop(id, runtimeSessionId);
    const next = await router.start(id, { agent: agy, resume: true });
    const applied = (await log()).filter(row => row.method === 'session/set_config_option').map(row => [row.params.configId, row.params.value]);
    assert.deepEqual(applied.slice(-2), [['model', neon], ['thought_level', 'xhigh']], 'the resumed session starts on the restored choice');
    await router.stop(id, next.runtimeSessionId);
    store.removeTerminal(id);
    const reopened = new WorkspaceStore(file).findTerminal(id);
    assert.equal(reopened.record.restore.threadId, undefined);
    assert.deepEqual(reopened.project.quotaAgents, [agy]);
  } finally { await router.close(); }
});

test('an existing agy lead choice remains effective without appearing in the model dropdown', { timeout: 10000 }, async t => {
  const { spec, factory, events } = await fixture(t);
  const savedModel = 'gemini-pro-orchestrator-neon';
  const runtime = factory.create({ ...spec, model: savedModel, effort: 'default' }, events.emit);
  try {
    await runtime.start();
    assert.deepEqual(runtime.modelOptions().models.map(option => option.value), modelIds);
    assert.equal(runtime.modelOptions().model, savedModel);
    await runtime.applyRouting({ model: 'gemini-pro-orchestrator-argon', effort: 'default' });
    assert.equal(runtime.modelOptions().model, 'gemini-pro-orchestrator-argon');
  } finally { await runtime.close(); }
});

test('agy full answers automatically and ask waits for the owner through allow, deny and interrupt', { timeout: 15000 }, async t => {
  const { spec, events, factory, log } = await fixture(t);
  for (const permissions of ['full', 'ask']) {
    const runtime = factory.create({ ...spec, permissions }, events.emit);
    try {
      await runtime.start();
      const opened = permissions === 'ask' && approval(events);
      let finished = done(events);
      await send(runtime, 'ALLOW');
      if (opened) {
        const { requestId } = (await opened).payload;
        assert.equal(runtime.snapshot().state, 'waiting');
        await assert.rejects(runtime.setModelOptions({ model: neon }), { code: 'agy_session_busy' });
        runtime.answer(requestId, { decision: 'allow' });
      }
      assert.equal((await finished).payload.status, 'completed');
      if (!opened) {
        assert.ok(!events.all.some(event => event.type === 'request.opened'));
        continue;
      }
      const deny = approval(events);
      finished = done(events);
      await send(runtime, 'DENY');
      runtime.answer((await deny).payload.requestId, { decision: 'deny' });
      await finished;
      const pending = approval(events);
      finished = done(events);
      await send(runtime, 'CANCEL');
      const { requestId } = (await pending).payload;
      await runtime.interrupt();
      assert.equal((await finished).payload.status, 'interrupted');
      assert.throws(() => runtime.answer(requestId, { decision: 'allow' }), { code: 'request_expired' });
      finished = done(events);
      await send(runtime, 'OK');
      assert.equal((await finished).payload.status, 'completed');
    } finally { await runtime.close(); }
  }
  const wire = await log();
  assert.deepEqual(wire.flatMap(row => row.result?.outcome?.optionId ?? []), ['permit-once', 'permit-once', 'reject-once']);
  assert.equal(wire.filter(row => row.method === 'session/cancel').length, 1);
});

test('agy applies the changed lead model and effort before a queued turn starts', { timeout: 10000 }, async t => {
  const { spec, events, factory, log } = await fixture(t);
  const router = createRouter({ agy: factory, claude: {}, settings: { get: () => ({}) }, resolveSpec: () => ({ ...spec, permissions: 'ask' }),
    emit: events.emit });
  const id = spec.terminalId;
  try {
    const { runtimeSessionId } = await router.start(id, { agent: agy });
    const opened = approval(events);
    await router.send(id, runtimeSessionId, { clientMessageId: randomUUID(), text: 'ALLOW' });
    const { requestId } = (await opened).payload;
    const changed = router.applyRouting(id, { model: neon, effort: 'xhigh' });
    const nextId = randomUUID(), second = events.wait(event => event.type === 'turn.started' && event.payload.clientMessageId === nextId);
    assert.equal((await router.send(id, runtimeSessionId, { clientMessageId: nextId, text: 'OK' })).status, 'queued');
    const configured = (await log()).filter(row => row.method === 'session/set_config_option').map(row => row.params.value);
    assert.ok(!configured.includes(neon) && !configured.includes('xhigh'), 'nothing changes while the turn runs');
    await router.answer(id, runtimeSessionId, requestId, { decision: 'allow' });
    assert.partialDeepStrictEqual(await changed, { model: neon, effort: 'xhigh' });
    const { turnId } = await second;
    const finished = event => event.type === 'turn.completed' && event.turnId === turnId;
    assert.equal((events.all.find(finished) ?? await events.wait(finished)).payload.status, 'completed');
    const methods = (await log()).filter(row => row.method === 'session/set_config_option' || row.method === 'session/prompt');
    assert.deepEqual(methods.slice(-4).map(row => row.params.value ?? row.params.prompt[0].text), ['ALLOW', neon, 'xhigh', 'OK']);
  } finally { await router.close(); }
});

test('agy startup explains missing installation, old version and missing login', { timeout: 10000 }, async t => {
  const messages = { agy_cli_required: /未找到/, agy_cli_outdated: /版本过低/, agy_auth_required: /先登录/ };
  const options = { agy_cli_required: { resolveExecutable: () => null }, agy_cli_outdated: {
    resolveExecutable: env => supportedExecutable(env, () => ({ file: 'fake-agy', version: '1.5.17' })),
  }, agy_auth_required: { scenario: 'auth' } };
  for (const [code, injected] of Object.entries(options)) {
    const { spec, factory } = await fixture(t, injected);
    const router = createRouter({ agy: factory, claude: {}, settings: { get: () => ({}) }, resolveSpec: () => spec,
      emit() { } });
    try {
      await assert.rejects(router.start(spec.terminalId, { agent: agy }), error => error.code === code && messages[code].test(error.message));
    } finally { await router.close(); }
  }
});

test('agy permissions default to full and agree with renderer settings', async t => {
  const { AGY_PERMISSIONS } = require('../electron/agy-permissions.mjs');
  const { AGY_PERMISSIONS: shared, isAgyPermissions } = require('../src/shared/agy-permissions.ts');
  assert.deepEqual(shared, AGY_PERMISSIONS);
  for (const choice of shared) {
    assert.equal(isAgyPermissions(choice), true);
    assert.equal(cleanSettings({ agyPermissions: choice }).agyPermissions, choice);
  }
  assert.equal(isAgyPermissions('config'), false);
  assert.equal(cleanSettings({ agyPermissions: 'config' }).agyPermissions, 'full');
  const file = path.join(await temporary(t), 'workspace.json'), store = new WorkspaceStore(file);
  assert.equal(store.settings.agyPermissions, 'full');
  const handlers = new Map();
  registerWorkspaceIpc({ handle: (name, handler) => handlers.set(name, handler), updateStoreSettings: patch => store.updateSettings(patch),
    getSettings: () => store.settings, chooseVoiceModel() {}, broadcast() {} });
  assert.throws(() => handlers.get('workspace:settings')({ agyPermissions: 'config' }), /无效的 Antigravity/);
  handlers.get('workspace:settings')({ agyPermissions: 'ask' });
  assert.equal(new WorkspaceStore(file).settings.agyPermissions, 'ask');
});

