# Prometheus Monitoring Revival

## Overview

Restore Prometheus as a persistent, low-volume monitoring stack and surface its metrics in Grafana for day-by-day operational visibility. Three concrete changes:

1. **Custom metrics refactor** — replace the three high-cardinality counters (`video_calculated_found`, `video_calculated_not_found`, `request_without_version` keyed by `video_id`/`owner_id`) with a single outcome counter `video_calculated_lookup_total{outcome, provider}` (six outcome states derived from `findVideoForRead`) plus a label-bounded `request_without_version_total{method, provider}`.
2. **HTTP infrastructure metrics** — keep `express-prom-bundle` but harden the config (normalize path params, blacklist `/metrics` from self-recording, narrower latency buckets).
3. **Persistent Prometheus + Grafana** — uncomment Prometheus in production compose with a 180-day retention on a named volume; add a minimal compose file to the sibling `native-ad-skip-grafana` repo so both stacks share the existing external `main-network`.

The new outcome taxonomy gives Grafana the signal it needs to diagnose lookup health (mismatch spikes, backfill rate, not-yet-aggregated videos) without exploding cardinality.

## Context (from discovery)

**Files involved:**

- `prometheus-wrapper.js` — three counters today; all three are removed/replaced.
- `server.js` — `express-prom-bundle` already wired (lines 14–16) with default config.
- `prv/routes/videos.js`, `rt/routes/videos.js`, `yt/routes/videos.js` — all three define near-identical `findVideoForRead`; prv has an additional legacy `!req.query.v` branch (`'-' + nativeFullVideoId` lookup).
- `prv/routes/markups.js` — calls `incrementRequestWithoutVersion('POST /markup', videoId)`.
- `docker-compose.yml` — Prometheus block commented out; mount path wrong (`/data` instead of `/prometheus`).
- `docker-compose.dev.yml` — Prometheus present; needs same fixes.
- `config/prometheus.yml`, `config/prometheus.dev.yml` — scrape config; target uses fragile container name.
- `CLAUDE.md` — has `Prometheus Metrics` section to rewrite.
- `../native-ad-skip-grafana/Dockerfile` — Grafana image; no compose file yet.

**Patterns observed:**

- rt/yt routes intentionally reuse prv code in places (`prv/service/user.js`, `prv/routes/users.js`). Sharing the new outcome-aware lookup helper across providers fits this convention.
- `main-network` in `docker-compose.yml` is `external: true` — multiple compose stacks can already attach.
- Test infrastructure: `test/e2e.js` is the canonical Node e2e suite (`make test-e2e`); Go unit tests under `calculator/`.

**Dependencies:**

- `prom-client` and `express-prom-bundle` already in `package.json` (verify version).
- No new third-party packages required.

## Development Approach

- **Testing approach:** Regular (code first, then tests within the same task).
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **Every task with code changes MUST include new/updated tests** in the same task.
  - Write unit tests for new helpers (`findVideoForReadWithOutcome`, outcome derivation).
  - Update existing e2e tests when handler behavior or metric semantics change.
  - Tests cover both success and error scenarios where applicable.
- Config-only tasks (Docker compose, Prometheus YAML, Grafana compose) have no automated tests — they are validated by `docker compose config` parse + manual smoke check in Post-Completion.
- **CRITICAL: all tests must pass before starting next task** — no exceptions.
- **CRITICAL: update this plan file when scope changes during implementation.**
- Maintain backward compatibility on HTTP responses (no client-visible behavior change).

## Testing Strategy

- **Unit tests** — none of the existing JS is unit-tested today; we add focused tests for the new outcome derivation logic in a colocated spec file using Node's built-in `node:test`. Pattern matches the existing `test/e2e.js` runner.
- **E2E tests** — extend `test/e2e.js` to cover:
  - GET /video-calculated returns 200 and the expected outcome label increments (`match`).
  - Backfill flow: pre-seed `Video` with `duration = null`, request with duration → response is 200, `backfilled` counter +1, video row updated.
  - Mismatch flow: pre-seed `Video` with different duration → 200, `mismatch` counter +1.
  - `no_duration` and `not_found` outcomes.
  - `/metrics` endpoint responds 200 with the expected metric names present.
- **Manual smoke test (post-deploy)** — exercise the Prometheus UI (target up, retention configured) and Grafana datasource health check.

## Solution Overview

**Architecture:**

