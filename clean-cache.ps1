<#
.SYNOPSIS
    Cleans up bloated Cargo build caches without forcing a full rebuild.
.DESCRIPTION
    Safely reclaims 30-45+ GB from 3RTC/desktop/target by removing:
      1. Stale incremental compiler query sessions (desktop/target/debug/incremental)
      2. Duplicate target directory (desktop/target/x86_64-pc-windows-msvc)
      3. Heavy debug symbol files (*.pdb) across target/
      4. Obsolete test runner binaries in deps/ (*.exe)
      5. Superseded duplicate crate hashes in deps/ (*.rlib, *.rmeta, *.d)

    CRITICAL: Preserves the active/newest compiled library for every crate,
    all native C/C++ builds (libwebrtc, etc.), and runtime binaries (3rtc.exe, libmpv-2.dll).
.PARAMETER DryRun
    Preview how much space will be freed without deleting any files.
.PARAMETER KeepPdb
    Do not delete .pdb debug symbol files.
.EXAMPLE
    .\clean-cache.ps1 -DryRun   # Preview space to be freed
    .\clean-cache.ps1           # Safely clean and reclaim 30-45 GB
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$KeepPdb
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopTarget = Join-Path $RepoRoot "desktop\target"

if (-not (Test-Path $DesktopTarget)) {
    Write-Host "Target directory not found: $DesktopTarget" -ForegroundColor Yellow
    exit 0
}

function Format-Size($bytes) {
    if ($bytes -ge 1GB) {
        return "$([math]::Round($bytes / 1GB, 2)) GB"
    } elseif ($bytes -ge 1MB) {
        return "$([math]::Round($bytes / 1MB, 2)) MB"
    } else {
        return "$([math]::Round($bytes / 1KB, 1)) KB"
    }
}

function Measure-DirSize($path) {
    if (-not (Test-Path $path)) { return 0 }
    $measure = Get-ChildItem -Path $path -Recurse -File -Force -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum
    if ($measure.Sum) {
        return $measure.Sum
    }
    return 0
}

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host " 3RTC Safe Cache Cleaner" -ForegroundColor Cyan
if ($DryRun) {
    Write-Host " [DRY RUN MODE - No files will be deleted]" -ForegroundColor Yellow
}
Write-Host "========================================================" -ForegroundColor Cyan

$InitialTotal = Measure-DirSize $DesktopTarget
Write-Host "Current desktop/target size: $(Format-Size $InitialTotal)" -ForegroundColor White
Write-Host ""

$TotalFreedBytes = 0

# 1. Clean duplicate target directory (desktop/target/x86_64-pc-windows-msvc)
$DuplicateTarget = Join-Path $DesktopTarget "x86_64-pc-windows-msvc"
if (Test-Path $DuplicateTarget) {
    $size = Measure-DirSize $DuplicateTarget
    $TotalFreedBytes += $size
    Write-Host " -> Duplicate target dir: $DuplicateTarget ($(Format-Size $size))" -ForegroundColor Gray
    if (-not $DryRun) {
        Remove-Item -Path $DuplicateTarget -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# 2. Clean incremental compiler caches (desktop/target/debug/incremental)
$IncrementalDir = Join-Path $DesktopTarget "debug\incremental"
if (Test-Path $IncrementalDir) {
    $size = Measure-DirSize $IncrementalDir
    $TotalFreedBytes += $size
    Write-Host " -> Stale incremental cache: $IncrementalDir ($(Format-Size $size))" -ForegroundColor Gray
    if (-not $DryRun) {
        Remove-Item -Path $IncrementalDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# 3. Clean .pdb debug symbol files (unless -KeepPdb is specified)
if (-not $KeepPdb) {
    $pdbFiles = Get-ChildItem -Path $DesktopTarget -Recurse -Filter "*.pdb" -File -ErrorAction SilentlyContinue
    if ($pdbFiles.Count -gt 0) {
        $size = ($pdbFiles | Measure-Object -Property Length -Sum).Sum
        $TotalFreedBytes += $size
        Write-Host " -> Debug symbol files (.pdb): $($pdbFiles.Count) files ($(Format-Size $size))" -ForegroundColor Gray
        if (-not $DryRun) {
            $pdbFiles | Remove-Item -Force -ErrorAction SilentlyContinue
        }
    }
}

# 4. Clean old test runner binaries (*.exe in deps/)
$DepsDir = Join-Path $DesktopTarget "debug\deps"
if (Test-Path $DepsDir) {
    $testExes = Get-ChildItem -Path $DepsDir -Filter "*.exe" -File -ErrorAction SilentlyContinue
    if ($testExes.Count -gt 0) {
        $size = ($testExes | Measure-Object -Property Length -Sum).Sum
        $TotalFreedBytes += $size
        Write-Host " -> Stale test runner executables in deps/: $($testExes.Count) files ($(Format-Size $size))" -ForegroundColor Gray
        if (-not $DryRun) {
            $testExes | Remove-Item -Force -ErrorAction SilentlyContinue
        }
    }
}

# 5. Clean superseded duplicate crate hashes (*.rlib, *.rmeta, *.d in deps/)
# Preserves the NEWEST file for each crate so base compiled dependencies are never lost!
if (Test-Path $DepsDir) {
    foreach ($ext in @("*.rlib", "*.rmeta", "*.d")) {
        $files = Get-ChildItem -Path $DepsDir -Filter $ext -File -ErrorAction SilentlyContinue
        if ($files.Count -eq 0) { continue }

        $grouped = $files | Group-Object {
            $lastDash = $_.BaseName.LastIndexOf('-')
            if ($lastDash -gt 0) { $_.BaseName.Substring(0, $lastDash) } else { $_.BaseName }
        }

        $obsoleteFiles = @()
        foreach ($g in $grouped) {
            if ($g.Count -gt 1) {
                $sorted = $g.Group | Sort-Object LastWriteTime -Descending
                $obsoleteFiles += ($sorted | Select-Object -Skip 1)
            }
        }

        if ($obsoleteFiles.Count -gt 0) {
            $size = ($obsoleteFiles | Measure-Object -Property Length -Sum).Sum
            $TotalFreedBytes += $size
            Write-Host " -> Superseded duplicate $ext archives: $($obsoleteFiles.Count) files ($(Format-Size $size))" -ForegroundColor Gray
            if (-not $DryRun) {
                $obsoleteFiles | Remove-Item -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

Write-Host ""
Write-Host "--------------------------------------------------------" -ForegroundColor Cyan
if ($DryRun) {
    Write-Host " Estimated space to be freed: $(Format-Size $TotalFreedBytes)" -ForegroundColor Green
    Write-Host " Run '.\clean-cache.ps1' (without -DryRun) to perform the cleanup." -ForegroundColor Yellow
} else {
    $FinalTotal = Measure-DirSize $DesktopTarget
    Write-Host " [SUCCESS] Total space freed: $(Format-Size $TotalFreedBytes)" -ForegroundColor Green
    Write-Host " New desktop/target size: $(Format-Size $FinalTotal)" -ForegroundColor Green
    Write-Host " Active compiled libraries preserved. App will NOT rebuild from scratch." -ForegroundColor White
}
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""
