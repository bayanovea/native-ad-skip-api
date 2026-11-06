# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The full reference lives in `docs/reference/` (`ops.md`, `ai-first.md`, `routes.md`, `models.md`, `metrics.md`,
`deployment.md`); the sections here of the same name summarise them and keep the invariants. A "see X" names a section
here or in one of those files. A behaviour change updates the reference file that describes it, and the summary here
when an invariant changes.

## Project Overview

**native-ad-skip-api** is a hybrid Node.js + Go service for crowdsourced video ad/segment skipping on three video platforms, which the repo never names: `prv` is the main provider (the platform the browser extension and the AI-first path serve), `rt` and `yt` two more with the same API (see Providers). Users submit time-interval markups (intro, sponsor, self_promotion, credits). A Go CLI aggregates markups into consensus boundaries stored in `VideoCalculated`, which clients poll to skip ads. AI-first (prv, behind flags, all off by default): a second Go command detects segments from the platform's auto subtitles with an LLM (Claude, or OpenAI through `AI_DETECT_CLIENT`) into `prv_ai_video_calculateds`, served instead of the human segments when `AI_FIRST=on`, and judges them on user signals (see AI-first segments); with `AI_SECOND_ENABLED=on`, a second model (OpenAI or Claude) must find a segment too before it is served.

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

# AI command (prv only, see AI-first segments); the binary sits next to its main.go, as calculate does
go build -mod=vendor -o prv/commands/ai/ai ./prv/commands/ai/
./prv/commands/ai/ai detect               # one cron tick (exits 0 at once unless AI_DETECT_ENABLED=on)
./prv/commands/ai/ai detect <native_id>   # manual run for one video: ignores the switch, the views / requests thresholds and the budget; synchronous; no heartbeat
./prv/commands/ai/ai judge                # one judge tick (exits 0 at once unless AI_JUDGE_ENABLED=on)
./prv/commands/ai/ai regate [--backfill]  # move AI entries between data and hidden by the current rules (see Ops)
./prv/commands/ai/ai audit               # one audit tick (exits 0 at once unless AI_AUDIT_ENABLED=on, see Ops → Audit)
./prv/commands/ai/ai audit <batch>       # audit one finished batch now: ignores the switch and the due rules; no heartbeat
```

### Tests

```bash
go test ./calculator                            # Go unit tests; TestIntegration skips unless TEST_DB_NAME is set
                                                # in the env (make test-calculator)
go test ./calculator -run TestFindMedian        # Run a single test
go test -mod=vendor ./ai/...                    # AI command unit tests (sqlmock, fixtures; no DB, no network)

make test-calculator                            # Go integration tests against a real Postgres
                                                # (requires DB_USER/DB_PASSWORD in env)
make test-e2e                                   # Full Docker e2e: spins up Postgres + Node app
                                                # and exercises HTTP endpoints + Go calc binary
