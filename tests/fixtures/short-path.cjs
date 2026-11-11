const { spawnSync } = require('node:child_process');

// Asks cmd.exe for the 8.3 name (%~sI); no PowerShell start-up, so it stays fast under CI load.
// Where 8.3 names are disabled the path comes back unchanged (no '~'), as before.
function shortPath(directory) {
  if (process.platform !== 'win32') return directory;
  const command = '"for %I in ("%AGENTRIX_ALIAS_DIRECTORY%") do @echo %~sI"';
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/u', '/s', '/c', command], {
    env: { ...process.env, AGENTRIX_ALIAS_DIRECTORY: directory }, encoding: 'utf16le', windowsHide: true, windowsVerbatimArguments: true, timeout: 60000,
  });
  if (result.error || result.status !== 0) throw result.error || new Error('ShortPath probe failed: ' + result.stderr);
  return result.stdout.trim();
}
module.exports = { shortPath };
