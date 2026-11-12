$ErrorActionPreference = 'Continue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'refresh-path.ps1')
$global:AgentrixSession = Get-Content -LiteralPath $env:AGENTRIX_BOOTSTRAP -Raw -Encoding UTF8 | ConvertFrom-Json
$global:AgentrixEventSequence = 0
Remove-Item Env:AGENTRIX_ACCOUNT_BASELINE -ErrorAction SilentlyContinue
# agent.ps1 (Command Prompt terminals) loads only the codex and claude wrappers below and keeps its own directory.
$global:AgentrixAgentOnly = $env:AGENTRIX_AGENT_ONLY -eq '1'
if (-not $global:AgentrixAgentOnly) { Set-Location -LiteralPath $global:AgentrixSession.projectPath }
# An agent's CLI is the first file on PATH with its name, in PowerShell's own order within a folder: script, PATHEXT, bare
# name. Get-Command is not asked: for a name that is not installed it goes on to analyse every installed PowerShell
# module, which delays each terminal (and each codex or claude typed in Command Prompt) by seconds where many are installed.
function global:Find-AgentrixProgram {
    param([string]$Name)
    $extensions = if ($env:PATHEXT) { $env:PATHEXT } else { '.COM;.EXE;.BAT;.CMD' }
    $suffixes = @('.ps1') + @($extensions -split ';' | Where-Object { $_ }) + @('')
    foreach ($folder in ($env:Path -split ';')) {
        $folder = $folder.Trim().Trim('"')
        if (-not $folder) { continue }
        foreach ($suffix in $suffixes) {
            $candidate = $folder.TrimEnd('\') + '\' + $Name + $suffix
            if ([IO.File]::Exists($candidate)) { return $candidate }
        }
    }
}
$global:AgentrixCodexCommand = Find-AgentrixProgram codex
# Claude Code is the one Agentrix chose for this terminal (AGENTRIX_CLAUDE_EXECUTABLE, claude-runtime's locator) while
# that file is there; otherwise the first on PATH as above.
$global:AgentrixClaudeCommand = if ($env:AGENTRIX_CLAUDE_EXECUTABLE -and [IO.File]::Exists($env:AGENTRIX_CLAUDE_EXECUTABLE)) { $env:AGENTRIX_CLAUDE_EXECUTABLE } else { Find-AgentrixProgram claude }
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

# Runs an executable in this terminal with exactly these arguments and returns its exit code.
function global:Invoke-AgentrixExecutable {
    param([string]$FileName, [string[]]$Arguments)
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FileName
    $startInfo.Arguments = ($Arguments | ForEach-Object { ConvertTo-AgentrixArgument $_ }) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.WorkingDirectory = (Get-Location).Path
    $process = [Diagnostics.Process]::Start($startInfo)
    try { $process.WaitForExit(); return $process.ExitCode } finally { $process.Dispose() }
}

function global:Send-AgentrixEvent {
    param([string]$Type, [int]$ExitCode = 0, [string]$Agent = 'codex', [string]$Command = '', [string[]]$Arguments = @())
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
            $eventData.args = @($Arguments)
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

# Codex conversations stay native inside Agentrix: the authenticated shell event requests app-server on this
# terminal and only the host interprets the bounded argv. The CLI's own management runs (codex --help, checked
# against 0.167.0) start no conversation and run here, with the CLI's exit code; bash-integration.bash,
# zsh-integration.zsh and remote-worker.py carry the same words. Piped input (an API key for codex login
# --with-api-key) and npm's script shims run as PowerShell runs any command.
function global:codex {
    if ($args.Count -and [string]$args[0] -cin @('--version', '-V', '--help', '-h', 'help', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'archive', 'delete', 'unarchive', 'migrate-rollouts', 'migrate-nfs-db', 'exec-server', 'features')) {
        if (-not $global:AgentrixCodexCommand) {
            Write-Host 'Codex CLI was not found in PATH. Install it, then restart this terminal.' -ForegroundColor Yellow
            $global:LASTEXITCODE = 127
        } elseif ($MyInvocation.ExpectingInput) { $input | & $global:AgentrixCodexCommand @args }
        elseif ([IO.Path]::GetExtension($global:AgentrixCodexCommand) -ne '.exe') { & $global:AgentrixCodexCommand @args }
        else { $global:LASTEXITCODE = Invoke-AgentrixExecutable $global:AgentrixCodexCommand $args }
        return
    }
    Send-AgentrixEvent 'codex-started' -Arguments @($args)
    Write-Host '已请求在原生模式打开 Codex。'
    $global:LASTEXITCODE = 0
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
    $currentNote = Get-AgentrixReadingNote
    $marker = ([string]$currentNote).IndexOf(' Agentrix skill delivery: ')
    if ($marker -ge 0) { $currentNote = $currentNote.Substring(0, $marker) + ' Agentrix delivers skill instructions through its SessionStart hook.' }
    $readingNote = if ($currentNote) { @('--append-system-prompt', $currentNote) } else { @() }
    $hookCommand = @(
        ($global:AgentrixSession.powershellPath -replace '\\', '/'),
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', ('"' + ($global:AgentrixSession.claudeHookPath -replace '\\', '/') + '"'),
        '-PipeName', $global:AgentrixSession.pipeName,
        '-ProjectId', $global:AgentrixSession.projectId,
        '-SessionKey', $global:AgentrixSession.sessionKey
    ) -join ' '
    $hook = { param($kind) @{ hooks = @(@{ type = 'command'; command = ($hookCommand + ' -Kind ' + $kind); timeout = 10; async = ($kind -eq 'progress') }) } }
    $hooks = @{ UserPromptSubmit = @(& $hook 'start'); Stop = @(& $hook 'stop'); Notification = @(& $hook 'notify'); SessionStart = @(& $hook 'session') }
    foreach ($name in @('PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'ElicitationResult')) { $hooks[$name] = @(& $hook 'progress') }
    foreach ($name in @('PermissionRequest', 'Elicitation')) { $hooks[$name] = @(& $hook 'permission') }
    $settings = @{ hooks = $hooks } | ConvertTo-Json -Depth 6 -Compress
    $sessionFolder = if ($env:AGENTRIX_BOOTSTRAP) { [IO.Path]::GetDirectoryName($env:AGENTRIX_BOOTSTRAP) } elseif ($env:AGENTRIX_READING_NOTE_FILE) { [IO.Path]::GetDirectoryName($env:AGENTRIX_READING_NOTE_FILE) } else { [IO.Path]::GetTempPath() }
    $sessionName = if ($env:AGENTRIX_BOOTSTRAP) { [IO.Path]::GetFileNameWithoutExtension($env:AGENTRIX_BOOTSTRAP) } else { [IO.Path]::GetFileNameWithoutExtension($env:AGENTRIX_READING_NOTE_FILE) -replace '-skills$', '' }
    $settingsFile = Join-Path $sessionFolder ($sessionName + '-claude-settings-' + [Guid]::NewGuid().ToString('N') + '.json')
    [IO.File]::WriteAllText($settingsFile, $settings, [Text.UTF8Encoding]::new($false))
    if (-not $global:AgentrixClaudeExecutable -or [IO.Path]::GetExtension($global:AgentrixClaudeExecutable) -ne '.exe') {
        try { & $global:AgentrixClaudeCommand --settings $settingsFile @readingNote @args }
        finally {
            Remove-Item -LiteralPath $settingsFile -Force -ErrorAction SilentlyContinue
            Send-AgentrixEvent 'codex-exited' $global:LASTEXITCODE -Agent 'claude'
        }
        return
    }
    $claudeExit = 0
    try {
        # What the reading view can show (electron/features/agents/reading-note.cjs); a later --append-system-prompt of the user's wins.
        $claudeExit = Invoke-AgentrixExecutable $global:AgentrixClaudeExecutable (@('--settings', $settingsFile) + $readingNote + @($args))
    } catch {
        Write-Error $_
        $claudeExit = 1
    } finally {
        Remove-Item -LiteralPath $settingsFile -Force -ErrorAction SilentlyContinue
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
Write-Host '  Type codex to open the native view, or codex resume --last to continue.' -ForegroundColor DarkGray
Write-Host ''
Send-AgentrixEvent 'shell-ready'
