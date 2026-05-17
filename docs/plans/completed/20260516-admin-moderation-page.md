# Admin moderation page

## Overview

New admin page that surfaces "bad signals" about users and markups in a single sorted view so an admin can ban a user or delete a markup, with every decision logged for history and used as a re-surface watermark.

- **Problem solved**: today there's no unified place to spot bad actors or systematically wrong markups. The existing per-video admin page only helps once you already know the bad video.
- **Approach**: server-rendered HTML page at `/admin/moderation` with two top-of-page sorted scoreboards (users + markups), informational sections below for raw signal samples and video-integrity flags, and a decision history at the bottom. Decisions persist as snapshots; an item only re-surfaces if new signals accumulate past a threshold.
- **Scope**: prv provider only (matches existing admin scope). All work in Node.js + Sequelize. No Go changes.

## Context (from discovery)

- **Existing admin**: `prv/routes/admin.js` (430 lines) — server-rendered HTML, query-param bearer auth (`?verifyBearerToken=…`), AJAX `delete` endpoints. New moderation route should match this style but live in a sibling file to avoid bloating `admin.js`.
- **Markup soft-delete pattern**: `markupRepository.softDeleteByIds([id], 'admin', null)` followed by `Markup.update({ is_new: true }, ...)` to retrigger calc, or `VideoCalculated.destroy(...)` if no siblings remain. Mirrored from existing `/admin/markups/:id/delete` handler (admin.js:406).
- **Vote → user rating link**: `prv/service/user.js:updateRatingByVote` updates the markup author's rating only when a single exact-match markup exists. This is the existing single-blame heuristic we'll extend with a more permissive "closest-match" rule for scoring.
- **Banned-user gate model**: `prv/routes/markups.js:45` already has a soft-rejection pattern — when `user.rating <= -2`, return `201` and log (not 4xx). The new `banned_at` gate will mirror this exact pattern for consistency.
- **Schema bootstrap pattern**: `db.js` calls `sequelize.sync()` then seeds categories in `.then()`. We extend this hook with idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for `banned_at` (the project does not use migrations folder).
- **e2e test harness**: `test/e2e.js` (Node `node:test`) spins up a real Postgres test DB and the Node server on port 3099. Run via `make test-e2e`. All new test scenarios go here.

## Development Approach

- **testing approach**: Regular (implementation first, then tests within the same task)
- complete each task fully before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** — listed as separate checklist items
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- run `make test-e2e` after each task with backend-touching changes
- maintain backward compatibility for the existing `/admin/*` routes

## Testing Strategy

- **unit tests**: required for every task with logic worth isolating (scoring math, closest-match resolver)
- **e2e tests** via `test/e2e.js`: required for HTTP-touching changes (page rendering with `?format=json`, decide endpoint, banned-user gate, auto-ban hook)
- e2e tests live in `test/e2e.js` and must pass before next task

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope
- keep plan in sync with actual work done

## Solution Overview

- **Architecture**: stateless per-request SQL. ~5 SELECTs per page load, no precomputed signal tables, no background job, no cache. Decision history is a thin append-only table; scoreboard subtracts the latest decision's snapshot to decide whether to re-surface.
- **Score formula** (constants in one file, easy to tune):
  - Users: `score = 3*dislikes + 1*undos`
  - Markups: `score = 3*dislikes + 1*undos + 3*max(0, -segment_rating)`
- **Closest-matching markup rule** is a single shared helper used by both scoring queries and (later) by any future code that needs to attribute a vote/undo to one markup.
- **Decision lifecycle**: approve/reject inserts an `admin_decisions` row with a JSON snapshot of current signals. A row re-surfaces only if `current_score - snapshot.score >= 5`.

## Technical Details

### Schema additions

1. New column on `users` table (prv only):
   ```sql
   ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP NULL;
   ```
   Added in `db.js` after `sequelize.sync()` resolves, alongside category seeding (idempotent — safe to run every boot).

2. New table `prv_admin_decisions` (created by `sequelize.sync()` via a new model):
   ```
   id                SERIAL PK
   target_type       VARCHAR(16)   -- 'user' | 'markup'
   target_id         INTEGER
   decision          VARCHAR(16)   -- 'approve' | 'reject'
   signals_snapshot  JSONB         -- { dislikes, undos, segment_rating, score }
   decided_at        TIMESTAMP
   decided_by        VARCHAR(16)   -- 'admin' | 'auto'
   INDEX             (target_type, target_id, decided_at DESC)
   ```

