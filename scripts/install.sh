#!/usr/bin/env bash
# Workzone AI Ads: one-command install and update (macOS / Linux, needs Docker).
#
#   ./scripts/install.sh                         first install: asks 2 questions, builds, starts
#   ./scripts/install.sh                         later: same command updates (after `git pull`)
#   ./scripts/install.sh --name "Acme" --port 3000 --yes     no questions (scripts, CI)
#   ./scripts/install.sh --domain ads.example.com            server with HTTPS (built-in Caddy)
#
# Options (each also readable from an environment variable):
#   --name NAME      your name or company, shown on the privacy pages     (WZ_OPERATOR_NAME)
#   --port PORT      port on this machine, default 3000                    (WZ_PORT)
#   --domain DOMAIN  serve https://DOMAIN through Caddy on ports 80/443    (WZ_DOMAIN)
#   --yes            never ask, use the values given or the defaults       (WZ_YES=1)
#   --no-wait        do not wait for the app to answer
#
# Safe to run again: an existing .env is never replaced, and keys already set are never changed.
set -euo pipefail

cd "$(dirname "$0")/.."

NAME="${WZ_OPERATOR_NAME-}"
PORT="${WZ_PORT-}"
DOMAIN_ARG="${WZ_DOMAIN-}"
YES="${WZ_YES:-0}"
WAIT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2-}"; shift 2 ;;
    --port) PORT="${2-}"; shift 2 ;;
    --domain) DOMAIN_ARG="${2-}"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    --no-wait) WAIT=0; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done
# No terminal to answer from (piped, CI): behave like --yes.
[ -t 0 ] || YES=1

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------ 1. Docker
command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install Docker Desktop (macOS / Windows) or Docker Engine (Linux): https://docs.docker.com/get-docker/ then run this again."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is missing (the 'docker compose' command). Update Docker, then run this again."
docker info >/dev/null 2>&1 || fail "Docker is installed but not running. Start Docker Desktop (or 'sudo systemctl start docker'), then run this again."

