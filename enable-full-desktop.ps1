$ErrorActionPreference = 'Stop'
# Fetch the optional service from its official publisher, rather than redistributing the MSI.
$msi = Join-Path $PSScriptRoot 'install\tightvnc-2.8.89-gpl-setup-64bit.msi'
if (!(Test-Path -LiteralPath $msi)) {
    New-Item -ItemType Directory -Path (Split-Path $msi) -Force | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest 'https://www.tightvnc.com/download/2.8.89/tightvnc-2.8.89-gpl-setup-64bit.msi' -OutFile $msi -UseBasicParsing
}
if ((Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash -ne 'DFF8D7E40A81E0B86BA1D9D5CC0D4F22D08354C50C9CBDC0825BBB6CCFB1073C') { throw 'TightVNC installer hash mismatch. Nothing was installed.' }
$signature = Get-AuthenticodeSignature -LiteralPath $msi
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne '90513AC184484A36A6461CB7B834B68761761006') { throw 'TightVNC publisher verification failed. Nothing was installed.' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$scriptFile = Join-Path $PSScriptRoot 'install-full-desktop.ps1'
$arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $scriptFile + '" -OwnerSid "' + $sid + '"'
Write-Host 'Approve the Windows administrator prompt on the PC to install the localhost-only desktop service.'
Start-Process -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden | Out-Null
Write-Host 'Setup continues after approval. Status: run\full-install-result.json'
