const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { claudeEvent } = require('../integration/agent-event.cjs');
const { createEventServer } = require('../electron/events.cjs');
const { terminalHooks } = require('../electron/features/terminal-events/hook-channel.cjs');

const hooks = { PreToolUse: 'progress', PostToolUse: 'progress', PostToolUseFailure: 'progress', PermissionDenied: 'progress', ElicitationResult: 'progress', PermissionRequest: 'permission', Elicitation: 'permission' };
// Claude 2.1.317 permission/elicitation inputs do not identify a tool-use request.
const payload = hookEvent => ({ session_id: 'provider', hook_event_name: hookEvent,
  ...(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(hookEvent) ? { tool_use_id: 'tool' } : {}),
  tool_name: 'Read', tool_input: { file_path: 'fixture.txt' }, permission_suggestions: [], prompt: 'not a submission' });
for (const [hookEvent, kind] of Object.entries(hooks)) test(hookEvent + ' is silent observational state, never a submitted prompt', () => {
  const event = claudeEvent(JSON.stringify(payload(hookEvent)), 'terminal', 'capability', kind);
  assert.equal(event.state, kind === 'progress' ? 'progress' : 'attention'); assert.equal(event.prompt, null);
  assert.equal(event.hookEvent, hookEvent); assert.equal(event.requestId, payload(hookEvent).tool_use_id); assert.equal(event.turnId, undefined); assert.ok(Number.isFinite(event.sentAt));
});

test('Bash, zsh and PowerShell register matching observation hooks', () => {
  // One generator writes every wrapper's settings; the command fallback keeps these kinds in every shell.
  const shells = { powershell: { posix: false, powershellPath: 'C:\Windows\powershell.exe', script: 'C:\agentrix\claude-hook.ps1' },
    posix: { posix: true, node: '/agentrix/node', helper: '/agentrix/agent-event.cjs' } };
  for (const [name, shell] of Object.entries(shells)) {
    const { settings } = terminalHooks({ port: 1, terminalId: 'terminal', sessionKey: 'capability', eventServer: { name: 'pipe', address: '/socket' }, env: {}, cwd: '/project',
      shell, platform: 'linux', home: '/home', read: () => '{}' });
    const fallback = JSON.parse(settings.fallback).hooks;
    for (const [event, kind] of Object.entries(hooks)) {
      const hook = fallback[event][0].hooks[0];
      assert.ok(hook.command.endsWith(name === 'posix' ? ` ${kind}` : ` -Kind ${kind}`), name + ': ' + event);
      assert.equal(hook.async === true, kind === 'progress', name + ': ' + event + ' async');
    }
  }
});

test('a StopFailure has its command hook in every shell and reports a failed turn, never a completed one', () => {
  const input = JSON.stringify({ session_id: 'provider', hook_event_name: 'StopFailure', prompt_id: 'p1', error: 'unknown', last_assistant_message: 'API Error: 400' });
  const event = claudeEvent(input, 'terminal', 'capability', 'stop-failed');
  assert.equal(event.state, 'failed'); assert.equal(event.hookEvent, 'StopFailure'); assert.equal(event.prompt, null); assert.equal(event.message, null);
  for (const shell of [{ posix: false, powershellPath: 'C:\\Windows\\powershell.exe', script: 'C:\\agentrix\\claude-hook.ps1' }, { posix: true, node: '/agentrix/node', helper: '/agentrix/agent-event.cjs' }]) {
    for (const platform of ['linux', 'win32']) {
      const { settings } = terminalHooks({ port: 1, terminalId: 'terminal', sessionKey: 'capability', eventServer: { name: 'pipe', address: '/socket' }, env: {}, cwd: '/project',
        shell, platform, home: '/home', read: () => '{}' });
      const [hook] = JSON.parse(settings.fallback).hooks.StopFailure[0].hooks;
      assert.ok(hook.command.endsWith(shell.posix ? ' stop-failed' : ' -Kind stop-failed'), hook.command);
      assert.equal(hook.async, undefined, `${platform}: K0b never proved StopFailure async`);
    }
  }
});

test('PowerShell and Node emit equivalent progress, permission and StopFailure fields without output', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const events = [], server = await createEventServer(event => events.push(event)); t.after(() => server.close());
  const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const commandEvents = { ...hooks, StopFailure: 'stop-failed' };
  for (const [hookEvent, kind] of Object.entries(commandEvents)) {
    const input = { ...payload(hookEvent), source: 'compact' };
    const result = await new Promise((resolve, reject) => {
      const child = spawn(executable, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../integration/claude-hook.ps1'), '-PipeName', server.name, '-ProjectId', 'terminal', '-SessionKey', 'capability', '-Kind', kind], { windowsHide: true });
      let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      child.on('error', reject); child.on('close', code => resolve({ code, output })); child.stdin.end(JSON.stringify(input));
    });
    assert.deepEqual(result, { code: 0, output: '' });
    const event = events.at(-1), expected = claudeEvent(JSON.stringify(input), 'terminal', 'capability', kind);
    assert.equal(events.length, Object.keys(commandEvents).indexOf(hookEvent) + 1);
    for (const key of Object.keys(expected).filter(key => !['eventId', 'sentAt'].includes(key))) assert.deepEqual(event[key], expected[key], hookEvent + ': ' + key);
    assert.ok(Number.isFinite(event.sentAt));
  }
});
