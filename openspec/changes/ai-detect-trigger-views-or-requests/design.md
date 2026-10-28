# Design

## Context

See proposal.md. Today `queueRule` in `ai/pipeline/queue.go` takes `seen` rows by `views_max >= $1 OR (views_max IS NULL AND requests >= $2)`, and `fetch()` in `ai/pipeline/detect.go` re-checks rows without `views_max` against yt-dlp's `view_count` (`checkViews`), which prv never fills. The dashboard repeats the rule in four SQL targets with the hidden constants `min_views` / `fallback_requests`. `prv_ai_videos` has no record of why a row left `seen`.

## Goals / Non-Goals

**Goals:**
- One rule, in one place in Go and copied verbatim into the dashboard SQL.
- The trigger survives retries and is readable by plain SQL.
- Nothing on the read path changes (`aiRepository.seen()` untouched).

**Non-Goals:**
- Backfilling `queued_by` for rows already past `seen`.
- A Prometheus series for the trigger.

## Decisions

- **Rule** `status = 'seen' AND (views_max >= $1 OR requests >= $2)`. NULL `views_max` makes the first operand NULL, so the OR reduces to the requests test; no COALESCE needed.
- **Column `queued_by` TEXT NULL on `prv_ai_videos`** (not a new table, not JSON in `judge_counters`): one fact per video, set once. Written by the claim UPDATE: `queued_by = COALESCE(queued_by, CASE WHEN views_max >= $1 AND requests >= $2 THEN 'both' WHEN views_max >= $1 THEN 'views' ELSE 'requests' END)`; `claimOne` writes `COALESCE(queued_by, 'manual')`. The CASE runs on the row's values at claim, so the value means "what let it in under that tick's thresholds". Added by `lib/schema.js` (`ADD COLUMN IF NOT EXISTS`) and the `db.js` model; a Go tick before Node's first boot on a fresh deploy fails the claim once, as the heartbeat already does.
  - Alternative rejected: storing it on `prv_ai_runs` — a video that never reaches the model (no track) would have no trigger.
- **Rename `AI_FALLBACK_REQUESTS` → `AI_MIN_REQUESTS`**, no alias. The owner's wording ("not a fallback any more") and the semantics changed; an alias would keep a misleading name alive for one deploy's convenience. The code default equals the value the owner wants, so a missing variable does no harm; prod's current `AI_FALLBACK_REQUESTS=5` becomes inert, which the proposal says out loud.
- **Drop the fetch-time view gate** (`checkViews`, `viewCount`, the `views_max` write from yt-dlp) rather than keep it for a provider that might fill `view_count`: the rule now says requests alone qualify, so a view re-check would contradict the spec. `fetch()` loses its third parameter; `TestViewCount` and `TestFetchWithoutViewCountPassesOnRequests` go, the no-track path is still covered by the e2e.
- **Dashboard**: variable `fallback_requests` renamed `min_requests` (value 20), `min_views` 500000; every target that spells the rule gets `COALESCE(a.views_max >= ${min_views} OR a.requests >= ${min_requests}, false)`. Panel 21 ("requests among stage-1 videos") loses its "N+" group (under the new rule enough requests always qualifies). New panels in row 2 (the queue row): a bar gauge "Почему взяли в детектор" over `COALESCE(queued_by, 'unknown')` for rows with `status <> 'seen'`, and a time series next to panel 31: runs per day per trigger, `prv_ai_runs r JOIN prv_ai_videos a USING (native_id)` grouped by `$__timeGroupAlias(r.created_at, '1d')` and `COALESCE(a.queued_by, 'unknown')`. Every SQL target is run once against the local restored dump (`localhost:5433/skipper`) before commit, per the dashboard rule in CLAUDE.md.
- **e2e fixtures**: keep the default thresholds in the e2e stack (no env override) so the test proves the defaults; rows move to 600 000 views and 19 / 20 requests, the former fallback cases (`-1_456000205` / `206`) become the "requests only" cases with their `.info.json` `view_count` left as inert data.

## Risks / Trade-offs

- [The old repo variable stays set on GitHub and someone expects it to work] → the deploy job's variable list no longer contains it; CLAUDE.md names the rename; the proposal tells the owner to delete it.
- [Stage-1 panels drift from prod when the owner tunes a threshold] → unchanged practice: the constants in the JSON are changed in the same commit (CLAUDE.md → Dashboard).
- [A higher views threshold plus the independent requests gate changes the mix of claimed videos] → that is the point; spend stays capped by `AI_DAILY_BUDGET_VIDEOS`, the trigger panel shows the mix.

## Migration Plan

Deploy as one image; nothing to run by hand. The ALTER runs on Node boot; `seen` rows are re-evaluated by the next tick. Owner's steps after the deploy: create `AI_MIN_REQUESTS` (or rely on 20), delete `AI_FALLBACK_REQUESTS`, check the new panel after the first ticks. Rollback: the previous image ignores `queued_by` (nullable, no reads).
