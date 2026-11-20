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

  The binaries are NOT kept in git: they go to a GitHub Release (tag desktop-<build>) on -Repo.
  Only latest.json (a few hundred bytes) is served by the website, at
  https://3rtc.me/desktop/latest.json, and it points at the release's files. The website's
  download links (/desktop/3RTC-portable.zip, /desktop/3RTC-Setup.exe) redirect to the newest
  release (client-ts/vercel.json).

.PARAMETER Repo
  The GitHub repository that holds the releases. Default dash0200/3RTC

.PARAMETER BaseUrl
  Where the files will be downloaded from (latest.json points there).
  Default https://github.com/<Repo>/releases/download/desktop-<build>/

.PARAMETER Notes
  One line about what's new (shown in the app's log when the update is ready).

.PARAMETER Publish
  Also upload the files as the GitHub Release desktop-<build> (needs the GitHub CLI, signed in:
  winget install GitHub.cli, then gh auth login), then copy latest.json into
  client-ts\public\desktop. Commit that latest.json and deploy the web app: from then on apps
  update to this build. Nothing big is copied into client-ts\public.

.EXAMPLE
  .\packaging\package.ps1 -Notes "Reactions, the soundboard and chat pictures"
  .\packaging\package.ps1 -Publish -Notes "Webcam and folder sharing"
#>
param(
    [string]$Repo = 'dash0200/3RTC',
    [string]$BaseUrl = '',
    [string]$Notes = '',
    [switch]$Publish
)

$ErrorActionPreference = 'Stop'
$desktop = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $desktop -Parent
Set-Location $desktop

# Build number: India Standard Time (UTC+5:30), YYMMDD.HHMM (matches client-ts/vite.config.ts)
$build = (Get-Date).ToUniversalTime().AddMinutes(330).ToString('yyMMdd.HHmm')
$tag = "desktop-$build"
if (-not $BaseUrl) { $BaseUrl = "https://github.com/$Repo/releases/download/$tag/" }
if (-not $BaseUrl.EndsWith('/')) { $BaseUrl += '/' }
# check for the GitHub CLI before the long build, not after
if ($Publish) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-Host "-Publish needs the GitHub CLI: winget install GitHub.cli, then gh auth login" -ForegroundColor Red
        exit 1
    }
    gh auth status --hostname github.com | Out-Null
    if ($LASTEXITCODE) {
        Write-Host "The GitHub CLI isn't signed in: run gh auth login" -ForegroundColor Red
        exit 1
    }
}
Write-Host "Building 3RTC $build (release; this takes a few minutes) ..." -ForegroundColor Cyan
$env:RTC_BUILD = $build
cargo build --release --locked -p rtc-app
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Remove-Item Env:RTC_BUILD

$dist = Join-Path $desktop 'target\dist'
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory $dist | Out-Null
$exe = Join-Path $desktop 'target\release\3rtc.exe'
# the local video player goes beside the exe
& (Join-Path $PSScriptRoot 'get-mpv.ps1')
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$mpv = Join-Path $desktop 'target\mpv\libmpv-2.dll'
$versioned = "3rtc-$build.exe"
Copy-Item $exe (Join-Path $dist $versioned)

# portable: a folder with the exe, the marker and the readme
$stage = Join-Path $dist 'portable\3RTC'
New-Item -ItemType Directory $stage | Out-Null
Copy-Item $exe (Join-Path $stage '3rtc.exe')
Copy-Item $mpv (Join-Path $stage 'libmpv-2.dll')
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
    & $iscc /Q "/DAppBuild=$build" "/DSourceExe=$exe" "/DMpvDll=$mpv" "/O$dist" (Join-Path $PSScriptRoot '3rtc.iss')
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    Copy-Item (Join-Path $dist "3RTC-Setup-$build.exe") (Join-Path $dist '3RTC-Setup.exe')
} else {
    Write-Host "No installer: Inno Setup 6 isn't installed (winget install JRSoftware.InnoSetup). The exe and the zip are made." -ForegroundColor Yellow
}

# what the app reads to find updates
$hash = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant()
Copy-Item $mpv (Join-Path $dist 'libmpv-2.dll')
$mpvHash = (Get-FileHash $mpv -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
    build = $build
    notes = $Notes
    exe   = [ordered]@{ url = "$BaseUrl$versioned"; sha256 = $hash; size = (Get-Item $exe).Length }
    # the video player, for installs that don't have it yet (update.rs ensure_player)
    mpv   = [ordered]@{ url = "${BaseUrl}libmpv-2.dll"; sha256 = $mpvHash; size = (Get-Item $mpv).Length }
}
# UTF-8 without a byte-order mark (Windows PowerShell's -Encoding utf8 would add one)
[IO.File]::WriteAllText((Join-Path $dist 'latest.json'), ($manifest | ConvertTo-Json -Depth 3), (New-Object Text.UTF8Encoding $false))

if ($Publish) {
    # 1. the binaries go to a GitHub Release (not into git): the versioned exe that latest.json
    #    names, the fixed-name zip and installer the website's links redirect to, and the player
    $assets = @($versioned, '3RTC-portable.zip', '3RTC-Setup.exe', 'libmpv-2.dll', 'latest.json') |
        ForEach-Object { Join-Path $dist $_ } | Where-Object { Test-Path $_ }
    $releaseNotes = if ($Notes) { $Notes } else { "3RTC desktop $build" }
    Write-Host "Uploading $tag to github.com/$Repo (about 250 MB) ..." -ForegroundColor Cyan
    gh release create $tag @assets --repo $Repo --title "3RTC desktop $build" --notes $releaseNotes --latest
    if ($LASTEXITCODE) { exit $LASTEXITCODE }

    # 2. only latest.json goes to the website; apps update once the web app is deployed with it
    $public = Join-Path $repo 'client-ts\public\desktop'
    New-Item -ItemType Directory $public -Force | Out-Null
    # binaries the old flow left here (they're in .gitignore; the release has them now)
    Get-ChildItem $public -File | Where-Object { $_.Name -ne 'latest.json' } | Remove-Item
    Copy-Item (Join-Path $dist 'latest.json') $public -Force
    Write-Host "Released $tag. Commit client-ts\public\desktop\latest.json and deploy the web app to publish 3RTC $build." -ForegroundColor Green
}

Write-Host ""
Write-Host "3RTC $build is in $dist" -ForegroundColor Green
Get-ChildItem $dist | Format-Table Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } -AutoSize
