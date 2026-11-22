const { execFile } = require('node:child_process');
const { win32: path } = require('node:path');

const absoluteDrivePath = value => typeof value === 'string' && /^[a-z]:[\\/]/i.test(value) && !/[:"\x00-\x1f]/.test(value.slice(2));
const encode = value => Buffer.from(value, 'utf16le').toString('base64');

function localHome(value) {
  if (!absoluteDrivePath(value)) return null;
  const home = path.normalize(value).replace(/\\+$/, '');
  return home.length > 2 && !/[. ](?:\\|$)/.test(home) ? home : null;
}

const setupCommand = String.raw`
$ErrorActionPreference = 'Stop'
function Test-SafeHome($homePath) {
    try {
        if ($homePath -eq [IO.Path]::GetPathRoot($homePath)) { return $false }
        if ([IO.DriveInfo]::new($homePath.Substring(0, 3)).DriveType -eq [IO.DriveType]::Network) { return $false }
        $paths = @()
        for ($folder = [IO.DirectoryInfo]::new($homePath); $folder; $folder = $folder.Parent) {
            $paths = @($folder.FullName) + $paths
        }
        $paths += [IO.Path]::Combine($homePath, '.sandbox')
        foreach ($candidate in $paths) {
            try { $attributes = [IO.File]::GetAttributes($candidate) }
            catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { continue }
            if (!($attributes -band [IO.FileAttributes]::Directory) -or ($attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
        }
        return $true
    } catch { return $false }
}
try {
    $cli = $env:AGENTRIX_SETUP_CLI
    $arguments = 'sandbox setup --elevated --user "{0}" --codex-home "{1}"' -f $env:AGENTRIX_SETUP_USER, $env:CODEX_HOME
    try { $signature = Get-AuthenticodeSignature -LiteralPath $cli }
    catch { exit 4 }
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*OpenAI OpCo, LLC*') { exit 4 }
    if (!(Test-SafeHome $env:CODEX_HOME)) { exit 2 }
    $process = Start-Process -FilePath $cli -ArgumentList $arguments -WorkingDirectory $PSHOME -WindowStyle Hidden -PassThru
    $null = $process.Handle
    if (!$process.WaitForExit(300000)) {
        # Stop the tree from the same elevation that started it.
        & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
        exit 1
    }
    if ($process.ExitCode -eq 0) { exit 0 }
    exit 1
} catch {
    exit 1
}
`;

function setupArgs(file, home) {
  if (!absoluteDrivePath(file) || !/\.(exe|com)$/i.test(file)) throw new Error('invalid_codex_executable');
  const command = String.raw`
$ErrorActionPreference = 'Stop'
try {
    $homePath = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encode(home)}'))
    if ([IO.DriveInfo]::new($homePath.Substring(0, 3)).DriveType -eq [IO.DriveType]::Network) { exit 2 }
    $values = @{
        AGENTRIX_SETUP_CLI = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encode(file)}'))
        AGENTRIX_SETUP_USER = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        CODEX_HOME = $homePath
        USERPROFILE = [Environment]::GetFolderPath('UserProfile')
    }
    $lines = foreach ($entry in $values.GetEnumerator()) {
        $value = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($entry.Value))
        '$env:{0} = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(''{1}''))' -f $entry.Key, $value
    }
    $lines += [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encode(setupCommand)}'))
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($lines -join [Environment]::NewLine))
    $process = Start-Process -FilePath "$PSHOME\powershell.exe" -Verb RunAs -WorkingDirectory $PSHOME -WindowStyle Hidden -PassThru -ArgumentList (
        "-NoProfile -NonInteractive -EncodedCommand $encoded"
    )
    $null = $process.Handle
    $process.WaitForExit()
    exit $process.ExitCode
} catch {
    for ($cause = $_.Exception; $cause; $cause = $cause.InnerException) {
        if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223) { exit 3 }
    }
    exit 1
}
`;
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(command)];
}

function runSetup(file, value, env, launch = execFile) {
  const home = localHome(value);
  if (!home) return Promise.resolve('invalidHome');
  const system = path.join(env.SystemRoot || 'C:\\Windows', 'System32');
  const powershell = path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = setupArgs(file, home);
  const options = { cwd: system, env, windowsHide: true, timeout: 360_000 };
  return new Promise(resolve => launch(powershell, args, options, error => {
    resolve(!error ? 'succeeded' : ({ 2: 'invalidHome', 3: 'declined', 4: 'unverified' })[error.code] || 'failed');
  }));
}

module.exports = { runSetup };
