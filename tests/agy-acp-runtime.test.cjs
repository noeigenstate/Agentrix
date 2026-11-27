const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createInstall, native, nativePolicy } = require('../electron/features/agy-acp/adapter.cjs');
const { createAgyRuntime, readActualModel } = require('../electron/features/agy-acp/index.cjs');
const { locateAgy, supportedExecutable } = require('../electron/features/agy-acp/locator.cjs');
const { createRequests } = require('../electron/features/agy-acp/requests.cjs');
const { temporary, session, fakeProcess } = require('./helpers/agy-runtime.cjs');

const { adapterOf } = require('../electron/features/cli-adapters/registry.cjs');

const { roleTools, notes } = adapterOf('agy');
const SESSION = '670f1895-da18-4940-b596-4e80e0c3c387';
const roleServer = { command: process.execPath, args: ['role.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } };
const flash = { model: 'gemini-3.8-flash', effort: 'low' };
const input = (text, id = text) => ({ text, clientMessageId: id });

async function fake(t, spec = {}, scenario) {
  let runtime;
  t.after(() => runtime?.close());
  const dataDir = await temporary(t), trace = path.join(dataDir, 'trace.jsonl');
  const launched = session(dataDir, spec, { resolveExecutable: () => process.execPath, spawnProcess: fakeProcess(trace, scenario || 'normal') });
  runtime = launched.runtime;
  const wire = () => fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  return { ...launched, dataDir, wire };
}

async function sendTurn(runtime, events, text, id) {
  const done = events.wait(event => event.type === 'turn.completed');
  const idle = events.wait(event => event.type === 'session.state' && event.payload.state === 'idle');
  await runtime.send(input(text, id));
  const completion = await done;
  await idle;
  return completion;
}

test('finds agy on PATH and in its platform installation directory', async t => {
  const root = await temporary(t), pathFolder = path.join(root, 'path');
  const windows = process.platform === 'win32', name = windows ? 'agy.exe' : 'agy';
  const fallback = path.join(root, ...(windows ? ['agy', 'bin'] : ['.local', 'bin']));
  const home = windows ? { LOCALAPPDATA: root } : { HOME: root };
  for (const directory of [fallback, pathFolder]) {
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(directory, name), '', { mode: 0o755 });
  }
  assert.equal(fs.realpathSync.native(locateAgy({ ...home, PATH: pathFolder })), fs.realpathSync.native(path.join(pathFolder, name)));
  assert.equal(fs.realpathSync.native(locateAgy(home)), fs.realpathSync.native(path.join(fallback, name)));
  const install = createInstall(async () => ({ installed: true, version: '1.5.18', file: path.join(fallback, name), reason: null }));
  assert.equal(install.peek(), null);
  assert.equal((await install.refresh(home)).version, '1.5.18');
  assert.equal(install.peek().installed, true);
  assert.equal(await native.load(), createAgyRuntime);
  assert.equal(nativePolicy.transport, 'agy-acp');
});

test('skips Agentrix shims for role, owner and model catalog launches', async t => {
  const dataDir = await temporary(t), windows = process.platform === 'win32', name = windows ? 'agy.exe' : 'agy';
  const marked = path.join(dataDir, 'shims'), linked = path.join(dataDir, 'linked'), installed = path.join(dataDir, 'bin');
  const shim = path.join(marked, name), cli = path.join(installed, name);
  for (const directory of [marked, installed]) await fs.promises.mkdir(directory);
  for (const file of [shim, cli]) await fs.promises.writeFile(file, '', { mode: 0o755 });
  await fs.promises.writeFile(path.join(marked, '.agentrix-shims'), '');
  if (windows) await fs.promises.symlink(marked, linked, 'junction');
  else {
    await fs.promises.mkdir(linked);
    await fs.promises.symlink(shim, path.join(linked, name));
  }
  const env = { HOME: dataDir, LOCALAPPDATA: dataDir, PATH: [marked, linked].join(path.delimiter) };
  assert.equal(locateAgy(env), null);
  assert.equal(locateAgy({ ...env, PATH: [env.PATH, installed].join(path.delimiter) }), cli);
  const expectations = { code: 'agy_cli_required' }, spawnProcess = () => assert.fail('must not start the shim');
  for (const owner of [undefined, 'gui']) {
    const { runtime } = session(dataDir, { owner, env }, { spawnProcess });
    t.after(() => runtime.close());
    await assert.rejects(runtime.start(), expectations);
  }
  const factory = createAgyRuntime({ dataDir, spawnProcess });
  await assert.rejects(factory.models({ cwd: dataDir, env }), expectations);
});

test('starts and resumes with isolated ACP configuration', { timeout: 10000 }, async t => {
  const fresh = await fake(t, { ...flash, ...roleTools.config(roleServer), ...notes.startup('Role note').config }, 'unsafe-mode');
  assert.deepEqual(await fresh.runtime.start(), { providerSessionId: SESSION });
  const [{ launch }, initialize, open, ...settings] = fresh.wire();
  assert.equal(launch.acp, 'acp');
  assert.equal(launch.flag, '--gemini-dir');
  assert.equal(launch.autoUpdate, 'true');
  assert.equal(fs.realpathSync.native(launch.profile), fs.realpathSync.native(path.join(fresh.dataDir, 'agy', 'role')));
  assert.deepEqual(initialize.params, { protocolVersion: 1, clientCapabilities: {},
    clientInfo: { name: 'Agentrix', title: 'Agentrix', version: '0.0.0' } });
  assert.equal(open.method, 'session/new');
  assert.equal(fs.realpathSync.native(open.params.cwd), fresh.dataDir);
  assert.deepEqual(open.params.mcpServers, [{ name: 'agentrix_role', command: roleServer.command, args: roleServer.args,
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] }]);
  assert.equal(open.params._meta.antigravity.systemPrompt.append, 'Role note');
  assert.deepEqual(settings.map(row => [row.params.configId, row.params.value]), [['model', 'gemini-3.8-flash'], ['thought_level', 'low'], ['mode', 'default']]);
  assert.equal(fresh.runtime.snapshot().events.at(-1).transport, 'agy-acp');
  await fresh.runtime.close();

  const resumed = await fake(t, { model: 'agy:gpt-oss-120b-medium', effort: 'default', providerSessionId: SESSION, ...notes.startup('Already persisted').config });
  assert.deepEqual(await resumed.runtime.resume(), { providerSessionId: SESSION });
  const rows = resumed.wire();
  assert.equal(rows[2].method, 'session/resume');
  assert.equal(rows[2].params.sessionId, SESSION);
  assert.equal(rows[2].params._meta, undefined);
  assert.deepEqual(rows.slice(3).map(row => row.params.configId), ['model']);
  assert.equal(rows[3].params.value, 'gpt-oss-120b-medium');
});

