# Installs your Earth Engine service-account key into this project.
#
# Usage — from a PowerShell window in this folder:
#
#     .\install-key.ps1
#         ...searches your usual download folders for the key and installs it.
#
#     .\install-key.ps1 -Path "C:\somewhere\my-key.json"
#         ...uses the exact file you point at.
#
# It copies the key to earthengine-key.json, writes .env.local, and prints a
# summary. It never displays the private key itself.

param(
    [string]$Path = ""
)

$ErrorActionPreference = "Stop"
$projectDir = $PSScriptRoot
$dest = Join-Path $projectDir "earthengine-key.json"
$envFile = Join-Path $projectDir ".env.local"

function Test-IsServiceAccountKey([string]$file) {
    try {
        $j = Get-Content $file -Raw | ConvertFrom-Json
        return ($j.type -eq "service_account" -and $j.client_email -and $j.private_key)
    } catch {
        return $false
    }
}

# --- find the key -----------------------------------------------------------
$found = $null

if ($Path -ne "") {
    if (-not (Test-Path $Path)) { Write-Host "No file at: $Path" -ForegroundColor Red; exit 1 }
    if (-not (Test-IsServiceAccountKey $Path)) {
        Write-Host "That file is not a Google service-account key." -ForegroundColor Red
        Write-Host "Expected JSON containing `"type`": `"service_account`"." -ForegroundColor Yellow
        exit 1
    }
    $found = $Path
} else {
    Write-Host "Searching for a service-account key..." -ForegroundColor Cyan
    $searchDirs = @(
        "$env:USERPROFILE\Downloads",
        "$env:USERPROFILE\Desktop",
        "$env:USERPROFILE\Documents",
        $projectDir
    )
    foreach ($od in @($env:OneDrive, $env:OneDriveCommercial)) {
        if ($od) { foreach ($s in @("Downloads", "Desktop", "Documents")) { $searchDirs += (Join-Path $od $s) } }
    }

    $candidates = @()
    foreach ($d in ($searchDirs | Sort-Object -Unique)) {
        if (-not (Test-Path $d)) { continue }
        Get-ChildItem -Path $d -Filter *.json -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 40 |
            ForEach-Object { if (Test-IsServiceAccountKey $_.FullName) { $candidates += $_ } }
    }

    if ($candidates.Count -eq 0) {
        Write-Host ""
        Write-Host "No service-account key found." -ForegroundColor Red
        Write-Host "Searched:" -ForegroundColor Yellow
        foreach ($d in ($searchDirs | Sort-Object -Unique)) { Write-Host "   $d" }
        Write-Host ""
        Write-Host "If the file is somewhere else, run:" -ForegroundColor Yellow
        Write-Host '   .\install-key.ps1 -Path "C:\path\to\your-key.json"'
        exit 1
    }

    $found = ($candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
    Write-Host "Found: $found" -ForegroundColor Green
}

# --- install ----------------------------------------------------------------
$key = Get-Content $found -Raw | ConvertFrom-Json
$projectId = $key.project_id

Copy-Item -LiteralPath $found -Destination $dest -Force

# MERGE into .env.local, never overwrite it.
#
# This script used to replace the whole file. That was harmless when Earth
# Engine was the only thing needing settings, but .env.local now also holds the
# Cloudflare R2 and Supabase entries. Overwriting it would silently delete them:
# the site would keep working, just slowly and without a cache, and nothing
# would say why. Re-running a setup script must never destroy other setup.
$settings = [ordered]@{
    GEE_PROJECT_ID = $projectId
    GEE_KEY_FILE   = "./earthengine-key.json"
}

$lines = if (Test-Path $envFile) { @(Get-Content -LiteralPath $envFile) } else { @() }
foreach ($name in $settings.Keys) {
    $replaced = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*$name\s*=") {
            $lines[$i] = "$name=$($settings[$name])"
            $replaced = $true
            break
        }
    }
    if (-not $replaced) { $lines += "$name=$($settings[$name])" }
}
$kept = ($lines | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=' }).Count - $settings.Count

Set-Content -LiteralPath $envFile -Value $lines -Encoding ascii

Write-Host ""
Write-Host "Installed." -ForegroundColor Green
Write-Host "  key file    : earthengine-key.json"
Write-Host "  .env.local  : written"
Write-Host "  project id  : $projectId"
Write-Host "  account     : $($key.client_email)"
if ($kept -gt 0) {
    Write-Host "  kept        : $kept other setting(s) already in .env.local, untouched"
}
Write-Host ""
Write-Host "Both files are git-ignored, so they will not be uploaded anywhere." -ForegroundColor Cyan
Write-Host ""
Write-Host "NOW RESTART THE WEBSITE so it picks up the new settings:" -ForegroundColor Yellow
Write-Host "   press Ctrl+C in the window running the site, then:  npm run dev"
