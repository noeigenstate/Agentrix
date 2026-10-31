param(
    [Parameter(Mandatory=$true)][string]$PipeName,
    [Parameter(Mandatory=$true)][string]$ProjectId,
    [Parameter(Mandatory=$true)][string]$SessionKey,
    [Parameter(Mandatory=$true)][ValidateSet('start', 'stop', 'notify', 'session')][string]$Kind,
    [string]$NoteFile = $env:AGENTRIX_READING_NOTE_FILE
)

# Claude Code hook: UserPromptSubmit reports a working turn, Stop reports a finished one, SessionStart the
# conversation Claude writes now (after /clear, /resume or a new start it is another file).
# Only SessionStart prints instruction JSON; all other hooks remain silent.
$ErrorActionPreference = 'Stop'

function Get-AgentrixSessionContext($hook) {
    if ($hook.session_id -notmatch '^[\w-]{1,160}$' -or $hook.source -notin @('startup', 'resume', 'compact', 'clear') -or -not $NoteFile) { return }
    $note = [IO.File]::ReadAllText($NoteFile, [Text.Encoding]::UTF8)
    $marker = [regex]::Match($note, ' Agentrix skill delivery: ([a-f0-9]{64}):([A-Za-z0-9_-]+)\.')
    if (-not $marker.Success) { return }
    $encoded = $marker.Groups[2].Value.Replace('-', '+').Replace('_', '/')
    $encoded = $encoded.PadRight($encoded.Length + ((4 - $encoded.Length % 4) % 4), '=')
    $manifest = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
    if (-not [IO.Path]::IsPathRooted($manifest)) { return }
    $info = Get-Item -LiteralPath $manifest
    if ($info.Attributes -band [IO.FileAttributes]::ReparsePoint -or $info.Length -gt 2097152) { return }
    $context = "Agentrix skill instructions:`n" + [IO.File]::ReadAllText($manifest, [Text.Encoding]::UTF8)
    $parent = Join-Path ([IO.Path]::GetDirectoryName($manifest)) 'receipts'
    [void][IO.Directory]::CreateDirectory($parent)
    if ((Get-Item -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
    $folder = Join-Path $parent 'claude'
    [void][IO.Directory]::CreateDirectory($folder)
    if ((Get-Item -LiteralPath $folder).Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $name = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$hook.session_id))).Replace('-', '').ToLowerInvariant().Substring(0, 32) }
    finally { $hash.Dispose() }
    $folder = Join-Path $folder $name
    [void][IO.Directory]::CreateDirectory($folder)
    if ((Get-Item -LiteralPath $folder).Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
    $receipt = Join-Path $folder $marker.Groups[1].Value.Substring(0, 32)
    if ((Test-Path -LiteralPath $receipt) -and ((Get-Item -LiteralPath $receipt).Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
    if ($hook.source -in @('compact', 'clear')) {
        foreach ($entry in Get-ChildItem -LiteralPath $folder -File) { if ($entry.Name -match '^[a-f0-9]{32}$') { [IO.File]::Delete($entry.FullName) } }
    }
    $mode = if ($hook.source -in @('compact', 'clear')) { [IO.FileMode]::Create } else { [IO.FileMode]::CreateNew }
    try { $file = [IO.File]::Open($receipt, $mode, [IO.FileAccess]::Write, [IO.FileShare]::None); $file.Dispose() }
    catch [IO.IOException] { return }
    return @{ hookSpecificOutput = @{ hookEventName = 'SessionStart'; additionalContext = $context } } | ConvertTo-Json -Depth 4 -Compress
}

try {
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $hook = [Console]::In.ReadToEnd() | ConvertFrom-Json
    # Idle notifications must not turn a completed round back into a waiting one.
    if ($Kind -eq 'notify' -and $hook.notification_type -notin @('permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog')) { exit 0 }
    $sessionId = [string]$hook.session_id
    if (-not $sessionId) { exit 0 }
    if ($Kind -eq 'session') { try { Get-AgentrixSessionContext $hook } catch { } }
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
