$root = "d:\Code\bx-admin-agent\apps\agent-server\.data"
Write-Host "=== glm5turbo ex-* (answerable) ==="
Get-Content "$root\analytics-eval-glm5turbo.log" -Encoding UTF8 | Select-String 'RUN ex-'
Write-Host ""
Write-Host "=== summary per model ==="
foreach ($m in @("glm5turbo","dsflash","dspro")) {
  $lines = Get-Content "$root\analytics-eval-$m.log" -Encoding UTF8
  $s = ($lines | Select-String '  answerable=' | Select-Object -Last 1)
  Write-Host "$m : $s"
}
