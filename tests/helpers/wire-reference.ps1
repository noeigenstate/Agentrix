param([string]$Expected, [string]$Kind = 'kv')
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$text = [Console]::In.ReadToEnd()
if ($Kind -ceq 'envelope') {
    $value = $text | ConvertFrom-Json
    $key = if ($Expected) { 'version' } else { 'v' }
    $legacy = -not $value.PSObject.Properties[$key]
    $version = if ($legacy) { 0 } else { $value.PSObject.Properties[$key].Value }
    if (-not $legacy -and ($version -isnot [int] -or $version -ne 1)) { exit 3 }
    if ($Expected -and (-not $legacy -or $value.PSObject.Properties['format']) -and $value.format -cne $Expected) { exit 2 }
    [Console]::Write((@{ value = $value; version = $version; legacy = $legacy } | ConvertTo-Json -Depth 12 -Compress))
    exit 0
}
if ($Kind -ceq 'words') {
    if (-not $text.EndsWith([string][char]0)) { exit 2 }
    $plan = @{ v = 1; type = 'launch.words'; unset = @(); env = @{}; argv = @() }
    $header = @{}
    foreach ($row in $text.Substring(0, $text.Length - 1).Split([char]0)) {
        $key, $value = $row -csplit '=', 2
        if ($null -eq $value) { exit 2 }
        switch -CaseSensitive ($key) {
            { $_ -cin @('format', 'version') } { if ($header.ContainsKey($key)) { exit 2 }; $header[$key] = $value }
            'unset' { $plan.unset += $value }
            'env'   { $name, $content = $value -csplit '=', 2; $plan.env[$name] = $content }
            'arg'   { $plan.argv += $value }
        }
    }
    if ($header.format -cne $Expected) { exit 2 }
    if ($header.version -cne '1') { exit 3 }
    [Console]::Write(($plan | ConvertTo-Json -Depth 12 -Compress))
    exit 0
}
if ($text.StartsWith([string][char]0xFEFF, [StringComparison]::Ordinal)) { $text = $text.Substring(1) }
if ($text.EndsWith("`n")) { $text = $text.Substring(0, $text.Length - 1) }
$fields = @{}
foreach ($line in $text.Split([char]10)) {
    $key, $value = $line -split '=', 2
    if ($key -cnotmatch '\A[a-z][a-z0-9_]*\z' -or $null -eq $value -or $value -match '[\r\x00]' -or $fields.ContainsKey($key)) { exit 2 }
    $fields[$key] = $value
    [Console]::Write("$key=$value`n")
}
if ($fields.format -cne $Expected -or -not $fields.ContainsKey('version')) { exit 2 }
if ($fields.version -cne '1') { exit 3 }
exit 0
