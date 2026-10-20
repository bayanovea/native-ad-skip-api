# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**native-ad-skip-api** is a hybrid Node.js + Go service for crowdsourced video ad/segment skipping. Users submit time-interval markups (intro, sponsor, self_promotion, credits). A Go CLI aggregates markups into consensus boundaries stored in `VideoCalculated`, which clients poll to skip ads.

## Commands

### Development

```bash
yarn install          # Install Node.js dependencies
yarn dev              # Start with nodemon (auto-reload, NODE_ENV=development)
yarn start            # Production mode

docker-compose -f docker-compose.dev.yml up          # Full dev stack (Node + DB + Prometheus)
docker-compose -f docker-compose.yml up --build -d app  # Local build of the prod image (prod itself pulls the
                                                        # image CI pushed to GHCR, see Deployment)
```

### Go CLI (Calculation Engine)

Each provider has its own entry point that calls the shared `calculator` package with its table prefix (`""`, `"rt_"`, `"yt_"`).

```bash
# Build all three
go build -mod=vendor -o prv/commands/calculate ./prv/commands/
go build -mod=vendor -o rt/commands/calculate ./rt/commands/
go build -mod=vendor -o yt/commands/calculate ./yt/commands/

# Run (example for prv)
./prv/commands/calculate                # Process all videos with new markups
./prv/commands/calculate <video_id>    # Process a single video
./prv/commands/calculate --recompute-ratings   # Reset every segment rating from the votes table (see Ops)
```

### Tests

```bash
go test ./calculator                            # Go unit tests; TestIntegration skips without DB env (CI), but a
                                                # local .env with DB_USER makes it run against DB_HOST (fails on
                                                # host.docker.internal) — locally add -run 'TestFindMedian|TestCalculateIntervals|TestApplyRatings'
go test ./calculator -run TestFindMedian        # Run a single test

make test-calculator                            # Go integration tests against a real Postgres
                                                # (requires DB_USER/DB_PASSWORD in env)
make test-e2e                                   # Full Docker e2e: spins up Postgres + Node app
                                                # and exercises HTTP endpoints + Go calc binary
make test-unit                                  # DB-free Node unit tests (no Docker)
```

`make test-e2e` runs `test/e2e.js` (Node `node:test`) and is the canonical end-to-end suite. It also runs `test/moderation-resolver.test.js` and `test/review-export.test.js` (the review export SQL in its own DB, plus `scripts/export-review-verdicts.sh` through psql: the e2e compose file builds the image with `EXTRA_PACKAGES=postgresql-client`, the prod image has no psql). `make test-unit` runs the DB-free unit tests: `test/review-sheet.test.js`, `test/find-video-for-read.test.js`, `test/prometheus-wrapper.test.js`, `test/redact-request.test.js`, `test/validate-intervals.test.js`, `test/i18n.test.js`, `test/reviewer-name.test.js`.

### Ops

```bash
make pull-dump                                  # gzipped prod pg_dump over SSH → ~/Web/dumps/adskip-prod/ (weekly)

# Segment ratings from the votes table (backfill after the 2026-10-17 deploy; safe to re-run, a second run
# reports 0 changed). Inside the app container, under the cron lock so it never overlaps a recalculation:
flock /tmp/calculate-prv.lock /app/prv/commands/calculate --recompute-ratings   # rt / yt: calculate-rt.lock, /app/rt/…

# Assessor review on prod (source of truth for verdicts since 2026-10-16; page:
# https://${API_HOST}/admin/review?verifyBearerToken=<AUTH_TOKEN> — pick who you are or
# create yourself in the picker form, the link then carries &reviewer=<code>; codes live in
# prv_review_reviewers: bayanovea / gkshi seeded in lib/schema.js, the rest created on the page).
# Import/export from the Mac over an SSH tunnel to the host Postgres, app role:
ssh -N -L 5434:localhost:5432 root@${HOST_IP}  # terminal 1
read -s "DB_PASSWORD?DB password: "; echo        # zsh; keeps the password out of history
DB_PASSWORD=$DB_PASSWORD DB_HOST=localhost DB_PORT=5434 DB_NAME=adskip DB_USER=adskip \
  node scripts/import-review-sheet.js ~/Web/data/review/<sheet>.md [--reviews N] [--exclude CODE[,CODE]]
PGPASSWORD=$DB_PASSWORD PGPORT=5434 PGUSER=adskip PGDATABASE=adskip \
  scripts/export-review-verdicts.sh <batch> [reviewer]
PGPASSWORD=$DB_PASSWORD PGPORT=5434 PGUSER=adskip PGDATABASE=adskip \
  scripts/export-video-flags.sh                  # → review/video-flags.tsv (track_mismatch per video)
unset DB_PASSWORD
# Blind copy of part of a sheet for a second reviewer (same codes, verdicts emptied); import it
# with --exclude <first reviewer> so they never get their own items back:
node scripts/subset-review-sheet.js ~/Web/data/review/<sheet>.md ~/Web/data/review/<out>.md --sample 12 --seed 7

# Same scripts against the local restored dump (localhost:5433/skipper, user postgres / password local);
# its prv_review_* copy of 2026-10-14-clean is stale, prod has the live verdicts
DB_HOST=localhost DB_PORT=5433 DB_USER=postgres DB_PASSWORD=local DB_NAME=skipper \
  node scripts/sync-db.js                       # once per fresh dump: creates prv_review_* tables (same schema steps as app boot)
DB_HOST=localhost DB_PORT=5433 DB_USER=postgres DB_PASSWORD=local DB_NAME=skipper \
  node scripts/import-review-sheet.js ~/Web/data/review/<sheet>.md [--batch NAME]
DB_HOST=localhost DB_PORT=5433 DB_USER=postgres DB_PASSWORD=local DB_NAME=skipper \
  AUTH_TOKEN=<token> NODE_APP_PORT=3022 node server.js   # then open /admin/review?verifyBearerToken=<token>
scripts/export-review-verdicts.sh <batch> [reviewer]   # psql (PG* env, defaults localhost:5433/skipper)
                                                # → ${ADSKIP_DATA:-~/Web/data}/review/<batch>[.<reviewer>].verdicts.tsv
```

