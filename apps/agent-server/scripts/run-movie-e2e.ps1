$p = Start-Process -FilePath "node" -ArgumentList "--import","tsx","scripts/_movie-e2e.mjs" -WorkingDirectory "d:\Code\bx-admin-agent\apps\agent-server" -RedirectStandardOutput "d:\Code\bx-admin-agent\apps\agent-server\_movie-out.txt" -RedirectStandardError "d:\Code\bx-admin-agent\apps\agent-server\_movie-err.txt" -PassThru -NoNewWindow
$p.WaitForExit(300000) | Out-Null
if ($p.HasExited) { Write-Output "EXIT=$($p.ExitCode)" } else { Write-Output "STILL_RUNNING"; $p.Kill() }