test('answers exact string IDs using structured tool intents', { timeout: 10000 }, async t => {
  const intents = [];
  const { runtime, events, wire } = await fake(t, { ...flash, ...roleTools.config(roleServer), allow: ['result.txt'], decidePermission: intent => {
    intents.push(intent);
    return intent.operation === 'edit' ? 'role_denied_edit' : null;
  } });
  await runtime.start();
  const done = await sendTurn(runtime, events, 'ALLOW');
  assert.equal(done.payload.status, 'completed');
  assert.deepEqual(done.payload.tokens, { input: 4274, cachedInput: 15976, cacheWrite: 0, output: 66, reasoning: 1 });
  const snapshot = runtime.snapshot().events;
  assert.ok(snapshot.some(event => event.type === 'item.upsert' && event.payload.kind === 'agent-message'
    && event.payload.status === 'completed' && event.payload.content.text === 'OK'));
  assert.ok(snapshot.some(event => event.type === 'item.upsert' && event.payload.kind === 'command'
    && event.payload.status === 'completed' && event.payload.content.output === 'PROBE_TOOL_RESULT_719'
    && event.payload.content.command === 'echo ACP_MARK'));
  assert.ok(events.all.some(event => event.type === 'item.delta' && event.payload.channel === 'reasoning-summary' && event.payload.text === 'Thought'));
  const usage = snapshot.find(event => event.type === 'usage.updated').payload;
  assert.deepEqual([usage.contextTokens, usage.contextWindow, usage.round.cachedInput, usage.costUsdMicros], [10220, 1048576, 15976, null]);
  assert.equal(await runtime.readActualModel(), 'gemini-3.8-flash-low');
  await sendTurn(runtime, events, 'DENY');
  await sendTurn(runtime, events, 'ROLE');
  await sendTurn(runtime, events, 'UNKNOWN');
  assert.deepEqual(intents.map(({ operation, command, paths }) => [operation, command, paths]), [
    ['command', 'echo ACP_MARK', []], ['edit', undefined, ['result.txt']],
  ]);
  assert.deepEqual(wire().filter(row => row.result).map(row => [row.id, row.result.outcome.optionId]), [
    ['jetski-acp-front:1', 'allow'], ['jetski-acp-front:2', 'deny'], ['jetski-acp-front:3', 'allow'], ['jetski-acp-front:4', 'deny'],
  ]);
  assert.ok(events.all.some(event => event.type === 'request.resolved' && event.payload.reason === 'role_denied_edit'));
  assert.ok(events.all.some(event => event.type === 'request.resolved' && event.payload.reason === 'unknown_tool'));
});

