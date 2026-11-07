const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { registerIpc } = require('../electron/features/native-session/ipc.cjs');
const { builtinCommands, unsupported } = require('../electron/features/codex-app-server/compatibility.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const catalog = [
  { model: 'model-a', isDefault: true, supportedReasoningEfforts: ['low', 'high', 'ultra'].map(reasoningEffort => ({ reasoningEffort })), defaultReasoningEffort: 'high', additionalSpeedTiers: ['fast'] },
  { model: 'model-b', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium', additionalSpeedTiers: [] },
];
function fixture(t, { remote = false, scope = 'host-a', home } = {}) {
  const root = home || fs.mkdtempSync(path.join(os.tmpdir(), 'agx-slash-unit-'));
  if (!home) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wire = [], events = [], threads = new Map(); let serial = 0, turn = 0, drop = false;
  function peer() {
    const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), remote: true, remoteScope: scope, exitCode: null, signalCode: null });
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0); }); };
    const write = value => child.stdout.write(JSON.stringify(value) + '\n');
    const notify = (method, params) => write({ method, params });
    let buffer = '';
    child.stdin.on('data', chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (message.id === undefined) continue;
        wire.push(message); const p = message.params, method = message.method;
        if (['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(method) && !p.threadId) { write({ id: message.id, error: { code: -32602 } }); continue; }
        let result = {};
        if (method === 'initialize') result = { userAgent: 'codex/0.166.0' };
        if (method === 'model/list') result = { data: catalog, nextCursor: null };
        if (method === 'skills/list') result = { data: [{ cwd: root, skills: [{ name: 'lookup', path: path.join(root, 'SKILL.md'), enabled: true }] }] };
        if (method === 'thread/start' || method === 'thread/resume') {
          const id = p.threadId || 'thread-' + ++serial;
          result = { ...threads.get(id), thread: { id, status: { type: 'idle' } }, model: p.model || 'model-a', reasoningEffort: p.config?.model_reasoning_effort || 'high', serviceTier: p.serviceTier || null, sandbox: { type: 'readOnly' } };
          threads.set(id, result);
        }
        if (method === 'thread/turns/list') result = { data: [], nextCursor: null };
        if (method === 'account/read') result = { account: null };
        if (method === 'account/rateLimits/read') result = {};
        if (method === 'turn/start' || ['thread/compact/start', 'review/start', 'thread/shellCommand'].includes(method)) {
          if (drop) {
            if (drop === 'after-start') {
              notify('turn/started', { threadId: p.threadId, turn: { id: 'accepted-command' } });
              write({ id: message.id, error: { code: -32603 } });
            } else child.kill();
            continue;
          }
          const id = 'turn-' + ++turn, review = method === 'review/start';
          if (method === 'turn/start') result = { turn: { id, status: 'inProgress', items: [] } };
          if (review) result = { turn: { id, status: 'inProgress', items: [] }, reviewThreadId: p.threadId };
          write({ id: message.id, result });
          notify('turn/started', { threadId: p.threadId, turn: { id: review ? 'review-child' : id, rootTurnId: review ? id : null } });
          if (method === 'thread/compact/start') notify('item/started', { threadId: p.threadId, turnId: id, item: { type: 'contextCompaction', id: 'compact-' + turn } });
          setImmediate(() => {
            if (method === 'thread/compact/start') notify('item/completed', { threadId: p.threadId, turnId: id, item: { type: 'contextCompaction', id: 'compact-' + turn } });
            notify('turn/completed', { threadId: p.threadId, turn: { id, status: 'completed', items: [] } });
          });
          continue;
        }
        write({ id: message.id, result });
      }
    });
    return child;
  }
  const factory = createCodexRuntime({ optionsHome: root, resolveExecutable: async () => 'unused', spawnProcess: peer,
    launchRemote: async () => ({ child: peer(), cwd: root }) });
  const spec = { owner: 'gui', projectId: 'p', terminalId: 't', cwd: root, env: { CODEX_HOME: root }, ...(remote ? { kind: 'ssh' } : {}) };
  const session = factory.create(spec, event => events.push(event)); t.after(() => session.close());
  return { root, factory, spec, session, events, wire, drop: (kind = true) => { drop = kind; } };
}

test('Codex choices validate against the real catalog shape, persist before a turn, and stay bound to the remote scope', async t => {
  for (const remote of [false, true]) {
    const f = fixture(t, { remote }); await f.session.start();
    const id = f.session.snapshot().events.find(row => row.providerSessionId).providerSessionId;
    await assert.rejects(f.session.runOptions({ effort: 'invented' }), /不支持/);
    await f.session.runOptions({ model: 'model-b' });
    assert.deepEqual(await f.session.runOptions({}), { model: 'model-b', effort: 'medium', fast: false });
    assert.equal((await f.session.commands()).some(row => row.name === '/fast'), false);
    await assert.rejects(f.session.runOptions({ fast: true }), /不支持快速/);
    await f.session.runOptions({ model: null, effort: 'ultra', fast: true });
    assert.equal(f.wire.some(row => row.method === 'turn/start'), true, 'only the mandatory empty capability probe has run');
    assert.equal(f.wire.filter(row => row.method === 'turn/start' && row.params.threadId).length, 0);
    await f.session.close();
    const resumed = f.factory.create({ ...f.spec, providerSessionId: id, preserveRunOptions: true }, event => f.events.push(event)); t.after(() => resumed.close());
    await resumed.resume(); assert.deepEqual(await resumed.runOptions({}), { model: 'model-a', effort: 'ultra', fast: true });
    await resumed.send({ clientMessageId: 'next', text: 'Next turn' }); await tick();
    const params = f.wire.findLast(row => row.method === 'turn/start').params;
    assert.equal(params.model, 'model-a'); assert.equal(params.effort, 'ultra'); assert.equal(params.serviceTier, 'fast');
    await resumed.close();
    if (!remote) {
      const explicit = f.factory.create({ ...f.spec, owner: 'dispatch', readOnly: true, providerSessionId: id,
        model: 'model-b', effort: 'medium', fast: false }, () => {}); t.after(() => explicit.close());
      await explicit.resume();
      assert.deepEqual(await explicit.runOptions({}), { model: 'model-b', effort: 'medium', fast: false }, 'GUI metadata never overrides an explicit worker declaration');
      await explicit.close();
    }
    if (remote) {
      const other = fixture(t, { remote: true, scope: 'host-b', home: f.root });
      const separate = other.factory.create({ ...other.spec, providerSessionId: id, preserveRunOptions: true }, () => {}); t.after(() => separate.close());
      await separate.resume(); assert.equal((await separate.runOptions({})).fast, false, 'another authenticated host cannot inherit the choice');
    }
  }
});