make test-unit                                  # DB-free Node unit tests (no Docker)
go vet ./...
```

`make test-e2e` runs `test/e2e.js` (Node `node:test`) and is the canonical end-to-end suite. It also runs `test/moderation-resolver.test.js`, `test/review-export.test.js` (the review export SQL in its own DB and `scripts/import-verdict-bounds.js`, plus `scripts/export-review-verdicts.sh` through psql: the e2e compose file builds the image with `EXTRA_PACKAGES=postgresql-client`, the prod image has no psql) and `test/legacy-rename.test.js` (the `LEGACY_PRV` rename one-off on `old_*` DDL in its own DB, see Schema bootstrap). The e2e compose sets `LEGACY_PRV: old`, so `test/e2e.js` also covers the API alias (`legacy alias:`). The `ai…:` tests of `test/e2e.js` drive the real `ai` binary with no network: `YTDLP_BIN` = `test/fixtures/ai/yt-dlp-stub.sh` (canned `<native_id>.info.json` + `.ru.vtt`) and `AI_CLIENT=fixture` (canned `<native_id>.detect.json` / `.judge.json`), set in `docker-compose.e2e.yml`; the `ai second:` tests add `AI_SECOND_ENABLED=on` + `AI_SECOND_CLIENT=fixture` per run (`<native_id>.second.json`, `.second-error`); a second app with `AI_FIRST=on` runs on port 3098 next to the default one, same DB. Fixtures use placeholder ids (`-1_456000…`), never real prv ids. `make test-unit` runs the DB-free unit tests: `test/review-sheet.test.js`, `test/find-video-for-read.test.js`, `test/find-ai-calculated.test.js`, `test/prometheus-wrapper.test.js`, `test/redact-request.test.js`, `test/validate-intervals.test.js`, `test/i18n.test.js`, `test/reviewer-name.test.js`, `test/parse-views-text.test.js`, `test/ai-rules.test.js`, `test/legacy-field.test.js`, `test/player-link.test.js`.

### Ops

Every ops command and what each script does: `docs/reference/ops.md`. What to know without opening it:

- Weekly backup: `PROD_HOST=root@${HOST_IP} DB_NAME=${DB_NAME} make pull-dump` (gzipped `pg_dump` over SSH →
  `~/Web/dumps/native-ad-skip-prod/`, `DUMP_DIR` overrides).
- A hand run that writes ratings or AI rows goes inside the app container under its cron job's lock, so it never
  overlaps a tick: `flock /tmp/calculate-<provider>.lock … calculate --recompute-ratings`,
  `flock /tmp/ai-detect.lock … ai detect <native_id>` / `ai regate [--backfill]`, `flock /tmp/ai-audit.lock … ai audit <batch>`.
- AI switches are GitHub repository variables; a change takes a deploy (Run workflow, `image_tag` = the running sha).
  Kill switch `AI_FIRST=off`; one video: the withdraw link on `/admin/video/:video_id`.
- A rule change (`AI_MIN_SEGMENT_SECONDS`, `accepted()`) is an `ai regate` run, never a read-time filter.
- Detector / prompt: **eval first, then sync** (`scripts/sync-detector.sh ~/Web/native-ad-skip-eval`); never edit the
  copied `ai/` packages or the detector prompt here.
- Review tooling in `scripts/`: sheet import (`import-review-sheet.js`: parts of ≤ 30, one transaction, never writes the
  md), verdict export (`export-review-verdicts.sh` → the eval's `adskip review -file`), split, blind subset, bounds
  import, below-threshold / served-sample import, adopt, video flags export. Prod verdicts are the source of truth since
  2026-10-16; scripts reach prod over `ssh -N -L 5434:localhost:5432` or as postgres on the host; the local restored
  dump is `localhost:5433/skipper` (its review tables are stale).
- `ai audit` (hourly at :45): rule and model findings on finished review batches, shown to the owner on
  `/admin/review?reviewer=bayanovea`; the Telegram ping is off (`AI_AUDIT_TELEGRAM`).

## Architecture

### Dual-Process Design

Two independent runtimes managed by Supervisor inside Docker:
- **Node.js (Express)** — HTTP API: CRUD for markups, votes, and serving calculated results
- **Go CLI** — Cron job every minute: aggregates new markups into `VideoCalculated`; plus the prv `ai` command (`ai detect` every 5 min, `ai judge` hourly, `ai audit` hourly at :45, all no-ops unless switched on, see AI-first segments and Ops → Audit)

Communication is only through PostgreSQL. The Go binary reads `MarkupTimeInterval` rows where `is_new = true` and writes aggregated JSON to `VideoCalculated` plus relational rows in `{provider}_calculated_segments` (and the segment ↔ markup junction). Node reads `VideoCalculated.data` for client responses and recomputes the per-segment `rating` from the votes table (in both the JSON and the segments table) when a vote arrives or is deleted; the Go binary computes it the same way on every recalculation.

### Request Flow

```
Client → Express routes → Middleware (validate, auth) → Repository layer → PostgreSQL
                                                                ↓ (async, every minute)
                                                    Go CLI (calculate) → VideoCalculated
