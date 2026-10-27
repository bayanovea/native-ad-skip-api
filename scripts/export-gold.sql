-- Gold v1 export for native-ad-skip-eval (anonymised, raw per-contributor intervals).
-- One line per live interval. No merging, no prv_user_id, no raw user ids.
--
-- Usage (see scripts/export-gold.sh):
--   psql ... -v salt="'<secret>'" -v assessors="'id1','id2','id3'" -v out=/abs/path/gold-v1.jsonl -f scripts/export-gold.sql
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

\o :out
SELECT row_to_json(r)
FROM (
  SELECT
    'prv'                                                        AS provider,
    v.native_id,
    v.duration,
    c.category,
    i."start",
    i."end",
    left(encode(sha256(convert_to(:salt || m.user_id, 'UTF8')), 'hex'), 16) AS contributor,
    m.user_id IN (:assessors)                                   AS is_assessor,
    u.rating                                                    AS contributor_rating,
    u.banned_at IS NOT NULL                                     AS contributor_banned,
    to_char(m."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
  FROM markup_time_intervals i
  JOIN markups m            ON m.id = i.markup_id
  JOIN videos v             ON v.id = m.video_id
  JOIN markup_categories c  ON c.id = m.category_id
  LEFT JOIN users u         ON u.id = m.internal_user_id
  WHERE i.deleted_at IS NULL
    AND m.deleted_at IS NULL
    AND v.native_id IS NOT NULL
  ORDER BY v.native_id, m."createdAt", i.id
) r;
\o
