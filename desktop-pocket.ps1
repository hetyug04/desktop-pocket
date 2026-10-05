param([ValidateSet('start','stop','status')][string]$Action = 'start', [switch]$NoQr)
$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$runRoot = Join-Path $appRoot 'run'
$pidFile = Join-Path $runRoot 'server.pid'
$configFile = Join-Path $runRoot 'config.json'
$tailscale = (Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source
if (!$tailscale -and (Test-Path 'C:\Program Files\Tailscale\tailscale.exe')) { $tailscale = 'C:\Program Files\Tailscale\tailscale.exe' }
if (!$tailscale) { throw 'Install Tailscale and sign in, then run SETUP.cmd.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
function AppProcess {
    if (!(Test-Path -LiteralPath $pidFile)) { return $null }
    $appPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $appPid" -ErrorAction SilentlyContinue
    if ($process -and $process.Name -eq 'node.exe' -and $process.CommandLine.Contains((Join-Path $appRoot 'server.mjs'))) { return $process }
    return $null
}
if ($Action -eq 'stop') {
    if (!(Test-Path -LiteralPath $configFile)) { Write-Host 'This folder is not set up. No server or Serve configuration was changed.'; exit 0 }
    $stopConfig = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    $stopHost = ([uri]$stopConfig.origin).Authority
    $stopServe = & $tailscale serve status --json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Serve; no changes made.' }
    $stopHandler = $stopServe.Web.$stopHost.Handlers.'/'
    if ($stopHandler -and $stopHandler.Proxy -ne 'http://127.0.0.1:4097') { throw 'Port 8443 belongs to another app. Nothing was stopped.' }
    & $tailscale serve --https=8443 off
    if ($LASTEXITCODE -ne 0) { throw 'Could not disable the Desktop Pocket Serve endpoint. Server was left running; retry stop.' }
    $appProcess = AppProcess
    if ($appProcess) {
        Set-Content -LiteralPath (Join-Path $runRoot 'stop.flag') -Value 'stop'
        for ($i=0; $i -lt 30; $i++) {
            if (!(Get-Process -Id $appProcess.ProcessId -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 100
        }
        if (Get-Process -Id $appProcess.ProcessId -ErrorAction SilentlyContinue) { & taskkill.exe /PID $appProcess.ProcessId /T /F | Out-Null }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host 'Desktop Pocket stopped. OpenCode on port 443 is unchanged.'
    exit
}
$tsStatus = (& $tailscale status --json | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or $tsStatus.BackendState -ne 'Running') { throw 'Connect this PC to Tailscale first.' }
$dns = $tsStatus.Self.DNSName.TrimEnd('.')
$origin = "https://${dns}:8443"
if ($Action -eq 'status') {
    Write-Host "URL: $origin"
    Write-Host "Process running: $([bool](AppProcess))"
    & $tailscale serve status
    if (!$NoQr) { & (Join-Path $appRoot 'show-phone-qr.ps1') -Origin $origin -NoOpen }
    exit
}
$existing = & $tailscale serve status --json | ConvertFrom-Json
$routeKey = "${dns}:8443"
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Serve; no changes made.' }
$existingHandler = $existing.Web.$routeKey.Handlers.'/'
if ($existingHandler -and $existingHandler.Proxy -ne 'http://127.0.0.1:4097') { throw 'Port 8443 is already used by another app. It was not changed.' }
$saved = if (Test-Path -LiteralPath $configFile) { Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json } else { $null }
$passwordFile = if ($env:DESKTOP_PASSWORD_FILE) { $env:DESKTOP_PASSWORD_FILE } elseif ($saved.passwordFile) { $saved.passwordFile } else { Join-Path $env:USERPROFILE '.opencode-remote\password.txt' }
$filesHost = if ($saved.filesHost) { $saved.filesHost } elseif ($env:DP_FILES_HOST) { $env:DP_FILES_HOST } else { [Environment]::MachineName.ToLowerInvariant() }
if ($saved.gates) { $env:DP_GATES = [string]$saved.gates }
$env:DP_FILES_HOST = $filesHost
if (!(Test-Path -LiteralPath $passwordFile)) { throw 'Machine key not found. Run SETUP.cmd first.' }
if (!(Test-Path -LiteralPath (Join-Path $appRoot 'native\DesktopBridge.exe'))) { & (Join-Path $appRoot 'build.ps1') }
New-Item -ItemType Directory -Path $runRoot,(Join-Path $appRoot 'logs') -Force | Out-Null
$config = @{origin=$origin;passwordFile=$passwordFile;filesHost=$filesHost}
if ($saved.gates) { $config.gates = $saved.gates }
$config | ConvertTo-Json | Set-Content -LiteralPath $configFile
if (!(AppProcess)) {
    if (@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object Port -eq 4097).Count) { throw 'Port 4097 is already used by another process or installation. Stop that app using its own launcher first; it was not changed.' }
    Remove-Item -LiteralPath (Join-Path $runRoot 'stop.flag') -Force -ErrorAction SilentlyContinue
    $env:DESKTOP_ORIGIN = $origin
    $env:DESKTOP_PASSWORD_FILE = $passwordFile
    $process = Start-Process -FilePath $node -ArgumentList @('"' + (Join-Path $appRoot 'server.mjs') + '"') -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $appRoot 'logs\server.log') -RedirectStandardError (Join-Path $appRoot 'logs\error.log')
    Set-Content -LiteralPath $pidFile -Value $process.Id -NoNewline
}
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try { $health = Invoke-RestMethod 'http://127.0.0.1:4097/api/health' -TimeoutSec 1; if ($health.app -eq 'desktop-pocket' -and $health.ready) { $ready=$true; break } } catch {}
    if ($process -and $process.HasExited) { break }
    Start-Sleep -Milliseconds 300
}
if (!$ready) { throw "Desktop Pocket did not become ready. Inspect $appRoot\logs\error.log" }
& $tailscale serve --bg --https=8443 http://127.0.0.1:4097
if ($LASTEXITCODE -ne 0) { throw 'Tailscale Serve failed. If HTTPS is unavailable, enable HTTPS Certificates on the DNS page of the Tailscale admin console. Funnel was not used.' }
Write-Host ''
Write-Host "Desktop Pocket: $origin"
Write-Host 'Sign in with your passkey (Face ID / Windows Hello). Password sign-in is disabled.'
Write-Host 'Private tailnet only. No firewall rule or public port required.'
if (!$NoQr) { & (Join-Path $appRoot 'show-phone-qr.ps1') -Origin $origin -EnrollmentIfNeeded }