- **Importer** registers the batch in `prv_review_batches` with `--reviews N` (how many reviewers must finish it, default 1) and `--exclude CODE[,CODE]` (registered codes that may never take it, e.g. the first reviewer of a subset sheet); for an existing batch a value other than the stored one fails the import (never silently re-routes a batch), an option left out is not checked. `--assignee` is gone (fails with a hint: batches are first come). It names the md verdicts' reviewer with `--reviewer CODE` (default `bayanovea`); when the newly imported verdicts leave the batch unfinished for that reviewer it is locked on them (only if they may take it), when they finish it their lock is released; a re-run that imports nothing touches no lock. It reads `<sheet>.md` + `<sheet>.key.tsv` (written by `adskip sheet` in `ad-skip-segment-eval`; blind `C<n>` sheets only, `K<n>` conflict sheets are rejected). Every item needs `Proposed as:`, an http(s) `Link:` and a `Verdict:` line. The verdict is the text on the `Verdict:` line; when that line is empty (as `adskip sheet` writes it), the first non-empty line after it must be the verdict (`Verdict: ` / `not an ad` / reason, the style of the 2026-10-12 sheets) and any other text there fails the import. The remaining lines are the comment, up to a markdown heading (`#`…`######` + space) or a `---` rule line, which ends the item. It first copies the md to `<sheet>.md.bak-YYYYMMDDHHMMSS` (suffix `-1`, `-2` instead of overwriting) and never writes the md. One transaction: items `ON CONFLICT (batch, item_code) DO NOTHING`, and an item already in the batch must be the same stretch (`native_id`, `start`, `end`, `proposed`) or the import fails, so a regenerated sheet or a wrong `--batch` never attaches verdicts to the wrong item; md verdicts (`source='import'`) go through `recordVerdict` and only for items with no verdict yet from anyone, so re-running after more md marks adds only the new ones. An unknown verdict text fails the whole import (nothing written). Batch defaults to the md file name.
- **Export** (`export-review-verdicts.sh <batch> [reviewer]`) writes the latest verdict per decided item (with a reviewer: their latest per item they decided, into `<batch>.<reviewer>.verdicts.tsv`; an unregistered code exits 1) as `provider native_id category start end verdict item note` for `adskip review -file`: `sponsor`/`self_promotion` → `gold_missing` (category = the verdict), `not_ad` → `model_wrong`, `unclear` → `definition_unclear` (category = first proposed). Times with one decimal, note = comment with tabs/newlines collapsed. Exits 1 (nothing written) on an unknown batch; creates `review/` if missing and writes through `<file>.tmp` + `mv`, so a failed query never leaves a truncated TSV.
- **Video flags export** (`export-video-flags.sh`) writes the latest value per `(native_id, flag)` of `prv_review_video_flags` as `provider native_id flag value reviewer set_at` to `review/video-flags.tsv`. Today one flag: `track_mismatch` (subtitle track ≠ player), the input for the eval repo's timing-clean slice and the drift audit.
- **`--recompute-ratings`** (`calculator.RecomputeRatings`, `calculator/recompute.go`): for every video with a `{prefix}video_calculateds` row, in its own transaction: locks that row (`FOR UPDATE`, as the vote handler and a recalculation do), computes the ratings with the calculator's rule (see Calculation Algorithm), updates only the segment rows whose rating differs and rewrites the JSON entries' `rating` (sparse; entry order and other fields kept) only when one changed. Never touches boundaries, markups or `is_new`. 10 videos in parallel; a failing video is logged (`Recompute ratings failed: <video_id>: <err>`) and the binary exits 1 at the end. Last line: `Recompute ratings finish: N videos processed, M segments changed, K video_calculateds rewritten`.

## Architecture

### Dual-Process Design

Two independent runtimes managed by Supervisor inside Docker:
- **Node.js (Express)** — HTTP API: CRUD for markups, votes, and serving calculated results
- **Go CLI** — Cron job every minute: aggregates new markups into `VideoCalculated`

Communication is only through PostgreSQL. The Go binary reads `MarkupTimeInterval` rows where `is_new = true` and writes aggregated JSON to `VideoCalculated` plus relational rows in `{provider}_calculated_segments` (and the segment ↔ markup junction). Node reads `VideoCalculated.data` for client responses and recomputes the per-segment `rating` from the votes table (in both the JSON and the segments table) when a vote arrives or is deleted; the Go binary computes it the same way on every recalculation.

### Request Flow

```
Client → Express routes → Middleware (validate, auth) → Repository layer → PostgreSQL
                                                                ↓ (async, every minute)
                                                    Go CLI (calculate) → VideoCalculated
```

### Providers

The service supports three video platforms, each isolated in its own directory:

| Provider | Mount path | Directory |
|----------|-----------|-----------|
| prv | `/` | `prv/` |
| rt | `/rt` | `rt/` |
| yt | `/yt` | `yt/` |

Each provider directory has the same internal layout:

```
<provider>/
  commands/main.go       # Go CLI entry point (passes table prefix to calculator)
  db/index.js            # Sequelize models scoped to this provider's table prefix
  repository/            # Raw Sequelize queries
  routes/                # Express route handlers
  service/               # Business logic (prv/ only; rt and yt reuse prv/service/user.js)
```

`rt` and `yt` share `prv/service/user.js` and `prv/routes/users.js` directly — they have no separate user service.

### Key Directories

