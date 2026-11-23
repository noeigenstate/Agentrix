const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('the worker permission decision reaches stdout before a stalled event connection', () => {
  // One stdout pipe records the order. The stand-in never connects, errors or closes.
  const stall = `import net from 'node:net';
import { EventEmitter } from 'node:events';
net.connect = () => {
  process.stdout.write('event connection started\\n');
  return Object.assign(new EventEmitter(), { destroy() {}, setTimeout() {} });
};`;
  const input = { hook_event_name: 'PermissionRequest', session_id: 'worker', tool_name: 'Bash', tool_input: { command: 'node --test' } };
  const child = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(stall),
    path.join(__dirname, '../integration/agent-event.cjs'), 'claude-hook', 'unresponsive', 'project', 'session', 'worker-permission'],
  { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 8000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const [decision, connection] = child.stdout.trimEnd().split('\n');
  assert.equal(connection, 'event connection started');
  const output = JSON.parse(decision).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PermissionRequest');
  assert.equal(output.decision.behavior, 'deny');
  assert.equal(output.decision.interrupt, false);
});
