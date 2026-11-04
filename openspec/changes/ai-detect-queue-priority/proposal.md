# Proposal

From the backlog item `docs/backlog/ai-detect-queue-outgrows-budget.md` (its 2026-11-04 check: inflow ≈ drain ≈ `AI_DAILY_BUDGET_VIDEOS` per day, the queue swings around 500 and a new eligible video waits ~2 days), in the shape the owner chose on 2026-11-04: not a bigger budget but a better order.

## Why

The detect queue is first come, first served, so a 10M-view video published today waits behind two days of 500k-view videos (prod 2026-11-04: 514 eligible, 243 of them 500k–1M views, 144 above 2M; inflow of videos above 1M is 100–140/day, well within the budget). And the budget itself is spent badly: 60 % of the runs of the last three days (401 of 662) found nothing to serve, while the one signal that predicts an ad is never read: a channel whose previous video had an ad gets one 72 % of the time, a channel whose previous video had none 18 % (base rate 38 %; the views band predicts nothing, 33–46 % in every band). Ordering by value and expected yield gives the viewers of the big videos their segments the same day and turns more of the same money into served segments.

## What Changes

- **A priority score replaces the oldest-first order** of the detect tick's claim (owner, 2026-11-04). Per eligible video:
  - *value*: `ln(views_max / AI_MIN_VIEWS + requests / AI_MIN_REQUESTS + 1)` (an unknown `views_max` counts 0; the two admission criteria are also the two value terms, 20 requests weigh as much as 500000 views, so the requests path needs no reserved share),
  - *freshness*: divided by `1 + days since first_seen_at` (the time the video was first requested from us, the proxy for its publication: the value of a detection falls as the views it would have served pass),
  - *channel history*: × 1.5 when the channel's latest AI row has a served entry, × 0.5 when the channel has at least two AI rows and none has one, × 1 otherwise (the channel is the owner part of the native id),
  - *human markup*: × 0.3 when any `videos` row of the native id has a live `sponsor` / `self_promotion` markup (the human path already serves those viewers, and with `AI_FIRST=on` the AI row would replace that markup).
  Highest score first; ties by `first_seen_at`, then `native_id`. Due retries and stale `fetching` rows sort by the same score. The admission rule (`AI_MIN_VIEWS` or `AI_MIN_REQUESTS`, community videos only), the budget and `queued_by` are unchanged.
- **A waiting video expires.** A `seen` video first requested more than 14 days ago is no longer eligible, however many views it has (the band the budget cannot drain sinks by the freshness term and would otherwise accumulate forever and keep the dashboard's queue count from meaning "waiting"); a later request does not revive it. A code constant, not a switch: with inflow at the budget the cut is what the order implies.
- **Dashboard**: the queue stat and the funnel's stage 2 apply the 14-day cut (literal tagged with the constant's name); the queue row gains the queue by views band (what waits now) and the expired count (what the order gave up).
- **Docs**: CLAUDE.md (`ai detect`, Dashboard), the AI-first overview pages ru/en (the detector takes the videos "with the most viewers first", one sentence) and their two artifacts; the backlog item closes at archive.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `ai-detect-queue`: the order in which eligible videos are claimed (score instead of oldest first), the channel and human-markup factors, and the 14-day expiry of a waiting video. The admission thresholds and the `queued_by` record are untouched.

## Impact

- Go: `ai/pipeline/queue.go` (`claimQueued`'s query: the score as the `ORDER BY`, the expiry in `queueRule`; a constant `queueMaxAge`), `ai/pipeline/queue_test.go` (sqlmock expectations). No new env variable, no schema change, no new table: the factors are read from `prv_ai_video_calculateds`, `markups` / `videos` / `markup_categories`, which exist. A `videos.native_id` index if there is none (`lib/schema.js`, `CREATE INDEX IF NOT EXISTS`): the human-markup factor is an `EXISTS` per eligible row.
- Node: nothing on the read path; `lib/schema.js` only for the index.
- Ops: `grafana/dashboards/ai-pipeline.json` (queue stat, funnel stage 2, two new panels). The `ai-dashboard-check` skill reads `queue_now` from the existing stat, so it keeps working and starts showing the queue without the expired rows.
- Tests: `test/e2e.js` (`ai detect: the queue takes the highest score first, a video older than 14 days not at all`), Go unit tests.
- Behaviour: from the first tick after the deploy the budget goes to the videos with the most viewers and the most likely ads; the 500k–1M band of channels without ads waits longest and part of it expires unprocessed. Nothing changes for published rows, serving, votes, the judge or review.

## Out of scope

- The real publication date: neither the stored yt-dlp info nor the extension carries it, so `first_seen_at` stands in (a year-old video first requested yesterday scores as fresh). Follow-up: the extension sends the page's date text next to `views_text`, a `published_text` → `published_at` pair of the `views_text` kind, and the freshness term switches to it when present (`docs/backlog/ai-publish-date-from-clients.md`, filed by this change).
- Moving the budget or the thresholds (`AI_DAILY_BUDGET_VIDEOS`, `AI_MIN_VIEWS`, `AI_MIN_REQUESTS`): the order makes the question "what to cut" rather than "how much to spend"; the backlog item records the numbers for when the owner wants to revisit.
- A view velocity from repeated readings (`views_max` − the first reading): 38 % of the queue has been requested once, and the extension date above answers the same question better.
- Skipping human-marked videos outright, or weighing the markup's author rating: the owner chose a factor (2026-11-04), the judge still wants AI rows on such videos as agreement data.
- The manual run `ai detect <native_id>` (no queue), the judge, regate, serving.