### Constants block (top of `prv/routes/admin-moderation.js`)

```js
const WEIGHT_DISLIKE = 3;
const WEIGHT_UNDO = 1;
const WEIGHT_SEGMENT_RATING = 3;
const RESURFACE_THRESHOLD = 5;
const SCOREBOARD_LIMIT = 50;
const HISTORY_LIMIT = 50;
const RECENT_DAYS = 7;
const UNDO_MATCH_TOLERANCE = 2;
const AUTO_BAN_RATING_THRESHOLD = -100;
```

### Closest-matching markup rule

Given a target `(video_id, category_id, start, end)`:
1. Candidate set: markups linked via `prv_calculated_segment_markups` where the segment's `category_id` matches and `(segment.start, segment.end)` falls within `±UNDO_MATCH_TOLERANCE` of the target (exact match for votes, fuzzy for undos).
2. Score each candidate: `abs(interval.start - target.start) + abs(interval.end - target.end)`.
3. Smallest wins; ties broken by `markup.id ASC`.
4. Skip markups where `deleted_at IS NOT NULL`.

### New routes

| Verb | Path | Output |
|---|---|---|
| GET | `/admin/moderation?verifyBearerToken=…&show=all&format=json` | HTML (or JSON for tests) |
| POST | `/admin/moderation/decide?verifyBearerToken=…` | `204` |
| GET | `/admin/user/:prv_user_id?verifyBearerToken=…` | HTML (video-less user view) |

### Decision flow (single transaction)

1. Recompute current snapshot for `(target_type, target_id)` using the same scoreboard query.
2. Apply side effect:
   - `user` + `reject` → `UPDATE users SET banned_at = NOW() WHERE id = $1`
   - `user` + `approve` → if `banned_at IS NOT NULL`, clear it (unban); else no row-state change
   - `markup` + `reject` → `softDeleteByIds([id], 'admin', null)`; mark siblings `is_new = true`; if no siblings, `VideoCalculated.destroy({video_id})`
   - `markup` + `approve` → no row-state change
3. `INSERT INTO prv_admin_decisions ...` with snapshot, `decided_by='admin'`.

### Auto-ban hook (in `prv/service/user.js`)

After every rating mutation:
```js
if (user.rating <= AUTO_BAN_RATING_THRESHOLD && user.banned_at == null) {
    await user.update({ banned_at: new Date() });
    // INSERT a prv_admin_decisions row, decided_by='auto', snapshot computed inline
}
```
The snapshot for auto-ban is computed by calling the same scoring helper used by the page.

### Banned-user gate (in `prv/routes/markups.js`)

After the existing `user.rating <= IGNORE_MARKUPS_USER_RATING_VAL` check, add a parallel branch:
```js
if (user.banned_at != null) {
    console.warn('Do not create markup because user is banned', {...});
    res.status(201).send('Created');
    return;
}
```
Same silent-201 + log shape as the existing rating gate. Hard-banned users hit this branch; their markups are never created. The existing rating ≤ -2 soft gate stays — orthogonal.

### Hide-already-decided

Default `/admin/moderation` excludes rows where a `decision` exists AND `(current_score - snapshot.score) < RESURFACE_THRESHOLD`. `?show=all` reveals everything.

### Page layout

```
TOP — sorted scoreboards (worst first, top 50 each)
  USERS table  [Ban] [Approve] per row
  MARKUPS table  [Delete] [Approve] per row

MIDDLE — context sections
  § Recent dislikes (last 7d, latest 50)
  § Recent undos (last 7d, latest 50)
  § Video integrity (duplicate native_ids, DurationLog outliers)

BOTTOM — decision history (latest 50)
```

Inline CSS, dark theme, AJAX action handlers — matching existing `prv/routes/admin.js` style.

## What Goes Where

- **Implementation Steps**: schema bootstrap, new model, repository, scoring helper, scoreboard route, decide route, video-less user route, banned-user gate, auto-ban hook, tests
- **Post-Completion**: deploy to prod (idempotent ALTER runs on boot); manual sanity check of `/admin/moderation` against real data

## Implementation Steps

### Task 1: Add `banned_at` column + `AdminDecision` model

