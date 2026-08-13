#!/usr/bin/env node
// ============================================================================
// package-extension.mjs
// Build a clean, review-safe Chrome Web Store upload ZIP containing ONLY the
// extension runtime files. Everything else (proxy server, docs, privacy policy,
// git metadata, build tooling) is excluded.
//
// Usage:
//   node build/package-extension.mjs
// Output:
//   dist/anuvaadmitra-v<version>.zip   (version read from manifest.json)
//
// Requires Node.js 18+. No external dependencies — shells out to the system
// `zip` on macOS/Linux, or PowerShell's Compress-Archive on Windows.
// ============================================================================

import { readFileSync, existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir, platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");              // the extension/ folder
const DIST = join(ROOT, "dist");

// Only these top-level entries are shipped. Add here if you add real runtime
// files (e.g. an options page). Keep everything else OUT.
const INCLUDE = [
  "manifest.json",
  "background.js",
  "content.js",
  "content.css",
  "popup.html",
  "popup.js",
  "icons"
];

// Sanity: things that must never end up in the package.
const FORBIDDEN = [
  "proxy-server",
  "privacy-policy",
  ".git",
  ".gitignore",
  "build",
  "dist",
  "node_modules",
  "store-submission.md",
  "README.md"
];

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// --- Read version from manifest ---
const manifestPath = join(ROOT, "manifest.json");
if (!existsSync(manifestPath)) fail("manifest.json not found — run from the extension folder.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const version = manifest.version || "0.0.0";

// --- Verify every required file exists ---
const missing = INCLUDE.filter((p) => !existsSync(join(ROOT, p)));
if (missing.length) fail(`Missing required file(s): ${missing.join(", ")}`);

// --- Guard: fail loudly if any forbidden path sneaks into INCLUDE ---
const leaked = INCLUDE.filter((p) => FORBIDDEN.includes(p));
if (leaked.length) fail(`INCLUDE lists forbidden path(s): ${leaked.join(", ")}`);

// --- Secret scan across the files we're about to ship ---
function walk(p) {
  const st = statSync(p);
  if (st.isDirectory()) return readdirSync(p).flatMap((c) => walk(join(p, c)));
  return [p];
}
const shipFiles = INCLUDE.flatMap((p) => walk(join(ROOT, p)));
const secretPatterns = [
  /1285b2f88ac94de7/,               // old hardcoded Bhashini user id
  /22067923f1-1936/,                // old hardcoded Udyat key
  /ulcaApiKey\s*:\s*["'][^"']+["']/, // any inline ULCA key
  /BHASHINI_ULCA_KEY\s*=\s*\S/       // any baked env secret
];
for (const f of shipFiles) {
  if (/\.(png|jpg|jpeg|gif|webp|ico)$/i.test(f)) continue; // skip binaries
  const text = readFileSync(f, "utf8");
  for (const re of secretPatterns) {
    if (re.test(text)) fail(`Possible secret found in ${f.replace(ROOT, ".")} — aborting. Pattern: ${re}`);
  }
}

// --- Stage into a temp dir, then zip ---
const stage = join(tmpdir(), `anuvaadmitra-pkg-${Date.now()}`);
mkdirSync(stage, { recursive: true });
for (const p of INCLUDE) {
  cpSync(join(ROOT, p), join(stage, p), { recursive: true });
}

mkdirSync(DIST, { recursive: true });
const outName = `anuvaadmitra-v${version}.zip`;
const outPath = join(DIST, outName);
if (existsSync(outPath)) rmSync(outPath);

try {
  if (platform() === "win32") {
    // PowerShell Compress-Archive: zip the staged CONTENTS (note the \*).
    const psCmd = `Compress-Archive -Path '${stage}\\*' -DestinationPath '${outPath}' -Force`;
    execFileSync("powershell", ["-NoProfile", "-Command", psCmd], { stdio: "inherit" });
  } else {
    // `zip -r <out> .` from inside the stage dir so paths are relative.
    execFileSync("zip", ["-r", "-X", outPath, "."], { cwd: stage, stdio: "inherit" });
  }
} catch (e) {
  fail(`Zip step failed: ${e.message}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

const sizeKb = (statSync(outPath).size / 1024).toFixed(1);
console.log(`\n✓ Built ${join("dist", outName)} (${sizeKb} KB)`);
console.log(`  Version ${version} · included: ${INCLUDE.join(", ")}`);
console.log("  Upload this ZIP to the Chrome Web Store Developer Dashboard.\n");
