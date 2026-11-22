param([switch]$Provision)

$ErrorActionPreference = 'Stop'

function Test-ElevatedSandboxConfig($ConfigPath) {
    if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return $false }

    # Remove comments and mask multiline strings before looking for the table and key Codex writes.
    $tokens = @'
(?mx)
  "{3} (?: \\. | (?! "{3} ) [^\\] )* "{3,5}
| '{3} (?: (?! '{3} ) [\s\S] )* '{3,5}
| "(?: \\. | [^"\\\r\n] )*" | '[^'\r\n]*'
| \#[^\r\n]*
'@
    $config = [regex]::Replace([IO.File]::ReadAllText($ConfigPath), $tokens, {
        param($token)
        if ($token.Value.StartsWith('#')) { return '' }
        if ($token.Value.Length -ge 6 -and $token.Value[0] -eq $token.Value[1] -and $token.Value[1] -eq $token.Value[2]) {
            return '""'
        }
        return $token.Value
    })
    $inWindows = $false
    foreach ($line in ($config -split '\r?\n')) {
        if ($line -cmatch '^[ \t]*\[.*\][ \t]*$') {
            $inWindows = $line -cmatch '^[ \t]*\[[ \t]*(windows|"windows"|''windows'')[ \t]*\][ \t]*$'
        } elseif ($inWindows -and $line -cmatch '^[ \t]*(sandbox|"sandbox"|''sandbox'')[ \t]*=[ \t]*("elevated"|''elevated'')[ \t]*$') {
            return $true
        }
    }
    return $false
}

try {
    $cli = Get-Command -Name codex -CommandType Application -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -match '\.(exe|cmd)$' } | Select-Object -First 1
    if (!$cli) {
        if ($Provision) { exit 1 }
        exit 0
    }

    $profilePath = [Environment]::GetFolderPath('UserProfile')
    $codexHome = $env:CODEX_HOME
    if (!$codexHome) { $codexHome = Join-Path $profilePath '.codex' }
    if ($codexHome -notmatch '^[a-z]:[\\/]') { throw 'Codex home must be an absolute local path.' }
    $codexHome = [IO.Path]::GetFullPath($codexHome)
    $configPath = Join-Path $codexHome 'config.toml'

    if (Test-ElevatedSandboxConfig $configPath) { exit 0 }
    if (!$Provision) { exit 10 }

    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    # Pin the target user and profile before RunAs, which can use another account.
    # Pass an inline command to the elevated process so it never opens the extracted script.
    $environment = @{
        AGENTRIX_SETUP_CLI = $cli.Source
        AGENTRIX_SETUP_USER = $user
        CODEX_HOME = $codexHome
        USERPROFILE = $profilePath
        PATH = $env:Path
    }
    $command = foreach ($entry in $environment.GetEnumerator()) {
        '$env:{0} = ''{1}''' -f $entry.Key, $entry.Value.Replace("'", "''")
    }
    $command += @'
$ErrorActionPreference = 'Stop'
try {
    if ($env:AGENTRIX_SETUP_CLI.EndsWith('.cmd', [StringComparison]::OrdinalIgnoreCase)) {
        # cmd expands these quoted variables once. Disable AutoRun and delayed expansion.
        $arguments = '/d /v:off /s /c ""%AGENTRIX_SETUP_CLI%" sandbox setup --elevated --user "%AGENTRIX_SETUP_USER%" --codex-home "%CODEX_HOME%""'
        $process = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
        exit $process.ExitCode
    }
    & $env:AGENTRIX_SETUP_CLI sandbox setup --elevated --user $env:AGENTRIX_SETUP_USER --codex-home $env:CODEX_HOME
    exit $LASTEXITCODE
} catch {
    exit 1
}
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command -join "`n"))
    $process = Start-Process -FilePath "$PSHOME\powershell.exe" -Verb RunAs -WorkingDirectory $PSHOME -WindowStyle Hidden -Wait -PassThru -ArgumentList (
        "-NoProfile -NonInteractive -EncodedCommand $encoded"
    )
    if ($process.ExitCode -ne 0 -or !(Test-ElevatedSandboxConfig $configPath)) { exit 1 }
    exit 0
} catch {
    exit 1
}