- Keep the existing dual-process design (Node + Go cron). Only the Node side gains new metrics; Go calculator is untouched.
- Prometheus runs as a sibling container to `app` in the same `docker-compose.yml`, scraping `app:3022/metrics` every 30 s.
- Grafana lives in `../native-ad-skip-grafana` as a self-contained compose stack that joins the *same* external `main-network`. **Neither compose stack creates this network** — it's declared `external: true` in both, which means a `docker network create main-network` (idempotent) must be run on the host before either stack can come up.
- A small shared helper `lib/find-video-for-read.js` houses the outcome-aware lookup so prv/rt/yt all call the same code. prv's legacy `!req.query.v` branch stays in `prv/routes/videos.js` (it's prv-specific).
- Compose project names are pinned (`name: native-ad-skip-api` / `name: native-ad-skip-grafana` at the top of each compose) so the named volumes (`prometheus_data`, `grafana_data`) resolve to stable Docker volume identities (`native-ad-skip-api_prometheus_data`, `native-ad-skip-grafana_grafana_data`) regardless of where the repo lives on disk.

**Design decisions:**

| Decision | Rationale |
|---|---|
| Single counter w/ `outcome` label | 6 outcomes × 3 providers = 18 series — bounded, queryable by outcome rate in Grafana |
| Drop `video_id` / `owner_id` labels | Unbounded cardinality → permanent series growth; not actionable on a dashboard |
| Shared helper across prv/rt/yt | Matches existing pattern of sharing `prv/service/user.js`; one place to evolve the outcome taxonomy |
| Named Docker volume `prometheus_data` | Survives container rebuild; mirrors the existing `prometheus_data:` definition |
| 180 d retention @ 30 s scrape | ~25 MB/year — effectively free; "data permanent enough" without downsampling complexity |
| No dashboard provisioning yet | User opts to keep manual dashboards; `grafana_data` volume preserves them; provisioning can be added later non-destructively |
| `autoregister: false` for `express-prom-bundle` | Lets us mount `/metrics` ourselves so it isn't recorded as a request, removing self-noise |

## Technical Details

**New outcome states** (definitions; will be documented in `CLAUDE.md`):

| Outcome | Definition |
|---|---|
| `match` | Request supplied `duration`; row found by `(native_id, duration ± 1)`; `VideoCalculated` row exists. |
| `backfilled` | Request supplied `duration`; no `± 1` match; a row with `duration = NULL` existed and was just updated to the request's duration; `VideoCalculated` row exists. |
| `mismatch` | Request supplied `duration`; no `± 1` match; no `NULL` row to backfill; helper fell through to `findOne({ native_id })` and returned a row whose stored duration differs by > 1 s; `VideoCalculated` row exists. |
| `no_duration` | Request had no `duration` query param (legacy client); helper fell through directly to `findOne({ native_id })`; `VideoCalculated` row exists. |
| `not_calculated` | Helper returned a `Video` (any of the four above) but no `VideoCalculated` row was found; caller overrides the helper's outcome to `not_calculated`. |
| `not_found` | Helper returned `null` (no `Video` row matched at all). |

**Counter contract:**

```text
video_calculated_lookup_total{ outcome, provider }
request_without_version_total{ method, provider }
http_request_duration_seconds_{ bucket | count | sum }{ method, path, status_code }
```

Cardinality budget — actual route audit (`router.(get|post|put|delete|patch)` across all providers): ~25 distinct route patterns × ~5 status codes × (6 buckets + `_count` + `_sum` = 8 series per histogram bin). Worst-case ≈ 25 × 5 × 8 ≈ 1 000 histogram series, plus the 18 + 6 = 24 custom-counter series. Realistically much less (most routes only see 1–2 status codes in practice). Bounded and harmless at this scale.

**Shared helper signature** (`lib/find-video-for-read.js`):

```js
async function findVideoForReadWithOutcome(models, nativeId, duration)
// returns one of five shapes:
//   { video: Video,  outcome: 'match' }
//   { video: Video,  outcome: 'backfilled' }   // side effect: video.duration updated
//   { video: Video,  outcome: 'mismatch' }
//   { video: Video,  outcome: 'no_duration' }  // duration was null/undefined in request
//   { video: null,   outcome: 'not_found' }
//
// The 'not_calculated' outcome is owned by the caller: if the helper returned a
// Video but VideoCalculated.findOne returned null, the caller rewrites
// outcome → 'not_calculated' before incrementing the counter.
```

