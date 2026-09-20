$ErrorActionPreference = "SilentlyContinue"
$dir = "D:\Code\bx-admin-agent\apps\agent-server\.data\traces"
$f = Get-ChildItem $dir -Filter *.jsonl | Sort-Object LastWriteTime -Descending | Select-Object -First 1
"file: " + $f.Name
Get-Content $f.FullName -Tail 1
