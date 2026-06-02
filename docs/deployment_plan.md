# Deployment Plan - Remote Video Synchronizer (RVS)

## Overview

Two components need to be deployed:
1. **Signaling Server** (`server.js`) — runs on a publicly reachable host
2. **Chrome Extension** (`extension/`) — packaged and distributed to users

---

## 1. Signaling Server Deployment

### Configuration

The server reads `HOST` and `PORT` from environment variables:

```bash
# Local dev (default)
node server.js                        # → ws://127.0.0.1:8080

# Production
HOST=0.0.0.0 PORT=8080 node server.js # → ws://0.0.0.0:8080
```

### Deployment Options

| Option | Pros | Cons | Cost |
|--------|------|------|------|
| **VPS (Recommended for MVP)** — e.g. DigitalOcean Droplet, Hetzner, Linode | Full control, simple setup, persistent WebSocket support | Manual server management | ~$4-6/mo |
| **Railway / Render / Fly.io** | Zero-ops deployment, auto-TLS, free tiers available | WebSocket idle timeout limits on free tiers | Free–$7/mo |
| **AWS EC2 / GCP Compute** | Scalable, enterprise-grade | More setup overhead | ~$5-10/mo |

> [!IMPORTANT]
> **WebSocket Compatibility**: Avoid serverless platforms (AWS Lambda, Vercel Functions, Cloudflare Workers) — they don't support persistent WebSocket connections natively.

### Recommended: VPS Deployment Steps

```bash
# 1. SSH into your server
ssh user@your-server-ip

# 2. Install Node.js (if not present)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. Clone or copy the project
scp -r /home/levil/rvs user@your-server-ip:~/rvs
# OR: git clone your-repo ~/rvs

# 4. Install dependencies
cd ~/rvs && npm install --production

# 5. Run with production settings
HOST=0.0.0.0 PORT=8080 node server.js
```

### Keeping the Server Running

Use `systemd` to auto-start and auto-restart the server:

```bash
sudo tee /etc/systemd/system/rvs.service > /dev/null << 'EOF'
[Unit]
Description=Remote Video Synchronizer (RVS) Signaling Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/home/user/rvs
Environment=HOST=0.0.0.0
Environment=PORT=8080
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable rvs
sudo systemctl start rvs

# Check status
sudo systemctl status rvs
# View logs
sudo journalctl -u rvs -f
```

### TLS / WSS (Secure WebSocket)

> [!WARNING]
> Chrome extensions on HTTPS pages (YouTube, Netflix) will **block** insecure `ws://` connections. You **must** use `wss://` in production.

Use a reverse proxy (Nginx or Caddy) to terminate TLS:

**Caddy (simplest — auto-TLS via Let's Encrypt):**
```
sync.yourdomain.com {
    reverse_proxy localhost:8080
}
```

**Nginx:**
```nginx
server {
    listen 443 ssl;
    server_name sync.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/sync.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

After TLS is configured, update `extension/config.js`:
```js
const WS_SERVER_URL = 'wss://sync.yourdomain.com';
```

---

## 2. Chrome Extension Deployment

### Configuration Before Packaging

Edit [extension/config.js](file:///home/levil/rvs/extension/config.js) — this is the **only file** you need to change:

```js
// Change this to your production server URL
const WS_SERVER_URL = 'wss://sync.yourdomain.com';
```

### Distribution Options

| Option | Audience | Review Time |
|--------|----------|-------------|
| **Chrome Web Store** | Public | 1-3 business days |
| **Developer Mode (sideload)** | Private / small team | Instant |
| **Enterprise policy push** | Org-wide | Instant |

### Option A: Chrome Web Store (Public)

1. Create a [Chrome Developer account](https://chrome.google.com/webstore/devconsole) ($5 one-time fee)
2. Zip the extension directory:
   ```bash
   cd /home/levil/rvs
   zip -r rvs-extension.zip extension/
   ```
3. Upload the `.zip` to the Chrome Web Store Developer Dashboard
4. Fill in listing details (name, description, screenshots)
5. Submit for review (typically 1-3 days)

### Option B: Sideload (Private / Testing)

Share the `extension/` folder directly. Recipients:
1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder

---

## 3. Pre-Deployment Checklist

- [ ] Set `WS_SERVER_URL` in `extension/config.js` to production `wss://` URL
- [ ] Deploy server with `HOST=0.0.0.0` and configure TLS reverse proxy
- [ ] Verify `wss://` connection works from a YouTube/Netflix tab
- [ ] Test sync between two browsers on different networks
- [ ] Package extension `.zip` for distribution

---

## Quick Reference: File Changes for Deployment

| File | What to Change | Example |
|------|---------------|---------|
| `extension/config.js` | `WS_SERVER_URL` | `'wss://sync.yourdomain.com'` |
| Server env | `HOST`, `PORT` | `HOST=0.0.0.0 PORT=8080` |
