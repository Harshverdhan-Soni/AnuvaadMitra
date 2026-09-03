// ============================================================================
// AnuvaadMitra translation proxy
// ----------------------------------------------------------------------------
// A small credential-holding proxy that sits between the Chrome extension and
// the upstream translation services. It exposes a clean, credential-free API
// to the extension:
//
//   POST /api/translate      { engine: "bhashini" | "cdac", text }  -> { translation }
//   POST /api/transliterate  { text, numSuggestions }               -> { candidates: [] }
//   GET  /healthz                                                    -> { ok: true }
//
// The real Bhashini credentials live ONLY here, in environment variables, and
// never reach the browser. Deploy this on a C-DAC-controlled server behind
// HTTPS. See README.md for deployment on a C-DAC box.
//
// Runtime: Node.js 18+ (uses the built-in global `fetch`). No native deps.
// ============================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");

// Minimal .env loader (no external dependency). Loads KEY=VALUE lines from a
// .env file next to this script into process.env, without overriding vars that
// are already set in the real environment (systemd/Docker take precedence).
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) {
    // ignore malformed .env — real environment variables still apply
  }
})();

// --------------------------- Configuration ---------------------------------
const PORT = parseInt(process.env.PORT || "8080", 10);

// Bhashini / ULCA credentials — REQUIRED for the Bhashini + transliteration
// features. Keep these out of source control; supply via environment.
const BHASHINI_USER_ID = process.env.BHASHINI_USER_ID || "";
const BHASHINI_ULCA_KEY = process.env.BHASHINI_ULCA_KEY || "";
const MEITY_PIPELINE_ID = process.env.MEITY_PIPELINE_ID || "64392f96daac500b55c543cd";

const BHASHINI_CONFIG_URL =
  process.env.BHASHINI_CONFIG_URL ||
  "https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline";

const CDAC_PUNE_URL =
  process.env.CDAC_PUNE_URL || "https://nlpsangraha.ebhasha.in/getTranslation";

// Comma-separated allow-list of browser origins, e.g.
//   chrome-extension://abcdefghijklmnopabcdefghijklmnop
// Use "*" only for local testing. Lock this to the published extension ID.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Simple per-IP rate limit to protect the Bhashini quota from abuse.
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "120", 10);

const MAX_TEXT_LENGTH = parseInt(process.env.MAX_TEXT_LENGTH || "5000", 10);