```

### Providers

The service supports three video platforms, each isolated in its own directory. The providers are two- or three-letter codes (`prv` = the main one; `rt`, `yt` the other two), and the platform's hosts and URL templates come from the deploy environment (see Environment Variables, Deployment).

| Provider | Mount path | Directory |
|----------|-----------|-----------|
| `prv` | `/` | `prv/` |
| `rt` | `/rt` | `rt/` |
| `yt` | `/yt` | `yt/` |

Each provider directory has the same internal layout:

```
<provider>/
  commands/main.go       # Go CLI entry point (passes table prefix to calculator)
  db/index.js            # Sequelize models scoped to this provider's table prefix
  routes/index.js        # Express router: prv/routes/provider-router.js over its models (prv adds its deps and admin pages, see below)
  repository/            # Raw Sequelize queries (prv/ only)
  routes/*.js            # Express route handlers (prv/ only)
  locales/review/        # Review page strings ru/en (prv/ only; loaded by lib/i18n.js, parity checked in test/i18n.test.js)
  service/               # Business logic (prv/ only; rt and yt reuse prv/service/user.js)
```

`rt` and `yt` have no route or repository code of their own. Every provider's `routes/index.js` calls
`prv/routes/provider-router.js` (`createProviderRouter(models, provider, prvDeps)`), which mounts the public prv routes
(`markups`, `videos`, `votes`, `users`, `events`) with its own `models` and the prv repositories, and gives `markups` /
`videos` (the routes with metrics) `provider` (the metric label); prv passes its prv-only deps (`aiRepository`,
`moderationRepository`, `durationLogRepository`, `legacyUnversioned`) and adds only the admin pages. prv's legacy no-`v` branch (`'-' + video_id`) is prv's alone (`legacyUnversioned`); on rt/yt a
request without `v` is only counted. Category ids are the same on all three: intro 3, sponsor 4, self_promotion 5,
credits 6, the ids the extension sends (`lib/schema.js` `CATEGORY_IDS`). A prv-only feature is skipped by what the provider lacks, never by a provider check: no
`models.AiVideoCalculated` (AI row lock and lookup), no `aiRepository` (AI queue, `views_text`), no `banned_at` on its
users (ban gate), no `moderationRepository` (auto-ban). A route change therefore lands on all three providers.

### Key Directories

| Path | Purpose |
|------|---------|
| `prv/`, `rt/`, `yt/` | Per-provider models, routers and Go CLI entry points; route handlers and repositories live in `prv/` |
| `ai/` | AI command packages (Go, prv only): `detector`, `transcript`, `vtt`, `provider`, `ytdlp` are synced copies from the eval repo (see Ops → Detector sync; `ai/SOURCE` = the eval commit; product-owned `detector/fixture.go` = `AI_CLIENT=fixture` and, with the suffix `.second.json`, `AI_SECOND_CLIENT=fixture`; `detector/openai.go` = the synchronous OpenAI transport, `detector/openai_batch.go` = the OpenAI Batch API one), `platform/` (product-owned: `platform.FromEnv()` registers the provider `prv` with `provider.Register(Def)` from `PROVIDER_VIDEO_URL` / `PROVIDER_LINK_AT` on its first call and returns it; `ai detect` and `ai judge` call it after their switch check, so a missing variable is their startup error (exit 1), a switched-off tick and `ai regate` never read them; Go tests register the e2e templates themselves, `testPrv`), `pipeline/` (`ai detect`: `queue.go`, `detect.go`, `gate.go`, `publish.go`, `confirm.go` (the second opinion), `chapters.go` (the chapter check); `ai regate`: `regate.go`), `judge/` (`ai judge`: `signals.go`, `rules.go`, `llm.go`, `review.go`, `judge.go`), `review/` (`review.Add` / `Batch`: the kind='ai' items and batch parts the Go callers write: the judge's, the second opinion's and the chapter check's; `openPart()` in `prv/repository/review.js` is its JS twin), `prompts/` (`v2.2.md` detector prompt from the eval, `judge-v1.md` and `audit-v1.md` product-owned), `audit/` (`ai audit`: `config.go`, `due.go`, `rules.go`, `llm.go`, `notify.go`, `audit.go`, see Ops → Audit). Entry point `prv/commands/ai/main.go`, binary `prv/commands/ai/ai` |
| `calculator/` | Shared Go source: `calculate.go` (algorithm), `recompute.go` (`--recompute-ratings`), `pool.go` (goroutine pool) |
| `middleware/` | Auth (`verify-bearer-token.js`; `verify-query-token.js` for the `?verifyBearerToken=` GET links of `votes.js`), validation, async error wrapper |
| `lib/` | Shared helpers: `find-video-for-read.js` (read-only video lookup), `duration-tolerance.js` (`DURATION_TOLERANCE = 2`, `durationMatchQuery()` — the `(native_id, duration ± 2)` where + order shared by the read helper and `prv/repository/video.js`, which rt and yt use too), `review-sheet.js` (review sheet parser, verdict normalisation, `formatPlayerTime` and its inverse `parsePlayerTime` (`s`, `m:ss`, `h:mm:ss`, else NaN), `validateVerdictBounds()` (the verdict bounds rules: `format` / `range` / `order`, else null; short bounds are valid, the page warns on them against `STATE.min_segment_seconds`; both inlined into the review page's script), `entryInsideSheetItem()` (an AI entry inside an old below-threshold sheet item's cue bounds, < 1 s each end; adopt's match, `hasItemAt`'s SQL twin), `splitSheet()` — items → balanced parts of at most N, shared by the importer and `splitBatch()`, `cuesOver()` — the cue texts over an entry's bounds, the item `cues` of the below-threshold importer and the admin link), `player-link.js` (`linkAt(native_id, seconds)` — the player link from the `PROVIDER_LINK_AT` template (`{id}`, `{t}` = `1h2m3s`, read once on load; unset = `https://example.invalid/video{id}?t={t}`), the Go provider's format; callers pass start − 2), `legacy-field.js` (`legacyField()` — the `<legacy>_user_id` → `prv_user_id` request alias and `LEGACY_PRV` as read at boot, see Routes), `admin-html.js` (`escapeHtml`, `urlToken`, `formatDate`, `CATEGORY_COLORS` for the prv admin pages), `script-db.js` (`scriptSequelize()` — DB connection for `scripts/`), `schema.js` (`syncSchema()` — sync + idempotent ALTERs + category ids (`syncCategories()`, `CATEGORY_IDS` 3..6, see Schema bootstrap) and reviewer seeding (`REVIEWERS`), the 2026-10-18 one-off that gives verdicts of unknown reviewers to `bayanovea`, the 2026-10-20 `assignee` one-off (see Schema bootstrap) and a default `prv_review_batches` row for every batch of `prv_review_items`; used by `db.js` boot and `scripts/sync-db.js`), `i18n.js` (review page strings from `prv/locales/review/{ru,en}.json`: `translator(lang)` → `t(key, params)` returns HTML (escaped, except `_html` keys whose markup is kept and only params escaped), `t.text()` plain text for the inline `STATE` (throws on `_html`); both locales have the same keys (parity checked in `test/i18n.test.js`), an unknown key throws; `pickLang(req)`: `?lang=` → `review_lang` cookie → `ru`), `reviewer-name.js` (`validReviewerName()` — the cleaned name or null: NFC, trimmed, inner spaces collapsed, 1–64 letters of any script, digits, space, `.`, `_`, `-`; the route checks it before `createReviewer()`), `redact-request.js` (`redactRequest()` — request fields for the `server.js` error log with the `Authorization` header and `verifyBearerToken` (query and url) redacted), `validate-intervals.js` (`validateIntervals()` — `POST /markup` interval rules, shared by prv/rt/yt), `parse-views-text.js` (`parseViewsText()` — the prv page's view counter text → count or null, see AI-first segments → Trigger), `ai-rules.js` (`MIN_SEGMENT_SECONDS` from `AI_MIN_SEGMENT_SECONDS`, default 5, read once on load, invalid throws; `prv/repository/ai.js` requires it, so an invalid value fails boot), `segment-rating.js` (`lockVideoCalculated()`, `recomputeSegmentRating()` — a segment's rating from the votes table, per provider `models`; `recomputeAiSegmentRating()` the same for an entry of `prv_ai_video_calculateds.data` (JSON only), `voteRating()`), `find-ai-calculated.js` (`findAiCalculated(models, videoId, { transaction })` — the AI row served instead of `video_calculateds`, or null (`servesAi`: `AI_FIRST` off (read once at boot), no row, withdrawn or empty `data`); `lockAiCalculated()` — the row in any state `FOR UPDATE`, for the vote handlers; `AI_LOOKUP_OUTCOMES` = `match` / `backfilled`) |
| `scripts/` | Local/ops scripts: `sync-db.js`, `pull-prod-dump.sh`, review import/export (`import-review-sheet.js`, `subset-review-sheet.js`, `split-review-batch.js`, `import-verdict-bounds.js`, `import-below-threshold.js`, `adopt-review-items.js`, `export-review-verdicts.sh`, `export-video-flags.sh`), gold export (`export-gold.sh`), `sync-detector.sh` (eval detector → `ai/`), `rename-to-legacy.js` (the 2026-10-29 rename undone, for a rollback, see Deployment → Rollback) |
| `db.js` | Sequelize models and associations for all providers |
| `api/doc/openapi.yaml` | OpenAPI spec served at `/api/doc` |
| `grafana/` | Grafana provisioning configs and dashboard JSONs (`infrastructure`, `product-stats`, `tables`, `assessors`, `ai-pipeline` = the AI-first picture, see AI-first segments → Dashboard); service runs on port 3024 |

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
4. Heartbeat: once the pool is done, `Run` upserts the provider's row in the shared `calculator_heartbeats` table (`provider` PK `prv`|`rt`|`yt`, plus `ai_detect` / `ai_judge` / `ai_audit` written by the `ai` command (see AI-first segments, Ops → Audit), `last_run_at`, `last_success_at`, `failed_videos`): `last_run_at = NOW()` always, `last_success_at` only when `failed_videos = 0` (an idle run with no videos counts as a success). Single-video mode writes it too, `--recompute-ratings` does not. A failed write is logged (`Heartbeat write failed: <err>`) and exits 1 — e.g. the table is missing because Go cron fired before Node's first `sync()` on a fresh deploy; the next minute is fine. `GET /metrics` exposes the row as the `calculator_*_timestamp_seconds` gauges (see Prometheus Metrics), the "Calculator: seconds since last success" stat panel on `grafana/dashboards/infrastructure.json` shows it (thresholds 600 s red; overrides per provider: `ai_detect` orange 600 / red 900, `ai_judge` and `ai_audit` orange 3900 / red 7200).

Cron starts each provider's binary every minute (`crontab`, offsets 0/20/40 s) under `flock -n /tmp/calculate-<provider>.lock`, so a run still going when the next minute fires makes the new one exit at once instead of overlapping. Their output (stdout and stderr) is appended to `/proc/1/fd/1`, supervisord's stdout, so it shows in `docker logs` next to the Node app's. The e2e suite covers the rollback, the mid-run markup, the skipped locked row, ratings surviving a recalculation, `--recompute-ratings` and the heartbeat (`calculator:` tests in `test/e2e.js`).

The segment rows in `{provider}_calculated_segments` are the source of truth for joins (e.g. analytics) and carry the same `rating` that lives in `video_calculateds.data`. Both are derived from the votes table: by the calculator on every recalculation, by the vote handler on every vote or vote deletion (see Routes → `votes.js`), and by `calculate --recompute-ratings` (see Ops).

### AI-first segments (prv: `ai/`, `prv/commands/ai`)

Source of truth for the flow: `docs/reference/ai-first.md` (trigger, `ai detect`, serving, served vs hidden, second
opinion, chapters, `ai judge`, votes and verdicts, withdraw / restore, prompt, dashboard). OpenSpec specs in
`openspec/specs/`; plans `docs/plans/completed/20261022-ai-first-segments.md`, `20261027-ai-hidden-entries.md`,
`20261104-ai-flow-audit.md` (every state against every writer).

- Owner's rule: serve only segments we are sure the viewer sees correctly, even at the cost of missed ads.
- Every switch defaults off in code and `docker-compose.yml`; turning AI-first on is only ever the owner's env change,
  never a code default or a migration. Human markups keep being accepted on AI-first videos (the judge's strongest
  signal, the fallback after a withdraw).
- Flow: `GET /video-calculated` with `v` upserts `prv_ai_videos` → `ai detect` (community videos at `AI_MIN_VIEWS` or
  `AI_MIN_REQUESTS`, daily budget, highest score first: views, requests, freshness, channel history, human markup; a
  `seen` video older than 14 days is dropped) fetches the ru auto track with yt-dlp, gates the timeline, calls the
  detector model (a batch API), then the second model (`AI_SECOND_ENABLED`) and the chapter check (`AI_CHAPTERS_ENABLED`), publishes
  `prv_ai_video_calculateds` → served instead of `video_calculateds` with `AI_FIRST=on` on a `match` / `backfilled`
  lookup → `ai judge` reads new user signals and sends review items or withdraws.
- An AI row keeps every detected segment: `data` = exactly what is served, `hidden` = the rest with a `reason`
  (`confidence` | `short` | `review` | `unconfirmed`). Both are precomputed (publish, `applyVerdict`, `ai regate`),
  nothing is evaluated on the read path, and everything that reads `data` ignores `hidden`.
- A verdict on an ai review item acts on the entry at the item's effective bounds: a keep serves it (its bounds may move
  it and absorb covered pieces), `not_ad` / `unclear` hide it as `review`. Only a verdict restores a row withdrawn by
  `judge` / `review`; `admin` rows stay withdrawn.
- One interval, one vote: a vote belongs to `(category_id, start, end)` whichever source served it. `video_calculateds`
  is always locked before the AI row; each writer's full lock order is in the reference.
- **Keep the overview current**: a conceptual change (what is served when, the gates, the judge's decisions, what a
  verdict does, the switches) updates `docs/ai-first-overview/{ru,en}.html` and the "updated" date in their header in
  the same change, then republishes both artifacts (ru `6NZNwDcYKbLV5MUgKPwc8n`, en `SQhQy8xEPoY8XaxvKL4d6o`; one file
  each, `style.css` inlined, the cross-language link pointing at the other artifact).
- Every AI panel lives on `grafana/dashboards/ai-pipeline.json`. Its thresholds are literals tagged with their variable
  (`200000 /* AI_MIN_VIEWS */`, `20 /* AI_MIN_REQUESTS */`, `1100 /* AI_DAILY_BUDGET_VIDEOS */`,
  `INTERVAL '14 days' /* queue.go queueMaxAge */`) and the ad-chapter SQL with `/* chapters.go adTitle */`: changing the
  variable, the constant or the regexp updates every tagged literal in the same change.

### Routes

Every endpoint in detail: `docs/reference/routes.md`. The three providers share the route modules (rt/yt mount prv's, see
Providers); `prv/` also mounts the prv-only admin pages. With `LEGACY_PRV` set, `lib/legacy-field.js` copies
`<legacy>_user_id` to `prv_user_id` in query and body.

- `markups.js` — markup CRUD. `POST /markup` checks intervals with `lib/validate-intervals.js`, rejects rating ≤ −2,
  returns 201 without a row for a banned user; `PUT /markups` edits one interval. Deletes have GET twins for Grafana.
- `votes.js` — one transaction under the `VideoCalculated` lock, then the AI row's; the segment must be in what GET
  serves (else 404); recomputes the segment rating from the votes table and adjusts the authors' rating (auto-ban at
  ≤ −100); Grafana GET links for undo and rating override.
- `videos.js` — `GET /video-calculated` through the read-only `findVideoForRead` (`(native_id, duration ± 2)`, then a
  null duration, then any row, else 204); prv serves the AI row when AI-first applies and records `views_text`.
- `events.js` — `POST /events`: `interval_undo`, `interval_click`, `time_saved`, `client_failed`; an invalid event is
  logged and skipped.
- `admin.js` — `/admin/video/:video_id`: markups, the AI block, the withdraw and send-to-review links.
- `admin-moderation.js` — worst users / markups, approve / reject, per-user view (by `users.id`, not `prv_user_id`).
- `admin-review.js` — the assessor page: reviewer picker (`&reviewer=<code>`), ru/en (every string from
  `prv/locales/review/`, `lib/i18n.js`), batches first come with one holder (lock expires after 12 h idle), item page
  with the transcript window, verdict + optional bounds + track flag, `POST /admin/review/decide` (on an ai item also
  `aiRepository.applyVerdict` in the same transaction), the owner's audit block, blind rule (`flagged_by` hidden until
  the item is decided).
- `routes.js` — `GET /` health, `GET /metrics`.

### Authentication

- **Admin routes**: `Authorization: Bearer <AUTH_TOKEN>` header (middleware `verify-bearer-token.js`)
- **Admin pages** (`/admin/video`, `/admin/moderation`, `/admin/user`, `/admin/review`): `AUTH_TOKEN` as `?verifyBearerToken=` query param, checked directly in `prv/routes/admin.js`, `admin-moderation.js` and `admin-review.js`. `admin-review.js` and the AI withdraw link also refuse every request when `AUTH_TOKEN` is unset, and its pages send no `Referer` (the token is in the URL).
- **Grafana GET links in `votes.js`** (`/votes/:id/delete`, `/votes/user/:internal_user_id/update-rating`, all providers): the same query param, checked by `middleware/verify-query-token.js` before any validator.
- **API docs** (`/api/doc`): HTTP Basic Auth — username `admin`, password `AUTH_TOKEN` env var
- Public write endpoints (markup creation, votes) are unauthenticated
- `POST /markup` silently returns 201 (no markup row created) when the user's `banned_at IS NOT NULL`, parallel to the existing `rating ≤ -2` soft gate.

### Database Models

Fields and writers of every model: `docs/reference/models.md`.

| Model | Gist |
|-------|------|
| `Markup`, `MarkupTimeInterval` | user markups and their intervals, soft-deleted |
| `MarkupCategory` | intro, sponsor, self_promotion, credits = ids 3..6 on every provider |
| `Video`, `DurationLog` | native_id + optional duration; claimed durations |
| `VideoCalculated` | aggregated JSON per video, `rating` sparse |
| `CalculatedSegment`, `CalculatedSegmentMarkup` | `{provider}_calculated_segments` (source of truth for joins, carries `rating`) and the markup junction |
| `Vote` | −1 / 0 / +1 keyed by `(video_id, category_id, start, end)` |
| `User` | `rating`, `time_saved`, `banned_at` (hard ban) |
| `AdminDecision` | `prv_admin_decisions`, append-only, written only through `moderationRepository.recordDecision()` |
| `CalculatorHeartbeat` | `calculator_heartbeats`: one row per provider and `ai_detect` / `ai_judge` / `ai_audit`; Node never writes it |
| `IntervalUndo`, `IntervalClick`, `TimeSavedEvent`, `ClientFailed` | `{provider}_events_*` |
| `ReviewItem`, `ReviewVerdict`, `ReviewReviewer`, `ReviewBatch`, `ReviewAudit` | `prv_review_*`: items (`kind` sheet / ai), append-only verdicts (latest wins, written through `reviewRepository.recordVerdict()`), reviewer codes, batches and their lock, batch audits |
| `AiVideo`, `AiRun`, `AiVideoCalculated`, `AiJudgement`, `AiConfirmation`, `AiTimeline` | `prv_ai_*`: queue, detector runs (the budget counts them), served `data` / `hidden`, judgements, second-model calls, phase 3 (no writer) |

The Go side (`ai/review`) inserts review items and batches with its own SQL, so a change to those tables updates both
(and `openPart()` in `prv/repository/review.js`).

**Soft Deletes:** All queries must filter `deleted_at IS NULL`. This is handled in `repository/` — always check there when writing new queries.

**Dual User ID System:** Users have both a `generated_user_id` (UUID) and an optional `prv_user_id`. The codebase is transitioning to internal DB `id` references.

**Schema bootstrap:** no migrations folder. New tables come from `sequelize.sync()` on every boot; new columns and
defaults are idempotent `ALTER TABLE … IF NOT EXISTS` / `SET DEFAULT` in `lib/schema.js` `syncSchema()` (shared by boot
and `scripts/sync-db.js`): add new ALTERs there. Guarded one-offs live there too (2026-10-20 batch assignees,
2026-10-29 `renameLegacyObjects()` before `sync()` with `LEGACY_PRV`, 2026-11-03 null AI `data`, 2026-11-05 category ids:
only the exact old seed 1..4 with nothing written for the provider is renumbered, else a warning, never a failed boot); details in the reference.

### Prometheus Metrics, Grafana, Alerting

Every metric, scrape target, dashboard and alert rule: `docs/reference/metrics.md`.

- `GET /metrics` (served by `server.js`): `video_calculated_lookup_total{outcome, provider, source}` (outcomes `match` /
  `backfilled` / `mismatch` / `no_duration` / `not_calculated` / `not_found`), `request_without_version_total`, the
  `calculator_*` heartbeat gauges, the `ai_*` gauges, `http_request_duration_seconds` (paths normalised in `server.js`:
  a new dynamic route needs a `normalizePath` rule).
- Prometheus keeps 30 days **and** at most 2 GB (the `path` label is unbounded).
- Grafana on `:3024`, provisioned from `grafana/` (UI edits live only in its volume). Never commit a token into a
  dashboard: admin links read the `verifyBearerToken` textbox variable.
- Alert rules in `grafana/provisioning/alerting/rules.yml` go to the Telegram contact point, which Compose renders from
  secrets; a rule removed from the file must be listed under `deleteRules`. `AiCostDaily`'s threshold is a literal:
  change it with the budget or the second model.

### Environment Variables

```
DB_NAME, DB_USER, DB_PASSWORD, DB_HOST   # PostgreSQL connection (prod: DB_HOST=host.docker.internal, set in docker-compose.yml)
DB_PORT=5432                              # Optional; honoured by db.js and lib/script-db.js (sync-db.js, the review importer) (e.g. 5433 for the local dump). The Go calculator ignores it (hardcodes 5432)
NODE_APP_PORT=3022                        # HTTP server port
AUTH_TOKEN                                # Admin bearer token
ENV=dev|production                        # Controls yarn dev vs yarn start