| Path | Purpose |
|------|---------|
| `prv/`, `rt/`, `yt/` | Per-provider Express routes, repositories, and Go CLI entry points |
| `calculator/` | Shared Go source: `calculate.go` (algorithm), `recompute.go` (`--recompute-ratings`), `pool.go` (goroutine pool) |
| `middleware/` | Auth (`verify-bearer-token.js`; `verify-query-token.js` for the `?verifyBearerToken=` GET links of `votes.js`), validation, async error wrapper |
| `lib/` | Shared helpers: `find-video-for-read.js` (read-only video lookup), `duration-tolerance.js` (`DURATION_TOLERANCE = 2`, `durationMatchQuery()` — the `(native_id, duration ± 2)` where + order shared by the read helper and the three `repository/video.js`), `review-sheet.js` (review sheet parser, verdict normalisation, `formatPlayerTime`), `admin-html.js` (`escapeHtml`, `urlToken`, `formatDate`, `CATEGORY_COLORS` for the prv admin pages), `script-db.js` (`scriptSequelize()` — DB connection for `scripts/`), `schema.js` (`syncSchema()` — sync + idempotent ALTERs + category and reviewer seeding (`REVIEWERS`), the 2026-10-18 one-off that gives verdicts of unknown reviewers to `bayanovea`, the 2026-10-20 `assignee` one-off (see Schema bootstrap) and a default `prv_review_batches` row for every batch of `prv_review_items`; used by `db.js` boot and `scripts/sync-db.js`), `i18n.js` (review page strings from `prv/locales/review/{ru,en}.json`: `translator(lang)` → `t(key, params)` returns HTML (escaped, except `_html` keys whose markup is kept and only params escaped), `t.text()` plain text for the inline `STATE` (throws on `_html`); a key missing in en falls back to ru, unknown everywhere throws; `pickLang(req)`: `?lang=` → `review_lang` cookie → `ru`), `reviewer-name.js` (`validReviewerName()` — the cleaned name or null: NFC, trimmed, inner spaces collapsed, 1–64 letters of any script, digits, space, `.`, `_`, `-`; route and repository share it), `redact-request.js` (`redactRequest()` — request fields for the `server.js` error log with the `Authorization` header and `verifyBearerToken` (query and url) redacted), `validate-intervals.js` (`validateIntervals()` — `POST /markup` interval rules, shared by prv/rt/yt), `segment-rating.js` (`lockVideoCalculated()`, `recomputeSegmentRating()` — a segment's rating from the votes table, per provider `models`) |
| `scripts/` | Local/ops scripts: `sync-db.js`, `pull-prod-dump.sh`, review import/export (`import-review-sheet.js`, `subset-review-sheet.js`, `export-review-verdicts.sh`, `export-video-flags.sh`), gold export (`export-gold.sh`) |
| `db.js` | Sequelize models and associations for all providers |
| `api/doc/openapi.yaml` | OpenAPI spec served at `/api/doc` |
| `grafana/` | Grafana provisioning configs and dashboard JSONs; service runs on port 3024 |

### Calculation Algorithm (`calculator/calculate.go`)

1. Query videos where any markup has `is_new = true`
2. For each video (up to 10 in parallel via goroutine pool), in **one transaction** (`db.Begin()`, commit at the end, rollback on any error, so a failure never leaves a video without its previous segments):
   - Read and row-lock the ids of the video's live `is_new` markups (`FOR NO KEY UPDATE SKIP LOCKED`). This runs before the interval read, so a markup committed in between is aggregated but stays new. A concurrent API write that sets `is_new = true` on a locked row waits for the commit and so survives it; a row some other transaction holds right now is skipped (no waiting, so no deadlock with the API) and stays new for the next run.
   - Read all live intervals of the video and group them by `(category_id, startRounded)` where `startRounded = start - (start % 3)` (3-second buckets)
   - **Start** = average of all starts in the group
   - **End** = median of all ends in the group
   - Row-lock the video's `video_calculateds` row (`FOR UPDATE`; the vote handler and `--recompute-ratings` take this lock first too, so the same order avoids deadlocks), then clear the previous segments (`{provider}_calculated_segment_markups` → `{provider}_calculated_segments` → `video_calculateds`)
   - Read the ratings from `{prefix}votes` (`voteRatings`), as late as possible: a segment's rating is the SUM of each user's latest vote (`DISTINCT ON (user_id, category_id, start, "end")`, `"createdAt" DESC, id DESC`) with an exact `(video_id, category_id, start, end)` match — vote bounds are floats, segment bounds ints. The Node API uses the same rule (`lib/segment-rating.js`). Votes whose bounds match no segment after a boundary shift count nowhere (`docs/backlog/votes-lost-when-segment-boundaries-shift.md`).
   - Insert the JSON array into `video_calculateds.data` (each entry: `category_id`, `start`, `end`, `rating` from the votes; `rating` is omitted when 0 — sparse representation).
   - Insert one row per segment into `{provider}_calculated_segments` (with that `rating`) and one row per contributing markup into `{provider}_calculated_segment_markups`
   - Set `is_new = false` on `{provider}markups` only for the ids read in the first step, so markups posted during the run are picked up by the next one
3. Per-video errors are returned, not panicked: the failing video is logged (`Calculate video failed: <video_id>: <err>`) and rolled back, the other videos go on, and the binary exits 1 at the end (`N of M videos failed`). Only startup failures (DB connect, listing the videos) abort the run.
4. Heartbeat: once the pool is done, `Run` upserts the provider's row in the shared `calculator_heartbeats` table (`provider` PK `prv`|`rt`|`yt`, `last_run_at`, `last_success_at`, `failed_videos`): `last_run_at = NOW()` always, `last_success_at` only when `failed_videos = 0` (an idle run with no videos counts as a success). Single-video mode writes it too, `--recompute-ratings` does not. A failed write is logged (`Heartbeat write failed: <err>`) and exits 1 — e.g. the table is missing because Go cron fired before Node's first `sync()` on a fresh deploy; the next minute is fine. `GET /metrics` exposes the row as the `calculator_*_timestamp_seconds` gauges (see Prometheus Metrics), the "Calculator: seconds since last success" stat panel on `grafana/dashboards/infrastructure.json` shows it.

Cron starts each provider's binary every minute (`crontab`, offsets 0/20/40 s) under `flock -n /tmp/calculate-<provider>.lock`, so a run still going when the next minute fires makes the new one exit at once instead of overlapping. Their output (stdout and stderr) is appended to `/proc/1/fd/1`, supervisord's stdout, so it shows in `docker logs` next to the Node app's. The e2e suite covers the rollback, the mid-run markup, the skipped locked row, ratings surviving a recalculation, `--recompute-ratings` and the heartbeat (`calculator:` tests in `test/e2e.js`).

The segment rows in `{provider}_calculated_segments` are the source of truth for joins (e.g. analytics) and carry the same `rating` that lives in `video_calculateds.data`. Both are derived from the votes table: by the calculator on every recalculation, by the vote handler on every vote or vote deletion (see Routes → `votes.js`), and by `calculate --recompute-ratings` (see Ops).

### Routes

All three providers share the same route shape; `prv/` also mounts the shared `events.js` / `users.js` and the prv-only admin pages (`admin.js`, `admin-moderation.js`, `admin-review.js`).

- **`markups.js`** — Core markup CRUD. `POST /markup` validates `data.intervals` with `lib/validate-intervals.js` (1–20 items; `start`/`end` finite numbers or numeric strings; after rounding `0 <= start < end <= 86400`; else 400) and creates the markup and all its intervals in one transaction. It rejects users with rating ≤ −2. It also silently returns 201 (no row created) when the user is hard-banned (banned_at IS NOT NULL); see Authentication. `PUT /markups` edits one interval (`new_start` / `new_end` / `new_category_id`): the resulting interval (new values merged with the stored ones) must pass the same `validateIntervals` rules, else 400 with the message as plain text; the interval update and the markup's `is_new = true` are one transaction. Several delete endpoints have both `DELETE` and `GET` variants because Grafana can only trigger GET requests.
- **`votes.js`** — Vote submission. Each new vote runs in one transaction that first row-locks the video's `VideoCalculated` (`lockVideoCalculated` in `lib/segment-rating.js`, which re-reads once when a recalculation replaced the row meanwhile), so votes on a video, its recalculation and `--recompute-ratings` serialise:
  - the segment must exist in `video_calculateds.data` (exact category/start/end), else 404; the user's previous vote row on the segment is replaced by the new one
  - `recomputeSegmentRating` (`lib/segment-rating.js`) sets `{provider}_calculated_segments.rating` and the matching `video_calculateds.data` entry (sparse) from the votes table, with the calculator's rule (each user's latest vote, summed)
  - the markup authors' user `rating` is adjusted by `vote - prevVote.vote` via `prv/service/user.js` `updateRatingByVote(vote, prevVote, { transaction })` (every author whose live markup has an interval with the exact `(start, end)`; ascending user id, so concurrent votes do not deadlock)
  - if the rating mutation drops a user to rating ≤ −100, `prv/service/user.js` also sets `banned_at` and writes a `prv_admin_decisions` row with `decided_by='auto'` (idempotent — only the first crossing writes; the `banned_at == null` guard short-circuits repeat crossings)
  - `GET /votes/:id/delete?verifyBearerToken=…` (Grafana link) undoes the vote: 401 on a wrong token, 404 on an unknown (or concurrently deleted) vote, else one transaction under the same `VideoCalculated` lock destroys the vote, recomputes the segment rating (table + JSON; skipped when the video has no `VideoCalculated`) and reverses the authors' change with `updateRatingByVote({ ...vote, vote: 0 }, vote, { transaction })`. The voter's own rating is never touched. `201 'Updated'`.
  - `GET /votes/user/:internal_user_id/update-rating?verifyBearerToken=…&rating=N` (Grafana link, e.g. `rating=-100` in `assessors.json`) overrides a user's rating: token first (`middleware/verify-query-token.js`, 401 whatever the params), then `rating` must be an INTEGER-range int (400), unknown user 404, else `201`. Each override is logged to stdout as `Admin rating override { internal_user_id, from, to }` (no table).
