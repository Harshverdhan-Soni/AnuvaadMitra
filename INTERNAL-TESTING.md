# CDAC AnuvaadMitra — Internal LAN Testing Guide

This is the **internal testing** track: run the proxy on the C-DAC VM
(`10.248.0.55`) and have a few internal employees try the extension on the local
network before any public Web Store launch. It exercises the real proxy
architecture, so going public later is mostly a URL change.

> Scope: internal LAN only. The test build talks to `http://10.248.0.55:8080`
> (a private IP over plain HTTP) and is loaded unpacked. It must **never** be
> uploaded to the Chrome Web Store. When you go public you switch to the public
> HTTPS host and use the store packaging script instead.

---

## Part 1 — Deploy the proxy on the VM (10.248.0.55)

Do this once on the Ubuntu 24.04 VM. Full detail is in `proxy-server/README.md`.

### 1.1 Install Node.js 20 (if not present)
```
$ sudo apt update
$ curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
$ sudo apt install -y nodejs
$ node -v        # should print v20.x
```

### 1.2 Copy the proxy app and install dependencies
Copy the `proxy-server/` folder to the VM (scp, git, or a share), then:
```
$ sudo mkdir -p /opt/anuvaadmitra-proxy
$ sudo cp server.js package.json /opt/anuvaadmitra-proxy/
$ cd /opt/anuvaadmitra-proxy
$ sudo npm install --omit=dev
```

### 1.3 Add the credentials (root-only file)
```
$ sudo tee /opt/anuvaadmitra-proxy/.env >/dev/null <<'EOF'
BHASHINI_USER_ID=<real C-DAC Bhashini User ID>
BHASHINI_ULCA_KEY=<real C-DAC Udyat Key>
ALLOWED_ORIGINS=*
PORT=8080
EOF
$ sudo chmod 600 /opt/anuvaadmitra-proxy/.env
```
> `ALLOWED_ORIGINS=*` is fine for internal testing (load-unpacked gives each
> machine a different extension ID). You lock this down only for public launch.

### 1.4 Run it as a service
```
$ sudo tee /etc/systemd/system/anuvaadmitra-proxy.service >/dev/null <<'EOF'
[Unit]
Description=AnuvaadMitra translation proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/anuvaadmitra-proxy
ExecStart=/usr/bin/node server.js
Restart=on-failure
User=www-data
EnvironmentFile=/opt/anuvaadmitra-proxy/.env

[Install]
WantedBy=multi-user.target
EOF

$ sudo systemctl daemon-reload
$ sudo systemctl enable --now anuvaadmitra-proxy
$ sudo systemctl status anuvaadmitra-proxy
```

### 1.5 Open port 8080 on the LAN
Allow inbound TCP **8080** from the C-DAC network (not the public internet). With
`ufw`, for example:
```
$ sudo ufw allow from 10.0.0.0/8 to any port 8080 proto tcp
```
(Adjust the source range to your LAN. If a separate network firewall governs the
VM, ask the network team to allow 8080 within the LAN.)

### 1.6 Verify the proxy on the VM and from another machine
On the VM:
```
$ curl http://localhost:8080/healthz
  → {"ok":true,"bhashiniConfigured":true}
```
From another PC on the LAN (replace as needed):
```
> curl http://10.248.0.55:8080/healthz
> curl -X POST http://10.248.0.55:8080/api/translate -H "Content-Type: application/json" -d "{\"engine\":\"cdac\",\"text\":\"Please attach the relevant documents.\"}"
> curl -X POST http://10.248.0.55:8080/api/translate -H "Content-Type: application/json" -d "{\"engine\":\"bhashini\",\"text\":\"Good morning.\"}"
```

**Checkpoint:** `/healthz` shows `bhashiniConfigured:true`, and both `cdac` and
`bhashini` return a translation — reachable from a second machine on the LAN.

---

## Part 2 — Build the internal test extension

