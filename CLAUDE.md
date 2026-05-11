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

- **`markups.js`** — Core markup CRUD. `POST /markup` rejects users with rating ≤ −2. Several delete endpoints have both `DELETE` and `GET` variants because Grafana can only trigger GET requests.
- **`votes.js`** — Vote submission. On each new vote:
  - `{provider}_calculated_segments.rating` is incremented by `vote - prevVote.vote` (or just `vote` if no prior vote from this user)
  - the matching entry in `video_calculateds.data` is rewritten with the same `rating` delta so clients see the updated value
  - the markup author's user `rating` is adjusted via `prv/service/user.js` only when a single markup with an exact `(start, end)` match contributed to the segment
- **`videos.js`** — `GET /video-calculated` serves aggregated segments; prv additionally logs duration claims and tracks legacy client versions. Uses a read-only `findVideoForRead` helper (never creates Video rows): looks up by `(native_id, duration±1)`, then `(native_id, null duration)` updating it, then any `native_id` match, then 204.
- **`prv/routes/events.js`** — `POST /events` (shared by all providers). Accepts a JSON array of mixed events; supported types below. Invalid events (unknown `type`, missing fields) are logged to stdout and skipped — the rest of the batch still processes. Returns `{ data: { time_saved: { ... } } }` when the batch contains at least one `time_saved` event.
  - **`interval_undo`** — fields: `user_id`, `prv_user_id`, `video_native_id`, `category_id`, `start`, `end`. Stored in `{provider}_events_interval_undo`.
  - **`interval_click`** — fields: same as above plus `click_time` (int). Stored in `{provider}_events_interval_click`.
  - **`time_saved`** — fields: `user_id`, `prv_user_id`, `inc`. Increments `User.time_saved`; stored in `{provider}_events_time_saved`. Response mirrors the old `POST /users/time-saved` structure: `by_user_id`, `by_prv_user_id`, `by_user`.
  - **`client_failed`** — fields: `user_id`, `prv_user_id`, `video_native_id`, `reason` (string), `data` (arbitrary JSON, optional). Stored in `{provider}_events_client_failed`.
- **`prv/routes/users.js`** — Shared by all providers (currently empty; `POST /users/time-saved` was removed in favour of the events endpoint).
- **`prv/routes/admin.js`** — Server-rendered HTML dashboard (`/admin/video/:video_id`) for viewing and deleting markups grouped by interval; protected by `AUTH_TOKEN` query param. prv only.
- **`prv/routes/routes.js`** — Health check (`GET /`) and Prometheus metrics (`GET /metrics`).

### Authentication

- **Admin routes**: `Authorization: Bearer <AUTH_TOKEN>` header (middleware `verify-bearer-token.js`)
- **Admin dashboard**: `AUTH_TOKEN` as query param (checked directly in `routes/admin.js`)
- **API docs** (`/api/doc`): HTTP Basic Auth — username `admin`, password `AUTH_TOKEN` env var
- Public write endpoints (markup creation, votes) are unauthenticated

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
| `User` | Internal user mapped to prv user ID; tracks `rating` and `time_saved` |
| `DurationLog` | Tracks claimed video durations for anomaly detection |
| `IntervalUndo` | Records interval undo events — table `{provider}_events_interval_undo` |
| `IntervalClick` | Records interval click events with `click_time` — table `{provider}_events_interval_click` |
| `TimeSavedEvent` | Records time_saved events — table `{provider}_events_time_saved` |
| `ClientFailed` | Records client-side failures with free-form `reason` and `data` JSON — table `{provider}_events_client_failed` |

**Soft Deletes:** All queries must filter `deleted_at IS NULL`. This is handled in `repository/` — always check there when writing new queries.

**Dual User ID System:** Users have both a `generated_user_id` (UUID) and an optional `prv_user_id`. The codebase is transitioning to internal DB `id` references.

### Prometheus Metrics (`prometheus-wrapper.js`)

- `video_calculated_found` — successful segment lookups
- `video_calculated_not_found` — missing segment lookups
- `request_without_version` — legacy API client requests

### Environment Variables

```
DB_NAME, DB_USER, DB_PASSWORD, DB_HOST   # PostgreSQL connection
NODE_APP_PORT=3022                        # HTTP server port
AUTH_TOKEN                                # Admin bearer token
ENV=dev|production                        # Controls yarn dev vs yarn start
```

### Deployment

CI/CD via GitHub Actions (`.github/workflows/deploy.yml`): pushes to `main` SSH-transfer the codebase to a Yandex Cloud VM and rebuild the Docker container. Supervisor inside Docker manages cron (Go CLI) and the Node.js app simultaneously.
