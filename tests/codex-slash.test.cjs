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
function fixture(t, { remote = false, scope = 'host-a', home, env = {}, shellOf } = {}) {
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
          result = { ...threads.get(id), thread: { id, status: { type: 'idle' } }, model: p.model || 'model-a', reasoningEffort: p.config?.model_reasoning_effort || 'high', serviceTier: p.serviceTier || null, sandbox: { type: { 'danger-full-access': 'dangerFullAccess', 'workspace-write': 'workspaceWrite' }[p.sandbox] || 'readOnly' } };
          threads.set(id, result);
        }
        if (method === 'thread/turns/list') result = { data: [], nextCursor: null };
        if (method === 'account/read') result = { account: null, requiresOpenaiAuth: true };
        if (method === 'account/rateLimits/read') result = { rateLimits: { limitId: 'codex', primary: null, secondary: null }, rateLimitsByLimitId: {} };
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
  const factory = createCodexRuntime({ optionsHome: root, resolveExecutable: async () => 'unused', spawnProcess: peer, ...(shellOf ? { shellOf } : {}),
    launchRemote: async () => ({ child: peer(), cwd: root }) });
  const spec = { owner: 'gui', projectId: 'p', terminalId: 't', cwd: root, env: { CODEX_HOME: root, ...env }, ...(remote ? { kind: 'ssh' } : {}) };
  const session = factory.create(spec, event => events.push(event)); t.after(() => session.close());
  return { root, factory, spec, session, events, wire, drop: (kind = true) => { drop = kind; } };
}

test('Codex resume sends the current seat even with saved beta thread settings', async t => {
  for (const remote of [false, true]) {
    const f = fixture(t, { remote }); await f.session.start();
    const id = f.session.snapshot().events.find(row => row.providerSessionId).providerSessionId;
    const key = require('node:crypto').createHash('sha256').update(JSON.stringify(
      [remote ? 'ssh' : 'local', remote ? ['host-a', f.root] : fs.realpathSync.native(f.root), id])).digest('hex');
    const directory = path.join(f.root, 'agentrix-run-options');
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, key + '.json'), JSON.stringify({ model: 'model-a', effort: 'low', fast: false }));
    await f.session.close();
    const resumed = f.factory.create({ ...f.spec, providerSessionId: id, preserveRunOptions: true,
      model: 'model-b', effort: 'medium', fast: true }, () => {});
    t.after(() => resumed.close());
    await resumed.resume();
    const resume = f.wire.findLast(row => row.method === 'thread/resume' && row.params.threadId).params;
    assert.deepEqual([resume.model, resume.config.model_reasoning_effort, resume.serviceTier], ['model-b', 'medium', 'fast']);
    for (const patch of [{ model: 'model-a' }, { effort: 'low' }, { fast: false }]) {
      await assert.rejects(resumed.runOptions(patch), error => error.code === 'routing-owned');
    }
    await resumed.send({ clientMessageId: 'next', text: 'Next turn' }); await tick();
    const turn = f.wire.findLast(row => row.method === 'turn/start').params;
    assert.deepEqual([turn.model, turn.effort, turn.serviceTier], ['model-b', 'medium', 'fast']);
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
    const itemsBefore = f.events.filter(row => row.type === 'item.upsert').length;
    const status = await f.session.send({ clientMessageId: 'status', text: '/status' });
    assert.deepEqual([status.status, status.local.command, status.local.account.kind, status.local.limits.map(row => row.usedPercent)], ['consumed', 'status', 'none', [null, null]], 'the answer is the receipt, with unread quota unknown');
    assert.equal(f.events.filter(row => row.type === 'item.upsert').length, itemsBefore, 'and no item of the conversation');
    assert.ok(f.wire.slice(before).every(row => !row.method.startsWith('turn/')));
    for (const text of ['/fork', '/reset', '/reviewing nope']) {
      if (text.startsWith('/reviewing')) continue;
      await assert.rejects(f.session.send({ clientMessageId: text.slice(1), text }), /原生模式暂不支持/);
    }
    // /permissions is the composer's menu (run options), never words for the model.
    await assert.rejects(f.session.send({ clientMessageId: 'permissions', text: '/permissions full' }), /请使用原生输入框的命令菜单/);
    const turns = f.wire.filter(row => row.method === 'turn/start' && row.params.threadId).length;
    for (const [i, text] of ['/model model-b', '/effort high', '/fast'].entries()) {
      await assert.rejects(f.session.send({ clientMessageId: 'routing-' + i, text }), error => error.code === 'routing-owned');
    }
    assert.equal(f.wire.filter(row => row.method === 'turn/start' && row.params.threadId).length, turns);
    await f.session.send({ clientMessageId: 'custom', text: '/prompts:mine ARG' }); await tick();
    await f.session.send({ clientMessageId: 'skill', text: '/lookup ARG' }); await tick();
    const sent = f.wire.filter(row => row.method === 'turn/start' && row.params.threadId).slice(turns);
    assert.equal(sent[0].params.input[0].text, '/prompts:mine ARG');
    assert.deepEqual(sent[1].params.input.at(-1), { type: 'skill', name: 'lookup', path: path.join(f.root, 'SKILL.md') });
    assert.deepEqual(builtinCommands().map(row => row.name), ['/new', '/clear', '/compact', '/review', '/status', '/usage', '/permissions']);
    assert.equal(unsupported.has('fork'), true);
  }
});

