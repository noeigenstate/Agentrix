const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { createEventServer } = require('../electron/events.cjs');
const { terminalHooks } = require('../electron/features/terminal-events/hook-channel.cjs');
const { occupyHookPipe, powershell } = require('./fixtures/busy-hook-pipe.cjs');
const { dispatchEnvironment } = require('./fixtures/team-isolation.cjs');
const { loadWithStubs } = require('./helpers/load-with-stubs.cjs');

const integration = path.join(__dirname, '../integration');
const helper = path.join(integration, 'agent-event.cjs');
const windowsPipe = '\\\\.\\pipe\\';
const permissionInput = { hook_event_name: 'PermissionRequest', session_id: 'worker', tool_name: 'Bash', tool_input: { command: 'node --test' } };
const importSource = source => 'data:text/javascript,' + encodeURIComponent(source);
const env = () => ({ ...dispatchEnvironment(), NODE_OPTIONS: '' });

test('the shell launch event allows the host to finish its note after the ordinary event deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets = [];
  const { send } = loadWithStubs(helper, (name, load) => name === 'node:net' ? { connect() {
    const socket = new EventEmitter();
    socket.ends = [];
    socket.end = data => socket.ends.push(JSON.parse(data));
    socket.destroyed = false;
    socket.destroy = () => { socket.destroyed = true; };
    sockets.push(socket);
    return socket;
  } } : load(name));
  const events = [{ type: 'agent-started' }, { type: 'shell-prompt' }];
  const sent = events.map(event => send('fixture', event));
  for (const socket of sockets) socket.emit('connect');
  t.mock.timers.tick(750);
  assert.deepEqual(sockets.map(socket => [socket.destroyed, ...socket.ends]), [[false, events[0]], [true, events[1]]]);
  sockets[0].emit('close');
  await Promise.all(sent);
  assert.equal(sockets[0].destroyed, true);
});

test('the Windows seat bridge publishes the observation as well as the decision', { skip: !powershell, timeout: 30000 }, async t => {
  const events = new EventEmitter();
  const receiver = await createEventServer(event => events.emit('report', event));
  t.after(() => receiver.close());
  const report = once(events, 'report', { signal: t.signal });
  const input = { hook_event_name: 'PreToolUse', session_id: 'fixture', tool_name: 'Agent', tool_use_id: 'tool-fixture',
    tool_input: { description: '[designer] Design the layout', prompt: 'Use a grid' } };
  const bridge = spawn(powershell, bridgeArgs(receiver.name, 'seat-routing'), { windowsHide: true,
    env: { ...env(), AGENTRIX_SEATS: JSON.stringify({ designer: { model: 'sonnet', effort: 'high' } }) }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => { if (bridge.exitCode === null) bridge.kill(); });
  const output = createInterface({ input: bridge.stdout });
  t.after(() => output.close());
  const stdout = once(output, 'line', { signal: t.signal });
  bridge.stdin.end(JSON.stringify(input));
  const [[line], [event]] = await Promise.all([stdout, report]);
  assert.equal(JSON.parse(line).hookSpecificOutput.updatedInput.model, 'sonnet');
  assert.deepEqual([event.type, event.phase, event.toolUseId, event.model], ['claude-seat-input', 'pre', 'tool-fixture', 'sonnet']);
});

// A loaded runner can take seconds to start PowerShell at all, so the bound is the measured startup plus the allowance:
// it still catches a hook that lingers on a dead pipe, which costs five seconds or more.
const scale = Math.max(1, Number(process.env.AGENTRIX_TEST_TIMEOUT_SCALE) || 1), startups = new Map();
function startup(file) {
  if (!startups.has(file)) {
    const started = performance.now();
    spawnSync(file, file === process.execPath ? ['-e', '0'] : ['-NoLogo', '-NoProfile', '-Command', 'exit'], { windowsHide: true, timeout: 120000 });
    startups.set(file, performance.now() - started);
  }
  return startups.get(file);
}

function runHook(t, file, args, { hookEnv = env(), timeout = 2200, input = permissionInput, checkStderr, encoding = 'utf8' } = {}) {
  const allowed = Math.ceil(timeout * scale + 2 * startup(file) + startup(process.execPath));
  const started = performance.now();
  const child = spawnSync(file, args, { env: hookEnv, input: Buffer.from(JSON.stringify(input)), encoding, windowsHide: true, timeout: allowed });
  t.diagnostic(path.basename(file) + ' finished in ' + Math.round(performance.now() - started) + ' ms');
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  checkStderr?.(child.stderr);
  return child.stdout;
}

function assertDeny(decision) {
  const output = JSON.parse(decision).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PermissionRequest');
  assert.equal(output.decision.behavior, 'deny');
  assert.equal(output.decision.interrupt, false);
}

function bridgeArgs(name, kind = 'worker-permission') {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(integration, 'claude-hook.ps1'),
    '-PipeName', name, '-ProjectId', 'project', '-SessionKey', 'session', '-Kind', kind, '-NodePath', process.execPath];
}

