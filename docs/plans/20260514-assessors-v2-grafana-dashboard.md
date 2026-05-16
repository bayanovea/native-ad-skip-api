# Assessors v2 Grafana Dashboard

## Overview

Port the per-video / per-user drill-down functionality from `prv/routes/admin.js` (server-rendered HTML at `/admin/video/:video_id` and `/admin/video/:video_id/user/:prv_user_id`) into a new Grafana dashboard "Асессоры v2".

`admin.js` stays in place — this is additive, not a replacement. v1 `assessors.json` ("Асессоры") is also untouched; v2 complements it as the focused drill-down view.

**Acceptance criteria:** New dashboard "Асессоры v2" visible in Grafana after deploy. Given a video native_id, shows video header + calculated segments + all markups (with consensus-segment linkage) + per-user filter. Delete action on markup row works (cascade-recalc kicks in). No backend changes.

## Context (from discovery)

- `prv/routes/admin.js` — source of functionality being ported
- `grafana/dashboards/assessors.json` — v1 reference (style, Postgres datasource UID `ce68e9be-35fa-4d6a-8f59-35f03dae1d52`, `verifyBearerToken` constant variable pattern)
- `grafana/provisioning/dashboards/dashboards.yml` — file provider, auto-loads JSON from `grafana/dashboards/`
- `prv/routes/markups.js:193-217` — `GET /markups/:id/delete` is byte-identical to admin.js's delete (soft-delete + cascade `is_new=true` + destroy `VideoCalculated` if empty). Reused; no new backend route.
- Schema (from CLAUDE.md): `videos`, `markups`, `markup_time_intervals`, `markup_categories`, `users`, `prv_calculated_segments`, `prv_calculated_segment_markups`. All soft-deletes filter `deleted_at IS NULL`.

## Development Approach

- **testing approach**: Regular (no unit tests applicable — Grafana dashboard JSON only). Verify each task manually in Grafana before proceeding.
- Build the dashboard incrementally — one panel at a time, verifying it loads against the real DB before adding the next.

## Solution Overview

1. New file `grafana/dashboards/assessors-v2.json`. Auto-provisioned alongside v1.
2. Variables: `$video_id` (textbox, native_id), `$prv_user_id` (textbox, optional), `$verifyBearerToken` (hidden constant, mirrors v1).
3. Four panels stacked vertically:
   - Video header (stat) — DB id, native_id, prv link, duration, segment count
   - Calculated segments (table) — consensus output for the video
   - Markups (table) — all markups for video, optionally filtered by user; consensus-segment linkage column; delete action; soft-deleted rows faded
   - User profile (stat) — shown only when `$prv_user_id` set: rating, time_saved, total markups, distinct videos
4. Filtering on optional `$prv_user_id` uses SQL pattern: `('$prv_user_id' = '' OR u.prv_user_id = NULLIF('$prv_user_id', '')::bigint)`.
5. Delete action: data-link on "Действия" column → `https://${API_HOST}/markups/${__data.fields.id}/delete?verifyBearerToken=${verifyBearerToken}` (same shape as v1).
6. prv_user_id column in Markups panel has data-link → `?var-prv_user_id=${__value.raw}` so clicking jumps to user-filtered view.
7. Soft-deleted markup rows visually faded via field override mapping on `deleted_at` (color text orange when not null).
8. Δend visual cue from admin.js: NOT ported (out of scope).
9. Bucket-grouping UI from admin.js: NOT ported — Grafana tables are flat. Consensus linkage column gives equivalent information via JOIN on `prv_calculated_segment_markups`.
10. **Semantic divergence from admin.js**: v2 displays soft-deleted markups (visually faded via `deleted_at` field override). admin.js filters `deleted_at IS NULL` on the main video view. Rationale: the user filter view in admin.js already shows deleted markups; in Grafana there's one flat panel that serves both purposes. If all of a markup's intervals are soft-deleted while the markup itself is alive, the interval column will be empty — acceptable.

## Technical Details

### SQL — Video header (refId A, single row)

```sql
SELECT
  v.id                                              AS "DB id",
  v.native_id                                       AS "native_id",
  'https://example.invalid/video?z=video' || v.native_id     AS "prv",
  v.duration                                        AS "Длительность",
  (SELECT COUNT(*) FROM prv_calculated_segments WHERE video_id = v.id) AS "Сегментов"
FROM videos v
WHERE v.native_id = '$video_id';
```

Note: the junction column linking `prv_calculated_segment_markups` → `prv_calculated_segments` is `segment_id` (NOT `calculated_segment_id`). Confirmed in `prv/db/index.js:102` and `calculator/calculate.go:100,227`.
```

### SQL — Calculated segments

```sql
SELECT
  mc.category AS "Категория",
  TO_CHAR(CAST(cs.start AS INTEGER) / 60, 'FM99999') || ':' || TO_CHAR(CAST(cs.start AS INTEGER) % 60, 'FM00') || ' - ' ||
  TO_CHAR(CAST(cs."end" AS INTEGER) / 60, 'FM99999') || ':' || TO_CHAR(CAST(cs."end" AS INTEGER) % 60, 'FM00') AS "Интервал",
  cs.rating AS "Рейтинг",
  (SELECT COUNT(*) FROM prv_calculated_segment_markups WHERE segment_id = cs.id) AS "Разметок"
