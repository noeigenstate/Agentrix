param(
    [scriptblock]$ReadPath = { param($Scope) [Environment]::GetEnvironmentVariable('Path', $Scope) }
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
