# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**native-ad-skip-api** is a hybrid Node.js + Go service for crowdsourced video ad/segment skipping. Users submit time-interval markups for video segments (intro, sponsor, self_promotion, credits). A Go CLI aggregates these markups into consensus boundaries stored in `VideoCalculated`, which clients poll to skip ads.

## Commands

### Development

```bash
yarn install          # Install Node.js dependencies
yarn dev              # Start Node.js with nodemon (auto-reload)
yarn start            # Start Node.js in production mode

docker-compose -f docker-compose.dev.yml up   # Full dev stack (Node + DB)
docker-compose -f docker-compose.yml up --build -d app  # Production
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

The service runs two independent runtimes under Supervisor:
- **Node.js (Express)**: Handles all HTTP API traffic — CRUD for markups, votes, and serving calculated results
- **Go CLI**: Runs via cron every minute to aggregate new markups into consensus data

These communicate only through PostgreSQL — the Go binary reads markups and writes to `VideoCalculated`; Node.js reads `VideoCalculated` and serves it to clients.

### Request Flow

```
Client → Express routes → Middleware (validate, auth) → Repository layer → PostgreSQL
                                                                ↓ (async, every minute)
                                                    Go CLI (calculate) → VideoCalculated
```

### Key Directories

| Path | Purpose |
|------|---------|
| `routes/` | Express route handlers (`videos.js`, `markups.js`, `votes.js`) |
| `repository/` | Data access layer — raw Sequelize queries |
| `service/` | Business logic (user rating updates) |
| `middleware/` | Auth (`verify-bearer-token.js`), validation, async error wrapper |
| `commands/` | Go source: `calculate.go` (algorithm), `pool.go` (goroutine pool) |
| `db.js` | Sequelize models and associations |
| `config/config.js` | Database connection config |

### Calculation Algorithm (`commands/calculate.go`)

1. Query videos where any markup has `is_new = true`
2. For each video (up to 10 in parallel via goroutine pool):
   - Group intervals by `(category_id, startRounded)` where `startRounded = start - (start % 3)` (3-second buckets)
   - **Start** = average of all starts in group
   - **End** = median of all ends in group
   - Upsert into `VideoCalculated` as JSON
   - Mark processed markups as `is_new = false`

### Authentication

Admin endpoints require `Authorization: Bearer <AUTH_TOKEN>` where `AUTH_TOKEN` is set via environment variable. Public write endpoints (markup creation, votes) are unauthenticated.

### Environment Variables

```
DB_NAME, DB_USER, DB_PASSWORD, DB_HOST   # PostgreSQL connection
NODE_APP_PORT=3022                        # HTTP server port
AUTH_TOKEN                                # Admin bearer token
ENV=dev|production                        # Controls yarn dev vs yarn start
```

### Database Models

- **Video** — native video IDs with optional duration
- **Markup** — user-submitted segment (soft-deleted via `deleted_at`)
- **MarkupTimeInterval** — start/end times belonging to a Markup
- **MarkupCategory** — enum: intro, sponsor, self_promotion, credits
- **VideoCalculated** — aggregated JSON result per video
- **Vote** — user rating of a markup (-1, 0, +1), affects User.rating
- **User** — internal user ID mapped to prv user ID + reputation rating

### Soft Deletes

Markups are soft-deleted (`deleted_at` timestamp). All queries must filter these out — check repository layer when writing new queries.

### Deployment

CI/CD via GitHub Actions (`.github/workflows/deploy.yml`): pushes to `main` SSH-transfer the codebase to a Yandex Cloud VM and rebuild the Docker container.
