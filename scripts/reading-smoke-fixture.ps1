# Only the isolated offline smoke's PowerShell. Ordinary prompts leave permission/question frames untouched.
# Newer PSReadLine paints history predictions in the input row (for example, the old " 42" after /fix-issue).
# This fake CLI needs literal physical echoes, without shell suggestions. PSReadLine 2.0 has no prediction option.
if ((Get-Command Set-PSReadLineOption).Parameters.ContainsKey('PredictionSource')) {
    Set-PSReadLineOption -PredictionSource None
}
$global:ReadingFixtureInputRow = $null
# The smoke reads this log from the other side while an antivirus or indexer may hold it for a moment: a failed append is tried again
# (Add-Content only reports a non-terminating error and the line is lost, so the smoke waits for it until its timeout).
function global:Write-ReadingFixtureLog {
    param([string]$Line)
    if (-not $env:READING_FIXTURE_ENTER_LOG) { return }
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try { [IO.File]::AppendAllText($env:READING_FIXTURE_ENTER_LOG, $Line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false)); return }
        catch { Start-Sleep -Milliseconds 25 }
    }
}
function global:prompt {
    if ($global:ReadingFixtureClearOnPrompt) {
        Clear-Host
        $global:ReadingFixtureClearOnPrompt = $false
    }
    if ($global:ReadingFixtureSlashSubmitted) {
        # PowerShell has actually executed the submitted slash command. Keep its echo and real error/output,
        # then append the next CLI input so the live popup retains the result.
        $global:ReadingFixtureSlashSubmitted = $false
        Show-ReadingFixtureInput
    }
    if ($null -ne $global:ReadingFixtureInputRow) {
        [Console]::SetCursorPosition(1, [int]$global:ReadingFixtureInputRow)
        $global:ReadingFixtureInputRow = $null
    }
    ' '
}
function global:Show-ReadingFixtureInput {
    Write-Host ([string][char]0x2500 * 40)
    Write-Host ([string][char]0x276F + ' ')
    Write-Host ([string][char]0x2500 * 40)
    Write-Host ('  ' + [char]0x23F8 + ' manual mode on')
    # Drawing at the bottom can scroll the console. Capture the input row after all four lines have landed.
    $global:ReadingFixtureInputRow = [Console]::CursorTop - 3
}
# Claude Code's busy screen: the spinner line is redrawn in place for a while, its input box below it untouched.
function global:Stream-ReadingFixtureWork {
    param([int]$Seconds = 5, [int]$IntervalMs = 100, [switch]$Redraw)
    Clear-Host
    Write-Host ([string][char]0x2736 + ' Osmosing' + [char]0x2026)
    Show-ReadingFixtureInput
    $glyphs = @([char]0x2736, [char]0x2733, [char]0x2722, [char]0x273B)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $step = 0
    while ($clock.Elapsed.TotalSeconds -lt $Seconds) {
        [Console]::SetCursorPosition(0, 0)
        Write-Host ($glyphs[$step % 4] + ' Osmosing' + [char]0x2026 + ' (' + [int]$clock.Elapsed.TotalSeconds + 's ' + [char]0x00B7 + ' esc to interrupt)  ') -NoNewline
        if ($Redraw) {
            # Claude Code's renderer repaints its whole live region on every update, the input box included.
            [Console]::SetCursorPosition(0, 1); Write-Host ([string][char]0x2500 * 40) -NoNewline
            [Console]::SetCursorPosition(0, 2); Write-Host ([string][char]0x276F + ' ') -NoNewline
            [Console]::SetCursorPosition(0, 3); Write-Host ([string][char]0x2500 * 40) -NoNewline
            [Console]::SetCursorPosition(0, 4); Write-Host ('  ' + [char]0x23F8 + ' manual mode on') -NoNewline
        }
        $step++
        Start-Sleep -Milliseconds $IntervalMs
    }
    # The round is over: Claude Code replaces the spinner line with its summary, which has no ellipsis.
    [Console]::SetCursorPosition(0, 0)
    Write-Host ([char]0x273B + ' Worked for ' + [int]$Seconds + 's' + (' ' * 40)) -NoNewline
    [Console]::SetCursorPosition(1, [int]$global:ReadingFixtureInputRow)
    Write-ReadingFixtureLog 'stream:done'
}
# Actual local payload execution precedes the CLI-shaped result. Echo is not a no-output command.
function global:!echo {
    param([string]$Text)
    $result = Write-Output $Text
    Clear-Host
    Write-Host ('! echo ' + $Text)
    Write-Host ('  ' + [char]0x23BF + ' ' + $result)
    Show-ReadingFixtureInput
}
function global:!true {
    & { }
    Clear-Host
    Write-Host '! true'
    Write-Host ('  ' + [char]0x23BF + ' (Bash completed with no output)')
    Show-ReadingFixtureInput
}
Set-PSReadLineKeyHandler -Key Ctrl+u -ScriptBlock { [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine() }
# Ctrl+G toggles a CLI that does not take Enter: the words stay in the input, as Claude Code leaves a message it did not submit.
# Every Enter is logged to the file the smoke names (held or submitted), so a check reads what the terminal really received.
Set-PSReadLineKeyHandler -Key Ctrl+g -ScriptBlock { $global:ReadingFixtureHoldEnter = -not $global:ReadingFixtureHoldEnter }
Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
    $line = $null
    $cursor = 0
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
    Write-ReadingFixtureLog ($(if ($global:ReadingFixtureHoldEnter) { 'held' } else { 'submitted' }) + ':' + $line)
    if ($global:ReadingFixtureHoldEnter -and $line -ne 'exit') { return } # the smoke's cleanup must always be able to end the shell
    $global:ReadingFixtureSlashSubmitted = $line.StartsWith('/')
    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
}
