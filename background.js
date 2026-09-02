// Background service worker — context menus + 3 translation engines
// (Google, Bhashini, C-DAC Pune) with user-selectable primary engine
// and automatic fallback through the others on failure.
//
// ============================================================================
// CREDENTIAL / PROXY MODEL (read before deploying)
// ----------------------------------------------------------------------------
// A Chrome extension's source is fully readable by anyone who installs it, so
// shipping a secret (Bhashini User ID / Udyat Key) inside this bundle exposes
// it. The INTENDED design is a small proxy server that C-DAC controls: the
// extension talks to that proxy over a clean, credential-free JSON API and the
// proxy injects the real Bhashini credentials server-side. Configure it via
// DEFAULT_PROXY_BASE below (and match it in manifest.json -> host_permissions).
//
//   POST {base}/api/translate       req {engine, text}          -> {translation}
//   POST {base}/api/transliterate   req {text, numSuggestions}  -> {candidates}
//
// ---------------------------------------------------------------------------
// DIRECT-CALL FALLBACK (INTERNAL / SIDELOADED BUILDS ONLY)
// ---------------------------------------------------------------------------
// When DEFAULT_PROXY_BASE is "" (no proxy deployed yet), the extension talks to
// the upstream APIs directly:
//   * C-DAC Pune  -> nlpsangraha.ebhasha.in (no auth)
//   * Bhashini    -> ULCA config call + Dhruva compute call, using the
//                    credentials in the BHASHINI_* constants below.
//
// WARNING: the direct Bhashini path embeds your credentials in this file, which
// every installed copy can read. This is acceptable ONLY for internal /
// sideloaded distribution to trusted machines. Do NOT publish a build with
// filled-in BHASHINI_* constants to the Chrome Web Store — deploy the proxy for
// any public/wide distribution and leave these blank.
// ============================================================================

// Leave "" until the proxy is deployed. When set, ALL Bhashini + C-DAC Pune
// calls route through the proxy and the direct paths below are not used.
// Must also appear in manifest.json -> host_permissions. No trailing slash.
const DEFAULT_PROXY_BASE = "";

// ---- Direct Bhashini credentials (fill locally; copy from your 5.16.1 build) ----
// These are only consulted when DEFAULT_PROXY_BASE is "" (internal builds).
const BHASHINI_USER_ID     = "1285b2f88ac94de7af87d0d53ea58962";
const BHASHINI_ULCA_API_KEY = "22067923f1-1936-4f79-b8ff-ad3721830daa";
// Pipeline ID for your registered app (cdac_hindi_translator). The MeitY public
// EN<->Indic pipeline below works for en->hi translation + transliteration;
// replace it with your own registered pipeline ID if you have one.
const BHASHINI_PIPELINE_ID = "64392f96daac500b55c543cd";

// ULCA pipeline-config endpoint (returns the inference endpoint + auth token).
const BHASHINI_CONFIG_URL =
  "https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline";

async function getProxyBase() {
  const { proxyBaseUrl } = await chrome.storage.sync.get({ proxyBaseUrl: "" });
  const base = (proxyBaseUrl && proxyBaseUrl.trim()) || DEFAULT_PROXY_BASE;
  return base.replace(/\/+$/, "");
}

// Parse a proxy error body into a short human-readable message.
async function proxyErrorMessage(response, fallback) {
  try {
    const body = await response.json();
    if (body && typeof body.error === "string" && body.error.trim()) {
      return body.error.trim();
    }
  } catch (_) {
    // non-JSON error body — ignore and use the fallback
  }
  return `${fallback} (HTTP ${response.status})`;
}

// ================= Context menus =================
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "e2h-hindi",
    title: "Translate to Hindi (हिंदी)",
    contexts: ["selection"]
  });
  chrome.contextMenus.create({
    id: "e2h-hinglish",
    title: "Translate to Hinglish",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id || !info.selectionText) return;
  const mode = info.menuItemId === "e2h-hinglish" ? "hinglish" : "hindi";
  const msg = { type: "SHOW_TRANSLATION", text: info.selectionText, mode };
  // If the selection was inside an iframe (e.g. a webmail's message-body
  // iframe), target it specifically so the card renders correctly and can
  // read the frame's own DOM. If that frame's content script isn't
  // reachable for any reason, fall back to the main frame so a translation
  // still appears rather than silently doing nothing.
  const frameOptions = typeof info.frameId === "number" ? { frameId: info.frameId } : undefined;
  chrome.tabs.sendMessage(tab.id, msg, frameOptions).catch(() => {
    if (frameOptions) {
      chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
    }
  });
});

