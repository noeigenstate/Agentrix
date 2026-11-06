// Test-only CPU throttling for one owned PowerShell PTY. Other app processes
// retain their affinity; all load children belong to the private controller.
async function installColdPowerShell({ app }, { node, cache }) {
  const path = process.getBuiltinModule('path'), cp = process.getBuiltinModule('child_process'), fs = process.getBuiltinModule('fs');
  const require = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'));
  const pty = require('node-pty'), original = pty.spawn;
  const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$self = [Diagnostics.Process]::GetCurrentProcess()
$mask = $self.ProcessorAffinity.ToInt64()
$core = $mask -band (-$mask)
$self.ProcessorAffinity = [IntPtr]::new($core)
$target = $null
$load = @()
try {
  for ($i = 0; $i -lt 16; $i++) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $env:AGX_COLD_NODE
    $info.Arguments = '-e "for(;;) Math.sqrt(1234567)"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $child = [Diagnostics.Process]::Start($info)
    $load += $child
    $child.ProcessorAffinity = [IntPtr]::new($core)
  }
  [Console]::WriteLine('READY')
  $pidFile = $env:AGX_COLD_STATE + '-pid'
  $stopFile = $env:AGX_COLD_STATE + '-stop'
  while (-not [IO.File]::Exists($pidFile)) {
    if ([IO.File]::Exists($stopFile)) { exit }
    [Threading.Thread]::Sleep(10)
  }
  $target = [Diagnostics.Process]::GetProcessById([int][IO.File]::ReadAllText($pidFile))
  if ($target.ProcessName -ne 'powershell') { throw 'Cold target is not the owned PowerShell' }
  $originalMask = $target.ProcessorAffinity
  $target.ProcessorAffinity = [IntPtr]::new($core)
  [Console]::WriteLine('TARGET_PINNED')
  while (-not [IO.File]::Exists($stopFile)) { [Threading.Thread]::Sleep(10) }
} finally {
  $self.ProcessorAffinity = [IntPtr]::new($mask)
  foreach ($child in $load) { try { $child.Kill(); $child.WaitForExit(); $child.Dispose() } catch {} }
  if ($target) { try { $target.ProcessorAffinity = $originalMask; $target.Dispose() } catch {} }
}
`;
  const controller = cp.spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, env: { ...process.env, AGX_COLD_NODE: node, AGX_COLD_STATE: cache + '-load', PSModuleAnalysisCachePath: cache + '-controller' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let closed = false, startedAt = null, output = '', pinned = false, pinTimer;
  const exited = new Promise(resolve => controller.once('exit', () => {
    closed = true; controller.stdout.destroy(); controller.stderr.destroy(); resolve();
  }));
  controller.stderr.on('data', value => { output = (output + value).slice(-2048); });
  controller.stdout.on('data', value => { if (value.toString().includes('TARGET_PINNED')) pinned = true; });
  let cleanup;
  process.__agxColdPowerShellClose = () => cleanup ||= (async () => {
    const startupMs = startedAt === null ? null : Date.now() - startedAt;
    clearInterval(pinTimer);
    pty.spawn = original;
    const unexpectedExit = closed;
    fs.writeFileSync(cache + '-load-stop', 'stop');
    // These deliberately busy children need no graceful drain. Reap the
    // private controller tree, not the PowerShell PTY being measured.
    if (!closed) {
      const killed = cp.spawnSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'),
        ['/PID', String(controller.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      if (killed.error || killed.status !== 0) throw killed.error || new Error('Could not stop cold load tree');
    }
    let timer;
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Cold PowerShell controller did not stop: ' + output));
        }, 5000);
      })]);
    } finally { clearTimeout(timer); }
    if (unexpectedExit || startedAt !== null && !pinned) throw new Error('Cold load was not applied: ' + output);
    return { startupMs, loadProcesses: 16, pinned };
  })();
  await new Promise((resolve, reject) => {
    controller.once('error', reject);
    controller.once('exit', code => reject(new Error(`Cold controller exited before ready: ${code} ${output}`)));
    controller.stdout.once('data', value => value.toString().includes('READY') ? resolve() : reject(new Error('Cold controller was not ready')));
  });
  pty.spawn = (file, args, options) => {
    const child = original(file, args, options);
    if (startedAt === null && /[\\/]powershell\.exe$/i.test(file)) {
      startedAt = Date.now();
      // node-pty publishes pid=0 until ConPTY has connected its data pipe.
      pinTimer = setInterval(() => {
        if (child.pid <= 0) return;
        clearInterval(pinTimer); fs.writeFileSync(cache + '-load-pid', String(child.pid));
      }, 10);
      child.onExit(() => clearInterval(pinTimer));
    }
    return child;
  };
  return { installed: true, loadProcesses: 16 };
}
module.exports = { installColdPowerShell };
