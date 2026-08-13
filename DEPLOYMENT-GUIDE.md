# CDAC AnuvaadMitra — End-to-End Deployment & Publishing Guide

This document walks through every step required to take the extension from its
current state to a live listing on the Chrome Web Store. Follow the phases in
order; each ends with a **Checkpoint** you can verify before moving on.

> Convention: text in `[brackets]` is a placeholder you must replace with a real
> value. Commands prefixed `$` run on a Linux server; PowerShell commands are
> shown as `PS>`.

---

## 0. Where things stand (already done)

The codebase is prepared for public listing:

- Hardcoded Bhashini credentials removed from the extension.
- Bhashini and C-DAC Pune calls route through a configurable proxy
  (`background.js` → `DEFAULT_PROXY_BASE`; `manifest.json` → `host_permissions`).
- Popup exposes an optional proxy-URL override; no keys are stored in the browser.
- Manifest trimmed, `minimum_chrome_version` set, version `5.17.0`.
- Proxy server written (`proxy-server/`) with Dockerfile + deployment notes.
- Privacy policy drafted (`privacy-policy/`), HTML + markdown.
- Submission-form text drafted (`store-submission.md`).
- Packaging scripts written (`build/`).

**What remains** is operational: deploy the proxy, point the extension at it,
host the privacy policy, prepare assets, register, package, submit.

---

## 1. Prerequisites (gather before you start)

- [ ] A C-DAC-controlled server (Linux) with a public hostname and HTTPS
      certificate — e.g. `anuvaadmitra.cdac.in`.
- [ ] The real Bhashini/Udyat **User ID** and **Udyat Key** for the C-DAC account.
- [ ] A Google account to register as a Chrome Web Store developer (US$5 one-time
      fee, per account).
- [ ] An official C-DAC contact email for the listing and privacy policy
      (e.g. `[anuvaadmitra-support@cdac.in]`).
- [ ] Node.js 18+ on your local machine (to run the packaging script) — or use
      the PowerShell script instead.

**Checkpoint:** you have a server hostname, the Bhashini credentials, a Google
account, and a contact email in hand.

---

## 2. Deploy the proxy server on C-DAC infrastructure

The proxy holds the Bhashini credentials so they never ship in the extension.
Full details are in `proxy-server/README.md`; the summary:

### 2.1 Copy the app to the server
```
$ sudo mkdir -p /opt/anuvaadmitra-proxy
$ sudo cp server.js package.json /opt/anuvaadmitra-proxy/
$ cd /opt/anuvaadmitra-proxy
$ sudo npm install --omit=dev
```

### 2.2 Create the environment file (root-only)
```
$ sudo tee /opt/anuvaadmitra-proxy/.env >/dev/null <<'EOF'
BHASHINI_USER_ID=[your_real_user_id]
BHASHINI_ULCA_KEY=[your_real_udyat_key]
ALLOWED_ORIGINS=*
PORT=8080
EOF
$ sudo chmod 600 /opt/anuvaadmitra-proxy/.env
```
> Leave `ALLOWED_ORIGINS=*` for now; you'll lock it to the extension ID in Phase 10
> after the ID exists.

### 2.3 Run it as a service
Use the `systemd` unit in `proxy-server/README.md` (§3c), then:
```
$ sudo systemctl enable --now anuvaadmitra-proxy
$ sudo systemctl status anuvaadmitra-proxy
```

### 2.4 Put HTTPS in front
Configure nginx (README §3d) so `https://[your-host]` reverse-proxies to
`127.0.0.1:8080`, with a valid TLS certificate.

### 2.5 Test the live proxy
```
$ curl https://[your-host]/healthz
  → {"ok":true,"bhashiniConfigured":true}
$ curl -X POST https://[your-host]/api/translate \
    -H "Content-Type: application/json" \
    -d '{"engine":"cdac","text":"Please attach the relevant documents."}'
  → {"translation":"..."}
$ curl -X POST https://[your-host]/api/translate \
    -H "Content-Type: application/json" \
    -d '{"engine":"bhashini","text":"Good morning."}'
  → {"translation":"..."}
```

**Checkpoint:** `/healthz` shows `bhashiniConfigured:true`, and both `cdac` and
`bhashini` requests return a `translation` over HTTPS.

---

## 3. Point the extension at the proxy

The proxy host must match in **two** files.

1. `background.js`:
   ```js
   const DEFAULT_PROXY_BASE = "https://[your-host]";
   ```
2. `manifest.json` → `host_permissions`:
   ```json
   "https://[your-host]/*"
   ```
   (Replace the placeholder `anuvaadmitra.cdac.in` entry.)

