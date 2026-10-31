$ErrorActionPreference = 'Continue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'refresh-path.ps1')
$global:AgentrixSession = Get-Content -LiteralPath $env:AGENTRIX_BOOTSTRAP -Raw -Encoding UTF8 | ConvertFrom-Json
$global:AgentrixEventSequence = 0
$global:AgentrixAccountBaseline = $env:AGENTRIX_ACCOUNT_BASELINE
Remove-Item Env:AGENTRIX_ACCOUNT_BASELINE -ErrorAction SilentlyContinue
# agent.ps1 (Command Prompt terminals) loads only the codex and claude wrappers below and keeps its own directory.
$global:AgentrixAgentOnly = $env:AGENTRIX_AGENT_ONLY -eq '1'
if (-not $global:AgentrixAgentOnly) { Set-Location -LiteralPath $global:AgentrixSession.projectPath }
$global:AgentrixCodexCommand = Get-Command codex -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
$global:AgentrixCodexExecutable = $global:AgentrixCodexCommand
$global:AgentrixCodexPrefix = @()
if ($global:AgentrixCodexCommand -and [IO.Path]::GetExtension($global:AgentrixCodexCommand) -in @('.ps1', '.cmd')) {
    $npmEntry = Join-Path (Split-Path $global:AgentrixCodexCommand -Parent) 'node_modules\@openai\codex\bin\codex.js'
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
    if ((Test-Path -LiteralPath $npmEntry) -and $nodeCommand) {
        $global:AgentrixCodexExecutable = $nodeCommand
        $global:AgentrixCodexPrefix = @($npmEntry)
    }
}

$global:AgentrixClaudeCommand = Get-Command claude -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
$global:AgentrixClaudeExecutable = $global:AgentrixClaudeCommand
if ($global:AgentrixClaudeCommand -and [IO.Path]::GetExtension($global:AgentrixClaudeCommand) -in @('.ps1', '.cmd', '')) {
    $nativeClaude = Join-Path (Split-Path $global:AgentrixClaudeCommand -Parent) 'node_modules\@anthropic-ai\claude-code\bin\claude.exe'
    if (Test-Path -LiteralPath $nativeClaude) { $global:AgentrixClaudeExecutable = $nativeClaude }
}

function global:Get-AgentrixReadingNote {
    if ($env:AGENTRIX_READING_NOTE_FILE) {
        try { return [IO.File]::ReadAllText($env:AGENTRIX_READING_NOTE_FILE, [Text.Encoding]::UTF8) } catch { }
    }
    return $env:AGENTRIX_READING_NOTE
}

# Windows PowerShell 5 strips embedded quotes when forwarding native arguments.
# Build the standard Windows argv representation explicitly so notify's TOML
# array, Chinese paths, quotes and trailing backslashes reach Codex intact.
function global:ConvertTo-AgentrixArgument {
    param([string]$Value)
    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append([char]34)
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq [char]92) { $slashes++; continue }
        if ($character -eq [char]34) {
            [void]$builder.Append(([string][char]92) * ($slashes * 2 + 1))
        } else {
            [void]$builder.Append(([string][char]92) * $slashes)
        }
        [void]$builder.Append($character)
        $slashes = 0
    }
    [void]$builder.Append(([string][char]92) * ($slashes * 2))
    [void]$builder.Append([char]34)
    return $builder.ToString()
}

function global:Send-AgentrixEvent {
    param([string]$Type, [int]$ExitCode = 0, [string]$Agent = 'codex', [string]$Command = '', [string]$AccountLaunch = '')
    $global:AgentrixEventSequence++
    try {
        $eventData = @{
            projectId = $global:AgentrixSession.projectId
            sessionKey = $global:AgentrixSession.sessionKey
            type = $Type
            sequence = $global:AgentrixEventSequence
            exitCode = $ExitCode
            agent = $Agent
            codexAvailable = [bool]$global:AgentrixCodexCommand
            claudeAvailable = [bool]$global:AgentrixClaudeCommand
            codexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.codex' } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' })
            cwd = (Get-Location).Path
            command = $Command
        }
        if ($Type -eq 'codex-started' -and $Agent -eq 'codex') {
            $eventData.accountLaunch = if ($AccountLaunch -ceq 'model-only-v1') { 'model-only-v1' } else { 'unavailable' }
        }
        $eventData = $eventData | ConvertTo-Json -Compress
        $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $global:AgentrixSession.pipeName, [System.IO.Pipes.PipeDirection]::InOut)
        try {
            $pipe.Connect(750)
            $writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false), 1024, $true)
            try {
                $writer.WriteLine($eventData); $writer.Flush()
                # The main process closes the pipe after writing this launch's agent-specific note.
                if ($Type -eq 'codex-started') {
                    $ack = [byte[]]::new(1)
                    [void]$pipe.ReadAsync($ack, 0, 1).Wait(1500)
                }
            } finally { $writer.Dispose() }
        } finally { $pipe.Dispose() }
    } catch { }
}

