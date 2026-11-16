require('./fixtures/team-isolation.cjs');
const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { createDispatchControl, connectDispatchControl } = require('../electron/features/agents/dispatch-control.cjs');
const { createInterventions } = require('../electron/features/agents/interventions.cjs');
const { projectTeam } = require('../electron/features/team/team.cjs');
const { run, locateCodex } = require('../integration/dispatch.cjs');

// The registration protocol over real Node streams, without opening a named pipe.
function registrationChannel() {
  const { Duplex } = require('node:stream'), { EventEmitter } = require('node:events');
  let accept;
  const net = {
    createServer(receive) {
      const server = new EventEmitter(); accept = receive;
      server.listen = (_address, ready) => queueMicrotask(ready); server.close = () => {};
      return server;
    },
    connect() {
      const socket = peer => new Duplex({ allowHalfOpen: false, read() {},
        write(chunk, _encoding, done) { peer().push(Buffer.from(chunk)); done(); },
        final(done) { peer().push(null); done(); },
        destroy(error, done) { if (!peer().destroyed) peer().destroy(); done(error); } });
      const client = socket(() => server), server = socket(() => client);
      server.setTimeout = () => {};
      queueMicrotask(() => { accept(server); client.emit('connect'); }); return client;
    },
  };
  const file = require.resolve('../electron/features/agents/dispatch-control.cjs'), load = require('node:module').createRequire(file), module = { exports: {} };
  require('node:vm').compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports', '__filename', '__dirname'])(
    name => name === 'node:net' ? net : load(name), module, module.exports, file, path.dirname(file));
  return { ...module.exports, net };
}

test('registration rejection reports the failed binding without exposing credentials', async t => {
  const { createDispatchControl, connectDispatchControl, net } = registrationChannel();
  const { resolveRegistration } = require('../electron/features/agents/dispatch-registration.cjs');
  const session = { sessionKey: 'synthetic-session-secret', controlCapability: 'synthetic-capability-secret', agent: 'claude' };
  const project = { id: 'project', path: os.tmpdir(), kind: 'local' };
  const worker = { id: 'admitted-worker', agent: 'claude', cwd: project.path, allow: ['src/**'], role: 'execution' };
  const deps = { sessions: new Map([['terminal', session]]), store: { findTerminal: () => ({ project }) },
    locateTeam: async (cwd, options) => {
      const team = { live: () => [worker] };
      return options?.details ? { status: 'found', common: cwd, team } : team;
    } };
  const channel = createDispatchControl({ resolveRun: registration => resolveRegistration(deps, registration) });
  const { address } = await channel.listen(); t.after(() => channel.close());
  const registration = { runId: worker.id, projectId: 'terminal', sessionKey: session.sessionKey, capability: session.controlCapability,
    cwd: worker.cwd, agent: worker.agent, allow: worker.allow, readOnly: false, roundtable: false };
  const client = await connectDispatchControl({ address, ...registration }); t.after(() => client.close());
  for (const [patch, code] of [
    [{ sessionKey: 'synthetic-stale-secret' }, 'dispatch.session_mismatch'],
    [{ capability: 'synthetic-wrong-secret' }, 'dispatch.control_unbound'],
    [{ runId: 'missing-worker' }, 'dispatch.unknown_run'],
    [{ cwd: path.join(project.path, 'synthetic-other-repository') }, 'dispatch.project_mismatch'],
    [{}, 'dispatch.duplicate_run'],
  ]) {
    await assert.rejects(connectDispatchControl({ address, ...registration, ...patch }), error => {
      assert.equal(error.message, 'control_unavailable'); assert.equal(error.stage, 'control_register'); assert.equal(error.category, code);
      assert.doesNotMatch(JSON.stringify(error), /synthetic-.*secret/); return true;
    });
    const wire = await new Promise((resolve, reject) => {
      const socket = net.connect(address); let received = '';
      socket.on('data', data => { received += data; }); socket.once('error', reject); socket.once('close', () => resolve(received));
      socket.once('connect', () => socket.write(JSON.stringify({ v: 1, type: 'register', ...registration, ...patch }) + '\n'));
    });
    assert.deepEqual(JSON.parse(wire), { v: 1, type: 'refused', runId: patch.runId || registration.runId, code,
      ...(!Object.hasOwn(patch, 'sessionKey') && !Object.hasOwn(patch, 'capability') ? { leadMode: 'terminal' } : {}) });
    assert.doesNotMatch(wire, /synthetic-.*secret/);
    assert.equal(client.connected, true, 'a refused duplicate never replaces the admitted client');
  }
});

