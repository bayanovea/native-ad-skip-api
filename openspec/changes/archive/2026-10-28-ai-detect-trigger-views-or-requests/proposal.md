# Proposal

## Why

The extension release that sends `views_text` is out, so `prv_ai_videos.views_max` is now filled for most new rows and the "views unknown → count our own requests" fallback no longer describes reality: a video that many of our users request is worth detecting whether or not its counter was read. The owner wants to steer AI spend with two independent thresholds and see on the dashboard which one let each video in.

No backlog item; follow-up of `docs/backlog/ai-views-from-clients.md` (the "to do once the extension release is out" part).

## What Changes

- **Queue rule**: a `seen` video is taken by `ai detect` when `views_max ≥ AI_MIN_VIEWS` **or** `requests ≥ AI_MIN_REQUESTS`; today's `views_max IS NULL AND requests ≥ …` becomes a plain `requests ≥ …`, so a video with a known but low view count still qualifies by requests.
- **Defaults**: `AI_MIN_VIEWS` 10 000 → 500 000; requests 10 → 20.
- **BREAKING (ops)**: `AI_FALLBACK_REQUESTS` is renamed `AI_MIN_REQUESTS` (code default, `docker-compose.yml`, the deploy workflow's two lists, the dashboard constant). The old repository variable is ignored after the deploy; the owner creates the new one (Settings → Secrets and variables → Actions → Variables) or relies on the default 20.
- **Removed**: the fetch-time check of yt-dlp's `view_count` against `AI_MIN_VIEWS` for rows without `views_max` (prv never returns one, and with requests as a criterion of its own a requests-claimed video must not be bounced on views). `views_max` comes from clients only.
- **Trigger record**: `prv_ai_videos.queued_by` (`views` | `requests` | `both` | `manual`), set once on the first claim from the row's values against the thresholds of that tick, kept over retries.
- **Dashboard**: `ai-pipeline.json` gets "why the detector took the video" (current split and runs per day by trigger), stage-1 panels follow the new rule, constants `min_views` 500000 and `min_requests` 20.
- **Docs**: CLAUDE.md (Trigger, `ai detect`, Dashboard, Environment Variables), the ru/en AI-first overview pages and their two published artifacts, the backlog item.

Out of scope: a new Prometheus metric for the trigger (dated rows give the history), `/admin/video` showing `queued_by`, any change to the judge (it keeps reading `views_max` / `requests` as signals), the extension.

## Capabilities

### New Capabilities
- `ai-detect-queue`: which `prv_ai_videos` rows the detector takes from the queue, in what order, and how the trigger is recorded.

### Modified Capabilities
<!-- none: openspec/specs/ is empty, this is the first change -->

## Impact

- Go: `ai/pipeline/queue.go` (rule, claim UPDATE, `claimOne`), `ai/pipeline/detect.go` (Config, the view gate in `fetch`), their tests, `prv/commands/ai/main.go` only if it names the variable.
- Node: `db.js` model + `lib/schema.js` ALTER for `queued_by`.
- Ops: `docker-compose.yml`, `.github/workflows/deploy.yml`, `grafana/dashboards/ai-pipeline.json`.
- Tests: `test/e2e.js` `ai detect:` cases (fixture rows at 50 000 views and 10 / 11 requests no longer qualify under the new defaults), `test/fixtures/ai/*.info.json` `view_count` fields become inert.
- Prod data: existing `seen` rows are re-evaluated by the new rule on the next tick; rows already past `seen` get `queued_by = NULL` (no backfill: the trigger of a past claim is not recorded anywhere).