FROM prv_calculated_segments cs
JOIN videos v ON v.id = cs.video_id
JOIN markup_categories mc ON mc.id = cs.category_id
WHERE v.native_id = '$video_id'
ORDER BY cs.start ASC;
```

### SQL — Markups

```sql
SELECT
  m.id,
  mc.category AS "Категория",
  STRING_AGG(
    TO_CHAR(CAST(mti.start AS INTEGER) / 60, 'FM99999') || ':' || TO_CHAR(CAST(mti.start AS INTEGER) % 60, 'FM00') || ' - ' ||
    TO_CHAR(CAST(mti."end" AS INTEGER) / 60, 'FM99999') || ':' || TO_CHAR(CAST(mti."end" AS INTEGER) % 60, 'FM00'),
    ', ' ORDER BY mti.start
  ) AS "Интервал",
  u.prv_user_id AS "prv user",
  (
    SELECT STRING_AGG(DISTINCT
      TO_CHAR(CAST(cs.start AS INTEGER) / 60, 'FM99999') || ':' || TO_CHAR(CAST(cs.start AS INTEGER) % 60, 'FM00') || ' - ' ||
      TO_CHAR(CAST(cs."end" AS INTEGER) / 60, 'FM99999') || ':' || TO_CHAR(CAST(cs."end" AS INTEGER) % 60, 'FM00'),
      ', '
    )
    FROM prv_calculated_segment_markups csm
    JOIN prv_calculated_segments cs ON cs.id = csm.segment_id
    WHERE csm.markup_id = m.id
  ) AS "Сегмент консенсуса",
  m."createdAt" AS "Создано",
  m.deleted_at  AS "Удалено",
  '❌ Удалить' AS "Действия"
FROM markups m
JOIN videos v ON v.id = m.video_id
JOIN markup_categories mc ON mc.id = m.category_id
-- internal_user_id is the canonical FK to users.id; markups.prv_user_id is legacy and nullable
LEFT JOIN users u ON u.id = m.internal_user_id
LEFT JOIN markup_time_intervals mti ON mti.markup_id = m.id AND mti.deleted_at IS NULL
WHERE v.native_id = '$video_id'
  AND ('$prv_user_id' = '' OR u.prv_user_id = NULLIF('$prv_user_id', '')::bigint)
GROUP BY m.id, mc.category, u.prv_user_id, m."createdAt", m.deleted_at
ORDER BY m.deleted_at NULLS FIRST, MIN(mti.start) ASC;
```

### SQL — User profile (only renders when `$prv_user_id` non-empty)

```sql
SELECT
  u.rating                                                                                                AS "Рейтинг",
  u.time_saved                                                                                            AS "Сэкономлено (с)",
  (SELECT COUNT(*)            FROM markups WHERE internal_user_id = u.id AND deleted_at IS NULL)          AS "Разметок",
  (SELECT COUNT(DISTINCT video_id) FROM markups WHERE internal_user_id = u.id AND deleted_at IS NULL)     AS "Видео"
