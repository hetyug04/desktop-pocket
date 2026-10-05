param([switch]$Install, [switch]$SkipIcons)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if ($Install -or !(Test-Path -LiteralPath '.\node_modules\ws\package.json')) {
        & npm.cmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $compiler /nologo /target:exe /platform:x64 /out:native\DesktopBridge.exe /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/lib:$(Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\WPF')" /reference:UIAutomationClient.dll /reference:UIAutomationTypes.dll /reference:WindowsBase.dll native\DesktopBridge.cs
    if ($LASTEXITCODE -ne 0) { throw 'Desktop bridge compilation failed.' }
    if (!$SkipIcons) {
    Add-Type -AssemblyName System.Drawing
    foreach ($size in @(192,512)) {
        $bitmap = New-Object System.Drawing.Bitmap($size,$size)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.ScaleTransform($size / 192.0, $size / 192.0)
        $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#101119'))
        $pen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#a6a9ff'),9)
        $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $pen.StartCap = $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $graphics.DrawRectangle($pen,31,39,113,84)
        $graphics.DrawLine($pen,84,123,84,153)
        $graphics.DrawLine($pen,64,153,107,153)
        $brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#101119'))
        $graphics.FillRectangle($brush,125,87,39,69)
        $graphics.DrawRectangle($pen,125,87,39,69)
        $bitmap.Save((Join-Path $PSScriptRoot "public\icon-$size.png"),[System.Drawing.Imaging.ImageFormat]::Png)
        $brush.Dispose(); $pen.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
    }
    }
    Write-Host 'Desktop bridge built; app icons are ready.'
} finally { Pop-Location }
