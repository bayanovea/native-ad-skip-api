# AI segments: keep every detected segment, serve by precomputed rules

## Overview

Today `ai detect` keeps only the segments that pass the publish rules (`accepted()` confidence thresholds, ≥ 5 s after inward rounding) in `prv_ai_video_calculateds.data`; the rest exists only inside `prv_ai_runs.raw_output`. A verdict with bounds shorter than 5 s is refused on the review page, and the below-threshold sheets (`B<n>` items) are `kind = 'sheet'`, so an assessor's "this is an ad" on a dropped segment changes nothing for viewers.

Owner's decisions (2026-10-27):

- **Store every segment.** The row keeps all detector segments; `data` stays "exactly what is served", a second column `hidden` holds the others with the reason they are not served.
- **Two layers.** (1) *Truth* about a segment: the model's answer, overridden by an assessor's verdict (category, bounds, "not an ad"). The confidence thresholds live here: they apply only to segments without a verdict. (2) *Serving filter*: rules over the truth, today one, the minimum length (5 s); it applies to every segment, verdict or not. Both layers are **precomputed** into `data` / `hidden`; nothing is evaluated on the read path.
- **The verdict is the last word.** A keep verdict on a hidden segment serves it (unless the length rule hides it); `not_ad` / `unclear` hides a segment for good, whatever the rules say later. A wrong verdict comes back through the existing judge loop (new dislikes / undo / conflicting markup after the verdict → LLM → review items).
- **Short bounds are saved.** An assessor may set bounds under 5 s: the segment is recorded at those bounds and hidden with reason `short`; the page says so instead of refusing.
- **A rule change is a recompute**, not a read-time filter: `ai regate` moves entries between `data` and `hidden` under the row lock. The length threshold becomes `AI_MIN_SEGMENT_SECONDS` (default 5), read by Go and Node.
- **Backfill**: `hidden` is filled for the rows already published, from `raw_output` + `transcript` of their run (the recompute that `scripts/import-below-threshold.js` does today), so a threshold change reaches them too.

Precision-first stays: a hidden segment reaches viewers only through a rule change by the owner or a human's keep verdict.

## Context (from discovery)

- `ai/pipeline/publish.go`: `Entry`, `accepted()`, `minSegmentSeconds`, `entries()` (filter + inward rounding), `publish()` (writes `data` with `calculator.WithVoteRatings` under the `video_calculateds` lock). `ai/pipeline/detect.go` `finish()` (line ~698) is the only caller.
- `prv/repository/ai.js`: `applyVerdict()` (entry lookup in `data` by `from` bounds, keep → move / re-category with `voteRating`, drop → filter out, withdraw by `review` when `data` is empty, restore via `allKept()`), `withdraw()`.
- `prv/routes/admin-review.js`: `parseBodyBounds()` (line ~93) and the page's `readBounds()` (line ~812) both call `validateVerdictBounds` (`lib/review-sheet.js`, `short` = under 5 s); `decide` applies the verdict at line ~1071. `prv/repository/review.js` `recordVerdict()` validates once more (line ~644). Locale keys `error_bounds_short`, `bounds_hint` in `prv/locales/review/{ru,en}.json`.
- `ai/judge/judge.go` `dueVideos()` (non-empty `data`), `signals.go` `entryKeeps()` (items → entries by effective bounds), `review.go` `addReviewItems()` (one `kind='ai'` item per `data` entry; same INSERT as `reviewRepository.insertItems`).
- `scripts/import-below-threshold.js`: recomputes the dropped segments from `raw_output` (`published()` mirrors `accepted()` + the floor), creates `kind='sheet'` items `B<n>`; e2e `import-below-threshold:` test in `test/e2e.js` (~line 1106).
- `lib/find-ai-calculated.js` `servesAi()` (non-empty `data`), `calculator/recompute.go` (AI ratings, `data` only), `prv/routes/admin.js` `aiBlock()` (entries table), `grafana/dashboards/ai-pipeline.json` (panels at lines ~2645 and ~4092 recompute "segments below the threshold" from `raw_output`; the other `jsonb_array_length(data)` panels mean "served" and stay).
- Schema: `lib/schema.js` idempotent ALTERs; model `AiVideoCalculated` in `prv/db/index.js` (line ~251). Env wiring: `docker-compose.yml`, `.github/workflows/deploy.yml` two lists, `infrastructure/init/init_env.sh` copies `AI_*` into `/app/.env`.
- Docs to keep in step: CLAUDE.md (AI-first segments, Ops, Models), `docs/ai-first-overview/{ru,en}.html` + the two artifacts, `docs/backlog/ai-below-threshold-verdicts.md`.

