# JSON preserves quotes under Windows PowerShell 5's native argument forwarding.
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$previousArguments = $env:AGENTRIX_INTERCEPT_ARGV
$previousElectron = $env:ELECTRON_RUN_AS_NODE
$node = if ($env:AGENTRIX_SHIM_NODE) { $env:AGENTRIX_SHIM_NODE } else { 'node' }
try {
    $env:AGENTRIX_INTERCEPT_ARGV = ConvertTo-Json -InputObject (@('codex', '--') + @($args)) -Compress
    $env:ELECTRON_RUN_AS_NODE = '1'
    if ($MyInvocation.ExpectingInput) { $input | & $node (Join-Path $PSScriptRoot 'intercept.cjs') }
    else { & $node (Join-Path $PSScriptRoot 'intercept.cjs') }
    $shimExit = $LASTEXITCODE
} finally {
    $env:AGENTRIX_INTERCEPT_ARGV = $previousArguments
    $env:ELECTRON_RUN_AS_NODE = $previousElectron
}
exit $shimExit