**Processing flow (`GET /video-calculated`):**

```
request → findVideoForReadWithOutcome → if no video: outcome stays, increment, 204
                                       → else lookup VideoCalculated
                                          → none: outcome = 'not_calculated', increment, 204
                                          → some: outcome unchanged ('match'|'backfilled'|'mismatch'|'no_duration'), increment, 200
```

prv's legacy `!req.query.v` branch increments `request_without_version_total{ method: 'GET /video-calculated', provider: 'prv' }` and then does its bespoke `'-' + nativeId` lookup (no outcome taxonomy applies — outcomes are for the canonical path).

## What Goes Where

- **Implementation Steps** (checkboxes): all code, config, docker-compose, and documentation changes inside this repo and the Grafana repo.
- **Post-Completion** (no checkboxes): manual verification on the deployed VM (Prometheus target health, Grafana datasource, dashboard rebuild), and any deploy-time coordination between the two compose stacks.

## Implementation Steps

### Task 1: Add shared outcome-aware video lookup helper

**Files:**
- Create: `lib/find-video-for-read.js`
- Create: `test/find-video-for-read.test.js`

- [x] create `lib/find-video-for-read.js` exporting `findVideoForReadWithOutcome(models, nativeId, duration)` that returns one of five shapes: `{video, outcome: 'match'}`, `{video, outcome: 'backfilled'}` (with `video.update({ duration })` side effect), `{video, outcome: 'mismatch'}`, `{video, outcome: 'no_duration'}` (when request had no duration), or `{video: null, outcome: 'not_found'}`
- [x] note: `not_calculated` is NOT a helper outcome — the caller derives it after a missed `VideoCalculated.findOne`
- [x] write unit tests in `test/find-video-for-read.test.js` using `node:test` with a stubbed `models.Video` (in-memory mock for `findOne` / `update`)
- [x] cover all five outcome branches; assert `video.update({ duration })` runs exactly once on the backfill branch and not on the others
- [x] run `node --test test/find-video-for-read.test.js` — must pass before next task

### Task 2: Refactor `prometheus-wrapper.js` to the new counter API

**Files:**
- Modify: `prometheus-wrapper.js`
- Create: `test/prometheus-wrapper.test.js`

- [x] remove `incrementVideoCalculatedFound`, `incrementVideoCalculatedNotFound`, the `counters` cache map, and the `_getOrCreateCounter` helper (with only two counters total, lazy caching is unneeded)
- [x] declare both counters once at module load on `prom-client`'s default registry:
  - `video_calculated_lookup_total` with `labelNames: ['outcome', 'provider']`
  - `request_without_version_total` with `labelNames: ['method', 'provider']`
- [x] export `incrementVideoCalculatedLookup(outcome, provider)` and `incrementRequestWithoutVersion(method, provider)` (new signature — drop the per-video `originalVideoId` arg)
- [x] rely on the default `prom-client` registry; `server.js` will serve `/metrics` from `prom-client.register` in Task 6 (no separate registry to wire)
- [x] write unit tests in `test/prometheus-wrapper.test.js` using `node:test`: after each helper call, read `prom-client.register.getSingleMetric('video_calculated_lookup_total').get()` and assert the counter value at the right label combination
- [x] run `node --test test/prometheus-wrapper.test.js` — must pass before next task

### Task 3: Wire the new helper + counter into prv video routes

**Files:**
- Modify: `prv/routes/videos.js`

- [x] import `findVideoForReadWithOutcome` from `lib/find-video-for-read`
- [x] preserve the `!req.query.v` legacy branch verbatim, **including the commented-out duration-anomaly tracking block at lines 41–49** (do not delete or rewrite it). Treat the legacy branch as a separate path that does NOT emit a lookup outcome — it continues to emit only `request_without_version_total`
- [x] in the canonical (`req.query.v` present) branch, call the shared helper and capture `{ video, outcome }`
- [x] after the canonical lookup, branch on `videoCalculated` presence: if missing, override outcome to `'not_calculated'`
- [x] call `incrementVideoCalculatedLookup(outcome, 'prv')` once per request, only on the canonical branch, before sending the response
- [x] update the legacy branch to call `incrementRequestWithoutVersion('GET /video-calculated', 'prv')` (new signature)
- [x] update / add e2e cases in `test/e2e.js` for: `match`, `backfilled`, `mismatch`, `no_duration`, `not_calculated`, `not_found` outcomes against the prv endpoint (assert response code AND metric counter value after the request)
- [x] run `make test-e2e` — deferred to after Task 5: rt/yt and markups still reference the removed wrapper API, so e2e cannot run until those are updated. Verified locally with `node --check`.