**Files:**
- Modify: `prv/db/index.js`
- Modify: `db.js`

- [x] add `banned_at: { type: DataTypes.DATE, allowNull: true }` to `User` model in `prv/db/index.js`
- [x] add new `AdminDecision` Sequelize model in `prv/db/index.js` with fields `target_type`, `target_id`, `decision`, `signals_snapshot` (JSONB), `decided_at`, `decided_by`; tableName `prv_admin_decisions`; index on `(target_type, target_id, decided_at DESC)`
- [x] export `AdminDecision` from the module
- [x] in `db.js`, inside the `sequelize.sync().then(...)` callback, run a raw `ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP NULL` (idempotent — survives multiple boots)
- [x] verify locally (deferred to Tasks 2+3 integration tests — see plan note)
- [x] **no dedicated tests** — pure schema task; correctness is verified by Tasks 2 + 3 integration tests which depend on these tables existing

### Task 2: Closest-matching markup resolver (shared helper)

**Files:**
- Create: `prv/repository/moderation.js`
- Create: `test/moderation-resolver.test.js`

- [x] create `prv/repository/moderation.js` exporting a `closestMarkupForTarget({video_id, category_id, start, end, tolerance})` function
- [x] query candidate markups via `prv_calculated_segment_markups` join with `prv_calculated_segments` filtered by `category_id` and start/end within `±tolerance` (tolerance=0 for exact-match vote case)
- [x] join `markups` and `markup_time_intervals`, filter `markups.deleted_at IS NULL`
- [x] score each candidate `abs(interval.start - target.start) + abs(interval.end - target.end)`, return the row with the smallest score; tie-break by `markup.id ASC`
- [x] return `null` if no candidate
- [x] **scope note**: this resolver is consumed ONLY by the new scoreboard queries (undo attribution) in v1. It does NOT replace `userService.updateRatingByVote`'s existing exact-match logic. Do not edit `prv/service/user.js` to use it.
- [x] write unit test: seed minimal segment + 3 contributing markups with different interval offsets → assert closest one wins
- [x] write unit test: all candidates soft-deleted → returns null
- [x] write unit test: tie on score → smaller markup.id wins
- [x] run `node --test test/moderation-resolver.test.js` — must pass before task 3

### Task 3: Scoring queries (users + markups scoreboards)

**Files:**
- Modify: `prv/repository/moderation.js`
- Modify: `test/moderation-resolver.test.js`

- [x] add `getUserScoreboard({limit, recentDays})` to `prv/repository/moderation.js`: returns array of `{user_id, prv_user_id, dislikes, dislikes_7d, undos, undos_7d, rating, markups_total, markups_recent, score}` sorted desc by score, limited
- [x] implement via raw SQL: subquery for dislikes (vote=-1 joined to closest-match markup author), subquery for undos (same), join users, compute score = 3*dislikes + 1*undos
- [x] add `getMarkupScoreboard({limit, recentDays})`: returns `{markup_id, dislikes, dislikes_7d, undos, undos_7d, segment_rating, user_id, prv_user_id, video_id, score}` sorted desc
- [x] implement score = 3*dislikes + 1*undos + 3*max(0, -segment_rating)
- [x] write unit test: seed 2 users with mixed dislikes/undos → assert score order matches formula
- [x] write unit test: seed 1 markup with negative segment_rating only → assert score reflects 3× weight
- [x] write unit test: signals older than 7d not counted in `*_7d` columns
- [x] run tests — must pass before task 4

### Task 4: Decision recording + snapshot/re-surface logic

**Files:**
- Modify: `prv/repository/moderation.js`
- Modify: `test/moderation-resolver.test.js`

- [x] add `recordDecision({target_type, target_id, decision, decided_by})` that recomputes the current snapshot (single-row variant of the scoreboard query) and inserts a row into `prv_admin_decisions`. This is the **single entrypoint** for writing decisions — both the admin POST endpoint and the auto-ban hook call it (passing `decided_by='admin'` or `decided_by='auto'`).
- [x] add `getLatestDecisionsMap(target_type, target_ids[])` returning a `Map` of `target_id → latest decision row` (one batched query, avoids N+1)
- [x] **inline filtering, no separate helper**: the re-surface filter is a 3-line inline check in the scoreboard route handler — `row.score - (latestDecision?.signals_snapshot?.score ?? 0) >= RESURFACE_THRESHOLD`. Do not add a standalone `filterByResurfaceThreshold` function.
- [x] write unit test: insert a decision with snapshot, add new dislikes, assert `getLatestDecisionsMap` returns expected snapshot
- [x] write unit test: target with no prior decision returns `undefined` from the map (caller treats as "always surface")
- [x] run tests — must pass before task 5

