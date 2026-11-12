# AGENTRIX_TEST_STORED_PATH ({"Machine": "...", "User": "..."}) stands in for the stored PATH, so a test of the
# wrappers never reads this computer's registry.
param(
    [scriptblock]$ReadPath = {
        param($Scope)
        if ($env:AGENTRIX_TEST_STORED_PATH) { return (ConvertFrom-Json $env:AGENTRIX_TEST_STORED_PATH).$Scope }
        [Environment]::GetEnvironmentVariable('Path', $Scope)
    }
)

# Keep launch-time toolchains first, then supplement them with newly installed
# machine/user tools. Only this PowerShell process is updated, never the registry.
$pgPathParts = [Collections.Generic.List[string]]::new()
$pgPathSeen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$pgPathSources = [Collections.Generic.List[string]]::new()
$pgPathSources.Add([string]$env:Path)
foreach ($pgPathScope in @('Machine', 'User')) {
    try {
        $pgStoredPath = [string](& $ReadPath $pgPathScope)
        $pgPathSources.Add([Environment]::ExpandEnvironmentVariables($pgStoredPath))
    } catch {
        # A denied registry scope must not prevent the other scope or shell startup.
    }
}
foreach ($pgPathSource in $pgPathSources) {
    foreach ($pgPathPart in ($pgPathSource -split ';')) {
        $pgPathEntry = $pgPathPart.Trim()
        if (-not $pgPathEntry) { continue }
        $pgPathKey = $pgPathEntry.Trim('"').Replace('/', '\')
        if ($pgPathKey.Length -gt 3) { $pgPathKey = $pgPathKey.TrimEnd('\') }
        if ($pgPathSeen.Add($pgPathKey)) { $pgPathParts.Add($pgPathEntry) }
    }
}
$env:Path = $pgPathParts -join ';'
