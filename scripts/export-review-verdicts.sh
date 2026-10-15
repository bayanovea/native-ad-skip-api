#!/bin/sh
# Export the assessor verdicts of one review batch (prv_review_items / prv_review_verdicts)
# from the local restored dump into the private data root, as input for `adskip review -file`.
# Usage: scripts/export-review-verdicts.sh <batch>   (e.g. 2026-10-14-clean)
set -eu
[ $# -eq 1 ] || { echo "usage: $0 <batch>" >&2; exit 2; }
BATCH=$1
OUT="${ADSKIP_DATA:-$HOME/Web/data}/review/$BATCH.verdicts.tsv"
export PGPASSWORD="${PGPASSWORD:-local}"
PSQL="psql -h ${PGHOST:-localhost} -p ${PGPORT:-5433} -U ${PGUSER:-postgres} -d ${PGDATABASE:-skipper} -v ON_ERROR_STOP=1"
ITEMS=$(echo "SELECT count(*) FROM prv_review_items WHERE batch = :'batch'" | $PSQL -tA -v batch="$BATCH")
[ "$ITEMS" -gt 0 ] || { echo "unknown batch $BATCH: no items in prv_review_items" >&2; exit 1; }
# Write to a temp file and move it into place only on success, so a failed
# query never leaves a truncated or empty TSV behind.
mkdir -p "$(dirname "$OUT")"
TMP="$OUT.tmp"
trap 'rm -f "$TMP"' EXIT
$PSQL -q -v batch="$BATCH" -v out="$TMP" -f "$(dirname "$0")/export-review-verdicts.sql"
mv "$TMP" "$OUT"
echo "wrote $OUT: $(($(wc -l < "$OUT") - 1)) verdicts of $ITEMS items"