test("an owner's ! command in a planner's session runs behind the line that takes the shims out, and shows as typed", async t => {
  const { ownerShellCommand } = require('../electron/shared/agentrix-shims.cjs');
  const { itemPayload } = require('../electron/features/codex-app-server/events.cjs');
  const planner = { AGENTRIX_SHIMS: '/agentrix/shims', AGENTRIX_DISPATCH_DEPTH: '0' }, typed = `claude -p --output-format json "it's x"`;
  // The line goes only to a shell it is written for; fish, cmd or an unknown shell gets the text as typed.
  for (const [remote, env, shell, expected] of [[false, planner, 'posix', ownerShellCommand(typed, planner, 'posix')],
    [false, planner, 'powershell', ownerShellCommand(typed, planner, 'powershell')], [false, planner, null, typed], [false, {}, 'posix', typed], [true, planner, 'posix', typed]]) {
    const asked = [];
    const f = fixture(t, { remote, env, shellOf: options => { asked.push(options); return shell; } }); await f.session.start();
    await f.session.shell('owner', typed);
    assert.equal(f.wire.findLast(row => row.method === 'thread/shellCommand').params.command, expected, `${shell} ${remote}`);
    if (!remote) assert.equal(asked.at(-1).env, f.spec.env, "the lookup sees the session's own env");
  }
  assert.notEqual(ownerShellCommand(typed, planner, 'posix'), typed);
  for (const shell of ['posix', 'powershell']) {
    const shown = itemPayload({ type: 'commandExecution', id: 'c', command: '/bin/zsh -lc rendered', status: 'completed',
      commandActions: [{ type: 'unknown', command: ownerShellCommand(typed, planner, shell) }] }, true);
    assert.equal(shown.content.command, typed, shell);
  }
  // Codex may split the text into several actions: its rendering keeps the POSIX line verbatim, and the line goes from there.
  const plain = 'git status && npm test', rendered = `/bin/zsh -lc '${ownerShellCommand(plain, planner, 'posix')}'`;
  assert.equal(itemPayload({ type: 'commandExecution', id: 'c', command: rendered, status: 'completed',
    commandActions: [{ type: 'unknown', command: 'git status' }, { type: 'unknown', command: 'npm test' }] }, true).content.command, `/bin/zsh -lc '${plain}'`);
  assert.equal(itemPayload({ type: 'commandExecution', id: 'c', command: 'npm test', status: 'completed', commandActions: [{ type: 'unknown', command: 'npm test' }] }, true).content.command, 'npm test');
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

test('Codex /new takes the current seat and rejects option updates on a retired binding', async t => {
  const f = fixture(t, { remote: true });
  const choices = { model: 'model-a', effort: 'high', fast: false };
  const router = createRouter({ codex: f.factory, claude: { facts: () => [] }, settings: { get: () => ({}) },
    resolveSpec: () => ({ ...f.spec, ...choices }), prepareConversation: spec => { Object.assign(spec, choices); },
    emit() {}, terminal() { assert.fail('no terminal'); } }); t.after(() => router.close());
  const first = await router.start('t', { agent: 'codex' });
  Object.assign(choices, { model: 'model-b', effort: 'medium', fast: true });
  assert.equal((await router.runOptions('t', first.runtimeSessionId, {})).model, 'model-a');
  const second = await router.newConversation('t', first.runtimeSessionId);
  assert.notEqual(first.runtimeSessionId, second.runtimeSessionId);
  await assert.rejects(router.runOptions('t', first.runtimeSessionId, {}), /会话已变化/);
  assert.deepEqual(await router.runOptions('t', second.runtimeSessionId, {}), { ...choices, permissions: 'full' });
  const handlers = {};
  registerIpc({ handle: (name, handler) => { handlers[name] = handler; }, router, settings: { get() {} }, claude: { credentials: {} } });
  assert.equal(handlers['native:run-options']('t', second.runtimeSessionId, { effort: 'high' }).code, 'routing-owned');
  assert.throws(() => handlers['native:run-options']('t', second.runtimeSessionId, { cwd: 'untrusted' }));
});
