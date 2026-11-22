param([switch]$Provision)

$ErrorActionPreference = 'Stop'

try {
    $cli = Get-Command -Name codex.exe -CommandType Application -ErrorAction SilentlyContinue
    if (!$cli) {
        $cli = Get-Command -Name codex.cmd -CommandType Application -All -ErrorAction SilentlyContinue |
            Where-Object { $_.Source -notmatch '(?:^|[\\/])integration[\\/]shims[\\/]codex\.cmd$' } | Select-Object -First 1
    }
    if (!$cli) { exit 0 }

    $profilePath = [Environment]::GetFolderPath('UserProfile')
    $codexHome = $env:CODEX_HOME
    if (!$codexHome) { $codexHome = Join-Path $profilePath '.codex' }
    if ($codexHome -notmatch '^[a-z]:[\\/]') { exit 0 }
    $codexHome = [IO.Path]::GetFullPath($codexHome).TrimEnd('\')
    if ($codexHome.Length -eq 2) { $codexHome += '\.' }

    $marker = Join-Path $codexHome '.sandbox\setup_marker.json'
    if (Test-Path -LiteralPath $marker -PathType Leaf) { exit 0 }
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
} catch {
    exit 0
}

if (!$Provision) { exit 10 }

try {
    # RunAs can use a different account. Pass the initiating user's values as data.
    $environment = @{
        AGENTRIX_SETUP_CLI = $cli.Source
        AGENTRIX_SETUP_USER = $user
        CODEX_HOME = $codexHome
        USERPROFILE = $profilePath
    }
    $command = foreach ($entry in $environment.GetEnumerator()) {
        $value = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($entry.Value))
        '$env:{0} = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(''{1}''))' -f $entry.Key, $value
    }
    $command += @'
$ErrorActionPreference = 'Stop'
try {
    $cli = $env:AGENTRIX_SETUP_CLI
    $arguments = 'sandbox setup --elevated --user "{0}" --codex-home "{1}"' -f $env:AGENTRIX_SETUP_USER, $env:CODEX_HOME
    if ($cli.EndsWith('.cmd', [StringComparison]::OrdinalIgnoreCase)) {
        # cmd expands each quoted variable once. Disable AutoRun and delayed expansion.
        $cli = "$env:SystemRoot\System32\cmd.exe"
        $arguments = '/d /v:off /s /c ""%AGENTRIX_SETUP_CLI%" sandbox setup --elevated --user "%AGENTRIX_SETUP_USER%" --codex-home "%CODEX_HOME%""'
    }
    $process = Start-Process -FilePath $cli -ArgumentList $arguments -WindowStyle Hidden -PassThru
    if (!$process.WaitForExit(300000)) {
        # Stop the CLI and its children from the same elevation that started them.
        & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
        exit 1
    }
    exit $process.ExitCode
} catch {
    exit 1
}
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command -join "`n"))
    $process = Start-Process -FilePath "$PSHOME\powershell.exe" -Verb RunAs -WorkingDirectory $PSHOME -WindowStyle Hidden -PassThru -ArgumentList (
        "-NoProfile -NonInteractive -EncodedCommand $encoded"
    )
    $process.WaitForExit()
    exit $process.ExitCode
} catch {
    exit 1
}