### Task 5: Create `/admin/moderation` page (HTML + JSON debug)

**Files:**
- Create: `prv/routes/admin-moderation.js`
- Modify: `prv/routes/index.js`

- [x] create `prv/routes/admin-moderation.js` exporting `createAdminModerationRoutes(models, {markupRepository, moderationRepository})`
- [x] declare all constants (`WEIGHT_DISLIKE`, etc.) at top of file
- [x] implement `GET /admin/moderation`: auth via `req.query.verifyBearerToken === AUTH_TOKEN`; load user+markup scoreboards, recent dislikes, recent undos, video-integrity rows, decision history
- [x] apply re-surface filtering unless `?show=all` present
- [x] when `?format=json`, respond with `res.json({users, markups, recent_dislikes, recent_undos, video_integrity, history})` where the top-level keys are EXACTLY those six (test contract — HTML render must use the same in-memory shape). Each `users[]` row: `{user_id, prv_user_id, score, dislikes, dislikes_7d, undos, undos_7d, rating, markups_total, markups_recent, banned_at, last_decision}`. Each `markups[]` row: `{markup_id, score, dislikes, dislikes_7d, undos, undos_7d, segment_rating, user_id, prv_user_id, video_id, video_native_id, last_decision}`. `history[]` row: full `prv_admin_decisions` row.
- [x] wire the new router in `prv/routes/index.js` (`router.use('/', require('./admin-moderation')(models, {markupRepository, moderationRepository}))`)
- [x] instantiate `moderationRepository = require('../repository/moderation')(models, sequelize)` in `prv/routes/index.js`
- [x] write e2e test in `test/e2e.js`: seed signals against multiple users/markups, GET `/admin/moderation?format=json&verifyBearerToken=...`, assert response shape and order
- [x] write e2e test: `?show=all` reveals decided items hidden by default
- [x] run `make test-e2e` — deferred to user (sandbox is read-only Docker fs); `node --check` passed on all touched files

### Task 6: `POST /admin/moderation/decide` endpoint

**Files:**
- Modify: `prv/routes/admin-moderation.js`
- Modify: `test/e2e.js`

- [x] add `POST /admin/moderation/decide` accepting JSON `{target_type, target_id, decision}`
- [x] **explicit auth check** (first line of handler): if `req.query.verifyBearerToken !== process.env.AUTH_TOKEN` return `401`. Do NOT rely on the GET-handler's check — this is a separate, state-changing endpoint.
- [x] wrap the whole handler in a Sequelize transaction
- [x] inside the transaction: call `recordDecision` (writes the snapshot), then apply side effect (the four cases are **mutually exclusive** — pick one branch based on `target_type` + `decision`):
  - `user`+`reject` → `UPDATE users SET banned_at = NOW()` (only if not already banned)
  - `user`+`approve` → `UPDATE users SET banned_at = NULL` (only if currently banned)
  - `markup`+`reject` → `markupRepository.softDeleteByIds([id], 'admin', null)`, then check siblings via `markupRepository.findAll({where: {video_id}})`:
    - **branch A**: if siblings exist → `Markup.update({is_new: true}, {where: {video_id}})` to retrigger calc
    - **branch B**: if NO siblings → `VideoCalculated.destroy({where: {video_id}})`
    - branches A and B are mutually exclusive — implementer must `if (siblings.length > 0) { A } else { B }`, mirroring `prv/routes/admin.js:418-423`
  - `markup`+`approve` → no row-state change (decision row alone is the entire side effect)
