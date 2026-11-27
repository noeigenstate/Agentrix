$ErrorActionPreference = 'Continue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'refresh-path.ps1')
$global:AgentrixSession = Get-Content -LiteralPath $env:AGENTRIX_BOOTSTRAP -Raw -Encoding UTF8 | ConvertFrom-Json
$bootstrapVersion = $global:AgentrixSession.version
if ($global:AgentrixSession.PSObject.Properties['version'] -and
    (($bootstrapVersion -isnot [int] -and $bootstrapVersion -isnot [long] -and $bootstrapVersion -isnot [double]) -or $bootstrapVersion -ne 1 -or
        $global:AgentrixSession.format -cne 'agentrix.bootstrap')) {
    throw 'Unsupported Agentrix bootstrap format or version.'
}
if ($global:AgentrixSession.PSObject.Properties['format'] -and $global:AgentrixSession.format -cne 'agentrix.bootstrap') {
    throw 'Unsupported Agentrix bootstrap format.'
}
# The shim folder goes only to the Claude Code the claude wrapper starts (Set-AgentrixPlanner): this terminal, its scripts and
# whatever else it runs find the real CLIs, and Find-AgentrixProgram skips the folder too.
Remove-Item Env:AGENTRIX_DISPATCH_DEPTH, Env:AGENTRIX_RUN_ID, Env:AGENTRIX_RUN_PROOF, Env:AGENTRIX_SHIM_NODE -ErrorAction SilentlyContinue
$global:AgentrixEventSequence = 0
$global:AgentrixIntercept = if ($global:AgentrixSession.shims) { Join-Path $global:AgentrixSession.shims 'intercept.cjs' } else { Join-Path $PSScriptRoot 'shims/intercept.cjs' }
$global:AgentrixNode = if ($global:AgentrixSession.nodePath) { $global:AgentrixSession.nodePath } else { $env:AGENTRIX_NODE }
Remove-Item Env:AGENTRIX_ACCOUNT_BASELINE -ErrorAction SilentlyContinue
# agent.ps1 (Command Prompt terminals) loads the wrappers below and keeps its own directory.
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
$global:AgentrixAgyCommand = if ($env:AGENTRIX_AGY_EXECUTABLE -and [IO.File]::Exists($env:AGENTRIX_AGY_EXECUTABLE)) {
    $env:AGENTRIX_AGY_EXECUTABLE
} else { Find-AgentrixProgram agy }

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

function global:ConvertFrom-AgentrixWireFields([string]$Text, [string]$Format) {
    if ([Text.Encoding]::UTF8.GetByteCount($Text) -gt 16384) { return }
    $Text = $Text.TrimStart([char]0xFEFF)
    if ($Text.EndsWith("`n")) { $Text = $Text.Substring(0, $Text.Length - 1) }
    $fields = @{}
    foreach ($line in $Text.Split([char]10)) {
        $key, $value = $line -csplit '=', 2
        if ($key -cnotmatch '\A[a-z][a-z0-9_]*\z' -or $null -eq $value -or $value -match '[\r\x00]' -or $fields.ContainsKey($key)) { return }
        $fields[$key] = $value
    }
    if ($fields.format -ceq $Format -and $fields.ContainsKey('version')) { return $fields }
}

function global:Get-AgentrixSessionMode {
    if (-not $env:AGENTRIX_BOOTSTRAP) { return }
    try {
        $text = [IO.File]::ReadAllText($env:AGENTRIX_BOOTSTRAP + '.mode.env', [Text.Encoding]::UTF8)
        $fields = ConvertFrom-AgentrixWireFields $text 'agentrix.session-mode'
        if ($fields.version -ceq '1' -and $fields.mode -cin @('native', 'conductor')) { return $fields.mode }
    } catch [IO.FileNotFoundException] {
        try { return [IO.File]::ReadAllText($env:AGENTRIX_BOOTSTRAP + '.mode').Trim() } catch { }
    } catch { }
}

