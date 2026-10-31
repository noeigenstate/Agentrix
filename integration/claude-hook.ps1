param(
    [Parameter(Mandatory=$true)][string]$PipeName,
    [Parameter(Mandatory=$true)][string]$ProjectId,
    [Parameter(Mandatory=$true)][string]$SessionKey,
    [Parameter(Mandatory=$true)][ValidateSet('start', 'stop', 'notify', 'session')][string]$Kind
)

# Claude Code hook: UserPromptSubmit reports a working turn, Stop reports a finished one, SessionStart the
# conversation Claude writes now (after /clear, /resume or a new start it is another file).
# Claude adds anything printed here to the conversation, so this script writes nothing,
# and a closed Agentrix must never delay or fail a turn.
$ErrorActionPreference = 'Stop'
try {
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    $hook = [Console]::In.ReadToEnd() | ConvertFrom-Json
    # Idle notifications must not turn a completed round back into a waiting one.
    if ($Kind -eq 'notify' -and $hook.notification_type -notin @('permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog')) { exit 0 }
    $sessionId = [string]$hook.session_id
    if (-not $sessionId) { exit 0 }
    $eventData = @{
        projectId = $ProjectId
        sessionKey = $SessionKey
        type = 'agent-activity'
        agent = 'claude'
        state = $(if ($Kind -eq 'notify') { 'attention' } elseif ($Kind -eq 'stop') { 'complete' } elseif ($Kind -eq 'session') { 'session' } else { 'working' })
        message = $(if ($Kind -eq 'notify') { ([string]$hook.message).Substring(0, [Math]::Min(300, ([string]$hook.message).Length)) } else { $null })
        sessionId = $sessionId
        # Where Claude writes this conversation; Agentrix reads the steps of the round from it.
        transcriptPath = [string]$hook.transcript_path
        eventId = $sessionId + ':' + [DateTime]::UtcNow.Ticks
        # The submitted prompt names the work; the spoken completion notice says what finished.
        prompt = $(if ($Kind -eq 'start' -and $hook.prompt) { ([string]$hook.prompt).Substring(0, [Math]::Min(2000, ([string]$hook.prompt).Length)) } else { $null })
    } | ConvertTo-Json -Compress
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [System.IO.Pipes.PipeDirection]::Out)
    try {
        $pipe.Connect(750)
        $writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false))
        try { $writer.WriteLine($eventData); $writer.Flush() } finally { $writer.Dispose() }
    } finally { $pipe.Dispose() }
} catch { }
exit 0
