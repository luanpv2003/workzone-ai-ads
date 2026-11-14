# Install Workzone AI Ads

Workzone AI Ads is software you run yourself. There is no hosted version: you download it, run one command, and use it in your browser. Your data stays on your machine.

You can run it in two places:

- **On your computer** (Mac, Linux, or Windows with WSL). Good for one person or trying it out. The app works while the computer is on.
- **On your server** (any Linux VPS). Good for a team, and needed if you want it running 24/7, reachable from anywhere, with HTTPS. Install it the same way, then follow [server.md](server.md).

Contents: [Requirements](#requirements) · [Install](#install) · [First login](#first-login) · [Update](#update) · [Backups](#backups) · [Stop and uninstall](#stop-and-uninstall) · [Without Docker](#without-docker) · [Troubleshooting](#troubleshooting)

## Requirements

| | On your computer | On your server |
|---|---|---|
| System | macOS 12+, Linux, or Windows 10/11 with WSL 2 | Linux (Ubuntu 22.04/24.04, Debian 12 or similar) |
| Docker | [Docker Desktop](https://docs.docker.com/desktop/) | [Docker Engine](https://docs.docker.com/engine/install/) with the Compose plugin |
| Memory | 4 GB free | 2 GB minimum, 4 GB recommended |
| Disk | 5 GB free | 10 GB free |
| Other | `git` | `git`, a domain name if you want HTTPS |

Check Docker works before you start:

```bash
docker compose version     # should print "Docker Compose version v2…"
```

On Windows: install Docker Desktop, turn on **Settings → Resources → WSL integration** for your Ubuntu distribution, then run every command below inside the Ubuntu (WSL) terminal, with the repository cloned inside WSL (for example `~/workzone-ai-ads`, not `/mnt/c/...`, which is much slower). PowerShell and `cmd` are not supported by the install script.

## Install

```bash
git clone https://github.com/workzone-vn/workzone-ai-ads.git     # the address of this repository (or download the ZIP and unpack it)
cd workzone-ai-ads
./scripts/install.sh
```

The script:

1. Checks that Docker is installed and running.
2. Creates `.env` from `.env.example` with a random `ENCRYPTION_KEY` and database password.
3. Asks two questions: your name or company (shown on the privacy pages, press Enter to skip) and the port (press Enter for 3000).
4. Builds and starts everything with `docker compose up -d --build`. The first build takes 2 to 10 minutes depending on your machine and connection.
5. Sets `COOKIE_SECURE` to match the address: `"false"` for a plain `http://` address, `"true"` for `https://`. Login cookies marked HTTPS-only are never kept over plain http, so a mismatch means nobody stays logged in.
6. Waits until the app answers, then prints the address, for example `http://localhost:3000`.

What runs (see `docker-compose.yml`):

| Service | What it does |
|---|---|
| `db` | PostgreSQL 16. Data in the Docker volume `workzone-ai-ads_db`. Not reachable from outside Docker. |
| `app` | The web app. Applies database migrations each time it starts. |
| `worker` | Background work: client jobs (sync, AI analysis, campaign drafts), new messages every 2 minutes, ad metrics every 15 minutes, follow-ups, lead notifications, report schedules, targeting library scans. |
| `scheduler` | The hourly schedule: full syncs and AI analysis on each client's schedule, campaign optimisation, automation rules, token checks, Google Ads sync. |

Uploaded images and Knowledge base documents are kept in the Docker volume `workzone-ai-ads_appdata`.

No questions (scripts, provisioning tools):

```bash
./scripts/install.sh --name "Acme Agency" --port 3000 --yes
# or with environment variables
WZ_OPERATOR_NAME="Acme Agency" WZ_PORT=3000 ./scripts/install.sh --yes
```

`./scripts/install.sh --help` lists every option.

## First login

Open the address the script printed. The first time, the app asks you to **create your admin account** (email, name, password). That account owns the installation: it can add clients, invite people and change system settings.

[Screenshot: the "Create your admin account" page]

Then:

1. Connect Meta for your first client: [meta.md](meta.md).
2. Using Google Ads too: [google.md](google.md).
3. Choose how AI works (built-in key, or your own Claude / ChatGPT): [ai.md](ai.md).
4. On a server: set up your domain and HTTPS: [server.md](server.md).

Forgot the admin password? Reset it from the terminal (the password is typed hidden):

```bash
docker compose exec worker tsx scripts/add-user.ts you@example.com "Your Name" --admin
```

## Update

```bash
cd workzone-ai-ads
git pull
./scripts/install.sh
```

The same command updates: it keeps your `.env`, rebuilds, restarts, and the app applies any new database migrations on start. Running jobs are put back in the queue and continue after the restart.

Take a backup first if the update notes mention database changes.

## Prebuilt images

Each release is also published as Docker images, so you can skip the build (useful on small servers). In `.env` set:

```bash
WZ_IMAGE="ghcr.io/workzone-vn/workzone-ai-ads"
WZ_TAG="latest"   # or a release, e.g. "v0.1.0"
```

and run `./scripts/install.sh` as usual: it downloads the images instead of building. Prebuilt images carry the default app name; to show your own `NEXT_PUBLIC_*` names, leave `WZ_IMAGE` empty and build.

## Backups

What to keep safe:

- the **database** (clients, conversations, leads, settings),
- **uploaded files** (creatives, Knowledge base documents),
- the **`.env` file**. It holds `ENCRYPTION_KEY`; without it, saved Meta and Google tokens cannot be read after a restore.

### Docker install

```bash
./scripts/backup-docker.sh
```

writes to `./backup/` (change with `BACKUP_DIR`):

- `db-YYYY-MM-DD.dump` database, kept 14 days
- `files-YYYY-MM-DD.tgz` uploads and Knowledge base, kept 8 weeks
- `env-YYYY-MM-DD` a copy of `.env`, kept 8 weeks

Run it every night:

- **On your computer:** run it by hand now and then, or add the cron line below (macOS: `crontab -e` works too). Copy the `backup` folder to another disk or cloud drive.
- **On your server:** add a cron line (`crontab -e`), and set `BACKUP_REMOTE` in `.env` to an [rclone](https://rclone.org/) remote (for example `s3:my-bucket/ads-backup`) so a copy leaves the server:

```cron
30 2 * * * cd /home/you/workzone-ai-ads && ./scripts/backup-docker.sh >> backup/backup.log 2>&1
```

Restore (on the same or a new machine, after `./scripts/install.sh`):

```bash
cp backup/env-YYYY-MM-DD .env                 # same ENCRYPTION_KEY and settings
./scripts/install.sh                          # start with that .env
docker compose stop worker scheduler
docker compose exec -T db pg_restore -U ads -d ads --clean --if-exists < backup/db-YYYY-MM-DD.dump
docker compose exec -T app tar -xzf - -C /app < backup/files-YYYY-MM-DD.tgz
docker compose restart app worker scheduler
```

If you restore onto a new machine, `.env` must be copied **before** the first `./scripts/install.sh`, because the database password is set when the database volume is created.

### Without Docker

`scripts/backup.sh` does the same with `pg_dump` on the host: it reads `DATABASE_URL`, writes to `BACKUP_DIR` (default `~/backup/ads`) and uses `BACKUP_REMOTE` if set. Run it from cron inside the app folder:

```cron
30 2 * * * cd /home/you/workzone-ai-ads && set -a && . ./.env && set +a && ./scripts/backup.sh
```

## Stop and uninstall

```bash
docker compose stop          # pause everything; start again with: docker compose start
docker compose down          # stop and remove the containers; data stays in the volumes
./scripts/install.sh         # start again later
```

Remove everything, **including all data** (take a backup first):

```bash
docker compose --profile https down -v --rmi local    # containers, volumes (database, uploads) and the built images
cd .. && rm -rf workzone-ai-ads
```

## Without Docker

For developers, or a server where you prefer to manage Node yourself. Requirements: Node.js 22+, PostgreSQL 16+.

```bash
createdb ads
cp .env.example .env        # set DATABASE_URL, ENCRYPTION_KEY (openssl rand -hex 32), PUBLIC_URL
npm ci
npm run setup               # apply database migrations
npm run build
npm start                   # web app on http://localhost:3000 (-p to change the port)
npm run targeting:worker    # background worker, in a second terminal
```

Then create the admin account in the browser (or `npm run user:add -- you@example.com "Your Name" --admin`), and run the hourly schedule from cron:

```cron
5 * * * * cd /home/you/workzone-ai-ads && npm run daily >> logs/daily.log 2>&1
```

Keep the app and the worker running with the process manager you already use (systemd, pm2). To run the built-in AI on a Claude subscription, install Claude Code on the same machine (see [ai.md](ai.md)).

For development: `npm run dev`, and `npm run seed` loads sample clients to click around.

## Troubleshooting

| Problem | What to do |
|---|---|
| `Docker is installed but not running` | Start Docker Desktop (or `sudo systemctl start docker`), run the script again. |
| `Port 3000 is already used` | Run `./scripts/install.sh --port 3010` on first install, or change `APP_PORT` and `PUBLIC_URL` in `.env`, then run the script again. |
| The app does not answer | `docker compose ps` then `docker compose logs app`. A database error usually means `.env` was changed after the database was created (see Restore above). |
| Background work does not move | `docker compose ps` should show `worker` and `scheduler` as `Up`; then `docker compose logs -f worker`. |
| Build fails with "killed" or out of memory | Give Docker more memory (Docker Desktop → Settings → Resources), or add swap on a small server ([server.md](server.md)). |
| The login or the first-run setup page keeps coming back (you are not kept logged in) | `COOKIE_SECURE` does not match `PUBLIC_URL`. Plain `http://` address (localhost or a LAN IP like `http://192.168.1.20:3000`): `COOKIE_SECURE="false"`. `https://` address: `COOKIE_SECURE="true"`. Fix `.env`, run `./scripts/install.sh` again. |
| You can log in on `localhost` but not from another device on your network | Expected: the app only listens on this computer by default. See "Use it from other devices on your network" in [server.md](server.md). |
