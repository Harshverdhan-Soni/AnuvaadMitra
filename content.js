// Content script — selection trigger, context-menu handling, translation
// card with हिंदी / Hinglish tabs. Selecting text shows a small button;
// translation only starts once the user explicitly clicks it (or uses
// right-click → Translate). Translation happens in background.js using the
// engine chain configured in the popup (Bhashini / C-DAC Pune / Google,
// with automatic fallback). The selected text is captured by walking the
// DOM directly (not the raw selection string) so paragraph/line structure
// is preserved. Hinglish = local Roman-script transliteration of the
// Hindi output.

(() => {
  let triggerBtn = null;
  let card = null;
  let lastSelectedText = "";
  let currentMode = "hindi";
  let cache = {}; // { hindi: "...", hinglish: "...", engineUsed: "..." }
  let isDraggingCard = false;
  let dragStartX = 0, dragStartY = 0, dragStartLeft = 0, dragStartTop = 0;
  let originalSelectionRange = null; // clone of the page's original selection, for "Insert"
  let canInsertHere = false;

  const MODE_LABELS = { hindi: "हिंदी", hinglish: "Hinglish" };
  const ENGINE_LABELS = { google: "Google", bhashini: "Bhashini", cdacPune: "C-DAC Pune" };

  // engineUsed may be a single engine key, an array of keys (when a
  // multi-line selection got split across engines), or null/undefined.
  function formatEngineLabel(engineUsed) {
    if (!engineUsed) return "";
    if (Array.isArray(engineUsed)) {
      const names = engineUsed.map((e) => ENGINE_LABELS[e] || e);
      return `via ${names.join(" + ")} (split across lines)`;
    }
    return `via ${ENGINE_LABELS[engineUsed] || engineUsed}`;
  }

  // Some host pages (observed in a few webmail rich-text editors) reset
  // native <button> border/padding/background globally, which quietly
  // defeats our class-based button styling even when content.css itself
  // loads fine. These inline, !important-marked base styles guarantee the
  // buttons look right regardless; class-based styling in content.css still
  // adds hover states etc. on top when the page doesn't fight it.
  const TAB_STYLE_BASE =
    "border:1px solid transparent !important;background:none !important;border-radius:999px !important;" +
    "padding:3px 12px !important;font-size:12px !important;font-weight:600 !important;" +
    "color:#8a8577 !important;cursor:pointer !important;margin:0 !important;line-height:normal !important;";
  const TAB_STYLE_ACTIVE =
    TAB_STYLE_BASE.replace("background:none", "background:#e8720c").replace(
      "border:1px solid transparent",
      "border:1px solid #e8720c"
    ) + "color:#fffdf8 !important;";
  const EDIT_STYLE_BASE =
    "border:1px solid transparent !important;background:none !important;border-radius:999px !important;" +
    "padding:3px 10px !important;font-size:11.5px !important;font-weight:600 !important;" +
    "color:#8a8577 !important;cursor:pointer !important;margin:0 !important;white-space:nowrap !important;";
  const EDIT_STYLE_ACTIVE =
    EDIT_STYLE_BASE.replace("background:none", "background:#1b7a43") + "color:#fffdf8 !important;";
  const CLOSE_STYLE =
    "border:none !important;background:none !important;font-size:18px !important;line-height:1 !important;" +
    "color:#8a8577 !important;cursor:pointer !important;padding:2px 6px !important;border-radius:4px !important;margin:0 !important;";
  const COPY_STYLE_BASE =
    "padding:6px 16px !important;border:none !important;border-radius:6px !important;" +
    "background:#1f2430 !important;color:#fffdf8 !important;font-size:13px !important;" +
    "font-weight:600 !important;cursor:pointer !important;white-space:nowrap !important;margin:0 !important;";
  const COPY_STYLE_DISABLED = COPY_STYLE_BASE + "opacity:0.45 !important;cursor:default !important;";
  const COPY_STYLE_COPIED = COPY_STYLE_BASE.replace("#1f2430", "#1b7a43");
  const COPY_STYLE_HOVER = COPY_STYLE_BASE.replace("#1f2430", "#e8720c");

  // Inline styles can't express :hover, and content.css's hover rules
  // aren't reliable on every page — this wires real mouseenter/mouseleave
  // listeners so hover feedback always works, regardless of page CSS.
  function wireHover(el, baseStyle, hoverStyle) {
    // Safe to call again on the same element when its meaning changes (e.g.
    // Insert going from "active" to "already inserted") — removes any
    // previously-wired hover behavior first so listeners never stack.
    if (el._hoverEnter) el.removeEventListener("mouseenter", el._hoverEnter);
    if (el._hoverLeave) el.removeEventListener("mouseleave", el._hoverLeave);
    el._hoverEnter = () => { el.style.cssText = hoverStyle; };
    el._hoverLeave = () => { el.style.cssText = baseStyle; };
    el.addEventListener("mouseenter", el._hoverEnter);
    el.addEventListener("mouseleave", el._hoverLeave);
  }

  // Small color-coded dot shown before each translated line, indicating
  // which engine produced it. The dot is an empty element (no text inside),
  // marked non-editable and non-selectable, so it never becomes part of the
  // copied/edited text regardless of how it's interacted with.
  const ENGINE_DOT_COLORS = { cdacPune: "#05186a", bhashini: "#e8720c", google: "#8a8577" };
  function engineDotStyle(engine) {
    const color = ENGINE_DOT_COLORS[engine] || "#c9c3b4";
    return (
      `display:inline-block !important;width:7px !important;height:7px !important;` +
      `border-radius:50% !important;background:${color} !important;margin-right:6px !important;` +
      `flex-shrink:0 !important;user-select:none !important;`
    );
  }

  // Reconstructs the plain, copyable text from the rendered per-line
  // structure — reading only each line's text span, never the engine-dot
  // badges (which hold no text content anyway, but this also explicitly
  // joins lines with real newlines, since block-level <div>s don't
  // otherwise contribute line breaks to .textContent).
  function getCleanLinesText(box) {
    const lineDivs = box.querySelectorAll(".e2h-line");
    if (lineDivs.length === 0) return box.textContent;
    return Array.from(lineDivs)
      .map((div) => div.querySelector(".e2h-line-text")?.textContent ?? div.textContent)
      .join("\n");
  }

  // "Insert" button styling — active when the original selection was made
  // inside an editable area (so there's somewhere valid to insert into),
  // disabled otherwise (e.g. quoted/received text being read, not written).
  const INSERT_STYLE_ACTIVE =
    "padding:6px 12px !important;border:1.5px solid #1f2430 !important;border-radius:6px !important;" +
    "background:transparent !important;color:#1f2430 !important;font-size:12.5px !important;" +
    "font-weight:600 !important;cursor:pointer !important;white-space:nowrap !important;margin:0 !important;";
  const INSERT_STYLE_DISABLED =
    "padding:6px 12px !important;border:1.5px solid #c9c3b4 !important;border-radius:6px !important;" +
    "background:transparent !important;color:#a8a296 !important;font-size:12.5px !important;" +
    "font-weight:600 !important;cursor:not-allowed !important;white-space:nowrap !important;" +
    "margin:0 !important;opacity:0.7 !important;";
  const INSERT_STYLE_HOVER = INSERT_STYLE_ACTIVE.replace("#1f2430", "#e8720c").replace(
    "background:transparent",
    "background:#e8720c"
  ) + "color:#fffdf8 !important;";
  // Once the translation has actually been inserted, the button locks into
  // this state permanently (disabled, to prevent inserting the same text
  // twice) — green to signal "done", with a blue hover as a distinct,
  // deliberate visual cue that this button has already done its job.
  const INSERT_STYLE_INSERTED =
    "padding:6px 12px !important;border:1.5px solid #1b7a43 !important;border-radius:6px !important;" +
    "background:#1b7a43 !important;color:#fffdf8 !important;font-size:12.5px !important;" +
    "font-weight:600 !important;cursor:default !important;white-space:nowrap !important;margin:0 !important;";
  const INSERT_STYLE_INSERTED_HOVER =
    "padding:6px 12px !important;border:1.5px solid #05186a !important;border-radius:6px !important;" +
    "background:#05186a !important;color:#fffdf8 !important;font-size:12.5px !important;" +
    "font-weight:600 !important;cursor:default !important;white-space:nowrap !important;margin:0 !important;";

  // Block-level tags that represent a paragraph/line boundary in the source
  // page. selection.toString() flattens text inconsistently depending on
  // how the source page structures its markup — walking the DOM ourselves
  // and inserting an explicit line break at each block boundary captures
  // paragraph structure far more reliably (e.g. Gmail/webmail compose
  // boxes, Wikipedia, most rich-text editors).
  // "Insert" only makes sense when the original text was selected inside an
  // editable area (a compose box, contenteditable note, etc.) — not on a
  // plain, read-only webpage where there's nowhere valid to insert into.
  // Some rich-text editors (notably TinyMCE 4, used by OX App Suite / Open-
  // Xchange webmail) make an <iframe> editable via document-level
  // `designMode = "on"` rather than per-element `contentEditable`. In that
  // case `element.isContentEditable` is false everywhere, so the checks below
  // would wrongly conclude there's nowhere to insert. Detect the editable
  // document directly. (The content script runs inside the editor iframe, so
  // `ownerDocument` here is that iframe's document.)
  function isDesignModeDoc(node) {
    const doc = node && (node.ownerDocument || (node.nodeType === Node.DOCUMENT_NODE ? node : null));
    return !!(doc && typeof doc.designMode === "string" && doc.designMode.toLowerCase() === "on");
  }

  function isInsideEditable(node) {
    let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el) {
      if (el.isContentEditable) return true;
      if (
        el.tagName === "TEXTAREA" ||
        (el.tagName === "INPUT" && /^(text|search|email|url|tel)$/i.test(el.type || "text"))
      ) {
        return true;
      }
      el = el.parentElement;
    }
    // designMode iframe editors (TinyMCE 4 / OX App Suite): the whole document
    // is editable even though no element reports isContentEditable.
    if (isDesignModeDoc(node)) return true;
    return false;
  }

  // Finds the outermost editable ancestor — the whole compose box/editor
  // area, not just whatever inner element the selection happened to land
  // in — since Insert targets the very start of that whole area.
  function findEditableRoot(node) {
    let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    let root = null;
    while (el) {
      if (el.isContentEditable) {
        root = el;
      } else if (root) {
        break; // left the editable chain — the last editable ancestor found is the root
      }
      el = el.parentElement;
    }
    // designMode iframe editors (TinyMCE 4 / OX App Suite): no element reports
    // isContentEditable, so fall back to the editable document's body as the
    // insertion root.
    if (!root && isDesignModeDoc(node)) {
      const doc = node.ownerDocument || (node.nodeType === Node.DOCUMENT_NODE ? node : document);
      root = doc.body || doc.documentElement;
    }
    return root;
  }

  // Finds a native <textarea>/<input> ancestor, if the selection was made
  // inside one — these don't support DOM Range insertion the way
  // contenteditable regions do, so they need a different insert strategy.
  function findFormControl(node) {
    let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el) {
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el;
      el = el.parentElement;
    }
    return null;
  }

  const BLOCK_TAGS = new Set([
    "P", "DIV", "LI", "TR", "H1", "H2", "H3", "H4", "H5", "H6",
    "BLOCKQUOTE", "PRE", "SECTION", "ARTICLE", "HEADER", "FOOTER"
  ]);

  function serializeWithLineBreaks(node) {
    let out = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === "BR") {
          out += "\n";
        } else if (child.tagName === "SCRIPT" || child.tagName === "STYLE") {
          // skip
        } else {
          const isBlock = BLOCK_TAGS.has(child.tagName);
          if (isBlock && out && !out.endsWith("\n")) out += "\n";
          out += serializeWithLineBreaks(child);
          if (isBlock && !out.endsWith("\n")) out += "\n";
        }
      }
    });
    return out;
  }

  // Extracts the selected text from a Range while preserving paragraph/line
  // structure, falling back to the plain selection string if anything goes
  // wrong (e.g. an unusual DOM shape).
  function extractSelectionText(range) {
    try {
      const frag = range.cloneContents();
      const container = document.createElement("div");
      container.appendChild(frag);
      const raw = serializeWithLineBreaks(container);
      // collapse 3+ consecutive blank lines down to a single blank line,
      // and trim each line's edge whitespace without losing the breaks
      const cleaned = raw
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/g, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return cleaned || range.toString().trim();
    } catch (_) {
      return range.toString().trim();
    }
  }

  // =========================================================
  // Translation
  // =========================================================

  async function translateLine(text) {
    if (!chrome?.runtime?.sendMessage) {
      throw new Error("Extension was updated — please refresh this page (F5) and try again.");
    }
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "TRANSLATE", text }, (response) => {
          if (chrome.runtime.lastError) {
            reject(
              new Error(
                chrome.runtime.lastError.message?.includes("context invalidated")
                  ? "Extension was updated — please refresh this page (F5) and try again."
                  : chrome.runtime.lastError.message
              )
            );
          } else if (response?.ok) {
            resolve({ hindi: response.hindi, engineUsed: response.engineUsed });
          } else {
            reject(new Error(response?.error || "Translation failed. Try again."));
          }
        });
      } catch (err) {
        reject(new Error("Extension was updated — please refresh this page (F5) and try again."));
      }
    });
  }

  // Translate multi-line selections (paragraphs, bullet/numbered lists) while
  // preserving line breaks and leading indentation, since translation engines
  // flatten a single combined string into one continuous line otherwise.
  // Always returns a per-line breakdown (lines[]) alongside the flattened
  // hindi string, so the UI can show which engine produced each line.
  async function translateToHindi(text) {
    const lines = text.split(/\r?\n/);
    const lineResults = []; // [{ text, engineUsed }], blank lines have engineUsed: null
    const engineCounts = {};

    for (const line of lines) {
      const leadingWs = (line.match(/^[ \t]*/) || [""])[0];
      const trimmedLine = line.trim();

      if (!trimmedLine) {
        lineResults.push({ text: "", engineUsed: null });
        continue;
      }

      const { hindi, engineUsed } = await translateLine(trimmedLine);
      if (engineUsed) engineCounts[engineUsed] = (engineCounts[engineUsed] || 0) + 1;
      lineResults.push({ text: leadingWs + hindi, engineUsed: engineUsed || null });
    }

    // If every line came from the same engine, report it plainly. If the
    // selection got split across engines (e.g. some lines fell back to
    // Bhashini while others succeeded via C-DAC Pune), say so explicitly
    // rather than silently picking whichever engine handled the most
    // lines — a majority-vote label can misrepresent what actually
    // produced the text the user is looking at.
    const distinctEngines = Object.keys(engineCounts);
    const engineUsed =
      distinctEngines.length <= 1 ? distinctEngines[0] || null : distinctEngines;

    return { hindi: lineResults.map((l) => l.text).join("\n"), engineUsed, lines: lineResults };
  }

  // ---------- Devanagari → Roman transliteration (for Hinglish) ----------
  const CONSONANTS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n",
    "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
    "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
    "य": "y", "र": "r", "ल": "l", "व": "v",
    "श": "sh", "ष": "sh", "स": "s", "ह": "h",
    "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z",
    "ड़": "r", "ढ़": "rh", "फ़": "f", "ऱ": "r", "ऴ": "l", "ळ": "l"
  };
  const VOWELS = {
    "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo",
    "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऋ": "ri",
    "ऑ": "o", "ऒ": "o", "ऍ": "e", "ऎ": "e"
  };
  const MATRAS = {
    "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo",
    "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ृ": "ri",
    "ॉ": "o", "ॊ": "o", "ॅ": "e", "ॆ": "e"
  };
  const DIGITS = { "०": "0", "१": "1", "२": "2", "३": "3", "४": "4", "५": "5", "६": "6", "७": "7", "८": "8", "९": "9" };
  const VIRAMA = "्", ANUSVARA = "ं", CHANDRABINDU = "ँ", VISARGA = "ः", NUKTA = "़";

  function isDevanagariLetter(ch) {
    return ch && (CONSONANTS[ch] || VOWELS[ch]);
  }

  function transliterate(hindi) {
    const chars = Array.from(hindi.normalize("NFC"));
    let out = "";

    for (let i = 0; i < chars.length; i++) {
      let ch = chars[i];

      if (chars[i + 1] === NUKTA && CONSONANTS[ch + NUKTA]) {
        ch = ch + NUKTA;
        i++;
      }

      if (ch === "।" || ch === "॥") { out += "."; continue; }
      if (DIGITS[ch]) { out += DIGITS[ch]; continue; }
      if (ch === ANUSVARA || ch === CHANDRABINDU) { out += "n"; continue; }
      if (ch === VISARGA) { out += "h"; continue; }
      if (VOWELS[ch]) { out += VOWELS[ch]; continue; }
      if (MATRAS[ch]) { out += MATRAS[ch]; continue; }

      if (CONSONANTS[ch]) {
        out += CONSONANTS[ch];
        let next = chars[i + 1];
        if (next === NUKTA) next = chars[i + 2];

        if (next === VIRAMA) {
          i++;
        } else if (MATRAS[next]) {
          // handled on next loop iteration
        } else if (next === ANUSVARA || next === CHANDRABINDU || next === VISARGA) {
          out += "a";
        } else if (isDevanagariLetter(next)) {
          out += "a";
        }
        continue;
      }

      out += ch;
    }
    return out;
  }

  async function getResult(mode) {
    if (cache[mode]) return cache[mode];
    if (!cache.hindiLines) {
      const { hindi, engineUsed, lines } = await translateToHindi(lastSelectedText);
      cache.hindi = hindi;
      cache.engineUsed = engineUsed;
      cache.hindiLines = lines;
    }
    if (mode === "hinglish" && !cache.hinglishLines) {
      cache.hinglishLines = cache.hindiLines.map((l) => ({
        text: l.text ? transliterate(l.text) : "",
        engineUsed: l.engineUsed
      }));
      cache.hinglish = cache.hinglishLines.map((l) => l.text).join("\n");
    }
    return cache[mode];
  }

  // =========================================================
  // UI
  // =========================================================

  function removeTrigger() {
    if (triggerBtn) { triggerBtn.remove(); triggerBtn = null; }
  }

  function removeCard() {
    if (card) { card.remove(); card = null; }
    removeSuggestPopup();
    removeInsertBtn();
    originalSelectionRange = null;
  }

  function showTrigger(x, y, text) {
    removeTrigger();
    lastSelectedText = text;

    triggerBtn = document.createElement("button");
    triggerBtn.className = "e2h-trigger";
    triggerBtn.type = "button";
    triggerBtn.textContent = "अ→हि";
    triggerBtn.title = "Translate to Hindi";
    // Minimal safety-net styling — guarantees the button is visible as a
    // floating pill even on pages where content.css doesn't load (observed
    // in some iframe-based webmail editors). content.css still applies on
    // top when it does load; this is just a baseline.
    triggerBtn.style.cssText =
      "position:absolute !important;z-index:2147483646 !important;padding:4px 10px !important;" +
      "border:1px solid #1f2430 !important;border-radius:999px !important;background:#fffdf8 !important;" +
      "color:#1f2430 !important;font-size:13px !important;font-weight:600 !important;" +
      "cursor:pointer !important;box-shadow:0 2px 8px rgba(31,36,48,0.18) !important;" +
      "display:inline-block !important;margin:0 !important;line-height:normal !important;";
    triggerBtn.style.left = `${x}px`;
    triggerBtn.style.top = `${y}px`;

    triggerBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    triggerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = triggerBtn.getBoundingClientRect();
      // Re-capture the live selection right now if it's still available and
      // still attached to the document — more reliable than an earlier
      // reference, since some rich-text editors periodically rebuild their
      // DOM, which can silently detach an earlier-captured Range.
      const liveSelection = window.getSelection();
      if (
        liveSelection &&
        liveSelection.rangeCount > 0 &&
        !liveSelection.isCollapsed &&
        liveSelection.getRangeAt(0).startContainer?.isConnected
      ) {
        originalSelectionRange = liveSelection.getRangeAt(0).cloneRange();
      }
      removeTrigger();
      openCard(lastSelectedText, "hindi", rect.left + window.scrollX, rect.bottom + window.scrollY + 6);
    });

    document.documentElement.appendChild(triggerBtn);
  }

  function openCard(text, mode, x, y) {
    const pendingRange = originalSelectionRange; // preserve across removeCard()'s cleanup below
    removeCard();
    originalSelectionRange = pendingRange;
    lastSelectedText = text;
    currentMode = mode;
    cache = {};
    canInsertHere =
      originalSelectionRange && originalSelectionRange.startContainer?.isConnected
        ? isInsideEditable(originalSelectionRange.startContainer)
        : false;

    card = document.createElement("div");
    card.className = "e2h-card";
    // Minimal safety-net styling — guarantees the card floats as a visible
    // overlay box even on pages where content.css doesn't load (observed in
    // some iframe-based webmail editors). content.css still applies on top
    // for everything else (colors, hover states, fonts) when it does load.
    card.style.cssText =
      "position:absolute !important;z-index:2147483647 !important;width:360px !important;" +
      "max-width:calc(100vw - 24px) !important;background:#fffdf8 !important;" +
      "border:1px solid #e9e4da !important;border-top:3px solid #e8720c !important;" +
      "border-radius:10px !important;box-shadow:0 8px 28px rgba(31,36,48,0.22) !important;" +
      "overflow:hidden !important;display:block !important;margin:0 !important;padding:0 !important;";

    const maxLeft = window.scrollX + document.documentElement.clientWidth - 372;
    card.style.left = `${Math.max(window.scrollX + 8, Math.min(x, maxLeft))}px`;
    card.style.top = `${y}px`;

    card.innerHTML = `
      <div class="e2h-head" style="display:flex !important;flex-direction:row !important;align-items:center !important;justify-content:space-between !important;padding:8px 12px !important;border-bottom:1px solid #e9e4da !important;margin:0 !important;">
        <div class="e2h-tabs" style="display:flex !important;flex-direction:row !important;gap:4px !important;margin:0 !important;">
          <button type="button" class="e2h-tab" data-mode="hindi" style="${TAB_STYLE_BASE}">हिंदी</button>
          <button type="button" class="e2h-tab" data-mode="hinglish" style="${TAB_STYLE_BASE}">Hinglish</button>
        </div>
        <div class="e2h-head-actions" style="display:flex !important;flex-direction:row !important;align-items:center !important;gap:4px !important;margin:0 !important;">
          <button type="button" class="e2h-edit" title="Edit translation" style="${EDIT_STYLE_BASE}">✎ Edit</button>
          <button type="button" class="e2h-close" title="Close" style="${CLOSE_STYLE}">×</button>
        </div>
      </div>
      <div class="e2h-body" style="padding:12px !important;max-height:260px !important;overflow-y:auto !important;margin:0 !important;"></div>
      <div class="e2h-foot" style="padding:10px 12px !important;border-top:1px solid #e9e4da !important;display:flex !important;flex-direction:row !important;align-items:center !important;justify-content:space-between !important;gap:8px !important;margin:0 !important;">
        <span class="e2h-engine" style="font-size:10.5px !important;color:#8a8577 !important;line-height:1.4 !important;flex:1 1 auto !important;min-width:0 !important;margin:0 8px 0 0 !important;"></span>
        <div class="e2h-foot-actions" style="display:flex !important;flex-direction:row !important;align-items:center !important;gap:6px !important;margin:0 !important;flex-shrink:0 !important;white-space:nowrap !important;">
          <button type="button" class="e2h-insert-result" ${canInsertHere ? "" : "disabled"} title="${canInsertHere ? "Insert into the page, at the start of the editable area" : "Only available when the original text was selected inside an editable area (a compose box, note, or form field) — not for quoted/received text you're reading"}" style="${canInsertHere ? INSERT_STYLE_ACTIVE : INSERT_STYLE_DISABLED}">${canInsertHere ? "⇤ Insert" : "Insert n/a"}</button>
          <button type="button" class="e2h-copy" disabled style="${COPY_STYLE_DISABLED}">Copy</button>
        </div>
      </div>
    `;

    card.querySelector(".e2h-close").addEventListener("click", removeCard);
    card.addEventListener("mousedown", (e) => e.stopPropagation());

    card.querySelector(".e2h-edit").addEventListener("click", toggleEdit);

    const insertBtnEl = card.querySelector(".e2h-insert-result");
    if (insertBtnEl) {
      insertBtnEl.addEventListener("click", handleInsertClick);
      if (canInsertHere) {
        wireHover(insertBtnEl, INSERT_STYLE_ACTIVE, INSERT_STYLE_HOVER);
      }
    }

    card.querySelectorAll(".e2h-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const m = tab.dataset.mode;
        if (m === currentMode) return;
        currentMode = m;
        loadMode();
      });
    });

    document.documentElement.appendChild(card);
    enableCardDrag();
    loadMode();
  }

  // Lets the user drag the card by its header to reposition it anywhere on
  // screen. Listeners run in the capture phase so dragging keeps working
  // even on pages with their own custom mouse-event handling.
  function enableCardDrag() {
    const header = card.querySelector(".e2h-head");
    if (!header) return;
    header.style.cursor = "move";
    header.addEventListener(
      "mousedown",
      (e) => {
        if (e.target.closest("button")) return; // don't hijack tab/edit/close clicks
        isDraggingCard = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragStartLeft = parseFloat(card.style.left) || 0;
        dragStartTop = parseFloat(card.style.top) || 0;
        e.preventDefault();
      },
      true
    );
  }

  // Plain "\n" characters collapse into a single space in HTML editors —
  // real <br> elements are needed for line breaks to actually render when
  // inserted into a rich-text destination.
  function buildLineBreakFragment(text, trailingSeparator) {
    const frag = document.createDocumentFragment();
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (idx > 0) frag.appendChild(document.createElement("br"));
      frag.appendChild(document.createTextNode(line));
    });
    if (trailingSeparator) frag.appendChild(document.createElement("br"));
    return frag;
  }

  // Some rich-text editors (CKEditor 5, ProseMirror, Quill, Slate, Draft.js,
  // Lexical, etc.) keep their own internal document MODEL and re-render the
  // editable DOM from it. If we mutate their DOM directly (Range.insertNode),
  // the inserted nodes live outside that model, so the editor treats them as
  // foreign content: it often becomes impossible to edit or delete, and it can
  // be stripped on the next change. Detect these so we can insert through the
  // editor's own input pipeline instead.
  const MODEL_EDITOR_SELECTOR =
    ".ck-editor__editable, .ck-content, .ProseMirror, .ql-editor, [data-slate-editor], .public-DraftEditor-content, [data-lexical-editor]";
  function findModelEditorHost(node) {
    const el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el || !el.closest) return null;
    return el.closest(MODEL_EDITOR_SELECTOR); // matches self or an ancestor
  }

  // Inserts text into a model-based editor (CKEditor 5, ProseMirror, Quill,
  // Lexical, …). These editors own an internal document model and only accept
  // content that arrives through their own input/clipboard pipeline; a native
  // `document.execCommand` with a native Range does NOT sync to their model, so
  // the insert silently no-ops (the symptom we saw: button flips to "Inserted"
  // but nothing appears). The most compatible pipeline across all of them is a
  // synthetic `paste` event carrying a DataTransfer — the editor's clipboard
  // handler reads it and inserts through the model, so the text stays fully
  // editable/deletable. `execCommand` is kept only as a secondary fallback.
  // Returns true only if the editor's content actually grew.
  function insertIntoModelEditor(hostEl, text, onDone) {
    try { hostEl.focus(); } catch (_) {}

    // Collapse the caret to the very START of the editor so the text is INSERTED
    // there, not pasted over whatever the user had selected. The collapse has to
    // take effect in the editor's own model, and model-based editors sync their
    // model selection from the DOM selection asynchronously (via the document
    // `selectionchange` event). So we set the collapsed DOM caret now and fire
    // the paste on the next tick, once that sync has happened — otherwise the
    // paste lands on the still-selected English and replaces it.
    const pageSelection = window.getSelection();
    const caret = document.createRange();
    caret.setStart(hostEl, 0); // very start of the editor
    caret.collapse(true);
    pageSelection.removeAllRanges();
    pageSelection.addRange(caret);

    const before = (hostEl.textContent || "").length;

    setTimeout(() => {
      let grew = false;

      // Primary: synthetic paste. text/html carries <br> line breaks so
      // multi-line text survives; text/plain is the fallback the editor uses if
      // it prefers it. Routes through the editor's clipboard pipeline, so the
      // text enters the model at the (now collapsed) caret and stays editable.
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        dt.setData(
          "text/html",
          text.split(/\r?\n/).map((l) => (l ? escapeHtml(l) : "")).join("<br>")
        );
        hostEl.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: dt,
          })
        );
        grew = (hostEl.textContent || "").length > before;
      } catch (_) {
        /* fall through to execCommand */
      }

      // Secondary: native input pipeline via execCommand("insertText"), which
      // fires the `beforeinput` events some editors also honour.
      if (!grew) {
        const lines = text.split(/\r?\n/);
        lines.forEach((line, idx) => {
          if (idx > 0) document.execCommand("insertParagraph");
          if (line) document.execCommand("insertText", false, line);
        });
        grew = (hostEl.textContent || "").length > before;
      }

      onDone(grew);
    }, 0);
  }

  // Inserts the current translation at the very start of the editable area
  // — position (0,0) of the editor, not at the position of the original
  // English selection — so it always lands at the top of whatever the user
  // is composing, regardless of where in the text they made the selection.
  // Direct DOM insertion at the start of a plain editable (Gmail, designMode
  // iframes, plain contenteditable). Not for model-based editors — see
  // insertIntoModelEditor.
  function insertViaDomRange(root, text) {
    const insertRange = document.createRange();
    insertRange.setStart(root, 0); // the very beginning of the editor's content
    insertRange.collapse(true);

    const frag = buildLineBreakFragment(text, true);
    const lastNode = frag.lastChild;
    insertRange.insertNode(frag);

    const after = document.createRange();
    after.setStartAfter(lastNode);
    after.collapse(true);
    const pageSelection = window.getSelection();
    pageSelection.removeAllRanges();
    pageSelection.addRange(after);
  }

  // Locks the Insert button once text has landed, so the same text can't be
  // inserted twice.
  function markInsertDone(insertBtnEl, ok) {
    if (!insertBtnEl) return;
    if (ok) {
      insertBtnEl.textContent = "Inserted ✓";
      insertBtnEl.disabled = true;
      insertBtnEl.title = "Already inserted";
      insertBtnEl.style.cssText = INSERT_STYLE_INSERTED;
      wireHover(insertBtnEl, INSERT_STYLE_INSERTED, INSERT_STYLE_INSERTED_HOVER);
    } else {
      insertBtnEl.textContent = "Insert failed — use Copy";
    }
  }

  function handleInsertClick() {
    if (!card || !canInsertHere || !originalSelectionRange) return;
    const insertBtnEl = card.querySelector(".e2h-insert-result");
    if (insertBtnEl?.disabled) return; // already inserted — button is locked
    const liveText = getCleanLinesText(card.querySelector(".e2h-hindi"));
    if (!liveText) return;

    try {
      const anchorNode = originalSelectionRange.startContainer;
      const formControl = findFormControl(anchorNode);

      if (formControl) {
        // <textarea>/<input> don't support DOM Range insertion — prepend
        // directly via their value property instead.
        const sep = formControl.value ? "\n" : "";
        formControl.value = liveText + sep + formControl.value;
        formControl.focus();
        formControl.setSelectionRange(0, 0);
        markInsertDone(insertBtnEl, true);
        return;
      }

      const root = findEditableRoot(anchorNode);
      if (!root) throw new Error("no editable root found");

      // Model-based editors (CKEditor 5, ProseMirror, Quill, …) must be fed
      // through their own input pipeline, otherwise the inserted text becomes
      // un-editable/un-deletable. That path is asynchronous (it waits a tick for
      // the editor to sync its collapsed caret), so it reports back via callback.
      // Fall back to direct DOM insertion only if it didn't take.
      const modelHost = findModelEditorHost(anchorNode);
      if (modelHost) {
        insertIntoModelEditor(modelHost, liveText, (ok) => {
          try {
            if (!ok) insertViaDomRange(root, liveText);
            markInsertDone(insertBtnEl, true);
          } catch (_) {
            markInsertDone(insertBtnEl, false);
          }
        });
        return;
      }

      insertViaDomRange(root, liveText);
      markInsertDone(insertBtnEl, true);
    } catch (_) {
      markInsertDone(insertBtnEl, false);
    }
  }

  function setActiveTab() {
    if (!card) return;
    card.querySelectorAll(".e2h-tab").forEach((tab) => {
      const isActive = tab.dataset.mode === currentMode;
      tab.classList.toggle("e2h-tab-active", isActive);
      tab.style.cssText = isActive ? TAB_STYLE_ACTIVE : TAB_STYLE_BASE;
    });
  }

  function showLoading() {
    if (!card) return;
    card.querySelector(".e2h-body").innerHTML = `
      <div class="e2h-loading">
        <span class="e2h-dot"></span><span class="e2h-dot"></span><span class="e2h-dot"></span>
        <span class="e2h-loading-text">Translating…</span>
      </div>
    `;
    const copyBtn = card.querySelector(".e2h-copy");
    copyBtn.disabled = true;
    copyBtn.textContent = "Copy";
    copyBtn.classList.remove("e2h-copied");
    copyBtn.style.cssText = COPY_STYLE_DISABLED;
    card.querySelector(".e2h-engine").textContent = "";
  }

  let isEditing = false;
  let suggestPopup = null;
  let insertBtn = null;
  let lastCaretRange = null;
  let activeHighlightSpan = null; // the manually-highlighted span currently being replaced, if any
  let replaceLeadingWs = ""; // whitespace that was part of the original selection, preserved across a replace
  let replaceTrailingWs = "";

  function removeSuggestPopup() {
    if (suggestPopup) { suggestPopup.remove(); suggestPopup = null; }
    if (activeHighlightSpan && activeHighlightSpan.isConnected) {
      activeHighlightSpan.replaceWith(document.createTextNode(activeHighlightSpan.textContent));
    }
    activeHighlightSpan = null;
  }

  function removeInsertBtn() {
    if (insertBtn) { insertBtn.remove(); insertBtn = null; }
    lastCaretRange = null;
  }

  // Shows a small "+" button at the text cursor whenever it's just a caret
  // (no selection) inside the editable हिंदी box, so a brand-new word can be
  // inserted at that exact point — not just a replacement of an existing word.
  function updateInsertButton() {
    if (!isEditing || currentMode !== "hindi" || !card) { removeInsertBtn(); return; }
    const box = card.querySelector(".e2h-hindi");
    if (!box) { removeInsertBtn(); return; }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      removeInsertBtn();
      return;
    }
    const anchorNode = selection.anchorNode;
    if (!anchorNode || !box.contains(anchorNode)) {
      removeInsertBtn();
      return;
    }

    const range = selection.getRangeAt(0).cloneRange();
    const rect = range.getBoundingClientRect();
    lastCaretRange = range;

    if (!insertBtn) {
      insertBtn = document.createElement("button");
      insertBtn.type = "button";
      insertBtn.className = "e2h-insert-btn";
      insertBtn.textContent = "+";
      insertBtn.title = "Insert a word here";
      insertBtn.style.cssText =
        "position:absolute !important;z-index:2147483647 !important;width:20px !important;height:20px !important;" +
        "line-height:18px !important;text-align:center !important;padding:0 !important;border:none !important;" +
        "border-radius:50% !important;background:#1b7a43 !important;color:#fffdf8 !important;font-size:14px !important;" +
        "font-weight:700 !important;cursor:pointer !important;box-shadow:0 2px 6px rgba(0,0,0,0.25) !important;margin:0 !important;";
      insertBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!lastCaretRange) return;
        const insertRange = lastCaretRange.cloneRange();
        const insertRect = insertBtn.getBoundingClientRect();
        removeInsertBtn();
        openSuggestPopup(insertRange, insertRect, "insert");
      });
      document.documentElement.appendChild(insertBtn);
    }
    insertBtn.style.left = `${rect.left + window.scrollX - 2}px`;
    insertBtn.style.top = `${rect.top + window.scrollY - 24}px`;
  }

  function toggleEdit() {
    if (!card) return;
    const box = card.querySelector(".e2h-hindi");
    if (!box) return; // nothing rendered yet (still loading / error state)

    isEditing = !isEditing;
    box.contentEditable = isEditing ? "true" : "false";
    box.classList.toggle("e2h-editing", isEditing);

    const editBtn = card.querySelector(".e2h-edit");
    editBtn.textContent = isEditing ? "✓ Done" : "✎ Edit";
    editBtn.classList.toggle("e2h-edit-active", isEditing);
    editBtn.style.cssText = isEditing ? EDIT_STYLE_ACTIVE : EDIT_STYLE_BASE;

    if (isEditing) {
      box.focus();
    } else {
      removeSuggestPopup();
      removeInsertBtn();
    }
  }

  // Selecting text inside the हिंदी tab (while editing) — via double-click on
  // one word, or drag-selecting a whole phrase — opens a popup to retype the
  // selection phonetically in Roman script and pick from Bhashini's suggestions.
  // The selection is wrapped in a visible highlight span, since the browser's
  // native selection highlight disappears once focus moves to the popup input.
  function handleSelectionInBox() {
    if (!isEditing || currentMode !== "hindi") return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
    const box = card?.querySelector(".e2h-hindi");
    if (!box || !box.contains(selection.anchorNode)) return;

    const range = selection.getRangeAt(0).cloneRange();
    // Double-click word-selection sometimes includes the trailing (or a
    // leading) space along with the word. Since the replacement swaps out
    // the whole selection, that whitespace needs to be preserved separately
    // or the next word ends up stuck directly against the replacement.
    const selectedRaw = range.toString();
    replaceLeadingWs = (selectedRaw.match(/^\s+/) || [""])[0];
    replaceTrailingWs = (selectedRaw.match(/\s+$/) || [""])[0];

    const span = document.createElement("span");
    span.className = "e2h-selected-highlight";
    span.style.cssText =
      "background:rgba(232,114,12,0.32) !important;border-radius:3px !important;" +
      "padding:0 1px !important;box-shadow:0 0 0 1px rgba(232,114,12,0.5) !important;";
    try {
      range.surroundContents(span);
    } catch (_) {
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    selection.removeAllRanges();

    const rect = span.getBoundingClientRect();
    removeInsertBtn();
    openSuggestPopup(span, rect, "replace");
  }

  function openSuggestPopup(target, rect, mode) {
    removeSuggestPopup(); // clears any prior popup and reverts its highlight, if any
    if (mode === "replace") activeHighlightSpan = target;

    suggestPopup = document.createElement("div");
    suggestPopup.className = "e2h-suggest";
    // Minimal safety-net styling — guarantees the popup floats correctly
    // near the word instead of falling into normal document flow (which
    // otherwise makes it appear stranded at the bottom of the page) on
    // pages where content.css doesn't load.
    suggestPopup.style.cssText =
      "position:absolute !important;z-index:2147483647 !important;width:240px !important;" +
      "background:#1f2430 !important;border-radius:8px !important;" +
      "box-shadow:0 8px 24px rgba(0,0,0,0.35) !important;padding:8px !important;margin:0 !important;";
    suggestPopup.style.left = `${rect.left + window.scrollX}px`;
    suggestPopup.style.top = `${rect.bottom + window.scrollY + 4}px`;
    suggestPopup.innerHTML = `
      <input type="text" class="e2h-suggest-input" placeholder="Type in Roman, e.g. mera" autocomplete="off"
        style="width:100% !important;box-sizing:border-box !important;padding:6px 8px !important;border:1px solid #3a4152 !important;border-radius:6px !important;background:#2a3040 !important;color:#fffdf8 !important;font-size:12.5px !important;outline:none !important;margin:0 !important;" />
      <div class="e2h-suggest-list" style="display:flex !important;flex-wrap:wrap !important;gap:5px !important;margin:7px 0 0 0 !important;max-height:140px !important;overflow-y:auto !important;"></div>
    `;
    document.documentElement.appendChild(suggestPopup);

    const input = suggestPopup.querySelector(".e2h-suggest-input");
    const list = suggestPopup.querySelector(".e2h-suggest-list");
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.focus();

    let debounceTimer = null;
    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      const val = input.value.trim();
      if (!val) { list.innerHTML = ""; return; }
      debounceTimer = setTimeout(() => fetchSuggestions(val, list, target, mode), 250);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") removeSuggestPopup();
    });
  }

  function fetchSuggestions(romanWord, list, target, mode) {
    list.innerHTML = `<div class="e2h-suggest-loading">…</div>`;
    chrome.runtime.sendMessage({ type: "TRANSLITERATE", text: romanWord }, (response) => {
      if (!suggestPopup) return; // popup closed while waiting
      if (chrome.runtime.lastError || !response?.ok) {
        list.innerHTML = `<div class="e2h-suggest-error">${escapeHtml(
          response?.error || chrome.runtime.lastError?.message || "No suggestions available"
        )}</div>`;
        return;
      }
      list.innerHTML = "";
      response.candidates.forEach((word) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "e2h-suggest-chip";
        chip.textContent = word;
        const chipBaseStyle =
          "border:none !important;background:#3a4152 !important;color:#fffdf8 !important;" +
          "font-size:14px !important;padding:4px 10px !important;border-radius:999px !important;" +
          "cursor:pointer !important;margin:0 !important;";
        chip.style.cssText = chipBaseStyle;
        // Inline styles can't express :hover, and content.css's hover rule
        // isn't reliable on every page — these listeners guarantee the
        // orange hover feedback regardless.
        chip.addEventListener("mouseenter", () => {
          chip.style.cssText = chipBaseStyle.replace("#3a4152", "#e8720c");
        });
        chip.addEventListener("mouseleave", () => {
          chip.style.cssText = chipBaseStyle;
        });
        chip.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            if (mode === "replace") {
              // target is the highlighted <span> wrapping the selected text.
              // Re-attach any whitespace that was part of the original
              // selection (double-click can grab a trailing space along
              // with the word), so the next word doesn't end up stuck to it.
              target.replaceWith(document.createTextNode(replaceLeadingWs + word + replaceTrailingWs));
              activeHighlightSpan = null; // already resolved, nothing left to revert
            } else {
              // target is a collapsed Range at the insertion point. A trailing
              // space is added automatically so the new word doesn't run into
              // whatever follows it.
              target.insertNode(document.createTextNode(word + " "));
            }
          } catch (_) {
            // DOM may have changed since the popup opened — ignore, user can retry
          }
          removeSuggestPopup();
        });
        list.appendChild(chip);
      });
    });
  }

  function showResult(lines) {
    if (!card) return;
    const body = card.querySelector(".e2h-body");
    body.innerHTML = `<div class="e2h-hindi ${currentMode === "hinglish" ? "e2h-latin" : ""}"></div>`;
    const box = body.firstElementChild;

    lines.forEach(({ text: lineText, engineUsed }) => {
      const lineDiv = document.createElement("div");
      lineDiv.className = "e2h-line";
      lineDiv.style.cssText =
        "display:flex !important;flex-direction:row !important;align-items:center !important;margin:0 0 4px 0 !important;";

      if (lineText && engineUsed) {
        const dot = document.createElement("span");
        dot.className = "e2h-engine-dot";
        dot.contentEditable = "false";
        dot.title = ENGINE_LABELS[engineUsed] || engineUsed;
        dot.style.cssText = engineDotStyle(engineUsed);
        lineDiv.appendChild(dot);
      }

      const textSpan = document.createElement("span");
      textSpan.className = "e2h-line-text";
      textSpan.textContent = lineText || "\u00a0"; // keep blank lines visually present
      lineDiv.appendChild(textSpan);

      box.appendChild(lineDiv);
    });

    box.addEventListener("mouseup", handleSelectionInBox);
    box.addEventListener("keyup", updateInsertButton);
    box.addEventListener("click", updateInsertButton);

    // Edit mode only applies meaningfully to the हिंदी tab (word suggestions
    // are Devanagari-specific); reset edit state when switching tabs.
    isEditing = false;
    removeSuggestPopup();
    removeInsertBtn();
    const editBtn = card.querySelector(".e2h-edit");
    editBtn.textContent = "✎ Edit";
    editBtn.classList.remove("e2h-edit-active");
    editBtn.style.cssText = EDIT_STYLE_BASE;

    const engineEl = card.querySelector(".e2h-engine");
    engineEl.textContent = formatEngineLabel(cache.engineUsed);

    const oldBtn = card.querySelector(".e2h-copy");
    const copyBtn = oldBtn.cloneNode(true);
    oldBtn.replaceWith(copyBtn);
    copyBtn.disabled = false;
    copyBtn.textContent = `Copy ${MODE_LABELS[currentMode]}`;
    copyBtn.style.cssText = COPY_STYLE_BASE;
    wireHover(copyBtn, COPY_STYLE_BASE, COPY_STYLE_HOVER);
    copyBtn.addEventListener("click", async () => {
      // Read live text so any manual edits the user made are included —
      // extracted per-line so the engine-dot badges are never included.
      const liveText = getCleanLinesText(card.querySelector(".e2h-hindi"));
      try {
        await copyWithFormatting(liveText);
        copyBtn.textContent = "Copied ✓";
        copyBtn.classList.add("e2h-copied");
        copyBtn.style.cssText = COPY_STYLE_COPIED;
        setTimeout(() => {
          if (!card) return;
          copyBtn.textContent = `Copy ${MODE_LABELS[currentMode]}`;
          copyBtn.classList.remove("e2h-copied");
          copyBtn.style.cssText = COPY_STYLE_BASE;
        }, 1600);
      } catch (_) {
        copyBtn.textContent = "Copy failed";
      }
    });
  }

  // Basic formatting preservation: writes both plain text and HTML (with
  // real <br> line breaks) to the clipboard, so pasting a multi-line
  // translation into a rich-text editor (Gmail, webmail, Word) keeps
  // paragraph/list breaks instead of collapsing into one run-on line —
  // while plain-text destinations still get a clean plain-text fallback.
  async function copyWithFormatting(text) {
    const html = text
      .split(/\r?\n/)
      .map((line) => escapeHtml(line))
      .join("<br>");
    try {
      const item = new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" })
      });
      await navigator.clipboard.write([item]);
    } catch (_) {
      await navigator.clipboard.writeText(text);
    }
  }

  function showError(msg) {
    if (!card) return;
    card.querySelector(".e2h-body").innerHTML = `<div class="e2h-error">${escapeHtml(msg)}</div>`;
  }

  function loadMode() {
    setActiveTab();
    const linesKey = currentMode === "hindi" ? "hindiLines" : "hinglishLines";
    if (cache[linesKey]) {
      showResult(cache[linesKey]);
      return;
    }
    showLoading();
    const requestedMode = currentMode;
    getResult(requestedMode)
      .then(() => {
        if (card && currentMode === requestedMode) {
          const key = requestedMode === "hindi" ? "hindiLines" : "hinglishLines";
          showResult(cache[key]);
        }
      })
      .catch((err) => {
        if (card && currentMode === requestedMode) showError(err.message);
      });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // =========================================================
  // Entry points
  // =========================================================

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "SHOW_TRANSLATION") return;
    removeTrigger();

    let x = window.scrollX + document.documentElement.clientWidth / 2 - 180;
    let y = window.scrollY + 120;
    let text = message.text;
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      text = extractSelectionText(range) || message.text;
      originalSelectionRange = range.cloneRange();
      const rect = range.getBoundingClientRect();
      if (rect.width || rect.height) {
        x = rect.left + window.scrollX;
        y = rect.bottom + window.scrollY + 8;
      }
    } else if (originalSelectionRange) {
      // Right-click → context menu can clear the live selection by the time
      // this async message arrives. Fall back to whatever was captured at
      // mouseup time rather than discarding it.
      try {
        const rect = originalSelectionRange.getBoundingClientRect();
        if (rect.width || rect.height) {
          x = rect.left + window.scrollX;
          y = rect.bottom + window.scrollY + 8;
        }
      } catch (_) {
        // stale range — harmless, just keep default position
      }
    }
    openCard(text, message.mode || "hindi", x, y);
  });

  // Selecting text shows a small button right next to it — translation only
  // starts once the user explicitly clicks it.
  document.addEventListener("mouseup", (e) => {
    if (e.target.closest?.(".e2h-trigger, .e2h-card")) return;

    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        removeTrigger();
        return;
      }
      const range = selection.getRangeAt(0);
      const text = extractSelectionText(range);

      if (!text || text.length < 2) {
        removeTrigger();
        return;
      }

      originalSelectionRange = range.cloneRange();
      const rect = range.getBoundingClientRect();
      const x = rect.left + window.scrollX + rect.width / 2 - 22;
      const y = rect.bottom + window.scrollY + 8;
      showTrigger(x, y, text);
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    if (e.target.closest?.(".e2h-trigger, .e2h-card, .e2h-suggest, .e2h-insert-btn")) return;
    removeTrigger();
    removeCard();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      removeTrigger();
      removeCard();
    }
  });

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!isDraggingCard || !card) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      card.style.left = `${dragStartLeft + dx}px`;
      card.style.top = `${dragStartTop + dy}px`;
    },
    true
  );

  document.addEventListener(
    "mouseup",
    () => {
      isDraggingCard = false;
    },
    true
  );
})();
