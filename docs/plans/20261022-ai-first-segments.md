# AI-first ad segments: detector in the product, signal judge, timeline safeguards

## Overview

Today every skip comes from human markups aggregated by the Go calculator. The eval repo
(`~/Web/ad-skip-segment-eval`) has a detector that passed the release gate on the held-out set
(SCORE 0.34, 1.6 s/h of content wrongly cut, $0.025 per video with the Batches API; Sonnet 5.5,
prompt v2.1; v2.2 is current on dev, not yet re-scored on held-out). This plan brings it into the
product as the primary source of segments:

1. **Detect** fresh, popular videos automatically (views ≥ N) from the prv auto subtitles and
   publish the segments the product thresholds accept to a new final table
   `prv_ai_video_calculateds`. Clients get these when the row exists; otherwise the human
   `video_calculateds` as today. A kill switch (`AI_FIRST=off`) returns to the human path without
   touching data.
2. **Judge** every published video on the user signals the product already collects (votes,
   "return" clicks = `interval_undo`, new human markups, duration changes, later: views, seeks)
   in batches, cheap rules first, an LLM call only when the rules do not decide: `ok` / `withdraw`
   (unpublish and send to a human) / `review` (keep, send to a human). Humans decide on the
   existing `/admin/review` page; their verdict is applied to the AI table automatically.
3. **Subtitle timing**: the detector refuses videos whose subtitle track does not fit the video
   (last cue ends > 3 s after the video, or the yt-dlp duration disagrees with what players
   report); a re-cut video (new duration) never gets the old segments because the AI row is keyed
   by the `videos` row (native_id + duration ± 2). Audio drift analysis (step offsets, re-timing
   the segments) is **designed and spiked here, built in a separate plan** once the spike says
   what it costs on the prod VM.

The owner's rule throughout (decided 2026-10-21): only segments we are sure the viewer sees
correctly, even at the cost of missed ads.

## Context (from discovery)

- **Detector** (`ad-skip-segment-eval/internal/detector`): pure Go, imports only
  `internal/transcript` + `internal/vtt`; `Client` interface with `Anthropic` (Messages API),
  `AnthropicBatch` (`Submit` / `Wait`, half price, resumable by batch id) and `ClaudeCLI`;
  `Validate`, `Resolve` (cue indices → seconds), `Prompt` from `prompts/v2.2.md`; JSON schema
  response. `internal/provider/platform.go` picks the auto track from yt-dlp output and builds player
  links (`LinkAt`, start − 2 s). `internal/ytdlp` wraps the `yt-dlp` binary with retries.
  `internal/netguard` refuses to fetch from a listed home IP (privacy of the eval data set, not a
  platform rule). All `internal/`: not importable from another module as is; the eval repo has no
  git remote.
- **Timing facts** (eval README, `docs/iterations.md` step 13, `~/Web/data/audit/drift.jsonl`):
  ~1 video in 5 has a subtitle timeline off by > 2 s (steps and offsets of 15–90 s). The cheap gate
  (last cue end − duration > 3 s) catches 13 of 15 bad videos in the 31-video audit, misses 2, and
  flags 2 good ones; on held-out it drops 51 of 217 videos.