test('agy approvals apply the shared command and file policy and recognize SearchDirectory', async t => {
  const cwd = await temporary(t);
  const cases = [
    ['run_command', { CommandLine: 'npm test' }, null, null],
    ['run_command', { CommandLine: 'git status' }, null, null],
    ...['git commit -m fixture', 'git push', 'git reset --hard HEAD'].map(CommandLine => ['run_command', { CommandLine }, 'git_forbidden', 'git_forbidden']),
    ['find_by_name', { SearchDirectory: cwd }, null, null],
    ['find_by_name', { Pattern: '*.txt' }, null, null],
    ['grep_search', { SearchDirectory: path.dirname(cwd) }, 'outside_worktree', 'outside_worktree'],
    ['write_file', { file_path: 'allowed.txt' }, 'read_only', null],
    ['write_file', { file_path: 'other.txt' }, 'read_only', 'outside_scope'],
    ['write_file', { file_path: '../other.txt' }, 'read_only', 'outside_worktree'],
    ['unknown', {}, 'unknown_tool', 'unknown_tool'],
  ];
  for (const [tool, rawInput, readReason, writeReason] of cases) {
    for (const readOnly of [true, false]) {
      const response = Promise.withResolvers(), resolved = Promise.withResolvers();
      const approvals = createRequests({
        spec: { cwd, readOnly, allow: ['allowed.txt'], decidePermission: () => null },
        rpc: { respond: (_id, value) => response.resolve(value.outcome.optionId) },
        events: { publish(type, payload) { if (type === 'request.resolved') resolved.resolve(payload.reason); } },
        providerSessionId: () => SESSION, active: () => true, setState() {},
      });
      approvals.open({ id: 'request', method: 'session/request_permission', params: { sessionId: SESSION,
        toolCall: { name: tool, rawInput }, options: [{ optionId: 'allow' }, { optionId: 'deny' }] } });
      const reason = readOnly ? readReason : writeReason;
      assert.deepEqual(await Promise.all([response.promise, resolved.promise]), [reason ? 'deny' : 'allow', reason], tool);
    }
  }
});

test('an older agy is refused before launching a role or probing a catalog', async t => {
  const dataDir = await temporary(t);
  const installed = version => async () => ({ file: process.execPath, version });
  assert.equal(await supportedExecutable({}, installed('1.5.18')), process.execPath);
  const { factory, runtime, events } = session(dataDir, flash, {
    resolveExecutable: env => supportedExecutable(env, installed('1.5.17')), spawnProcess: () => assert.fail('outdated CLI must not start'),
  });
  t.after(() => runtime.close());
  await assert.rejects(runtime.start(), { code: 'agy_cli_outdated', message: /1\.5\.17.*1\.5\.18/ });
  await assert.rejects(factory.models({ cwd: dataDir }), { code: 'agy_cli_outdated' });
  assert.match(events.all.find(event => event.type === 'error').payload.message, /upgrade/);
});

