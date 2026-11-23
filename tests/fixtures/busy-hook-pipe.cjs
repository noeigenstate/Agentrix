const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { createInterface } = require('node:readline');

const powershell = process.platform === 'win32' && path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');

async function occupyHookPipe(t, name, env) {
  // A single connected instance makes subsequent CreateFile calls see ERROR_PIPE_BUSY.
  const script = `
$ErrorActionPreference = 'Stop'
$server = [IO.Pipes.NamedPipeServerStream]::new('${name}', [IO.Pipes.PipeDirection]::InOut, 1)
try {
    $client = [IO.Pipes.NamedPipeClientStream]::new('.', '${name}', [IO.Pipes.PipeDirection]::InOut)
    try {
        $client.Connect(1000)
        $server.WaitForConnection()
        [Console]::WriteLine('ready')
        [void][Console]::ReadLine()
    } finally { $client.Dispose() }
} finally { $server.Dispose() }
`;
  const command = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], { env, windowsHide: true });
  const closed = once(child, 'close');
  t.after(async () => { child.stdin.end(); await closed; });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const ready = once(lines, 'line', { signal: AbortSignal.timeout(8000) });
  const [line] = await Promise.race([ready, closed.then(([code]) => { throw new Error('Busy pipe fixture exited (' + code + '): ' + stderr); })]);
  if (line !== 'ready') throw new Error('Busy pipe fixture did not acknowledge readiness');
}

module.exports = { occupyHookPipe, powershell };
