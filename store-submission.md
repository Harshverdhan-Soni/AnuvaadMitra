# Chrome Web Store — submission form text (paste-ready)

Copy each block into the matching field of the Chrome Web Store Developer
Dashboard. Fill any `[bracketed]` placeholders first. Keep this file out of the
uploaded ZIP.

---

## 1. Single purpose description

> CDAC AnuvaadMitra has one purpose: to translate English text that the user
> selects on a web page into Hindi (or Hinglish) and display it for the user to
> copy.

---

## 2. Permission justifications

Paste one justification per declared permission.

### `storage`
> Used to save the user's own settings — chosen translation engine, the
> automatic-fallback preference, and an optional custom translation-server URL —
> so they persist between sessions. No personal data is stored.

### `contextMenus`
> Adds a right-click menu option ("Translate to Hindi / Hinglish") so the user
> can translate their current text selection from the context menu.

### Host permission — `https://translate.googleapis.com/*`
> The Google Translate engine option sends the user's selected text to Google's
> translation endpoint and returns the Hindi translation.

### Host permission — `https://anuvaadmitra.cdac.in/*`
> This is C-DAC's translation proxy. The extension sends the user's selected text
> here to obtain a translation from the C-DAC Pune and Bhashini engines. The
> proxy holds the API credentials server-side so they are not exposed in the
> extension. (Replace with your actual deployed proxy host if different.)

### Host permission — `https://nlpsangraha.ebhasha.in/*`
> Endpoint for the C-DAC Pune translation engine, used as a direct fallback path
> to translate the user's selected English text into Hindi.

### Content script host access — `<all_urls>` with `all_frames`
> The extension's core function is to translate text the user selects on any web
> page they are reading. Because the user may select text on any site — and
> inside embedded frames such as webmail compose windows — the content script
> must be able to run on all URLs and all frames to detect the selection and show
> the translation in place. The script only reads the text the user explicitly
> selects and never reads or transmits other page content.

---

## 3. Remote code

Answer: **No, I am not using remote code.**

> All extension logic ships inside the package. The extension only makes network
> requests to translation APIs to send selected text and receive a translation;
> it does not load or execute any remotely hosted JavaScript.

---

## 4. Data usage — Privacy Practices tab

### Data types collected / used
Select and disclose:

- **Website content** — YES. The extension transmits the specific text the user
  selects for translation to the chosen translation service. (This is the only
  user data the extension handles beyond local settings.)

Do **not** select (the extension does not collect these): personally identifiable
information, health information, financial and payment information, authentication
information, personal communications, location, web history, or user activity
(analytics/clicks/keystroke logging).

### Required certifications (check all three — all are true for this extension)

- [x] I do not sell or transfer user data to third parties, outside of the
      approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my
      item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for
      lending purposes.

### Privacy policy URL
> [https://your-hosted-privacy-policy-url]  ← the public URL where you host
> privacy-policy.html

---

## 5. Notes on the "Website content" disclosure

The selected text is sent to third-party translation engines (C-DAC Pune,
Bhashini, Google Translate) solely to produce the translation the user requested.
This is disclosed in the privacy policy under "Third-party translation services."
Ensure the Privacy Practices selections above match the privacy policy wording.

---

## 6. Pre-submission checklist

- [ ] Replace the proxy host placeholder in `background.js` (`DEFAULT_PROXY_BASE`)
      and `manifest.json` (`host_permissions`) with the real deployed HTTPS host.
- [ ] Deploy the proxy (`proxy-server/`) and confirm `/healthz` responds.
- [ ] Fill placeholders in the privacy policy (contact email, effective date) and
      host it at a public URL.
- [ ] Lock the proxy's `ALLOWED_ORIGINS` to the published extension ID after the
      first upload (the ID is assigned on upload).
- [ ] Build the upload ZIP from extension files only — exclude `proxy-server/`,
      `privacy-policy/`, `store-submission.md`, `README.md`, `.git/`, `.gitignore`.
- [ ] Prepare listing assets: 128×128 icon, at least one 1280×800 (or 640×400)
      screenshot of the translation card in action, short + detailed description.
- [ ] Pay the one-time US$5 developer registration fee (per account) if not done.
- [ ] Choose visibility: Public (as decided).
