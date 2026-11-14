#!/usr/bin/env bash
# Backup for the Docker install (scripts/install.sh). Non-Docker installs use scripts/backup.sh.
#   ./scripts/backup-docker.sh            database dump (kept 14 days) + uploaded files (kept 8 weeks) + a copy of .env
# Settings (environment or .env): BACKUP_DIR (default ./backup), BACKUP_REMOTE (rclone remote for an off-machine copy).
# Restore: see docs/install.md "Backups".
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

val() { [ -f .env ] && awk -v k="$1" 'index($0, k"=")==1 { v=substr($0, length(k)+2); gsub(/^"|"$/, "", v); print v; exit }' .env; }
DEST="${BACKUP_DIR:-$(val BACKUP_DIR)}"; DEST="${DEST:-backup}"
REMOTE="${BACKUP_REMOTE:-$(val BACKUP_REMOTE)}"
mkdir -p "$DEST"
STAMP="$(date +%F)"

docker compose exec -T db pg_dump -U ads --format=custom ads > "$DEST/db-$STAMP.dump.tmp"
mv "$DEST/db-$STAMP.dump.tmp" "$DEST/db-$STAMP.dump"
# Uploaded creatives + Knowledge base documents (message images are a cache and are skipped).
docker compose exec -T app tar -czf - -C /app data/uploads data/knowledge > "$DEST/files-$STAMP.tgz.tmp"
mv "$DEST/files-$STAMP.tgz.tmp" "$DEST/files-$STAMP.tgz"
# ENCRYPTION_KEY lives in .env: without it, saved Meta / Google tokens cannot be read after a restore.
cp .env "$DEST/env-$STAMP"

find "$DEST" -name 'db-*.dump' -mtime +14 -delete
find "$DEST" \( -name 'files-*.tgz' -o -name 'env-*' \) -mtime +56 -delete
if [ -n "$REMOTE" ]; then
  rclone copy "$DEST" "$REMOTE" --max-age 8d
fi
echo "Backup written to $DEST: db-$STAMP.dump, files-$STAMP.tgz, env-$STAMP"
