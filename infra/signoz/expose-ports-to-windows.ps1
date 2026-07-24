#Requires -RunAsAdministrator
# Refresh Windows -> WSL port forwards for SigNoz (run after every WSL restart).

$ErrorActionPreference = "Continue"

Write-Host "Ensuring IP Helper service is running..."
Set-Service -Name iphlpsvc -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service -Name iphlpsvc -ErrorAction SilentlyContinue

$wslIp = (wsl -d Ubuntu -- hostname -I).Trim().Split(" ")[0]
if (-not $wslIp) {
  Write-Error "Could not get WSL IP. Is Ubuntu WSL running?"
  exit 1
}
Write-Host "WSL IP: $wslIp"

# Keep SigNoz up
wsl -d Ubuntu -- bash -lc "sudo service docker start >/dev/null 2>&1; cd /mnt/d/project/SignozHack/infra/signoz/pours/deployment && sudo docker compose up -d >/dev/null 2>&1"

foreach ($port in 8000, 8080, 4317, 4318) {
  netsh interface portproxy delete v4tov4 listenport=$port listenaddress=127.0.0.1 2>$null | Out-Null
  netsh interface portproxy add v4tov4 listenport=$port listenaddress=127.0.0.1 connectport=$port connectaddress=$wslIp | Out-Null
  Write-Host "  127.0.0.1:$port -> ${wslIp}:$port"
}

Write-Host ""
netsh interface portproxy show all
Write-Host ""
Write-Host "Waiting for SigNoz UI..."
$ok = $false
for ($i = 1; $i -le 24; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/v1/health" -UseBasicParsing -TimeoutSec 3
    Write-Host "UI OK: $($r.Content)"
    $ok = $true
    break
  } catch {
    Write-Host "  try $i ..."
    Start-Sleep -Seconds 5
  }
}

try {
  $m = Invoke-WebRequest -Uri "http://127.0.0.1:8000/livez" -UseBasicParsing -TimeoutSec 3
  Write-Host "MCP OK: $($m.Content)"
} catch {
  Write-Host "MCP not reachable yet: $($_.Exception.Message)"
}

if (-not $ok) {
  Write-Host ""
  Write-Host "Still failing. Open http://localhost:8080 again after ~30s,"
  Write-Host "or run: wsl -d Ubuntu -- curl -s http://127.0.0.1:8080/api/v1/health"
  exit 1
}

Write-Host ""
Write-Host "Open: http://localhost:8080"
Write-Host "MCP:  http://localhost:8000/livez"
