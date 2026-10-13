#!/usr/bin/env bash
# Nightly pg_dump → Timeweb S3. Installed at /usr/local/bin/pg-backup.sh, run from root's crontab.
# Setup, schedule and restore drill: infrastructure/backup/README.md
set -euo pipefail

DB_NAME="${DB_NAME:?DB_NAME is required}"
BUCKET="${BUCKET:-adskip-backups}"
DIR=/var/backups/pg
KEEP_DAYS=3

cd /
mkdir -p "$DIR"
chmod 700 "$DIR"
FILE="$DIR/$DB_NAME-$(date +%F).sql.gz"
trap 'rm -f "$FILE.tmp"' EXIT

# peer auth as the postgres superuser — no password on disk
runuser -u postgres -- pg_dump "$DB_NAME" | gzip > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
s3cmd put --no-progress "$FILE" "s3://$BUCKET/"
find "$DIR" -name '*.sql.gz' -mtime +"$KEEP_DAYS" -delete

echo "$(date -Is) ok $FILE $(du -h "$FILE" | cut -f1)"
