$ErrorActionPreference = "SilentlyContinue"
"before: " + (netstat -ano | Select-String ":8787.*LISTENING" | Select-Object -First 1)
(Get-Item "D:\Code\bx-admin-agent\apps\agent-server\src\chat.ts").LastWriteTime = Get-Date
Start-Sleep -Seconds 5
"after : " + (netstat -ano | Select-String ":8787.*LISTENING" | Select-Object -First 1)
"---- health ----"
try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/health -TimeoutSec 5).Content } catch { "health fail: $_" }
