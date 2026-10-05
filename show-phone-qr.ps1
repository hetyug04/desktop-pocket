param([string]$Origin, [switch]$NoOpen, [switch]$EnrollmentIfNeeded)
$ErrorActionPreference='Stop'
$saved = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'run\config.json') -Raw | ConvertFrom-Json
if (!$Origin) { $Origin=$saved.origin }
$needsSetup=$false
if ($EnrollmentIfNeeded) {
    $authFile = if ($env:DP_AUTH_FILE) { $env:DP_AUTH_FILE } else { Join-Path (Split-Path $saved.passwordFile) 'passkeys.json' }
    $needsSetup=$true
    if (Test-Path -LiteralPath $authFile) {
        $store=Get-Content -LiteralPath $authFile -Raw | ConvertFrom-Json
        $needsSetup=@($store.credentials | Where-Object { !$_.removed }).Count -eq 0
    }
}
if ($needsSetup) {
    $env:DESKTOP_PASSWORD_FILE=$saved.passwordFile
    $env:DESKTOP_ORIGIN=$Origin
    $page=Join-Path (Split-Path $saved.passwordFile) 'phone-setup.html'
    & node.exe (Join-Path $PSScriptRoot 'lib\auth-cli.mjs') setup --qr-file $page
} else {
    $page=Join-Path $PSScriptRoot 'run\phone-connect.html'
    & node.exe (Join-Path $PSScriptRoot 'lib\phone-qr-cli.mjs') $Origin $page
}
if ($LASTEXITCODE -ne 0) { throw 'Phone QR generation failed.' }
if (!$NoOpen) { Start-Process -FilePath $page | Out-Null }
