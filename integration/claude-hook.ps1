param(
    [Parameter(Mandatory=$true)][string]$PipeName,
    [Parameter(Mandatory=$true)][string]$ProjectId,
    [Parameter(Mandatory=$true)][string]$SessionKey,
    [Parameter(Mandatory=$true)][ValidateSet('start', 'stop', 'stop-failed', 'notify', 'session', 'progress', 'permission', 'seat-routing', 'worker-permission')][string]$Kind,
    [string]$NodePath
)

# Claude Code hook: UserPromptSubmit reports a working turn, Stop reports a finished one, StopFailure one that ended in an
# API error (an interrupted round, never a completed one), SessionStart the
# conversation Claude writes now (after /clear, /resume or a new start it is another file).
# SessionStart reports the conversation path. The separate seat-routing hook can print tool input or a notice.
$ErrorActionPreference = 'Stop'

function Write-HookLine($stream, $line, $newline = [Environment]::NewLine) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($line + $newline)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
}

function Write-HookTrace($stage) {
    if ($env:AGENTRIX_HOOK_TRACE) {
        Write-HookLine ([Console]::OpenStandardError()) "[agentrix-hook] $([DateTime]::UtcNow.ToString('o')) powershell $Kind $stage"
    }
}

if ($env:AGENTRIX_HOOK_TRACE) {
    Write-HookTrace "script-start process-start=$([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString('o'))"
}

if ($Kind -in @('seat-routing', 'worker-permission')) {
    $workerPermission = $Kind -eq 'worker-permission'
    try {
        if (-not $NodePath) { exit 0 }
        if ($Kind -eq 'seat-routing' -and (-not $env:AGENTRIX_SEATS -or $env:AGENTRIX_SEATS -eq 'null') -and
            ($env:AGENTRIX_BOOTSTRAP -notmatch '^[A-Za-z]:[\\/]' -or -not [IO.File]::Exists($env:AGENTRIX_BOOTSTRAP + '.seats'))) { exit 0 }
        $start = [Diagnostics.ProcessStartInfo]::new($NodePath)
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        # Node reads Claude's stdin directly. A second reader or an intermediate buffer delays the decision.
        $start.RedirectStandardOutput = $true
        # The CLI is attached to a pseudoterminal. Use UTF-8 on the pipes without changing its console code page.
        $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
        if ($workerPermission) {
            $start.EnvironmentVariables['AGENTRIX_WORKER_PERMISSION_BRIDGE'] = '1'
        }
        $start.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
        $helper = [IO.Path]::Combine($PSScriptRoot, 'agent-event.cjs')
        $start.Arguments = '"{0}" claude-hook "\\.\pipe\{1}" "{2}" "{3}" {4}' -f $helper, $PipeName, $ProjectId, $SessionKey, $Kind
        Write-HookTrace 'node-launch'
        $child = [Diagnostics.Process]::Start($start)
        try {
            Write-HookTrace 'node-launched'
            $output = $child.StandardOutput.ReadLineAsync()
            if (-not $output.Wait($(if ($workerPermission) { 8000 } else { 2500 }))) {
                if ($workerPermission) {
                    Write-HookLine ([Console]::OpenStandardError()) 'Agentrix worker permission hook timed out reading the decision from Node.'
                }
                exit 0
            }
            $line = $output.GetAwaiter().GetResult()
            if ($null -ne $line) {
                Write-HookLine ([Console]::OpenStandardOutput()) $line "`n"
                Write-HookTrace 'output-forwarded'
            }
            if (-not $workerPermission) {
                [void]$child.WaitForExit(850)
            }
        } finally {
            try {
                if (-not $child.HasExited) { $child.Kill() }
            } finally { $child.Dispose() }
            Write-HookTrace 'bridge-exit'
        }
    } catch {
        if ($workerPermission) {
            Write-HookLine ([Console]::OpenStandardError()) "Agentrix worker permission bridge failed ($($_.Exception.GetType().Name))."
        }
    }
    exit 0
}

try {
    $sentAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $inputReader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false), $false)
    try { $hook = $inputReader.ReadToEnd() | ConvertFrom-Json } finally { $inputReader.Dispose() }
    # Idle notifications must not turn a completed round back into a waiting one.
    if ($Kind -eq 'notify' -and $hook.notification_type -notin @('permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog')) { exit 0 }
    $sessionId = [string]$hook.session_id
    if (-not $sessionId) { exit 0 }
    $eventData = @{
        v = 1
        projectId = $ProjectId
        sessionKey = $SessionKey
        type = 'agent-activity'
        agent = 'claude'
        state = $(if ($Kind -in @('notify', 'permission')) { 'attention' } elseif ($Kind -eq 'stop') { 'complete' } elseif ($Kind -eq 'stop-failed') { 'failed' } elseif ($Kind -eq 'session') { 'session' } elseif ($Kind -eq 'progress') { 'progress' } else { 'working' })
        message = $(if ($Kind -in @('notify', 'permission')) { $text = if ($null -ne $hook.message) { [string]$hook.message } else { [string]$hook.tool_name }; $text.Substring(0, [Math]::Min(300, $text.Length)) } else { $null })
        sentAt = $sentAt
        hookEvent = [string]$hook.hook_event_name
        menuTool = $(if ($hook.tool_name -in @('AskUserQuestion', 'ExitPlanMode')) { [string]$hook.tool_name } else { $null })
        sessionSource = [string]$hook.source
        sessionId = $sessionId
        # Where Claude writes this conversation; Agentrix reads the steps of the round from it.
        transcriptPath = [string]$hook.transcript_path
        eventId = $sessionId + ':' + [DateTime]::UtcNow.Ticks
        # The submitted prompt names the work; the spoken completion notice says what finished.
        prompt = $(if ($Kind -eq 'start' -and $hook.prompt) { ([string]$hook.prompt).Substring(0, [Math]::Min(2000, ([string]$hook.prompt).Length)) } else { $null })
    }
    if ($hook.turn_id -is [string]) { $eventData.turnId = $hook.turn_id }
    if ($hook.tool_use_id -is [string]) { $eventData.requestId = $hook.tool_use_id }
    # The prompt whose turn this is: with async hooks a late Stop of an older prompt cannot end a newer turn.
    if ($hook.prompt_id -is [string]) { $eventData.promptId = $hook.prompt_id }
    $eventData = $eventData | ConvertTo-Json -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($eventData + [Environment]::NewLine)
    $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [IO.Pipes.PipeDirection]::Out, [IO.Pipes.PipeOptions]::Asynchronous)
    $report = [Diagnostics.Stopwatch]::StartNew()
    try {
        Write-HookTrace 'pipe-connect'
        if (-not $pipe.ConnectAsync(750).Wait(750)) { exit 0 }
        Write-HookTrace 'pipe-write'
        [void]$pipe.WriteAsync($bytes, 0, $bytes.Length).Wait([Math]::Max(0, 750 - $report.ElapsedMilliseconds))
    } finally {
        $pipe.Dispose()
        Write-HookTrace "report-exit elapsed-ms=$($report.ElapsedMilliseconds)"
    }
} catch { }
exit 0