function global:Get-AgentrixLeadFields {
    try {
        $text = [IO.File]::ReadAllText($env:AGENTRIX_BOOTSTRAP + '.lead.env', [Text.Encoding]::UTF8)
        $fields = ConvertFrom-AgentrixWireFields $text 'agentrix.lead-seat'
        if ($fields -and $fields.version -cne '1') {
            Write-Host '座位文件版本不受支持'
            return
        }
        if ($fields.ultracode -cmatch '\A[01]\z' -and $fields.seats) { return $fields }
    } catch [IO.FileNotFoundException] {
        try { $lead = [IO.File]::ReadAllLines($env:AGENTRIX_BOOTSTRAP + '.lead', [Text.Encoding]::UTF8) } catch { return }
        if ($lead.Length -lt 3) { return }
        # Old files put the seat map on line 6, after two retired fields.
        $seatIndex = if ($lead.Length -ge 6) { 5 } else { 3 }
        return @{ model = $lead[0]; effort = $lead[1]; fast = $lead[2]; seats = $lead[$seatIndex]
            ultracode = [int]($lead.Length -eq 5 -and $lead[4] -ceq 'ultracode') }
    } catch { }
}

function global:Get-AgentrixClaudeLaunch([bool]$Conversation, $Hooks) {
    $launch = @{ Model = ''; Effort = ''; Env = @{}; HookSettings = $Hooks.settings; Ultracode = $false }
    if (-not $Conversation -or -not $env:AGENTRIX_BOOTSTRAP) { return $launch }
    $launch.Env.AGENTRIX_SEATS = 'null'
    $lead = Get-AgentrixLeadFields
    $modelPattern = '\A[A-Za-z0-9][A-Za-z0-9_.:@+/\[\]-]{0,159}\z'
    if (-not $lead -or $lead.model -cnotmatch $modelPattern -or $lead.effort -cnotmatch '^[a-z][a-z0-9-]{0,31}$' -or $lead.fast -cnotmatch '^[01]$') { return $launch }
    $launch.Model = $lead.model; $launch.Effort = $lead.effort
    if ($lead.fast -eq '1' -and $Hooks.fastSettings) { $launch.HookSettings = $Hooks.fastSettings }
    if ($lead.seats -like '{*') { $launch.Env.AGENTRIX_SEATS = $lead.seats }
    $launch.Ultracode = $lead.ultracode -eq '1' -and (Get-AgentrixSessionMode) -ceq 'conductor'
    return $launch
}

# Windows PowerShell cannot pass quoted native arguments intact. Give Node a JSON array over the environment.
function global:Invoke-AgentrixLaunchPlan([string[]]$Words, [hashtable]$Fields = @{}) {
    $previous = @{}
    $Fields.ELECTRON_RUN_AS_NODE = '1'
    $Fields.AGENTRIX_LAUNCH_WIRE = '1'
    $Fields.AGENTRIX_INTERCEPT_ARGV = ConvertTo-Json -InputObject $Words -Compress
    try {
        foreach ($name in $Fields.Keys) {
            $previous[$name] = [Environment]::GetEnvironmentVariable($name)
            [Environment]::SetEnvironmentVariable($name, $Fields[$name])
        }
        $result = Invoke-AgentrixExecutable $global:AgentrixNode @($global:AgentrixIntercept) -Capture
        if ($result.ExitCode -ne 0) {
            $failure = [InvalidOperationException]::new('Agentrix could not prepare the terminal launch.')
            $failure.Data['ExitCode'] = $result.ExitCode
            throw $failure
        }
        return $result.Output
    } finally { Restore-AgentrixEnvironment $previous }
}

