<#
.SYNOPSIS
    Runs local CI checks before pushing to Git (mirrors GitHub Actions workflow).
.DESCRIPTION
    Runs:
      1. Rust format check (cargo fmt --all -- --check)
      2. Security / licenses audit (cargo-deny, if installed)
      3. Windows-specific clippy (rtc-platform-win)
      4. Server packages install (for integration tests)
      5. Full workspace clippy (-D warnings)
      6. Full workspace tests
      7. Release binary build (unless -SkipRelease or -Quick is passed)
.PARAMETER Quick
    Skips the long release build (LTO) and only runs formatting, lints, and tests.
.PARAMETER SkipRelease
    Alias/same as -Quick.
.PARAMETER Web
    Also runs client-ts typecheck and unit tests.
.PARAMETER Fix
    Automatically runs 'cargo fmt --all' if formatting differs.
#>
[CmdletBinding()]
param(
    [switch]$Quick,
    [switch]$SkipRelease,
    [switch]$Web,
    [switch]$Fix
)

$ErrorActionPreference = "Stop"

# Determine repository root
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopDir = Join-Path $RepoRoot "desktop"
$ServerDir = Join-Path $RepoRoot "server"
$ClientDir = Join-Path $RepoRoot "client-ts"

function Step-Header($title) {
    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host " >> $title" -ForegroundColor Cyan
    Write-Host "==================================================" -ForegroundColor Cyan
}

function Run-Step($name, [scriptblock]$action) {
    Step-Header $name
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $action
        $sw.Stop()
        Write-Host " [PASS] $name ($([math]::Round($sw.Elapsed.TotalSeconds, 1))s)" -ForegroundColor Green
    }
    catch {
        $sw.Stop()
        Write-Host " [FAIL] $name failed!" -ForegroundColor Red
        Write-Error $_
        exit 1
    }
}

$TotalTime = [System.Diagnostics.Stopwatch]::StartNew()

# 1. Format check
Run-Step "1/7: Rust Format Check (cargo fmt)" {
    Push-Location $DesktopDir
    try {
        if ($Fix) {
            cargo fmt --all
            if ($LASTEXITCODE -ne 0) { throw "cargo fmt failed" }
        } else {
            cargo fmt --all -- --check
            if ($LASTEXITCODE -ne 0) {
                throw "Code formatting differs. Run 'cargo fmt --all' in desktop or rerun with -Fix."
            }
        }
    } finally {
        Pop-Location
    }
}

# 2. Dependency Audit (cargo deny)
Run-Step "2/7: Dependency Audit (cargo-deny)" {
    if (Get-Command cargo-deny -ErrorAction SilentlyContinue) {
        Push-Location $DesktopDir
        try {
            cargo deny check licenses sources bans advisories
            if ($LASTEXITCODE -ne 0) { throw "cargo-deny checks failed" }
        } finally {
            Pop-Location
        }
    } else {
        Write-Host " cargo-deny is not installed locally. Skipping audit." -ForegroundColor Yellow
        Write-Host " (To install: cargo install cargo-deny)" -ForegroundColor DarkGray
    }
}

# 3. Windows-only crate check
Run-Step "3/7: Windows Platform Clippy (rtc-platform-win)" {
    Push-Location $DesktopDir
    try {
        cargo clippy -p rtc-platform-win --target x86_64-pc-windows-msvc --all-targets --locked -- -D warnings
        if ($LASTEXITCODE -ne 0) { throw "clippy failed on rtc-platform-win" }
    } finally {
        Pop-Location
    }
}

# 4. Signaling server packages
Run-Step "4/7: Signaling Server Dependencies (server)" {
    Push-Location $ServerDir
    try {
        if (-not (Test-Path "node_modules")) {
            Write-Host " Installing server dependencies..." -ForegroundColor Gray
            npm ci 2>$null
            if ($LASTEXITCODE -ne 0) {
                npm install
                if ($LASTEXITCODE -ne 0) { throw "npm install failed in server/" }
            }
        } else {
            Write-Host " server/node_modules already present." -ForegroundColor Gray
        }
    } finally {
        Pop-Location
    }
}

# 5. Full workspace Clippy
Run-Step "5/7: Workspace Clippy (all warnings are errors)" {
    Push-Location $DesktopDir
    try {
        cargo clippy --workspace --all-targets --locked -- -D warnings
        if ($LASTEXITCODE -ne 0) { throw "cargo clippy --workspace failed" }
    } finally {
        Pop-Location
    }
}

# 6. Workspace tests
Run-Step "6/7: Workspace Tests (all units, loopback, integration)" {
    Push-Location $DesktopDir
    try {
        cargo test --workspace --locked
        if ($LASTEXITCODE -ne 0) { throw "cargo test --workspace failed" }
    } finally {
        Pop-Location
    }
}

# 7. Release build
if ($Quick -or $SkipRelease) {
    Step-Header "7/7: Release Build (Skipped via -Quick)"
    Write-Host " Skipping release build (-Quick / -SkipRelease specified)." -ForegroundColor Yellow
} else {
    Run-Step "7/7: Release Build (3rtc.exe)" {
        Push-Location $DesktopDir
        try {
            $env:RTC_BUILD = "local"
            cargo build --release --locked -p rtc-app
            if ($LASTEXITCODE -ne 0) { throw "cargo build --release failed" }
            $exePath = Join-Path $DesktopDir "target\release\3rtc.exe"
            if (Test-Path $exePath) {
                $sizeMb = [math]::Round((Get-Item $exePath).Length / 1MB, 2)
                Write-Host " Release binary created: $exePath ($sizeMb MB)" -ForegroundColor Green
            }
        } finally {
            Remove-Item env:RTC_BUILD -ErrorAction SilentlyContinue
            Pop-Location
        }
    }
}

# Optional: Web checks
if ($Web) {
    Run-Step "Optional: Web Client Typecheck & Unit Tests" {
        Push-Location $ClientDir
        try {
            Write-Host " Running typecheck (tsc -b)..." -ForegroundColor Gray
            npm run typecheck
            if ($LASTEXITCODE -ne 0) { throw "npm run typecheck failed in client-ts" }

            Write-Host " Running unit tests..." -ForegroundColor Gray
            npm run test
            if ($LASTEXITCODE -ne 0) { throw "npm run test failed in client-ts" }
        } finally {
            Pop-Location
        }
    }
}

$TotalTime.Stop()
$TotalSeconds = [math]::Round($TotalTime.Elapsed.TotalSeconds, 1)

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host " ALL CHECKS PASSED CLEANLY! ($($TotalSeconds)s)" -ForegroundColor Green
Write-Host " Safe to commit and push." -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
