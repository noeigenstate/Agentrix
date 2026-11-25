param([string]$Expected)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$text = [Console]::In.ReadToEnd()
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