# AI-first (prv). Default in parentheses; empty = default. Node reads only AI_FIRST and AI_MIN_SEGMENT_SECONDS (once at boot), the rest is the ai command's.
AI_FIRST (off)                            # on = serve prv_ai_video_calculateds (Node); off is the kill switch
AI_DETECT_ENABLED (off)                   # on = the ai detect cron tick works
AI_JUDGE_ENABLED (off)                    # on = the ai judge cron tick works
AI_JUDGE_AUTO_WITHDRAW (on)               # off = an LLM withdraw only sends to review; no effect while the judge is off
AI_JUDGE_MIN_INTERVAL (6h)                # Go duration: no LLM call within it of the video's last judgement (judged_at, any judgement)
AI_JUDGE_MODEL, AI_MODEL (claude-sonnet-5-5)
AI_MIN_VIEWS (500000; prod 200000 2026-11-07 to 11-09, to spend the OpenAI allowance), AI_MIN_REQUESTS (20)      # a seen video is taken at either threshold (was AI_FALLBACK_REQUESTS until 2026-10-28; the old variable is ignored)
AI_DAILY_BUDGET_VIDEOS (300; prod 1100 from 2026-11-07 to 11-09 ≈ $16–19/day at terra + Haiku ~$0.015–0.018 a video and ~1060 runs a day at AI_BATCH_MAX 5, then ~260 ≈ $100/month of OpenAI), AI_BATCH_MAX (5)
AI_MIN_SEGMENT_SECONDS (5)                # int ≥ 1: shorter AI segments go to `hidden` (reason short); read by the ai command (invalid = exit 1) and Node (lib/ai-rules.js, once on load, invalid throws)
AI_FETCH_PAUSE (40s)                      # Go duration: mean pause before each video's prv fetch on a cron tick, ± 50 % jitter; e2e sets 0
AI_CLIENT (anthropic)                     # judge and audit: anthropic | messages (both Messages API) | fixture (tests); the detector's fallback
AI_DETECT_CLIENT (AI_CLIENT)              # anthropic = Claude Batches API on the cron tick | messages | openai-batch = OpenAI Batch API | openai | fixture;
                                          # the manual run is synchronous; AI_MODEL must be the transport's vendor's (claude-* = Anthropic), else exit 1