FROM users u
WHERE u.prv_user_id = NULLIF('$prv_user_id', '')::bigint;
```

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): JSON authoring + manual Grafana verification
- **Post-Completion** (no checkboxes): deployment to prod, optional v1 cross-link

## Implementation Steps

### Task 1: Create dashboard skeleton with variables

**Files:**
- Create: `grafana/dashboards/assessors-v2.json`

- [ ] Copy `assessors.json` structure as starting point (`schemaVersion: 42`, `editable: false`, `id: null`)
- [ ] Generate fresh `uid` (`uuidgen | tr A-Z a-z`) — confirm it differs from v1's `a5ce11dd-d1f0-40de-9ed6-05de698df89f` (collision would error the provisioner on startup)
- [ ] Set `title: "Асессоры v2"`
- [ ] Add three templating variables:
  - `video_id` (type `textbox`, label "Video native_id", `"current": { "text": "", "value": "" }`, `"query": ""`)
  - `prv_user_id` (type `textbox`, label "prv user id", `"current": { "text": "", "value": "" }`, `"query": ""`) — explicit empty defaults are required so the `NULLIF('$prv_user_id', '')::bigint` cast trick works on first load
  - `verifyBearerToken` (type `constant`, `hide: 2`, value matches v1's token)
- [ ] Empty `panels: []` for now
- [ ] Validate JSON parses (`jq . grafana/dashboards/assessors-v2.json > /dev/null`)
- [ ] Restart Grafana locally (`docker-compose -f docker-compose.dev.yml restart grafana` or equivalent) — dashboard appears with no panels, variables editable at top
- [ ] Open the dashboard with no URL params, inspect any panel (once Task 2 adds one) via panel inspector → confirm `$prv_user_id` substitutes to `''` (empty string), not the literal `$prv_user_id`

### Task 2: Add Video header + Calculated segments panels

**Files:**
- Modify: `grafana/dashboards/assessors-v2.json`

- [ ] Add row panel "Видео"
- [ ] Add stat panel "Видео" with the Video header SQL; field override on `prv` column to render as link (`targetBlank: true`, `url: ${__value.raw}`)
- [ ] Add table panel "Сегменты консенсуса" with the Calculated segments SQL; mappings for `Категория` colors (intro/sponsor/self_promotion/credits matching v1's color scheme)
- [ ] Grid positions: stat at row 1 (`h:4, w:24`), segments table below (`h:8, w:24`)
- [ ] Restart Grafana, paste a real video native_id into `$video_id` — confirm header populates and segments table lists rows in start order

### Task 3: Add Markups panel with delete + user drill-down

**Files:**
- Modify: `grafana/dashboards/assessors-v2.json`

- [ ] Add row panel "Разметки"
- [ ] Add table panel "Разметки" with the Markups SQL
- [ ] Field override on `prv user` column: data link → `/d/${__dashboard.uid}?var-video_id=${video_id}&var-prv_user_id=${__value.raw}` (same dashboard, scoped to clicked user). Note: `var-` is the URL query-param key; the Grafana interpolation token is `${video_id}` not `${var-video_id}` — v1's data links at `assessors.json:190,353,954` confirm the syntax.
- [ ] Field override on `Действия` column: data link → `https://${API_HOST}/markups/${__data.fields.id}/delete?verifyBearerToken=${verifyBearerToken}`, `targetBlank: true`
- [ ] Value mapping on `Действия`: `"❌ Удалить"` → red color
- [ ] Field override on `Удалено` column: continuous color or value-mapped so non-null values render orange/red (visual fade for soft-deleted rows)
- [ ] Category color mappings consistent with v1
- [ ] Grid position: full-width table (`h:18, w:24`), `enablePagination: true`
- [ ] Restart Grafana, verify: (a) markups load for the video; (b) clicking a prv_user_id filters to that user (URL updates with `var-prv_user_id`, table filters); (c) clicking "❌ Удалить" opens delete URL in new tab and returns 201

### Task 4: Add User profile stat panel

**Files:**
- Modify: `grafana/dashboards/assessors-v2.json`

- [ ] Add stat panel "Профиль пользователя" with the User profile SQL
- [ ] Use Grafana's panel-level `hideTimeOverride` / dashboard variable conditional: set the panel to use the `$prv_user_id` variable in its query; when empty, the `NULLIF` will produce a NULL filter that returns 0 rows → panel shows "No data" gracefully (acceptable behavior; no need for explicit hide logic)
- [ ] Grid position: below Markups (`h:5, w:24`) or sidebar-style; pick whatever reads cleanly
- [ ] Field override on `Рейтинг`: thresholds (red < 0, orange = 0, green > 0)
- [ ] Restart Grafana, set `$prv_user_id` to a real user — confirm profile shows correct rating + counts; clear `$prv_user_id` — confirm panel shows "No data" without breaking the dashboard

### Task 5: Verify acceptance criteria

- [ ] All four panels load against a real `$video_id` with no SQL errors
- [ ] Optional `$prv_user_id` filter works in Markups panel
- [ ] Click prv_user_id in Markups → URL gains `var-prv_user_id` → User profile panel populates
- [ ] Click "❌ Удалить" → markup soft-deleted in DB → on refresh, row shows `deleted_at` and appears faded
- [ ] Empty `$video_id` → Calculated segments + Markups tables show "No data" (no error toast)
- [ ] Confirm v1 `assessors.json` still works unchanged (open it in Grafana, verify panels load)
- [ ] JSON validates (`jq . grafana/dashboards/assessors-v2.json > /dev/null`)

### Task 6: [Final] Update documentation and close plan

**Files:**
- Modify: `CLAUDE.md`

- [ ] Add one line to CLAUDE.md's `prv/routes/admin.js` section noting that the "Асессоры v2" Grafana dashboard mirrors this functionality
- [ ] Move this plan to `docs/plans/completed/`

## Post-Completion

**Deployment:**
- Commit `assessors-v2.json` and push to `main`. The deploy workflow rebuilds the Grafana container, which re-provisions dashboards from the mounted `grafana/dashboards/` directory.
- After deploy, open `http://178.154.241.202:3024/` and confirm "Асессоры v2" appears in the dashboard list.

**Optional follow-up (not in this plan):**
- Add data-link on v1 "Асессоры" dashboard's "Видео" column → opens v2 with `?var-video_id=<native_id>`. ~10 min change, non-blocking.

**Manual verification on prod:**
- Pick a recent video with multiple markups, paste its native_id into v2, verify drill-down and delete flow work end-to-end against production data.
