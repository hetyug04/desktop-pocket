<# Fresh, independent Windows setup. Never imports another person's machine key or passkeys. #>
param([switch]$Check, [switch]$NoInstall, [switch]$NoShortcut)
$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
function Refresh-Path {
    $env:PATH = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:PATH + ';C:\Program Files\Tailscale;C:\Program Files\nodejs'
}
function Require-Tool($command, $package, $link) {
    if (Get-Command $command -ErrorAction SilentlyContinue) { return }
    if ($Check -or $NoInstall -or !(Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw "Missing $command. Install from $link, then rerun SETUP.cmd." }
    Write-Host "Installing $package with Windows Package Manager. Approve any installer/Windows prompts."
    & winget.exe install --id $package --exact --source winget
    if ($LASTEXITCODE -ne 0) { throw "Install failed. Install from $link, then rerun SETUP.cmd." }
    Refresh-Path
    if (!(Get-Command $command -ErrorAction SilentlyContinue)) { throw "$package was installed. Close this window, reopen SETUP.cmd so PATH refreshes." }
}
if (![Environment]::Is64BitOperatingSystem -or @(Get-CimInstance Win32_Processor | Where-Object Architecture -eq 9).Count -eq 0) { throw 'This setup supports Windows 10/11 x64. Windows ARM is not tested.' }
if ([Environment]::OSVersion.Version.Build -lt 17763) { throw 'Windows 10 version 1809 or later is required.' }
Refresh-Path
Require-Tool 'node.exe' 'OpenJS.NodeJS.LTS' 'https://nodejs.org/en/download'
$nodeVersion = [version]((& node.exe --version).Trim().TrimStart('v'))
$major = $nodeVersion.Major
if ($major -lt 22) { throw 'Node.js 22 or newer is required. Update Node.js LTS, reopen SETUP.cmd.' }
Require-Tool 'tailscale.exe' 'Tailscale.Tailscale' 'https://tailscale.com/download/windows'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework 4.x compiler is missing. Ask your coding agent to enable .NET Framework 4.x.' }
if (Test-Path -LiteralPath (Join-Path $appRoot 'RELEASE-MANIFEST.json')) {
    $manifest = Get-Content -LiteralPath (Join-Path $appRoot 'RELEASE-MANIFEST.json') -Raw | ConvertFrom-Json
    foreach ($entry in $manifest.files) {
        $target = [IO.Path]::GetFullPath((Join-Path $appRoot $entry.path))
        if (!$target.StartsWith($appRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid release manifest path.' }
        if (!(Test-Path -LiteralPath $target) -or (Get-FileHash -LiteralPath $target).Hash -ne $entry.sha256) { throw "Release file changed or incomplete: $($entry.path). Re-extract the ZIP, or have your agent review its edits before setup." }
    }
}
if ($Check) { Write-Host 'Package integrity and local prerequisites passed. No installation, security, server or Tailscale changes made.'; exit 0 }
$ts = (Get-Command tailscale.exe).Source
while ($true) {
    $statusText = & $ts status --json 2>$null | Out-String
    $status = if ($LASTEXITCODE -eq 0) { $statusText | ConvertFrom-Json } else { $null }
    if ($status.BackendState -eq 'Running' -and $status.Self.DNSName) { break }
    Write-Host 'Sign into your OWN Tailscale account on this PC. Your phone must join that same tailnet.'
    $tray = Join-Path (Split-Path $ts) 'tailscale-ipn.exe'
    if (Test-Path -LiteralPath $tray) { Start-Process -FilePath $tray | Out-Null }
    Read-Host 'After signing in, press Enter here (Ctrl+C cancels)' | Out-Null
}
Push-Location $appRoot
try {
    & (Join-Path $appRoot 'build.ps1') -Install -SkipIcons
    if ($LASTEXITCODE -ne 0) { throw 'Build failed. Ask your coding agent to inspect npm output.' }
    $run = Join-Path $appRoot 'run'; New-Item -ItemType Directory -Path $run -Force | Out-Null
    $configPath = Join-Path $run 'config.json'
    if (!(Test-Path -LiteralPath $configPath)) {
        $secretDir = Join-Path $env:LOCALAPPDATA 'DesktopPocket\security'
        New-Item -ItemType Directory -Path $secretDir -Force | Out-Null
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetAccessRuleProtection($true,$false)
        foreach ($sidText in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')) {
            $sid = New-Object Security.Principal.SecurityIdentifier($sidText)
            $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $secretDir -AclObject $acl
        $keyFile = Join-Path $secretDir 'machine-key.txt'
        if (!(Test-Path -LiteralPath $keyFile)) {
            $bytes = New-Object byte[] 32; $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
            [IO.File]::WriteAllText($keyFile,[Convert]::ToBase64String($bytes), (New-Object Text.UTF8Encoding($false)))
        }
        @{passwordFile=$keyFile;origin=('https://' + $status.Self.DNSName.TrimEnd('.') + ':8443');filesHost=[Environment]::MachineName.ToLowerInvariant();gates='off'} | ConvertTo-Json | Set-Content -LiteralPath $configPath
    }
    & (Join-Path $appRoot 'desktop-pocket.ps1') start -NoQr
    if ($LASTEXITCODE -ne 0) { throw 'Start failed. See logs\error.log.' }
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $env:DESKTOP_PASSWORD_FILE = $config.passwordFile
    $env:DESKTOP_ORIGIN = $config.origin
    $authFile = Join-Path (Split-Path $config.passwordFile) 'passkeys.json'
    $hasKeys = $false
    if (Test-Path -LiteralPath $authFile) { $store = Get-Content -LiteralPath $authFile -Raw | ConvertFrom-Json; $hasKeys = @($store.credentials | Where-Object { !($_.removed) }).Count -gt 0 }
    if (!$hasKeys) {
        $pairingPage = Join-Path (Split-Path $config.passwordFile) 'phone-setup.html'
        & node.exe lib\auth-cli.mjs setup --qr-file $pairingPage
        if ($LASTEXITCODE -ne 0) { throw 'Passkey setup QR generation failed.' }
        Start-Process -FilePath $pairingPage | Out-Null
    } else {
        Write-Host 'Your existing passkeys are unchanged. Use SECURITY-SETUP.cmd for a new enrollment QR.'
        & (Join-Path $appRoot 'show-phone-qr.ps1') -Origin $config.origin
    }
    if (!$NoShortcut) {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Desktop Pocket.lnk'))
        $shortcut.TargetPath = Join-Path $appRoot 'START.cmd'; $shortcut.WorkingDirectory = $appRoot; $shortcut.Save()
    }
    Write-Host ''
    Write-Host "READY: $($config.origin)" -ForegroundColor Green
    Write-Host 'On your phone: connect Tailscale, scan the QR shown on this PC, tap Create passkey, then confirm with Face ID/Windows Hello. No address or code to type.'
    Write-Host 'Save the recovery codes in a password manager. Safari: Share > Add to Home Screen.'
    Write-Host 'Optional UAC/lock-screen support: enable-full-desktop.cmd (approve its administrator prompt locally).'
    Write-Host 'Next time: START.cmd or the Desktop Pocket shortcut. Stop: STOP.cmd. Machine must be awake.'
} finally { Pop-Location }
