const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createEventServer } = require('../electron/events.cjs');

test('PowerShell URL elicitation sends one silent attention event, never a completed turn', { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
  const events = [], server = await createEventServer(event => events.push(event));
  t.after(() => server.close());
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../integration/claude-hook.ps1'),
      '-PipeName', server.name, '-ProjectId', 'terminal', '-SessionKey', 'key', '-Kind', 'notify'], { windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
    child.stdin.end(JSON.stringify({ session_id: 's', notification_type: 'elicitation_url_dialog', message: '长'.repeat(400), prompt: 'not a submission' }));
  });
  assert.deepEqual(result, { code: 0, output: '' });
  assert.equal(events.length, 1);
  assert.equal(events[0].state, 'attention');
  assert.equal(events[0].message, '长'.repeat(300));
  assert.equal(events[0].prompt, null);
  assert.equal(events[0].projectId, 'terminal');
  assert.equal(events[0].sessionKey, 'key');
});