// ================= Message router =================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TRANSLATE") {
    translate(message.text)
      .then((result) => sendResponse({ ok: true, hindi: result.hindi, engineUsed: result.engineUsed }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === "TRANSLITERATE") {
    bhashiniTransliterate(message.text)
      .then((candidates) => sendResponse({ ok: true, candidates }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ================= Engine orchestration =================
const ENGINE_LABELS = { google: "Google Translate", bhashini: "Bhashini", cdacPune: "C-DAC Pune" };
const DEFAULT_AUTO_ORDER = ["cdacPune", "bhashini", "google"]; // C-DAC Pune first (best observed quality), Bhashini as fallback for cases Pune can't handle (e.g. text too long), Google as final safety net

async function translate(text) {
  const settings = await chrome.storage.sync.get({
    engine: "auto",
    autoFallback: true
  });

  let order;
  if (settings.engine === "auto") {
    order = [...DEFAULT_AUTO_ORDER];
  } else {
    order = [settings.engine];
    if (settings.autoFallback) {
      for (const e of DEFAULT_AUTO_ORDER) {
        if (!order.includes(e)) order.push(e);
      }
    }
  }

  const errors = [];
  for (const engine of order) {
    try {
      const hindi = await runEngine(engine, text);
      return { hindi, engineUsed: engine };
    } catch (err) {
      errors.push(`${ENGINE_LABELS[engine] || engine}: ${err.message}`);
      // try next engine in the chain
    }
  }

  throw new Error(
    order.length > 1
      ? `All translation engines failed.\n${errors.join("\n")}`
      : errors[0] || "Translation failed."
  );
}

function runEngine(engine, text) {
  if (engine === "bhashini") return bhashiniTranslate(text);
  if (engine === "cdacPune") return cdacPuneTranslate(text);
  return googleTranslate(text);
}

// ================= Engine: Google (free web endpoint) =================
async function googleTranslate(text) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=hi&dt=t&q=" +
    encodeURIComponent(text);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`unavailable (HTTP ${response.status})`);
  }
  const data = await response.json();
  const hindi = (data?.[0] || []).map((c) => c?.[0] || "").join("").trim();
  if (!hindi) throw new Error("empty response");
  return hindi;
}

// ================= Engine: Bhashini =================
// Routed through the proxy when one is configured; otherwise calls the ULCA /
// Dhruva pipeline directly using the BHASHINI_* credentials (internal builds).
async function bhashiniTranslate(text) {
  const base = await getProxyBase();
  return base ? bhashiniViaProxy(base, text) : bhashiniDirect(text);
}

// ---- Bhashini via proxy (credential-free; proxy runs the ULCA pipeline) ----
async function bhashiniViaProxy(base, text) {
  let response;
  try {
    response = await fetch(`${base}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine: "bhashini", text })
    });
  } catch (_) {
    throw new Error("translation service unreachable — check your connection");
  }

  if (!response.ok) {
    throw new Error(await proxyErrorMessage(response, "request failed"));
  }

  const data = await response.json();
  const hindi = (data?.translation || "").trim();
  if (!hindi) throw new Error("empty response");
  return hindi;
}

// ---- Direct Bhashini (INTERNAL BUILDS ONLY — credentials are in this file) ----
//
// Two-step ULCA flow:
//   1. Config call  -> gives us the inference endpoint (callbackUrl), an auth
//      header (name/value) and the serviceId for the task.
//   2. Compute call -> hits that endpoint with the auth header and the text.
// The config result is stable per task, so we cache it in memory and only
// re-fetch it if it's missing or a compute call reports an auth failure.
const bhashiniConfigCache = {}; // { translation: {...}, transliteration: {...} }

function bhashiniCredsPresent() {
  return (
    BHASHINI_USER_ID && !BHASHINI_USER_ID.startsWith("PASTE_") &&
    BHASHINI_ULCA_API_KEY && !BHASHINI_ULCA_API_KEY.startsWith("PASTE_")
  );
}

async function getBhashiniPipeline(taskType) {
  if (bhashiniConfigCache[taskType]) return bhashiniConfigCache[taskType];

  if (!bhashiniCredsPresent()) {
    throw new Error("credentials not set in background.js (internal build)");
  }

  let response;
  try {
    response = await fetch(BHASHINI_CONFIG_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        userID: BHASHINI_USER_ID,
        ulcaApiKey: BHASHINI_ULCA_API_KEY
      },
      body: JSON.stringify({
        pipelineTasks: [
          {
            taskType,
            config: { language: { sourceLanguage: "en", targetLanguage: "hi" } }
          }
        ],
        pipelineRequestConfig: { pipelineId: BHASHINI_PIPELINE_ID }
      })
    });
  } catch (_) {
    throw new Error("config call unreachable — check network/VPN");
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(`config auth rejected (HTTP ${response.status}) — check User ID / Udyat Key`);
  }
  if (!response.ok) {
    throw new Error(`config call failed (HTTP ${response.status})`);
  }

  const data = await response.json();
  const endpoint = data?.pipelineInferenceAPIEndPoint;
  const taskConfig = data?.pipelineResponseConfig?.find(
    (c) => c.taskType === taskType
  )?.config?.[0];

  if (!endpoint?.callbackUrl || !endpoint?.inferenceApiKey?.name || !taskConfig?.serviceId) {
    throw new Error("unexpected config response shape");
  }

  const resolved = {
    callbackUrl: endpoint.callbackUrl,
    authName: endpoint.inferenceApiKey.name,
    authValue: endpoint.inferenceApiKey.value,
    serviceId: taskConfig.serviceId
  };
  bhashiniConfigCache[taskType] = resolved;
  return resolved;
}

async function bhashiniDirect(text) {
  const p = await getBhashiniPipeline("translation");

  let response;
  try {
    response = await fetch(p.callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", [p.authName]: p.authValue },
      body: JSON.stringify({
        pipelineTasks: [
          {
            taskType: "translation",
            config: {
              language: { sourceLanguage: "en", targetLanguage: "hi" },
              serviceId: p.serviceId
            }
          }
        ],
        inputData: { input: [{ source: text }] }
      })
    });
  } catch (_) {
    throw new Error("unreachable — check network/VPN");
  }

  if (response.status === 401 || response.status === 403) {
    delete bhashiniConfigCache.translation; // token may have rotated — force re-config next time
    throw new Error(`auth rejected (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new Error(`request failed (HTTP ${response.status})`);
  }

  const data = await response.json();
  const hindi = (
    data?.pipelineResponse?.find((r) => r.taskType === "translation")
      ?.output?.[0]?.target || ""
  ).trim();
  if (!hindi) throw new Error("empty response");
  return hindi;
}

// ================= Engine: C-DAC Pune =================
// Routed through the proxy when one is configured (keeps all upstream calls in
// one place and works even if the C-DAC endpoint is not directly reachable from
// the browser). Falls back to calling the C-DAC endpoint directly otherwise.
const CDAC_PUNE_URL = "https://nlpsangraha.ebhasha.in/getTranslation";

async function cdacPuneTranslate(text) {
  const base = await getProxyBase();
  const hindi = base
    ? await cdacPuneViaProxy(base, text)
    : await cdacPuneDirect(text);

  // C-DAC Pune has a length restriction on the input it will translate in
  // full; beyond that it can silently return a truncated translation rather
  // than an explicit error. Treat a suspiciously short/incomplete-looking
  // response as a failure so the engine chain falls through to Bhashini
  // instead of quietly returning a cut-off translation.
  if (looksTruncated(text, hindi)) {
    throw new Error("response appears truncated (input likely exceeds C-DAC Pune's length limit)");
  }

  return hindi;
}

async function cdacPuneViaProxy(base, text) {
  let response;
  try {
    response = await fetch(`${base}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine: "cdac", text })
    });
  } catch (_) {
    throw new Error("translation service unreachable — check your connection");
  }
  if (!response.ok) {
    throw new Error(await proxyErrorMessage(response, "request failed"));
  }
  const data = await response.json();
  const hindi = (data?.translation || "").trim();
  if (!hindi) throw new Error("empty response");
  return hindi;
}

async function cdacPuneDirect(text) {
  let response;
  try {
    response = await fetch(CDAC_PUNE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip_text: text, srcLang: "eng-latn", tgtLang: "hin-deva" })
    });
  } catch (_) {
    throw new Error("unreachable — check network/VPN");
  }

  if (!response.ok) throw new Error(`request failed (HTTP ${response.status})`);

  const data = await response.json();
  const hindi = extractCdacTranslation(data);
  if (!hindi) throw new Error("unrecognized response format");
  return hindi;
}

// Heuristic truncation check — C-DAC Pune doesn't document an explicit
// "truncated" flag, so this looks for two signals: the output being
// disproportionately short relative to the input, or the input clearly
// ending a sentence while the output does not (a strong sign it was cut off
// mid-translation). Only applied to inputs long enough that truncation is a
// realistic concern, to avoid flagging naturally short/valid translations.
// Wikipedia and similar sources pepper text with citation markers like
// [3], [8][9], [a] — these confuse a naive "does the text end with
// punctuation" check (the sentence ends, then a bracket follows), so both
// the truncation check and its sentence-ending check strip them first.
function stripCitationMarkers(text) {
  return text.replace(/\[\s*[a-zA-Z0-9]+\s*\]/g, "").trim();
}

function countSentences(text) {
  const matches = text.match(/[.!?।]+/g);
  return matches ? matches.length : text.trim() ? 1 : 0;
}

function looksTruncated(inputText, outputText) {
  const inClean = stripCitationMarkers(inputText.trim());
  const outClean = stripCitationMarkers(outputText.trim());
  if (inClean.length < 40) return false;

  // Primary signal: a complete translation should produce roughly one
  // output sentence per input sentence. A source with several sentences
  // coming back with noticeably fewer strongly suggests some were dropped
  // — this catches cases (like a multi-sentence paragraph translated down
  // to just its first sentence) that a simple character-length ratio
  // misses, since the output isn't necessarily *proportionally* tiny.
  const inSentences = countSentences(inClean);
  const outSentences = countSentences(outClean);
  if (inSentences >= 2 && outSentences < inSentences * 0.7) {
    return true;
  }

  // Secondary signal: input clearly ends a sentence, output doesn't.
  const sentenceEndPattern = /[.!?।]\s*$/;
  if (sentenceEndPattern.test(inClean) && !sentenceEndPattern.test(outClean)) {
    return true;
  }

  // Fallback signal: output is drastically shorter than the input overall.
  const ratio = outClean.length / inClean.length;
  if (ratio < 0.35) return true;

  return false;
}

// The exact response field name is "Output" (confirmed), e.g.
// { "Output": "कृपया संबंधित ईमेल दस्तावेजों को संलग्न करें।" }
// A few other likely variants are kept as fallbacks in case of casing/naming drift.
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

  // Nested shapes: { output: [{ target: "..." }] } or { data: { ... } }
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

// ================= Bhashini Transliteration (word-suggestion feature) =================
// Suggests Devanagari spellings for a word typed phonetically in Roman script
// (e.g. "mera" -> मेरा/मीरा/...). Routes through the proxy when configured;
// otherwise calls Bhashini's Transliteration pipeline directly (internal builds).
async function bhashiniTransliterate(romanWord) {
  const base = await getProxyBase();
  return base
    ? bhashiniTransliterateViaProxy(base, romanWord)
    : bhashiniTransliterateDirect(romanWord);
}

async function bhashiniTransliterateViaProxy(base, romanWord) {
  let response;
  try {
    response = await fetch(`${base}/api/transliterate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: romanWord, numSuggestions: 6 })
    });
  } catch (_) {
    throw new Error("suggestion service unreachable — check your connection");
  }

  if (!response.ok) {
    throw new Error(await proxyErrorMessage(response, "suggestion request failed"));
  }

  const data = await response.json();
  const candidates = Array.isArray(data?.candidates)
    ? data.candidates.filter((c) => typeof c === "string" && c.trim())
    : [];
  if (!candidates.length) throw new Error("no suggestions found");
  return candidates;
}