### Task 4: Wire the new helper + counter into rt and yt video routes

**Files:**
- Modify: `rt/routes/videos.js`
- Modify: `yt/routes/videos.js`

- [x] remove the inline `findVideoForRead` from both files; import the shared helper
- [x] both routes require `duration` via `query('duration').isInt()` — there is no legacy `!req.query.v` branch or `no_duration` outcome reachable in practice; still pass `duration` through to the helper unchanged (helper handles `null` defensively)
- [x] derive `not_calculated` in the route handler when `VideoCalculated.findOne` returns null (same pattern as Task 3)
- [x] call `incrementVideoCalculatedLookup(outcome, 'rt')` / `(outcome, 'yt')` respectively
- [x] extend `test/e2e.js` with at least one happy-path (`match`) case per provider hitting `/rt/video-calculated` and `/yt/video-calculated`, asserting the counter increments with the correct provider label
- [x] run `make test-e2e` — deferred until after Task 5 (see Task 3 note); syntax verified with `node --check`

### Task 5: Update `prv/routes/markups.js` `request_without_version` call

**Files:**
- Modify: `prv/routes/markups.js`

- [x] change the call at line 35 to `incrementRequestWithoutVersion('POST /markup', 'prv')` (drop the `videoId` arg per the new signature)
- [x] confirmed by audit: rt/yt `markups.js` do not have a `!req.body.v` branch and do not call `incrementRequestWithoutVersion` — no changes needed in those files
- [x] extend `test/e2e.js` to assert that calling `POST /markup` without `v` increments `request_without_version_total{method="POST /markup", provider="prv"}` by 1
- [x] run `make test-e2e` — all 32 tests passing

### Task 6: Harden `express-prom-bundle` config and `/metrics` endpoint in `server.js`

**Files:**
- Modify: `server.js`
- Modify: `prv/routes/routes.js`

**Audited routes with `:param` segments** (these must all normalize to a stable label value; remember rt/yt mount under `/rt` and `/yt`):

| Source | Path pattern | Method(s) |
|---|---|---|
| `prv/routes/admin.js:7` | `/admin/video/:video_id` | GET |
| `prv/routes/admin.js:254` | `/admin/video/:video_id/user/:prv_user_id` | GET |
| `prv/routes/admin.js:414` | `/admin/markups/:id/delete` | GET |
| `prv/routes/markups.js:171` | `/markups/:id` | DELETE |
| `prv/routes/markups.js:193` | `/markups/:id/delete` | GET |
| `prv/routes/markups.js:219` | `/videos/:id/markups` | DELETE |
| `prv/routes/votes.js:79` | `/votes/:id/delete` | GET |
| `prv/routes/votes.js:102` | `/votes/user/:internal_user_id/update-rating` | GET |
| (same patterns repeat under `/rt` and `/yt`) | | |

- [x] **first, remove the broken `/metrics` handler in `prv/routes/routes.js:11–14`** (it references an undefined `metricsMiddleware` variable and currently 500s). Keep the `/` health route. The `/gdfgestshgergevcv3rwrf2e2e` test endpoint was left in place (out of scope)
- [x] configure `express-prom-bundle` in `server.js` with:
  - `includeMethod: true`, `includePath: true`, `includeStatusCode: true`
  - `autoregister: false`
  - `buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5]`
  - `excludeRoutes: [/^\/metrics(\/|$)/]` — suppresses self-recording when we serve `/metrics` manually (autoregister: false alone keeps the middleware recording the request even when bypassing its built-in handler)
  - `normalizePath` array of `[regex, replacement]` tuples — specific patterns first, with optional `/rt` / `/yt` prefix capture group on shared routes; admin routes are prv-only so no prefix branch
  - **Removed `urlValueParser: { minBase64Length: 1 }`** from the plan: the default `valueMasks` include a `^[a-zA-Z0-9\-_]{minBase64Length,}$` rule that, at length 1, swallows every literal path chunk (`admin`, `video`, `markups`) and rewrites them to `#val`. The default (66) is correct; the integer/UUID masks already cover stray numeric IDs as defense-in-depth