AI_PROMPT (/app/ai/prompts/v2.2.md), AI_JUDGE_PROMPT (/app/ai/prompts/judge-v1.md), AI_FIXTURE_DIR (/app/test/fixtures/ai)
YTDLP_BIN (/usr/local/bin/yt-dlp)         # the image's pinned static release, absolute because cron's PATH lacks /usr/local/bin; e2e points it to the stub
ANTHROPIC_API_KEY                         # env only (no key file); AI_CLIENT=anthropic|messages without it is a startup error (exit 1)
AI_SECOND_ENABLED (off)                   # on = the second opinion before publish (ai detect)
AI_SECOND_CLIENT (openai)                 # openai | anthropic (Messages) | fixture (<native_id>.second.json, tests); AI_SECOND_MODEL must match its vendor
AI_SECOND_MODEL (gpt-6-luna)              # the second model's id (price from detector.Prices; unknown = cost 0 and a log line)
AI_CHAPTERS_ENABLED (off)                 # on = the chapter check after the second opinion (ai detect); chapters are stored either way
AI_CHAPTER_EDGE_SECONDS (10)              # int ≥ 1: how far a chapter's edge may be from the entry's (invalid = exit 1)
OPENAI_API_KEY                            # env only; AI_SECOND_ENABLED=on with AI_SECOND_CLIENT=openai and no key: startup error (exit 1)
AI_AUDIT_ENABLED (off)                    # on = the ai audit cron tick works (review batch audit, see Ops → Audit)
AI_AUDIT_TELEGRAM (off)                   # on = the audit pings the owner in Telegram; off = the page block only (Telegram is
                                          # unreachable from the prod host since 2026-11-01: docs/backlog/telegram-blocked-from-prod-host.md)
