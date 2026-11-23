const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { occupyHookPipe, powershell } = require('./fixtures/busy-hook-pipe.cjs');
const { dispatchEnvironment } = require('./fixtures/team-isolation.cjs');

const integration = path.join(__dirname, '../integration');
const helper = path.join(integration, 'agent-event.cjs');
const windowsPipe = '\\\\.\\pipe\\';
const permissionInput = { hook_event_name: 'PermissionRequest', session_id: 'worker', tool_name: 'Bash', tool_input: { command: 'node --test' } };
const importSource = source => 'data:text/javascript,' + encodeURIComponent(source);
const env = () => ({ ...dispatchEnvironment(), NODE_OPTIONS: '' });

function runHook(t, file, args, { hookEnv = env(), timeout = 2200, input = permissionInput } = {}) {
  const started = performance.now();
  const child = spawnSync(file, args, { env: hookEnv, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout });
  t.diagnostic(path.basename(file) + ' finished in ' + Math.round(performance.now() - started) + ' ms');
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}

function assertDeny(decision) {
  const output = JSON.parse(decision).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PermissionRequest');
  assert.equal(output.decision.behavior, 'deny');
  assert.equal(output.decision.interrupt, false);
}

function bridgeArgs(name) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(integration, 'claude-hook.ps1'),
    '-PipeName', name, '-ProjectId', 'project', '-SessionKey', 'session', '-Kind', 'worker-permission', '-NodePath', process.execPath];
}

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
    if (endpoint === 'busy') {
      const input = { hook_event_name: 'Stop', session_id: 'worker' };
      assert.equal(runHook(t, process.execPath, [helper, 'claude-hook', address, 'project', 'session', 'stop'], { input }), '');
    }
  });
}

test('the Windows bridge forwards the decision with the child still holding stdout open', { skip: !powershell }, t => {
  const linger = importSource(`const { port1, port2 } = new MessageChannel();
port1.on('message', () => {});
process.exit = () => {};
// Release the child even if a broken bridge fails to kill it.
AbortSignal.timeout(4500).addEventListener('abort', () => { port1.close(); port2.close(); });`);
  const hookEnv = { ...env(), NODE_OPTIONS: '--import=' + linger };
  const stdout = runHook(t, powershell, bridgeArgs('agentrix-' + randomUUID()), { hookEnv, timeout: 2500 });
  assertDeny(stdout);
});