- [x] register `app.get('/metrics', ...)` in `server.js` AFTER `app.use(metricsMiddleware)` but BEFORE `app.use('/', routes)` (serves from `prom-client.register.metrics()`)
- [x] also `require('./prometheus-wrapper')` at top of `server.js` so the custom counters register on the default registry before the first scrape (the wrapper is otherwise only imported by route files, which load lazily on first hit)
- [x] add e2e cases in `test/e2e.js`:
  - GET `/metrics` returns 200 and the body contains the strings `video_calculated_lookup_total`, `request_without_version_total`, `http_request_duration_seconds`
  - `/metrics` itself does NOT appear as a `path` label value in `http_request_duration_seconds`
  - GET `/admin/video/<id>` normalizes to `path="/admin/video/#video_id"` — NOT the raw numeric id
  - DELETE `/markups/<id>` normalizes to `path="/markups/#id"` — NOT the raw numeric id
- [x] run `make test-e2e` — all 36 tests passing

### Task 7: Update production and dev `docker-compose.yml` for persistent Prometheus

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose.dev.yml`

- [x] add `name: native-ad-skip-api` at the top of both compose files so the named volume `prometheus_data` resolves to a stable `native-ad-skip-api_prometheus_data` regardless of the repo directory name
- [x] in `docker-compose.yml` (production):
  - uncomment the `prometheus` service
  - correct the mount to `prometheus_data:/prometheus`
  - expose port as `127.0.0.1:9090:9090` (loopback only)
  - add `restart: unless-stopped`
  - add `--storage.tsdb.retention.time=180d` to the command list (also keep `--storage.tsdb.path=/prometheus` for explicitness — matches Prometheus's default)
  - uncomment the `volumes:` block declaring `prometheus_data`
- [x] in `docker-compose.dev.yml` (dev):
  - keep the port binding at `9090:9090` (no loopback restriction — local browser access is expected)
  - fix the mount from `/data` to `/prometheus`
  - add `--storage.tsdb.retention.time=180d` (parity with prod)
- [x] no automated test (compose is config) — manual verification covered in Post-Completion
- [x] run `docker compose -f docker-compose.yml config` AND `docker compose -f docker-compose.dev.yml config` to validate YAML — both succeed

### Task 8: Update `config/prometheus.yml` and `config/prometheus.dev.yml`

**Files:**
- Modify: `config/prometheus.yml`
- Modify: `config/prometheus.dev.yml`

- [x] set `global.scrape_interval: 30s` and `global.evaluation_interval: 30s` in both files
- [x] rename the job to `native-ad-skip-api` in both files
- [x] in `config/prometheus.yml` (prod): change target to `app:3022` (compose service name; survives container rename)
- [x] in `config/prometheus.dev.yml`: change target from `host.docker.internal:3022` to `app:3022`. Rationale: the dev compose stack runs the API as the `app` service in the same network as Prometheus, so the service name is the correct target. The old `host.docker.internal` value was for scraping a host-side `yarn dev`; that mode is no longer the primary dev workflow per CLAUDE.md.
- [x] no automated test (config); the e2e suite in Task 6 already verifies `/metrics` is reachable
- [ ] deferred to Post-Completion: `docker compose -f docker-compose.dev.yml up -d prometheus app` and confirm the target appears `UP` in `http://localhost:9090/targets` (requires a real DB host; covered by the manual verification steps below)

### Task 9: Add minimal `docker-compose.yml` to the Grafana repo

**Files:**
- Create: `../native-ad-skip-grafana/docker-compose.yml`
- Modify: `../native-ad-skip-grafana/README.md`
- Modify: `../native-ad-skip-grafana/.env` (add `GF_ADMIN_PASSWORD` placeholder — real value lives only on the deploy host; do NOT commit a real password)

- [x] write a compose file with:
  - `name: native-ad-skip-grafana` at the top (pins the volume identity to `native-ad-skip-grafana_grafana_data`)
  - `build: .`, `restart: unless-stopped`
  - `ports: ['127.0.0.1:3024:3024']` — Grafana listens on 3024 internally because `GF_SERVER_HTTP_PORT=3024` is set in the existing `.env` (loaded via `env_file: .env`)
  - attached to network `main-network` declared `external: true`
  - volume `grafana_data:/var/lib/grafana`
  - env `GF_USERS_ALLOW_SIGN_UP=false`, `GF_SECURITY_ADMIN_PASSWORD=${GF_ADMIN_PASSWORD}`