test('project agy configuration warns about hooks and MCP and refuses a role server name collision before launch', async t => {
  const f = await fake(t, flash), folder = path.join(f.dataDir, '.agents');
  await fs.promises.mkdir(folder);
  await fs.promises.writeFile(path.join(folder, 'hooks.json'), '{}');
  const mcp = names => fs.promises.writeFile(path.join(folder, 'mcp_config.json'), JSON.stringify({ mcpServers: names }));
  await mcp({ fixture: {} });
  await f.runtime.start();
  assert.match(f.events.all.find(event => event.type === 'worker.notice')?.payload.text, /agy hooks and MCP servers.*approvals may have bypassed/);
  await f.runtime.close();
  await mcp({ agentrix_role: {} });
  const blocked = session(f.dataDir, flash, { resolveExecutable: () => assert.fail('conflict must refuse before launch') });
  t.after(() => blocked.runtime.close());
  await assert.rejects(blocked.runtime.start(), { code: 'agy_role_server_conflict', message: /agentrix_role conflicts/ });
});

test('a busy catalog directory does not discard probed rows and is removed on the next probe', { timeout: 10000 }, async t => {
  const { factory, dataDir } = await fake(t);
  const rm = fs.promises.rm;
  let leftover;
  const mock = t.mock.method(fs.promises, 'rm', async (folder, options) => {
    if (!leftover && path.basename(folder).startsWith('catalog-')) {
      leftover = folder;
      throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
    }
    return rm(folder, options);
  });
  try {
    assert.equal((await factory.models({ cwd: dataDir })).length, 3);
    assert.ok(fs.existsSync(leftover));
    assert.equal((await factory.models({ cwd: dataDir })).length, 3);
    assert.deepEqual(await fs.promises.readdir(path.dirname(leftover)), []);
  } finally { mock.mock.restore(); }
});

test('blocks a second connection to the same session until the first closes', { timeout: 10000 }, async t => {
  const { dataDir, runtime } = await fake(t, flash);
  const options = { resolveExecutable: () => process.execPath, spawnProcess: fakeProcess(path.join(dataDir, 'resume.jsonl'), 'normal') };
  const resumed = () => session(dataDir, { ...flash, providerSessionId: SESSION }, options).runtime;
  const second = resumed(), third = resumed();
  await runtime.start();
  try {
    await assert.rejects(second.resume(), { code: 'agy_session_in_use' });
    await runtime.close();
    assert.deepEqual(await third.resume(), { providerSessionId: SESSION });
  } finally { await Promise.all([second.close(), third.close()]); }
});

test('interactive answers and cancellation resolve each approval once', { timeout: 10000 }, async t => {
  const { runtime, events, wire } = await fake(t);
  await runtime.start();
  const request = () => events.wait(event => event.type === 'request.opened');
  let opened = request(), finished = sendTurn(runtime, events, 'ALLOW', 'accepted');
  const first = (await opened).payload.requestId;
  assert.equal(runtime.workerIntent(first).command, 'echo ACP_MARK');
  runtime.answer(first, { decision: 'allow' });
  assert.throws(() => runtime.answer(first, { decision: 'allow' }), { code: 'request_expired' });
  await finished;
  opened = request();
  finished = sendTurn(runtime, events, 'ALLOW', 'denied');
  runtime.cancel((await opened).payload.requestId);
  await finished;
  assert.deepEqual(runtime.snapshot().requests, []);
  assert.deepEqual(wire().filter(row => row.result).map(row => row.result.outcome.optionId), ['allow', 'deny']);
});