- **`videos.js`** — `GET /video-calculated` serves aggregated segments; prv additionally logs duration claims and tracks legacy client versions. Uses a read-only `findVideoForRead` helper (never creates Video rows): looks up by `(native_id, duration±2)` (tolerance constant in `lib/duration-tolerance.js`), then `(native_id, null duration)` updating it, then any `native_id` match, then 204. The tolerance query is ordered by `ABS(duration - <requested>)`, then `id`, on the read path and in `findByNativeIdAndDuration` (`POST /markup`) alike, so a duration that fits both rows of an old split pair always lands on the same row (the 5 pre-2026-10-19 pairs stay split by decision: `docs/backlog/video-rows-race-and-old-split-families.md`).
- **`prv/routes/events.js`** — `POST /events` (shared by all providers). Accepts a JSON array of mixed events; supported types below. Invalid events (unknown `type`, missing fields) are logged to stdout and skipped — the rest of the batch still processes. Returns `{ data: { time_saved: { ... } } }` when the batch contains at least one `time_saved` event.
  - **`interval_undo`** — fields: `user_id`, `prv_user_id`, `video_native_id`, `category_id`, `start`, `end`. Stored in `{provider}_events_interval_undo`.
  - **`interval_click`** — fields: same as above plus `click_time` (int). Stored in `{provider}_events_interval_click`.
  - **`time_saved`** — fields: `user_id`, `prv_user_id`, `inc`. Increments `User.time_saved`; stored in `{provider}_events_time_saved`. Response mirrors the old `POST /users/time-saved` structure: `by_user_id`, `by_prv_user_id`, `by_user`.
  - **`client_failed`** — fields: `user_id`, `prv_user_id`, `video_native_id`, `reason` (string), `data` (arbitrary JSON, optional). Stored in `{provider}_events_client_failed`.
- **`prv/routes/users.js`** — Shared by all providers (currently empty; `POST /users/time-saved` was removed in favour of the events endpoint).
- **`prv/routes/admin.js`** — Server-rendered HTML dashboard (`/admin/video/:video_id`) for viewing and deleting markups grouped by interval; protected by `AUTH_TOKEN` query param. prv only.
- **`prv/routes/admin-moderation.js`** — prv-only moderation routes, protected by `AUTH_TOKEN` query param (`?verifyBearerToken=…`).
  - `GET /admin/moderation?verifyBearerToken=…&show=all&format=json` — admin moderation page. Lists worst users + worst markups sorted by suspicion score (`3*dislikes + 1*undos` for users; `+ 3*max(0, -segment_rating)` for markups). Default view hides rows where a prior decision exists and `current_score - snapshot.score < 5` (`RESURFACE_THRESHOLD`). `?show=all` reveals all. `?format=json` returns structured data for tests/integrations.
  - `POST /admin/moderation/decide?verifyBearerToken=…` — body `{target_type:'user'|'markup', target_id, decision:'approve'|'reject'}`. Returns `204`. Side effects: `user`+`reject` sets `users.banned_at=NOW()`; `user`+`approve` clears it; `markup`+`reject` soft-deletes the markup and (if no remaining siblings) destroys `VideoCalculated` else marks siblings `is_new=true`; `markup`+`approve` records the decision only. Writes a row to `prv_admin_decisions` with snapshot and `decided_by='admin'`.
  - `GET /admin/user/:internal_id?verifyBearerToken=…` — video-less per-user view showing all markups across all videos. Param is the internal `users.id` PK, NOT `prv_user_id` (which is not unique — multiple `User` rows can share the same `prv_user_id` because the unique index is composite `(generated_user_id, prv_user_id)`).