test('the Windows worker permission hook registered on either channel answers without a launch note', { skip: !powershell }, t => {
  const name = 'agentrix-' + randomUUID();
  const { settings } = terminalHooks({ port: 4242, terminalId: 'project', sessionKey: 'session', eventServer: { name }, env: {},
    cwd: integration, shell: { posix: false, powershellPath: powershell, script: path.join(integration, 'claude-hook.ps1'), node: process.execPath },
    read: () => '{}', workerPermission: true });
  const hookEnv = env();
  delete hookEnv.AGENTRIX_READING_NOTE_FILE;
  for (const channel of ['http', 'fallback']) {
    const [entry] = JSON.parse(settings[channel]).hooks.PermissionRequest;
    const [hook] = entry.hooks;
    assert.equal(hook.type, 'command');
    assert.equal(hook.async, undefined);
    const command = hook.shell === 'powershell' ? hook.command : '& ' + hook.command;
    const args = ['-NoProfile', '-NonInteractive', '-Command', command];
    assertDeny(runHook(t, powershell, args, { hookEnv, timeout: 3500, checkStderr: stderr => assert.equal(stderr, '') }));
  }
});

test('the worker permission decision reaches stdout before a stalled event connection', t => {
  // One stdout pipe records the order. The stand-in never connects, errors or closes.
  const stall = `import net from 'node:net';
import { EventEmitter } from 'node:events';
net.connect = () => {
  process.stdout.write('event connection started\\n');
  new MessageChannel().port1.on('message', () => {});
  return Object.assign(new EventEmitter(), { destroy() {}, setTimeout() {} });
};`;
  const stdout = runHook(t, process.execPath, ['--import', importSource(stall), helper, 'claude-hook', 'unresponsive', 'project', 'session', 'worker-permission']);
  const [decision, connection] = stdout.trimEnd().split('\n');
  assert.equal(connection, 'event connection started');
  assertDeny(decision);
});

for (const endpoint of ['absent', 'busy']) {
  test('worker permission prints a deny and exits with the event endpoint ' + endpoint, { skip: endpoint === 'busy' && !powershell }, async t => {
    const name = 'agentrix-' + randomUUID();
    if (endpoint === 'busy') await occupyHookPipe(t, name, env());
    const address = powershell ? windowsPipe + name : path.join(os.tmpdir(), name + '.sock');
    assertDeny(runHook(t, process.execPath, [helper, 'claude-hook', address, 'project', 'session', 'worker-permission']));
    if (powershell) assertDeny(runHook(t, powershell, bridgeArgs(name), { timeout: 2500 }));
    for (const [kind, hook_event_name] of [['start', 'UserPromptSubmit'], ['progress', 'PreToolUse'], ['notify', 'Notification']]) {
      const input = { hook_event_name, session_id: 'worker', notification_type: 'permission_prompt' };
      assert.equal(runHook(t, process.execPath, [helper, 'claude-hook', address, 'project', 'session', kind], { input }), '');
      if (powershell) assert.equal(runHook(t, powershell, bridgeArgs(name, kind), { input }), '');
    }
  });
}

