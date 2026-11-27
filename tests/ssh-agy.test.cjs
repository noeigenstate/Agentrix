const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { RemoteConnection } = require('../electron/remote-connection.cjs');
const { createRemoteAgyProcess } = require('../electron/features/ssh/codex-process.cjs');
const { createAgyRuntime } = require('../electron/features/agy-acp/index.cjs');
const { nativePolicy } = require('../electron/features/agy-acp/adapter.cjs');
const { remoteAgyLimits } = require('../electron/features/agy-acp/usage.cjs');
const { adapterOf } = require('../electron/features/cli-adapters/registry.cjs');
const { recordEvents } = require('./helpers/agy-runtime.cjs');
const modelOptions = require('./fixtures/agy-acp/model-options.json');

const cwd = '/remote/项目', sessionId = '670f1895-da18-4940-b596-4e80e0c3c387';
const otherId = '3fae06d2-2995-4784-a0a0-2ea80260aa02';
const neon = 'gemini-4-neon', flash = 'gemini-3.8-flash';
const modelIds = [neon, 'gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', flash,
  'agy:claude-opus-5-5', 'agy:claude-sonnet-5-5', 'agy:gpt-oss-120b-medium'];
const roleServer = { command: '/remote/bin/node', args: ['/remote/dispatch.cjs', 'mcp', 'agy'], env: {} };
const info = { root: '/remote', cwd, context: 'Remote project instructions', roleServer };

class Peer {
  model = neon;
  effort = 'high';
  methods = [];
  configOptions = () => [
    { id: 'model', currentValue: this.model, options: modelOptions },
    { id: 'thought_level', currentValue: this.effort, options: ['low', 'high'].map(value => ({ value, name: value })) },
    { id: 'mode', currentValue: 'default', options: [{ value: 'default', name: 'default' }] },
  ];

  receive(frame, send) {
    assert.equal(frame.jsonrpc, '2.0');
    const { id, method, params } = frame, reply = result => send({ id, result });
    this.methods.push(frame);
    switch (method) {
      case 'initialize': return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: true } } });
      case 'session/list':
        return reply(params.cursor ? { sessions: [{ sessionId, cwd, title: 'Remote history' }] }
          : { nextCursor: 'next', sessions: [{ sessionId: otherId, cwd: cwd + '/another' }] });
      case 'session/new':
        if (this.authRequired) return send({ id, error: { code: -32000, message: 'Log in on this host' } });
        assert.equal(params.cwd, cwd);
        return reply({ sessionId, configOptions: this.configOptions() });
      case 'session/load':
        assert.equal(params.sessionId, sessionId);
        assert.equal(params.cwd, cwd);
        assert.equal(params._meta, undefined);
        send({ method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Replayed remotely' },
        } } });
        return reply({ configOptions: this.configOptions() });
      case 'session/set_config_option':
        if (params.configId === 'model') this.model = params.value;
        else this.effort = params.value;
        return reply({ configOptions: this.configOptions() });
      case 'session/prompt':
        this.prompt = id;
        return send({ method: 'session/request_permission', id: 'remote/approval', params: { sessionId,
          toolCall: { toolCallId: 'remote-tool', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'echo test' } },
          options: [{ optionId: 'remote/allow', kind: 'allow_once' }, { optionId: 'remote/deny', kind: 'reject_once' }] } });
      case undefined:
        if (id === 'remote/approval' && frame.result.outcome.optionId) return send({ id: this.prompt, result: { stopReason: 'end_turn' } });
        return;
      case 'session/cancel': return send({ id: this.prompt, result: { stopReason: 'cancelled' } });
      case 'session/close': return reply({});
      default: assert.fail(method);
    }
  }
}

function fixture(t, code) {
  const peers = [], requests = [], detached = [];
  const adapter = adapterOf('agy');
  const factory = createAgyRuntime({
    resolveExecutable: () => assert.fail('local agy lookup'),
    spawnProcess: () => assert.fail('local agy process'),
    remoteContext: (spec, remote) => nativePolicy.ownerContext({ ...spec, ...remote }, adapter),
    launchRemote: async (spec, { purpose, readOnly }) => {
      const peer = new Peer();
      peer.authRequired = code === 'agy_auth_required';
      peers.push(peer);
      const remote = new RemoteConnection({ path: spec.cwd, ssh: {} }, {
        auth: { hasPending: () => false }, native: true, nativeAgent: 'agy',
        integrationDir: path.resolve(__dirname, '../integration'),
      }, () => ({
        key: 'fake host',
        attach(connection) { this.connection = connection; return peers.length; },
        detach(channel) { detached.push(channel); },
        send(message) {
          const deliver = value => this.connection.receive(value);
          const respond = value => deliver({ type: 'response', id: message.id, ok: true, value });
          requests.push(message);
          if (message.op === 'open') return queueMicrotask(() => deliver({ type: 'ready', info }));
          if (message.op === 'agy-open' && code && !peer.authRequired) return deliver({ type: 'response', id: message.id, ok: false, code, error: 'fixture' });
          if (message.op === 'agy-input') {
            peer.receive(JSON.parse(Buffer.from(message.data, 'base64').toString()), response => deliver({
              type: 'agy-data', processId: message.processId, stream: 'stdout',
              data: Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...response }) + '\n').toString('base64'),
            }));
          }
          return respond({});
        },
      }));
      t.after(() => remote.close());
      await remote.ready;
      return { ...info, roleServer: readOnly ? undefined : roleServer, child: createRemoteAgyProcess(remote, nativePolicy.remoteProcessOptions(purpose)) };
    },
  });
  const spec = { kind: 'ssh', owner: 'gui', agent: 'agy', projectId: 'project', terminalId: 'terminal', cwd: '/remote/link',
    runtimeSessionId: randomUUID(), permissions: 'ask' };
  return { factory, spec, peers, requests, detached };
}