### 3.1 Test locally (unpacked)
1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension` folder.
4. On any web page, select English text → click **अ→हि**, and right-click →
   **Translate to Hindi**. Confirm a translation card appears.
5. Open the extension popup, switch engines (C-DAC Pune / Bhashini / Google),
   and confirm each returns a translation.

**Checkpoint:** all three engines translate correctly through the deployed proxy
in a locally loaded copy.

---

## 4. Finalize and host the privacy policy

1. Open `privacy-policy/privacy-policy.html` and replace:
   - `[anuvaadmitra-support@cdac.in]` → your official contact email (2 places).
   - `[DD Month 2026]` → today's date (2 places).
   - Confirm/adjust the C-DAC Pune policy link.
2. Publish the HTML at a **public, persistent** URL that opens without login, for
   example a page on `cdac.in`, or via GitHub Pages from this repo.
3. Open the hosted URL in a private browser window to confirm it loads publicly.

**Checkpoint:** the privacy policy is live at a public URL, placeholders filled.

---

## 5. Prepare the store listing assets

Chrome Web Store requires:

- [ ] **Store icon** — 128×128 PNG (you have `icons/icon128.png`).
- [ ] **Screenshots** — at least one, 1280×800 or 640×400 PNG/JPEG. Capture the
      translation card in action on a real page (and the popup settings).
- [ ] **Short description** — up to 132 characters. Suggested:
      > Select English text on any page and get an instant Hindi translation —
      > powered by C-DAC, Bhashini, and Google.
- [ ] **Detailed description** — what it does, the three engines, how to use it
      (select → अ→हि or right-click), and that it's a C-DAC product.
- [ ] **Category** — Productivity (or Tools).
- [ ] **Language** — English (with Hindi relevance noted in the description).
- [ ] *(Optional)* small promo tile 440×280.

**Checkpoint:** icon, at least one screenshot, and both descriptions are ready.

---

## 6. Register the developer account

1. Go to the Chrome Web Store Developer Dashboard
   (`https://chrome.google.com/webstore/devconsole`).
2. Sign in with the Google account that will own the listing.
3. Pay the one-time **US$5** registration fee.
4. Complete the account details (publisher name — for a C-DAC product, set the
   publisher/display name to **C-DAC** as agreed) and verify the contact email.

**Checkpoint:** you can access the dashboard and see "Add new item".

---

## 7. Build the upload package

From the `extension` folder on your machine:
```
node build/package-extension.mjs
```
or, without Node:
```
PS> .\build\package-extension.ps1
```
This creates `dist/anuvaadmitra-v5.17.0.zip` containing only the runtime files
(`manifest.json` at the root, JS/CSS/HTML, `icons/`). The script aborts if it
detects a leftover credential.

**Checkpoint:** `dist/anuvaadmitra-v5.17.0.zip` exists; if you open it, it
contains the manifest at the top level and no `proxy-server/`, `privacy-policy/`,
docs, or `.git`.

---

## 8. Create the item and fill the submission form

In the dashboard, click **Add new item** and upload the ZIP. Then complete every
tab, using the paste-ready text in `store-submission.md`:

### 8.1 Store listing
- Short + detailed description, category, language.
- Upload the 128×128 icon and screenshot(s).

### 8.2 Privacy tab
- **Single purpose** — paste from `store-submission.md` §1.
- **Permission justifications** — paste each from §2 (`storage`, `contextMenus`,
  each host permission, and the `<all_urls>`/all-frames content-script access).
- **Remote code** — select **No** (§3).
- **Data usage / Privacy practices** — disclose **Website content** only; do not
  check the other categories. Tick the three certifications (§4).
- **Privacy policy URL** — paste your hosted URL from Phase 4.

### 8.3 Distribution
- **Visibility:** Public.
- Regions: all (or as required).

**Checkpoint:** every required field is green/complete; no validation warnings
remain.

---

## 9. Submit for review

1. Click **Submit for review**.
2. Review typically takes from a few hours to a few days. Broad host permissions
   (`<all_urls>`) can lengthen it — the justification you pasted is there for
   exactly this.
3. Watch the dashboard and the developer contact email for the decision or any
   reviewer questions.

**If rejected:** read the stated reason, fix it (often a permissions
justification or privacy-practices mismatch), bump the `version` in
`manifest.json`, re-run the packaging script, and re-submit.

**Checkpoint:** status shows "Pending review", then "Published".

---

## 10. Post-approval: lock the proxy to your extension ID

Once published, Chrome assigns a permanent 32-character extension ID (visible on
the listing URL and in `chrome://extensions`).

1. On the server, edit `/opt/anuvaadmitra-proxy/.env`:
   ```
   ALLOWED_ORIGINS=chrome-extension://[your-32-char-extension-id]
   ```
2. Restart: `$ sudo systemctl restart anuvaadmitra-proxy`
3. Confirm the published extension still translates, and that requests from other
   origins are refused.

**Checkpoint:** only your published extension can call the proxy.

---

## 11. Publishing updates later

For any future change:

1. Make the code change.
2. Increment `version` in `manifest.json` (e.g. `5.17.0` → `5.17.1`).
3. Re-run the packaging script.
4. In the dashboard, open the item → **Package** → upload the new ZIP →
   **Submit for review**.
5. Commit and push the change to the repo.

---

## Quick reference — the two must-match placeholders

| Placeholder | Files it appears in |
|---|---|
| Proxy host (`https://[your-host]`) | `background.js` (`DEFAULT_PROXY_BASE`), `manifest.json` (`host_permissions`), `store-submission.md` (host justification) |
| Contact email / effective date | `privacy-policy/privacy-policy.html` and `.md` |

## Master checklist

- [ ] Proxy deployed, HTTPS, `/healthz` = `bhashiniConfigured:true`
- [ ] Extension points at the proxy (both files), tested locally, all engines work
- [ ] Privacy policy placeholders filled and hosted at a public URL
- [ ] Listing assets ready (icon, screenshot, descriptions)
- [ ] Developer account registered, US$5 paid
- [ ] Package built from `build/` script (runtime files only)
- [ ] Submission form completed from `store-submission.md`
- [ ] Submitted for review → published
- [ ] `ALLOWED_ORIGINS` locked to the published extension ID