test('interrupts a waiting turn and sends the next prompt on the same session', { timeout: 10000 }, async t => {
  const { runtime, events, wire } = await fake(t, { allow: ['one.txt', 'two.txt'], decidePermission: () => new Promise(() => {}) });
  await runtime.start();
  const opened = ['call_1', 'call_2'].map(id => events.wait(event => event.type === 'request.opened' && event.payload.providerData.itemId === id));
  const cancelled = sendTurn(runtime, events, 'CANCEL_MULTIPLE');
  const pending = await Promise.all(opened);
  await runtime.interrupt();
  assert.equal((await cancelled).payload.status, 'interrupted');
  for (const { payload } of pending) assert.throws(() => runtime.cancel(payload.requestId), { code: 'request_expired' });
  assert.deepEqual(runtime.snapshot().requests, []);
  assert.equal((await sendTurn(runtime, events, 'NEXT')).payload.status, 'completed');
  assert.deepEqual(wire().filter(row => row.method === 'session/cancel'), [{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: SESSION } }]);
  assert.deepEqual(wire().filter(row => row.result), ['jetski-acp-front:1', 'jetski-acp-front:2']
    .map(id => ({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } })));
});

test('process exit leaves sent input unknown and rejects unsent queued input', { timeout: 10000 }, async t => {
  const { runtime, events } = await fake(t, { decidePermission: () => new Promise(() => {}) });
  await runtime.start();
  const published = events.wait(event => event.type === 'request.opened');
  const disconnected = events.wait(event => event.type === 'session.state' && event.payload.state === 'disconnected');
  await runtime.send(input('EXIT'));
  await published;
  assert.equal((await runtime.send(input('NEXT'))).status, 'queued');
  await disconnected;
  assert.deepEqual(runtime.snapshot().requests, []);
  assert.equal((await runtime.send(input('EXIT'))).status, 'unknown');
  assert.equal((await runtime.send(input('NEXT'))).status, 'rejected');
  assert.equal(events.all.filter(event => event.type === 'turn.started').length, 1);
  assert.equal(events.all.find(event => event.type === 'turn.completed').payload.status, 'unknown');
});

test('a process exit after the prompt response preserves the completed turn', { timeout: 10000 }, async t => {
  const { runtime, events } = await fake(t, flash);
  await runtime.start();
  const completed = events.wait(event => event.type === 'turn.completed');
  const disconnected = events.wait(event => event.type === 'session.state' && event.payload.state === 'disconnected');
  await runtime.send(input('EXIT_AFTER_REPLY'));
  assert.equal((await completed).payload.status, 'completed');
  await disconnected;
  assert.equal((await runtime.send(input('EXIT_AFTER_REPLY'))).status, 'consumed');
});

test('probes model choices without a prompt and verifies models from transcripts', { timeout: 10000 }, async t => {
  const { factory, runtime, events, dataDir, wire } = await fake(t, { ...flash, model: 'agy:gemini-3.8-flash' });
  assert.deepEqual(await factory.models({ cwd: dataDir }), [
    { model: 'gemini-4-neon', label: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', fast: false, isDefault: true },
    { model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', fast: false, isDefault: false },
    { model: 'agy:gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', efforts: ['default'], defaultEffort: 'default', fast: false, isDefault: false },
  ]);
  assert.deepEqual(wire().slice(1).map(row => row.method), ['initialize', 'session/new', 'session/set_config_option', 'session/set_config_option', 'session/close']);
  assert.deepEqual(await fs.promises.readdir(path.join(dataDir, 'agy')), []);
  await runtime.start();
  assert.equal(wire().findLast(row => row.params?.configId === 'model').params.value, flash.model);
  assert.equal(await runtime.readActualModel(), null);
  assert.equal(await readActualModel(wire()[0].launch.profile, '../settings'), null);
  await sendTurn(runtime, events, 'NEXT');
  const routing = () => runtime.snapshot().events.find(event => event.type === 'routing.updated').payload;
  assert.equal(routing().effective.model, flash.model);
  assert.deepEqual(routing().observed, { model: flash.model, effort: flash.effort, fast: null });
  await sendTurn(runtime, events, 'NO_TRANSCRIPT');
  assert.equal(routing().reason, 'model_unverified');
  assert.equal(routing().observed.model, null);
});