## Development Approach

- **testing approach**: Regular (code first, then tests), per the owner's rule: tests change with behaviour.
- complete each task fully before moving to the next; small, focused changes matching the surrounding style
- **every task includes its tests**: Go unit tests (sqlmock / fixtures) for the pipeline and judge, `node:test` unit tests for `lib/`, e2e (`make test-e2e`) for anything that crosses Node ↔ Go ↔ Postgres
- all tests pass before the next task; CLAUDE.md is updated in the same change as the behaviour it describes
- update this plan when scope changes

## Testing Strategy

- **unit**: `go test -mod=vendor ./ai/... ./calculator`, `make test-unit`
- **e2e**: `make test-e2e` (the `ai…:` tests drive the real binary with the fixture client; the detect fixtures already contain below-threshold segments: `-1_456000201` 300–320 `self_promotion medium`, `-1_456000206` 20–30 `sponsor low`; `-1_456000201` also a 3-s sponsor 480–483)
- no UI e2e framework; the page's bounds handling is covered through `format=json` + `POST /decide` in e2e and the inlined helpers in `test/review-sheet.test.js`

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix, blockers with ⚠️ prefix
- keep the plan in sync with the work

## Solution Overview

**Row shape.** `prv_ai_video_calculateds` gets `hidden JSONB NOT NULL DEFAULT '[]'`. Entries of both arrays share the shape `{category_id, start, end, confidence, source: "ai" | "review", rating?}`; a `hidden` entry also carries `reason`:

| reason | meaning | who sets it | who clears it |
|---|---|---|---|
| `confidence` | truth layer: below `accepted()` and no verdict | publish, backfill, regate | a keep verdict (→ `data` or `short`), regate when the thresholds drop |
| `short` | serving filter: `end − start < AI_MIN_SEGMENT_SECONDS` | publish, backfill, a verdict with short bounds, regate | regate when the threshold drops, a keep verdict with longer bounds |
| `review` | truth layer: an assessor said `not_ad` / `unclear` | `applyVerdict` | a later keep verdict on the same item (the verdict history is the truth) |

`data` never carries `reason`. `servesAi`, the vote handlers, `--recompute-ratings`, the judge, restore (`allKept`) and every "served" dashboard panel keep reading `data` unchanged. Ratings: an entry entering `data` gets its rating from the votes on its bounds (`WithVoteRatings` in Go, `voteRating` in Node); ratings on `hidden` entries are not maintained (no segment is served there).

**Pinning.** An entry with a keep verdict is pinned in the truth layer: `ai regate` never moves it to `confidence`, and a `review` entry never comes back by rules. The length rule is not pinned: it moves any entry. Pinned = the entry's bounds appear in the judge's `entryKeeps` set (latest verdict of an ai item at its effective bounds is a keep), without the `decided_at > judged_at` condition; the Go side gets `entryKeepsAll()` next to it.

