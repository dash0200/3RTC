<#
.SYNOPSIS
  Gets libmpv-2.dll, the local video player (an LGPL build of mpv), next to 3rtc.exe.

.DESCRIPTION
  Downloads the newest "mpv-dev-lgpl-x86_64" build from github.com/zhongfly/mpv-winbuild,
  takes libmpv-2.dll out of it into target\mpv\, and copies it next to the debug and release
  builds (target\debug, target\release). The app loads it when a video file plays; without it
  the app runs and says the player is missing.

  The LGPL build leaves out mpv's GPL-only parts (none of them are needed to play files), so
  3RTC can ship it beside its own MIT code. See docs/adr for the reasons.

.PARAMETER Force
  Download again even if target\mpv\libmpv-2.dll is there.

.EXAMPLE
  .\packaging\get-mpv.ps1
#>
param([switch]$Force)

$ErrorActionPreference = 'Stop'
$desktop = Split-Path $PSScriptRoot -Parent
$store = Join-Path $desktop 'target\mpv'
$dll = Join-Path $store 'libmpv-2.dll'

function Place {
    foreach ($build in 'debug', 'release') {
        $dir = Join-Path $desktop "target\$build"
        New-Item -ItemType Directory $dir -Force | Out-Null
        Copy-Item $dll (Join-Path $dir 'libmpv-2.dll') -Force
    }
    Write-Host "libmpv-2.dll is in target\debug and target\release" -ForegroundColor Green
}

if ((Test-Path $dll) -and -not $Force) {
    Place
    exit 0
}

New-Item -ItemType Directory $store -Force | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host 'Looking up the newest LGPL build of mpv ...' -ForegroundColor Cyan
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/zhongfly/mpv-winbuild/releases/latest' `
    -Headers @{ 'User-Agent' = '3rtc-get-mpv' }
$asset = $release.assets | Where-Object { $_.name -match '^mpv-dev-lgpl-x86_64-\d.*\.7z$' } | Select-Object -First 1
if (-not $asset) {
    # older builds named the plain x86_64 one without "-v3"; take any lgpl dev build for x86_64
    $asset = $release.assets | Where-Object { $_.name -match '^mpv-dev-lgpl-x86_64.*\.7z$' } | Select-Object -First 1
}
if (-not $asset) {
    Write-Host "No LGPL dev build in release $($release.tag_name). Its files:" -ForegroundColor Red
    $release.assets | ForEach-Object { Write-Host "  $($_.name)" }
    exit 1
}

$archive = Join-Path $store $asset.name
$mb = [math]::Round($asset.size / 1MB)
Write-Host "Downloading $($asset.name) ($mb MB) ..." -ForegroundColor Cyan
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes Invoke-WebRequest very slow
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive -Headers @{ 'User-Agent' = '3rtc-get-mpv' }

# a .7z: 7-Zip if it's installed, else Windows' own tar (it reads 7z on Windows 11)
$unpack = Join-Path $store 'unpacked'
if (Test-Path $unpack) { Remove-Item $unpack -Recurse -Force }
New-Item -ItemType Directory $unpack | Out-Null
$sevenZip = @(
    (Get-Command 7z -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
    "$env:ProgramFiles\7-Zip\7z.exe",
    "${env:ProgramFiles(x86)}\7-Zip\7z.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($sevenZip) {
    & $sevenZip x $archive "-o$unpack" -y | Out-Null
} else {
    & tar -xf $archive -C $unpack
}
$found = Get-ChildItem $unpack -Recurse -Filter 'libmpv-2.dll' | Select-Object -First 1
if (-not $found) {
    Write-Host "Couldn't unpack $($asset.name). Install 7-Zip (winget install 7zip.7zip) and run this again." -ForegroundColor Red
    exit 1
}
Copy-Item $found.FullName $dll -Force
Remove-Item $unpack -Recurse -Force
Remove-Item $archive -Force
Set-Content (Join-Path $store 'VERSION.txt') "$($release.tag_name) $($asset.name)"
Write-Host "Got libmpv-2.dll from $($asset.name)" -ForegroundColor Green
Place