test('SSH agy uses remote ACP for owner turns, approval, interruption, history and models', { timeout: 15000 }, async t => {
  const { factory, spec, peers, requests, detached } = fixture(t);
  const events = recordEvents(), runtime = factory.create(spec, events.emit);
  try {
    assert.deepEqual(await runtime.start(), { providerSessionId: sessionId });
    assert.equal(requests[0].nativeAgent, 'agy');
    assert.equal(peers[0].methods.find(row => row.method === 'session/new').params.mcpServers[0].name, 'agentrix_role');
    assert.deepEqual(runtime.modelOptions().models.map(option => option.value), modelIds);
    assert.equal((await runtime.setModelOptions({ model: flash, effort: 'low' })).effort, 'low');
    for (const decision of ['allow', 'deny', 'interrupt']) {
      const approval = events.wait(event => event.type === 'request.opened');
      const finished = events.wait(event => event.type === 'turn.completed');
      await runtime.send({ clientMessageId: randomUUID(), text: decision });
      const requestId = (await approval).payload.requestId;
      if (decision === 'interrupt') await runtime.interrupt();
      else await runtime.answer(requestId, { decision });
      assert.equal((await finished).payload.status, decision === 'interrupt' ? 'interrupted' : 'completed');
    }
    assert.ok(peers[0].methods.some(row => row.id === 'remote/approval' && row.result?.outcome?.optionId === 'remote/allow'));
    assert.ok(peers[0].methods.some(row => row.id === 'remote/approval' && row.result?.outcome?.optionId === 'remote/deny'));
  } finally { await runtime.close(); }
  assert.deepEqual(await factory.history(spec), [{ id: sessionId, title: 'Remote history', at: null }]);
  const resumed = factory.create({ ...spec, providerSessionId: sessionId }, events.emit);
  try {
    await resumed.resume();
    assert.ok(resumed.snapshot().events.some(event => event.replay && event.payload.content?.text === 'Replayed remotely'));
    assert.ok(!peers[2].methods.some(row => row.method === 'session/prompt'));
  } finally { await resumed.close(); }
  assert.deepEqual((await factory.models(spec)).map(row => row.model), modelIds);
  assert.deepEqual(requests.filter(request => request.op === 'agy-open').map(request => request.purpose), ['session', 'history', 'session', 'catalog']);
  assert.ok(!peers[3].methods.some(row => row.method === 'session/prompt'));
  assert.equal(requests.filter(request => request.op === 'agy-close').length, 4);
  assert.equal(detached.length, 4);
});

test('SSH agy reports missing installation, old version and missing remote login', { timeout: 10000 }, async t => {
  for (const [code, pattern] of [['agy_cli_required', /远端主机自行安装并登录/],
    ['agy_cli_outdated', /远端主机自行升级后登录/], ['agy_auth_required', /远端主机登录/]]) {
    const { factory, spec } = fixture(t, code);
    const runtime = factory.create(spec, () => {});
    try {
      await assert.rejects(runtime.start(), error => error.code === code && pattern.test(nativePolicy.startupMessage(error, spec)));
    } finally { await runtime.close(); }
  }
});

test('SSH agy returns only remote quota windows and shares each read within the same channel', async () => {
  let calls = 0, time = 1000;
  const now = () => time;
  const remote = { request: async op => {
    assert.equal(op, 'agy-usage');
    calls++;
    return [{ id: 'gemini', minutes: 300, percent: 5, resetsAt: 1720000000000, extra: 'private' },
      { id: '3p', minutes: 10080, percent: 42 }, { id: 'unrecognized', percent: 4 }, { id: 'gemini', percent: -1 }];
  } };
  const [first, second] = await Promise.all([remoteAgyLimits(remote, now), remoteAgyLimits(remote, now)]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.deepEqual(first.limitsById, {
    gemini: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAtMs: 1720000000000 } },
    '3p': { secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAtMs: null } },
  });
  time += 299999;
  assert.equal(await remoteAgyLimits(remote, now), first);
  assert.equal(calls, 1);
  time++;
  assert.notEqual(await remoteAgyLimits(remote, now), first);
  assert.equal(calls, 2);
  assert.equal(await remoteAgyLimits({ request: async () => null }), null);
});
