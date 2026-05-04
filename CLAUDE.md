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
go test ./calculator                            # Run Go unit tests
go test ./calculator -run TestFindMedian        # Run a single test
```

No Node.js test suite is configured.

## Architecture

### Dual-Process Design

Two independent runtimes managed by Supervisor inside Docker:
- **Node.js (Express)** — HTTP API: CRUD for markups, votes, and serving calculated results
- **Go CLI** — Cron job every minute: aggregates new markups into `VideoCalculated`

Communication is only through PostgreSQL. The Go binary reads `MarkupTimeInterval` rows where `is_new = true` and writes aggregated JSON to `VideoCalculated`; Node reads that table for client responses.

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
   - Upsert into `VideoCalculated` as JSON; store markup IDs in `meta`
   - Mark processed markups as `is_new = false`

### Routes

All three providers share the same route shape; `prv/` has two extras.

- **`markups.js`** — Core markup CRUD. `POST /markup` rejects users with rating ≤ −2. Several delete endpoints have both `DELETE` and `GET` variants because Grafana can only trigger GET requests.
- **`votes.js`** — Vote submission updates the creator's rating via `prv/service/user.js`.
- **`videos.js`** — `GET /video-calculated` serves aggregated segments; prv additionally logs duration claims and tracks legacy client versions.
- **`prv/routes/events.js`** — `POST /events` (shared by all providers). Accepts a JSON array of mixed events; supported types below. Returns `{ data: { time_saved: { ... } } }` when the batch contains at least one `time_saved` event.
  - **`interval_undo`** — fields: `user_id`, `prv_user_id`, `video_native_id`, `category_id`, `start`, `end`. Stored in `[prefix_]interval_undos`.
  - **`interval_click`** — fields: same as above plus `click_time` (int). Stored in `[prefix_]interval_clicks`.
  - **`time_saved`** — fields: `user_id`, `prv_user_id`, `inc`. Increments `User.time_saved`; stored in `[prefix_]time_saved_events`. Response mirrors the old `POST /users/time-saved` structure: `by_user_id`, `by_prv_user_id`, `by_user`.
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
| `Video` | prv video reference with optional duration |
| `VideoCalculated` | Aggregated JSON result per video (1:1 with Video) |
| `Vote` | User rating of a markup (-1, 0, +1) |
| `User` | Internal user mapped to prv user ID; tracks `rating` and `time_saved` |
| `DurationLog` | Tracks claimed video durations for anomaly detection |
| `IntervalUndo` | Records per-provider interval undo events (`[prefix_]interval_undos`) |
| `IntervalClick` | Records per-provider interval click events with `click_time` (`[prefix_]interval_clicks`) |
| `TimeSavedEvent` | Records per-provider time_saved events (`[prefix_]time_saved_events`) |

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
