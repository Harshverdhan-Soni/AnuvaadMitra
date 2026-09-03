# ============================================================================
# make-internal-test.ps1
# Assemble an UNPACKED internal-test build that talks to the proxy on the C-DAC
# LAN over plain HTTP. Testers load the output folder via
# chrome://extensions -> Developer mode -> "Load unpacked".
#
#   .\build\make-internal-test.ps1 [-ProxyBase "http://10.248.0.55:8080"]
#   output: dist-internal\   (an unpacked extension folder)
#
# INTERNAL LAN TESTING ONLY. Built from the credential-free background.public.js;
# never upload dist-internal\ to the Chrome Web Store.
# ============================================================================

param(
  [string]$ProxyBase = "http://10.248.0.55:8080"
)
$ErrorActionPreference = "Stop"
$ProxyBase = $ProxyBase.TrimEnd('/')

$Root = Split-Path -Parent $PSScriptRoot
$Out  = Join-Path $Root "dist-internal"
$Copy = @("content.js", "content.css", "popup.html", "popup.js", "icons")

$CredentialMarkers = @(
  "BHASHINI_USER_ID", "BHASHINI_ULCA_API_KEY", "BHASHINI_ULCA_KEY",
  "BHASHINI_PIPELINE_ID", "getBhashiniPipeline", "bhashiniDirect",
  "bhashiniTransliterateDirect", "meity-auth.ulcacontrib.org",
  "dhruva-api.bhashini.gov.in", "1285b2f88ac94de7", "22067923f1-1936"
)

$pubPath = Join-Path $Root "background.public.js"
if (-not (Test-Path $pubPath)) { throw "background.public.js not found." }
$bg = Get-Content $pubPath -Raw
foreach ($m in $CredentialMarkers) {
  if ($bg -like "*$m*") { throw "Internal-build marker '$m' found in background.public.js - refusing to build." }
}

$new = $bg -replace 'const DEFAULT_PROXY_BASE = "[^"]*";', ('const DEFAULT_PROXY_BASE = "' + $ProxyBase + '";')
if ($new -eq $bg) { throw "Could not find DEFAULT_PROXY_BASE line to set." }
$bg = $new

$manifest = Get-Content (Join-Path $Root "manifest.json") -Raw | ConvertFrom-Json
$manifest.host_permissions = @("https://translate.googleapis.com/*", "$ProxyBase/*")
if ($manifest.name -notlike "*(Internal Test)*") { $manifest.name = "$($manifest.name) (Internal Test)" }

if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Path $Out -Force | Out-Null
Set-Content -Path (Join-Path $Out "background.js") -Value $bg -NoNewline
($manifest | ConvertTo-Json -Depth 20) | Set-Content -Path (Join-Path $Out "manifest.json")
foreach ($p in $Copy) { Copy-Item (Join-Path $Root $p) (Join-Path $Out $p) -Recurse }

Write-Host ""
Write-Host "OK  Built internal test build -> dist-internal\" -ForegroundColor Green
Write-Host "    Proxy: $ProxyBase"
Write-Host "    Load it: chrome://extensions -> Developer mode -> Load unpacked -> select dist-internal\"
Write-Host "    NOTE: internal LAN testing only - never upload dist-internal\ to the Web Store."
Write-Host ""