test('built-ins execute protocol controls, review root turns complete once, and unsupported names never become prompts', async t => {
  for (const remote of [false, true]) {
    const f = fixture(t, { remote }); await f.session.start();
    for (const text of ['/compact', '/review', '/review inspect this change', '!echo proof']) {
      const before = f.events.filter(row => row.type === 'turn.completed').length;
      await f.session.send({ clientMessageId: text.replace(/\W/g, '-') + before, text }); await tick();
      assert.equal(f.events.filter(row => row.type === 'turn.completed').length, before + 1);
      assert.equal(f.session.snapshot().state, 'idle');
    }
    assert.equal(f.events.filter(row => row.type === 'turn.started').length, 4);
    assert.equal(f.events.filter(row => row.type === 'context.compacted' && row.payload.trigger === 'manual').length, 1);
    const before = f.wire.length;
    await f.session.send({ clientMessageId: 'status', text: '/status' });
    assert.ok(f.events.some(row => row.type === 'item.upsert' && /额度 未知/.test(row.payload.content?.text || '')));
    assert.ok(f.wire.slice(before).every(row => !row.method.startsWith('turn/')));
    for (const text of ['/permissions', '/fork', '/reset', '/reviewing nope']) {
      if (text.startsWith('/reviewing')) continue;
      await assert.rejects(f.session.send({ clientMessageId: text.slice(1), text }), /原生模式暂不支持/);
    }
    const turns = f.wire.filter(row => row.method === 'turn/start' && row.params.threadId).length;
    await f.session.send({ clientMessageId: 'custom', text: '/prompts:mine ARG' }); await tick();
    await f.session.send({ clientMessageId: 'skill', text: '/lookup ARG' }); await tick();
    const sent = f.wire.filter(row => row.method === 'turn/start' && row.params.threadId).slice(turns);
    assert.equal(sent[0].params.input[0].text, '/prompts:mine ARG');
    assert.deepEqual(sent[1].params.input.at(-1), { type: 'skill', name: 'lookup', path: path.join(f.root, 'SKILL.md') });
    assert.deepEqual(builtinCommands().map(row => row.name), ['/model', '/effort', '/fast', '/new', '/clear', '/compact', '/review', '/status']);
    assert.equal(unsupported.has('fork'), true);
  }
});

test('uncertain shell delivery stays unknown and duplicate command IDs never restart it', async t => {
  for (const kind of [true, 'after-start']) {
    const f = fixture(t); await f.session.start(); f.drop(kind);
    await assert.rejects(f.session.shell('shell-id', 'echo proof'), error => error.uncertain === true);
    assert.ok(f.events.some(row => row.itemId === 'shell:shell-id' && row.payload.content?.modelDelivery === 'unknown'));
    await assert.rejects(f.session.shell('shell-id', 'echo proof'));
    assert.equal(f.wire.filter(row => row.method === 'thread/shellCommand').length, 1);
  }
});

test('Codex router controls and fresh conversation preserve identity checks and IPC exposes no execution parameters', async t => {
  const f = fixture(t, { remote: true });
  const router = createRouter({ codex: f.factory, claude: { apiState: () => ({ status: 'ready' }) }, settings: { get: () => ({}) },
    resolveSpec: () => f.spec, emit() {}, terminal() { assert.fail('no terminal'); } }); t.after(() => router.close());
  const first = await router.start('t', { agent: 'codex' });
  await router.runOptions('t', first.runtimeSessionId, { effort: 'ultra', fast: true });
  const second = await router.newConversation('t', first.runtimeSessionId);
  assert.notEqual(first.runtimeSessionId, second.runtimeSessionId);
  await assert.rejects(router.models('t', first.runtimeSessionId), /会话已变化/);
  assert.deepEqual(await router.runOptions('t', second.runtimeSessionId, {}), { model: 'model-a', effort: 'ultra', fast: true });
  const handlers = {};
  registerIpc({ handle: (name, handler) => { handlers[name] = handler; }, router, settings: { get() {} }, claude: { credentials: {} } });
  await handlers['native:run-options']('t', second.runtimeSessionId, { effort: 'ultra' });
  assert.throws(() => handlers['native:run-options']('t', second.runtimeSessionId, { cwd: 'untrusted' }));
  assert.throws(() => handlers['native:run-options']('t', second.runtimeSessionId, { effort: 'x'.repeat(100) }));
});