**Verdicts** (`applyVerdict`, now over `data ∪ hidden`, the item's entry found by `from` bounds in either array):
- `not_ad` / `unclear`: the entry moves to `hidden` with `reason: 'review'` (was: deleted). The row is withdrawn by `review` when `data` becomes empty, as today.
- keep (`sponsor` / `self_promotion`) at `to` bounds: the entry takes the verdict's category and bounds (`source: 'review'` when moved) and goes to `data` when `to.end − to.start ≥ AI_MIN_SEGMENT_SECONDS`, else to `hidden` with `reason: 'short'`. Overlap check against `data` only (hidden entries never reach a player). A keep verdict never withdraws a row; a row whose only entry went `short` serves nothing (like stage 9) but is not withdrawn. Restore of a `judge` / `review` row stays: every `data` entry kept.
- `ai_applied` stays true when either array changed.

**Short bounds on the page**: `validateVerdictBounds` keeps returning `short` so the page can warn, but the server and `recordVerdict` accept it; `short` moves from the error list to a warning under the inputs ("кусок короче N с: сохраним, но зрителю не покажем, пока порог не изменится"), with the threshold rendered into `STATE`. Gold export (`export-review-verdicts.sh`) is unaffected: short bounds are ordinary `gold_missing` bounds.

**`ai regate`** (new subcommand, run by hand after a threshold change, like `--recompute-ratings`; also what the backfill ends with): for every AI row in any state, in its own transaction, under the row's `FOR UPDATE` and the `video_calculateds` lock (the vote handlers' order): recompute each entry's place with the current `accepted()` and threshold, pinned entries exempt from the confidence rule, `review` entries never moved; entries entering `data` get their vote rating; `data` re-sorted by `start`; a row is written only when something moved; log `ai regate: <video_id> <n> served, <m> hidden (+a −b)` per changed row and a summary line; no heartbeat. Withdrawn rows are regated too (their `data` is served again on restore).

**Backfill** (`ai regate --backfill`, once, before the first regate on prod): for rows whose `hidden` is empty and whose run has an object `raw_output` and a transcript, rebuild every segment the way `finish()` does (`requestFormat.Apply(cues)`, `detector.Resolve`, inward rounding) and put those not in `data` (by category, bounds) into `hidden` with the reason the current rules give (`confidence` first, else `short`). Entries removed by a `not_ad` verdict before this change are in neither array; backfill re-adds them from `raw_output` only if they fail the rules, which cannot happen for an entry that was once published, so none is resurrected. Idempotent: a second run finds no empty `hidden` to fill.

**Below-threshold review** becomes an AI-row review: `scripts/import-below-threshold.js` reads `hidden` entries with `reason = 'confidence'` (and `short` only with `--min-seconds` below the threshold) and creates `kind = 'ai'` items with `video_id`, so their verdicts go through `applyVerdict`; dedupe by `(native_id, bounds, category)` stays. The 80 decided `kind = 'sheet'` items of `ai-below-threshold-2026-10-24` are adopted by a one-off script that turns a sheet item matching an entry of the native_id's AI row into an ai item and re-applies its latest verdict; the owner runs it (62 confirmed `self_promotion medium` would start serving; see Post-Completion).

**Judge**: unchanged in logic; it sees `data` only. New items on hidden entries sit outside `data`, so `entryKeeps` / `allKept` ignore them until a keep verdict moves the entry in. `ai_review_open` now also counts open below-threshold ai items.

**Dashboard**: the "misses" panels read `jsonb_array_length(hidden)` instead of recomputing from `raw_output`; a new stat pair next to "segments ready": hidden segments by reason; the admin page's AI block lists hidden entries greyed with their reason.

## Technical Details