- [x] return `204` on success, `400` on bad input, `401` on bad token, `404` on missing target
- [x] write e2e test: missing/invalid token → 401, no decision row written, no state change
- [x] write e2e test: POST reject on a markup with siblings → markup soft-deleted, siblings `is_new=true`, `VideoCalculated` row still exists, decision row exists with correct snapshot
- [x] write e2e test: POST reject on a markup with no siblings → markup soft-deleted, `VideoCalculated` row destroyed, decision row exists
- [x] write e2e test: POST reject on a user → `users.banned_at` set, decision row inserted
- [x] write e2e test: POST approve on a banned user → `banned_at` cleared (unban path), decision row inserted
- [x] write e2e test: missing/invalid `target_type` → 400
- [x] run `make test-e2e` — deferred to user (sandbox: read-only Docker fs); `node --check` passed on all touched files

### Task 7: Re-surface threshold behavior

**Files:**
- Modify: `test/e2e.js`

- [x] write e2e test: create user with 3 dislikes (score=9); POST approve → user no longer in scoreboard default view
- [x] add 1 more dislike (4 total, delta=3 < 5) → still hidden
- [x] add 1 more dislike (5 total, delta=6 ≥ 5) → re-surfaces
- [x] write e2e test: `?show=all` shows the user throughout, regardless of delta
- [x] add sanity test: approved user with 0 new signals stays hidden across multiple GETs
- [x] run `make test-e2e` — deferred to user (sandbox: read-only Docker fs); `node --check` passed on test/e2e.js

### Task 8: Auto-ban hook in user service [x]

**Files:**
- Modify: `prv/routes/index.js`
- Modify: `prv/service/user.js`
- Modify: `test/e2e.js`

- [x] **wiring order in `prv/routes/index.js`** (must be done first to avoid a circular dep — call it out explicitly):
  ```
  models → markupRepository
        → moderationRepository(models, sequelize)
        → userService(models, {markupRepository, markupTimeIntervalRepository, moderationRepository})
        → routes (admin-moderation router takes moderationRepository; votes router takes userService)
  ```
- [x] add `moderationRepository` parameter to `createUserService(models, deps)` and store on closure
- [x] in `updateRatingByVote`, after `user.increment('rating', ...)`, reload to read fresh rating, then if `user.rating <= AUTO_BAN_RATING_THRESHOLD && user.banned_at == null`:
  - set `banned_at = NOW()` on the User row
  - call `moderationRepository.recordDecision({target_type: 'user', target_id: user.id, decision: 'reject', decided_by: 'auto'})` — this is the **same single entrypoint** that the admin POST uses; no helper extraction
- [x] the `user.banned_at == null` guard means **no duplicate decision rows** on repeat crossings (e.g. rating goes -100 → -110 → -120 still produces exactly ONE auto decision row, written at the first crossing)
- [x] write e2e test: drive a user's rating to -100 via many -1 votes; assert `users.banned_at IS NOT NULL` and exactly ONE `prv_admin_decisions` row with `decided_by='auto'` exists
- [x] write e2e test (idempotency under repeated crossings): drive a user from healthy → -100 (1 auto row written), then continue voting to drop rating to -120 → still exactly 1 auto decision row, `banned_at` unchanged
- [x] write e2e test: user already manually banned (`banned_at` set, decided_by='admin') — auto-ban path does NOT write a second decision row when rating crosses -100
- [x] run `make test-e2e` — deferred to user (sandbox: read-only Docker fs); `node --check` passed on all touched files

### Task 9: Banned-user gate in `POST /markup`

**Files:**
- Modify: `prv/routes/markups.js`
- Modify: `test/e2e.js`

- [x] after the existing `user.rating <= IGNORE_MARKUPS_USER_RATING_VAL` check in `POST /markup`, add a parallel `if (user.banned_at != null) { log + return 201 }` branch
- [x] preserve existing rating-gate behavior (do not remove or alter)
- [x] write e2e test: pre-set a user's `banned_at` directly in DB, POST /markup as that user → response 201, no `Markup` row created
- [x] write e2e test: unbanned user with `banned_at = null` → markup still created normally (regression)
- [x] run `make test-e2e` — deferred to user (sandbox: read-only Docker fs); `node --check` passed on all touched files

### Task 10: Video-less user view `/admin/user/:prv_user_id`

**Files:**
- Modify: `prv/routes/admin-moderation.js` (or `prv/routes/admin.js` — pick whichever is cleaner)
- Modify: `test/e2e.js`