On your machine, from the `extension` folder:
```
node build/make-internal-test.mjs
```
or, without Node:
```
PS> .\build\make-internal-test.ps1
```
This creates a `dist-internal/` folder: a credential-free extension pointed at
`http://10.248.0.55:8080`, named **"CDAC AnuvaadMitra (Internal Test)"** so it's
never confused with the store build. (If the IP or port differs, pass it:
`node build/make-internal-test.mjs http://10.248.0.55:8080`.)

**Checkpoint:** `dist-internal/manifest.json` shows host_permissions of the
Google host plus `http://10.248.0.55:8080/*`, and `background.js` has
`DEFAULT_PROXY_BASE = "http://10.248.0.55:8080"`.

---

## Part 3 — Load it on a tester's machine (unpacked)

Each tester:

1. Opens `chrome://extensions`.
2. Turns on **Developer mode** (top-right).
3. Clicks **Load unpacked** and selects the `dist-internal` folder.
4. Confirms the tile reads **"CDAC AnuvaadMitra (Internal Test)"**.
5. On any web page, selects English text → clicks the **अ→हि** button, and also
   tries right-click → **Translate to Hindi**. A translation card should appear.
6. Opens the popup and tries each engine — **C-DAC Pune**, **Bhashini**, and
   **Google** — confirming each returns a translation.

Share the `dist-internal` folder with testers via a network share or ZIP.

**Checkpoint:** all three engines translate on a tester's machine through the
LAN proxy.

---

## Part 4 — If translations fail: quick troubleshooting

The most likely issue is Chrome blocking the private-IP HTTP call. Check in this
order:

1. **Open the service worker console.** `chrome://extensions` → the extension →
   **service worker** (link) → Console/Network tab. Trigger a translation and
   read the error.
2. **"Failed to fetch" / blocked by Private Network Access.** The proxy already
   sends the `Access-Control-Allow-Private-Network` header to allow this, so first
   confirm you're running the current proxy build. If Chrome still blocks it, on
   the tester's machine set `chrome://flags/#block-insecure-private-network-requests`
   to **Disabled** (a testing-only workaround) and restart Chrome.
3. **`bhashiniConfigured:false` at `/healthz`.** The `.env` credentials aren't
   loaded — recheck `/opt/anuvaadmitra-proxy/.env` and restart the service.
4. **Only C-DAC Pune works, Bhashini fails.** Usually a credential problem on the
   proxy; the service-worker error will name it (e.g. "credentials rejected").
5. **Nothing reaches the VM.** Re-check the LAN firewall rule (Part 1.5) and that
   `curl http://10.248.0.55:8080/healthz` works from the tester's machine.
6. **Google works but the others don't.** Expected symptom of the proxy being
   unreachable — Google is called directly and bypasses the proxy.

> If HTTP-to-IP proves unreliable across tester machines, the robust fix is an
> internal HTTPS hostname (e.g. `anuvaadmitra.internal.cdac.in` → 10.248.0.55
> with a C-DAC internal-CA certificate). Rebuild with
> `node build/make-internal-test.mjs https://anuvaadmitra.internal.cdac.in` and
> nginx terminating TLS in front of port 8080.

---

## Part 5 — When internal testing passes: moving to public

1. Get the public endpoint from the network team: a public route to the VM, a
   public DNS name (`anuvaadmitra.cdac.in`), and a TLS certificate (see the
   follow-up already discussed).
2. Point the **public** build at it: `DEFAULT_PROXY_BASE = "https://anuvaadmitra.cdac.in"`
   in `background.public.js`, and the matching `host_permissions` in `manifest.json`.
3. Build the store package with `node build/package-extension.mjs` (not the
   internal script) and follow `DEPLOYMENT-GUIDE.md` for submission.
4. After publishing, set the proxy's `ALLOWED_ORIGINS` to the published extension
   ID and restart the service.
