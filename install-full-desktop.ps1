param([string]$OwnerSid)
$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$runRoot = Join-Path $appRoot 'run'
$resultPath = Join-Path $runRoot 'full-install-result.json'
$secretPath = Join-Path $runRoot 'vnc.json'
$admin = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run enable-full-desktop.ps1 and approve the Windows administrator prompt.' }
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$installationAttempted = $false
try {
    if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $OwnerSid) { throw 'Approve setup with the same Windows account that runs Desktop Pocket.' }
    if (Get-Service tvnserver -ErrorAction SilentlyContinue) { throw 'TightVNC already exists. This installer will not overwrite an existing remote-desktop service.' }
    $msi = Join-Path $appRoot 'install\tightvnc-2.8.89-gpl-setup-64bit.msi'
    if ((Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash -ne 'DFF8D7E40A81E0B86BA1D9D5CC0D4F22D08354C50C9CBDC0825BBB6CCFB1073C') { throw 'Installer hash does not match the verified vendor download.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $msi
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne '90513AC184484A36A6461CB7B834B68761761006') { throw 'Installer publisher verification failed.' }
    $uacPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
    $uacBefore = Get-ItemProperty -LiteralPath $uacPath
    function RandomPassword {
        $bytes = New-Object byte[] 6
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        return [Convert]::ToBase64String($bytes).Replace('+','-').Replace('/','_')
    }
    $vncPassword = RandomPassword
    $viewPassword = RandomPassword
    $adminPassword = RandomPassword
    $properties = @(
        'ADDLOCAL=Server', 'REBOOT=ReallySuppress', 'SERVER_REGISTER_AS_SERVICE=1',
        'SERVER_SERVICE_ONLY=1', 'SERVER_ADD_FIREWALL_EXCEPTION=0', 'VIEWER_ADD_FIREWALL_EXCEPTION=0', 'SERVER_ALLOW_SAS=0',
        'SET_ALLOWLOOPBACK=1', 'VALUE_OF_ALLOWLOOPBACK=1', 'SET_LOOPBACKONLY=1', 'VALUE_OF_LOOPBACKONLY=1',
        'SET_ACCEPTHTTPCONNECTIONS=1', 'VALUE_OF_ACCEPTHTTPCONNECTIONS=0',
        'SET_ACCEPTRFBCONNECTIONS=1', 'VALUE_OF_ACCEPTRFBCONNECTIONS=1',
        'SET_RFBPORT=1', 'VALUE_OF_RFBPORT=5905', 'SET_EXTRAPORTS=1', 'VALUE_OF_EXTRAPORTS=""',
        'SET_ENABLEFILETRANSFERS=1', 'VALUE_OF_ENABLEFILETRANSFERS=0',
        'SET_REMOVEWALLPAPER=1', 'VALUE_OF_REMOVEWALLPAPER=0',
        'SET_BLOCKLOCALINPUT=1', 'VALUE_OF_BLOCKLOCALINPUT=0', 'SET_BLOCKREMOTEINPUT=1', 'VALUE_OF_BLOCKREMOTEINPUT=0',
        'SET_DISCONNECTACTION=1', 'VALUE_OF_DISCONNECTACTION=0', 'SET_ALWAYSSHARED=1', 'VALUE_OF_ALWAYSSHARED=1',
        'SET_USEMIRRORDRIVER=1', 'VALUE_OF_USEMIRRORDRIVER=0',
        'SET_USEVNCAUTHENTICATION=1', 'VALUE_OF_USEVNCAUTHENTICATION=1',
        'SET_PASSWORD=1', "VALUE_OF_PASSWORD=$vncPassword", 'SET_VIEWONLYPASSWORD=1', "VALUE_OF_VIEWONLYPASSWORD=$viewPassword",
        'SET_USECONTROLAUTHENTICATION=1', 'VALUE_OF_USECONTROLAUTHENTICATION=1',
        'SET_REPEATCONTROLAUTHENTICATION=1', 'VALUE_OF_REPEATCONTROLAUTHENTICATION=1',
        'SET_CONTROLPASSWORD=1', "VALUE_OF_CONTROLPASSWORD=$adminPassword", 'SET_RUNCONTROLINTERFACE=1', 'VALUE_OF_RUNCONTROLINTERFACE=1',
        'MsiHiddenProperties="VALUE_OF_PASSWORD;VALUE_OF_VIEWONLYPASSWORD;VALUE_OF_CONTROLPASSWORD;SetPasswordsActionSilently;SetViewOnlyPasswordsActionSilently;SetControlPasswordsActionSilently"'
    ) -join ' '
    # COM keeps passwords out of a new process command line; hidden MSI properties suppress them in installer logs.
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $installer.UILevel = 2
    $installationAttempted = $true
    $installer.InstallProduct($msi, $properties)
    $reg = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\TightVNC\Server'
    foreach ($check in @{LoopbackOnly=1;AllowLoopback=1;RfbPort=5905;AcceptHttpConnections=0;EnableFileTransfers=0;UseVncAuthentication=1}.GetEnumerator()) {
        if ($reg.($check.Key) -ne $check.Value) { throw "Service setting $($check.Key) was not applied." }
    }
    if ($reg.ExtraPorts) { throw 'Unexpected additional VNC ports were configured.' }
    if (!$reg.Password -or !$reg.PasswordViewOnly) { throw 'Service passwords were not configured.' }
    $service = Get-CimInstance Win32_Service -Filter "Name='tvnserver'"
    if ($service.StartName -ne 'LocalSystem') { throw 'The desktop service does not have the required Windows service identity.' }
    if ($service.State -ne 'Running') { Start-Service tvnserver }
    $listen = @()
    for ($i=0;$i -lt 30;$i++) {
        $listen = @(Get-NetTCPConnection -State Listen -LocalPort 5905 -ErrorAction SilentlyContinue)
        if ($listen.Count) { break }
        Start-Sleep -Milliseconds 300
    }
    if (!$listen.Count -or @($listen | Where-Object LocalAddress -NotIn @('127.0.0.1','::1')).Count) { throw 'VNC is not listening exclusively on loopback.' }
    $vncPids = @(Get-CimInstance Win32_Process -Filter "Name='tvnserver.exe'" | Select-Object -ExpandProperty ProcessId)
    $unexpected = @(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in $vncPids -and ($_.LocalAddress -notin @('127.0.0.1','::1') -or $_.LocalPort -ne 5905) })
    if ($unexpected.Count) { throw 'Unexpected VNC service listener; service was stopped.' }
    $uacAfter = Get-ItemProperty -LiteralPath $uacPath
    if ($uacAfter.EnableLUA -ne $uacBefore.EnableLUA -or $uacAfter.PromptOnSecureDesktop -ne $uacBefore.PromptOnSecureDesktop) { throw 'UAC settings changed unexpectedly.' }
    # Create a restricted file before putting credentials in it. Never served as an HTTP asset.
    [IO.File]::WriteAllText($secretPath, '')
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($sidText in @($OwnerSid,'S-1-5-18','S-1-5-32-544')) {
        $sid = New-Object Security.Principal.SecurityIdentifier($sidText)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $secretPath -AclObject $acl
    $config = @{ready=$true;port=5905;password=$vncPassword;viewPassword=$viewPassword;installedVersion='2.8.89';ownerSid=$OwnerSid}
    [IO.File]::WriteAllText($secretPath,($config | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    @{ready=$true;service='tvnserver';port=5905;loopbackOnly=$true;uacUnchanged=$true;time=(Get-Date -Format o)} | ConvertTo-Json | Set-Content -LiteralPath $resultPath
} catch {
    if ($installationAttempted) {
        Stop-Service tvnserver -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $secretPath -Force -ErrorAction SilentlyContinue
    }
    @{ready=$false;error=$_.Exception.Message;time=(Get-Date -Format o)} | ConvertTo-Json | Set-Content -LiteralPath $resultPath
    exit 1
}
