Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class NativeMethods
{
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool DestroyIcon(IntPtr handle);
}
"@

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$outputDir = Join-Path $projectRoot 'public'
$pngPath = Join-Path $outputDir 'port-manager-icon.png'
$icoPath = Join-Path $outputDir 'port-manager-icon.ico'

[int]$size = 256
$bitmap = New-Object System.Drawing.Bitmap $size, $size
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)

$backgroundRect = New-Object System.Drawing.Rectangle 18, 18, 220, 220
$backgroundBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $backgroundRect,
    [System.Drawing.Color]::FromArgb(255, 86, 145, 255),
    [System.Drawing.Color]::FromArgb(255, 34, 84, 215),
    45
)
$graphics.FillEllipse($backgroundBrush, $backgroundRect)

$ringRect = New-Object System.Drawing.Rectangle 38, 38, 180, 180
$ringPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(170, 235, 244, 255), 10)
$graphics.DrawEllipse($ringPen, $ringRect)

$fontFamily = New-Object System.Drawing.FontFamily 'Segoe UI'
$stringFormat = New-Object System.Drawing.StringFormat
$stringFormat.Alignment = [System.Drawing.StringAlignment]::Center
$stringFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
$letterBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$graphics.DrawString('P', (New-Object System.Drawing.Font($fontFamily, 118, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)), $letterBrush, (New-Object System.Drawing.RectangleF(26, 26, 204, 204)), $stringFormat)

$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$hIcon = $bitmap.GetHicon()
try {
    $icon = [System.Drawing.Icon]::FromHandle($hIcon)
    $fileStream = [System.IO.File]::Create($icoPath)
    try {
        $icon.Save($fileStream)
    }
    finally {
        $fileStream.Dispose()
        $icon.Dispose()
    }
}
finally {
    [NativeMethods]::DestroyIcon($hIcon) | Out-Null
    $ringPen.Dispose()
    $letterBrush.Dispose()
    $backgroundBrush.Dispose()
    $stringFormat.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

Write-Output "Generated $pngPath"
Write-Output "Generated $icoPath"
