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
docker-compose -f docker-compose.yml up --build -d app  # Production build
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
```

### Tests

```bash
go test ./calculator                            # Run Go unit tests (no DB required)
go test ./calculator -run TestFindMedian        # Run a single test

make test-calculator                            # Go integration tests against a real Postgres
                                                # (requires DB_USER/DB_PASSWORD in env)
make test-e2e                                   # Full Docker e2e: spins up Postgres + Node app
                                                # and exercises HTTP endpoints + Go calc binary
```

`make test-e2e` runs `test/e2e.js` (Node `node:test`) and is the canonical end-to-end suite.

## Architecture

### Dual-Process Design

Two independent runtimes managed by Supervisor inside Docker:
- **Node.js (Express)** — HTTP API: CRUD for markups, votes, and serving calculated results
- **Go CLI** — Cron job every minute: aggregates new markups into `VideoCalculated`

Communication is only through PostgreSQL. The Go binary reads `MarkupTimeInterval` rows where `is_new = true` and writes aggregated JSON to `VideoCalculated` plus relational rows in `{provider}_calculated_segments` (and the segment ↔ markup junction). Node reads `VideoCalculated.data` for client responses and updates the per-segment `rating` (in both the JSON and the segments table) when a vote arrives.

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
| `calculator/` | Shared Go source: `calculate.go` (algorithm), `pool.go` (goroutine pool) |
| `middleware/` | Auth (`verify-bearer-token.js`), validation, async error wrapper |
| `db.js` | Sequelize models and associations for all providers |
| `api/doc/openapi.yaml` | OpenAPI spec served at `/api/doc` |
| `grafana/` | Grafana provisioning configs and dashboard JSONs; service runs on port 3024 |

### Calculation Algorithm (`calculator/calculate.go`)

1. Query videos where any markup has `is_new = true`
2. For each video (up to 10 in parallel via goroutine pool):
   - Group intervals by `(category_id, startRounded)` where `startRounded = start - (start % 3)` (3-second buckets)
   - **Start** = average of all starts in the group
   - **End** = median of all ends in the group
   - Clear the previous segments (`{provider}_calculated_segment_markups` → `{provider}_calculated_segments` → `video_calculateds`)
   - Insert the JSON array into `video_calculateds.data` (each entry: `category_id`, `start`, `end`; `rating` is omitted when 0 — sparse representation). `meta` is no longer written.
   - Insert one row per segment into `{provider}_calculated_segments` (with `rating = 0`) and one row per contributing markup into `{provider}_calculated_segment_markups`
   - Mark processed markups as `is_new = false`

The segment rows in `{provider}_calculated_segments` are the source of truth for joins (e.g. analytics) and carry the same `rating` that lives in `video_calculateds.data`. Both are kept in sync by the vote handler (see Routes → `votes.js`).

### Routes

All three providers share the same route shape; `prv/` has two extras.

- **`markups.js`** — Core markup CRUD. `POST /markup` rejects users with rating ≤ −2. It also silently returns 201 (no row created) when the user is hard-banned (banned_at IS NOT NULL); see Authentication. Several delete endpoints have both `DELETE` and `GET` variants because Grafana can only trigger GET requests.
- **`votes.js`** — Vote submission. On each new vote:
  - `{provider}_calculated_segments.rating` is incremented by `vote - prevVote.vote` (or just `vote` if no prior vote from this user)
  - the matching entry in `video_calculateds.data` is rewritten with the same `rating` delta so clients see the updated value
  - the markup author's user `rating` is adjusted via `prv/service/user.js` only when a single markup with an exact `(start, end)` match contributed to the segment
  - if the rating mutation drops a user to rating ≤ −100, `prv/service/user.js` also sets `banned_at` and writes a `prv_admin_decisions` row with `decided_by='auto'` (idempotent — only the first crossing writes; the `banned_at == null` guard short-circuits repeat crossings)
- **`videos.js`** — `GET /video-calculated` serves aggregated segments; prv additionally logs duration claims and tracks legacy client versions. Uses a read-only `findVideoForRead` helper (never creates Video rows): looks up by `(native_id, duration±1)`, then `(native_id, null duration)` updating it, then any `native_id` match, then 204.
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
- **`prv/routes/routes.js`** — Health check (`GET /`) and Prometheus metrics (`GET /metrics`).

### Authentication

- **Admin routes**: `Authorization: Bearer <AUTH_TOKEN>` header (middleware `verify-bearer-token.js`)
- **Admin dashboard**: `AUTH_TOKEN` as query param (checked directly in `routes/admin.js`)
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
| `VideoCalculated` | Aggregated JSON array per video (1:1 with Video). Each entry: `category_id`, `start`, `end`; `rating` present only when non-zero. `meta` is unused by current calculator |
| `CalculatedSegment` | One row per aggregated segment — table `{provider}_calculated_segments`; carries `rating` updated by votes |
| `CalculatedSegmentMarkup` | Junction linking a `CalculatedSegment` to each contributing `Markup` — table `{provider}_calculated_segment_markups` |
| `Vote` | User vote on a calculated segment (-1, 0, +1) |
| `User` | Internal user mapped to prv user ID; tracks `rating`, `time_saved`, and `banned_at` (hard ban — set by admin via /admin/moderation/decide or automatically when rating ≤ -100; gates POST /markup independently of the soft `rating ≤ -2` check) |
| `AdminDecision` | Append-only log of admin moderation decisions — table `prv_admin_decisions` (prv only — no rt_ / yt_ analogue exists; moderation is prv-scoped per plan). Fields `target_type` ('user'\|'markup'), `target_id`, `decision` ('approve'\|'reject'), `signals_snapshot` (JSONB), `decided_at`, `decided_by` ('admin'\|'auto'). Latest row per target acts as a watermark for the re-surface threshold on /admin/moderation. All writes go through `moderationRepository.recordDecision()` — both the admin POST endpoint and the auto-ban hook share this single entrypoint to keep `signals_snapshot` consistent. |
| `DurationLog` | Tracks claimed video durations for anomaly detection |
| `IntervalUndo` | Records interval undo events — table `{provider}_events_interval_undo` |
| `IntervalClick` | Records interval click events with `click_time` — table `{provider}_events_interval_click` |
| `TimeSavedEvent` | Records time_saved events — table `{provider}_events_time_saved` |
| `ClientFailed` | Records client-side failures with free-form `reason` and `data` JSON — table `{provider}_events_client_failed` |

**Soft Deletes:** All queries must filter `deleted_at IS NULL`. This is handled in `repository/` — always check there when writing new queries.

**Dual User ID System:** Users have both a `generated_user_id` (UUID) and an optional `prv_user_id`. The codebase is transitioning to internal DB `id` references.

**Schema bootstrap:** project has no migrations folder. New tables come from `sequelize.sync()` (run on every boot in `db.js`); new columns on existing tables are added with idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements queued inside the `sync().then(...)` callback. Example: `banned_at` on `users`.

### Prometheus Metrics (`prometheus-wrapper.js`, `server.js`)

Two custom counters and one HTTP histogram are exposed on `GET /metrics` (served by `server.js`, not by `express-prom-bundle`'s autoregister — `/metrics` is in `excludeRoutes` so it doesn't record itself).

**`video_calculated_lookup_total{outcome, provider}`** — outcomes of `GET /video-calculated`. `provider` is `prv` / `rt` / `yt`. `outcome` is one of:

| Outcome | Definition |
|---|---|
| `match` | Request supplied `duration`; row found by `(native_id, duration ± 1)`; `VideoCalculated` row exists. |
| `backfilled` | Request supplied `duration`; no `± 1` match; a row with `duration = NULL` existed and was just updated to the request's duration; `VideoCalculated` row exists. |
| `mismatch` | Request supplied `duration`; no `± 1` match; no `NULL` row to backfill; helper fell through to `findOne({ native_id })` and returned a row whose stored duration differs by > 1 s; `VideoCalculated` row exists. |
| `no_duration` | Request had no `duration` query param (legacy client); helper fell through directly to `findOne({ native_id })`; `VideoCalculated` row exists. |
| `not_calculated` | Helper returned a `Video` (any of the four above) but no `VideoCalculated` row was found; caller overrides the helper's outcome to `not_calculated`. |
| `not_found` | Helper returned `null` (no `Video` row matched at all). |

The first five outcomes are emitted by `lib/find-video-for-read.js`; `not_calculated` is derived in the route handler when `VideoCalculated.findOne` returns null. prv's legacy `!req.query.v` branch in `prv/routes/videos.js` does **not** emit a lookup outcome — it only increments `request_without_version_total`.

**`request_without_version_total{method, provider}`** — count of legacy client requests that omit the `v` query/body param. `method` is the route key (`GET /video-calculated`, `POST /markup`).

**`http_request_duration_seconds_{bucket|count|sum}{method, path, status_code}`** — `express-prom-bundle` histogram with buckets `[0.05, 0.1, 0.25, 0.5, 1, 2.5]`. `path` is normalized via `normalizePath` rules in `server.js` so dynamic segments collapse (`/admin/video/12345` → `/admin/video/#video_id`, `/markups/42` → `/markups/#id`, etc.). The default `url-value-parser` catches any unmapped numeric/UUID IDs as defense-in-depth.

