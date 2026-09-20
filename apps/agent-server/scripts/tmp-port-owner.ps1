$ErrorActionPreference = "SilentlyContinue"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  "{0} <- parent {1}`n    {2}" -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine
}
"---- port 8787 ----"
netstat -ano | Select-String ":8787" | Select-Object -First 4