# ------------------------------------------------------------ helpers for .env
get_env() { # value of KEY in .env, without quotes ("" if missing)
  awk -v k="$1" 'index($0, k"=")==1 { v=substr($0, length(k)+2); gsub(/^["'\'']|["'\'']$/, "", v); print v; exit }' .env
}
set_env() { # set KEY="VALUE" in .env (replace the line or append it)
  local tmp; tmp="$(mktemp)"
  K="$1" V="$2" awk 'BEGIN { k=ENVIRON["K"]; line=k "=\"" ENVIRON["V"] "\"" }
    index($0, k"=")==1 { if (!done) print line; done=1; next } { print }
    END { if (!done) print line }' .env > "$tmp"
  cat "$tmp" > .env && rm -f "$tmp"
}
random_hex() { # n bytes of randomness as hex
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"; else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }
ask() { # ask "Question" default -> answer (default when --yes)
  local a=""
  if [ "$YES" = 1 ]; then printf '%s' "$2"; return; fi
  read -r -p "$1 " a </dev/tty || true
  printf '%s' "${a:-$2}"
}

# ------------------------------------------------------------ 2. .env (created once, never replaced)
if [ ! -f .env ]; then
  bold "First install: creating .env"
  [ -f .env.example ] || fail ".env.example is missing. Run this from a full copy of the repository."
  cp .env.example .env
  chmod 600 .env

  if [ -z "$NAME" ]; then
    NAME="$(ask "Your name or company, shown on the privacy pages (Enter to skip):" "")"
  fi
  NAME="$(printf '%s' "$NAME" | tr -d '"\\`$')"
  [ -n "$NAME" ] && set_env NEXT_PUBLIC_OPERATOR_NAME "$NAME"

  if [ -z "$DOMAIN_ARG" ]; then
    if [ -z "$PORT" ]; then PORT="$(ask "Port to open the app on this machine [3000]:" "3000")"; fi
    case "$PORT" in ''|*[!0-9]*) fail "Port must be a number, got '$PORT'." ;; esac
    while port_busy "$PORT"; do
      [ "$YES" = 1 ] && { rm -f .env; fail "Port $PORT is already used by another program. Run again with --port <another port>."; }
      PORT="$(ask "Port $PORT is already in use. Another port:" "$((PORT + 1))")"
    done
    set_env APP_PORT "$PORT"
    set_env PUBLIC_URL "http://localhost:$PORT"
  fi
fi

# Fill in what is missing (also for a .env made by hand or by an older version). Existing values are kept.
[ -n "$(get_env POSTGRES_PASSWORD)" ] || set_env POSTGRES_PASSWORD "$(random_hex 24)"
if [ -z "$(get_env ENCRYPTION_KEY)" ]; then
  set_env ENCRYPTION_KEY "$(random_hex 32)"
  echo "Generated a new ENCRYPTION_KEY in .env. Keep a copy of .env with your backups."
fi
if [ -n "$DOMAIN_ARG" ]; then
  set_env DOMAIN "$DOMAIN_ARG"
  set_env PUBLIC_URL "https://$DOMAIN_ARG"
  set_env COOKIE_SECURE "true"
  set_env TRUST_PROXY "true" # the bundled Caddy sets X-Real-IP (login rate limit per client IP)
fi

# Login cookies must match the address: HTTPS-only cookies are never kept over plain http (LAN IP, Safari on localhost).
if [ -z "$(get_env COOKIE_SECURE)" ]; then
  case "$(get_env PUBLIC_URL)" in https://*) set_env COOKIE_SECURE "true" ;; *) set_env COOKIE_SECURE "false" ;; esac
fi
case "$(get_env PUBLIC_URL)|$(get_env COOKIE_SECURE)" in
  http://*\|true) echo "Warning: PUBLIC_URL is http:// but COOKIE_SECURE=\"true\": logins will not stick. Set COOKIE_SECURE=\"false\" in .env." ;;
  https://*\|false) echo "Note: PUBLIC_URL is https://; set COOKIE_SECURE=\"true\" in .env for HTTPS-only login cookies." ;;
esac

PORT="$(get_env APP_PORT)"; PORT="${PORT:-3000}"
DOMAIN="$(get_env DOMAIN)"
PUBLIC_URL="$(get_env PUBLIC_URL)"

# ------------------------------------------------------------ 3. Build and start
PROFILE_ARGS=()
[ -n "$DOMAIN" ] && PROFILE_ARGS=(--profile https)
if [ -n "$(get_env WZ_IMAGE)" ]; then
  # Prebuilt images (WZ_IMAGE in .env): download instead of building. They carry the default app name.
  bold "Downloading the prebuilt images ($(get_env WZ_IMAGE), tag $(get_env WZ_TAG))…"
  docker compose "${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"}" pull app worker scheduler
  docker compose "${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"}" up -d --no-build --remove-orphans
else
  bold "Building and starting (the first build takes a few minutes)…"
  docker compose "${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"}" up -d --build --remove-orphans
fi

# ------------------------------------------------------------ 4. Wait until the app answers
LOCAL_URL="http://localhost:$PORT"
if [ "$WAIT" = 1 ]; then
  printf 'Waiting for the app to answer'
  ok=0
  for _ in $(seq 1 90); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$LOCAL_URL/login" 2>/dev/null || true)"
    case "$code" in 2*|3*) ok=1; break ;; esac
    printf '.'; sleep 2
  done
  echo
  if [ "$ok" != 1 ]; then
    docker compose ps
    fail "The app did not answer on $LOCAL_URL after 3 minutes. See what went wrong with: docker compose logs app"
  fi
fi

echo
bold "Workzone AI Ads is running."
if [ -n "$DOMAIN" ]; then
  echo "  Open:  https://$DOMAIN   (the certificate can take a minute the first time)"
else
  echo "  Open:  $LOCAL_URL"
fi
# An empty database sends /login to the first-run /setup page.
case "$(curl -s -o /dev/null -w '%{redirect_url}' "$LOCAL_URL/login" 2>/dev/null || true)" in
  */setup*) echo "  Open it and create your admin account." ;;
esac
[ -n "$PUBLIC_URL" ] && [ -z "$DOMAIN" ] && [ "$PUBLIC_URL" != "$LOCAL_URL" ] && echo "  PUBLIC_URL in .env: $PUBLIC_URL"
echo
echo "  Status:  docker compose ps        Logs:  docker compose logs -f app worker"
echo "  Update:  git pull && ./scripts/install.sh"
echo "  Stop:    docker compose down      (your data stays in Docker volumes)"
echo "  Next:    connect Meta (docs/meta.md) and your AI (docs/ai.md)"
