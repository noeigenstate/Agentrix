require('./fixtures/team-isolation.cjs');
// The owner's Codex permissions (Settings.codexPermissions and /permissions). An in-process stand-in answers the JSON-RPC envelopes and fields of
// the 0.167 app-server schema (thread/start, thread/settings/update and its thread/settings/updated notice, thread/unsubscribe); no executable,
// account directory, network request or real host is used. The local runs inject the platform they describe.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');

const TYPES = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
// The CLI's own configuration in this stand-in: read-only, asking on request, under the built-in read-only profile (what 0.167 gives an untrusted folder).
const CONFIGURED = { sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request', activePermissionProfile: { id: ':read-only', extends: null } };

// `apply(params)` is the sandbox the stand-in really applies to a thread request; `settle(params)` what it reports after a settings update (null
// sends no notice), `reviewer` the approver it reports, `noise` notices it sends before its confirmation, `silentProbe` an ephemeral start it
// announces but never answers, `reject` a method it refuses with that JSON-RPC code. As 0.167 does, it announces every thread it starts.
function codexServer({ apply = params => params.sandbox ? { type: TYPES[params.sandbox] } : CONFIGURED.sandbox, settle, reviewer, noise = [], silentProbe = false, reject = {}, threadId = 'owner-thread' } = {}) {
  const child = new EventEmitter(), wire = [], waits = [];
  let probes = 0, starts = 0;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.kill = () => { if (child.exitCode !== null) return; child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  const notify = (method, params) => send({ method, params });
  child.stdin = new Writable({ write(bytes, _encoding, done) {
    for (const line of bytes.toString().trim().split('\n')) {
      const request = JSON.parse(line), p = request.params || {}; wire.push(request);
      for (const wait of waits.filter(wait => wait.test(request))) { waits.splice(waits.indexOf(wait), 1); wait.resolve(request); }
      if (request.id == null) continue;
      queueMicrotask(() => {
        if (['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(request.method) && !p.threadId) return send({ id: request.id, error: { code: -32602, message: 'missing threadId' } });
        if (Object.hasOwn(reject, request.method)) return send({ id: request.id, error: { code: reject[request.method], message: 'private server message' } });
        let result = {};
        if (request.method === 'initialize') result = { userAgent: 'codex/0.167.0' };
        else if (['thread/start', 'thread/resume'].includes(request.method)) {
          const id = p.threadId || (p.ephemeral ? `probe-${++probes}` : ++starts === 1 ? threadId : `${threadId}-${starts}`), configured = !p.sandbox && !p.approvalPolicy;
          const thread = { id, turns: [], status: { type: 'idle' }, ephemeral: p.ephemeral === true };
          if (request.method === 'thread/start') notify('thread/started', { thread });
          if (p.ephemeral && silentProbe) return;
          result = { thread, cwd: p.cwd, model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: null,
            approvalPolicy: p.approvalPolicy || CONFIGURED.approvalPolicy, approvalsReviewer: p.approvalsReviewer, sandbox: apply(p),
            activePermissionProfile: configured ? CONFIGURED.activePermissionProfile : null };
        } else if (request.method === 'thread/unsubscribe') result = { status: 'unsubscribed' };
        else if (request.method === 'thread/turns/list') result = { data: [], nextCursor: null, backwardsCursor: null };
        else if (request.method === 'turn/start') result = { turn: { id: 'turn-1', status: 'inProgress', items: [] } };
        else if (request.method === 'account/rateLimits/read') result = { rateLimits: { limitId: 'codex', primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 2000000000 } }, rateLimitsByLimitId: {} };
        send({ id: request.id, result });
        // A turn starts and keeps running until the test is over.
        if (request.method === 'turn/start') notify('turn/started', { threadId: p.threadId, turn: result.turn });
        // Codex answers a settings change first and confirms it with a notice of the thread's settings.
        if (request.method === 'thread/settings/update') {
          for (const [method, params] of noise) notify(method, params);
          const sandboxPolicy = settle ? settle(p) : p.sandboxPolicy || (p.permissions === ':read-only' ? CONFIGURED.sandbox : { type: 'workspaceWrite' });
          if (sandboxPolicy) notify('thread/settings/updated', { threadId: p.threadId, threadSettings: { model: 'gpt-6.1-sol', effort: 'high', serviceTier: null,
            approvalPolicy: p.approvalPolicy ?? CONFIGURED.approvalPolicy, approvalsReviewer: reviewer ?? p.approvalsReviewer, sandboxPolicy,
            activePermissionProfile: p.permissions ? { id: p.permissions, extends: null } : null } });
        }
      });
    }
    done();
  } });
  // `written(test)` resolves when the runtime writes a matching request: the evidence a test waits for, never a pause.
  const written = test => wire.find(test) ? Promise.resolve(wire.find(test)) : new Promise(resolve => waits.push({ test, resolve }));
  return { child, wire, notify, written, threadRequests: method => wire.filter(row => row.method === method && row.params?.cwd) };
}

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-permissions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
// A runtime over one stand-in, local or SSH. The SSH one reaches the stand-in through the injected remote launcher, as main's does.
function runtime(t, { kind = 'local', platform = 'linux', server = codexServer(), spec = {} } = {}) {
  const root = directory(t), remote = kind === 'ssh';
  if (remote) Object.assign(server.child, { remote: true, remoteScope: 'remote-scope' });
  const factory = createCodexRuntime({ platform, optionsHome: root, resolveExecutable: async () => 'fake-only', spawnProcess: () => server.child,
    launchRemote: async () => ({ cwd: '/srv/project', child: server.child, hosts: [] }) });
  const session = factory.create({ owner: 'gui', projectId: 'p', terminalId: 't', ...(remote ? { kind: 'ssh', cwd: '/srv/project', env: {} } : { cwd: root, env: { CODEX_HOME: root, PATH: '' } }), ...spec }, () => {});
  t.after(() => session.close());
  return { session, server, root };
}
const policyOf = params => ({ sandbox: params.sandbox, approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer });
const FULL = { sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' };
const ASK = { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' };
const CONFIG = { sandbox: undefined, approvalPolicy: undefined, approvalsReviewer: 'user' };

for (const kind of ['local', 'ssh']) {
  test(`${kind}: each Codex permissions choice gives its own thread/start and thread/resume parameters`, async t => {
    for (const [permissions, expected] of [['full', FULL], ['config', CONFIG], ['ask', ASK]]) {
      for (const resume of [false, true]) {
        const { session, server } = runtime(t, { kind, spec: { permissions, providerSessionId: resume ? 'owner-thread' : null } });
        await session[resume ? 'resume' : 'start']();
        const [request] = server.threadRequests(resume ? 'thread/resume' : 'thread/start');
        assert.deepEqual(policyOf(request.params), expected, `${kind} ${permissions} ${resume ? 'resume' : 'start'}`);
        assert.equal((await session.runOptions({})).permissions, permissions);
        await session.close();
      }
    }
  });

  test(`${kind}: a missing or unknown Codex permissions value is full access`, async t => {
    for (const permissions of [undefined, null, '', 'bypass', 'FULL', 42, { full: true }, ['ask']]) {
      const { session, server } = runtime(t, { kind, spec: { permissions } });
      await session.start();
      assert.deepEqual(policyOf(server.threadRequests('thread/start')[0].params), FULL, JSON.stringify(permissions));
      assert.equal((await session.runOptions({})).permissions, 'full');
      await session.close();
    }
  });
}

test('dispatched, roundtable and read-only sessions keep their own sandbox and approvals whatever the permissions say', async t => {
  // The dispatch helper's own policy (integration/dispatch.cjs) is the production worker spec.
  const helper = { owner: 'dispatch', policy: { approvalPolicy: 'never' } };
  for (const [spec, expected] of [
    [{ ...helper, permissions: 'full' }, { sandbox: 'workspace-write', approvalPolicy: 'never', approvalsReviewer: 'user' }],
    [{ ...helper, roundtable: true, permissions: 'full' }, { sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user' }],
    [{ ...helper, readOnly: true, permissions: 'ask' }, { sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user' }],
    [{ owner: 'dispatch', permissions: 'full' }, { sandbox: 'workspace-write', approvalPolicy: undefined, approvalsReviewer: 'user' }],
    [{ owner: 'dispatch', readOnly: true, permissions: 'full' }, { sandbox: 'read-only', approvalPolicy: undefined, approvalsReviewer: 'user' }],
    [{ owner: 'gui', readOnly: true, permissions: 'full' }, { sandbox: 'read-only', approvalPolicy: undefined, approvalsReviewer: 'user' }],
    [{ owner: 'gui', roundtable: true, permissions: 'ask' }, { sandbox: 'read-only', approvalPolicy: undefined, approvalsReviewer: 'user' }],
  ]) {
    const { session, server } = runtime(t, { spec });
    await session.start();
    assert.deepEqual(policyOf(server.threadRequests('thread/start')[0].params), expected, JSON.stringify(spec));
    assert.equal((await session.runOptions({})).permissions, undefined, 'a worker reports no owner permissions');
    await assert.rejects(session.runOptions({ permissions: 'full' }), /这个会话不能更改权限/);
    assert.equal(server.wire.some(row => row.method === 'thread/settings/update' || row.params?.ephemeral), false, 'a worker’s thread is never changed');
    await session.close();
  }
});

test('a sandbox Codex did not apply stops the start and says why: full, ask over SSH, and ask on Windows after one unelevated retry', async t => {
  const readOnly = () => ({ type: 'readOnly', networkAccess: false });
  const cases = [
    { kind: 'local', platform: 'linux', permissions: 'full', reason: /未应用完全访问权限，已停止启动/, requested: 'danger-full-access' },
    { kind: 'ssh', platform: 'win32', permissions: 'ask', reason: /远端 Codex 只给了只读沙箱.*远端是 Windows 时.*\[windows\]/, requested: 'workspace-write', starts: 1 },
    { kind: 'local', platform: 'win32', permissions: 'ask', reason: /\[windows\] 中设置 sandbox = "unelevated"/, requested: 'workspace-write', starts: 2 },
  ];
  for (const { kind, platform, permissions, reason, requested, starts = 1 } of cases) {
    const server = codexServer({ apply: readOnly }), { session } = runtime(t, { kind, platform, server, spec: { permissions } });
    const error = await session.start().then(() => null, value => value);
    assert.ok(error, `${kind} ${permissions} must not start`);
    assert.match(error.message, reason); assert.equal(error.code, 'sandbox_mismatch');
    assert.deepEqual([error.requestedSandbox, error.appliedSandbox], [requested, 'readOnly']);
    assert.equal(server.threadRequests('thread/start').length, starts, 'only a local Windows writable request is retried, once');
    assert.equal(session.snapshot().state, 'failed');
  }
  // On Windows the owner's "ask" gets the same request-scoped unelevated retry as a dispatched worker, and the read-only thread is let go first.
  const server = codexServer({ apply: params => params.config?.['windows.sandbox'] === 'unelevated' ? { type: 'workspaceWrite' } : readOnly() });
  const { session } = runtime(t, { platform: 'win32', server, spec: { permissions: 'ask' } });
  await session.start();
  const [first, second] = server.threadRequests('thread/start');
  assert.deepEqual([first.params.config['windows.sandbox'], second.params.config['windows.sandbox']], [undefined, 'unelevated']);
  const order = server.wire.filter(row => ['thread/start', 'thread/unsubscribe'].includes(row.method) && (row.params.cwd || row.params.threadId)).map(row => [row.method, row.params.threadId]);
  assert.deepEqual(order, [['thread/start', undefined], ['thread/unsubscribe', 'owner-thread'], ['thread/start', undefined]]);
  assert.equal(session.threadResponse.sandbox.type, 'workspaceWrite');
});

test('the router names the sandbox Codex did not apply when a session fails to start', async t => {
  const root = directory(t), server = codexServer({ apply: () => ({ type: 'readOnly' }) }), events = [];
  const router = createRouter({ codex: createCodexRuntime({ platform: 'linux', resolveExecutable: async () => 'fake-only', spawnProcess: () => server.child }),
    claude: { apiState: () => ({ status: 'no_key' }) }, settings: { get: () => ({}) }, emit: row => events.push(row),
    resolveSpec: () => ({ terminalId: 't', projectId: 'p', owner: 'gui', cwd: root, env: { CODEX_HOME: root, PATH: '' } }) });
  t.after(() => router.close());
  await assert.rejects(router.start('t', { agent: 'codex' }), /Codex 未应用完全访问权限，已停止启动/);
  assert.match(events.find(row => row.type === 'error').payload.message, /未应用完全访问权限/);
});

test('/permissions changes the running session only, from its next turn, with what a new session of that choice would get', async t => {
  for (const kind of ['local', 'ssh']) {
    const mine = runtime(t, { kind, spec: { permissions: 'ask' } }), other = runtime(t, { kind, server: codexServer({ threadId: 'other-thread' }), spec: { permissions: 'ask' } });
    await mine.session.start(); await other.session.start();
    const changed = await mine.session.runOptions({ permissions: 'full' });
    assert.equal(changed.permissions, 'full');
    // The target is read from an ephemeral thread started exactly as a new "full" session would be, and that thread is let go.
    const probe = mine.server.wire.find(row => row.method === 'thread/start' && row.params.ephemeral);
    assert.deepEqual(policyOf(probe.params), FULL, kind);
    assert.ok(mine.server.wire.some(row => row.method === 'thread/unsubscribe' && row.params.threadId === 'probe-1'));
    const update = mine.server.wire.find(row => row.method === 'thread/settings/update');
    assert.deepEqual(update.params, { threadId: 'owner-thread', approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } });
    assert.equal(mine.server.wire.filter(row => row.method === 'turn/start' && row.params.threadId).length, 0, 'changing permissions starts no turn');
    assert.equal(mine.session.threadResponse.sandbox.type, 'dangerFullAccess', 'what Codex confirmed is what /status shows');
    // Another session, and the next new one, keep the Settings choice.
    assert.equal((await other.session.runOptions({})).permissions, 'ask');
    assert.equal(other.server.wire.some(row => row.method === 'thread/settings/update'), false);
    const next = runtime(t, { kind, server: codexServer({ threadId: 'next-thread' }), spec: { permissions: 'ask' } }); await next.session.start();
    assert.deepEqual(policyOf(next.server.threadRequests('thread/start')[0].params), ASK);
    // "config" applies what the CLI's configuration gives a new thread, keeping its named profile; the same choice again sends nothing.
    await mine.session.runOptions({ permissions: 'config' });
    assert.deepEqual(policyOf(mine.server.wire.filter(row => row.method === 'thread/start' && row.params.ephemeral).at(-1).params), CONFIG);
    assert.deepEqual(mine.server.wire.filter(row => row.method === 'thread/settings/update').at(-1).params,
      { threadId: 'owner-thread', approvalPolicy: 'on-request', approvalsReviewer: 'user', permissions: ':read-only' });
    const updates = mine.server.wire.filter(row => row.method === 'thread/settings/update').length;
    await mine.session.runOptions({ permissions: 'config' });
    assert.equal(mine.server.wire.filter(row => row.method === 'thread/settings/update').length, updates);
    assert.equal((await mine.session.runOptions({})).permissions, 'config');
    await assert.rejects(mine.session.runOptions({ permissions: 'bypass' }), /无效的权限选项/);
    await assert.rejects(mine.session.runOptions({ permissions: 'full', fast: true }), /无效的运行选项/);
  }
});

test('/permissions refuses with the reason when Codex would not apply the sandbox, and the session keeps its choice', async t => {
  // The ephemeral thread shows Codex would not apply full access: nothing is changed.
  const refusing = codexServer({ apply: params => params.ephemeral ? { type: 'readOnly' } : { type: TYPES[params.sandbox] } });
  const first = runtime(t, { server: refusing, spec: { permissions: 'ask' } });
  await first.session.start();
  await assert.rejects(first.session.runOptions({ permissions: 'full' }), error => error.code === 'sandbox_mismatch' && /不会应用完全访问权限，本会话权限未更改/.test(error.message));
  assert.equal(refusing.wire.some(row => row.method === 'thread/settings/update'), false);
  assert.equal((await first.session.runOptions({})).permissions, 'ask');
});

test('Windows (local, injected platform): only a thread that started writable switches to "ask", whatever the configuration says later', async t => {
  // Whether the CLI's configuration has a [windows] sandbox: without one a writable request is answered read-only unless it carries the
  // request-scoped unelevated sandbox. The stand-in can change it mid-session, as an owner editing config.toml would.
  let configured = false;
  const answer = params => params.sandbox === 'workspace-write' && !configured && params.config?.['windows.sandbox'] !== 'unelevated' ? { type: 'readOnly' }
    : params.sandbox ? { type: TYPES[params.sandbox] } : CONFIGURED.sandbox;
  const server = codexServer({ apply: answer });
  const { session } = runtime(t, { platform: 'win32', server, spec: { permissions: 'full' } });
  await session.start();
  const refusal = error => error.code === 'sandbox_mismatch' && /这个会话启动时没有 Windows 沙箱.*修改 Codex 配置后也一样。请新建会话使用「先询问」/.test(error.message);
  await assert.rejects(session.runOptions({ permissions: 'ask' }), refusal);
  // The configuration now has a Windows sandbox, so a new thread would be writable: this thread still started without one.
  configured = true;
  await assert.rejects(session.runOptions({ permissions: 'ask' }), refusal, 'a configuration changed mid-session gives the running thread no sandbox');
  assert.equal(server.wire.some(row => row.method === 'thread/settings/update' || row.params?.ephemeral), false, 'nothing is asked of Codex for it');
  assert.deepEqual([(await session.runOptions({})).permissions, session.threadResponse.sandbox.type], ['full', 'dangerFullAccess']);
  // A thread that started as "ask" (through the unelevated retry) keeps its sandbox: it may leave "ask" and come back, its target read the same way.
  configured = false;
  const writable = codexServer({ apply: answer }), asked = runtime(t, { platform: 'win32', server: writable, spec: { permissions: 'ask' } });
  await asked.session.start();
  assert.equal((await asked.session.runOptions({ permissions: 'full' })).permissions, 'full');
  assert.equal((await asked.session.runOptions({ permissions: 'ask' })).permissions, 'ask');
  const probes = writable.wire.filter(row => row.method === 'thread/start' && row.params.ephemeral && row.params.sandbox === 'workspace-write');
  assert.deepEqual(probes.map(row => row.params.config?.['windows.sandbox']), [undefined, 'unelevated']);
  const at = test => writable.wire.findIndex(test);
  const letGo = at(row => row.method === 'thread/unsubscribe' && row.params.threadId === 'probe-2');
  assert.ok(letGo >= 0 && letGo < at(row => row.params?.ephemeral && row.params.config?.['windows.sandbox'] === 'unelevated'), 'the read-only probe is let go before the retry');
  assert.equal(asked.session.threadResponse.sandbox.type, 'workspaceWrite');
  // Over SSH a remote that answers read-only is told as a remote one.
  const remoteServer = codexServer({ apply: params => params.ephemeral && params.sandbox === 'workspace-write' ? { type: 'readOnly' } : { type: TYPES[params.sandbox] } });
  const remote = runtime(t, { kind: 'ssh', platform: 'win32', server: remoteServer, spec: { permissions: 'full' } });
  await remote.session.start();
  await assert.rejects(remote.session.runOptions({ permissions: 'ask' }), /远端 Codex 只给了只读沙箱/);
});

test('/permissions takes the change only once Codex reports it with the user as the only approver, waiting past unrelated notices', async t => {
  // Notices of another thread, of this thread's other settings and of its items come first; the confirmation comes last.
  const noise = [['thread/settings/updated', { threadId: 'someone-else', threadSettings: { sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never', approvalsReviewer: 'user' } }],
    ['thread/settings/updated', { threadId: 'owner-thread', threadSettings: { model: 'gpt-6.1-sol', effort: 'low', serviceTier: null } }],
    ['item/agentMessage/delta', { threadId: 'owner-thread', turnId: 'turn-0', itemId: 'x', delta: 'unrelated' }]];
  const patient = runtime(t, { server: codexServer({ noise }), spec: { permissions: 'ask' } });
  await patient.session.start();
  assert.equal((await patient.session.runOptions({ permissions: 'full' })).permissions, 'full');
  // A confirmation that names another approver is no confirmation: the deadline passes and the owner is told it may have been applied.
  const reviewed = runtime(t, { server: codexServer({ reviewer: 'auto_review' }), spec: { permissions: 'ask', rpcTimeoutMs: 300 } });
  await reviewed.session.start();
  await assert.rejects(reviewed.session.runOptions({ permissions: 'full' }), /没有及时确认权限更改，可能已经应用，请用 \/status 查看/);
  assert.equal((await reviewed.session.runOptions({})).permissions, 'ask');
  // No confirmation at all: the same.
  const silent = runtime(t, { server: codexServer({ settle: () => null }), spec: { permissions: 'ask', rpcTimeoutMs: 300 } });
  await silent.session.start();
  await assert.rejects(silent.session.runOptions({ permissions: 'full' }), /可能已经应用，请用 \/status 查看/);
  assert.equal((await silent.session.runOptions({})).permissions, 'ask');
});

test('/permissions during a running turn changes the thread for its next turn and leaves the turn running', async t => {
  const { session, server } = runtime(t, { spec: { permissions: 'ask' } });
  await session.start();
  assert.equal((await session.send({ clientMessageId: 'work', text: 'keep working' })).status, 'delivered');
  assert.equal(session.snapshot().state, 'running');
  assert.equal((await session.runOptions({ permissions: 'full' })).permissions, 'full');
  assert.equal(session.snapshot().state, 'running', 'the running turn goes on');
  assert.equal(server.wire.filter(row => row.method === 'turn/start' && row.params.threadId).length, 1, 'no turn is started or restarted for it');
  assert.equal(server.wire.some(row => row.method === 'turn/interrupt' && row.params.threadId), false);
  assert.deepEqual(server.wire.find(row => row.method === 'thread/settings/update').params.sandboxPolicy, { type: 'dangerFullAccess' });
});

test('/permissions failures are told in the owner’s words, and a probe thread is let go even when its answer never comes', async t => {
  // The probe never answers but is announced: it is let go, before and after the read gives up.
  const lost = codexServer({ silentProbe: true }), stuck = runtime(t, { server: lost, spec: { permissions: 'ask', rpcTimeoutMs: 300 } });
  await stuck.session.start();
  await assert.rejects(stuck.session.runOptions({ permissions: 'full' }), /Codex 没有及时回应，本会话权限未更改/);
  assert.ok(lost.wire.some(row => row.method === 'thread/unsubscribe' && row.params.threadId === 'probe-1'));
  lost.notify('thread/started', { thread: { id: 'probe-late', ephemeral: true, turns: [], status: { type: 'idle' } } });
  await lost.written(row => row.method === 'thread/unsubscribe' && row.params.threadId === 'probe-late');
  // An older Codex refuses the fields; another refusal is told as one; neither changes the session.
  for (const [code, reason] of [[-32602, /这个版本的 Codex 不支持在会话中切换权限/], [-32603, /Codex 拒绝了权限更改，本会话权限未更改/]]) {
    const { session } = runtime(t, { server: codexServer({ reject: { 'thread/settings/update': code } }), spec: { permissions: 'ask' } });
    await session.start();
    await assert.rejects(session.runOptions({ permissions: 'full' }), error => reason.test(error.message) && !/private server message/.test(error.message));
    assert.equal((await session.runOptions({})).permissions, 'ask');
  }
});

test('the three permissions names are one list: main’s module, the window’s constant, the Settings store and the runtime agree', async t => {
  const { CODEX_PERMISSIONS } = require('../electron/codex-permissions.cjs');
  assert.equal(require('../electron/state.cjs').CODEX_PERMISSIONS, CODEX_PERMISSIONS, 'state.cjs takes the shared module');
  const shared = fs.readFileSync(path.join(__dirname, '../src/shared/codex-permissions.ts'), 'utf8');
  assert.deepEqual(JSON.parse(/CODEX_PERMISSIONS = (\[[^\]]*\])/.exec(shared)[1].replace(/'/g, '"')), [...CODEX_PERMISSIONS]);
  // Each name is one the runtime honours as itself, not by falling back to full.
  for (const permissions of CODEX_PERMISSIONS) {
    const { session } = runtime(t, { spec: { permissions } });
    await session.start();
    assert.equal((await session.runOptions({})).permissions, permissions);
    await session.close();
  }
});

test('the router keeps /permissions for this card’s session and its next conversation, never for the Settings default', async t => {
  const root = directory(t), servers = [];
  const factory = createCodexRuntime({ platform: 'linux', resolveExecutable: async () => 'fake-only', spawnProcess: () => { const server = codexServer({ threadId: `thread-${servers.length}` }); servers.push(server); return server.child; } });
  const settingsSpec = { terminalId: 't', projectId: 'p', owner: 'gui', cwd: root, env: { CODEX_HOME: root, PATH: '' }, permissions: 'ask' };
  const router = createRouter({ codex: factory, claude: { apiState: () => ({ status: 'no_key' }) }, settings: { get: () => ({}) }, emit() {},
    resolveSpec: () => ({ ...settingsSpec }) });
  t.after(() => router.close());
  const { runtimeSessionId } = await router.start('t', { agent: 'codex' });
  assert.equal((await router.runOptions('t', runtimeSessionId, { permissions: 'full' })).permissions, 'full');
  assert.equal(settingsSpec.permissions, 'ask', 'the Settings default is untouched');
  const renewed = await router.newConversation('t', runtimeSessionId);
  assert.deepEqual(policyOf(servers.at(-1).threadRequests('thread/start').at(-1).params), FULL, 'the next conversation of this session keeps its choice');
  assert.equal((await router.runOptions('t', renewed.runtimeSessionId, {})).permissions, 'full');
});

test('native IPC passes only the three permissions choices on to the router', async () => {
  const handlers = new Map(), calls = [];
  require('../electron/features/native-session/ipc.cjs').registerIpc({ handle: (name, handler) => handlers.set(name, handler),
    router: { runOptions: (...args) => calls.push(args) }, settings: {}, claude: { credentials: {} } });
  const run = handlers.get('native:run-options');
  for (const permissions of ['full', 'config', 'ask']) run('t', 's', { permissions });
  assert.deepEqual(calls.map(call => call[2].permissions), ['full', 'config', 'ask']);
  for (const permissions of ['bypass', null, 1, '']) assert.throws(() => run('t', 's', { permissions }));
});

for (const kind of ['local', 'ssh']) test(`${kind}: main hands a new Codex session the Settings permissions as stored, and a Claude one none`, () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const project = { id: 'p', kind, path: kind === 'ssh' ? '/srv/project' : path.resolve('project') };
  for (const stored of ['full', 'config', 'ask']) {
    const context = vm.createContext({ path, randomUUID: () => 'id', sessions: new Map(), findProject: () => project, disposeTerminal() {},
      store: { settings: { codexPermissions: stored }, findTerminal: () => ({ record: { restore: null } }) }, nativeSpecs: new Map(),
      runtimeDir: path.resolve('runtime'), eventServer: { name: 'pipe', address: '/socket' }, process: { platform: process.platform, env: {} },
      fs: { writeFileSync() {} }, createTerminalEnvironment: () => ({}), withoutAppImage: value => value, startupNote: () => 'context', READING_NOTE: 'reading',
      handoffFile: () => 'handoff', skills: { delivery() {} }, integrationDir: 'integration', controlAddress: 'control' });
    vm.runInContext(source.slice(source.indexOf('function nativeSpec('), source.indexOf('\nfunction structuredEvent(')), context);
    // Settings hold one of the three (state.cjs cleans the rest to full); the spec carries it as stored.
    assert.equal(context.nativeSpec('t', 'codex', false).permissions, stored);
    if (kind === 'local') assert.equal(Object.hasOwn(context.nativeSpec('t', 'claude', false), 'permissions'), false);
  }
});

// The composer's /permissions: Codex's only, a menu of the three choices with the current one marked, and a usage line for another value.
test('the composer reads /permissions for Codex only and offers the three choices', () => {
  const src = path.join(__dirname, '../src');
  const load = file => {
    const mod = new Module(file, module); mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
    const original = mod.require.bind(mod);
    mod.require = name => !name.startsWith('.') || name.endsWith('.json') ? original(name) : load(path.resolve(path.dirname(file), name.endsWith('.ts') ? name : name + '.ts'));
    mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
    return mod.exports;
  };
  const composer = load(path.join(src, 'features/native-session/native-composer.ts'));
  assert.deepEqual(composer.composerAction('/permissions', 'codex'), { kind: 'option', option: 'permissions', value: '' });
  assert.deepEqual(composer.composerAction('/permissions ask', 'codex'), { kind: 'option', option: 'permissions', value: 'ask' });
  assert.equal(composer.composerAction('/permissions', 'claude'), null, 'a Claude session keeps the words as a message');
  assert.deepEqual(['full', 'config', 'ask', 'bypass'].map(value => composer.optionPatch('permissions', value)), [{ permissions: 'full' }, { permissions: 'config' }, { permissions: 'ask' }, null]);
  assert.deepEqual(composer.permissionChoices('config').map(choice => [choice.name, choice.current]), [['full', false], ['config', true], ['ask', false]]);
  // The words follow the window's language; both are checked against the dictionary the window uses.
  const en = require('../electron/locales/en.json');
  assert.ok([en['用法：/permissions full、config 或 ask'], '用法：/permissions full、config 或 ask'].includes(composer.optionUsage('permissions')));
  const told = composer.optionTold('permissions', { model: null, effort: null, fast: false, permissions: 'ask' }, 'ask');
  assert.ok([en['本会话权限已设为{value}，从下一轮起生效'].replace('{value}', en['先询问']), '本会话权限已设为先询问，从下一轮起生效'].includes(told), told);
});