# The first word given to an agent's CLI when it is a subcommand or an option (update, --version): Agentrix tells such a
# run from a conversation by it (electron/features/agents/agent-command.cjs). Anything else is not sent.
function global:Get-AgentrixCommand($arguments) {
    $first = if ($arguments.Count) { [string]$arguments[0] } else { '' }
    if ($first -cmatch '^-{0,2}[A-Za-z][A-Za-z-]{0,23}$') { $first } else { '' }
}

# Owned helper, bounded and silent. Full argv goes only through its private stdin;
# the event receives a capability, never a prompt, config or credential value.
function global:Get-AgentrixAccountLaunch($arguments) {
    $scopeProcess = $null
    try {
        if (-not $global:AgentrixAccountBaseline -or -not $global:AgentrixSession.nodePath -or -not $global:AgentrixSession.accountScopeHelper) { return 'unavailable' }
        $info = [Diagnostics.ProcessStartInfo]::new()
        $info.FileName = $global:AgentrixSession.nodePath
        $info.Arguments = ConvertTo-AgentrixArgument $global:AgentrixSession.accountScopeHelper
        $info.UseShellExecute = $false; $info.CreateNoWindow = $true
        $info.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
        $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
        $scopeProcess = [Diagnostics.Process]::Start($info)
        $output = $scopeProcess.StandardOutput.ReadToEndAsync()
        $diagnostics = $scopeProcess.StandardError.ReadToEndAsync()
        $payload = @{ args = @($arguments); baseline = ($global:AgentrixAccountBaseline | ConvertFrom-Json) } | ConvertTo-Json -Depth 5 -Compress
        $scopeProcess.StandardInput.Write($payload); $scopeProcess.StandardInput.Close()
        if (-not $scopeProcess.WaitForExit(3000)) { $scopeProcess.Kill(); return 'unavailable' }
        if ($scopeProcess.ExitCode -eq 0 -and $output.Result -ceq 'model-only-v1') { return 'model-only-v1' }
    } catch { } finally {
        if ($scopeProcess) { try { if (-not $scopeProcess.HasExited) { $scopeProcess.Kill() } } catch { }; $scopeProcess.Dispose() }
    }
    return 'unavailable'
}

function global:codex {
    if (-not $global:AgentrixCodexCommand) {
        Write-Host 'Codex CLI was not found in PATH. Install it, then restart this terminal.' -ForegroundColor Yellow
        return
    }
    $forwardArgs = @($args)
    $notifyCommand = @(
        $global:AgentrixSession.powershellPath,
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', $global:AgentrixSession.notifyPath,
        '-PipeName', $global:AgentrixSession.pipeName,
        '-ProjectId', $global:AgentrixSession.projectId,
        '-SessionKey', $global:AgentrixSession.sessionKey
    ) | ConvertTo-Json -Compress
    Send-AgentrixEvent 'codex-started' -Command (Get-AgentrixCommand $args) -AccountLaunch (Get-AgentrixAccountLaunch $forwardArgs)
    $codexExit = 0
    try {
        if ([IO.Path]::GetExtension($global:AgentrixCodexExecutable) -ne '.exe') {
            throw 'Use a native Codex executable or the standard npm installation of Codex.'
        }
        # What the reading view can show (electron/features/agents/reading-note.cjs); the user's own -c comes later and wins.
        $currentNote = Get-AgentrixReadingNote
        $readingNote = if ($currentNote) { @('-c', ('developer_instructions="' + $currentNote + '"')) } else { @() }
        $nativeArgs = @($global:AgentrixCodexPrefix) + @('-c', ('notify=' + $notifyCommand), '-c', 'tui.terminal_title=["session-id"]') + $readingNote + $forwardArgs
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $global:AgentrixCodexExecutable
        $startInfo.Arguments = (($nativeArgs | ForEach-Object { ConvertTo-AgentrixArgument ([string]$_) }) -join ' ')
        $startInfo.UseShellExecute = $false
        $startInfo.WorkingDirectory = (Get-Location).Path
        $codexProcess = [Diagnostics.Process]::Start($startInfo)
        try { $codexProcess.WaitForExit(); $codexExit = $codexProcess.ExitCode }
        finally { $codexProcess.Dispose() }
    } catch {
        Write-Error $_
        $codexExit = 1
    } finally {
        Send-AgentrixEvent 'codex-exited' $codexExit
        $global:LASTEXITCODE = $codexExit
    }
}