- [x] add a short README section documenting:
  - **Precondition:** `docker network create main-network` must already have been run on the host (idempotent: `docker network inspect main-network >/dev/null 2>&1 || docker network create main-network`). The api stack does NOT create this network either — both stacks declare it `external: true`.
  - Datasource URL: `http://prometheus:9090`
  - Rationale for persistence-only-no-provisioning today (manual dashboards safe on `grafana_data` volume; provisioning can be added later non-destructively)
- [x] no automated test (config); verified manually after deploy
- [x] run `docker compose config` inside the Grafana repo locally to validate the YAML — passes
- [x] `.env` itself is gitignored and pre-existing — the README documents `GF_ADMIN_PASSWORD` as required, no committed placeholder needed

### Task 10: Rewrite the `Prometheus Metrics` section in `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [x] replace the existing `### Prometheus Metrics (prometheus-wrapper.js)` section with a section that lists:
  - the two custom counters and their label sets
  - all six outcome states with their exact definitions (copy from Technical Details above)
  - the `express-prom-bundle` histogram and what queries it answers
  - retention (180 d), scrape interval (30 s), storage (`prometheus_data` named volume)
  - sibling Grafana repo location and `main-network` linkage
- [x] remove references to the deleted `incrementVideoCalculatedFound` / `incrementVideoCalculatedNotFound` API
- [x] no automated test (documentation); a human reviews the diff
- [x] commit and proceed to verification

### Task 11: Verify acceptance criteria
- [x] verify all six outcome states are emitted by the e2e suite (covered by tests 17–24 in `test/e2e.js`)
- [x] verify `/metrics` does not appear in `http_request_duration_seconds` series (e2e test 34)
- [x] verify path normalization rewrites `/admin/video/<id>` → `path="/admin/video/#video_id"` and `/markups/<id>` → `path="/markups/#id"` (e2e tests 35, 36)
- [x] run full e2e: `make test-e2e` — 36 pass / 0 fail
- [x] run unit tests: `node --test test/find-video-for-read.test.js test/prometheus-wrapper.test.js` — 9 pass / 0 fail
- [x] run Go calculator pure unit tests: `go test ./calculator -run 'TestFindMedian|TestProcess'` — pass (integration test `TestIntegration` requires DB env vars, unchanged by this work)

### Task 12: [Final] Move plan to completed
- [x] verify CLAUDE.md changes render correctly
- [x] `mkdir -p docs/plans/completed && mv docs/plans/20260512-prometheus-monitoring.md docs/plans/completed/`

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only.*

**Host precondition (run BEFORE either compose stack):**

```bash
docker network inspect main-network >/dev/null 2>&1 || docker network create main-network
```

This is idempotent. Both compose stacks declare `main-network` as `external: true`, so neither will create it.

**Manual verification on deployed VM:**

- After CI/CD deploys the updated `native-ad-skip-api` stack, confirm `http://<vm>:9090/targets` shows the `native-ad-skip-api` job target as `UP` (scraping `app:3022`). Note: port 9090 is bound to `127.0.0.1` in production — use `ssh -L 9090:127.0.0.1:9090` or similar to access from a laptop.
- Confirm the `native-ad-skip-api_prometheus_data` named volume exists (`docker volume ls | grep prometheus`) and is non-empty after ~5 minutes of scraping (`docker run --rm -v native-ad-skip-api_prometheus_data:/data alpine ls /data`).
- Bring up the Grafana stack from `native-ad-skip-grafana` (`docker compose up -d`) AFTER the api stack is up — Grafana joins the same `main-network` and resolves `prometheus` by DNS within that network.
- In Grafana, configure a Prometheus datasource pointing at `http://prometheus:9090`; run the datasource health check (must succeed before dashboard work begins).
- Rebuild dashboards manually (provisioning is intentionally deferred). Dashboard data is preserved across rebuilds via the `native-ad-skip-grafana_grafana_data` named volume.

**External system updates:**

- Deploy host needs `GF_ADMIN_PASSWORD` set in the Grafana repo's `.env` before first launch (do NOT commit the real value).
- If Grafana was previously running on this host with a different configuration, the new compose stack will collide on the host port `3024` — stop the old instance first.
- No changes required in client apps (HTTP response surface is unchanged).
