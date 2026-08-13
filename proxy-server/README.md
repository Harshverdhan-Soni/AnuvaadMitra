# AnuvaadMitra translation proxy

A small credential-holding proxy for the **CDAC AnuvaadMitra** Chrome extension.
It keeps the Bhashini (ULCA/Udyat) credentials on a C-DAC-controlled server so
they never ship inside the extension bundle. The extension calls this proxy with
a clean, credential-free JSON API.

> **Important:** this folder is a *separate server application*. Do **not** include
> `proxy-server/` in the ZIP you upload to the Chrome Web Store — package only the
> extension files (`manifest.json`, `background.js`, `content.js`, `content.css`,
> `popup.html`, `popup.js`, `icons/`).

## API

| Method & path            | Request body                              | Success response          |
|--------------------------|-------------------------------------------|---------------------------|
| `POST /api/translate`    | `{ "engine": "bhashini"\|"cdac", "text": "…" }` | `{ "translation": "…" }`  |
| `POST /api/transliterate`| `{ "text": "…", "numSuggestions": 6 }`    | `{ "candidates": ["…"] }` |
| `GET  /healthz`          | –                                         | `{ "ok": true, … }`       |

Errors return a JSON `{ "error": "…" }` body with an appropriate HTTP status.

## 1. Run locally

Requires **Node.js 18+** (uses the built-in `fetch`; no native modules).

```bash
cd proxy-server
cp .env.example .env        # then edit .env and fill in the Bhashini credentials
npm install
npm start                   # listens on http://localhost:8080
```

Smoke test:

```bash
curl http://localhost:8080/healthz
curl -X POST http://localhost:8080/api/translate \
  -H "Content-Type: application/json" \
  -d '{"engine":"cdac","text":"Please attach the relevant documents."}'
```

## 2. Configuration (environment variables)

| Variable              | Required | Default                         | Purpose                                             |
|-----------------------|----------|---------------------------------|-----------------------------------------------------|
| `BHASHINI_USER_ID`    | yes*     | –                               | Bhashini/Udyat User ID (App ID)                     |
| `BHASHINI_ULCA_KEY`   | yes*     | –                               | Bhashini/Udyat Key                                  |
| `MEITY_PIPELINE_ID`   | no       | `64392f96daac500b55c543cd`      | MeitY pipeline id                                   |
| `CDAC_PUNE_URL`       | no       | `https://nlpsangraha.ebhasha.in/getTranslation` | C-DAC Pune endpoint                 |
| `PORT`                | no       | `8080`                          | Listen port                                         |
| `ALLOWED_ORIGINS`     | no       | `*`                             | Comma-separated allowed browser origins (lock this) |
| `RATE_LIMIT_WINDOW_MS`| no       | `60000`                         | Rate-limit window                                   |
| `RATE_LIMIT_MAX`      | no       | `120`                           | Max requests per IP per window                      |
| `MAX_TEXT_LENGTH`     | no       | `5000`                          | Max input characters                                |

\* Bhashini + transliteration require these. The `cdac` engine works without them.

**Lock CORS before production.** Once the extension is published, Chrome assigns
it a fixed 32-character ID. Set:

```
ALLOWED_ORIGINS=chrome-extension://<your-32-char-extension-id>
```

so only your extension can call the proxy.

## 3. Deploy on a C-DAC server (systemd + nginx + HTTPS)

This is the recommended production setup on a C-DAC Linux box.

### a) Place the app and install deps

```bash
sudo mkdir -p /opt/anuvaadmitra-proxy
sudo cp server.js package.json /opt/anuvaadmitra-proxy/
cd /opt/anuvaadmitra-proxy
sudo npm install --omit=dev
```

### b) Create the environment file (root-only readable)

```bash
sudo tee /opt/anuvaadmitra-proxy/.env >/dev/null <<'EOF'
BHASHINI_USER_ID=xxxxxxxxxxxxxxxx
BHASHINI_ULCA_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ALLOWED_ORIGINS=chrome-extension://<your-extension-id>
PORT=8080
EOF
sudo chmod 600 /opt/anuvaadmitra-proxy/.env
```

### c) systemd service

```bash
sudo tee /etc/systemd/system/anuvaadmitra-proxy.service >/dev/null <<'EOF'
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

sudo systemctl daemon-reload
sudo systemctl enable --now anuvaadmitra-proxy
sudo systemctl status anuvaadmitra-proxy
```

### d) nginx reverse proxy with HTTPS

Point a hostname (for example `anuvaadmitra.cdac.in`) at the box, then:

```nginx
server {
    listen 443 ssl;
    server_name anuvaadmitra.cdac.in;

    ssl_certificate     /etc/ssl/certs/anuvaadmitra.crt;   # or use certbot / Let's Encrypt
    ssl_certificate_key /etc/ssl/private/anuvaadmitra.key;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

Reload nginx and verify:

```bash
sudo nginx -t && sudo systemctl reload nginx
curl https://anuvaadmitra.cdac.in/healthz
```

### Alternative: Docker

```bash
docker build -t anuvaadmitra-proxy .
docker run -d --name anuvaadmitra-proxy \
  --env-file .env -p 8080:8080 --restart unless-stopped \
  anuvaadmitra-proxy
```

## 4. Point the extension at the deployed proxy

In the extension, the proxy host appears in **two** places that must match:

1. `background.js` → `const DEFAULT_PROXY_BASE = "https://anuvaadmitra.cdac.in";`
2. `manifest.json` → `host_permissions` entry `"https://anuvaadmitra.cdac.in/*"`

Replace both with your real HTTPS host, then reload the extension. (End users can
also override the server URL under the popup's *Advanced: translation server*
section, but the default should point at the production proxy.)

## Security notes

- Credentials live only in `.env` / the environment — never in the extension and
  never in the container image.
- Keep `.env` out of source control (see `.dockerignore`; add a `.gitignore` too).
- Serve only over HTTPS and lock `ALLOWED_ORIGINS` to the published extension ID.
- The built-in per-IP rate limit protects the Bhashini quota; tune it to your
  expected traffic. For multi-instance deployments, move rate limiting to nginx
  or a shared store since the built-in limiter is per-process.