# Claude Code reports each turn through hooks injected with --settings, which merge with the
# user's own settings instead of replacing them. Depending on the installation Claude runs hook
# commands through PowerShell or Git Bash, so the command must mean the same in both: the
# executable path has no spaces and stays unquoted (a quoted first word is only a string in
# PowerShell), arguments are quoted, and every path uses forward slashes.
function global:claude {
    if (-not $global:AgentrixClaudeCommand) {
        Write-Host 'Claude Code was not found in PATH. Install it, then restart this terminal.' -ForegroundColor Yellow
        return
    }
    Send-AgentrixEvent 'codex-started' -Agent 'claude' -Command (Get-AgentrixCommand $args)
    $readingNote = @('--append-system-prompt', 'Agentrix delivers this session''s instructions through its SessionStart hook.')
    $hookCommand = @(
        ($global:AgentrixSession.powershellPath -replace '\\', '/'),
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', ('"' + ($global:AgentrixSession.claudeHookPath -replace '\\', '/') + '"'),
        '-PipeName', $global:AgentrixSession.pipeName,
        '-ProjectId', $global:AgentrixSession.projectId,
        '-SessionKey', $global:AgentrixSession.sessionKey
    ) -join ' '
    $hook = { param($kind) @{ hooks = @(@{ type = 'command'; command = ($hookCommand + ' -Kind ' + $kind); timeout = 10 }) } }
    $settings = @{ hooks = @{ UserPromptSubmit = @(& $hook 'start'); Stop = @(& $hook 'stop'); Notification = @(& $hook 'notify'); SessionStart = @(& $hook 'session') } } | ConvertTo-Json -Depth 6 -Compress
    if (-not $global:AgentrixClaudeExecutable -or [IO.Path]::GetExtension($global:AgentrixClaudeExecutable) -ne '.exe') {
        try { & $global:AgentrixClaudeCommand --settings $settings @readingNote @args }
        finally { Send-AgentrixEvent 'codex-exited' $global:LASTEXITCODE -Agent 'claude' }
        return
    }
    $claudeExit = 0
    try {
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $global:AgentrixClaudeExecutable
        # What the reading view can show (electron/features/agents/reading-note.cjs); a later --append-system-prompt of the user's wins.
        $startInfo.Arguments = ((@('--settings', $settings) + $readingNote + @($args)) | ForEach-Object { ConvertTo-AgentrixArgument ([string]$_) }) -join ' '
        $startInfo.UseShellExecute = $false
        $startInfo.WorkingDirectory = (Get-Location).Path
        $claudeProcess = [Diagnostics.Process]::Start($startInfo)
        try { $claudeProcess.WaitForExit(); $claudeExit = $claudeProcess.ExitCode }
        finally { $claudeProcess.Dispose() }
    } catch {
        Write-Error $_
        $claudeExit = 1
    } finally {
        Send-AgentrixEvent 'codex-exited' $claudeExit -Agent 'claude'
        $global:LASTEXITCODE = $claudeExit
    }
}

if ($global:AgentrixAgentOnly) { return }

function global:prompt {
    Send-AgentrixEvent 'shell-prompt'
    'PS ' + (Get-Location).Path + '> '
}

# No user profile is modified. This wrapper exists only inside this terminal.
Write-Host '  AGENTRIX' -ForegroundColor DarkGray
Write-Host '  Type codex to start, or codex resume to continue a session.' -ForegroundColor DarkGray
Write-Host ''
Send-AgentrixEvent 'shell-ready'
