// Background service worker — context menus + 3 translation engines
// (Google, Bhashini, C-DAC Pune) with user-selectable primary engine
// and automatic fallback through the others on failure.
//
// ============================================================================
// CREDENTIAL / PROXY MODEL (read before deploying to the Chrome Web Store)
// ----------------------------------------------------------------------------
// A Chrome extension's source is fully readable by anyone who installs it, so
// NO secret (Bhashini User ID / Udyat Key, or any other API credential) may be
// shipped inside this bundle. Those credentials now live ONLY on a small proxy
// server that C-DAC controls. The extension talks to that proxy over a clean,
// credential-free JSON API; the proxy injects the real Bhashini credentials
// and forwards the request upstream.
//
// Configure the proxy host in ONE place: DEFAULT_PROXY_BASE below (and match it
// in manifest.json -> host_permissions). Advanced users can override it at
// runtime via the popup (stored as `proxyBaseUrl`).
//
// Expected proxy API (implement server-side; see PROXY-SETUP note in README):
//   POST {base}/api/translate
//     req  : { "engine": "bhashini" | "cdac", "text": "..." }
//     resp : { "translation": "..." }            (HTTP 200)
//   POST {base}/api/transliterate
//     req  : { "text": "...", "numSuggestions": 6 }
//     resp : { "candidates": ["...", "..."] }     (HTTP 200)
// Non-200 responses should carry a short { "error": "..." } body when possible.
// ============================================================================

// Replace with C-DAC's deployed proxy host. Must also appear in
// manifest.json -> host_permissions. Leave without a trailing slash.
const DEFAULT_PROXY_BASE = "https://anuvaadmitra.cdac.in";

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

// ================= Engine: Bhashini (via C-DAC proxy) =================
// The proxy holds the Bhashini credentials and performs the ULCA pipeline
// (config + compute) server-side. The extension only sends the text.
async function bhashiniTranslate(text) {
  const base = await getProxyBase();
  if (!base) {
    throw new Error("translation service not configured — set the proxy URL in the extension popup");
  }

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
// (e.g. "mera" -> मेरा/मीरा/...). Like translation, this now goes through the
// proxy, which runs Bhashini's Transliteration pipeline server-side.
async function bhashiniTransliterate(romanWord) {
  const base = await getProxyBase();
  if (!base) {
    throw new Error("suggestion service not configured — set the proxy URL in the extension popup");
  }

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
