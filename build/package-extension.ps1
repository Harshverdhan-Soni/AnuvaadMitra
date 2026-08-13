# ============================================================================
# package-extension.ps1
# Build a clean Chrome Web Store upload ZIP with ONLY the extension runtime
# files. Run from anywhere; paths resolve relative to this script.
#
#   PowerShell:  .\build\package-extension.ps1
#   Output:      dist\anuvaadmitra-v<version>.zip
# ============================================================================

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot           # the extension\ folder
$Dist = Join-Path $Root "dist"

# Only these top-level entries ship.
$Include = @(
  "manifest.json",
  "background.js",
  "content.js",
  "content.css",
  "popup.html",
  "popup.js",
  "icons"
)

# Read version from manifest.
$manifestPath = Join-Path $Root "manifest.json"
if (-not (Test-Path $manifestPath)) { throw "manifest.json not found." }
$version = (Get-Content $manifestPath -Raw | ConvertFrom-Json).version
if (-not $version) { $version = "0.0.0" }

# Verify required files exist.
$missing = $Include | Where-Object { -not (Test-Path (Join-Path $Root $_)) }
if ($missing) { throw "Missing required file(s): $($missing -join ', ')" }

# Secret scan over shippable text files.
$patterns = @("1285b2f88ac94de7", "22067923f1-1936", "BHASHINI_ULCA_KEY=")
foreach ($item in $Include) {
  $full = Join-Path $Root $item
  $files = if (Test-Path $full -PathType Container) { Get-ChildItem $full -Recurse -File } else { Get-Item $full }
  foreach ($f in $files) {
    if ($f.Extension -match '\.(png|jpg|jpeg|gif|webp|ico)$') { continue }
    $content = Get-Content $f.FullName -Raw
    foreach ($p in $patterns) {
      if ($content -like "*$p*") { throw "Possible secret '$p' found in $($f.FullName) — aborting." }
    }
  }
}

# Stage into a temp folder, then compress its contents.
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("anuvaadmitra-pkg-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($item in $Include) {
  Copy-Item (Join-Path $Root $item) (Join-Path $stage $item) -Recurse
}

New-Item -ItemType Directory -Path $Dist -Force | Out-Null
$outPath = Join-Path $Dist ("anuvaadmitra-v{0}.zip" -f $version)
if (Test-Path $outPath) { Remove-Item $outPath -Force }

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $outPath -Force
Remove-Item $stage -Recurse -Force

$sizeKb = "{0:N1}" -f ((Get-Item $outPath).Length / 1KB)
Write-Host ""
Write-Host "OK  Built dist\anuvaadmitra-v$version.zip ($sizeKb KB)" -ForegroundColor Green
Write-Host "    Included: $($Include -join ', ')"
Write-Host "    Upload this ZIP to the Chrome Web Store Developer Dashboard."
Write-Host ""