- **Product signals already stored**: `votes` (−1/0/+1 per user per segment, the vote handler
  needs the segment in `video_calculateds.data`, `prv/routes/votes.js:32-37`); `prv_events_interval_undo`
  (the "return" button, `prv/routes/events.js`), `prv_events_interval_click`, `prv_events_time_saved`;
  human markups (`markups` + `markup_time_intervals`, author rating on `users`); several `videos`
  rows per native_id with different durations (`lib/duration-tolerance.js`, the only "video was
  edited" signal; `duration_logs` writing is commented out in `prv/routes/videos.js:35-43`). No
  views anywhere: neither the API nor the extension (`~/Web/native-ad-skip`) sees them.
- **Serving**: `GET /video-calculated` (`prv/routes/videos.js`) → `findVideoForReadWithOutcome` →
  `video_calculateds.data`; the legacy `!req.query.v` branch is separate.
- **Human review**: `prv_review_items` / `prv_review_verdicts` / `prv_review_batches`, written only
  through `prv/repository/review.js` (`insertItems`, `createBatch`, `recordVerdict`); the page
  already shows a signals panel (markups, calculated segments, undo/click counts) per item.
- **Runtime**: Go binaries built in the Dockerfile `go-build` stage (`golang:1.27`, static,
  `-mod=vendor`, `go.mod` says `go 1.19`), run by cron under `flock` with output to
  `/proc/1/fd/1`; heartbeats in `calculator_heartbeats` → `/metrics` → Grafana alerts. Image is
  `node:20-bookworm-slim`, no Python, no yt-dlp. Prod VM: 2 vCPU / 4 GB, Almaty (KZ IP).
- **Tests**: `make test-unit` (Node, DB-free), `make test-e2e` (Docker: Postgres + app +
  Go binaries, `test/e2e.js`), `go test ./calculator`.

## Development Approach

- **testing approach**: Regular (code first, then tests), the project's style
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
  - Go: unit tests next to the package; Node: `test/*.test.js` for DB-free logic, `test/e2e.js`
    for anything that touches the DB or the binaries
  - the external calls are replaced by fixtures in e2e: `YTDLP_BIN` points to a stub script
    (`test/fixtures/ai/yt-dlp-stub.sh`) that writes a canned `info.json` + VTT per native_id;
    `AI_CLIENT=fixture` makes the detector and the judge read canned responses from
    `test/fixtures/ai/<native_id>.detect.json` / `.judge.json`
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- behind flags from day one: `AI_FIRST`, `AI_DETECT_ENABLED`, `AI_JUDGE_ENABLED` (all `off`
  by default, so a deploy of any intermediate task changes nothing for clients); the switch to
  AI-first is only ever a deliberate env change by the owner (`AI_FIRST=on` in the deploy
  secrets), never a code default, a migration or a later task of this plan
- prv only (`rt` / `yt` have no traffic, `docs/backlog/rt-yt-providers-unused.md`)

## Testing Strategy

- **unit tests**: required for every task (see Development Approach above)
- **e2e tests**: `test/e2e.js` gets an `ai:` group that drives the real binaries against the
  stubs: queue → fetch → gate → detect → publish → serve → vote → judge → review item → verdict
  applied → kill switch; run by `make test-e2e` in CI before every deploy
- **no live calls in tests**: the stub yt-dlp and the fixture client are the only transports in
  CI; a missing `ANTHROPIC_API_KEY` with `AI_CLIENT=anthropic` is a startup error of the binary,
  tested as such

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope
- keep plan in sync with actual work done

## Solution Overview

```
extension ──GET /video-calculated?…&views=V──▶ Node ──upsert──▶ prv_ai_videos (seen, views_max)
                                                 │
                                                 ├── AI row for this videos row? ──yes──▶ prv_ai_video_calculateds.data
                                                 └── no / AI_FIRST=off ──────────────▶ video_calculateds.data (today)

cron (every 5 min, flock)  prv/commands/ai/ai detect
   queue: prv_ai_videos.status='seen' AND views_max ≥ AI_MIN_VIEWS (or fallback, see Trigger)
   → yt-dlp info + auto subs (ru)      → no track: retry 6 h / 24 h / 72 h, then no_track
   → timeline gate                     → timeline_unreliable (nothing published)
   → Batches API submit (AnthropicBatch) → status detecting, batch_id; next tick polls
   → Validate + Resolve + thresholds   → prv_ai_runs (raw) + prv_ai_video_calculateds (published)

cron (hourly, flock)  prv/commands/ai/ai judge
   due: published rows with new signals since judged_at (or never judged, ≥ 24 h old)
   → signals (votes, undo, clicks, human markups, duration variants, views, age)
   → rules: nothing negative → ok (no call); duration changed > 2 s → withdraw (no call)
   → LLM judge (fixture in tests) → ok | withdraw | review, reason
   → withdraw: withdrawn_at + reason; withdraw|review: prv_review_items batch ai-judge-<date>

/admin/review decide on an ai item → reviewRepository.recordVerdict → aiRepository.applyVerdict
   not_ad / unclear → segment removed (row withdrawn when empty); sponsor / self_promotion → kept
   or restored with the verdict's category
```

Key decisions:

- **Separate final table, not synthetic markups.** Owner's call (2026-10-22): AI-first with the
  human path as fallback and a switch back. `prv_ai_video_calculateds` keeps the entry shape of
  `video_calculateds.data` (`category_id`, `start`, `end`, `rating` sparse) plus `confidence`
  and `source: "ai"`, so the extension needs no change to skip; votes and undo events already
  carry `(category_id, start, end)` and match either table.
- **Keyed by `videos.id`, like `video_calculateds`.** The detector finds or creates the `videos`
  row by `(native_id, yt-dlp duration ± 2)` (`findByNativeIdAndDuration`, the `POST /markup`
  rule). A client whose player reports a different duration lands on another row or none and
  gets the human path: a re-cut video never serves segments timed for the old cut. This is the
  "different durations" signal turned into a guarantee rather than a heuristic.
- **Detector code is copied, not imported.** `internal/` packages cannot be imported, the eval
  repo has no remote, and CI builds from this repo's tarball. `scripts/sync-detector.sh` copies
  `detector`, `transcript`, `vtt`, `provider`, `ytdlp` from the eval checkout into `ai/` and
  writes the source commit into `ai/SOURCE`; the eval repo keeps being the place where prompts
  and the detector change (eval first, then sync). `prompts/v2.2.md` is copied the same way to
  `ai/prompts/`. Rejected: moving the packages to a published module (needs a private Go module
  proxy or CI token for a repo that must stay private; revisit if a third consumer appears).
- **Batches API in the product.** Detection latency is irrelevant (the video has no AI row yet
  and serves the human path meanwhile), and batches halve the cost ($0.025 vs $0.05 per video).
  The detect cron submits one batch per tick and resolves finished batches on the next ticks.
- **Judge: rules first, LLM second, humans last.** Most videos have no negative signal and
  cost nothing. The LLM judge runs at most once per video per `AI_JUDGE_MIN_INTERVAL` (6 h)
  and only when the signal counters moved since the last judgement; it gets the AI segments
  with their quotes, the counters normalised by views when known, the human intervals with the
  transcript around every disagreement, and answers with a schema. Phase 2a (this plan): every
  `withdraw` and `review` goes to a human; `withdraw` also unpublishes at once
  (`AI_JUDGE_AUTO_WITHDRAW=on`), because a wrong cut costs more than a missed ad. Letting the
  judge close cases without a human is a later flag, after the review verdicts show its
  precision.
- **Human markups keep being accepted** on AI-first videos: they are the judge's strongest
  signal and the fallback when the AI row is withdrawn.
- **Timeline gate stays binary in this plan.** overrun > 3 s or |yt-dlp duration − videos.duration|
  > 2 s → `timeline_unreliable`. Fixing offsets needs the audio analysis (phase 3 design below).

## Technical Details

### Tables (all prv, created by `sequelize.sync()` + `lib/schema.js` ALTERs)

- `prv_ai_videos` — one row per native_id, the queue and the state machine.
  `native_id` PK, `views_max` INT NULL, `requests` INT (GET count), `first_seen_at`,
  `last_seen_at`, `status` TEXT (`seen` | `queued` | `fetching` | `detecting` | `published` |
  `withdrawn` | `no_track` | `timeline_unreliable` | `failed`), `attempts` INT, `next_attempt_at`,
  `batch_id` TEXT NULL, `last_error` TEXT NULL, `judged_at`, `judge_counters` JSONB (the signal
  counters at the last judgement, to detect movement), `updated_at`.
- `prv_ai_runs` — one row per detector call, the audit trail (what the eval stores in `calls`):
  `id`, `native_id`, `video_id`, `prompt_sha`, `prompt_version`, `model`, `transcript` JSONB
  (meta + cues; ~150 KB per video, needed by the judge and the review cues), `track_overrun_s`,
  `yt_duration_s`, `raw_output` JSONB, `usage` JSONB, `cost_usd`, `created_at`.
- `prv_ai_video_calculateds` — the final table. `video_id` PK (FK `videos`), `native_id`,
  `run_id` FK, `data` JSONB (entries `{category_id, start, end, confidence, source:"ai",
  rating?}`), `published_at`, `withdrawn_at` NULL, `withdrawn_by` (`judge` | `review` | `admin` |
  `duration`), `withdrawn_reason` TEXT, `updated_at`. Withdrawn rows keep `data` for the record;
  serving checks `withdrawn_at IS NULL`.
- `prv_ai_judgements` — append-only: `id`, `video_id`, `decision` (`ok` | `withdraw` | `review`),
  `by` (`rules` | `llm`), `reason`, `signals` JSONB, `model`, `cost_usd`, `created_at`.
- `prv_review_items.kind` TEXT NOT NULL DEFAULT `'sheet'` (`'ai'` for judge items) and
  `prv_review_items.video_id` INT NULL (the AI row the item belongs to) — ALTER ADD COLUMN IF NOT
  EXISTS, so pre-plan images keep inserting.
- `calculator_heartbeats` gets rows `ai_detect` and `ai_judge` (same columns; `failed_videos` =
  videos that failed in the tick).
- `prv_ai_timelines` (phase 3, created now, written by the spike script only): `native_id`,
  `video_id`, `yt_duration_s`, `steps` JSONB (`[{at_s, shift_s}]`, shift = subtitle time − audio
  time), `windows` JSONB (the measurements), `method` TEXT, `measured_at`.

### Trigger and views

- `GET /video-calculated` accepts `views` (optional int ≥ 0). With `v` present, after the
  response is sent, one fire-and-forget upsert:
  `INSERT INTO prv_ai_videos (native_id, views_max, requests, first_seen_at, last_seen_at, status)
  VALUES (…, 'seen') ON CONFLICT (native_id) DO UPDATE SET views_max = GREATEST(…), requests =
  requests + 1, last_seen_at = NOW()`. Errors are logged, never returned. Only the detector
  changes `status` away from `seen`.
- Queue rule (`ai detect`): `status = 'seen' AND (views_max ≥ AI_MIN_VIEWS OR (views_max IS NULL
  AND requests ≥ AI_FALLBACK_REQUESTS))`, or a due retry (`status = 'queued' AND next_attempt_at ≤ NOW()`),
  oldest `first_seen_at` first, at most
  `AI_DAILY_BUDGET_VIDEOS` per day (counted from `prv_ai_runs`). For the fallback rows the
  detector reads `view_count` from yt-dlp `info.json` and applies `AI_MIN_VIEWS` to it before
  fetching subtitles (sets `views_max` from it, so the row is not re-examined).
- The extension sends `views` once it can read the counter from the page (external task, see
  Post-Completion); until then every row is a fallback row.

### Subtitle fetch and gate (`ai detect`)

- `yt-dlp` static Linux binary added to the image (`/usr/local/bin/yt-dlp`, version pinned in
  the Dockerfile, no Python needed); `YTDLP_BIN` overrides it (stub in e2e).
- Per video: `ytdlp.Info` → `provider.prv.PickTrack` (ru auto track) → `WriteSubs` → `vtt.Collapse`
  → transcript. No ru auto track: `attempts + 1`, `next_attempt_at` = now + 6 h / 24 h / 72 h,
  then `no_track` (the owner's point: auto subtitles may not exist yet when the video is fresh;
  the spike measures how long prv takes).
- Gate: `overrun = lastCue.End − info.duration`; `overrun > 3` → `timeline_unreliable`. The
  `videos` row: `findByNativeIdAndDuration(native_id, round(info.duration))` (creates one when
  missing); if the native_id has other `videos` rows whose duration differs from yt-dlp's by
  > 2 s, log `ai: duration variants` and count them in `judge_counters.duration_variants` (a
  signal, not a gate: old split families exist, `docs/backlog/video-rows-race-and-old-split-families.md`).
- Transcript rendering, request and thresholds exactly as the eval (`detector.NewRequestFormat`
  with the format the held-out run used, cue timestamps dropped); publish filter: `sponsor` with
  confidence ≥ `medium`, `self_promotion` only `high`, `end − start ≥ 5`; categories mapped to
  `markup_categories` ids by name at startup.
- Model / prompt: `AI_MODEL` (default `claude-sonnet-5-5`, the held-out run's model),
  `ai/prompts/v2.2.md`; the prompt sha goes into every run row, so a prompt change is visible per
  video.
- Batches: tick 1 submits up to `AI_BATCH_MAX` queued videos as one batch (`status=detecting`,
  `batch_id`); later ticks `Wait` with a zero timeout (poll once), resolve finished results,
  `failed` after `AI_BATCH_MAX_AGE` (24 h). `AI_CLIENT=messages` uses the synchronous client
  (for a single-video manual run: `ai detect <native_id>`).

### Serving and votes (Node)

- `lib/find-ai-calculated.js`: `findAiCalculated(models, videoId)` → the active AI row or null,
  honouring `AI_FIRST` (`on` | `off`, read once at boot). `GET /video-calculated`: after the video
  lookup, AI row first, else today's path; outcome label gets a new `source` dimension
  (`ai` | `human`) on `video_calculated_lookup_total`. The AI row is served only on a `match` /
  `backfilled` lookup (`AI_LOOKUP_OUTCOMES`): on `mismatch` / `no_duration` the player may be on
  another cut, so it gets the human path.
- Votes: the vote handler resolves the segment the same way (AI row active → its `data`, else
  `video_calculateds`), under the AI row's lock when AI (`SELECT … FOR UPDATE` on
  `prv_ai_video_calculateds`), and recomputes the entry's `rating` with the calculator's rule
  (sum of each user's latest vote; `lib/segment-rating.js` gets a variant that updates only the
  JSON, there are no `calculated_segments` rows for AI). `updateRatingByVote` runs as today (it
  finds no authors for AI bounds). Vote delete: same resolution.
- Legacy `!req.query.v` branch: unchanged (human only).

### Judge (`ai judge`)

- Signals per published video, all cheap SQL over existing tables, restricted to the AI
  entries' exact `(category_id, start, end)` where the signal carries bounds:
  `votes_up`, `votes_down` (distinct users, latest vote), `undo` (`prv_events_interval_undo`),
  `clicks`, `human_markups` (live markups since `published_at`: intervals, author rating, IoU
  with every AI entry), `duration_variants`, `duration_recut`, `views_max`, `requests`, `age_h`
  (`time_saved` events carry no video, so they are not a per-video signal).
- Rules (no call): all of `votes_down`, `undo`, conflicting `human_markups` (IoU < 0.5 with every
  AI entry of the same category, author rating ≥ 0) are 0 → `ok`; a `videos` row with a duration
  that differs by > 2 s appeared after publish and now receives requests → `withdraw` by
  `duration` (the video was re-cut). Everything else → LLM judge, if `judge_counters` moved and
  `judged_at` is older than `AI_JUDGE_MIN_INTERVAL`.
- LLM judge: one Messages call (`AI_JUDGE_MODEL`, default `claude-sonnet-5-5`; `AI_CLIENT=anthropic`
  and `messages` both use the Messages API here, `fixture` reads `<native_id>.judge.json`), schema
  `{decision: ok|withdraw|review, reason, segments: [{index, keep: bool}]}`, prompt
  `ai/prompts/judge-v1.md` (written here, iterated later in the eval repo against the review
  verdicts). Input: AI entries with their transcript text, counters with rates per 1k views when
  `views_max` is known, human intervals and the transcript ±60 s around every AI entry and every
  conflicting human interval (windows merged). A transport / API error fails the video (the next
  tick retries); an answer that does not parse or check (unknown decision, empty reason, a segment
  index outside the entries or twice) is `review` by `rules` with reason `judge_invalid: …`, model
  and cost still recorded.
- Outcome: `prv_ai_judgements` row (`model`, `cost_usd` when the LLM was called); an LLM `withdraw`
  → `withdrawn_at/by='judge'/reason` (when `AI_JUDGE_AUTO_WITHDRAW=on`); LLM `withdraw` and `review`
  (and `judge_invalid`) → one `prv_review_items` row per AI entry (kind `ai`, `video_id`, sheet
  `ai-judge-<YYYY-MM-DD>` (UTC), item codes `A<n>`; batch = the sheet's newest part that nobody
  holds or has a verdict in and that has room for the video's items within 30, else a new part
  `<sheet>`, `<sheet>-p2`, …, so a reviewer's batch never grows; `proposed` = category, `cues` =
  transcript of the entry, `link` = `LinkAt(start − 2)` as the sheets' links, `flagged_by` = a list
  of strings like the sheets' run ids, because the page and the export read a list:
  `judge <decision> by <by>: <reason>`, `signals: <non-zero counters>`, `keep: <bool>`; blind as
  today), written by the Go binary with the same INSERTs as `reviewRepository.insertItems` /
  `createBatch` (`reviews_needed` 1). A video already waiting on an open ai item is not
  re-submitted. The rules' duration withdraw sends nothing to review: a verdict on the old cut's
  timing would put the row back.

### Applying verdicts

- `reviewRepository.recordVerdict` is unchanged; the decide route calls
  `aiRepository.applyVerdict(item, verdict, { transaction })` when `item.kind === 'ai'`, inside
  the same transaction: `not_ad` / `unclear` → the entry is removed from `data` (row `withdrawn_by
  = review` when `data` is empty); `sponsor` / `self_promotion` → the entry kept (or put back
  with that `category_id` if the judge withdrew the row: `withdrawn_at = NULL` when every entry
  of the row has a keep verdict). Import of md sheets never produces ai items.
- Admin: `prv_ai_video_calculateds` rows and judgements visible on `/admin/video/:video_id`
  (read-only block) with a "withdraw" link (`withdrawn_by = admin`) — the operator's manual switch
  per video.

### Metrics, alerts, ops

- Heartbeat rows `ai_detect` / `ai_judge` → `calculator_*` gauges already exposed per provider;
  `CalculatorStale` threshold per provider (detect 15 min, judge 2 h) — one rule change.
- New gauges from one `collect()`: `ai_videos{status}`, `ai_cost_usd_total{kind=detect|judge}`,
  `ai_judgements_total{decision,by}`, `ai_review_open`. Grafana: an "AI" row on
  `infrastructure.json`.
- Logs: `ai detect: <native_id> <status> …` one line per video, `ai judge: <video_id> <decision>
  <by> …`.
- Secrets: `ANTHROPIC_API_KEY` (GitHub secret → `docker-compose.yml` env of `app`); the key is
  read from the env only (the eval's `apiKeyPath` file lookup is dropped in the copy).
- Flags (env, defaults in parentheses): `AI_FIRST` (off), `AI_DETECT_ENABLED` (off),
  `AI_JUDGE_ENABLED` (off), `AI_JUDGE_AUTO_WITHDRAW` (on), `AI_JUDGE_MIN_INTERVAL` (`6h`, a Go
  duration), `AI_JUDGE_PROMPT` (`/app/ai/prompts/judge-v1.md`), `AI_MIN_VIEWS` (10000, owner 2026-10-22), `AI_FALLBACK_REQUESTS` (3), `AI_DAILY_BUDGET_VIDEOS` (200 ≈ $5/day), `AI_BATCH_MAX`
  (100), `AI_MODEL`, `AI_JUDGE_MODEL`, `AI_CLIENT` (anthropic = Batches API | messages | fixture), `YTDLP_BIN`,
  `AI_PROMPT` (`/app/ai/prompts/v2.2.md`), `AI_FIXTURE_DIR` (`/app/test/fixtures/ai`).

### Phase 3 design (audio drift) — built in a separate plan

- Trigger: a judge `withdraw` / `review` whose counters look like timing (undo on every entry,
  human markups shifted by a near-constant offset from the AI entries) or a `timeline_unreliable`
  video with views ≥ 5 × `AI_MIN_VIEWS`; at most `AI_TIMELINE_DAILY` per day.
- Measurement, as `~/Web/data/audit/audit.py`: download audio (yt-dlp, `m4a ≤ 70 kbps`), ASR on
  three 2-minute windows (whisper.cpp, `small` model, Russian), word-level alignment histogram
  per window → shift per window; steps between windows refined by bisection (two more windows)
  when the shifts differ by > 2 s. Output `prv_ai_timelines.steps`.
- Use: `Resolve` the AI entries through the steps (subtitle time − shift at that point), compare
  with the human intervals, re-judge; publish only when every entry's window has a confident
  shift (matches ≥ 50 words).
- The spike in Task 9 answers the two unknowns: CPU minutes per video on the 2 vCPU VM and the
  accuracy against `drift.jsonl` (31 videos, known shifts). The plan for the implementation is
  written after that.

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): tasks achievable within this codebase - code changes, tests, documentation updates
- **Post-Completion** (no checkboxes): items requiring external action - manual testing, changes in consuming projects, deployment configs, third-party verifications

## Implementation Steps

### Task 0: Spikes — the external facts the design rests on

**Files:**
- Create: `docs/research/20261022-ai-first-spikes.md` (results; no video ids in the repo)

- [x] from the prod host (KZ IP, no cookies): `yt-dlp --list-subs` + `--write-auto-subs --sub-langs ru --skip-download` on 10 prv videos with known ru auto tracks; record success rate, wall time, any rate limiting (⚠️ deferred: prod-host spike, owner runs it later)
- [x] subtitle readiness: 10 prv videos published < 2 h ago (channels with many human markups); poll `--list-subs` hourly for 3 days from the host (cron + log); record when the ru auto track appears → sets the retry schedule (6 h / 24 h / 72 h is the placeholder) (⚠️ deferred: prod-host spike, owner runs it later)
- [x] views: confirm the counter is in the prv video page DOM the extension already reads, and that `info.json` `view_count` is present for prv (fallback) (⚠️ deferred: prod-host spike, owner runs it later)
- [x] build check: `go.mod` to `go 1.27`, vendor `anthropic-sdk-go`, `go build -mod=vendor` in the Dockerfile stage; image size delta (measured in a throwaway copy, nothing committed: builds, copied tests pass, image +22.5 MB, +40.6 MB more with yt-dlp in Task 2)
- [x] write results and the chosen constants into the research note; adjust Technical Details if a fact contradicts them (constants unchanged until the prod-host spikes; binary path fixed to `prv/commands/ai/ai`)

### Task 1: Views on the read path and the AI queue table

**Files:**
- Create: `prv/repository/ai.js` (`seen()` upsert, later the rest of the AI repository)
- Modify: `prv/db/index.js` (`AiVideo` model → `prv_ai_videos`), `lib/schema.js`, `prv/routes/videos.js`, `api/doc/openapi.yaml`
- Modify: `test/e2e.js`

- [x] `AiVideo` model + `lib/schema.js` (sync; `status` default `seen`) (new table, so `sync()` alone creates it: no ALTER in `lib/schema.js`; all columns of Technical Details defined now, timestamps with DB-side defaults)
- [x] `GET /video-calculated`: `views` optional int ≥ 0 (express-validator); after `res.send`, `aiRepository.seen(native_id, views)` with errors logged, never thrown (a failed upsert never fails the read) (`res.once('finish')`, so every return of the `v` path counts, 204 included; `views` capped at the INTEGER max, above it 400)
- [x] `openapi.yaml`: document `views`
- [x] e2e: a request with `views` creates the row; a second with a smaller `views` keeps the max and bumps `requests`; a request without `views` leaves `views_max` NULL; the legacy branch (`!v`) writes nothing
- [x] run `make test-e2e` — must pass before task 2

### Task 2: Detector code in this repo, yt-dlp in the image

**Files:**
- Create: `scripts/sync-detector.sh`, `ai/SOURCE`, `ai/detector/`, `ai/transcript/`, `ai/vtt/`, `ai/provider/`, `ai/ytdlp/`, `ai/prompts/v2.2.md`
- Modify: `go.mod`, `go.sum`, `vendor/`, `Dockerfile`, `.dockerignore` (if any)
- Modify: eval repo (`~/Web/ad-skip-segment-eval`): the copied packages must not import `netguard`/`store` (they do not today; add a test there that keeps it so)

- [x] `scripts/sync-detector.sh <eval checkout>`: copies the five packages and the prompt, rewrites the import path to `odedohbest/video-calculate/ai/…`, drops `apiKeyPath` (env only) and `claudecli.go` (not for the product), writes the eval commit sha to `ai/SOURCE`; refuses on a dirty eval checkout (also drops the eval's `anthropic_test.go`, which tests only the key file; product-owned files `detector/fixture.go`, `fixture_test.go`, `apikey_test.go` survive a sync; ends with `go build ./ai/...` and a warning when the eval's SDK version differs; eval side: `internal/policy/product_imports_test.go`, eval `9393890`)
- [x] `go.mod`: `go 1.27`, `anthropic-sdk-go` at the eval's version; `go mod vendor` (v1.80.0)
- [x] Dockerfile: `yt-dlp` static binary (pinned release, sha256 checked) into the runtime stage; `ai/` copied into the `go-build` stage (own `ytdlp` stage, release `2026.10.21`, `yt-dlp_linux` / `_aarch64` by `TARGETARCH`; e2e checks `yt-dlp --version` in the image)
- [x] `ai/detector`: `FixtureClient` (`AI_CLIENT=fixture`) reading `test/fixtures/ai/<native_id>.detect.json`, implementing `Client` and the batch interface (so e2e drives the batch path too) (`NewFixtureClient(dir, model)`; `BatchClient` interface = `Client` + `Submit` / `Wait`, `AnthropicBatch` satisfies it; a fixture batch has ended at once, a missing fixture is that video's error)
- [x] copied Go unit tests pass (`go test ./ai/...`); test for `FixtureClient` (missing file → error)
- [x] `make test-e2e` still green (nothing wired yet) — must pass before task 3

### Task 3: `ai detect`: queue → fetch → gate → detect → publish

**Files:**
- Create: `prv/commands/ai/main.go` (subcommand `detect [native_id]`, Task 5 adds `judge`; flags from env), `ai/pipeline/detect.go`, `ai/pipeline/queue.go`, `ai/pipeline/gate.go`, `ai/pipeline/publish.go`, `ai/pipeline/*_test.go` (sqlmock, as `calculator/`)
- Modify: `prv/db/index.js` (`AiRun`, `AiVideoCalculated` models; new tables, so `lib/schema.js` needs nothing), `crontab`, `Dockerfile`, `infrastructure/init/init_env.sh`, `docker-compose.yml`, `calculator/calculate.go` (`WriteHeartbeat` exported); `supervisord.conf` not needed
- Create: `test/fixtures/ai/yt-dlp-stub.sh`, `test/fixtures/ai/*.info.json`, `*.ru.vtt`, `*.detect.json`
- Modify: `test/e2e.js`, `docker-compose.e2e.yml` (`AI_*` env, `YTDLP_BIN`)

- [x] queue selection (`queue.go`): the rule from Technical Details, daily budget from `prv_ai_runs`, `FOR UPDATE SKIP LOCKED` on the `prv_ai_videos` row, status `fetching` (budget = runs in the last 24 h, rolling; the lock is held for the claim only, so the read path's upsert never waits on yt-dlp; a `fetching` row untouched for 1 h, a crashed tick, is claimed again)
- [x] fetch (`detect.go`): `ytdlp.Info` → fallback views check → `PickTrack` → `WriteSubs` → collapse; no track → retry schedule / `no_track`; yt-dlp failure → `failed` with `last_error` after 3 attempts (a retry waits as status `queued` with `next_attempt_at`; both cases count `attempts`, a yt-dlp failure waits 6 h / 24 h; `view_count` is read from the raw info JSON, a missing count is 0)
- [x] gate (`gate.go`): overrun and duration-variants, `findByNativeIdAndDuration` port (same SQL as `prv/repository/video.js`, create when missing), `timeline_unreliable` (the overrun check runs first, so a refused video gets no `videos` row)
- [x] detect: request as the held-out run; batch submit / poll by `batch_id`; `prv_ai_runs` row with transcript, raw output, usage, cost (`detector.Price`) (effort `medium`, `NoTimes`, no thinking; batch cost × 0.5 as the eval; the run row is written at submit and gets the answer when the batch ends; a tick submits, then polls every waiting batch once, so a fixture batch publishes in the same tick; eval `e7710d0` adds `AnthropicBatch.Poll`, `BatchClient` and `FixtureClient` have it)
- [x] publish (`publish.go`): thresholds, category ids by name, `prv_ai_video_calculateds` upsert (`published_at`, `withdrawn_at = NULL`), status `published`; no entry survives the thresholds → status `published` with empty `data` (the video is done, nothing to skip; serving treats empty as no AI row) (bounds are whole seconds inside the predicted span: start up, end down; the length floor applies after that)
- [x] heartbeat row `ai_detect`; exit 1 when any video failed in the tick, as the calculator (`calculator.WriteHeartbeat` exported; `ai detect <native_id>` is a manual run: it ignores `AI_DETECT_ENABLED`, views and budget, and writes no heartbeat, so a manual run never feeds the cron's alert)
- [x] crontab: `*/5 * * * * flock -n /tmp/ai-detect.lock /app/prv/commands/ai/ai detect >> /proc/1/fd/1 2>&1` (the binary sits next to its `main.go`, as `calculate` does; `/app/prv/commands/ai` is the source directory), gated by `AI_DETECT_ENABLED` inside the binary (exit 0 silently when off) (cron sees only `/app/.env`: `init_env.sh` appends every `AI_*`, `YTDLP_BIN`, `ANTHROPIC_API_KEY` there; `docker-compose.yml` passes `AI_DETECT_ENABLED` (default `off`), `AI_MIN_VIEWS`, `AI_DAILY_BUDGET_VIDEOS`, `ANTHROPIC_API_KEY`)
- [x] unit tests (sqlmock): queue rule incl. budget and fallback, retry schedule, gate decisions (overrun 2.9 / 3.1, duration variants), threshold filter, category mapping error (also `findOrCreateVideo`'s three branches and the env defaults)
- [x] e2e: stub yt-dlp + fixture client; one video → `published` with the expected entries; one without a ru track → `next_attempt_at` set; one with overrun 10 s → `timeline_unreliable`, no AI row; `ai detect <native_id>` single-video mode; heartbeat on `/metrics` (also: off by default, no key with `AI_CLIENT=anthropic` → exit 1, the fallback rows both ways, empty publish, a yt-dlp failure → `queued` + exit 1 + `failed_videos`)
- [x] run `make test-e2e` and `go test ./ai/...` — must pass before task 4

### Task 4: AI-first serving, votes on AI segments, kill switch

**Files:**
- Create: `lib/find-ai-calculated.js`, `test/find-ai-calculated.test.js`
- Modify: `prv/routes/videos.js`, `prv/routes/votes.js`, `lib/segment-rating.js` (`recomputeAiSegmentRating`), `prometheus-wrapper.js` (`source` label), `prv/repository/ai.js`
- Modify: `test/e2e.js`, `test/prometheus-wrapper.test.js`

- [x] `findAiCalculated`: `AI_FIRST` on, row for `video.id` with `withdrawn_at IS NULL` and non-empty `data` → `{data}`; else null (returns the model row; `{ transaction, lock }` pass through, so the vote handler locks with the same rule)
- [x] `GET /video-calculated`: AI row first; `video_calculated_lookup_total` gets `source` (`human` by default, also for `not_found` / `not_calculated` and rt/yt; legacy `!v` branch untouched)
- [x] votes: segment resolution by the same rule; AI path locks the AI row and recomputes the entry's `rating` from `votes` (same SUM rule); vote delete symmetric; 404 unchanged when the segment is in neither (a segment only in `video_calculateds` of an AI-first video is 404 too; delete recomputes both tables, since the vote may predate the AI row, locking the AI row before `VideoCalculated`)
- [x] `prv/repository/ai.js`: `withdraw(video_id, by, reason)` (used by the admin link now, the judge later) (also sets `prv_ai_videos.status = 'withdrawn'`; false when no row or already withdrawn; optional `{ transaction }`)
- [x] `/admin/video/:video_id`: AI block (status, entries, judgements) + withdraw link (`?verifyBearerToken=`) (`GET /admin/video/:id/ai/withdraw`, numeric `videos.id`, from a confirm button as the markup delete; judgements wait for their table, ➕ in Task 5)
- [x] unit tests: `find-ai-calculated` (flag off, withdrawn, empty data), `prometheus-wrapper` label
- [x] e2e: AI row served over an existing human `video_calculateds`; `AI_FIRST=off` serves the human one (picked: a second app with `AI_FIRST=on` on port 3098 next to the default one, same DB; the flag stays read once at boot); a vote on an AI entry updates its `rating`, the vote's author-rating path is a no-op; vote on a human segment of an AI-first video → 404; withdraw link → human path again
- [x] run `make test-unit` and `make test-e2e` — must pass before task 5

### Task 5: Signals and rule-based judge

**Files:**
- Create: `ai/judge/signals.go`, `ai/judge/rules.go`, `ai/judge/*_test.go`
- Modify: `prv/db/index.js` (`AiJudgement`), `lib/schema.js`, `prv/commands/ai/main.go` (`judge` subcommand, heartbeat `ai_judge`), `crontab`
- Modify: `test/e2e.js`

- [x] `signals.go`: the counters from Technical Details, one query per signal, restricted to the AI entries' bounds; `duration_variants` includes the "new videos row receiving requests after publish" fact (separate counter `duration_recut`: a row off by > 2 s created after publish with a request for the native_id since (`prv_ai_videos.last_seen_at`), because the GET path records no videos row; `time_saved` dropped: the event carries no video; conflicts count only sponsor / self_promotion markups, the detector never marks intro / credits; votes, undo and clicks are not limited to after publish, like the rating rule)
- [x] `rules.go`: `ok` when nothing negative; `withdraw` by `duration`; else `needs_llm`; movement check against `judge_counters` (the re-cut check runs first; the duration withdraw is a fact, not gated by `AI_JUDGE_AUTO_WITHDRAW`; `judge_counters` is replaced by the judged counters, views / requests / age are in `signals` only)
- [x] ➕ `/admin/video/:video_id` AI block: list the row's `prv_ai_judgements` (Task 4 left them out, the table arrives here)
- [x] `judge` subcommand: due rows (published, `withdrawn_at IS NULL`, counters moved or never judged and ≥ 24 h old), rules, `prv_ai_judgements` row, `judged_at` + `judge_counters` update; `AI_JUDGE_ENABLED` gate; hourly cron line (`ai/judge/judge.go`; rows with empty `data` are skipped; the judgement is written under the AI row's `FOR UPDATE`, a row withdrawn meanwhile is left alone; heartbeat `ai_judge`, exit 1 on a failed video; cron at minute 30; `AI_JUDGE_ENABLED` in `docker-compose.yml` (default `off`) and the deploy workflow's variable list, `init_env.sh` already copies every `AI_*`; new table, so `lib/schema.js` needs nothing)
- [x] unit tests: each counter (sqlmock), rules table (no signals / dislikes / undo / conflicting markup with negative-rating author ignored / duration withdraw), movement (also `judgeVideo`: unmoved skip, review write, re-cut withdraw)
- [x] e2e: published video + an undo event → judgement `needs_llm` recorded as `review` with `by=rules` while the LLM is off (Task 6 replaces this); a new `videos` row with another duration + request → `withdrawn_by = duration`, human path served (also: off by default, `ok` without signals, not due before 24 h, unmoved counters not re-judged, the new row without a request is not a re-cut, judgements on `/admin/video`)
- [x] run tests — must pass before task 6
- ⚠️ found while building the re-cut rule: `GET /video-calculated` served the AI row also on a `mismatch` / `no_duration` lookup (`findVideoForRead` falls back to any row of the native_id), so a player on another cut could get the old cut's AI segments until the judge withdrew the row. Fixed in Task 6 (first ➕): AI only on `match` / `backfilled` (`AI_LOOKUP_OUTCOMES` in `lib/find-ai-calculated.js`), as the Key decision "Keyed by `videos.id`" promises.

### Task 6: LLM judge, withdraw, review batches

**Files:**
- Create: `ai/judge/llm.go`, `ai/prompts/judge-v1.md`, `ai/judge/review.go` (items + batch via SQL identical to `reviewRepository.insertItems` / `createBatch` — or, simpler and preferred, a Node script is not wanted here: keep the Go binary and mirror the two INSERTs; add a test in `test/e2e.js` that the page lists and opens the items)
- Modify: `prv/db/index.js` (`ReviewItem.kind`, `video_id`), `lib/schema.js` (ALTERs), `prv/repository/review.js` (`hydrate` exposes `kind`, `video_id`)
- Create: `test/fixtures/ai/*.judge.json`
- Modify: `test/e2e.js`

- [x] ➕ `GET /video-calculated` serves the AI row only on a `match` / `backfilled` lookup (the ⚠️ of Task 5): `AI_LOOKUP_OUTCOMES` in `lib/find-ai-calculated.js`, unit test; e2e: a duration > 2 s off and a request without duration get the human segments on the AI-first app; the vote handler keeps resolving by the AI row (votes carry exact bounds)
- [x] `llm.go`: request from signals + run transcript (±60 s around disagreements), schema, `FixtureClient` in tests, cost into the judgement row; min interval (`llmClient` in `ai/judge`, not the detector's `Client`: the detector package is a synced copy with its own output type; `fixtureJudge` reads `<native_id>.judge.json`; the min interval gates only the LLM path: within it the video is skipped with its old counters, so it is due again later; flags `AI_JUDGE_MODEL`, `AI_JUDGE_MIN_INTERVAL`, `AI_JUDGE_AUTO_WITHDRAW` wired in `docker-compose.yml` and the deploy workflow, `init_env.sh` already copies every `AI_*`)
- [x] `judge-v1.md`: the decision rules in the prompt mirror the review page's "How to decide" card (payer test, woven-in calls to action are self_promotion, unclear when the text does not decide, timing is a separate flag)
- [x] `review.go`: batch `ai-judge-<date>` (new batch after 30 items), one item per AI entry (`kind='ai'`, `video_id`, `proposed`, `cues`, `link`, `flagged_by`), skip videos with an open ai item (part rule, codes, link and `flagged_by` as a list: see Technical Details → Judge; `kind` / `video_id` added to `ReviewItem`, `lib/schema.js` ALTER, `hydrate` exposes both)
- [x] withdraw on `withdraw` when `AI_JUDGE_AUTO_WITHDRAW=on` (`withdrawn_by='judge'`, queue status `withdrawn`; the items are created either way)
- [x] unit tests: prompt rendering (disagreement windows), schema parse errors → `review` by `rules` with reason `judge_invalid` (fail safe toward a human), min interval, no duplicate items (also: LLM ok / review / withdraw with auto withdraw on and off, a failed call records nothing, the re-cut skips the LLM, part selection, env defaults, client selection)
- [x] e2e: fixture judge says `withdraw` → row withdrawn, human path served, items in a batch visible on `/admin/review?format=json`; fixture says `review` → row still served, items created; fixture says `ok` → nothing (also: the item page opens the ai item, JSON and HTML, blind; a second review while the item is open adds no item; the duration withdraw ignores `AI_JUDGE_AUTO_WITHDRAW=off` and creates no item)
- [x] run tests — must pass before task 7

### Task 7: Review verdicts applied to the AI table

**Files:**
- Modify: `prv/repository/ai.js` (`applyVerdict`), `prv/routes/admin-review.js` (decide route), `prv/repository/review.js` (item `kind` in `hydrate`), `prv/locales/review/{ru,en}.json` (an "AI segment" badge on ai items, the signals panel already shows votes/undo)
- Modify: `test/e2e.js`, `test/i18n.test.js` (parity is automatic)

- [ ] `applyVerdict(item, verdict, {transaction})`: `not_ad`/`unclear` remove the entry (withdraw row when empty, `withdrawn_by='review'`); `sponsor`/`self_promotion` keep/restore with the verdict's category; idempotent (a second identical verdict changes nothing)
- [ ] decide route: call it inside `withBatchLock()`'s transaction for `kind='ai'` items; `format=json` response gets `ai_applied: true|false`
- [ ] item page: badge + the judge's reason shown only after the verdict (blind rule, with `flagged_by`)
- [ ] e2e: `not_ad` on one of two entries → the other still served; `not_ad` on the last → human path; `sponsor` on a judge-withdrawn row → served again; sheet items (`kind='sheet'`) untouched by the hook
- [ ] run tests — must pass before task 8

### Task 8: Metrics, alerts, Grafana

**Files:**
- Modify: `prometheus-wrapper.js` (`registerAiMetrics`), `server.js`, `grafana/provisioning/alerting/rules.yml`, `grafana/dashboards/infrastructure.json`, `test/prometheus-wrapper.test.js`, `test/e2e.js`

- [ ] gauges `ai_videos{status}`, `ai_cost_usd_total{kind}`, `ai_judgements_total{decision,by}`, `ai_review_open` from one `collect()`; a failing query logs once and leaves them empty
- [ ] `CalculatorStale`: per-provider threshold (`ai_detect` 15 min, `ai_judge` 2 h) — one rule with a label-based threshold or two rules; `deleteRules` not needed
- [ ] `AiCostDaily` alert: `increase(ai_cost_usd_total[24h]) > AI_DAILY_BUDGET_VIDEOS × 0.05` (budget breached twice over)
- [ ] dashboard row: videos by status, cost per day, judgements by decision, open review items
- [ ] unit test for the collector (DB-free, injected query); e2e asserts the gauges on `/metrics` after the Task 3/6 scenarios
- [ ] run tests — must pass before task 9

### Task 9: Phase-3 spike and design note (audio drift)

**Files:**
- Create: `scripts/timeline-spike/` (`README.md`, `measure.py` = `~/Web/data/audit/audit.py` with whisper.cpp instead of the current ASR, host-only; nothing in the image), `docs/research/20261022-timeline-spike.md`
- Modify: `prv/db/index.js` (`AiTimeline` model, table only), `lib/schema.js`

- [ ] `prv_ai_timelines` table (no writer in the product yet)
- [ ] on the prod host (or a VM of the same size): whisper.cpp `small` on three 2-min windows of 5 audited videos; record CPU seconds, RAM, shift accuracy vs `drift.jsonl`
- [ ] research note: cost per video, accuracy, the trigger budget this allows, and the open design points for the next plan (bisection for steps, re-timing through `Resolve`, judge input)
- [ ] no product code path changes; `make test-e2e` unaffected

### Task 10: Verify acceptance criteria
- [ ] every flag default leaves the product as before the plan (fresh e2e run with no `AI_*` env: identical behaviour, the only diff is the `views` param accepted)
- [ ] the full path in one e2e scenario: `views` request → detect → served → vote → undo → judge `withdraw` → review item → `sponsor` verdict → served again → admin withdraw → human path
- [ ] run full test suite: `make test-unit && go test ./calculator ./ai/... && make test-e2e`
- [ ] `go vet ./...`, no video ids in tracked files (fixtures use placeholder ids like `-1_456000001`)

### Task 11: [Final] Update documentation
- [ ] CLAUDE.md: new binary, tables, flags, serving rule, judge, review `kind`, ops commands (`ai detect <native_id>`, `scripts/sync-detector.sh`), the "eval first, then sync" rule
- [ ] eval repo README/CLAUDE.md: the product consumes `internal/detector` via copy; prompt changes land there first
- [ ] `docs/backlog/`: items this plan leaves open (judge autonomy flag, views from old clients, phase-3 plan pointer)
- [ ] move this plan to `docs/plans/completed/`
- [ ] cleanup pass before commit (residue / transient state / open questions)

## Post-Completion

**Deploy order and rollout**
- ⚠️ **Owner, before week 1:** add the `ANTHROPIC_API_KEY` repository secret in GitHub Actions
  (Settings → Secrets and variables → Actions). Without it `AI_DETECT_ENABLED=on` has no key and
  every detect tick exits 1 (`AI_CLIENT=anthropic` refuses to start without a key).
- Secrets: `ANTHROPIC_API_KEY` as a GitHub Actions secret; `AI_FIRST`, `AI_DETECT_ENABLED`,
  `AI_JUDGE_ENABLED`, `AI_JUDGE_AUTO_WITHDRAW`, `AI_JUDGE_MODEL`, `AI_JUDGE_MIN_INTERVAL`,
  `AI_MIN_VIEWS`, `AI_DAILY_BUDGET_VIDEOS` as repository variables (unset = off / code default;
  `AI_JUDGE_AUTO_WITHDRAW` unset = on). `.github/workflows/deploy.yml` exports them to the remote compose; a flag added
  later goes into that list, `docker-compose.yml` and nothing else. Deploy
  with every `AI_*` flag off.
- Week 1: `AI_DETECT_ENABLED=on`, `AI_FIRST=off`, `AI_MIN_VIEWS=10000`: the
  detector publishes, nobody is served; compare `prv_ai_video_calculateds` with the human
  segments on the same videos from the DB (precision check on live data, no viewer affected).
- Week 2: `AI_FIRST=on` + `AI_JUDGE_ENABLED=on`; watch `ai_judgements_total`, the review
  queue and the undo rate per 1k views against the human-path baseline. Kill switch: `AI_FIRST=off`
  (set the repository variable, then Run workflow with `image_tag` = the running sha: no build,
  only the container swap).
- Later: `AI_JUDGE_AUTO_WITHDRAW` stays on; a judge-closes-cases flag only after the review
  verdicts show the judge's `withdraw` precision over a few weeks.

**External system updates**
- Extension (`~/Web/native-ad-skip`): send `views` (from the page counter) on `GET /video-calculated`;
  until released, the server fallback (requests + yt-dlp `view_count`) carries the trigger.
  Planned next client signals (seeks / timeline clicks, views) feed `prv_ai_videos` and the judge
  the same way: new event types in `POST /events`, new counters in `signals.go`.
- Eval repo: the judge prompt and the detector prompt are iterated there against the review
  verdicts (`ai-judge-*` sheets export like any other: `scripts/export-review-verdicts.sh`);
  `scripts/sync-detector.sh` brings a new version over, the prompt sha in `prv_ai_runs` tells
  which videos ran under which.
- Held-out re-score with v2.2 before it ships as `AI_MODEL`'s prompt (eval repo; the gate is
  SCORE ≥ 0.15 and ≤ 6 s/h wrongly cut, scored once).

**Prod-host spikes (deferred from Task 0 / Task 9, owner runs them; results go into
`docs/research/20261022-ai-first-spikes.md`, constants adjusted from them)**
- yt-dlp from the KZ IP: `--list-subs` + ru auto subs on 10 prv videos (success rate, wall time,
  rate limiting).
- Subtitle readiness: 10 fresh videos polled hourly for 3 days → the 6 h / 24 h / 72 h retry schedule.
- Views: the counter in the prv page DOM, `info.json` `view_count` for prv.

**Manual verification**
- Prod: `ai detect <native_id>` on one known video; `docker logs` lines; `/metrics` gauges;
  `/admin/video/:id` block; a vote from the extension on an AI segment; `AI_FIRST=off` round trip.

## Open questions

- Should a video with human markups *before* the detector runs be detected at all? This plan
  says yes (AI-first), the judge sees the markups as signals; the alternative (skip videos that
  already have ≥ 2 human markups with authors of rating ≥ 0) saves money and respects proven
  human work — decide after week 1's comparison.
- Timing gate threshold: 3 s (eval) vs 2 s; the spike's readiness data and week 1 counts decide.
- Judge model: Sonnet 5.5 is the default; if the review verdicts show it withdraws good segments,
  try Opus 5.5 on the judge only (small context, few calls).