- **`prv/routes/admin-review.js`** — prv-only assessor review page (sibling of moderation, same `?verifyBearerToken=…` auth, but an unset `AUTH_TOKEN` refuses every request). One verdict per AI-flagged segment from an imported review sheet (see Ops). Reads/writes only through `prv/repository/review.js`. **Reviewer identity**: every page needs `&reviewer=<code>` (a row of `prv_review_reviewers`); `/admin/review` without it (or with an unknown code) shows the picker, `/admin/review/:batch` without it redirects there (302; `format=json` → 400). All links and POST bodies carry the code on. **Language**: Russian by default (assessors), English switch in the toolbar; `?lang=ru|en` sets the `review_lang` cookie (1 year, path `/admin/review`, httpOnly), and `<html lang>` follows. Every visible string comes from `lib/i18n.js`; only `_html` keys may hold markup (repo-owned files), the rest is escaped; verdict values stay English identifiers in the DB and JSON, only labels are translated; client-side texts go to the inline script in `STATE.i18n`.
  - **First come, one holder** (`prv/repository/review.js`, `STATE`): batches are not assigned. The `prv_review_batches` row holds `reviews_needed`, `excluded` and the lock (`locked_by`, `locked_at`); per batch `workers` = reviewers with a verdict on any item, `finished` = with a verdict on every item. State for reviewer R, first match wins: `mine` (R holds it), `done` (R ∈ finished), `closed` (R ∈ `excluded`, even while someone holds it), `locked` (another holder), `available` (no holder, R not finished, and R ∈ workers — back after giving up — or `|finished| < reviews_needed`, so a second review goes to everyone except those who worked on it), else `closed`. Only `mine` and `done` may decide (a finisher can still fix their verdicts).
  - `GET /admin/review?reviewer=…&verifyBearerToken=…[&show=all][&format=json]` — batch list in sections In work / Available / Locked by others / Done (`closed` rows only with `show=all`), with state, total and R's decided / open per batch, most recently imported first. JSON: `{reviewer, batches}`, rows `{batch, total, decided, open, reviews_needed, finished: [codes], locked_by, locked_at, state}` (`state` ∈ `mine | available | locked | done | closed`); without a reviewer `{reviewers, reviewer: null}` (400 for an unknown code). The picker has a "create reviewer" form under the name list.
  - `POST /admin/review/reviewers?verifyBearerToken=…` — body `{name}` (form or JSON); the cleaned name (`lib/reviewer-name.js`) is the code. Taken in any letter case (compared in JS under a table lock) → `taken`, bad name → `invalid`. Form: 303 to the new reviewer's batch list, or 400 with the picker, the typed value and the reason; JSON: `201 {code}` or `400 {reason, message}`.
  - `POST /admin/review/:batch/take` / `…/release?verifyBearerToken=…` — body `{reviewer, force?: boolean}`. Take locks a batch available to R in one `UPDATE … WHERE` with the availability check, so of two concurrent takes exactly one wins (taking your own batch again is a no-op). Release clears the holder's own lock ("Give up"; verdicts stay), or anyone's with `force: true` (the page asks for a confirm naming the holder; covers an assessor who disappeared). `200 {batch, locked_by, locked_at}`, 400 bad input / unknown reviewer, 404 unknown batch, `409 {reason, locked_by, message}` (`reason` = R's state, `message` in the page language).
  - `GET /admin/review/:batch?reviewer=…&verifyBearerToken=…&item=C7&format=json` — item page; without `item` R's first open item by `position`, or the last item when R has decided them all; 404 on unknown batch/item. "Open" and nav `decided` / first open / save → next open count R's verdicts, so a second reviewer starts at C1. A lock banner says R's state with one button: "Take it" (`available`), "Give up" (`mine`), force "Give up" naming the holder (`locked`); verdict controls are disabled unless R may decide. The verdict buttons and comment start from R's own latest verdict (`item.own_verdict`); the "Current verdict" block, history and `flagged_by` show everyone's (a second reviewer is not blind). Shows times in player format (`m:ss` / `h:mm:ss`), the stored `link` from the sheet (already at start − 2 s, used as is; `player_link` is `null` and no link is shown when it is not http(s)), cues, a short "How to decide" rules card (payer test, woven-in calls to action are still self_promotion, unclear only when the text does not decide, track flag is separate), and a signals panel (±30 s, across all `videos` rows of the native_id: live markups with author rating, calculated segments with rating + vote counts, undo/click counts). JSON shape `{reviewer, batch (R's progress row, as in the list), can_decide, item, video_flags: {track_mismatch}, nav: {prev, next, first_open}, signals}`; nav entries are `{item_code, decided, player_link}`. Switching items (`j`/`k`, plain click on ◀/▶/first open, save → next item) also preloads the new item's player behind the review page by swapping tabs: the new item opens in a new tab in front, the current tab navigates to the player (a page can neither open a tab behind itself nor open one on load). Popup blocked or no link → plain navigation, no player. A successful save closes the saved item's player tab (the review tab's `window.opener`, only when cross-origin; a same-origin opener is the batch list). The browser closes only script-opened tabs, so the batch list opens a batch with `window.open`; a player in a tab the reviewer opened stays and the save flash says to close it by hand. **Verdict** = what the text is (four buttons). **Track flag** (checkbox, hotkey `5`): "Subtitle track ≠ video", a per-video fact in `prv_review_video_flags` (`track_mismatch`, append-only, latest wins), shown pre-checked with who set it on every item of that video; independent of the verdict (replaced the pre-2026-10-18 "Wrong text" shortcut, which saved `unclear` with a canned Russian comment; such verdicts are shown as legacy and should be re-decided). Hotkeys: `1`–`4` verdict, `5` flag, `c` comment, `Enter` / Ctrl+Enter save, `j`/`k` next/prev, `o` open player, `Esc` leave a field; letters also work by physical key on a non-Latin (e.g. Russian) layout. The letter keys are one list, `LETTER_HOTKEYS`, read by the key handler (via `STATE.letters`), the hotkeys line and the onboarding table (`hotkeyRows()`), so the help cannot drift. Saving the same verdict and comment the same reviewer already has, with the flag unchanged, is "No change" on the page; the server also never appends a duplicate verdict row for the same reviewer (so a flag-only save writes only the flag), while another reviewer saving the same verdict adds a row.
  - `POST /admin/review/decide?verifyBearerToken=…` — body `{item_id (JSON integer), verdict: 'sponsor'|'self_promotion'|'not_ad'|'unclear', comment? (string or null; trimmed, blank → null), reviewer (registered code), track_mismatch? (boolean)}`. `409 {reason, locked_by, message}` unless R holds the batch or has finished it. Appends a `prv_review_verdicts` row (`source='page'`) unless identical to the item's latest row by the same reviewer, and a `prv_review_video_flags` row when `track_mismatch` differs from the video's current value; returns `201 {item_id, item_code, verdict, track_mismatch, flagged_by, next_item, next_player_link}` (`next_item` = R's next open item after this one, wrapping round, `null` when R is done); R's verdict on the last open item releases their lock (`releaseIfFinished`), so the batch moves to `done`. `400` on invalid input, unknown reviewer or unknown item.
  - **Onboarding**: a `<details>` block, closed by default, on the batch list and the item page (not on the picker): what this is, workflow (take → item by item → finishes on the last verdict; give up), verdicts, track flag, player window, −2 s start, hotkeys, comments → shared chat. Sections `ONBOARDING_SECTIONS`, keys `onb_<section>_title` / `onb_<section>_html`.
  - **Blind rule**: `flagged_by` (which detector runs flagged the segment) is stripped in the repository from every item without a verdict, so neither HTML nor JSON shows it until the item is decided.
- **`prv/routes/routes.js`** — Health check (`GET /`) and Prometheus metrics (`GET /metrics`).

### Authentication

- **Admin routes**: `Authorization: Bearer <AUTH_TOKEN>` header (middleware `verify-bearer-token.js`)
- **Admin pages** (`/admin/video`, `/admin/moderation`, `/admin/user`, `/admin/review`): `AUTH_TOKEN` as `?verifyBearerToken=` query param, checked directly in `prv/routes/admin.js`, `admin-moderation.js` and `admin-review.js`. `admin-review.js` also refuses every request when `AUTH_TOKEN` is unset, and its pages send no `Referer` (the token is in the URL).
- **Grafana GET links in `votes.js`** (`/votes/:id/delete`, `/votes/user/:internal_user_id/update-rating`, all providers): the same query param, checked by `middleware/verify-query-token.js` before any validator.
- **API docs** (`/api/doc`): HTTP Basic Auth — username `admin`, password `AUTH_TOKEN` env var
- Public write endpoints (markup creation, votes) are unauthenticated
- `POST /markup` silently returns 201 (no markup row created) when the user's `banned_at IS NOT NULL`, parallel to the existing `rating ≤ -2` soft gate.

### Database Models

| Model | Notes |
|-------|-------|
| `Markup` | User-submitted segment; soft-deleted via `deleted_at` |
| `MarkupTimeInterval` | start/end times belonging to a Markup; also soft-deleted |
| `MarkupCategory` | Enum: intro, sponsor, self_promotion, credits |
| `Video` | Video reference with optional duration |
| `VideoCalculated` | Aggregated JSON array per video (1:1 with Video). Each entry: `category_id`, `start`, `end`; `rating` present only when non-zero. The old `meta` column was dropped on 2026-10-18 (`lib/schema.js`) |
| `CalculatedSegment` | One row per aggregated segment — table `{provider}_calculated_segments`; carries `rating`, derived from the votes table (calculator, vote handler, `--recompute-ratings`) |
| `CalculatedSegmentMarkup` | Junction linking a `CalculatedSegment` to each contributing `Markup` — table `{provider}_calculated_segment_markups` |
| `Vote` | User vote on a calculated segment (-1, 0, +1) |
| `User` | Internal user mapped to prv user ID; tracks `rating`, `time_saved`, and `banned_at` (hard ban — set by admin via /admin/moderation/decide or automatically when rating ≤ -100; gates POST /markup independently of the soft `rating ≤ -2` check) |
| `AdminDecision` | Append-only log of admin moderation decisions — table `prv_admin_decisions` (prv only — no rt_ / yt_ analogue exists; moderation is prv-scoped per plan). Fields `target_type` ('user'\|'markup'), `target_id`, `decision` ('approve'\|'reject'), `signals_snapshot` (JSONB), `decided_at`, `decided_by` ('admin'\|'auto'). Latest row per target acts as a watermark for the re-surface threshold on /admin/moderation. All writes go through `moderationRepository.recordDecision()` — both the admin POST endpoint and the auto-ban hook share this single entrypoint to keep `signals_snapshot` consistent. |
| `DurationLog` | Tracks claimed video durations for anomaly detection |
| `CalculatorHeartbeat` | Defined in `db.js` (shared, no provider prefix) — table `calculator_heartbeats`, one row per `provider` written by the Go calculator at the end of every run (see Calculation Algorithm step 4), read by `GET /metrics`. Node never writes it |
| `IntervalUndo` | Records interval undo events — table `{provider}_events_interval_undo` |
| `IntervalClick` | Records interval click events with `click_time` — table `{provider}_events_interval_click` |
| `TimeSavedEvent` | Records time_saved events — table `{provider}_events_time_saved` |
| `ClientFailed` | Records client-side failures with free-form `reason` and `data` JSON — table `{provider}_events_client_failed` |
| `ReviewItem` | One AI-flagged segment from an imported review sheet — table `prv_review_items` (prv only). Fields `batch` (sheet name), `item_code` (`C7`), `position`, `native_id`, `start`/`end` (seconds, from key.tsv), `proposed` (`sponsor` or `sponsor+self_promotion`), `cues`, `link` (player link from the sheet, required by the importer), `flagged_by` (JSONB run ids, blind until decided), `created_at` (DB-side default). Unique `(batch, item_code)`. The importer writes items via `reviewRepository.insertItems()` / `itemsInBatch()` (no review-table SQL in `scripts/`) |
| `ReviewVerdict` | Append-only assessor verdicts — table `prv_review_verdicts`, FK `item_id` (cascade). `verdict` (`sponsor`\|`self_promotion`\|`not_ad`\|`unclear`), `comment`, `reviewer` (a `prv_review_reviewers` code; md imports: `--reviewer`, default `bayanovea`), `source` (`page`\|`import`), `decided_at` (DB-side default `CURRENT_TIMESTAMP`, also set on existing tables by `bootstrap()`). Latest row per item (`decided_at DESC, id DESC`) is the verdict, older rows are history. All writes go through `reviewRepository.recordVerdict()` (page and importer), which throws `ReviewInputError` (→ 400) on bad input |
| `ReviewReviewer` | Reviewer codes — table `prv_review_reviewers` (`code` PK, `created_at`). Seeded with `REVIEWERS` (`bayanovea`, `gkshi`) in `lib/schema.js`; assessors add themselves on the picker (`reviewRepository.createReviewer()`, unique in any letter case). Verdicts, flags and locks carry these codes |
| `ReviewBatch` | One row per review batch — table `prv_review_batches` (`batch` PK = the items' batch name). `reviews_needed` (INT, default 1: how many reviewers must finish it), `excluded` (TEXT[], default `{}`: codes that may never take it), `locked_by` / `locked_at` (current holder, null = free), `created_at`. Written by the importer (`createBatch()`) and the lock calls; "who worked on / finished it" is derived from verdicts, not stored |

**Soft Deletes:** All queries must filter `deleted_at IS NULL`. This is handled in `repository/` — always check there when writing new queries.

**Dual User ID System:** Users have both a `generated_user_id` (UUID) and an optional `prv_user_id`. The codebase is transitioning to internal DB `id` references.

**Schema bootstrap:** project has no migrations folder. New tables come from `sequelize.sync()` (run on every boot in `db.js`); new columns on existing tables are added with idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements run right after `sync()`. Example: `banned_at` on `users`. Column defaults go the same way (`ALTER TABLE … ALTER COLUMN … SET DEFAULT …`, e.g. the review tables' `created_at` / `decided_at`). The sync, the ALTERs and category seeding live in `lib/schema.js` `syncSchema()`, shared by `bootstrap()` and `scripts/sync-db.js`, so both leave the DB in the same shape — add new ALTERs there. One-offs live there too, guarded so a second boot is a no-op: `dropBatchAssignee()` (2026-10-20) runs only while `prv_review_batches.assignee` exists and, in one transaction, sets `excluded = {bayanovea}` on `gkshi` batches (blind copies of her sheets), locks every batch whose assignee has not finished it on that assignee (`gkshi` only once started, so untouched overlap batches go to anyone else), then drops the column.

### Prometheus Metrics (`prometheus-wrapper.js`, `server.js`)

Two custom counters and one HTTP histogram are exposed on `GET /metrics` (served by `server.js`, not by `express-prom-bundle`'s autoregister — `/metrics` is in `excludeRoutes` so it doesn't record itself).

**`video_calculated_lookup_total{outcome, provider}`** — outcomes of `GET /video-calculated`. `provider` is `prv` / `rt` / `yt`. `outcome` is one of:

| Outcome | Definition |
|---|---|
| `match` | Request supplied `duration`; row found by `(native_id, duration ± 2)`; `VideoCalculated` row exists. |
| `backfilled` | Request supplied `duration`; no `± 2` match; a row with `duration = NULL` existed and was just updated to the request's duration; `VideoCalculated` row exists. |
| `mismatch` | Request supplied `duration`; no `± 2` match; no `NULL` row to backfill; helper fell through to `findOne({ native_id })` and returned a row whose stored duration differs by > 2 s; `VideoCalculated` row exists. |
| `no_duration` | Request had no `duration` query param (legacy client); helper fell through directly to `findOne({ native_id })`; `VideoCalculated` row exists. |
| `not_calculated` | Helper returned a `Video` (any of the four above) but no `VideoCalculated` row was found; caller overrides the helper's outcome to `not_calculated`. |
| `not_found` | Helper returned `null` (no `Video` row matched at all). |

The first five outcomes are emitted by `lib/find-video-for-read.js`; `not_calculated` is derived in the route handler when `VideoCalculated.findOne` returns null. prv's legacy `!req.query.v` branch in `prv/routes/videos.js` does **not** emit a lookup outcome — it only increments `request_without_version_total`.

**`request_without_version_total{method, provider}`** — count of legacy client requests that omit the `v` query/body param. `method` is the route key (`GET /video-calculated`, `POST /markup`).

**`calculator_last_run_timestamp_seconds{provider}`**, **`calculator_last_success_timestamp_seconds{provider}`**, **`calculator_failed_videos{provider}`** — unix time of the Go calculator's last run / last run with no failed video, and the number of videos that failed in the last run (0 included), from `calculator_heartbeats` (one row per provider, see Calculation Algorithm step 4), read on every scrape by one shared `collect()` callback that `registerCalculatorHeartbeat(sequelize)` in `prometheus-wrapper.js` installs (called from `server.js` after `bootstrap()`, so the module stays DB-free for `test/prometheus-wrapper.test.js`). A provider without a row (or, for the success gauge, with `last_success_at` NULL) has no series; a failing query is logged once and leaves all three gauges empty for that scrape, the rest of `/metrics` is unaffected. The `CalculatorStale` alert watches the success gauge and `CalculatorFailedVideos` the failed-videos one (see Grafana → Alerting).

**`http_request_duration_seconds_{bucket|count|sum}{method, path, status_code}`** — `express-prom-bundle` histogram with buckets `[0.05, 0.1, 0.25, 0.5, 1, 2.5]`. `path` is normalized via `normalizePath` rules in `server.js` so dynamic segments collapse (`/admin/video/12345` → `/admin/video/#video_id`, `/markups/42` → `/markups/#id`, `/admin/review/<batch>` → `/admin/review/#batch` except `/admin/review/decide` and `/admin/review/reviewers`, `…/<batch>/take|release` → `/admin/review/#batch/take|release`, etc.). The default `url-value-parser` catches any unmapped numeric/UUID IDs as defense-in-depth.

