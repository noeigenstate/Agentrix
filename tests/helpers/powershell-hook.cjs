const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:net');
const path = require('node:path');

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const shellArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const quote = value => "'" + value.replaceAll("'", "''") + "'";

function bootstrapScript(bootstrap) {
  return [
    "$env:AGENTRIX_AGENT_ONLY = '1'",
    '$env:AGENTRIX_BOOTSTRAP = ' + quote(bootstrap),
    '. ' + quote(path.resolve(__dirname, '../../integration/bootstrap.ps1')),
  ].join('\n');
}

function runPowerShell(script, env) {
  return execFileSync(powershell, [...shellArgs, '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, env,
  });
}

function runPowerShellHook(kind, input, { pipeName = 'agentrix-hook-test-' + randomUUID() } = {}) {
  const args = ['-File', path.resolve(__dirname, '../../integration/claude-hook.ps1'),
    '-PipeName', pipeName, '-ProjectId', 'fixture', '-SessionKey', 'fixture-key', '-Kind', kind];
  const env = { ...process.env };
  delete env.AGENTRIX_READING_NOTE_FILE;
  delete env.AGENTRIX_HOOK_TRACE;
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, [...shellArgs, ...args], { timeout: 5000, windowsHide: true, env });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject).once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function assertIdlePowerShellHook() {
  if (process.platform !== 'win32') return;
  const pipeName = 'agentrix-hook-test-' + randomUUID();
  const messages = [];
  const server = createServer(socket => {
    let text = '';
    socket.setEncoding('utf8').on('data', chunk => { text += chunk; });
    socket.once('end', () => messages.push(text));
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen('\\\\.\\pipe\\' + pipeName, resolve));
  try {
    for (const notification_type of ['idle_prompt', 'permission_prompt']) {
      const result = await runPowerShellHook('notify', { session_id: notification_type, notification_type }, { pipeName });
      assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.deepEqual(messages.map(message => JSON.parse(message).sessionId), ['permission_prompt']);
}

module.exports = { assertIdlePowerShellHook, bootstrapScript, runPowerShell, runPowerShellHook };
