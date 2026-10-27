#!/bin/sh
# Export gold v1 from the local restored dump into the private data root.
# Secrets (salt, assessor ids) live in ~/.config/native-ad-skip-eval, never in the repo.
set -eu
CFG="$HOME/.config/native-ad-skip-eval"
OUT="${ADSKIP_DATA:-$HOME/Web/data}/gold-v1.jsonl"
SALT=$(cat "$CFG/salt")
ASSESSORS=$(sed "s/.*/'&'/" "$CFG/assessors" | paste -sd, -)
PGPASSWORD="${PGPASSWORD:-local}" psql -h "${PGHOST:-localhost}" -p "${PGPORT:-5433}" -U "${PGUSER:-postgres}" -d "${PGDATABASE:-skipper}" \
  -v salt="'$SALT'" -v assessors="$ASSESSORS" -v out="$OUT" -f "$(dirname "$0")/export-gold.sql"
echo "wrote $OUT: $(wc -l < "$OUT") lines"