test('the register frame carries the worker declaration and never accepts its claimed lead mode', async t => {
  const { createDispatchControl, connectDispatchControl } = registrationChannel();
  const { resolveRegistration } = require('../electron/features/agents/dispatch-registration.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-control-outside-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'worker'), project = { id: 'project', kind: 'local', path: path.join(root, 'project') };
  fs.mkdirSync(cwd); fs.mkdirSync(project.path);
  const session = { agent: 'claude', nativeStructured: true,
    sessionKey: 'synthetic-session', controlCapability: 'synthetic-control' };
  const channel = createDispatchControl({ resolveRun: registration => resolveRegistration({ sessions: new Map([['terminal', session]]),
    store: { findTerminal: () => ({ project }) }, locateTeam: async () => ({ status: 'outside_git', common: null, team: null }) }, registration) });
  const { address } = await channel.listen(); t.after(() => channel.close());
  const client = await connectDispatchControl({ address, runId: 'boardless-worker', projectId: 'terminal', sessionKey: session.sessionKey,
    capability: session.controlCapability, cwd, agent: 'claude', allow: ['docs/**'], readOnly: true, leadMode: 'terminal' });
  t.after(() => client.close());
  let binding;
  channel.onRequest('inspect', run => { binding = run; });
  await client.request('inspect', {});
  assert.equal(binding.leadMode, 'native'); assert.equal(binding.agent, 'claude'); assert.equal(binding.cwd, cwd);
  assert.deepEqual(binding.allow, ['docs/**']); assert.equal(binding.readOnly, true);
  assert.equal(binding.sessionKey, undefined); assert.equal(binding.capability, undefined);
});

test('authenticated refusals carry the lead mode on the wire and client error; failed authentication carries none', async t => {
  const { createDispatchControl, connectDispatchControl, net } = registrationChannel();
  const { resolveRegistration } = require('../electron/features/agents/dispatch-registration.cjs');
  for (const leadMode of ['native', 'terminal', 'codex']) {
    const session = { agent: leadMode === 'codex' ? 'codex' : 'claude', nativeStructured: leadMode === 'native',
      sessionKey: 'synthetic-session-secret', controlCapability: 'synthetic-control-secret' };
    const project = { id: 'project', kind: 'local', path: os.tmpdir() }, worker = { id: 'worker', agent: 'claude', cwd: os.tmpdir(), allow: ['src/**'] };
    const channel = createDispatchControl({ resolveRun: registration => resolveRegistration({ sessions: new Map([['terminal', session]]),
      store: { findTerminal: () => ({ project }) }, locateTeam: async cwd => ({ status: cwd.endsWith('git-error') ? 'git_error' : 'found', common: cwd,
        team: { live: () => [worker] } }) }, registration) });
    const { address } = await channel.listen(); t.after(() => channel.close());
    const registration = { runId: worker.id, projectId: 'terminal', sessionKey: session.sessionKey, capability: session.controlCapability,
      cwd: worker.cwd, agent: worker.agent, allow: worker.allow, readOnly: false, roundtable: false, leadMode: 'forged' };
    const client = await connectDispatchControl({ address, ...registration }); t.after(() => client.close());
    for (const [patch, code, authenticated] of [
      [{ sessionKey: 'stale' }, 'dispatch.session_mismatch', false],
      [{ capability: 'wrong' }, 'dispatch.control_unbound', false],
      [{ runId: 'missing-worker' }, 'dispatch.unknown_run', true],
      [{ cwd: path.join(project.path, 'other-repository') }, 'dispatch.project_mismatch', true],
      [{ cwd: path.join(project.path, 'git-error') }, 'dispatch.project_mismatch', true],
      [{ allow: ['../outside/**'] }, 'dispatch.control_unbound', true],
      [{}, 'dispatch.duplicate_run', true],
    ]) {
      await assert.rejects(connectDispatchControl({ address, ...registration, ...patch }), error => {
        assert.equal(error.category, code); assert.equal(error.leadMode, authenticated ? leadMode : undefined);
        assert.doesNotMatch(JSON.stringify(error), /synthetic-.*secret|forged/); return true;
      });
      const wire = await new Promise((resolve, reject) => {
        const socket = net.connect(address); let received = '';
        socket.on('data', data => { received += data; }); socket.once('error', reject); socket.once('close', () => resolve(received));
        socket.once('connect', () => socket.write(JSON.stringify({ v: 1, type: 'register', ...registration, ...patch }) + '\n'));
      });
      assert.deepEqual(JSON.parse(wire), { v: 1, type: 'refused', runId: patch.runId || worker.id, code, ...(authenticated ? { leadMode } : {}) });
      assert.doesNotMatch(wire, /synthetic-.*secret|forged/);
    }
  }
});

test('persistent channel authenticates a binding, streams events and deduplicates control receipts', async t => {
  const id = randomUUID(), controls = [];
  const run = { runId: id, projectId: 'p', cwd: os.tmpdir(), worktree: os.tmpdir(), allow: [], readOnly: false, roundtable: false };
  const control = createDispatchControl({ resolveRun: input => input.sessionKey === 'synthetic-key' && input.runId === id ? run : null });
  const { address } = await control.listen(); t.after(() => control.close());
  await assert.rejects(connectDispatchControl({ address, runId: id, projectId: 'p', sessionKey: 'wrong' }));
  const events = [], client = await connectDispatchControl({ address, runId: id, projectId: 'p', sessionKey: 'synthetic-key',
    onEvent: event => events.push(event), onControl: messageId => { controls.push(messageId); return 'delivered'; } });
  t.after(() => client.close());
  control.onRequest('synthetic.run', async (binding, payload, stream) => {
    assert.deepEqual(binding, run); assert.deepEqual(payload, { text: 'brief' }); stream.emit({ type: 'test-event' });
  });
  await client.request('synthetic.run', { text: 'brief' }); assert.equal(events.length, 1);
  const message = { messageId: randomUUID(), type: 'intervene', text: 'hello' };
  const [a, b] = await Promise.all([control.pushControl(id, message), control.pushControl(id, message)]);
  assert.deepEqual(a, b); assert.equal(a.status, 'delivered'); assert.equal(controls.length, 1);
  await assert.rejects(control.pushControl(id, { ...message, text: 'conflict' }), /conflict/);
});

test('broker forwards later controls to the registered provider handler without an SDK in the helper', async t => {
  const id = randomUUID(), run = { runId: id, projectId: 'p', cwd: os.tmpdir(), allow: [], agent: 'claude' };
  const control = createDispatchControl({ resolveRun: () => run });
  const { address } = await control.listen(); t.after(() => control.close());
  let ready, finish;
  t.after(() => finish?.());
  const waiting = new Promise(resolve => { ready = resolve; });
  control.onRequest('claude-sdk.run', async (_run, _payload, stream) => {
    stream.onControl(input => { assert.equal(input.text, 'change'); return { status: 'delivered' }; }); ready();
    await new Promise(resolve => { finish = resolve; });
  });
  const client = await connectDispatchControl({ address, runId: id, projectId: 'p' }); t.after(() => client.close());
  const result = client.request('claude-sdk.run', {}); await waiting;
  assert.deepEqual(await client.request('control.deliver', { messageId: randomUUID(), type: 'intervene', text: 'change' }), { status: 'delivered' });
  finish(); await result;
});

test('a registration main verifies within 2 s succeeds: neither the helper wait nor the channel idle limit cuts it short', async t => {
  const id = randomUUID(), control = createDispatchControl({ resolveRun: async () => {
    await new Promise(resolve => setTimeout(resolve, 1700));
    return { runId: id, projectId: 'p', cwd: os.tmpdir(), allow: [], agent: 'codex' };
  } });
  const { address } = await control.listen(); t.after(() => control.close());
  const client = await connectDispatchControl({ address, runId: id, projectId: 'p' }); t.after(() => client.close());
  assert.equal(client.connected, true);
});

test('a disconnected in-flight push reports unknown and never resends automatically', async t => {
  const id = randomUUID(), control = createDispatchControl({ resolveRun: () => ({ runId: id, projectId: 'p', cwd: os.tmpdir(), allow: [] }) });
  const { address } = await control.listen(); t.after(() => control.close());
  let client;
  client = await connectDispatchControl({ address, runId: id, projectId: 'p', onControl: () => { client.close(); return 'delivered'; } });
  const message = { messageId: randomUUID(), type: 'stop' };
  assert.equal((await control.pushControl(id, message)).status, 'unknown');
  assert.equal((await control.pushControl(id, message)).status, 'unknown');
});

test('registration may tighten plan mode but cannot loosen the main-owned read-only binding', async t => {
  const control = createDispatchControl({ resolveRun: auth => ({ runId: auth.runId, projectId: 'p', cwd: os.tmpdir(), allow: [], readOnly: auth.runId === 'trusted-read-only', roundtable: false }) });
  const { address } = await control.listen(); t.after(() => control.close());
  control.onRequest('mode', async (run, _payload, stream) => stream.emit({ readOnly: run.readOnly }));
  for (const [runId, readOnly] of [['client-plan', true], ['trusted-read-only', false]]) {
    const events = [], client = await connectDispatchControl({ address, runId, projectId: 'p', readOnly, onEvent: event => events.push(event) });
    try { await client.request('mode', {}); assert.equal(events[0].readOnly, true); }
    finally { client.close(); }
  }
});

test('M9: SDK execution is limited to one request on its verified Claude run binding', async t => {
  const control = createDispatchControl({ resolveRun: auth => ({ runId: auth.runId, projectId: 'p', cwd: os.tmpdir(), allow: [], agent: auth.runId === 'claude-run' ? 'claude' : 'codex' }) });
  const { address } = await control.listen(); t.after(() => control.close());
  let requests = 0;
  control.onRequest('claude-sdk.run', async () => { requests++; });
  for (const runId of ['claude-run', 'codex-run']) {
    const client = await connectDispatchControl({ address, runId, projectId: 'p', agent: 'claude' });
    try {
      if (runId === 'claude-run') await client.request('claude-sdk.run', {});
      await assert.rejects(client.request('claude-sdk.run', { runId: 'claude-run' }), /run_binding_rejected/);
    } finally { client.close(); }
  }
  assert.equal(requests, 1);
});

for (const action of ['intervene', 'stop', 'npm']) test(`helper delivers ${action} to a fake app-server before its turn ends`, { timeout: 15000, skip: action === 'npm' && process.platform !== 'win32' }, async t => {
  const lifetime = resources(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agx-native-dispatch-'))), repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  const team = projectTeam(repo, true), bootstrap = path.join(root, 'bootstrap.json'), brief = path.join(root, 'brief.md'), out = path.join(root, 'answer.md');
  fs.writeFileSync(brief, 'Synthetic task');
  const bin = path.join(root, 'bin');
  if (action === 'npm') {
    // A global npm prefix as npm 10 and 11 lay it out (tests/fixtures/real-cli/codex-layouts.json): a shim that would
    // fail if it ran, and the nested platform package's codex.exe, an offline stand-in that serves the fake app-server.
    const vendor = path.join(bin, 'node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin');
    fs.mkdirSync(vendor, { recursive: true });
    fs.writeFileSync(path.join(bin, 'codex.cmd'), '@exit /b 99');
    await (await import('../scripts/gui-codex-env.mjs')).windowsCodexStandIn(vendor);
  }
  const control = createDispatchControl({ resolveRun: auth => auth.sessionKey === 'synthetic-key' && team.live().some(x => x.id === auth.runId)
    ? { runId: auth.runId, projectId: 'p', cwd: repo, worktree: repo, allow: [], readOnly: false, roundtable: false } : null });
  const { address } = await control.listen();
  lifetime.defer('close control', () => control.close());
  fs.writeFileSync(bootstrap, JSON.stringify({ pipeName: address + '-unused', controlAddress: address, controlCapability: 'synthetic-capability', projectId: 'p', sessionKey: 'synthetic-key' }));
  let stdout = '', finished = false;
  const result = run(['codex', '--role', 'exec', '--title', 'Synthetic native', '--model', 'synthetic-model', '--effort', 'high', '--fast',
    '--cwd', repo, '--brief', brief, '--out', out, '--allow', 'src/**', '--skip-meeting', 'Synthetic native fixture'], {
    env: { PATH: action === 'npm' ? bin : '', CODEX_HOME: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      AGENTRIX_BOOTSTRAP: bootstrap, AGENTRIX_SDK_PARENT: '1', ANTHROPIC_API_KEY: 'synthetic-injected',
      SYNTHETIC_CODEX_MODE: action === 'npm' ? 'normal' : 'worker',
      ...(action === 'npm' ? { AGENTRIX_FAKE_NODE: process.execPath, AGENTRIX_GUI_CODEX_RPC: path.join(__dirname, 'fixtures/codex-app-server.cjs') } : {}) },
    stdout: { write: text => { stdout += text; } },
    // The npm case searches the fake bin with the real locator, by name; the others inject their resolver.
    locate: locateCodex,
    ...(action === 'npm' ? {} : { resolveExecutable: (_agent, args) => ({ file: process.execPath, args: [path.join(__dirname, 'fixtures/codex-app-server.cjs'), ...args] }) }),
    launch: (file, args, options) => lifetime.child(spawn(file, args, options)),
  }).finally(() => { finished = true; });
  lifetime.defer('finish Codex helper', async () => {
    if (!finished) for (const worker of team.live()) await team.queueControl(worker.id, { id: randomUUID(), type: 'stop', at: Date.now(), noResume: true }).catch(() => {});
    await result;
  });
  t.after(async () => { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  for (let n = 0; !stdout.includes('[dispatch] started') && n < 400 && !finished; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(stdout, /\[dispatch\] started/);
  if (action === 'npm') {
    assert.equal(await result, 0); assert.doesNotMatch(stdout, /fallback/);
    assert.equal(fs.readFileSync(out, 'utf8'), 'final answer'); return;
  }
  const id = /\[dispatch\] started ([\w-]+)/.exec(stdout)[1];
  const api = createInterventions({ resolve: () => ({ terminalId: 't', callId: `dispatch:${id}`, parentSessionId: 'planner', confirmed: true,
    route: 'dispatch', runId: id, title: 'Synthetic native', cwd: repo, projectPath: repo, local: true }),
    sendParentPrompt: () => assert.fail('planner paste'), pushControl: control.pushControl });
  const receipt = action === 'intervene' ? await api.interveneAgent('t', `dispatch:${id}`, 'Owner correction') : await api.stopAgent('t', `dispatch:${id}`);
  assert.ok((action === 'intervene' ? ['delivered', 'consumed'] : ['delivered']).includes(receipt.status));
  assert.equal(await result, action === 'intervene' ? 0 : 1);
  if (action === 'intervene') assert.equal(fs.readFileSync(out, 'utf8'), 'Owner correction');
  assert.match(stdout, /intervention .* (?:delivered|consumed)/); assert.doesNotMatch(stdout, /fallback|resume failed/);
  assert.match(fs.readFileSync(team.memory, 'utf8'), /\[dispatch\] intervention .* (?:delivered|consumed)/);
});