**Storage / scrape:** Prometheus scrapes `app:3022/metrics` every 30 s and stores data on the `prometheus_data` named Docker volume (mounted at `/prometheus` in the container; pinned project name `native-ad-skip-api` → stable volume `native-ad-skip-api_prometheus_data`). Retention is bounded by **both** `--storage.tsdb.retention.time=30d` and `--storage.tsdb.retention.size=2GB`; whichever hits first wins, so the volume can never exceed ~2 GB. The size cap exists because the `path` label on `http_request_duration_seconds` is effectively unbounded (unmatched/404 URLs each create their own series), which previously grew the volume to 35 GB. Prometheus does not downsample — reclaiming space means dropping whole 2 h blocks, which it does on startup and every compaction cycle.

**Grafana:** the `grafana` service in `docker-compose.yml` (the old `../native-ad-skip-grafana` repo is superseded). All services attach to the external `main-network` (precondition on the host: `docker network create main-network`). Datasources are provisioned from `grafana/provisioning/datasources/datasources.yml`: Prometheus at `http://prometheus:9090`, Postgres at `${DB_HOST}:5432` (= `host.docker.internal`). Dashboards are provisioned from `grafana/dashboards`; ad-hoc UI edits live only on the `native-ad-skip-api_grafana_data` volume. Data links that call the API's GET admin endpoints (vote/markup delete, update-rating) in `tables.json` and `assessors.json` take the token from a `verifyBearerToken` textbox variable that starts empty: type `AUTH_TOKEN` into it, or open the dashboard with `?var-verifyBearerToken=…`. Never commit a token value into a dashboard. Grafana listens on plain HTTP `:3024` (`http://${HOST_IP}:3024/`), open to the internet by a Timeweb cloud firewall rule and protected only by its login (anonymous access and sign-up disabled). Plain HTTP means the password crosses the network unencrypted, and its Postgres datasource uses the app's read-write `DB_USER`. Docker-published ports bypass host `ufw`; the **Timeweb cloud firewall** is the only filter, so to close Grafana remove the 3024 rule there (or bind it to `127.0.0.1` and use `ssh -L 3024:localhost:3024`).

