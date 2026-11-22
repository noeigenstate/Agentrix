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
const { defineMain } = require('./helpers/main-modules.cjs');
const { timeoutScale } = require('../scripts/wait.mjs');

const TYPES = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
// The CLI's own configuration in this stand-in: read-only, asking on request, under the built-in read-only profile (what 0.167 gives an untrusted folder).
const CONFIGURED = { sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request', activePermissionProfile: { id: ':read-only', extends: null } };

// `apply(params)` is the sandbox the stand-in really applies to a thread request; `settle(params)` what it reports after a settings update (null
// sends no notice), `reviewer` the approver it reports, `noise` notices it sends before its confirmation, `silentProbe` an ephemeral start it
// announces but never answers, `reject` a method it refuses with that JSON-RPC code. As 0.167 does, it announces every thread it starts.
function codexServer({ apply = params => params.sandbox ? { type: TYPES[params.sandbox] } : CONFIGURED.sandbox, settle, reviewer, initialReviewer = 'user', noise = [], silentProbe = false, announceProbe = true, reject = {}, readiness = 'ready', version = '0.167.0', onWrite = () => {}, threadId = 'owner-thread' } = {}) {
  const child = new EventEmitter(), wire = [], waits = [];
  let probes = 0, starts = 0;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.kill = () => { if (child.exitCode !== null) return; child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  const notify = (method, params) => send({ method, params });
  child.stdin = new Writable({ write(bytes, _encoding, done) {
    for (const line of bytes.toString().trim().split('\n')) {
      const request = JSON.parse(line), p = request.params || {}; wire.push(request);
      onWrite(request);
      for (const wait of waits.filter(wait => wait.test(request))) { waits.splice(waits.indexOf(wait), 1); wait.resolve(request); }
      if (request.id == null) continue;
      queueMicrotask(() => {
        if (['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(request.method) && !p.threadId) return send({ id: request.id, error: { code: -32602, message: 'missing threadId' } });
        if (Object.hasOwn(reject, request.method)) return send({ id: request.id, error: typeof reject[request.method] === 'number'
          ? { code: reject[request.method], message: 'private server message' } : reject[request.method] });
        let result = {};
        if (request.method === 'initialize') result = { userAgent: 'codex/' + version };
        else if (request.method === 'windowsSandbox/readiness') result = { status: readiness };
        else if (request.method === 'command/exec') result = { exitCode: 0, stdout: p.cwd };
        else if (['thread/start', 'thread/resume'].includes(request.method)) {
          const id = p.threadId || (p.ephemeral ? `probe-${++probes}` : ++starts === 1 ? threadId : `${threadId}-${starts}`), configured = !p.sandbox && !p.approvalPolicy;
          const thread = { id, turns: [], status: { type: 'idle' }, ephemeral: p.ephemeral === true };
          if (request.method === 'thread/start' && (!p.ephemeral || announceProbe)) notify('thread/started', { thread });
          if (p.ephemeral && silentProbe) return;
          result = { thread, cwd: p.cwd, model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: null,
            approvalPolicy: p.approvalPolicy || CONFIGURED.approvalPolicy, ...(initialReviewer === null ? {} : { approvalsReviewer: initialReviewer }), sandbox: apply(p),
            activePermissionProfile: configured ? CONFIGURED.activePermissionProfile : null };
        } else if (request.method === 'thread/unsubscribe') result = { status: 'unsubscribed' };
        else if (request.method === 'thread/turns/list') result = { data: [], nextCursor: null, backwardsCursor: null };
        else if (request.method === 'turn/start') result = { turn: { id: 'turn-1', status: 'inProgress', items: [] } };
        else if (request.method === 'account/rateLimits/read') result = { rateLimits: { limitId: 'codex', primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 2000000000 } }, rateLimitsByLimitId: {} };
        if (request.method === 'thread/settings/update') for (const [method, params] of noise) notify(method, params);
        send({ id: request.id, result });
        // A turn starts and keeps running until the test is over.
        if (request.method === 'turn/start') notify('turn/started', { threadId: p.threadId, turn: result.turn });
        // Codex answers a settings change first and confirms it with a notice of the thread's settings.
        if (request.method === 'thread/settings/update') {
          const sandboxPolicy = settle ? settle(p) : p.sandboxPolicy || (p.permissions === ':read-only' ? CONFIGURED.sandbox : { type: 'workspaceWrite' });
          if (sandboxPolicy) notify('thread/settings/updated', { threadId: p.threadId, threadSettings: { model: 'gpt-6.1-sol', effort: 'high', serviceTier: null,
            approvalPolicy: p.approvalPolicy ?? CONFIGURED.approvalPolicy, ...(reviewer === null ? {} : { approvalsReviewer: reviewer ?? p.approvalsReviewer }), sandboxPolicy,
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
function runtime(t, { kind = 'local', platform = 'linux', server = codexServer(), spec = {}, timers } = {}) {
  const root = directory(t), remote = kind === 'ssh';
  const launches = [];
  if (remote) Object.assign(server.child, { remote: true, remoteScope: 'remote-scope' });
  const factory = createCodexRuntime({ platform, timers, optionsHome: root, resolveExecutable: async () => 'fake-only',
    spawnProcess: (_file, args) => { launches.push(args); return server.child; },
    launchRemote: async () => ({ cwd: '/srv/project', child: server.child, hosts: [], context: spec.context }) });
  const session = factory.create({ owner: 'gui', projectId: 'p', terminalId: 't', ...(remote ? { kind: 'ssh', cwd: '/srv/project', env: {} } : { cwd: root, env: { CODEX_HOME: root, PATH: '' } }), ...spec }, () => {});
  t.after(() => session.close());
  return { session, server, root, launches };
}
const policyOf = params => ({ sandbox: params.sandbox, approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer });
const FULL = { sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' };
const ASK = { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' };
const CONFIG = { sandbox: undefined, approvalPolicy: undefined, approvalsReviewer: 'user' };

function confirmationClock() {
  let now = 0;
  const pending = new Set(), scheduled = Promise.withResolvers();
  return { scheduled: scheduled.promise, pending,
    timers: {
      setTimeout(fn, delay) { const task = { fn, at: now + delay }; pending.add(task); scheduled.resolve(task); return task; },
      clearTimeout(task) { pending.delete(task); },
    },
    tick(ms) { now += ms; for (const task of [...pending]) if (task.at <= now) { pending.delete(task); task.fn(); } },
  };
}

for (const kind of ['local', 'ssh']) {
  test(`${kind}: each Codex permissions choice gives its own thread/start and thread/resume parameters`, async t => {
    for (const [permissions, expected] of [['full', FULL], ['config', CONFIG], ['ask', ASK]]) {
      for (const resume of [false, true]) {
        const spec = { permissions, effort: 'high', context: 'Follow the project instructions.', providerSessionId: resume ? 'owner-thread' : null };
        const { session, server } = runtime(t, { kind, spec });
        await session[resume ? 'resume' : 'start']();
        const [request] = server.threadRequests(resume ? 'thread/resume' : 'thread/start');
        assert.deepEqual(request.params.config, { model_reasoning_effort: 'high', developer_instructions: spec.context });
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

test('dispatched and read-only sessions keep their own sandbox and approvals whatever the permissions say', async t => {
  // The dispatch helper's own policy (integration/dispatch.cjs) is the production worker spec.
  const helper = { owner: 'dispatch', policy: { approvalPolicy: 'never' } };
  for (const [spec, expected] of [
    [{ ...helper, permissions: 'full' }, { sandbox: 'workspace-write', approvalPolicy: 'never', approvalsReviewer: 'user' }],
    [{ ...helper, readOnly: true, permissions: 'ask' }, { sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user' }],
    [{ owner: 'dispatch', permissions: 'full' }, { sandbox: 'workspace-write', approvalPolicy: undefined, approvalsReviewer: 'user' }],
    [{ owner: 'dispatch', readOnly: true, permissions: 'full' }, { sandbox: 'read-only', approvalPolicy: undefined, approvalsReviewer: 'user' }],
    [{ owner: 'gui', readOnly: true, permissions: 'full' }, { sandbox: 'read-only', approvalPolicy: undefined, approvalsReviewer: 'user' }],
    [{ owner: 'gui', readOnly: true, permissions: 'ask' }, { sandbox: 'read-only', approvalPolicy: undefined, approvalsReviewer: 'user' }],
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

test('local Windows dispatch requires elevated readiness and requests the scoped backend on start and resume', async t => {
  for (const platform of ['win32', 'linux']) for (const kind of ['local', 'ssh']) {
    const elevated = platform === 'win32' && kind === 'local';
    for (const readOnly of [false, true]) for (const resume of [false, true]) {
      const spec = { owner: 'dispatch', policy: { approvalPolicy: 'never' }, readOnly, providerSessionId: resume ? 'owner-thread' : null };
      const { session, server, launches } = runtime(t, { kind, platform, spec });
      await session[resume ? 'resume' : 'start']();
      const method = resume ? 'thread/resume' : 'thread/start';
      const [request] = server.threadRequests(method);
      const readiness = server.wire.findIndex(row => row.method === 'windowsSandbox/readiness');
      assert.deepEqual(policyOf(request.params), { sandbox: readOnly ? 'read-only' : 'workspace-write', approvalPolicy: 'never', approvalsReviewer: 'user' });
      assert.deepEqual(request.params.config, elevated ? { 'windows.sandbox': 'elevated', 'features.prefer_mxc': false } : {});
      assert.equal(readiness >= 0, elevated);
      if (elevated) {
        assert.ok(readiness < server.wire.indexOf(request));
        assert.deepEqual(server.wire[readiness].params, {});
        assert.deepEqual(launches[0].slice(3), ['-c', 'windows.sandbox=elevated', '-c', 'features.prefer_mxc=false']);
      }
      await session.close();
    }
  }
});

test('local Windows dispatch stops before opening a thread when elevated setup is missing or stale', async t => {
  for (const readiness of ['notConfigured', 'updateRequired']) for (const readOnly of [false, true]) {
    const server = codexServer({ readiness });
    const env = { USERDOMAIN: 'DOMAIN', USERNAME: 'test-user', CODEX_HOME: "C:\\Codex User's Home" };
    const { session } = runtime(t, { platform: 'win32', server, spec: { owner: 'dispatch', readOnly, env } });
    await assert.rejects(session.start(), {
      code: 'elevated_sandbox_not_ready',
      message: /重启 Agentrix.*「设置」.*管理员 PowerShell.*codex sandbox setup --elevated --user 'DOMAIN\\test-user' --codex-home 'C:\\Codex User''s Home'/,
    });
    assert.equal(server.threadRequests('thread/start').length, 0);
    assert.equal(session.snapshot().state, 'failed');
  }
});

test('local Windows dispatch asks the user to update Codex when the readiness method is unavailable', async t => {
  const server = codexServer({ reject: { 'windowsSandbox/readiness': -32601 } });
  const { session } = runtime(t, { platform: 'win32', server, spec: { owner: 'dispatch' } });
  await assert.rejects(session.start(), { code: 'unsupported_codex_version', stage: 'sandbox_readiness', message: /Codex 版本过旧.*请更新 Codex/ });
  assert.equal(server.threadRequests('thread/start').length, 0);
});

test('a freshly provisioned Windows role verifies the sandbox cwd before sending its brief', async t => {
  for (const readOnly of [true, false]) {
    const stages = [];
    const { session, server, root } = runtime(t, { platform: 'win32', spec: { owner: 'dispatch', readOnly, onSandboxWait: line => stages.push(line) } });
    fs.mkdirSync(path.join(root, '.sandbox'));
    fs.writeFileSync(path.join(root, '.sandbox', 'setup_marker.json'), '{}');
    await session.start();
    assert.equal(stages.length, 1);
    assert.equal((await session.send({ clientMessageId: 'brief', text: 'Role brief' })).status, 'delivered');
    const probe = server.wire.findIndex(row => row.method === 'command/exec');
    assert.ok(probe > server.wire.findIndex(row => row.method === 'thread/start'));
    assert.ok(probe < server.wire.findIndex(row => row.method === 'turn/start' && row.params.threadId));
    assert.equal(server.wire[probe].params.cwd, root);
    assert.deepEqual(server.wire[probe].params.sandboxPolicy, { type: readOnly ? 'readOnly' : 'workspaceWrite', networkAccess: false });
  }
});

test('dispatch launched inside SSH on Windows does not probe elevated readiness', async t => {
  const server = codexServer({ apply: () => ({ type: 'workspaceWrite' }) });
  const env = { SSH_CONNECTION: 'ssh-fixture' };
  const { session } = runtime(t, { platform: 'win32', server, spec: { owner: 'dispatch', readOnly: true, env } });
  await assert.rejects(session.start(), { code: 'sandbox_mismatch', requestedSandbox: 'read-only' });
  assert.equal(server.wire.some(row => row.method === 'windowsSandbox/readiness'), false);
});

test('the dispatch helper keeps the sandbox mismatch category and read-only hint over SSH', async t => {
  const { run } = require('../integration/dispatch.cjs');
  const cwd = directory(t), brief = path.join(cwd, 'brief.txt');
  fs.writeFileSync(brief, 'Synthetic review task');
  for (const remote of [false, true]) {
    const { child } = codexServer({ apply: () => ({ type: 'workspaceWrite' }) });
    child.remote = true; // The in-process fixture has no OS process tree.
    const env = { PATH: '', CODEX_HOME: cwd, ...(remote ? { SSH_CONNECTION: 'ssh-fixture' } : {}) };
    let output = '';
    const result = await run(['codex', '--role', 'review', '--title', 'Synthetic mismatch', '--model', 'gpt-6.1-sol',
      '--effort', 'high', '--read-only', '--cwd', cwd, '--brief', brief, '--out', path.join(cwd, remote ? 'remote.md' : 'local.md')], {
      env, stdout: { write: value => { output += value; } }, resolveExecutable: () => ({ file: 'fake-only', args: [] }), launch: () => child,
    });
    assert.equal(result, 1, output);
    assert.match(output, /Codex 未应用只读沙箱/);
    assert.equal(output.includes('(thread_start/sandbox_mismatch)'), remote || process.platform !== 'win32', output);
  }
});

test('local Windows dispatch still rejects sandbox mismatches without retrying', async t => {
  for (const readOnly of [false, true]) {
    const server = codexServer({ apply: () => ({ type: readOnly ? 'workspaceWrite' : 'readOnly' }) });
    const { session } = runtime(t, { platform: 'win32', server, spec: { owner: 'dispatch', readOnly } });
    await assert.rejects(session.start(), { code: 'sandbox_mismatch', requestedSandbox: readOnly ? 'read-only' : 'workspace-write' });
    assert.equal(server.threadRequests('thread/start').length, 1);
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
  // On Windows the owner's "ask" retries with a request-scoped unelevated override and lets the read-only thread go first.
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
    claude: { facts: () => [{ name: 'key', reason: { code: 'claude.no_key' } }] }, settings: { get: () => ({}) }, emit: row => events.push(row),
    resolveSpec: () => ({ terminalId: 't', projectId: 'p', owner: 'gui', cwd: root, env: { CODEX_HOME: root, PATH: '' } }) });
  t.after(() => router.close());
  await assert.rejects(router.start('t', { agent: 'codex' }), /Codex 未应用完全访问权限，已停止启动/);
  assert.match(events.find(row => row.type === 'error').payload.message, /未应用完全访问权限/);
});

test('/permissions reuses a valid probe per CLI home', { timeout: 15000 * timeoutScale }, async t => {
  const first = runtime(t, { spec: { permissions: 'ask' } }); await first.session.start();
  await first.session.runOptions({ permissions: 'full' }); await first.session.runOptions({ permissions: 'full' });
  const probes = () => first.server.wire.filter(row => row.method === 'thread/start' && row.params.ephemeral);
  assert.equal(probes().length, 1);
  assert.equal(first.server.wire.some(row => row.method === 'thread/unsubscribe'), false);
  const other = runtime(t, { spec: { permissions: 'ask', cwd: first.root } }); await other.session.start();
  await other.session.runOptions({ permissions: 'full' });
  assert.equal(other.server.wire.filter(row => row.method === 'thread/start' && row.params.ephemeral).length, 1, 'a second CLI home reads its own target');
  first.server.notify('thread/closed', { threadId: 'probe-1' });
  await first.session.runOptions({ permissions: 'full' });
  assert.equal(probes().length, 2, 'a provider-closed probe is no longer valid');
  first.server.child.kill();
  await assert.rejects(first.session.runOptions({ permissions: 'full' }), /连接已断开/, 'a disconnected process cannot reuse its old proof');
});

test('/permissions releases a late probe only after timeout', { timeout: 15000 * timeoutScale }, async t => {
  const valid = runtime(t, { server: codexServer({ announceProbe: false }), spec: { permissions: 'ask' } });
  await valid.session.start(); await valid.session.runOptions({ permissions: 'full' });
  valid.server.notify('thread/started', { thread: { id: 'probe-1', ephemeral: true } });
  assert.equal(valid.server.wire.some(row => row.method === 'thread/unsubscribe'), false, 'a late successful announcement keeps the reusable probe');
  const late = codexServer({ silentProbe: true, announceProbe: false });
  const lost = runtime(t, { server: late, spec: { permissions: 'ask', rpcTimeoutMs: 300 } }); await lost.session.start();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failure = assert.rejects(lost.session.runOptions({ permissions: 'full' }), /没有及时回应.*权限未更改/);
  await late.written(row => row.method === 'thread/start' && row.params.ephemeral);
  assert.equal(late.wire.some(row => row.method === 'thread/unsubscribe'), false);
  t.mock.timers.tick(300); await failure;
  late.notify('thread/started', { thread: { id: 'probe-1', ephemeral: true } });
  await late.written(row => row.method === 'thread/unsubscribe' && row.params.threadId === 'probe-1');
});

test('/permissions waits past stale notices before the reply', { timeout: 15000 * timeoutScale }, async t => {
  const clock = confirmationClock();
  // This stale partial notice would inherit the startup reviewer if confirmation used the merged snapshot.
  const noise = [['thread/settings/updated', { threadId: 'owner-thread', threadSettings: {
    sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never',
  } }], ['thread/settings/updated', { threadSettings: {
    sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never', approvalsReviewer: 'user',
  } }]];
  const f = runtime(t, { timers: clock.timers, server: codexServer({ noise, settle: () => null }), spec: { permissions: 'ask' } });
  await f.session.start();
  const failure = assert.rejects(f.session.runOptions({ permissions: 'full' }), /可能已经应用/);
  await clock.scheduled; clock.tick(8000); await failure;
  assert.equal((await f.session.runOptions({})).permissions, 'ask');
  const repeated = assert.rejects(f.session.runOptions({ permissions: 'full' }), /可能已经应用/);
  await Promise.race([repeated, f.server.written(row => row.method === 'thread/settings/update'
    && f.server.wire.filter(entry => entry.method === 'thread/settings/update').length === 2)]);
  clock.tick(8000); await repeated;
});

test('/permissions starts confirmation timing at the request write', { timeout: 15000 * timeoutScale }, async t => {
  const clock = confirmationClock();
  const server = codexServer({ onWrite(request) { if (request.method === 'thread/settings/update') clock.tick(1000); } });
  const f = runtime(t, { timers: clock.timers, server, spec: { permissions: 'ask', rpcTimeoutMs: 300 } }); await f.session.start();
  const changed = f.session.runOptions({ permissions: 'full' }), timer = await clock.scheduled;
  assert.equal(timer.at, 1300, 'the full confirmation interval follows the actual write');
  assert.equal((await changed).permissions, 'full'); assert.equal(clock.pending.size, 0);
});

test('/permissions missing approvalsReviewer reports may have been applied', { timeout: 15000 * timeoutScale }, async t => {
  for (const initialReviewer of [null, 'user']) {
    const clock = confirmationClock();
    const f = runtime(t, { timers: clock.timers, server: codexServer({ initialReviewer, reviewer: null }), spec: { permissions: 'ask' } });
    await f.session.start();
    const failure = assert.rejects(f.session.runOptions({ permissions: 'full' }), /可能已经应用.*\/status/);
    await clock.scheduled; clock.tick(8000); await failure;
    assert.equal((await f.session.runOptions({})).permissions, 'ask', 'neither an absent nor a retained old reviewer confirms this change');
    const repeated = assert.rejects(f.session.runOptions({ permissions: 'full' }), /可能已经应用/);
    await Promise.race([repeated, f.server.written(row => row.method === 'thread/settings/update'
      && f.server.wire.filter(entry => entry.method === 'thread/settings/update').length === 2)]);
    clock.tick(8000); await repeated;
    assert.equal((await f.session.runOptions({})).permissions, 'ask', 'a repeat cannot confirm from the merged partial snapshot');
  }
});

test('/permissions managed policy forbidding workspace-write reports a policy refusal', { timeout: 15000 * timeoutScale }, async t => {
  for (const method of ['thread/start', 'thread/settings/update']) {
    const reject = {}, server = codexServer({ reject }), f = runtime(t, { server, spec: { permissions: 'full' } });
    await f.session.start();
    reject[method] = { code: -32600, message: 'sandbox_mode workspace-write is not allowed by requirements.toml (allowed values: read-only); private policy text' };
    await assert.rejects(f.session.runOptions({ permissions: 'ask' }), error => error.code === 'permissions_policy_refused'
      && /托管策略不允许/.test(error.message) && !/private policy text|不支持在会话/.test(error.message));
    assert.equal((await f.session.runOptions({})).permissions, 'full');
  }
});

test('Codex 0.166 refuses /permissions through its unsupported-method path without changing the session', async t => {
  const f = runtime(t, { server: codexServer({ version: '0.166.0', reject: { 'thread/settings/update': -32601 } }), spec: { permissions: 'ask' } });
  await f.session.start();
  await assert.rejects(f.session.runOptions({ permissions: 'full' }), /这个版本的 Codex 不支持在会话中切换权限/);
  assert.equal((await f.session.runOptions({})).permissions, 'ask');
});

test('real permissions CI uses private Codex 0.167 while the minimum-version jobs keep 0.166', async () => {
  const { parseWorkflow } = await import('../scripts/ci-preflight-core.mjs');
  const workflow = parseWorkflow(fs.readFileSync(path.join(__dirname, '../.github/workflows/build-windows.yml'), 'utf8'));
  const step = workflow.jobs.windows.steps.find(row => row.run?.includes('node --test tests/codex-permissions-real-cli.test.cjs'));
  assert.ok(step, 'the release-gating Windows job runs the real permissions contract');
  assert.match(step.run, /--prefix "\$prefix".*@openai\/codex@0\.167\.0/);
  assert.match(step.run, /AGENTRIX_REAL_CODEX=/);
  assert.match(step.run, /node --test tests\/codex-permissions-real-cli\.test\.cjs/);
  assert.match(step.if, /build-only/);
  const minimum = Object.values(workflow.jobs).flatMap(job => job.steps || []).filter(row => row.name === 'Install Codex CLI for offline startup checks');
  assert.equal(minimum.length, 2);
  for (const install of minimum) assert.match(install.run, /@openai\/codex@0\.166\.0/);
});

test('/permissions changes the running session only, from its next turn, with what a new session of that choice would get', async t => {
  for (const kind of ['local', 'ssh']) {
    const mine = runtime(t, { kind, spec: { permissions: 'ask' } }), other = runtime(t, { kind, server: codexServer({ threadId: 'other-thread' }), spec: { permissions: 'ask' } });
    await mine.session.start(); await other.session.start();
    const changed = await mine.session.runOptions({ permissions: 'full' });
    assert.equal(changed.permissions, 'full');
    // The target is read from an ephemeral thread started exactly as a new "full" session would be, retained for the same request.
    const probe = mine.server.wire.find(row => row.method === 'thread/start' && row.params.ephemeral);
    assert.deepEqual(policyOf(probe.params), FULL, kind);
    assert.equal(mine.server.wire.some(row => row.method === 'thread/unsubscribe' && row.params.threadId === 'probe-1'), false);
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
    await assert.rejects(mine.session.runOptions({ permissions: 'full', fast: true }), { code: 'routing-owned' });
    assert.equal(mine.server.wire.filter(row => row.method === 'thread/settings/update').length, updates, 'the rejected patch also leaves permissions alone');
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
  // The probe never answers or announces itself until after its read gives up.
  const lost = codexServer({ silentProbe: true, announceProbe: false }), stuck = runtime(t, { server: lost, spec: { permissions: 'ask', rpcTimeoutMs: 300 } });
  await stuck.session.start();
  await assert.rejects(stuck.session.runOptions({ permissions: 'full' }), /Codex 没有及时回应，本会话权限未更改/);
  assert.equal(lost.wire.some(row => row.method === 'thread/unsubscribe'), false);
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
  const router = createRouter({ codex: factory, claude: { facts: () => [{ name: 'key', reason: { code: 'claude.no_key' } }] }, settings: { get: () => ({}) }, emit() {},
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
  const project = { id: 'p', kind, path: kind === 'ssh' ? '/srv/project' : path.resolve('project') };
  for (const stored of ['full', 'config', 'ask']) {
    const context = vm.createContext({ path, randomUUID: () => 'id', sessions: new Map(), findProject: () => project, disposeTerminal() {},
      store: { settings: { codexPermissions: stored }, findTerminal: () => ({ record: { restore: null } }) }, nativeSpecs: new Map(),
      runtimeDir: path.resolve('runtime'), eventServer: { name: 'pipe', address: '/socket' }, process: { platform: process.platform, env: {} },
      writeBootstrap() {}, createTerminalEnvironment: () => ({}), withoutAppImage: value => value, startupNote: () => 'context', READING_NOTE: 'reading',
      handoffFile: () => 'handoff', skills: { delivery() {} }, integrationDir: 'integration', controlAddress: 'control' });
    defineMain(context, 'nativeEnvironment', 'nativeSpec');
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