// ------------------------------ App setup -----------------------------------
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowAll = ALLOWED_ORIGINS.includes("*");
  if (allowAll) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Private Network Access: when the extension (a secure context) calls this
  // proxy on a private/LAN IP over plain HTTP, Chrome sends a preflight with
  // `Access-Control-Request-Private-Network: true` and requires this response
  // header to permit it. Needed for internal HTTP-to-IP testing; harmless in
  // public HTTPS deployment.
  if (req.headers["access-control-request-private-network"]) {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Very small in-memory rate limiter (per IP, fixed window).
const hits = new Map();
app.use((req, res, next) => {
  if (req.path === "/healthz") return next();
  const now = Date.now();
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const rec = hits.get(ip);
  if (!rec || now - rec.start >= RATE_LIMIT_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
  } else {
    rec.count += 1;
    if (rec.count > RATE_LIMIT_MAX) {
      return res.status(429).json({ error: "rate limit exceeded — try again shortly" });
    }
  }
  next();
});

// Periodically evict stale rate-limit records so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) {
    if (now - rec.start >= RATE_LIMIT_WINDOW_MS) hits.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

// ----------------------- Bhashini session handling --------------------------
// Cache the resolved pipeline session (service id + inference endpoint) so we
// don't re-run the config call on every request. Re-fetched automatically on
// a 401/403 from the compute call.
let translationSession = null;
let transliterationSession = null;

function requireBhashiniCreds() {
  if (!BHASHINI_USER_ID || !BHASHINI_ULCA_KEY) {
    const err = new Error("server missing Bhashini credentials (BHASHINI_USER_ID / BHASHINI_ULCA_KEY)");
    err.status = 503;
    throw err;
  }
}

async function fetchBhashiniConfig(taskType) {
  requireBhashiniCreds();
  const response = await fetch(BHASHINI_CONFIG_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      userID: BHASHINI_USER_ID,
      ulcaApiKey: BHASHINI_ULCA_KEY
    },
    body: JSON.stringify({
      pipelineTasks: [
        { taskType, config: { language: { sourceLanguage: "en", targetLanguage: "hi" } } }
      ],
      pipelineRequestConfig: { pipelineId: MEITY_PIPELINE_ID }
    })
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      const err = new Error("Bhashini credentials rejected by ULCA (check User ID / Udyat Key)");
      err.status = 502;
      throw err;
    }
    const err = new Error(`Bhashini config call failed (HTTP ${response.status})`);
    err.status = 502;
    throw err;
  }

  const data = await response.json();
  const serviceId = data?.pipelineResponseConfig?.[0]?.config?.[0]?.serviceId;
  const endpoint = data?.pipelineInferenceAPIEndPoint;
  const callbackUrl = endpoint?.callbackUrl;
  const headerName = endpoint?.inferenceApiKey?.name || "Authorization";
  const headerValue = endpoint?.inferenceApiKey?.value;

  if (!serviceId || !callbackUrl || !headerValue) {
    const err = new Error(`Bhashini ${taskType} not available for this account/pipeline`);
    err.status = 502;
    throw err;
  }
  return { callbackUrl, headerName, headerValue, serviceId };
}

async function getTranslationSession() {
  if (!translationSession) translationSession = await fetchBhashiniConfig("translation");
  return translationSession;
}

async function getTransliterationSession() {
  if (!transliterationSession) transliterationSession = await fetchBhashiniConfig("transliteration");
  return transliterationSession;
}

// ------------------------------- Engines ------------------------------------
async function bhashiniTranslate(text) {
  let session = await getTranslationSession();

  const doCompute = () =>
    fetch(session.callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", [session.headerName]: session.headerValue },
      body: JSON.stringify({
        pipelineTasks: [
          {
            taskType: "translation",
            config: { language: { sourceLanguage: "en", targetLanguage: "hi" }, serviceId: session.serviceId }
          }
        ],
        inputData: { input: [{ source: text }] }
      })
    });

  let response = await doCompute();
  if (response.status === 401 || response.status === 403) {
    translationSession = null;
    session = await getTranslationSession();
    response = await doCompute();
  }
  if (!response.ok) {
    const err = new Error(`Bhashini request failed (HTTP ${response.status})`);
    err.status = 502;
    throw err;
  }
  const data = await response.json();
  const hindi = data?.pipelineResponse?.[0]?.output?.[0]?.target?.trim();
  if (!hindi) {
    const err = new Error("Bhashini returned an empty translation");
    err.status = 502;
    throw err;
  }
  return hindi;
}

async function cdacPuneTranslate(text) {
  let response;
  try {
    response = await fetch(CDAC_PUNE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip_text: text, srcLang: "eng-latn", tgtLang: "hin-deva" })
    });
  } catch (_) {
    const err = new Error("C-DAC Pune endpoint unreachable from the server");
    err.status = 502;
    throw err;
  }
  if (!response.ok) {
    const err = new Error(`C-DAC Pune request failed (HTTP ${response.status})`);
    err.status = 502;
    throw err;
  }
  const data = await response.json();
  const hindi = extractCdacTranslation(data);
  if (!hindi) {
    const err = new Error("C-DAC Pune returned an unrecognized response");
    err.status = 502;
    throw err;
  }
  return hindi;
}