**Alerting:** provisioned from the repo, folder "native-ad-skip-api", evaluation group `api` every minute, on the Prometheus datasource (`StaleMarkups` on the Postgres one). `grafana/provisioning/alerting/rules.yml` has six rules; `noDataState: OK` unless said otherwise (a rule removed from the file stays in Grafana and keeps firing until its uid is listed under `deleteRules` there, as `lookup-not-found-share` is since 2026-10-19):
- `CalculatorStale` — `time() - max by (provider) (calculator_last_success_timestamp_seconds) > 600` for 5 min; no data at all = the calculator never ran, so `noDataState: Alerting`.
- `Http5xx` — `sum(increase(http_request_duration_seconds_count{status_code=~"5.."}[5m])) > 5` for 5 min.
- `ApiDown` — `up{job="native-ad-skip-api"}` below 1 for 2 min (queried unfiltered: `up == 0` is empty while healthy); no `up` series = Prometheus is not scraping the app, so `noDataState: Alerting`.
- `HttpLatencyP95` — `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m]))) > 1` for 5 min (the top bucket is 2.5 s, the quantile saturates there).
- `CalculatorFailedVideos` — `max by (provider) (calculator_failed_videos) > 0` for 3 min (three cron runs); the summary says to look for `Calculate video failed: <video_id>` in `docker logs`.
- `StaleMarkups` — Postgres: `COUNT(*)` of `markups` with `is_new = true`, `deleted_at IS NULL` and `"updatedAt"` older than 10 min, `> 0` for 5 min (every `is_new = true` writer is a Sequelize update, which bumps `updatedAt`; prv only, rt/yt have no data).

