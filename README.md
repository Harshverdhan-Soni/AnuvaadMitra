# CDAC AnuvaadMitra

A Chrome extension that translates selected **English** text to **Hindi** (or
Hinglish) on any web page. Select text and click the floating **अ→हि** button, or
right-click and choose *Translate to Hindi*, and a copy-ready translation card
appears in place.

It draws on three translation engines with automatic fallback:

- **C-DAC Pune** — C-DAC's in-house translation API (best observed quality)
- **Bhashini** — MeitY's national translation API (IndicTrans models)
- **Google Translate** — free web endpoint, used as a final safety net

In *Auto* mode the extension tries C-DAC Pune → Bhashini → Google in order, so a
translation appears even if one engine is unavailable.

## Repository layout

```
.
├── manifest.json          # MV3 manifest (public build: Google + proxy hosts only)
├── background.public.js   # PUBLIC build service worker (credential-free, proxy-only)
├── background.js          # INTERNAL build service worker (embeds creds; sideload only)
├── content.js/.css        # in-page selection button and translation card
├── popup.html/.js         # settings: engine choice, fallback, server override
├── icons/                 # extension icons
├── build/                 # packaging scripts (ship the PUBLIC build)
└── proxy-server/          # credential-holding translation proxy (server app)
```

## Two builds — do not confuse them

There are two service-worker variants:

- **Public build — `background.public.js`.** Credential-free and **proxy-only**:
  Bhashini and C-DAC Pune are reached through the C-DAC proxy, which holds the
  credentials server-side. This is the **only** build that may be published to the
  Chrome Web Store. The packaging script ships it *as* `background.js`.
- **Internal build — `background.js`.** Embeds the Bhashini User ID / Udyat Key in
  `BHASHINI_*` constants and calls the ULCA/Dhruva APIs directly (used when no
  proxy is deployed). Suitable for **sideloaded / internal** distribution to
  trusted machines only — **never publish it**, because its source (and therefore
  its credentials) is readable by anyone who installs it.

## Architecture: why there is a proxy

A Chrome extension's source is fully readable by anyone who installs it, so **no
API credential may ship in a published extension**. In the public build the
Bhashini (ULCA/Udyat) credentials live only on a small server that C-DAC controls
(`proxy-server/`). The extension calls that proxy over a clean, credential-free
JSON API; the proxy injects the real credentials and forwards the request
upstream.

```
Public build ──HTTPS──▶ proxy-server (holds Bhashini creds) ──▶ Bhashini / C-DAC Pune
             ──HTTPS──▶ Google Translate (no credentials)
```

See [`proxy-server/README.md`](proxy-server/README.md) for the proxy API and
deployment on a C-DAC server (systemd + nginx + HTTPS, or Docker).

## Configure the proxy host

The proxy host appears in **two** places that must match:

1. `background.public.js` → `const DEFAULT_PROXY_BASE = "https://anuvaadmitra.cdac.in";`
2. `manifest.json` → `host_permissions` entry `"https://anuvaadmitra.cdac.in/*"`

Replace both with the deployed HTTPS host before packaging. End users can also
override the server URL under the popup's *Advanced: translation server* section.

## Load the extension locally (development)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder
4. Select English text on any page and click **अ→हि**, or right-click →
   *Translate to Hindi*

## Publishing to the Chrome Web Store

Use the packaging script — it ships the **public** build (`background.public.js`
as `background.js`), excludes everything that shouldn't ship, and aborts if it
detects an internal-build credential marker:

```
node build/package-extension.mjs        # cross-platform (Node 18+)
.\build\package-extension.ps1           # native Windows PowerShell
```

The resulting `dist/anuvaadmitra-v<version>.zip` contains only:

```
manifest.json  background.js(=public)  content.js  content.css  popup.html  popup.js  icons/
```

Never hand-zip the folder for publishing — that risks shipping the internal
`background.js`. Store submission also requires a public privacy policy URL and
permission justifications (see `store-submission.md` and `DEPLOYMENT-GUIDE.md`).

## License

Internal C-DAC project. Add a license here if this is to be distributed.
