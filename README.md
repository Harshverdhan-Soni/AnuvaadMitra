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
├── manifest.json         # MV3 manifest
├── background.js         # service worker: context menus + engine orchestration
├── content.js/.css       # in-page selection button and translation card
├── popup.html/.js        # settings: engine choice, fallback, server override
├── icons/                # extension icons
└── proxy-server/         # credential-holding translation proxy (server app)
```

## Architecture: why there is a proxy

A Chrome extension's source is fully readable by anyone who installs it, so **no
API credential may ship inside the extension**. The Bhashini (ULCA/Udyat)
credentials therefore live only on a small server that C-DAC controls
(`proxy-server/`). The extension calls that proxy over a clean, credential-free
JSON API; the proxy injects the real credentials and forwards the request
upstream.

```
Chrome extension ──HTTPS──▶ proxy-server (holds Bhashini creds) ──▶ Bhashini / C-DAC Pune
                 ──HTTPS──▶ Google Translate (no credentials)
```

See [`proxy-server/README.md`](proxy-server/README.md) for the proxy API and
deployment on a C-DAC server (systemd + nginx + HTTPS, or Docker).

## Configure the proxy host

The proxy host appears in **two** places that must match:

1. `background.js` → `const DEFAULT_PROXY_BASE = "https://anuvaadmitra.cdac.in";`
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

Package **only** the extension files — do **not** include `proxy-server/`,
`.git/`, or `README.md` build notes in the uploaded ZIP:

```
manifest.json  background.js  content.js  content.css  popup.html  popup.js  icons/
```

Store submission also requires a public privacy policy URL and permission
justifications (notably for `<all_urls>` + `all_frames`). Those are tracked
separately from this repository.

## License

Internal C-DAC project. Add a license here if this is to be distributed.