- Go `Entry` gets `Reason string \`json:"reason,omitempty"\``; `entries()` returns `(served, hidden []Entry)`; `publish()` writes both columns (`hidden = EXCLUDED.hidden` on conflict).
- `AI_MIN_SEGMENT_SECONDS` (int, default 5): `pipeline.Config.MinSegmentSeconds` (used by `entries()`, `regate`), Node `lib/ai-rules.js` `MIN_SEGMENT_SECONDS` read once at boot (used by `applyVerdict`, the page's `STATE`, `import-below-threshold.js` default `--min-seconds`). Wired like the other `AI_*` flags (compose, deploy workflow, `init_env.sh` copies every `AI_*`).
- `accepted()` stays the Go truth; `import-below-threshold.js` drops its `published()` copy (it reads `hidden`).
- `prv_review_items` for hidden entries: `kind = 'ai'`, `video_id` = the row's `video_id`, `proposed` = the entry's category name, `cues` = the entry's transcript text, `flagged_by = ["detect run <id>: <category> <confidence>, <len> s, hidden: <reason>"]`.
- Log line of publish: `… published: %d entries of %d segments` → `… published: %d served, %d hidden of %d segments`.
- Lock order everywhere: `video_calculateds` row → AI row (regate, backfill, publish); batch row → AI row (decide), as today.

## What Goes Where

- **Implementation Steps**: code, tests, docs in this repo.
- **Post-Completion**: prod runs (backfill, adopt script, env), the artifacts, the assessors' note.

## Implementation Steps

### Task 1: `hidden` column, `AI_MIN_SEGMENT_SECONDS`, publish writes both arrays

**Files:**
- Modify: `lib/schema.js`, `prv/db/index.js` (model: `hidden` JSONB, default `[]`)
- Create: `lib/ai-rules.js` (`MIN_SEGMENT_SECONDS` from env, default 5, validated int ≥ 1)
- Modify: `ai/pipeline/publish.go`, `ai/pipeline/detect.go` (`Config.MinSegmentSeconds`, `ConfigFromEnv`, `finish()`), `ai/pipeline/publish_test.go`, `ai/pipeline/detect_test.go`
- Modify: `docker-compose.yml`, `.github/workflows/deploy.yml` (both lists), `test/e2e.js`

- [x] `ALTER TABLE prv_ai_video_calculateds ADD COLUMN IF NOT EXISTS hidden JSONB NOT NULL DEFAULT '[]'` in `syncSchema()`; model field
- [x] `lib/ai-rules.js` + `test/ai-rules.test.js` (default, valid value, invalid → throws at boot); add to `make test-unit`
- [x] Go: `Entry.Reason`, `entries(preds, categories, minSeconds) (served, hidden)` with `reason` `confidence` before `short`; `publish(tx, …, served, hidden)`; `ConfigFromEnv` reads `AI_MIN_SEGMENT_SECONDS`
- [x] `finish()` passes both; log line with served / hidden counts
- [x] wire the variable in compose and the workflow (unset = default)
- [x] tests: `publish_test.go` (split by confidence and length, reason precedence, custom threshold), `detect_test.go` env parsing; e2e `ai detect:` assertions read `hidden` of the fixture rows (`-1_456000201`: 300–320 `confidence`, the 3-s sponsor 480–483 `short`; `-1_456000206`: 20–30 `confidence`)
- [x] run `go test -mod=vendor ./ai/...`, `make test-unit`, `make test-e2e` — green before task 2

### Task 2: `ai regate` and `ai regate --backfill`

**Files:**
- Create: `ai/pipeline/regate.go`, `ai/pipeline/regate_test.go`
- Modify: `prv/commands/ai/main.go` (usage), `ai/judge/signals.go` (`entryKeepsAll()` shared; or move the keep query to a small package both import)
- Modify: `test/e2e.js`, CLAUDE.md (Commands, Ops)

- [ ] `Regate(cfg, backfill bool)`: list AI rows; per row one transaction: `video_calculateds` lock (`lockVideoCalculated`), AI row `FOR UPDATE`, read `data`, `hidden`, pinned set
- [ ] backfill: for a row with empty `hidden` and an object `raw_output` + transcript, rebuild all predictions (`requestFormat.Apply`, `detector.Resolve`, inward rounding), add those not in `data` with the rules' reason; then fall through to the regate pass
- [ ] regate pass: `review` entries untouched; `confidence` ↔ `data` only for unpinned entries; `short` ↔ `data` for all; entries entering `data` get `WithVoteRatings`; sort; write only on change; per-row log and summary; exit 1 when a row failed
- [ ] `main.go`: `ai regate [--backfill]`; usage string
- [ ] tests: `regate_test.go` with sqlmock (threshold drop serves a `short` entry with its vote rating; threshold rise hides a served one; a pinned low-confidence entry stays served; a `review` entry never moves; backfill fills only empty `hidden` and skips rows without `raw_output`); e2e: change the threshold via env for one `ai regate` run inside the container and assert the move both ways, `--backfill` on a row whose `hidden` was emptied by SQL
- [ ] run the Go tests and `make test-e2e` — green before task 3

### Task 3: `applyVerdict` over both arrays; short bounds accepted server-side

**Files:**
- Modify: `prv/repository/ai.js`, `prv/repository/review.js` (`recordVerdict`: `short` is not an error), `prv/routes/admin-review.js` (`parseBodyBounds`), `lib/review-sheet.js` (doc comment: `short` is a warning code)
- Modify: `test/e2e.js` (`review…` / `ai judge…` tests on verdicts), `test/review-sheet.test.js`

- [ ] `applyVerdict`: locate the entry in `data` or `hidden` by `from`; drop → `hidden` with `reason: 'review'`; keep → category / bounds / `source`, then `data` or `hidden short` by `MIN_SEGMENT_SECONDS`; overlap check against `data` only; withdraw / restore rules as in Solution Overview; `changed` covers both arrays
- [ ] server accepts short bounds (`parseBodyBounds`, `recordVerdict`): only `format` / `range` / `order` are errors
- [ ] e2e: keep with 4-s bounds on a served entry → entry in `hidden short`, GET no longer serves it, `ai_applied: true`; a later keep with 10-s bounds → back in `data` with the votes' rating; `not_ad` → `hidden review`; keep on a `confidence` entry (an ai item created by SQL in the test, as task 5 will) → served; `unclear` on a hidden entry → `review`
- [ ] unit: `review-sheet.test.js` keeps `short` as the returned code
- [ ] run `make test-unit`, `make test-e2e` — green before task 4

### Task 4: review page: short bounds as a warning, threshold in `STATE`

**Files:**
- Modify: `prv/routes/admin-review.js` (`readBounds()`, the save flow, `STATE.minSegmentSeconds`, hint under the inputs), `prv/locales/review/ru.json`, `prv/locales/review/en.json` (`error_bounds_short` → `warn_bounds_short` with `{seconds}`; `bounds_hint` mentions the rule), `test/i18n.test.js` if keys are listed there
- Modify: `test/e2e.js` (`format=json` exposes `min_segment_seconds`)

- [ ] `readBounds()` returns `{bounds, warning}` for `short`; the warning shows live under the inputs and in the save flash; the save goes through
- [ ] onboarding / rules card: one line on short segments (saved, not served while the threshold stands)
- [ ] both locales, parity test green
- [ ] e2e: decide with short bounds via the page's JSON path returns 201 and the item page JSON shows the bounds and `min_segment_seconds`
- [ ] run `make test-unit`, `make test-e2e` — green before task 5

### Task 5: below-threshold items become ai items; adopt the 2026-10-24 sheet

**Files:**
- Modify: `scripts/import-below-threshold.js` (read `hidden`, `kind = 'ai'`, `video_id`, `flagged_by` with the reason, `--min-seconds` default from `lib/ai-rules.js`, drop `published()`)
- Create: `scripts/adopt-review-items.js <sheet> [--dry-run]`
- Modify: `prv/repository/review.js` (`insertItems` accepts `kind` / `video_id`, as the judge's INSERT does), `test/e2e.js` (`import-below-threshold:` test), CLAUDE.md (Ops bullet)

- [ ] importer: candidates = `hidden` entries (`reason = 'confidence'`, plus `short` when `--min-seconds` < threshold) of rows with a run; `cues` from the run transcript between the entry's bounds; ai items with `video_id`; `--empty-only` = rows with empty `data`
- [ ] adopt script: for each `kind = 'sheet'` item of the sheet whose `(native_id, bounds ± 0.05, proposed)` matches a `data` or `hidden` entry of the native_id's AI row: set `kind = 'ai'`, `video_id`, then `applyVerdict` with its latest verdict (`from` = effective bounds); one transaction per item under the batch lock; prints matched / applied / unmatched; `--dry-run`
- [ ] e2e: the importer creates ai items for the fixture rows' hidden entries; a keep verdict on one serves it; the adopt script on a sheet item created in the test converts and applies
- [ ] run `make test-unit`, `make test-e2e` — green before task 6

### Task 6: dashboard, admin page, metrics

**Files:**
- Modify: `grafana/dashboards/ai-pipeline.json` (panels ~2645, ~4092 read `hidden`; new stat "скрытых сегментов" by reason next to "segments ready"; funnel row 9 wording "ответ без отдаваемых сегментов"), `prv/routes/admin.js` (`aiBlock`: hidden entries greyed with reason), `prometheus-wrapper.js` (optional `ai_hidden_segments{reason}` gauge; skip if the Postgres panel is enough)
- Modify: `test/e2e.js` (admin page shows the hidden table), `test/prometheus-wrapper.test.js` if a gauge is added

- [ ] dashboard SQL run against a seeded copy of the schema (as every panel was)
- [ ] admin page: hidden table under the served one, withdraw link unchanged
- [ ] tests green

### Task 7: Verify acceptance criteria

- [ ] every detector segment of a new detection lands in `data` or `hidden` with a reason; backfill fills old rows; regate moves both ways under the threshold env
- [ ] a verdict is the last word: keep on hidden serves (unless short), drop hides for good, regate respects both
- [ ] short bounds save with a warning; nothing short is ever served
- [ ] `make test-unit`, `go test -mod=vendor ./calculator ./ai/...`, `go vet ./...`, `make test-e2e`

### Task 8: [Final] Documentation

- [ ] CLAUDE.md: AI-first segments (publish, verdicts, regate, hidden reasons), Commands (`ai regate`), Ops (backfill, adopt, threshold change recipe), Models (`AiVideoCalculated.hidden`), Environment Variables (`AI_MIN_SEGMENT_SECONDS`), Dashboard
- [ ] `docs/ai-first-overview/{ru,en}.html`: two layers, what a verdict does, short bounds; "updated" date; republish both artifacts
- [ ] `docs/backlog/ai-below-threshold-verdicts.md`: close or rewrite (the verdicts now act; the threshold question moves to "regate with `self_promotion: medium` when the eval agrees")
- [ ] cleanup pass before commit (residue / transient state / open questions)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

**Prod, in order** (owner; each inside the app container, under the detect lock so no tick publishes meanwhile):
1. deploy; `flock /tmp/ai-detect.lock /app/prv/commands/ai/ai regate --backfill` — fills `hidden` for every published row (idempotent).
2. `node scripts/adopt-review-items.js ai-below-threshold-2026-10-24` — the 80 decided B-items become ai items and their verdicts apply: ~62 `self_promotion medium` segments start serving (`AI_FIRST` permitting), 3 `not_ad` go `review`. Owner's call on timing: this is the first time verdicts override the confidence threshold on prod.
3. later `scripts/import-below-threshold.js` runs produce ai items directly.
4. a threshold change = set `AI_MIN_SEGMENT_SECONDS` (repository variable, deploy) and run `ai regate` once; the judge, votes and GET need nothing.

**Assessors**: one line in the shared chat: short bounds now save; the page says the viewer will not see them.

**Open question**: whether `unclear` should pin like `not_ad` (today both hide with `review`). Decide when the first `unclear` on a served entry shows up in the judge loop.