`policies.yml` routes everything to the one contact point `telegram` (group by alertname, `group_wait 30s`, `group_interval 5m`, `repeat_interval 4h`). The contact point is **not** a file in that directory: Compose renders it from the `configs:` block of `docker-compose.yml` into `/etc/grafana/provisioning/alerting/contact-points.yml` (needs Compose 2.23.1+, prod has 2.40.3), with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from the deploy environment — GitHub Actions secrets, never in the repo. Grafana's own `$VAR` expansion cannot be used for the chat id: Grafana 12.3.1 turns an env var that parses as a number into a YAML number and the Telegram integration requires `chatid` to be a string, so provisioning fails and Grafana refuses to start. **Missing secrets:** with both variables empty Grafana exits 1 at start (`Failed to provision alerting … could not find Bot Token in settings`) and crash-loops under `restart: unless-stopped`; `docker compose up -d` still returns 0, so the deploy job passes and `app` / `prometheus` are unaffected, but Grafana is down until the two secrets exist. Verified locally with Compose 2.40.3 and `grafana/grafana:12.3.1` on 2026-10-18.

### Environment Variables

```
DB_NAME, DB_USER, DB_PASSWORD, DB_HOST   # PostgreSQL connection (prod: DB_HOST=host.docker.internal, set in docker-compose.yml)
DB_PORT=5432                              # Optional; honoured by db.js and lib/script-db.js (sync-db.js, the review importer) (e.g. 5433 for the local dump). The Go calculator ignores it (hardcodes 5432)
NODE_APP_PORT=3022                        # HTTP server port
AUTH_TOKEN                                # Admin bearer token
ENV=dev|production                        # Controls yarn dev vs yarn start
```

### Deployment

Prod is a single Timeweb Cloud VM in Almaty, `ala-1` (Ubuntu 24.04, `${HOST_IP}`; Novosibirsk had no capacity), migrated from Yandex Cloud in Oct 2026 — see `docs/plans/completed/20261014-timeweb-migration.md`.

- **CI/CD:** GitHub Actions (`.github/workflows/deploy.yml`), on push to `main` or manual dispatch. A `test` job runs `make test-unit`, `go test -mod=vendor ./calculator` (`TestIntegration` skips when neither `TEST_DB_NAME` nor `DB_USER` is set) and `make test-e2e`; the `deploy` job `needs:` it, so a red test never deploys or pushes an image (one deploy at a time, `concurrency: deploy-prod`). The deploy job builds the image in CI (`docker/build-push-action`, GHA layer cache) and pushes it to GHCR as `ghcr.io/odedohbest/native-ad-skip-api:<commit sha>` and `:latest`, logging in with the job's `GITHUB_TOKEN` (`permissions: packages: write`). It then tars the checkout (without `.git` / `node_modules`) over SSH as `skipper-admin` to `/home/skipper-admin/tmp/codebase.tar.gz`, extracts it into a fresh `/home/skipper-admin/tmp/src/` (the previous checkout moves to `src.old/`, so files deleted from the repo do not linger; prometheus/grafana configs are bind-mounted from there), logs the host into GHCR with the same job token (expires with the job; `docker logout` on exit), and runs `docker compose -p native-ad-skip-api -f …/tmp/src/docker-compose.yml pull app` then `up -d --no-build --force-recreate --remove-orphans app prometheus grafana` with `IMAGE_TAG=<sha>`, under `set -e`. The remote script and its secrets go over stdin to `ssh … 'bash -s'` (`printf %q` exports), not on the remote command line. There is no `down` and nothing is built on the host (`--no-build`: the `app` service keeps `build: .` for local runs): the old stack keeps serving through the pull and stays up if it fails; the API is down only for the container swap. The host key is pinned in the workflow (ed25519, `StrictHostKeyChecking yes`), so a rebuilt VM needs the new key there. Secrets: `HOST_IP`, `SSH_PRIVATE_KEY`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `NODE_APP_PORT`, `AUTH_TOKEN`, `GF_ADMIN_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (Grafana alerting, see Alerting; without them Grafana does not start). Supervisor inside the app container manages cron (Go CLI) and the Node.js app.
  - **First deploy with the `src/` layout** (2026-10-18): before it, the compose file and the bind-mounted `config/`, `grafana/` lived directly under `/home/skipper-admin/tmp/`. The stack is addressed by project name (`-p native-ad-skip-api`) and the named volumes keep their names (`native-ad-skip-api_prometheus_data`, `_grafana_data`), so the new compose path recreates the same containers with the new mount paths; the old files directly under `tmp/` (everything except `src/`, `src.old/`) can be deleted by hand after the first successful deploy.
  - **Rollback:** Actions → "Build and Run Docker Image on Timeweb" → Run workflow with `image_tag` = the previous commit sha (any sha CI has pushed; `:latest` stays at the newest build). The job skips the build and deploys that tag, tests included. By hand on the host, as long as the image is still in the local Docker cache (no registry login needed): `IMAGE_TAG=<sha> docker compose -p native-ad-skip-api -f /home/skipper-admin/tmp/src/docker-compose.yml up -d --no-build app`.
  - **GHCR visibility** follows the repo: the repo is private, so the package is private and the job token is the only login the host ever uses. A manual `docker pull` on the host would need a PAT with `read:packages` (`docker login ghcr.io`), and `docker logout ghcr.io` afterwards.
- **DNS:** reg.ru, zone `${DNS_ZONE}` on reg.ru's free NS; A records `api`, `www.api`, `test-api`, `adskip`, `www.adskip` → `${HOST_IP}`, zone TTL 1h (panel minimum). `api` (this repo's vhost) and the landing `adskip` (static Vue build in `/var/www/landing`, `www` redirects to it) have vhosts and certs; the landing's vhost `/etc/nginx/sites-available/landing.conf` is not in this repo.
- **TLS / reverse proxy:** nginx on the host terminates TLS for `${API_HOST}` (Let's Encrypt, certbot webroot renewals) and proxies to `127.0.0.1:3022`. The vhost is versioned in `infrastructure/nginx/` and copied to the host by hand; its access log uses the `redacted` format (`redacted-log-format.conf` in `conf.d/`: no query string, no referer), so `?verifyBearerToken=` is not logged. `.dev` is HSTS-preloaded, so the API is HTTPS-only.
- **Postgres:** PostgreSQL 16 installed on the host via apt, not in Docker. Containers reach it at `host.docker.internal` (`extra_hosts: host-gateway`); `pg_hba` + `ufw` allow only `172.16.0.0/12` (Docker bridges) and localhost, so 5432 is never public.
- **Backups:** Timeweb VM auto-backups (daily, keep 7) plus `make pull-dump` (`scripts/pull-prod-dump.sh`), which streams a gzipped `pg_dump --no-owner` over SSH to `~/Web/dumps/adskip-prod/` on the owner's Mac (`latest.sql.gz` symlink) — run weekly. The nightly S3 job (`infrastructure/backup/pg-backup.sh`, restore drill in its README) is written but **not installed yet**: `docs/backlog/offhost-pg-backup-s3.md`.
