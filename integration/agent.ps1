# Command Prompt terminals run agents through this script (doskey macros in bootstrap.cmd),
# so they get the same wrappers as PowerShell terminals: turn status, Claude hooks and session restore.
# bootstrap.ps1 loads only those wrappers here; the working directory stays the one cmd was in.
# Usage: agent.ps1 <agent> [arguments...]. There is no param() block: an advanced script would
# refuse the agent's own arguments (resume, --continue, ...), which pass through untouched.
$agent = [string]$args[0]
$forward = @($args | Select-Object -Skip 1)
$here = (Get-Location).Path
$env:AGENTRIX_AGENT_ONLY = '1'
. (Join-Path $PSScriptRoot 'bootstrap.ps1')
Set-Location -LiteralPath $here
# Events from this short-lived process must sort after the prompt events of the terminal.
$global:AgentrixEventSequence = [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
agentrix_agent $agent.ToLowerInvariant() @forward
exit $global:LASTEXITCODE
