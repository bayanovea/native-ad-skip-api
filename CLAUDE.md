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

```bash
go build -o commands/calculate commands/*.go   # Build the calculator
./commands/calculate                           # Process all videos with new markups
./commands/calculate <video_id>               # Process a single video
```

### Tests

```bash
go test ./commands                            # Run Go unit tests
go test ./commands -run TestFindMedian        # Run a single test
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

### Key Directories

| Path | Purpose |
|------|---------|
| `routes/` | Express route handlers |
| `repository/` | Raw Sequelize queries — soft-delete filtering lives here |
| `service/` | Business logic (user rating updates on votes) |
| `middleware/` | Auth (`verify-bearer-token.js`), validation, async error wrapper |
| `commands/` | Go source: `calculate.go` (algorithm), `pool.go` (goroutine pool) |
| `db.js` | Sequelize models and associations |

### Calculation Algorithm (`commands/calculate.go`)

1. Query videos where any markup has `is_new = true`
2. For each video (up to 10 in parallel via goroutine pool):
   - Group intervals by `(category_id, startRounded)` where `startRounded = start - (start % 3)` (3-second buckets)
   - **Start** = average of all starts in the group
   - **End** = median of all ends in the group
   - Upsert into `VideoCalculated` as JSON; store markup IDs in `meta`
   - Mark processed markups as `is_new = false`

### Routes

- **`routes/markups.js`** — Core markup CRUD. `POST /markup` rejects users with rating ≤ −2. Several delete endpoints have both `DELETE` and `GET` variants because Grafana can only trigger GET requests.
- **`routes/votes.js`** — Vote submission updates the creator's rating via `service/user.js`.
- **`routes/videos.js`** — `GET /video-calculated` serves aggregated segments; logs duration claims and tracks legacy client versions.
- **`routes/users.js`** — `POST /users/time-saved` aggregates time saved per user and prv ID.
- **`routes/admin.js`** — Server-rendered HTML dashboard (`/admin/video/:video_id`) for viewing and deleting markups grouped by interval; protected by `AUTH_TOKEN` query param.
- **`routes/routes.js`** — Health check (`GET /`) and Prometheus metrics (`GET /metrics`).

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