**Storage / scrape:** Prometheus scrapes `app:3022/metrics` every 30 s and stores data on the `prometheus_data` named Docker volume (mounted at `/prometheus` in the container; pinned project name `native-ad-skip-api` → stable volume `native-ad-skip-api_prometheus_data`). Retention is bounded by **both** `--storage.tsdb.retention.time=30d` and `--storage.tsdb.retention.size=2GB`; whichever hits first wins, so the volume can never exceed ~2 GB. The size cap exists because the `path` label on `http_request_duration_seconds` is effectively unbounded (unmatched/404 URLs each create their own series), which previously grew the volume to 35 GB. Prometheus does not downsample — reclaiming space means dropping whole 2 h blocks, which it does on startup and every compaction cycle.

**Grafana:** sibling repo at `../native-ad-skip-grafana` holds the Grafana compose stack. Both stacks attach to the external `main-network` (precondition on the host: `docker network create main-network`); Grafana's datasource points at `http://prometheus:9090` by DNS within that network. Dashboards are maintained manually and persisted on the `native-ad-skip-grafana_grafana_data` volume.

### Environment Variables

```
DB_NAME, DB_USER, DB_PASSWORD, DB_HOST   # PostgreSQL connection
NODE_APP_PORT=3022                        # HTTP server port
AUTH_TOKEN                                # Admin bearer token
ENV=dev|production                        # Controls yarn dev vs yarn start
```

### Deployment

CI/CD via GitHub Actions (`.github/workflows/deploy.yml`): pushes to `main` SSH-transfer the codebase to a Yandex Cloud VM and rebuild the Docker container. Supervisor inside Docker manages cron (Go CLI) and the Node.js app simultaneously.
