-- Assessor verdicts of one review sheet (all its parts) or one batch as an `adskip review -file` TSV
-- (native-ad-skip-eval, internal/score/review.go).
-- Columns: provider, native_id, category, start, end, verdict, item, note.
-- :batch names a sheet or a batch (sheet IS NULL on rows of an older image: their sheet is their batch).
-- One row per decided item (latest verdict wins), ordered by position; open items are skipped.
-- A non-empty :reviewer narrows to that reviewer's verdicts (their latest per item).
-- start / end of a gold_missing row are the item's effective bounds: those of the latest verdict (of :reviewer,
-- when given) that carries bounds (an assessor's correction), else the item's own. The other rows judge the
-- stretch the model proposed, so they keep the item's bounds.
--
--   sponsor / self_promotion -> gold_missing,       category = the verdict
--   not_ad                   -> model_wrong,        category = first proposed category
--   unclear                  -> definition_unclear, category = first proposed category
--
-- Usage (see scripts/export-review-verdicts.sh):
--   psql ... -v batch=2026-10-14-clean -v reviewer= -v out=/abs/path/2026-10-14-clean.verdicts.tsv -f scripts/export-review-verdicts.sql
-- test/review-export.test.js runs the same query without the psql lines (`\…`), binding :'batch' as $1
-- and :'reviewer' as $2.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

\o :out
SELECT line
FROM (
  SELECT 0 AS ord, 0 AS position, '' AS item_code,
         concat_ws(E'\t', 'provider', 'native_id', 'category', 'start', 'end', 'verdict', 'item', 'note') AS line
  UNION ALL
  SELECT 1, i.position, i.item_code,
         concat_ws(E'\t',
           'prv',
           i.native_id,
           CASE WHEN v.verdict IN ('sponsor', 'self_promotion') THEN v.verdict
                ELSE split_part(i.proposed, '+', 1) END,
           round((CASE WHEN v.verdict IN ('sponsor', 'self_promotion') THEN COALESCE(b."start", i."start") ELSE i."start" END)::numeric, 1)::text,
           round((CASE WHEN v.verdict IN ('sponsor', 'self_promotion') THEN COALESCE(b."end", i."end") ELSE i."end" END)::numeric, 1)::text,
           CASE v.verdict WHEN 'sponsor'        THEN 'gold_missing'
                          WHEN 'self_promotion' THEN 'gold_missing'
                          WHEN 'not_ad'         THEN 'model_wrong'
                          WHEN 'unclear'        THEN 'definition_unclear' END,
           i.item_code,
           coalesce(btrim(regexp_replace(v.comment, '\s*[\t\r\n]+\s*', ' ', 'g')), ''))
  FROM prv_review_items i
  JOIN (
    SELECT DISTINCT ON (item_id) item_id, verdict, comment
    FROM prv_review_verdicts
    WHERE :'reviewer' = '' OR reviewer = :'reviewer'
    ORDER BY item_id, decided_at DESC, id DESC
  ) v ON v.item_id = i.id
  LEFT JOIN (
    SELECT DISTINCT ON (item_id) item_id, "start", "end"
    FROM prv_review_verdicts
    WHERE "start" IS NOT NULL AND (:'reviewer' = '' OR reviewer = :'reviewer')
    ORDER BY item_id, decided_at DESC, id DESC
  ) b ON b.item_id = i.id
  WHERE i.sheet = :'batch' OR i.batch = :'batch'
) r
ORDER BY ord, position, item_code;
\o