test('the PowerShell status hook exits when the event endpoint accepts but does not read', { skip: !powershell }, async t => {
  const name = 'agentrix-' + randomUUID();
  await occupyHookPipe(t, name, env(), { stallWrite: true });
  // Exceed the pipe buffer to ensure the write waits for the receiver.
  const input = { hook_event_name: 'PreToolUse', session_id: 'worker', transcript_path: 'x'.repeat(128 * 1024) };
  const stdout = runHook(t, powershell, bridgeArgs(name, 'progress'), {
    input, hookEnv: { ...env(), AGENTRIX_HOOK_TRACE: '1' }, checkStderr: stderr => assert.match(stderr, /powershell progress pipe-write/),
  });
  assert.equal(stdout, '');
});

test('the PowerShell bridge preserves seat-routing stdout byte for byte', { skip: !powershell }, t => {
  const name = 'agentrix-' + randomUUID();
  const input = { hook_event_name: 'PreToolUse', session_id: 'worker', tool_name: 'Agent',
    tool_input: { description: '[designer] Design the layout', prompt: 'Use a grid \u7f51\u683c' } };
  const hookEnv = { ...env(), AGENTRIX_SEATS: JSON.stringify({ designer: { model: 'sonnet', effort: 'high' } }) };
  const options = { input, hookEnv, encoding: 'buffer' };
  const expected = runHook(t, process.execPath, [helper, 'claude-hook', windowsPipe + name, 'project', 'session', 'seat-routing'], options);
  const { updatedInput } = JSON.parse(expected).hookSpecificOutput;
  assert.equal(updatedInput.model, 'sonnet');
  assert.equal(updatedInput.prompt, input.tool_input.prompt);
  assert.deepEqual(runHook(t, powershell, bridgeArgs(name, 'seat-routing'), options), expected);
});

test('the Windows bridge forwards the decision with the child still holding stdout open', { skip: !powershell }, t => {
  const linger = importSource(`if (process.argv.includes('worker-permission')) {
  const { port1, port2 } = new MessageChannel();
  port1.on('message', () => {});
  process.exit = () => {};
  const write = process.stdout.write;
  process.stdout.write = function (...args) {
    setTimeout(() => process.stderr.write('decision child still alive'), 500);
    return write.apply(this, args);
  };
  // Release the child even if a broken bridge fails to kill it.
  AbortSignal.timeout(4500).addEventListener('abort', () => { port1.close(); port2.close(); });
}`);
  const hookEnv = { ...env(), NODE_OPTIONS: '--import=' + linger };
  const stdout = runHook(t, powershell, bridgeArgs('agentrix-' + randomUUID()), {
    hookEnv, timeout: 2500, checkStderr: stderr => assert.doesNotMatch(stderr, /decision child still alive/),
  });
  assertDeny(stdout);
});

test('the Windows refusal reporter can start reporting after the bridge exits', { skip: !powershell, timeout: 30000 }, async t => {
  const bridgeExited = Promise.withResolvers();
  const gate = net.createServer(socket => bridgeExited.promise.then(() => socket.end()));
  gate.listen(0, '127.0.0.1');
  await once(gate, 'listening');
  t.after(() => gate.close());
  const events = new EventEmitter();
  const receiver = await createEventServer(event => events.emit('report', event));
  t.after(() => receiver.close());
  const preload = importSource(`import net from 'node:net';
import { once } from 'node:events';
if (process.argv[2] === 'worker-report') {
  const gate = net.connect(${gate.address().port}, '127.0.0.1');
  gate.resume();
  await once(gate, 'end');
}`);
  const options = { signal: t.signal };
  const reported = once(events, 'report', options);
  // Process exit can be observed even if an inherited handle is still holding a pipe open.
  const bridge = spawn(powershell, bridgeArgs(receiver.name), { windowsHide: true,
    env: { ...env(), NODE_OPTIONS: '--import=' + preload }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => { bridgeExited.resolve(); if (bridge.exitCode === null) bridge.kill(); });
  const exited = once(bridge, 'exit', options);
  const lines = createInterface({ input: bridge.stdout });
  t.after(() => lines.close());
  const output = once(lines, 'line', options);
  bridge.stdin.end(JSON.stringify(permissionInput));
  const [[code], [decision], [report]] = await Promise.all([
    exited.then(result => { bridgeExited.resolve(); return result; }), output, reported,
  ]);
  assert.equal(code, 0);
  assertDeny(decision);
  assert.equal(report.hookEvent, 'PermissionRequest');
  assert.match(report.workerRefused, /^Bash: /);
});
