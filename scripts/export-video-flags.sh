#!/bin/sh
# Export the latest reviewer video flags (prv_review_video_flags) into the private
# data root. Defaults to the local restored dump; for prod set PG* to the SSH
# tunnel (see CLAUDE.md, Ops).
# Usage: scripts/export-video-flags.sh
set -eu
OUT="${ADSKIP_DATA:-$HOME/Web/data}/review/video-flags.tsv"
export PGPASSWORD="${PGPASSWORD:-local}"
PSQL="psql -h ${PGHOST:-localhost} -p ${PGPORT:-5433} -U ${PGUSER:-postgres} -d ${PGDATABASE:-skipper} -v ON_ERROR_STOP=1"
mkdir -p "$(dirname "$OUT")"
TMP="$OUT.tmp"
trap 'rm -f "$TMP"' EXIT
$PSQL -q -v out="$TMP" -f "$(dirname "$0")/export-video-flags.sql"
mv "$TMP" "$OUT"
echo "wrote $OUT: $(($(wc -l < "$OUT") - 1)) flags"
