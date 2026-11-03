const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { claudeEvent } = require('../integration/agent-event.cjs');
const { createEventServer } = require('../electron/events.cjs');

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
  for (const file of ['bash-integration.bash', 'zsh-integration.zsh']) {
    const text = fs.readFileSync(path.join(__dirname, '../integration', file), 'utf8');
    const line = text.split('\n').find(line => line.startsWith('  local settings=')).trimEnd();
    const settings = JSON.parse(line.slice(line.indexOf('=') + 2, -1).replace(/\\"/g, '"').replace(/\$(start|stop|notify|session|progress|permission)/g, (_, kind) => JSON.stringify(kind)));
    for (const [name, kind] of Object.entries(hooks)) {
      const hook = settings.hooks[name][0].hooks[0];
      assert.equal(hook.command, kind, file + ': ' + name);
      assert.equal(hook.async === true, kind === 'progress', file + ': ' + name + ' async');
    }
  }
  const ps = fs.readFileSync(path.join(__dirname, '../integration/bootstrap.ps1'), 'utf8');
  for (const name of Object.keys(hooks)) assert.ok(ps.includes("'" + name + "'"), name);
  assert.match(ps, /async = \(\$kind -eq 'progress'\)/);
});

test('PowerShell and Node emit equivalent progress and permission fields without output', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const events = [], server = await createEventServer(event => events.push(event)); t.after(() => server.close());
  const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  for (const [hookEvent, kind] of Object.entries(hooks)) {
    const input = { ...payload(hookEvent), source: 'compact' };
    const result = await new Promise((resolve, reject) => {
      const child = spawn(executable, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../integration/claude-hook.ps1'), '-PipeName', server.name, '-ProjectId', 'terminal', '-SessionKey', 'capability', '-Kind', kind], { windowsHide: true });
      let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      child.on('error', reject); child.on('close', code => resolve({ code, output })); child.stdin.end(JSON.stringify(input));
    });
    assert.deepEqual(result, { code: 0, output: '' });
    const event = events.at(-1), expected = claudeEvent(JSON.stringify(input), 'terminal', 'capability', kind);
    assert.equal(events.length, Object.keys(hooks).indexOf(hookEvent) + 1);
    for (const key of Object.keys(expected).filter(key => !['eventId', 'sentAt'].includes(key))) assert.deepEqual(event[key], expected[key], hookEvent + ': ' + key);
    assert.ok(Number.isFinite(event.sentAt));
  }
});
