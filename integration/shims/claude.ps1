# Preserve argv in JSON and inherit raw OS streams; PowerShell's native pipeline decodes stdin and adds newlines.
$previousArguments = $env:AGENTRIX_INTERCEPT_ARGV
$previousElectron = $env:ELECTRON_RUN_AS_NODE
$node = if ($env:AGENTRIX_SHIM_NODE) { $env:AGENTRIX_SHIM_NODE } else { 'node' }
try {
    $env:AGENTRIX_INTERCEPT_ARGV = ConvertTo-Json -InputObject (@('claude', '--') + @($args)) -Compress
    $env:ELECTRON_RUN_AS_NODE = '1'
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node
    $start.Arguments = '"' + (Join-Path $PSScriptRoot 'intercept.cjs') + '"'
    $start.WorkingDirectory = (Get-Location).ProviderPath
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $false
    $start.RedirectStandardOutput = $false
    $start.RedirectStandardError = $false
    $child = [Diagnostics.Process]::Start($start)
    try { $child.WaitForExit(); $shimExit = $child.ExitCode } finally { $child.Dispose() }
} finally {
    $env:AGENTRIX_INTERCEPT_ARGV = $previousArguments
    $env:ELECTRON_RUN_AS_NODE = $previousElectron
}
exit $shimExit
