# Explicit allowlist: runtime state, credentials, personal screenshots and old installers never enter the ZIP.
param([string]$OutputDir = (Join-Path (Split-Path $PSScriptRoot) 'releases'))
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$stage = Join-Path $OutputDir ('stage-' + [Guid]::NewGuid().ToString('N'))
$payload = Join-Path $stage 'DesktopPocket'; New-Item -ItemType Directory -Path $payload -Force | Out-Null
$items = @('.gitignore','.gitattributes','server.mjs','package.json','package-lock.json','desktop-pocket.ps1','setup.ps1','SETUP.cmd','START.cmd','STOP.cmd','STATUS.cmd','SECURITY-SETUP.cmd','security-setup.ps1','show-phone-qr.ps1','start-desktop-phone.cmd','stop-desktop-phone.cmd','build.ps1','enable-full-desktop.cmd','enable-full-desktop.ps1','install-full-desktop.ps1','README.md','AGENT-SETUP.md','THIRD-PARTY.md','SHARE.txt','lib','modules','public','native\DesktopBridge.cs','test\files.test.mjs','test\package.test.mjs','test\qr.test.mjs','docs\install-mac.sh','docs\SETUP.md','docs\screenshots','scripts\package-windows.ps1')
$forbidden = '(^|/)(run|logs|node_modules|test-output|releases|\.git)(/|$)|(^|/)(password\.txt|passkeys\.json|vnc\.json|config\.json|server\.pid)$|\.(exe|msi|dll|lnk|log)$'
foreach ($item in $items) {
    $source = Join-Path $root $item
    if (!(Test-Path -LiteralPath $source)) { throw "Missing release item: $item" }
    $entry = Get-Item -LiteralPath $source
    $files = if ($entry.PSIsContainer) { @(Get-ChildItem -LiteralPath $source -Recurse -File -Force) } else { @($entry) }
    # Do not follow junctions or symbolic links into other directories.
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Release input is a reparse point: $item" }
    if ($entry.PSIsContainer -and @(Get-ChildItem -LiteralPath $source -Recurse -Directory -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw "Release directory contains a reparse point: $item" }
    foreach ($file in $files) {
        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Release file is a reparse point.' }
        $relative = $file.FullName.Substring($root.Length + 1).Replace('\','/')
        if ($relative -match $forbidden) { throw "Private/runtime file in release inputs: $relative" }
        $target = Join-Path $payload $relative; New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target
    }
}
$entries = @(Get-ChildItem -LiteralPath $payload -Recurse -File | Sort-Object FullName | ForEach-Object { @{path=$_.FullName.Substring($payload.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName).Hash;bytes=$_.Length} })
@{name='Desktop Pocket';platform='Windows x64';format=1;created=(Get-Date -Format o);files=$entries} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $payload 'RELEASE-MANIFEST.json') -Encoding UTF8
$zip = Join-Path $OutputDir 'DesktopPocket-Windows.zip'
Compress-Archive -LiteralPath $payload -DestinationPath $zip -Force
$hash = (Get-FileHash -LiteralPath $zip).Hash
Set-Content -LiteralPath ($zip + '.sha256') -Value ($hash + '  DesktopPocket-Windows.zip') -Encoding ASCII
# Only remove the exact stage created above, beneath the validated output directory.
$stageResolved = [IO.Path]::GetFullPath($stage); $outResolved = [IO.Path]::GetFullPath($OutputDir)
if (!$stageResolved.StartsWith($outResolved.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe staging cleanup target.' }
Remove-Item -LiteralPath $stageResolved -Recurse -Force
Write-Host "Share this file: $zip"
Write-Host "SHA256: $hash"
