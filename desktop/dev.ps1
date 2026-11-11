<#
.SYNOPSIS
  Runs the 3RTC desktop app for development, against a signaling server on this PC.

.DESCRIPTION
  Starts server/server.js on port 8080 (unless something already listens there), then builds and
  runs the app pointed at it. Everything this script started is stopped when the app closes.

.PARAMETER Web
  Also start the web app (Vite) and open it on the local server, to test desktop and web together.

.PARAMETER Prod
  Use the real server (wss://orc.3rtc.me) instead of a local one.

.PARAMETER Release
  Build optimised (slow to compile, fast to run).

.PARAMETER Check
  Don't run the app: format check, clippy and tests (what CI runs).

.EXAMPLE
  .\dev.ps1            # app + local server
  .\dev.ps1 -Web       # app + local server + web app in the browser
  .\dev.ps1 -Check     # before pushing
#>
param([switch]$Web, [switch]$Prod, [switch]$Release, [switch]$Check)

$ErrorActionPreference = 'Stop'
$desktop = $PSScriptRoot
$repo = Split-Path $desktop -Parent
$port = 8080
$started = @()

function Need($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "Missing '$cmd'. $hint" -ForegroundColor Red
        exit 1
    }
}

function Listening($p) {
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $p); $c.Close(); $true } catch { $false }
}

function NpmInstall($dir) {
    if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
        Write-Host "Installing packages in $dir ..." -ForegroundColor Cyan
        Push-Location $dir
        try { npm ci; if ($LASTEXITCODE -ne 0) { throw "npm ci failed in $dir" } } finally { Pop-Location }
    }
}

Need cargo 'Install Rust from https://rustup.rs (and Visual Studio Build Tools with "Desktop development with C++").'
Set-Location $desktop

if ($Check) {
    cargo fmt --all -- --check;                                   if ($LASTEXITCODE) { exit $LASTEXITCODE }
    cargo clippy --workspace --all-targets -- -D warnings;        if ($LASTEXITCODE) { exit $LASTEXITCODE }
    if (Get-Command node -ErrorAction SilentlyContinue) { NpmInstall (Join-Path $repo 'server') }
    cargo test --workspace;                                       exit $LASTEXITCODE
}

try {
    if ($Prod) {
        Remove-Item Env:RTC_SIGNAL_URL -ErrorAction SilentlyContinue
        Write-Host 'Using the real server (wss://orc.3rtc.me).' -ForegroundColor Yellow
    } else {
        Need node 'Install Node.js 22 from https://nodejs.org, or run with -Prod to use the real server.'
        $serverDir = Join-Path $repo 'server'
        if (Listening $port) {
            Write-Host "Port $port is already in use: using what's running there." -ForegroundColor Yellow
        } else {
            NpmInstall $serverDir
            $env:PORT = "$port"
            $started += Start-Process node -ArgumentList 'server.js' -WorkingDirectory $serverDir -PassThru -WindowStyle Minimized
            for ($i = 0; $i -lt 50 -and -not (Listening $port); $i++) { Start-Sleep -Milliseconds 200 }
            if (-not (Listening $port)) { throw "The signaling server didn't start on port $port." }
            Write-Host "Signaling server on ws://localhost:$port" -ForegroundColor Green
        }
        $env:RTC_SIGNAL_URL = "ws://localhost:$port"
    }

    if ($Web) {
        Need node 'Install Node.js 22 from https://nodejs.org.'
        NpmInstall $repo
        $webDir = Join-Path $repo 'client-ts'
        $started += Start-Process cmd -ArgumentList '/c', 'npm run dev -- --port 5173 --strictPort' -WorkingDirectory $webDir -PassThru -WindowStyle Minimized
        for ($i = 0; $i -lt 100 -and -not (Listening 5173); $i++) { Start-Sleep -Milliseconds 200 }
        $url = if ($Prod) { 'http://localhost:5173/' } else { 'http://localhost:5173/?s=local' }
        Start-Process $url
        Write-Host "Web app at $url" -ForegroundColor Green
    }

    if (-not $env:RUST_LOG) { $env:RUST_LOG = 'warn,rtc=debug' }
    $cargoArgs = @('run', '-p', 'rtc-app')
    if ($Release) { $cargoArgs += '--release' }
    Write-Host "cargo $($cargoArgs -join ' ')   (the first build takes several minutes)" -ForegroundColor Cyan
    & cargo @cargoArgs
} finally {
    foreach ($p in $started) {
        if ($p -and -not $p.HasExited) { & taskkill /PID $p.Id /T /F 2>$null | Out-Null }
    }
}
