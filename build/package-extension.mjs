#!/usr/bin/env node
// ============================================================================
// package-extension.mjs
// Build a clean, review-safe Chrome Web Store upload ZIP containing ONLY the
// PUBLIC (credential-free) extension runtime files.
//
// IMPORTANT — TWO BUILDS:
//   * Internal build  = background.js       (embeds BHASHINI_* credentials +
//                        direct ULCA/Dhruva calls; SIDELOAD ONLY, never publish)
//   * Public build    = background.public.js (proxy-only, no credentials)
// This script packages the PUBLIC build: it ships background.public.js AS
// background.js and refuses to build if any internal-build credential marker is
// present in the files being packaged.
//
// Usage:
//   node build/package-extension.mjs
// Output:
//   dist/anuvaadmitra-v<version>.zip   (version read from manifest.json)
//
// Requires Node.js 18+. Shells out to the system `zip` (macOS/Linux) or
// PowerShell's Compress-Archive (Windows).
// ============================================================================

import { readFileSync, existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir, platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");              // the extension/ folder
const DIST = join(ROOT, "dist");

// Files to ship. Each entry is { src, dest }: `src` is the repo path, `dest` is
// the name inside the ZIP. The PUBLIC background source is renamed to
// background.js so the manifest's service_worker resolves.
const INCLUDE = [
  { src: "manifest.json",        dest: "manifest.json" },
  { src: "background.public.js", dest: "background.js" },   // PUBLIC build only
  { src: "content.js",           dest: "content.js" },
  { src: "content.css",          dest: "content.css" },
  { src: "popup.html",           dest: "popup.html" },
  { src: "popup.js",             dest: "popup.js" },
  { src: "icons",                dest: "icons" }
];

// Internal-build credential markers. If ANY of these appear in a file being
// packaged, the build is aborted — this is the primary safety gate that stops
// the credentialed internal build from ever being published.
const CREDENTIAL_MARKERS = [
  "BHASHINI_USER_ID",
  "BHASHINI_ULCA_API_KEY",
  "BHASHINI_ULCA_KEY",
  "BHASHINI_PIPELINE_ID",
  "getBhashiniPipeline",
  "bhashiniDirect",
  "bhashiniTransliterateDirect",
  "meity-auth.ulcacontrib.org",
  "dhruva-api.bhashini.gov.in",
  "1285b2f88ac94de7",          // old hardcoded user id (defence in depth)
  "22067923f1-1936"            // old hardcoded udyat key
];

// Upstream API hosts that must NOT appear in the public manifest's
// host_permissions (the proxy calls them server-side).
const FORBIDDEN_MANIFEST_HOSTS = [
  "meity-auth.ulcacontrib.org",
  "dhruva-api.bhashini.gov.in",
  "nlpsangraha.ebhasha.in"
];

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// --- Read version from manifest ---
const manifestPath = join(ROOT, "manifest.json");
if (!existsSync(manifestPath)) fail("manifest.json not found — run from the extension folder.");
const manifestText = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);
const version = manifest.version || "0.0.0";

// --- Verify every required source exists ---
const missing = INCLUDE.filter((e) => !existsSync(join(ROOT, e.src)));
if (missing.length) fail(`Missing required file(s): ${missing.map((e) => e.src).join(", ")}`);

// --- Guard: the public background source must exist and be the public one ---
if (!existsSync(join(ROOT, "background.public.js"))) {
  fail("background.public.js not found — the credential-free public build source is required.");
}

// --- Manifest host_permissions must not include upstream API hosts ---
const hostPerms = manifest.host_permissions || [];
const badHosts = hostPerms.filter((h) => FORBIDDEN_MANIFEST_HOSTS.some((f) => h.includes(f)));
if (badHosts.length) {
  fail(`manifest.json host_permissions includes upstream API host(s) that the public build must not request: ${badHosts.join(", ")}. In the public build these are called by the proxy server-side.`);
}

// --- Credential scan across every file we're about to ship ---
function walk(p) {
  const st = statSync(p);
  if (st.isDirectory()) return readdirSync(p).flatMap((c) => walk(join(p, c)));
  return [p];
}
const shipFiles = INCLUDE.flatMap((e) => walk(join(ROOT, e.src)));
for (const f of shipFiles) {
  if (/\.(png|jpg|jpeg|gif|webp|ico)$/i.test(f)) continue; // skip binaries
  const text = readFileSync(f, "utf8");
  for (const marker of CREDENTIAL_MARKERS) {
    if (text.includes(marker)) {
      fail(`Internal-build marker "${marker}" found in ${f.replace(ROOT, ".")} — this looks like the credentialed internal build. Aborting: never publish the internal build.`);
    }
  }
}

// --- Stage into a temp dir (applying the rename map), then zip ---
const stage = join(tmpdir(), `anuvaadmitra-pkg-${Date.now()}`);
mkdirSync(stage, { recursive: true });
for (const e of INCLUDE) {
  cpSync(join(ROOT, e.src), join(stage, e.dest), { recursive: true });
}

mkdirSync(DIST, { recursive: true });
const outName = `anuvaadmitra-v${version}.zip`;
const outPath = join(DIST, outName);
if (existsSync(outPath)) rmSync(outPath);

try {
  if (platform() === "win32") {
    const psCmd = `Compress-Archive -Path '${stage}\\*' -DestinationPath '${outPath}' -Force`;
    execFileSync("powershell", ["-NoProfile", "-Command", psCmd], { stdio: "inherit" });
  } else {
    execFileSync("zip", ["-r", "-X", outPath, "."], { cwd: stage, stdio: "inherit" });
  }
} catch (e) {
  fail(`Zip step failed: ${e.message}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

const sizeKb = (statSync(outPath).size / 1024).toFixed(1);
console.log(`\n✓ Built ${join("dist", outName)} (${sizeKb} KB) — PUBLIC build`);
console.log(`  Shipped background.public.js as background.js; no credentials present.`);
console.log(`  Version ${version} · included: ${INCLUDE.map((e) => e.dest).join(", ")}`);
console.log("  Upload this ZIP to the Chrome Web Store Developer Dashboard.\n");