AI_AUDIT_MODEL (claude-sonnet-5-5), AI_AUDIT_PROMPT (/app/ai/prompts/audit-v1.md)
TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID      # the alerting bot (Grafana) and, on app, the audit's ping; AI_AUDIT_TELEGRAM=on without them: startup error
TELEGRAM_API_URL (https://api.telegram.org)   # overridable for tests (the e2e stub)

# The video platform (GitHub secrets on prod, see Deployment)
PROVIDER_VIDEO_URL                        # page URL template yt-dlp is pointed at, {id} = native id (the ai command)
PROVIDER_LINK_AT                          # player link template, {id} and {t} (1h2m3s); Node (lib/player-link.js) and the ai command;
                                          # unset = https://example.invalid/video{id}?t={t} in Node; the ai command needs both once a
                                          # detect or judge tick actually runs (ai/platform, exit 1 with the message), regate never
LEGACY_PRV                           # an earlier prefix of the DB objects and of the user id API field, renamed on boot (prod: the
                                          # old prefix without the underscore); unset = nothing to rename, no API alias (see Schema bootstrap)
API_HOST, LANDING_HOST                    # the public host names (secrets); only the deploy's render step reads them, into the
                                          # bind-mounted prometheus.yml and dashboards (see Deployment → Render), never the containers
```

Wiring: `docker-compose.yml` passes `AI_FIRST`, `AI_DETECT_ENABLED`, `AI_JUDGE_ENABLED` (`:-off`), `AI_JUDGE_AUTO_WITHDRAW` (`:-on`), `AI_JUDGE_MODEL`, `AI_JUDGE_MIN_INTERVAL`, `AI_MIN_VIEWS`, `AI_MIN_REQUESTS`, `AI_DAILY_BUDGET_VIDEOS`, `AI_MIN_SEGMENT_SECONDS`, `AI_MODEL`, `AI_DETECT_CLIENT`, `AI_SECOND_ENABLED` (`:-off`), `AI_SECOND_CLIENT`, `AI_SECOND_MODEL`, `AI_CHAPTERS_ENABLED` (`:-off`), `AI_CHAPTER_EDGE_SECONDS`, `AI_AUDIT_ENABLED`, `AI_AUDIT_TELEGRAM` (`:-off`), `AI_AUDIT_MODEL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (empty = code default) to `app`; the deploy workflow fills them from repository variables (`vars.AI_*`) and the `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `TELEGRAM_*` secrets. Cron jobs see only `/app/.env`: `infrastructure/init/init_env.sh` appends every `AI_*`, `YTDLP_BIN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `TELEGRAM_*` of the container env there, and `prv/commands/ai/main.go` loads it (variables already set win). A new flag goes into the workflow's two lists (env and the `printf %q` exports) and `docker-compose.yml`; nothing else. The other variables above keep their code defaults on prod.

### Deployment

Pipeline details, render, rollback procedures, DNS, TLS and backups: `docs/reference/deployment.md`.

- Prod: one Timeweb VM (Almaty); Postgres 16 on the host (containers reach it at `host.docker.internal`); nginx with
  Let's Encrypt in front of `127.0.0.1:3022`.
- CI (`.github/workflows/deploy.yml`, push to `main` or manual dispatch): tests (unit, Go, Docker e2e) → image built and
  pushed to GHCR as `:<sha>` → checkout tarred to the host, placeholders rendered (`${API_HOST}`, `${LANDING_HOST}`,
  `${PROVIDER_VIDEO_URL}`) → `docker compose -p "$COMPOSE_PROJECT" pull app` + `up -d --no-build --force-recreate`.
  A push to `main` is a deploy.
- `COMPOSE_PROJECT` is the stack's original name; change it only together with a rename of the volumes.
- Rollback: Run workflow with `image_tag` = an older sha. An image older than 2026-10-29 needs
  `scripts/rename-to-legacy.js` first, a pre-AI image needs its AI heartbeat rows deleted (see the reference).
- Backups: Timeweb daily VM backups plus the weekly `make pull-dump`; the S3 nightly job is not installed
  (`docs/backlog/offhost-pg-backup-s3.md`).
