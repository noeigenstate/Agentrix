$ErrorActionPreference = 'Continue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'refresh-path.ps1')
$global:AgentrixSession = Get-Content -LiteralPath $env:AGENTRIX_BOOTSTRAP -Raw -Encoding UTF8 | ConvertFrom-Json
# The shim folder goes only to the Claude Code the claude wrapper starts (Set-AgentrixPlanner): this terminal, its scripts and
# whatever else it runs find the real CLIs, and Find-AgentrixProgram skips the folder too.
Remove-Item Env:AGENTRIX_DISPATCH_DEPTH, Env:AGENTRIX_RUN_ID, Env:AGENTRIX_RUN_PROOF, Env:AGENTRIX_SHIM_NODE -ErrorAction SilentlyContinue
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
        if (Test-Path -LiteralPath ($folder.TrimEnd('\') + '\.agentrix-shims')) { continue }
        foreach ($suffix in $suffixes) {
            $candidate = $folder.TrimEnd('\') + '\' + $Name + $suffix
            if ([IO.File]::Exists($candidate)) { return $candidate }
        }
    }
}
# Codex is the one Agentrix chose for this terminal (AGENTRIX_CODEX_EXECUTABLE, codex-runtime's locator) while that
# file is there; otherwise the first on PATH as above.
$global:AgentrixCodexCommand = if ($env:AGENTRIX_CODEX_EXECUTABLE -and [IO.File]::Exists($env:AGENTRIX_CODEX_EXECUTABLE)) { $env:AGENTRIX_CODEX_EXECUTABLE } else { Find-AgentrixProgram codex }
# Claude Code is the one Agentrix chose for this terminal (AGENTRIX_CLAUDE_EXECUTABLE, claude-runtime's locator) while
# that file is there; otherwise the first on PATH as above.
$global:AgentrixClaudeCommand = if ($env:AGENTRIX_CLAUDE_EXECUTABLE -and [IO.File]::Exists($env:AGENTRIX_CLAUDE_EXECUTABLE)) { $env:AGENTRIX_CLAUDE_EXECUTABLE } else { Find-AgentrixProgram claude }
$global:AgentrixClaudeExecutable = $global:AgentrixClaudeCommand
if ($global:AgentrixClaudeCommand -and [IO.Path]::GetExtension($global:AgentrixClaudeCommand) -in @('.ps1', '.cmd', '')) {
    $nativeClaude = Join-Path (Split-Path $global:AgentrixClaudeCommand -Parent) 'node_modules\@anthropic-ai\claude-code\bin\claude.exe'
    if (Test-Path -LiteralPath $nativeClaude) { $global:AgentrixClaudeExecutable = $nativeClaude }
}

# The proxy variable that would carry this terminal's HTTP hooks to $Port, by hook-channel.cjs's rule over the live
# environment, where every spelling is the one variable: HTTPS_PROXY or HTTP_PROXY, unless NO_PROXY exempts 127.0.0.1.
function global:Get-AgentrixHookProxy {
    param([int]$Port)
    $proxy = @('HTTPS_PROXY', 'HTTP_PROXY') | Where-Object { [Environment]::GetEnvironmentVariable($_) } | Select-Object -First 1
    if (-not $proxy) { return }
    foreach ($entry in ([string][Environment]::GetEnvironmentVariable('NO_PROXY') -split '[\s,]+')) {
        if ($entry -eq '*' -or $entry -eq '127.0.0.1' -or $entry -eq "127.0.0.1:$Port" -or ($entry.StartsWith('.') -and '127.0.0.1'.EndsWith($entry))) { return }
    }
    $proxy
}

function global:Get-AgentrixReadingNote {
    if ($env:AGENTRIX_READING_NOTE_FILE) {
        try { return [IO.File]::ReadAllText($env:AGENTRIX_READING_NOTE_FILE, [Text.Encoding]::UTF8) } catch { }
    }
    return $env:AGENTRIX_READING_NOTE
}

# Native mode: the lead is the plain CLI, so its own --model and --effort are the owner's to give.
function global:Test-AgentrixNativeMode {
    if (-not $env:AGENTRIX_BOOTSTRAP) { return $false }
    try { return ([IO.File]::ReadAllText($env:AGENTRIX_BOOTSTRAP + '.mode').Trim() -ceq 'native') } catch { return $false }
}

function global:Get-AgentrixClaudeLaunch([bool]$Conversation, $Hooks) {
    $launch = @{ LeadArgs = @(); Env = @{}; HookSettings = $Hooks.settings; Ultracode = $false }
    if (-not $Conversation -or -not $env:AGENTRIX_BOOTSTRAP) { return $launch }
    $launch.Env.AGENTRIX_SEATS = 'null'
    $lead = $null
    try { $lead = [IO.File]::ReadAllLines($env:AGENTRIX_BOOTSTRAP + '.lead', [Text.Encoding]::UTF8) } catch { }
    $modelPattern = '\A[A-Za-z0-9][A-Za-z0-9_.:@+/\[\]-]{0,159}\z'
    if ($lead.Length -lt 3 -or $lead[0] -cnotmatch $modelPattern -or
        $lead[1] -cnotmatch '^[a-z][a-z0-9-]{0,31}$' -or $lead[2] -cnotmatch '^[01]$') { return $launch }
    $launch.LeadArgs = @("--model", $lead[0], "--effort", $lead[1])
    if ($lead[2] -eq '1' -and $Hooks.fastSettings) { $launch.HookSettings = $Hooks.fastSettings }
    # Old files put the seat map on line 6, after two retired fields.
    $seatIndex = if ($lead.Length -ge 6) { 5 } else { 3 }
    if ($lead.Length -gt $seatIndex -and $lead[$seatIndex] -like '{*') { $launch.Env.AGENTRIX_SEATS = $lead[$seatIndex] }
    $launch.Ultracode = $lead.Length -eq 5 -and $lead[4] -ceq 'ultracode' -and
        (Get-Content -LiteralPath ($env:AGENTRIX_BOOTSTRAP + '.mode') -TotalCount 1 -ErrorAction SilentlyContinue) -ceq 'conductor'
    return $launch
}

# Makes the Claude Code started next a planner: intercept.cjs (withShims) names what to set, with the shims first on PATH
# at depth zero, and after a "--" word the arguments that give its conversation the role tools (none for a print or
# utility call). It reads the user's arguments from AGENTRIX_INTERCEPT_ARGV, as Windows PowerShell cannot hand a quoted
# word to Node intact. Returns those arguments and what Restore-AgentrixEnvironment puts back once it exits; when
# intercept.cjs cannot be asked, the launch goes on as a plain one.
function global:Set-AgentrixPlanner([hashtable]$LaunchEnvironment, [string[]]$Arguments) {
    $planner = @{ Previous = @{}; RoleTools = @() }
    # Set first: the tool server runs with the environment intercept.cjs is asked in, seats included.
    foreach ($name in $LaunchEnvironment.Keys) {
        $planner.Previous[$name] = [Environment]::GetEnvironmentVariable($name)
        [Environment]::SetEnvironmentVariable($name, $LaunchEnvironment[$name])
    }
    if (-not $global:AgentrixSession.shims) { return $planner }
    $electron = $env:ELECTRON_RUN_AS_NODE
    try {
        $env:ELECTRON_RUN_AS_NODE = '1'
        $env:AGENTRIX_INTERCEPT_ARGV = ConvertTo-Json -InputObject (@('--shim-env', 'json', '--role-tools', 'claude') + $Arguments) -Compress
        $words = & $global:AgentrixSession.nodePath (Join-Path $global:AgentrixSession.shims 'intercept.cjs') 2>$null | ConvertFrom-Json
    } catch { $words = @() } finally { $env:ELECTRON_RUN_AS_NODE = $electron; $env:AGENTRIX_INTERCEPT_ARGV = $null }
    $words = @($words)
    for ($index = 0; $index -lt $words.Count; $index++) {
        if ($words[$index] -ceq '--') { $planner.RoleTools = @($words | Select-Object -Skip ($index + 1)); break }
        if ($words[$index] -ceq '-u') { $name = $words[++$index]; $value = $null } else { $name, $value = $words[$index] -split '=', 2 }
        $planner.Previous[$name] = [Environment]::GetEnvironmentVariable($name)
        [Environment]::SetEnvironmentVariable($name, $value)
    }
    return $planner
}

function global:Restore-AgentrixEnvironment([hashtable]$Previous) {
    foreach ($name in $Previous.Keys) { [Environment]::SetEnvironmentVariable($name, $Previous[$name]) }
}

function global:New-AgentrixClaudeSettingsPath([string]$Folder, [string]$Suffix) {
    # Main also removes these files when the terminal exits. The note is named <session>-skills.txt.
    $name = if ($env:AGENTRIX_READING_NOTE_FILE) { [IO.Path]::GetFileNameWithoutExtension($env:AGENTRIX_READING_NOTE_FILE) -replace '-skills$', '' }
        else { [IO.Path]::GetFileNameWithoutExtension($env:AGENTRIX_BOOTSTRAP) }
    Join-Path $Folder ($name + '-claude-settings-' + [Guid]::NewGuid().ToString('N') + $Suffix)
}

# A single option word keeps Claude's variadic --mcp-config from consuming the user's prompt.
# The space in the filename makes Windows PowerShell quote the whole word for cmd.exe.
function global:Invoke-AgentrixClaudeShim([string]$Launcher, [string[]]$Arguments, [string[]]$RoleTools) {
    $prefix = '--mcp-config='
    $extension = [IO.Path]::GetExtension($Launcher)
    if ($extension -notin @('.cmd', '.ps1') -or $RoleTools.Count -ne 1 -or
        -not $RoleTools[0].StartsWith($prefix + '{', [StringComparison]::Ordinal)) {
        & $Launcher @Arguments
        return
    }
    $file = $null
    $configArgs = @()
    try {
        try {
            $file = New-AgentrixClaudeSettingsPath ([IO.Path]::GetDirectoryName($env:AGENTRIX_BOOTSTRAP)) '-mcp config.json'
            if ($extension -eq '.cmd' -and $file -match '[%!]') { throw 'The config path contains characters that cmd.exe can expand.' }
            [IO.File]::WriteAllText($file, $RoleTools[0].Substring($prefix.Length), [Text.UTF8Encoding]::new($false))
            $configArgs = @($prefix + $file)
        } catch { Write-Warning "Agentrix role tools are unavailable for this Claude launch. $($_.Exception.Message)" }
        & $Launcher @configArgs @Arguments
    } finally {
        if ($file) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
    }
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
    # Here-strings keep localized text from introducing quote tokens in legacy Windows code pages.
    Write-Host @'
已请求在原生模式打开 Codex。
'@
    $global:LASTEXITCODE = 0
}

# Claude Code reports each turn through the hooks main wrote for this terminal (hook-channel.cjs), passed with --settings,
# which merge with the user's own settings instead of replacing them: HTTP hooks, or command hooks when a proxy would
# carry them. A proxy set in this terminal since it started falls back too, and main is told why.
function global:claude {
    $utilities = @("auth", "config", "doctor", "install", "login", "logout", "mcp", "migrate-installer", "plugin", "setup-token", "update", "upgrade")
    $conversation = $utilities -cnotcontains $args[0]
    foreach ($word in $args) {
        if ($word -ceq "--") { break }
        if ($word -cmatch "^--(?:model|effort)(?:=|$)" -and -not (Test-AgentrixNativeMode)) {
            Write-Host @'
模型由模型路由决定，请在模型路由中更改。
'@
            $global:LASTEXITCODE = 2
            return
        }
        if ($word -cin @("--version", "-v", "-V", "--help", "-h")) { $conversation = $false }
    }
    if (-not $global:AgentrixClaudeCommand) {
        Write-Host 'Claude Code was not found in PATH. Install it, then restart this terminal.' -ForegroundColor Yellow
        return
    }
    $hooks = $global:AgentrixSession.hooks
    $launch = Get-AgentrixClaudeLaunch $conversation $hooks
    $launchSettings = $launch.HookSettings
    $leadArgs = $launch.LeadArgs
    $settings = $launchSettings.fallback
    if ($hooks.channel -eq 'http') {
        $proxy = Get-AgentrixHookProxy $hooks.port
        if ($proxy) { Send-AgentrixEvent 'hook-channel' -Agent 'claude' -Command $proxy } else { $settings = $launchSettings.http }
    }
    if ($launch.Ultracode) {
        $settings = if (-not $settings -or $settings -ceq '{}') { '{"ultracode":true}' }
                    else { '{"ultracode":true,' + $settings.Substring(1) }
    }
    Send-AgentrixEvent 'codex-started' -Agent 'claude' -Command (Get-AgentrixCommand $args)
    $currentNote = Get-AgentrixReadingNote
    if ($currentNote) {
        $marker = ([string]$currentNote).IndexOf(' Agentrix skill delivery: ')
        if ($marker -ge 0) { $currentNote = $currentNote.Substring(0, $marker) + ' Agentrix delivers skill instructions through its SessionStart hook.' }
    }
    # An array even when empty: an if that yields @() gives $null, which splats as an empty argument.
    $readingNote = @(if ($currentNote) { "--append-system-prompt", $currentNote })
    # Without settings for this terminal Claude Code starts with the user's own alone, never with an empty file.
    $settingsFile = $null
    $settingsArgs = @()
    if ($settings) {
        $sessionFolder = if ($env:AGENTRIX_BOOTSTRAP) { [IO.Path]::GetDirectoryName($env:AGENTRIX_BOOTSTRAP) } elseif ($env:AGENTRIX_READING_NOTE_FILE) { [IO.Path]::GetDirectoryName($env:AGENTRIX_READING_NOTE_FILE) } else { [IO.Path]::GetTempPath() }
        $settingsFile = New-AgentrixClaudeSettingsPath $sessionFolder '.json'
        [IO.File]::WriteAllText($settingsFile, $settings, [Text.UTF8Encoding]::new($false))
        $settingsArgs = @("--settings", $settingsFile)
    }
    $planner = Set-AgentrixPlanner $launch.Env @($args)
    if (-not $global:AgentrixClaudeExecutable -or [IO.Path]::GetExtension($global:AgentrixClaudeExecutable) -ne '.exe') {
        try { Invoke-AgentrixClaudeShim $global:AgentrixClaudeCommand ($settingsArgs + $readingNote + $leadArgs + @($args)) $planner.RoleTools }
        finally {
            Restore-AgentrixEnvironment $planner.Previous
            if ($settingsFile) { Remove-Item -LiteralPath $settingsFile -Force -ErrorAction SilentlyContinue }
            Send-AgentrixEvent 'codex-exited' $global:LASTEXITCODE -Agent 'claude'
        }
        return
    }
    $claudeExit = 0
    try {
        # What the reading view can show (electron/features/agents/reading-note.cjs); a later --append-system-prompt of the user's wins.
        $claudeExit = Invoke-AgentrixExecutable $global:AgentrixClaudeExecutable ($planner.RoleTools + $settingsArgs + $readingNote + $leadArgs + @($args))
    } catch {
        Write-Error $_
        $claudeExit = 1
    } finally {
        Restore-AgentrixEnvironment $planner.Previous
        if ($settingsFile) { Remove-Item -LiteralPath $settingsFile -Force -ErrorAction SilentlyContinue }
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
