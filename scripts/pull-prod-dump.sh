#!/usr/bin/env bash
# Pull a gzipped pg_dump of prod to this machine. Interim off-host backup until
# the nightly S3 job lands (docs/backlog/offhost-pg-backup-s3.md). Run: make pull-dump
set -euo pipefail

HOST="${PROD_HOST:-root@${HOST_IP}}"
DB_NAME="${DB_NAME:-adskip}"
DIR="${DUMP_DIR:-$HOME/Web/dumps/adskip-prod}"

mkdir -p "$DIR"
FILE="$DIR/$DB_NAME-$(date +%F).sql.gz"
trap 'rm -f "$FILE.tmp"' EXIT

# --no-owner: restores cleanly as any role (prod objects are owned by the app role)
ssh "$HOST" "runuser -u postgres -- pg_dump --no-owner --no-privileges $DB_NAME | gzip" > "$FILE.tmp"
gzip -t "$FILE.tmp"
# grep -c reads the whole stream; grep -q would SIGPIPE gunzip and trip pipefail
[ "$(gunzip -c "$FILE.tmp" | grep -c '^CREATE TABLE public.markups ')" = 1 ] || { echo "dump has no markups table" >&2; exit 1; }
mv "$FILE.tmp" "$FILE"
ln -sf "$(basename "$FILE")" "$DIR/latest.sql.gz"

echo "ok $FILE $(du -h "$FILE" | cut -f1)"
