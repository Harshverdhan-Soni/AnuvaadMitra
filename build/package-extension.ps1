# ============================================================================
# package-extension.ps1
# Build a clean Chrome Web Store upload ZIP with ONLY the PUBLIC
# (credential-free) extension runtime files.
#
# TWO BUILDS:
#   * Internal build = background.js        (embeds credentials; SIDELOAD ONLY)
#   * Public build   = background.public.js (proxy-only, no credentials)
# This packages the PUBLIC build: ships background.public.js AS background.js and
# refuses to build if any internal-build credential marker is present.
#
#   PowerShell:  .\build\package-extension.ps1
#   Output:      dist\anuvaadmitra-v<version>.zip
# ============================================================================

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot           # the extension\ folder
$Dist = Join-Path $Root "dist"

# Ship list: @{ Src = repo path; Dest = name inside the ZIP }
$Include = @(
  @{ Src = "manifest.json";        Dest = "manifest.json" },
  @{ Src = "background.public.js"; Dest = "background.js" },   # PUBLIC build only
  @{ Src = "content.js";           Dest = "content.js" },
  @{ Src = "content.css";          Dest = "content.css" },
  @{ Src = "popup.html";           Dest = "popup.html" },
  @{ Src = "popup.js";             Dest = "popup.js" },
  @{ Src = "icons";                Dest = "icons" }
)

$CredentialMarkers = @(
  "BHASHINI_USER_ID", "BHASHINI_ULCA_API_KEY", "BHASHINI_ULCA_KEY",
  "BHASHINI_PIPELINE_ID", "getBhashiniPipeline", "bhashiniDirect",
  "bhashiniTransliterateDirect", "meity-auth.ulcacontrib.org",
  "dhruva-api.bhashini.gov.in", "1285b2f88ac94de7", "22067923f1-1936"
)
$ForbiddenManifestHosts = @(
  "meity-auth.ulcacontrib.org", "dhruva-api.bhashini.gov.in", "nlpsangraha.ebhasha.in"
)

# Read + validate manifest.
$manifestPath = Join-Path $Root "manifest.json"
if (-not (Test-Path $manifestPath)) { throw "manifest.json not found." }
$manifestText = Get-Content $manifestPath -Raw
$manifest = $manifestText | ConvertFrom-Json
$version = if ($manifest.version) { $manifest.version } else { "0.0.0" }

foreach ($h in $manifest.host_permissions) {
  foreach ($f in $ForbiddenManifestHosts) {
    if ($h -like "*$f*") { throw "manifest.json host_permissions includes upstream API host '$f' — the public build must not request it (the proxy calls it server-side)." }
  }
}

# Verify sources exist.
$missing = $Include | Where-Object { -not (Test-Path (Join-Path $Root $_.Src)) }
if ($missing) { throw "Missing required file(s): $(($missing | ForEach-Object { $_.Src }) -join ', ')" }
if (-not (Test-Path (Join-Path $Root "background.public.js"))) {
  throw "background.public.js not found — the credential-free public build source is required."
}

# Credential scan over shippable text files.
foreach ($item in $Include) {
  $full = Join-Path $Root $item.Src
  $files = if (Test-Path $full -PathType Container) { Get-ChildItem $full -Recurse -File } else { Get-Item $full }
  foreach ($f in $files) {
    if ($f.Extension -match '\.(png|jpg|jpeg|gif|webp|ico)$') { continue }
    $content = Get-Content $f.FullName -Raw
    foreach ($m in $CredentialMarkers) {
      if ($content -like "*$m*") { throw "Internal-build marker '$m' found in $($f.FullName) — this looks like the credentialed internal build. Aborting: never publish the internal build." }
    }
  }
}

# Stage (apply rename map), then compress.
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("anuvaadmitra-pkg-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($item in $Include) {
  Copy-Item (Join-Path $Root $item.Src) (Join-Path $stage $item.Dest) -Recurse
}

New-Item -ItemType Directory -Path $Dist -Force | Out-Null
$outPath = Join-Path $Dist ("anuvaadmitra-v{0}.zip" -f $version)
if (Test-Path $outPath) { Remove-Item $outPath -Force }

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $outPath -Force
Remove-Item $stage -Recurse -Force

$sizeKb = "{0:N1}" -f ((Get-Item $outPath).Length / 1KB)
Write-Host ""
Write-Host "OK  Built dist\anuvaadmitra-v$version.zip ($sizeKb KB) - PUBLIC build" -ForegroundColor Green
Write-Host "    Shipped background.public.js as background.js; no credentials present."
Write-Host "    Included: $(($Include | ForEach-Object { $_.Dest }) -join ', ')"
Write-Host "    Upload this ZIP to the Chrome Web Store Developer Dashboard."
Write-Host ""