// ---- Direct Bhashini transliteration (INTERNAL BUILDS ONLY) ----
async function bhashiniTransliterateDirect(romanWord) {
  const p = await getBhashiniPipeline("transliteration");

  let response;
  try {
    response = await fetch(p.callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", [p.authName]: p.authValue },
      body: JSON.stringify({
        pipelineTasks: [
          {
            taskType: "transliteration",
            config: {
              language: { sourceLanguage: "en", targetLanguage: "hi" },
              serviceId: p.serviceId,
              isSentence: false,
              numSuggestions: 6
            }
          }
        ],
        inputData: { input: [{ source: romanWord }] }
      })
    });
  } catch (_) {
    throw new Error("suggestion service unreachable — check network/VPN");
  }

  if (response.status === 401 || response.status === 403) {
    delete bhashiniConfigCache.transliteration;
    throw new Error(`auth rejected (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new Error(`suggestion request failed (HTTP ${response.status})`);
  }

  const data = await response.json();
  const target =
    data?.pipelineResponse?.find((r) => r.taskType === "transliteration")
      ?.output?.[0]?.target;
  const candidates = Array.isArray(target)
    ? target.filter((c) => typeof c === "string" && c.trim())
    : [];
  if (!candidates.length) throw new Error("no suggestions found");
  return candidates;
}
