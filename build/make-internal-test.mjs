#!/usr/bin/env node
// ============================================================================
// make-internal-test.mjs
// Assemble an UNPACKED internal-test build of the extension that talks to the
// proxy on the C-DAC LAN over plain HTTP. Testers load the output folder via
// chrome://extensions → Developer mode → "Load unpacked".
//
//   node build/make-internal-test.mjs [proxyBase]
//   default proxyBase: http://10.248.0.55:8080
//   output: dist-internal/   (an unpacked extension folder)
//
// This is for INTERNAL LAN TESTING ONLY — it points at a private IP over HTTP
// and must never be uploaded to the Chrome Web Store. It is still built from the
// credential-free public background (background.public.js); the same credential
// guard applies, so it can never accidentally ship the internal credentialed
// build.
// ============================================================================

import { readFileSync, existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "dist-internal");

// Where the proxy is reachable on the LAN. Override with a CLI arg if the IP
// or port changes, e.g.:  node build/make-internal-test.mjs http://10.248.0.55:8080
const PROXY_BASE = (process.argv[2] || "http://10.248.0.55:8080").replace(/\/+$/, "");

// Shared runtime files copied as-is.
const COPY = ["content.js", "content.css", "popup.html", "popup.js", "icons"];

const CREDENTIAL_MARKERS = [
  "BHASHINI_USER_ID", "BHASHINI_ULCA_API_KEY", "BHASHINI_ULCA_KEY",
  "BHASHINI_PIPELINE_ID", "getBhashiniPipeline", "bhashiniDirect",
  "bhashiniTransliterateDirect", "meity-auth.ulcacontrib.org",
  "dhruva-api.bhashini.gov.in", "1285b2f88ac94de7", "22067923f1-1936"
];

function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }

// --- Source background must be the credential-free public build ---
const pubPath = join(ROOT, "background.public.js");
if (!existsSync(pubPath)) fail("background.public.js not found.");
let bg = readFileSync(pubPath, "utf8");
for (const m of CREDENTIAL_MARKERS) {
  if (bg.includes(m)) fail(`Internal-build marker "${m}" found in background.public.js — refusing to build.`);
}

// --- Bake the LAN proxy URL into DEFAULT_PROXY_BASE ---
const before = bg;
bg = bg.replace(
  /const DEFAULT_PROXY_BASE = "[^"]*";/,
  `const DEFAULT_PROXY_BASE = "${PROXY_BASE}";`
);
if (bg === before) fail("Could not find DEFAULT_PROXY_BASE line to set in background.public.js.");

// --- Build the internal manifest: Google + the LAN proxy host only ---
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
manifest.host_permissions = [
  "https://translate.googleapis.com/*",
  `${PROXY_BASE}/*`
];
// Mark the build so it can never be confused with the store build.
manifest.name = manifest.name.includes("(Internal Test)")
  ? manifest.name
  : `${manifest.name} (Internal Test)`;

// --- Write output folder ---
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "background.js"), bg);
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const p of COPY) cpSync(join(ROOT, p), join(OUT, p), { recursive: true });

console.log(`\n✓ Built internal test build → dist-internal/`);
console.log(`  Proxy: ${PROXY_BASE}`);
console.log(`  host_permissions: ${manifest.host_permissions.join(", ")}`);
console.log(`  Load it: chrome://extensions → Developer mode → Load unpacked → select dist-internal/`);
console.log(`  NOTE: internal LAN testing only — never upload dist-internal/ to the Web Store.\n`);
