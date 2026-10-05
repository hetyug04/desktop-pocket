param([ValidateSet('setup','status','recovery','signout-all')][string]$Action='setup')
$ErrorActionPreference='Stop'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'run\config.json') -Raw | ConvertFrom-Json
$env:DESKTOP_PASSWORD_FILE = $config.passwordFile
$env:DESKTOP_ORIGIN = $config.origin
if ($Action -in @('setup','recovery')) {
    $page = Join-Path (Split-Path $config.passwordFile) 'phone-setup.html'
    & node.exe (Join-Path $PSScriptRoot 'lib\auth-cli.mjs') $Action --qr-file $page
    $result = $LASTEXITCODE
    if ($result -eq 0 -and (Test-Path -LiteralPath $page)) { Start-Process -FilePath $page | Out-Null }
    exit $result
}
& node.exe (Join-Path $PSScriptRoot 'lib\auth-cli.mjs') $Action
exit $LASTEXITCODE
