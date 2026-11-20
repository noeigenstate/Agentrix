param(
    [Parameter(Mandatory=$true)][string]$PipeName,
    [Parameter(Mandatory=$true)][string]$ProjectId,
    [Parameter(Mandatory=$true)][string]$SessionKey,
    [Parameter(Mandatory=$true)][ValidateSet('start', 'stop', 'stop-failed', 'notify', 'session', 'progress', 'permission', 'seat-routing')][string]$Kind,
    [string]$NoteFile = $env:AGENTRIX_READING_NOTE_FILE,
    [string]$NodePath
)

# Claude Code hook: UserPromptSubmit reports a working turn, Stop reports a finished one, StopFailure one that ended in an
# API error (an interrupted round, never a completed one), SessionStart the
# conversation Claude writes now (after /clear, /resume or a new start it is another file).
# SessionStart prints instructions. The separate seat-routing hook can print tool input or a notice.
$ErrorActionPreference = 'Stop'

if ($Kind -eq 'seat-routing') {
    try {
        if (-not $NodePath) { exit 0 }
        $start = [Diagnostics.ProcessStartInfo]::new($NodePath)
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        $start.StandardOutputEncoding = [Console]::OutputEncoding
        $inputBuffer = [char[]]::new(4194305)
        $length = [Console]::In.ReadBlock($inputBuffer, 0, $inputBuffer.Length)
        if ($length -ge $inputBuffer.Length) { exit 0 }
        $start.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
        $helper = Join-Path $PSScriptRoot 'agent-event.cjs'
        $start.Arguments = '"{0}" claude-hook "\\.\pipe\{1}" "{2}" "{3}" seat-routing' -f $helper, $PipeName, $ProjectId, $SessionKey
        $child = [Diagnostics.Process]::Start($start)
        try {
            $output = $child.StandardOutput.ReadToEndAsync()
            $write = $child.StandardInput.WriteAsync($inputBuffer, 0, $length)
            if (-not $write.Wait(1500)) { $child.Kill(); exit 0 }
            $child.StandardInput.Close()
            if ($child.WaitForExit(2500)) { [Console]::Out.Write($output.Result) }
            else { $child.Kill() }
        } finally { $child.Dispose() }
    } catch { }
    exit 0
}

function Get-AgentrixSessionContext($hook) {
    if ($hook.session_id -notmatch '^[A-Za-z0-9_-]{1,160}$' -or $hook.source -notin @('startup', 'resume', 'compact', 'clear') -or -not $NoteFile) { return }
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
    if ($hook.source -in @('compact', 'clear')) {
        try {
            $metadataFile = $manifest + '.json'
            $metadataInfo = Get-Item -LiteralPath $metadataFile
            if (-not ($metadataInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $metadataInfo.Length -le 2097152) {
                $metadata = [IO.File]::ReadAllText($metadataFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
                $current = [string]$metadata.current
                if ($metadata.fingerprint -eq $marker.Groups[1].Value -and [IO.Path]::IsPathRooted($current) -and
                    [IO.Path]::GetDirectoryName($current) -eq [IO.Path]::GetDirectoryName($manifest)) {
                    $currentInfo = Get-Item -LiteralPath $current
                    if (-not ($currentInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $currentInfo.Length -le 2097152) {
                        $context = "Agentrix skill instructions:`n" + [IO.File]::ReadAllText($current, [Text.Encoding]::UTF8)
                    }
                }
            }
        } catch { }
    }
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
    $sentAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
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
        state = $(if ($Kind -in @('notify', 'permission')) { 'attention' } elseif ($Kind -eq 'stop') { 'complete' } elseif ($Kind -eq 'stop-failed') { 'failed' } elseif ($Kind -eq 'session') { 'session' } elseif ($Kind -eq 'progress') { 'progress' } else { 'working' })
        message = $(if ($Kind -in @('notify', 'permission')) { $text = if ($null -ne $hook.message) { [string]$hook.message } else { [string]$hook.tool_name }; $text.Substring(0, [Math]::Min(300, $text.Length)) } else { $null })
        sentAt = $sentAt
        hookEvent = [string]$hook.hook_event_name
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
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [System.IO.Pipes.PipeDirection]::Out)
    try {
        $pipe.Connect(750)
        $writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false))
        try { $writer.WriteLine($eventData); $writer.Flush() } finally { $writer.Dispose() }
    } finally { $pipe.Dispose() }
} catch { }
exit 0