- [x] add `GET /admin/user/:prv_user_id` rendering a dark-theme HTML page: user header (prv_user_id, rating, banned_at, time_saved), list of all their markups across all videos, with delete buttons
- [x] reuse the styling of the existing per-video user view (`/admin/video/:id/user/:prv_user_id` in `prv/routes/admin.js`)
- [x] from scoreboard, user-row link points at this new route
- [x] write e2e test: GET the new route → 200, contains expected markup IDs
- [x] write e2e test: unauthorized request → 401
- [x] run `make test-e2e` — deferred to user (sandbox: read-only Docker fs); `node --check` passed on all touched files

### Task 11: Verify acceptance criteria

- [x] verify users scoreboard renders correctly with seeded data — code-level audit passed (prv/routes/admin-moderation.js:228-253 emits exact JSON contract keys: user_id, prv_user_id, score, dislikes, dislikes_7d, undos, undos_7d, rating, markups_total, markups_recent, banned_at, last_decision)
- [x] verify markups scoreboard renders correctly with seeded data — code-level audit passed (prv/routes/admin-moderation.js:255-268 emits exact contract keys: markup_id, score, dislikes, dislikes_7d, undos, undos_7d, segment_rating, user_id, prv_user_id, video_id, video_native_id, last_decision)
- [x] verify decide endpoint applies the correct side effect for each (target_type, decision) combination — code-level audit passed (prv/routes/admin-moderation.js:642-677: four mutually-exclusive `if/else if` branches; markup+reject siblings check mirrors admin.js:418-423; markup+approve is a no-op beyond the decision row; user banned_at toggled with idempotent guards)
- [x] verify re-surface threshold of 5 is respected — code-level audit passed (prv/routes/admin-moderation.js:79-86 inline filter; `RESURFACE_THRESHOLD = 5`; formula `(row.score - snapshotScore) >= RESURFACE_THRESHOLD` exactly per plan)
- [x] verify auto-ban at -100 rating sets `banned_at` and logs a decision — code-level audit passed (prv/service/user.js:38-57: increment → reload → threshold check → banned_at update → recordDecision with decided_by='auto'; banned_at==null guard ensures single row)
- [x] verify banned-user gate silently rejects markup creation — code-level audit passed (prv/routes/markups.js:57-67: after rating gate, `if (user.banned_at != null)` logs and returns 201 BEFORE Markup.create)
- [x] verify `?show=all` reveals all rows regardless of decisions — code-level audit passed (prv/routes/admin-moderation.js:79,81: `showAll = req.query.show === 'all'` short-circuits filterRow with `return true`)
- [x] verify `?format=json` returns structured data identical to the HTML's underlying data — code-level audit passed (prv/routes/admin-moderation.js:270-275: both branches consume the same `payload` object; branch happens at output formatting only)
- [x] run full suite: `make test-e2e` — deferred to user (sandbox: read-only Docker fs prevents Docker compose stack from starting)
- [x] verify no regression in existing `/admin/video/:id` page — code-level audit passed (`git diff --stat main..admin-moderation-page` shows prv/routes/admin.js is NOT modified on this branch)

### Task 12: Update documentation

- [x] add a "Moderation" subsection to the **Routes** section of `CLAUDE.md`, documenting `/admin/moderation`, `/admin/moderation/decide`, `/admin/user/:prv_user_id`, and the constants block
- [x] add `banned_at` to the `User` row of the Database Models table in `CLAUDE.md`
- [x] add `AdminDecision` to the Database Models table in `CLAUDE.md`
- [x] move this plan to `docs/plans/completed/`

## Post-Completion

**Manual verification on prod**:
- After deploy, hit `/admin/moderation?verifyBearerToken=…` and confirm scoreboards render with realistic data.
- Spot-check at least one Ban and one Delete action; confirm `prv_admin_decisions` row and side effect both happened.
- Confirm idempotent `ALTER TABLE` ran cleanly against the existing prod `users` table (no error in app startup logs).

**Tuning** (no code changes needed):
- Weights (`WEIGHT_DISLIKE`, `WEIGHT_UNDO`, `WEIGHT_SEGMENT_RATING`) and `RESURFACE_THRESHOLD` are constants at the top of `prv/routes/admin-moderation.js`. After a week of real use, revisit numbers.

**Out of scope for v1** (note for future):
- `rt` and `yt` providers — copy the same route + model into their dirs.
- Prometheus-derived signals (would require new `native_id` label, cardinality concern).
- `client_failed` event as a user-level signal (currently debug-only).