function global:Set-AgentrixPlanner([string]$Agent, $Launch, [string]$SettingsFile, [string]$Note, [string[]]$Arguments) {
    $target = if ($global:AgentrixSession.shims -and [IO.File]::Exists($global:AgentrixSession.nodePath)) { 'shims' } else { 'plain' }
    $fields = @{
        AGENTRIX_LAUNCH_MODEL = $Launch.Model; AGENTRIX_LAUNCH_EFFORT = $Launch.Effort
        AGENTRIX_LAUNCH_SETTINGS = $SettingsFile; AGENTRIX_LAUNCH_NOTE = $Note
    }
    foreach ($name in $Launch.Env.Keys) { $fields[$name] = $Launch.Env[$name] }
    $words = Invoke-AgentrixLaunchPlan (@('--launch', $Agent, 'json', $target) + $Arguments) $fields | ConvertFrom-Json -ErrorAction Stop
    if (($words.v -isnot [int] -and $words.v -isnot [long]) -or $words.v -ne 1 -or $words.type -cne 'launch.words' -or
        $words.unset -isnot [array] -or $words.env -isnot [pscustomobject] -or $words.argv -isnot [array]) {
        throw 'Unsupported Agentrix terminal launch plan.'
    }
    $changes = @{}
    foreach ($name in $words.unset) { $changes[$name] = $null }
    foreach ($entry in $words.env.PSObject.Properties) { $changes[$entry.Name] = $entry.Value }
    foreach ($name in $Launch.Env.Keys) { $changes[$name] = $Launch.Env[$name] }
    $previous = @{}
    try {
        foreach ($name in $changes.Keys) {
            $previous[$name] = [Environment]::GetEnvironmentVariable($name)
            [Environment]::SetEnvironmentVariable($name, $changes[$name])
        }
    } catch {
        Restore-AgentrixEnvironment $previous
        throw
    }
    return @{ Previous = $previous; Arguments = $words.argv }
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
function global:Invoke-AgentrixClaudeShim([string]$Launcher, [string[]]$PrefixArguments, [string[]]$Arguments) {
    $extension = [IO.Path]::GetExtension($Launcher)
    $inlineConfig = if ($PrefixArguments.Count) { $PrefixArguments[0].IndexOf('={', [StringComparison]::Ordinal) } else { -1 }
    if ($extension -notin @('.cmd', '.ps1') -or $inlineConfig -lt 0) {
        if ($MyInvocation.ExpectingInput) { $input | & $Launcher @PrefixArguments @Arguments }
        else { & $Launcher @PrefixArguments @Arguments }
        return
    }
    $prefix = $PrefixArguments[0].Substring(0, $inlineConfig + 1)
    $file = $null
    $configArgs = @()
    try {
        try {
            $file = New-AgentrixClaudeSettingsPath ([IO.Path]::GetDirectoryName($env:AGENTRIX_BOOTSTRAP)) '-mcp config.json'
            if ($extension -eq '.cmd' -and $file -match '[%!]') { throw 'The config path contains characters that cmd.exe can expand.' }
            [IO.File]::WriteAllText($file, $PrefixArguments[0].Substring($prefix.Length), [Text.UTF8Encoding]::new($false))
            $configArgs = @($prefix + $file)
        } catch { throw '无法写入角色工具设置。请检查目录权限和可用磁盘空间。' }
        $remaining = @($PrefixArguments | Select-Object -Skip 1)
        if ($MyInvocation.ExpectingInput) { $input | & $Launcher @configArgs @remaining @Arguments }
        else { & $Launcher @configArgs @remaining @Arguments }
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
    param([string]$FileName, [string[]]$Arguments, [switch]$Capture, [Collections.IEnumerator]$InputLines)
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FileName
    $startInfo.Arguments = ($Arguments | ForEach-Object { ConvertTo-AgentrixArgument $_ }) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.WorkingDirectory = (Get-Location).ProviderPath
    $startInfo.RedirectStandardInput = $null -ne $InputLines
    if ($Capture) {
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    }
    $process = [Diagnostics.Process]::Start($startInfo)
    try {
        if ($Capture) { $stderrDrain = $process.StandardError.ReadToEndAsync() }
        if ($null -ne $InputLines) {
            $writer = [IO.StreamWriter]::new($process.StandardInput.BaseStream, [Text.UTF8Encoding]::new($false))
            try { while ($InputLines.MoveNext()) { $writer.WriteLine([string]$InputLines.Current) } }
            catch [IO.IOException] { }
            finally { try { $writer.Dispose() } catch [IO.IOException] { } }
        }
        if ($Capture) { $output = $process.StandardOutput.ReadToEnd() }
        $process.WaitForExit()
        if ($Capture) { [void]$stderrDrain.GetAwaiter().GetResult(); return @{ ExitCode = $process.ExitCode; Output = $output } }
        return $process.ExitCode
    } finally { $process.Dispose() }
}

function global:Send-AgentrixEvent {
    param([string]$Type, [int]$ExitCode = 0, [string]$Agent = 'codex', [string]$Command = '', [string[]]$Arguments = @())
    $global:AgentrixEventSequence++
    try {
        $eventData = @{
            v = 1
            projectId = $global:AgentrixSession.projectId
            sessionKey = $global:AgentrixSession.sessionKey
            type = $Type
            sequence = $global:AgentrixEventSequence
            exitCode = $ExitCode
            agent = $Agent
            codexAvailable = [bool]$global:AgentrixCodexCommand
            claudeAvailable = [bool]$global:AgentrixClaudeCommand
            codexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.codex' } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' })
            cwd = (Get-Location).ProviderPath
            command = $Command
        }
        if ($Type -eq 'agent-started' -and $PSBoundParameters.ContainsKey('Arguments')) {
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
                if ($Type -eq 'agent-started') {
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

function global:Write-AgentrixLaunchError([int]$Code, [string]$Reason, [string]$Remedy) {
    [Console]::Error.WriteLine("Agentrix：$Reason（退出码 $Code）。$Remedy。")
    $global:LASTEXITCODE = $Code
}

# The owner shell keeps PowerShell's pipeline and executable quoting behavior.
function global:agentrix_agent {
    $agent = [string]$args[0]
    $arguments = @($args | Select-Object -Skip 1)
    $native = (Get-AgentrixSessionMode) -ceq 'native'
    $mode = if ($native) { 'native' } else { 'conductor' }
    if (-not $native -and $global:AgentrixSession.shims -and -not [IO.File]::Exists($global:AgentrixIntercept)) {
        Write-AgentrixLaunchError 1 '无法加载角色工具' '请重开终端，若仍失败请重新安装 Agentrix'
        return
    }
    try { $output = Invoke-AgentrixLaunchPlan (@('--launch', $agent, 'classify', $mode) + $arguments) }
    catch {
        $exitCode = $_.Exception.Data['ExitCode']
        if (-not $exitCode) { $exitCode = 1 }
        Write-AgentrixLaunchError $exitCode '无法判断启动方式' '请重开终端后重试'
        return
    }
    $classification = ConvertFrom-AgentrixWireFields $output 'agentrix.launch-route'
    $route = $classification.route
    if ($classification.version -cne '1' -or $route -cnotin @('passthrough', 'native', 'refused', 'conversation', 'utility', 'print')) {
        $code = if ($classification.version -and $classification.version -cne '1') { 3 } else { 2 }
        Write-AgentrixLaunchError $code '启动方式的数据格式或版本不受支持' '请重开终端后重试'
        return
    }
    $program = @{
        codex = @{ command = $global:AgentrixCodexCommand; label = 'Codex' }
        agy = @{ command = $global:AgentrixAgyCommand; label = 'agy'; requiresExecutable = $true }
    }[$agent]
    $programFile = $program.command
    if ($program.requiresExecutable -and -not $programFile) {
        Write-AgentrixLaunchError 127 "在 PATH 中找不到 $($program.label)" '请安装后重开终端'
        return
    }
    if ($route -ceq 'passthrough') {
        if (-not $programFile) {
            Write-Host 'Codex CLI was not found in PATH. Install it, then restart this terminal.' -ForegroundColor Yellow
            $global:LASTEXITCODE = 127
        } elseif ($MyInvocation.ExpectingInput) { $input | & $programFile @arguments }
        elseif ([IO.Path]::GetExtension($programFile) -ne '.exe') { & $programFile @arguments }
        else { $global:LASTEXITCODE = Invoke-AgentrixExecutable $programFile $arguments }
        return
    }
    if ($route -ceq 'native') {
        Send-AgentrixEvent 'agent-started' -Arguments $arguments -Agent $agent
        Write-Host "已请求在原生模式打开 $($program.label)。"
        $global:LASTEXITCODE = 0
        return
    }
    if ($route -ceq 'refused') {
        Write-Host @'
模型由模型路由决定，请在模型路由中更改。
'@
        $global:LASTEXITCODE = 2
        return
    }
    if (-not $global:AgentrixClaudeCommand) {
        Write-AgentrixLaunchError 127 '在 PATH 中找不到 Claude Code' '请安装后重开终端'
        return
    }
    $conversation = $route -ceq 'conversation'
    if ($MyInvocation.ExpectingInput) { $input | Invoke-AgentrixHookAgent $agent $conversation $arguments }
    else { Invoke-AgentrixHookAgent $agent $conversation $arguments }
}

function global:codex {
    if ($MyInvocation.ExpectingInput) { $input | agentrix_agent codex @args } else { agentrix_agent codex @args }
}
function global:claude {
    if ($MyInvocation.ExpectingInput) { $input | agentrix_agent claude @args } else { agentrix_agent claude @args }
}
function global:agy {
    if ($MyInvocation.ExpectingInput) { $input | agentrix_agent agy @args } else { agentrix_agent agy @args }
}

function global:Invoke-AgentrixHookAgent([string]$Agent, [bool]$Conversation, [string[]]$Arguments) {
    $hooks = $global:AgentrixSession.hooks
    $launch = Get-AgentrixClaudeLaunch $conversation $hooks
    $launchSettings = $launch.HookSettings
    $settings = $launchSettings.fallback
    if ($hooks.channel -eq 'http') {
        $proxy = Get-AgentrixHookProxy $hooks.port
        if ($proxy) { Send-AgentrixEvent 'hook-channel' -Agent $Agent -Command $proxy } else { $settings = $launchSettings.http }
    }
    if ($launch.Ultracode) {
        $settings = if (-not $settings -or $settings -ceq '{}') { '{"ultracode":true}' }
                    else { '{"ultracode":true,' + $settings.Substring(1) }
    }
    Send-AgentrixEvent 'agent-started' -Agent $Agent -Command (Get-AgentrixCommand $Arguments)
    $currentNote = Get-AgentrixReadingNote
    # Without settings for this terminal Claude Code starts with the user's own alone, never with an empty file.
    $settingsFile = $null
    $planner = $null
    $claudeExit = 1
    try {
        if ($settings) {
            $failure = '无法写入 Claude 设置'
            $remedy = '请检查目录权限和可用磁盘空间'
            if ($env:AGENTRIX_BOOTSTRAP) { $sessionFolder = [IO.Path]::GetDirectoryName($env:AGENTRIX_BOOTSTRAP) }
            elseif ($env:AGENTRIX_READING_NOTE_FILE) { $sessionFolder = [IO.Path]::GetDirectoryName($env:AGENTRIX_READING_NOTE_FILE) }
            else { $sessionFolder = [IO.Path]::GetTempPath() }
            $settingsFile = New-AgentrixClaudeSettingsPath $sessionFolder '.json'
            [IO.File]::WriteAllText($settingsFile, $settings, [Text.UTF8Encoding]::new($false))
        }
        $failure = '无法读取启动参数，数据格式不受支持或生成失败'
        $remedy = '请重开终端后重试'
        $planner = Set-AgentrixPlanner $Agent $launch $settingsFile $currentNote $Arguments
        $failure = '无法执行 Claude Code'
        $remedy = '请检查 Claude Code 和角色工具的设置后重试'
        if ([IO.Path]::GetExtension($global:AgentrixClaudeExecutable) -eq '.exe') {
            $lines = if ($MyInvocation.ExpectingInput) { ,$input }
            $claudeExit = Invoke-AgentrixExecutable $global:AgentrixClaudeExecutable ($planner.Arguments + $Arguments) -InputLines $lines
        } else {
            $global:LASTEXITCODE = 0
            if ($MyInvocation.ExpectingInput) { $input | Invoke-AgentrixClaudeShim $global:AgentrixClaudeCommand $planner.Arguments $Arguments }
            else { Invoke-AgentrixClaudeShim $global:AgentrixClaudeCommand $planner.Arguments $Arguments }
            $claudeExit = $global:LASTEXITCODE
        }
    } catch {
        Write-AgentrixLaunchError $claudeExit $failure $remedy
    } finally {
        if ($planner) { Restore-AgentrixEnvironment $planner.Previous }
        if ($settingsFile) { Remove-Item -LiteralPath $settingsFile -Force -ErrorAction SilentlyContinue }
        Send-AgentrixEvent 'agent-exited' $claudeExit -Agent $Agent
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
