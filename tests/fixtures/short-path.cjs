const { spawnSync } = require('node:child_process');

function shortPath(directory) {
  if (process.platform !== 'win32') return directory;
  const script = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $f = New-Object -ComObject Scripting.FileSystemObject; [Console]::Write(($f.GetFolder($env:AGENTRIX_ALIAS_DIRECTORY).ShortPath | ConvertTo-Json -Compress))';
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, AGENTRIX_ALIAS_DIRECTORY: directory }, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  if (result.error || result.status !== 0) throw result.error || new Error('ShortPath probe failed: ' + result.stderr);
  return JSON.parse(result.stdout.trim());
}
module.exports = { shortPath };
