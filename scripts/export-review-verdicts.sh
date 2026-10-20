#!/bin/sh
# Export the assessor verdicts of one review sheet, all its parts, or of one batch
# (prv_review_items / prv_review_verdicts) into the private data root, as input for
# `adskip review -file`. Defaults to the local restored dump; for prod set PG* to the
# SSH tunnel (see CLAUDE.md, Ops).
# Usage: scripts/export-review-verdicts.sh <sheet|batch> [reviewer]   (e.g. 2026-10-14-clean gkshi)
# With a reviewer: only their verdicts, into <name>.<reviewer>.verdicts.tsv.
set -eu
[ $# -eq 1 ] || [ $# -eq 2 ] || { echo "usage: $0 <sheet|batch> [reviewer]" >&2; exit 2; }
BATCH=$1
REVIEWER=${2:-}
OUT="${ADSKIP_DATA:-$HOME/Web/data}/review/$BATCH${REVIEWER:+.$REVIEWER}.verdicts.tsv"
export PGPASSWORD="${PGPASSWORD:-local}"
PSQL="psql -h ${PGHOST:-localhost} -p ${PGPORT:-5433} -U ${PGUSER:-postgres} -d ${PGDATABASE:-skipper} -v ON_ERROR_STOP=1"
ITEMS=$(echo "SELECT count(*) FROM prv_review_items WHERE sheet = :'batch' OR batch = :'batch'" | $PSQL -tA -v batch="$BATCH")
[ "$ITEMS" -gt 0 ] || { echo "unknown sheet or batch $BATCH: no items in prv_review_items" >&2; exit 1; }
if [ -n "$REVIEWER" ]; then
  KNOWN=$(echo "SELECT count(*) FROM prv_review_reviewers WHERE code = :'reviewer'" | $PSQL -tA -v reviewer="$REVIEWER")
  [ "$KNOWN" -gt 0 ] || { echo "unknown reviewer $REVIEWER: not in prv_review_reviewers" >&2; exit 1; }
fi
# Write to a temp file and move it into place only on success, so a failed
# query never leaves a truncated or empty TSV behind.
mkdir -p "$(dirname "$OUT")"
TMP="$OUT.tmp"
trap 'rm -f "$TMP"' EXIT
$PSQL -q -v batch="$BATCH" -v reviewer="$REVIEWER" -v out="$TMP" -f "$(dirname "$0")/export-review-verdicts.sql"
mv "$TMP" "$OUT"
echo "wrote $OUT: $(($(wc -l < "$OUT") - 1)) verdicts of $ITEMS items"
