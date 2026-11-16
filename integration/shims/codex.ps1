# Preserve argv in JSON. Node inherits the raw stdin handle, so piped bytes and EOF reach it unchanged; only objects
# piped inside PowerShell are forwarded, as UTF-8. Under -File, a script that names the automatic input variable has
# process stdin drained and decoded before it runs, so that variable is looked up at run time and only when a line
# piped objects here (a top-level -File call has no invoking line).
$previousArguments = $env:AGENTRIX_INTERCEPT_ARGV
$previousElectron = $env:ELECTRON_RUN_AS_NODE
$node = if ($env:AGENTRIX_SHIM_NODE) { $env:AGENTRIX_SHIM_NODE } else { 'node' }
$node = (Get-Command $node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$entry = Join-Path $PSScriptRoot 'intercept.cjs'
try {
    $env:AGENTRIX_INTERCEPT_ARGV = ConvertTo-Json -InputObject (@('codex', '--') + @($args)) -Compress
    $env:ELECTRON_RUN_AS_NODE = '1'
    if ($MyInvocation.ExpectingInput -and $MyInvocation.Line) {
        $OutputEncoding = [Text.UTF8Encoding]::new($false)
        $ExecutionContext.SessionState.PSVariable.GetValue('input') | & $node $entry
    } else { & $node $entry }
    $shimExit = $LASTEXITCODE
} finally {
    $env:AGENTRIX_INTERCEPT_ARGV = $previousArguments
    $env:ELECTRON_RUN_AS_NODE = $previousElectron
}
exit $shimExit
