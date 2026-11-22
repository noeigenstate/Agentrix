const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { build } = require('../package.json');
const installerFile = name => fs.readFileSync(path.join(__dirname, '..', 'build', name), 'utf8');

test('only a fresh interactive Windows install with detected Codex can abort for sandbox setup', () => {
  assert.equal(build.nsis.perMachine, false);
  assert.equal(build.nsis.include, 'build/installer.nsh');
  const include = installerFile('installer.nsh');
  assert.match(include, /!macro customInit\b/);
  assert.match(include, /\$\{OrIf\} \$\{Silent\}\s+\$\{OrIf\} \$\{isUpdated\}\s+Goto agentrixCodexSetupDone[\s\S]*?InitPluginsDir/);
  assert.match(include, /\$WINDIR\\Sysnative\\WindowsPowerShell\\v1\.0\\powershell\.exe[\s\S]*?\$SYSDIR\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(include, /\$\{If\} \$0 == "10"\s+MessageBox MB_OKCANCEL/);
  assert.match(include, /IDCANCEL agentrixCodexSetupFailed/);
  assert.match(include, /-Provision['"]\s+Pop \$0\s+\$\{If\} \$0 != "0"\s+Goto agentrixCodexSetupFailed/);
  assert.match(include, /agentrixCodexSetupFailed:[\s\S]*?SetErrorLevel 1\s+Abort\b/);
});

test('the installer checks the Codex marker and bounds the elevated setup process', () => {
  const setup = installerFile('codex-sandbox-setup.ps1');
  assert.match(setup, /Get-Command -Name codex\.exe[^\r\n]*\s+if \(!\$cli\) \{\s+\$cli = Get-Command -Name codex\.cmd[\s\S]*?if \(!\$cli\) \{ exit 0 \}/);
  assert.match(setup, /'\.sandbox\\setup_marker\.json'\s+if \(Test-Path -LiteralPath \$marker -PathType Leaf\) \{ exit 0 \}/);
  assert.doesNotMatch(setup, /config\.toml|\bPATH\s*=/i);
  assert.match(setup, /catch \{\s+exit 0\s+\}\s+if \(!\$Provision\) \{ exit 10 \}/);
  assert.match(setup, /if \(!\$process\.WaitForExit\(300000\)\) \{[\s\S]*?taskkill\.exe" \/PID \$process\.Id \/T \/F[^\r\n]*\s+exit 1/);
  assert.match(setup, /\$process\.WaitForExit\(\)\s+exit \$process\.ExitCode/);
});