function extractCdacTranslation(data) {
  if (typeof data === "string") return data.trim();
  const directKeys = [
    "Output", "output",
    "op_text", "output_text", "translated_text", "translatedText",
    "translation", "target", "hin_text", "result", "text"
  ];
  for (const key of directKeys) {
    const val = data?.[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  if (Array.isArray(data?.output) && data.output[0]) {
    for (const key of directKeys) {
      const val = data.output[0]?.[key];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
  }
  if (data?.data && typeof data.data === "object") {
    return extractCdacTranslation(data.data);
  }
  return null;
}

async function bhashiniTransliterate(romanWord, numSuggestions) {
  let session = await getTransliterationSession();

  const doCompute = () =>
    fetch(session.callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", [session.headerName]: session.headerValue },
      body: JSON.stringify({
        pipelineTasks: [
          {
            taskType: "transliteration",
            config: {
              language: { sourceLanguage: "en", targetLanguage: "hi" },
              serviceId: session.serviceId,
              isSentence: false,
              numSuggestions
            }
          }
        ],
        inputData: { input: [{ source: romanWord }] }
      })
    });

  let response = await doCompute();
  if (response.status === 401 || response.status === 403) {
    transliterationSession = null;
    session = await getTransliterationSession();
    response = await doCompute();
  }
  if (!response.ok) {
    const err = new Error(`transliteration request failed (HTTP ${response.status})`);
    err.status = 502;
    throw err;
  }
  const data = await response.json();
  const out0 = data?.pipelineResponse?.[0]?.output?.[0];
  let candidates = [];
  if (out0) {
    if (Array.isArray(out0.target)) candidates = out0.target;
    else if (typeof out0.target === "string" && out0.target) candidates = [out0.target];
    else if (Array.isArray(out0.targets)) candidates = out0.targets;
    else if (Array.isArray(out0.suggestions)) candidates = out0.suggestions;
  }
  return candidates.filter((c) => typeof c === "string" && c.trim());
}

// ------------------------------- Routes -------------------------------------
function validText(v) {
  return typeof v === "string" && v.trim() && v.length <= MAX_TEXT_LENGTH;
}

app.get("/healthz", (req, res) => {
  res.json({ ok: true, bhashiniConfigured: Boolean(BHASHINI_USER_ID && BHASHINI_ULCA_KEY) });
});

app.post("/api/translate", async (req, res) => {
  const { engine, text } = req.body || {};
  if (!validText(text)) {
    return res.status(400).json({ error: `text must be a non-empty string up to ${MAX_TEXT_LENGTH} characters` });
  }
  try {
    let translation;
    if (engine === "bhashini") translation = await bhashiniTranslate(text);
    else if (engine === "cdac") translation = await cdacPuneTranslate(text);
    else return res.status(400).json({ error: 'engine must be "bhashini" or "cdac"' });
    res.json({ translation });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "translation failed" });
  }
});

app.post("/api/transliterate", async (req, res) => {
  const { text } = req.body || {};
  let numSuggestions = parseInt((req.body || {}).numSuggestions, 10);
  if (!Number.isFinite(numSuggestions) || numSuggestions < 1 || numSuggestions > 10) numSuggestions = 6;
  if (!validText(text)) {
    return res.status(400).json({ error: "text must be a non-empty string" });
  }
  try {
    const candidates = await bhashiniTransliterate(text, numSuggestions);
    if (!candidates.length) return res.status(404).json({ error: "no suggestions found" });
    res.json({ candidates });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "transliteration failed" });
  }
});

app.use((req, res) => res.status(404).json({ error: "not found" }));

app.listen(PORT, () => {
  console.log(`AnuvaadMitra proxy listening on :${PORT}`);
  if (!BHASHINI_USER_ID || !BHASHINI_ULCA_KEY) {
    console.warn("WARNING: Bhashini credentials not set — /api/translate?engine=bhashini and /api/transliterate will fail until BHASHINI_USER_ID and BHASHINI_ULCA_KEY are provided.");
  }
  if (ALLOWED_ORIGINS.includes("*")) {
    console.warn("WARNING: ALLOWED_ORIGINS is '*'. Lock this to your published extension origin before production.");
  }
});
