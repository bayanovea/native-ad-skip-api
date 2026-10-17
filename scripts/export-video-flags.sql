-- Latest value of every reviewer video flag (prv_review_video_flags), as a TSV
-- for the eval repo (timing-clean slices, drift-audit ground truth) and the
-- product (no auto-skip on a flagged video).
-- Columns: provider, native_id, flag, value, reviewer, set_at.
-- Usage (see scripts/export-video-flags.sh):
--   psql ... -v out=/abs/path/video-flags.tsv -f scripts/export-video-flags.sql
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

\o :out
SELECT line
FROM (
  SELECT 0 AS ord, '' AS native_id, '' AS flag,
         concat_ws(E'\t', 'provider', 'native_id', 'flag', 'value', 'reviewer', 'set_at') AS line
  UNION ALL
  SELECT 1, f.native_id, f.flag,
         concat_ws(E'\t', 'prv', f.native_id, f.flag, f.value::text, f.reviewer, to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
  FROM (
    SELECT DISTINCT ON (native_id, flag) native_id, flag, value, reviewer, created_at
    FROM prv_review_video_flags
    ORDER BY native_id, flag, created_at DESC, id DESC
  ) f
) r
ORDER BY ord, native_id, flag;
\o
