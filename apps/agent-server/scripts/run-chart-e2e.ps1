Set-Location "d:\Code\bx-admin-agent\apps\agent-server"
$p = Start-Process -FilePath "node" -ArgumentList "scripts/_chart-e2e.mjs" `
  -WorkingDirectory "d:\Code\bx-admin-agent\apps\agent-server" `
  -RedirectStandardOutput "out-chart.txt" -RedirectStandardError "err-chart.txt" `
  -PassThru -NoNewWindow
Write-Output "started pid=$($p.Id)"
