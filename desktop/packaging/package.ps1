<#
.SYNOPSIS
  Builds a 3RTC release: the exe, the portable zip, the per-user installer and latest.json.

.DESCRIPTION
  Everything goes to desktop\target\dist:
    3rtc-<build>.exe              the app (what updates download)
    3RTC-portable-<build>.zip     a folder with 3rtc.exe, the "portable" marker and a readme
    3RTC-Setup-<build>.exe        the per-user installer (needs Inno Setup 6)
    3RTC-Setup.exe, 3RTC-portable.zip   the same, under names that don't change (for links)
    latest.json                   what the app reads to find updates
  The build number is the time now in UTC, YYMMDD.HHMM (what the app shows and compares).

.PARAMETER BaseUrl
  Where the files will be served from (latest.json points there). Default https://3rtc.me/desktop/

.PARAMETER Notes
  One line about what's new (shown in the app's log when the update is ready).

.PARAMETER Publish
  Also copy the files into client-ts\public\desktop, so deploying the web app serves them.

.EXAMPLE
  .\packaging\package.ps1 -Notes "Reactions, the soundboard and chat pictures"
  .\packaging\package.ps1 -Publish
#>
param(
    [string]$BaseUrl = 'https://3rtc.me/desktop/',
    [string]$Notes = '',
    [switch]$Publish
)

$ErrorActionPreference = 'Stop'
$desktop = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $desktop -Parent
Set-Location $desktop

$build = (Get-Date).ToUniversalTime().ToString('yyMMdd.HHmm')
if (-not $BaseUrl.EndsWith('/')) { $BaseUrl += '/' }
Write-Host "Building 3RTC $build (release; this takes a few minutes) ..." -ForegroundColor Cyan
$env:RTC_BUILD = $build
cargo build --release --locked -p rtc-app
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Remove-Item Env:RTC_BUILD

$dist = Join-Path $desktop 'target\dist'
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory $dist | Out-Null
$exe = Join-Path $desktop 'target\release\3rtc.exe'
$versioned = "3rtc-$build.exe"
Copy-Item $exe (Join-Path $dist $versioned)

# portable: a folder with the exe, the marker and the readme
$stage = Join-Path $dist 'portable\3RTC'
New-Item -ItemType Directory $stage | Out-Null
Copy-Item $exe (Join-Path $stage '3rtc.exe')
New-Item -ItemType File (Join-Path $stage 'portable') | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'README-portable.txt') (Join-Path $stage 'README.txt')
$zip = Join-Path $dist "3RTC-portable-$build.zip"
Compress-Archive -Path $stage -DestinationPath $zip
Copy-Item $zip (Join-Path $dist '3RTC-portable.zip')
Remove-Item (Join-Path $dist 'portable') -Recurse -Force

# installer, if Inno Setup is there
$iscc = @(
    (Get-Command iscc -ErrorAction SilentlyContinue | ForEach-Object Source),
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($iscc) {
    & $iscc /Q "/DAppBuild=$build" "/DSourceExe=$exe" "/O$dist" (Join-Path $PSScriptRoot '3rtc.iss')
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    Copy-Item (Join-Path $dist "3RTC-Setup-$build.exe") (Join-Path $dist '3RTC-Setup.exe')
} else {
    Write-Host "No installer: Inno Setup 6 isn't installed (winget install JRSoftware.InnoSetup). The exe and the zip are made." -ForegroundColor Yellow
}

# what the app reads to find updates
$hash = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
    build = $build
    notes = $Notes
    exe   = [ordered]@{ url = "$BaseUrl$versioned"; sha256 = $hash; size = (Get-Item $exe).Length }
}
# UTF-8 without a byte-order mark (Windows PowerShell's -Encoding utf8 would add one)
[IO.File]::WriteAllText((Join-Path $dist 'latest.json'), ($manifest | ConvertTo-Json -Depth 3), (New-Object Text.UTF8Encoding $false))

if ($Publish) {
    $public = Join-Path $repo 'client-ts\public\desktop'
    New-Item -ItemType Directory $public -Force | Out-Null
    # only the newest version is kept there
    Get-ChildItem $public -File | Where-Object { $_.Name -like '3rtc-*.exe' -or $_.Name -like '3RTC-*' } | Remove-Item
    Copy-Item (Join-Path $dist '*') $public
    Write-Host "Copied to $public : deploy the web app to publish 3RTC $build." -ForegroundColor Green
}

Write-Host ""
Write-Host "3RTC $build is in $dist" -ForegroundColor Green
Get-ChildItem $dist | Format-Table Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } -AutoSize
