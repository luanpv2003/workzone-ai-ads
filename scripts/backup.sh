#!/usr/bin/env bash
# Nightly backup: Postgres dump (kept 14 days) + uploaded files (weekly, kept 8 weeks).
# A5: set BACKUP_REMOTE to an rclone remote (e.g. "s3:my-bucket/ads-backup") so copies
# also leave this server. Run from cron on the host, inside the app folder.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
DEST="${BACKUP_DIR:-$HOME/backup/ads}"; mkdir -p "$DEST"
STAMP="$(date +%F)"
: "${DATABASE_URL:?DATABASE_URL is not set}"
pg_dump --format=custom --dbname="$DATABASE_URL" > "$DEST/db-$STAMP.dump.tmp"
mv "$DEST/db-$STAMP.dump.tmp" "$DEST/db-$STAMP.dump"
find "$DEST" -name 'db-*.dump' -mtime +14 -delete
if [ "$(date +%u)" = 7 ]; then
  tar -czf "$DEST/files-$STAMP.tgz" data/uploads data/knowledge 2>/dev/null || true
  find "$DEST" -name 'files-*.tgz' -mtime +56 -delete
fi
if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "$DEST" "$BACKUP_REMOTE" --max-age 8d
fi
