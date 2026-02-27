<#
.SYNOPSIS
    DeskMan Agent Builder — downloads, builds, and outputs a standalone EXE.
.DESCRIPTION
    Run this script on any Windows PC with Python 3.8+ installed.
    It downloads all agent source files from GitHub, embeds your Supabase
    credentials, compiles into a single .exe via PyInstaller, and opens the
    output folder. No manual cloning or file downloads needed.
.PARAMETER Url
    Your Supabase project URL (e.g. https://xxxx.supabase.co)
.PARAMETER Key
    Your Supabase service_role key
.PARAMETER Name
    Output executable name (default: deskman_agent)
.PARAMETER NoConsole
    Hide the console window so the agent runs silently
.PARAMETER Branch
    GitHub branch to pull source from (default: main)
.EXAMPLE
    .\build_remote.ps1 -Url "https://xxx.supabase.co" -Key "eyJ..." -Name "deskman_agent" -NoConsole
#>
param(
    [Parameter(Mandatory=$true)]  [string]$Url,
    [Parameter(Mandatory=$true)]  [string]$Key,
    [string]$Name = "deskman_agent",
    [switch]$NoConsole,
    [string]$Branch = "main",
    [string]$Repo = "shafferelisa9-cell/deskman"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # speeds up Invoke-WebRequest

$banner = @"
============================================================
  DeskMan Agent Builder (Remote)
  Builds a standalone .exe with embedded credentials
============================================================
"@
Write-Host $banner -ForegroundColor Cyan

# ---------- 1. Check Python ----------
Write-Host "`n[1/6] Checking for Python..." -ForegroundColor Yellow
$python = $null
foreach ($cmd in @("python", "python3", "py")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python 3") {
            $python = $cmd
            Write-Host "       Found: $ver" -ForegroundColor Green
            break
        }
    } catch {}
}
if (-not $python) {
    Write-Host "       ERROR: Python 3 is required but not found." -ForegroundColor Red
    Write-Host "       Install from https://www.python.org/downloads/" -ForegroundColor Red
    Write-Host "       Make sure to check 'Add Python to PATH' during install." -ForegroundColor Red
    exit 1
}

# ---------- 2. Create temp build directory ----------
Write-Host "`n[2/6] Setting up build workspace..." -ForegroundColor Yellow
$buildDir = Join-Path $env:TEMP "deskman_build_$(Get-Random)"
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
Write-Host "       Workspace: $buildDir" -ForegroundColor Gray

# ---------- 3. Download agent source files ----------
Write-Host "`n[3/6] Downloading agent source files..." -ForegroundColor Yellow
$rawBase = "https://raw.githubusercontent.com/$Repo/$Branch/agent"
$files = @("deskman_agent.py", "requirements.txt")

foreach ($file in $files) {
    $dest = Join-Path $buildDir $file
    $fileUrl = "$rawBase/$file"
    Write-Host "       Downloading $file..." -ForegroundColor Gray
    try {
        Invoke-WebRequest -Uri $fileUrl -OutFile $dest -UseBasicParsing
    } catch {
        Write-Host "       ERROR: Failed to download $file from $fileUrl" -ForegroundColor Red
        Write-Host "       Check the repo URL and branch name." -ForegroundColor Red
        Remove-Item -Recurse -Force $buildDir -ErrorAction SilentlyContinue
        exit 1
    }
}

# Write embedded_config.py with the provided credentials
Write-Host "       Writing embedded configuration..." -ForegroundColor Gray
$configContent = @"
# DeskMan Agent - Embedded Configuration (auto-generated)
SUPABASE_URL = "$Url"
SUPABASE_KEY = "$Key"
HEARTBEAT_INTERVAL = 30
COMMAND_POLL_INTERVAL = 2
"@
$configContent | Out-File -FilePath (Join-Path $buildDir "embedded_config.py") -Encoding utf8

# ---------- 4. Install dependencies ----------
Write-Host "`n[4/6] Installing dependencies..." -ForegroundColor Yellow
$reqFile = Join-Path $buildDir "requirements.txt"
& $python -m pip install --quiet --upgrade pip 2>&1 | Out-Null
& $python -m pip install --quiet -r $reqFile 2>&1 | Out-Null
& $python -m pip install --quiet pyinstaller 2>&1 | Out-Null
Write-Host "       Dependencies installed." -ForegroundColor Green

# ---------- 5. Build EXE with PyInstaller ----------
Write-Host "`n[5/6] Compiling standalone EXE (this may take a few minutes)..." -ForegroundColor Yellow

$agentScript = Join-Path $buildDir "deskman_agent.py"
$configFile  = Join-Path $buildDir "embedded_config.py"
$distDir     = Join-Path $buildDir "dist"
$workDir     = Join-Path $buildDir "build_temp"

$pyiArgs = @(
    "-m", "PyInstaller",
    "--name", $Name,
    "--onefile",
    "--clean",
    "--noconfirm",
    "--distpath", $distDir,
    "--workpath", $workDir,
    "--add-data", "$configFile;.",
    "--hidden-import", "supabase",
    "--hidden-import", "gotrue",
    "--hidden-import", "postgrest",
    "--hidden-import", "storage3",
    "--hidden-import", "realtime",
    "--hidden-import", "supafunc",
    "--hidden-import", "psutil",
    "--hidden-import", "mss",
    "--hidden-import", "mss.windows",
    "--hidden-import", "PIL",
    "--hidden-import", "PIL.Image"
)
if ($NoConsole) {
    $pyiArgs += "--noconsole"
}
$pyiArgs += $agentScript

& $python $pyiArgs 2>&1 | ForEach-Object {
    if ($_ -match "ERROR|error") {
        Write-Host "       $_" -ForegroundColor Red
    } elseif ($_ -match "Building|Appending|Copying") {
        Write-Host "       $_" -ForegroundColor Gray
    }
}

$exePath = Join-Path $distDir "$Name.exe"
if (-not (Test-Path $exePath)) {
    Write-Host "`n       ERROR: Build failed — EXE not found." -ForegroundColor Red
    exit 1
}

# ---------- 6. Deliver the EXE ----------
Write-Host "`n[6/6] Finalizing..." -ForegroundColor Yellow

# Copy EXE to user's Desktop for easy access
$desktopDir = [Environment]::GetFolderPath("Desktop")
$outputDir  = Join-Path $desktopDir "DeskMan_Agent"
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
Copy-Item -Path $exePath -Destination $outputDir -Force

$finalExe = Join-Path $outputDir "$Name.exe"
$sizeMB   = [math]::Round((Get-Item $finalExe).Length / 1MB, 1)

# Cleanup build workspace
Remove-Item -Recurse -Force $buildDir -ErrorAction SilentlyContinue

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host "  BUILD SUCCESSFUL" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  EXE:  $finalExe" -ForegroundColor White
Write-Host "  Size: $sizeMB MB" -ForegroundColor White
Write-Host ""
Write-Host "  Each PC that runs this EXE gets a unique Agent ID." -ForegroundColor Cyan
Write-Host "  Just copy the EXE to any Windows PC and run it." -ForegroundColor Cyan
Write-Host "  No Python or dependencies needed on the target." -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Green

# Open the output folder
explorer.exe $outputDir
