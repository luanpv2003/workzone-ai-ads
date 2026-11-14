# Run it on your server

Install it first as in [install.md](install.md). This page covers what changes on a server: a domain with HTTPS, `PUBLIC_URL`, the firewall, and keeping it running 24/7.

Why a server: Meta webhooks, Claude.ai / Claude Desktop custom connectors and ChatGPT all call your installation from the internet, so they need a public `https://` address. A server also keeps background work (message sync, scheduled reports, lead notifications) running when your laptop is closed.

Contents: [Domain and HTTPS](#domain-and-https) · [PUBLIC_URL](#public_url) · [Firewall](#firewall) · [Running 24/7](#running-247) · [Other devices on your network](#use-it-from-other-devices-on-your-network) · [Small servers](#small-servers)

## Domain and HTTPS

### 1. Point a domain at the server

At your DNS provider, add an **A record** (and **AAAA** if the server has IPv6) for the name you want, for example `ads.example.com`, pointing to the server's IP address. Wait until `ping ads.example.com` shows that IP.

If the domain is on Cloudflare, set the record to **DNS only** (grey cloud) for the first start, so the certificate can be issued. You can switch the proxy on afterwards with SSL mode **Full (strict)**.

### 2a. Built-in HTTPS (recommended)

The compose file includes [Caddy](https://caddyserver.com/), which gets and renews a free Let's Encrypt certificate on its own. Ports 80 and 443 must be free (no nginx or Apache already running).

```bash
./scripts/install.sh --domain ads.example.com
```

This sets in `.env`:

```dotenv
DOMAIN="ads.example.com"
PUBLIC_URL="https://ads.example.com"
COOKIE_SECURE="true"
```

and starts the stack with the `https` profile (`docker compose --profile https up -d`). Later runs of `./scripts/install.sh` keep using it. Open `https://ads.example.com`; the first visit can take a minute while the certificate is issued (`docker compose logs caddy` shows progress).

### 2b. Your own reverse proxy

If the server already runs nginx, Caddy or Traefik, leave `DOMAIN` empty and point your proxy at the app, which listens on `127.0.0.1:3000` (`APP_PORT`). Set in `.env`:

```dotenv
PUBLIC_URL="https://ads.example.com"
COOKIE_SECURE="true"
```

then run `./scripts/install.sh` again. `COOKIE_SECURE` must follow `PUBLIC_URL`: `"true"` for `https://`, `"false"` for a plain `http://` address, otherwise nobody stays logged in (the first-run setup page included).

Caddy (`/etc/caddy/Caddyfile`):

```caddy
ads.example.com {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Real-IP {remote_host}
    }
}
```

nginx (certificate from certbot):

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name ads.example.com;
    ssl_certificate     /etc/letsencrypt/live/ads.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ads.example.com/privkey.pem;

    client_max_body_size 32m;          # creative images and documents up to 31 MB

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;        # AI tasks can take a while
    }
}
server {
    listen 80;
    server_name ads.example.com;
    return 301 https://$host$request_uri;
}
```

Keep the `Host` header: forms in the app check that requests come from the same address. Behind Caddy or nginx set `TRUST_PROXY="true"` in `.env` so the login rate limit can count per client IP (only when the proxy sets `X-Real-IP`; never when the app port is reachable directly).

## PUBLIC_URL

`PUBLIC_URL` in `.env` is the address everyone else uses to reach this installation, without a trailing slash. It is used for:

- links in lead notifications and reports,
- the Meta webhook callback: `PUBLIC_URL/api/meta/webhook` ([meta.md](meta.md)),
- the MCP endpoint for your own AI: `PUBLIC_URL/api/mcp` ([ai.md](ai.md)),
- OAuth sign-in for Claude and ChatGPT connectors.

After changing it, run `./scripts/install.sh` again (or `docker compose up -d`). If you change the domain later, update the webhook in your Meta app and reconnect your AI connectors.

## Firewall

Only SSH and the web ports need to be open. The database and the app's port 3000 are not exposed (the app listens on `127.0.0.1` only).

Ubuntu / Debian with `ufw`:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp     # HTTP/3, optional
sudo ufw enable
```

Also open 80 and 443 in your cloud provider's firewall / security group if it has one.

Note: ports published by Docker bypass `ufw` rules. That is why the app is bound to `127.0.0.1` by default; do not set `APP_BIND="0.0.0.0"` on a public server.

## Running 24/7

- Every service has `restart: unless-stopped`: they come back after a crash or a reboot, as long as Docker itself starts at boot:

  ```bash
  sudo systemctl enable docker
  ```

- Check what is running: `docker compose ps`. Follow logs: `docker compose logs -f app worker scheduler`.
- Logs are kept by Docker. To cap their size, add to `/etc/docker/daemon.json` and restart Docker:

  ```json
  { "log-driver": "local", "log-opts": { "max-size": "20m", "max-file": "5" } }
  ```

- Nightly backups with an off-server copy: see [install.md → Backups](install.md#backups).
- Updates: `git pull && ./scripts/install.sh`.

On your computer instead of a server: the app only works while the computer is awake and Docker Desktop is running. Turn on Docker Desktop → **Settings → General → Start Docker Desktop when you sign in**, and stop the computer from sleeping if you want messages and reports processed overnight.

### More capacity

With many clients, background jobs can queue. Raise `WORKER_CONCURRENCY` in `.env` (default 3) and run `./scripts/install.sh` again.

## Use it from other devices on your network

On your computer the app listens on `127.0.0.1`, so only that computer can open it. To open it from a phone or another computer in the same office, set in `.env` (use your computer's local IP):

```dotenv
APP_BIND="0.0.0.0"
PUBLIC_URL="http://192.168.1.20:3000"
COOKIE_SECURE="false"
```

and run `./scripts/install.sh` again. `COOKIE_SECURE="false"` is needed because the connection is plain http. Do this only on a network you trust; for anything else use a server with HTTPS.

## Small servers

Building the image needs about 2 GB of memory. On a 1 to 2 GB server, add swap before the first install:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```
