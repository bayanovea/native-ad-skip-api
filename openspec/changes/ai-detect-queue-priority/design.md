# Design

## Context

`claimQueued` (`ai/pipeline/queue.go`) selects the eligible `prv_ai_videos` rows with `queueRule` (`seen` past a threshold, a due retry, a stale `fetching`), `ORDER BY first_seen_at, native_id LIMIT <budget left> FOR UPDATE SKIP LOCKED`, and moves them to `fetching` in the same short transaction. Everything this change needs is already in the DB: `views_max`, `requests`, `first_seen_at` on the row; the channel's AI rows in `prv_ai_video_calculateds` (`native_id`, `data`, `published_at`); human markups in `markups` / `videos` / `markup_categories`. Prod numbers behind the factors (read-only, 2026-11-04): ad rate 72 % after a channel row with an ad, 18 % after one without, 38 % base, 80 % when a human ad markup exists; 514 eligible, all first requested within 4 days, 45 with a human ad markup, 115 from channels with no ad in ≥ 2 rows, 152 from channels with ≥ 50 %.

## Goals / Non-Goals

**Goals:**
- The budget goes first to the videos with the most viewers and the most likely ads, from the first tick after the deploy, without a new switch, column or table.
- What waits and what is given up is visible on the dashboard.

**Non-Goals:**
- The real publication date, a view velocity, a higher budget (proposal, Out of scope).
- Any change to admission, `queued_by`, the manual run, publish, serving.

## Decisions

- **One `ORDER BY` expression, computed in SQL** (not in Go after a wider read): the claim is `LIMIT n FOR UPDATE SKIP LOCKED`, so the order has to be the query's; reading all ~500 eligible rows into Go to sort them and then locking the chosen ids would need a second query and a re-check. The expression reads the row and two subqueries:
  ```sql
  ln(COALESCE(views_max, 0)::float / $1 + requests::float / $2 + 1)
    / (1 + EXTRACT(epoch FROM NOW() - first_seen_at) / 86400)
    * COALESCE(ch.factor, 1)
    * CASE WHEN EXISTS (SELECT 1 FROM markups m JOIN videos v ON v.id = m.video_id
                        JOIN markup_categories mc ON mc.id = m.category_id
                        WHERE v.native_id = a.native_id AND m.deleted_at IS NULL
                          AND mc.category IN ('sponsor', 'self_promotion')) THEN 0.3 ELSE 1 END
  ```
  `ch` is a CTE over `prv_ai_video_calculateds` grouped by `split_part(native_id, '_', 1)`: `n` rows, `served` rows with `jsonb_array_length(data) > 0`, `latest_served` of the row with the greatest `published_at`; `factor = CASE WHEN latest_served THEN 1.5 WHEN n >= 2 AND served = 0 THEN 0.5 ELSE 1 END`, joined by the eligible row's owner part. `$1`, `$2` are `cfg.MinViews`, `cfg.MinRequests`, already bound for `queueRule`. Withdrawn rows count like any other: a served entry at publish means the model found an ad on that channel. The log base does not matter for an order; `ln` reads shortest.
- **The value terms are the admission terms** (owner, 2026-11-04: "keep 10–20 % for the requests path" was the ask; the data says 16 videos in the queue and 93 runs ever came by requests): a quota is a second mechanism to get wrong, a term in the score lifts the same videos (20 requests ≈ `AI_MIN_VIEWS` views, the admission rule's own exchange rate) and both admission criteria stay as they are.
- **Freshness divides, it does not add** (owner's "fresh videos first", 2026-11-04): an additive age bonus would let an old low-value video beat a new big one and guarantees nothing but eventual processing; a divisor says the value of the detection decays with the views already watched, so the band the budget cannot drain sinks and the 14-day cut takes it out. `first_seen_at` is the proxy (Out of scope: the extension date); the known error is an old video first requested recently scoring as fresh, which the channel and human factors do not correct.
- **Expiry is a code constant** (`queueMaxAge = 14 * 24 * time.Hour`, rendered into `queueRule` as `first_seen_at > NOW() - INTERVAL '14 days'` on the `seen` branch only): retries carry their own `next_attempt_at`, a stale `fetching` row is a crash to recover, not a wait. A switch or variable would be the fourth knob on one queue; a change of the constant is a code change with the dashboard literal (`/* queue.go queueMaxAge */`). Expired rows keep `status = 'seen'`: no new status, the previous image sees ordinary rows, and a dashboard panel counts them by the same predicate.
- **Channel factor from AI rows only**, not from human markups or review verdicts: the rows are the model's own history on the channel, the thing the 72 / 18 % split was measured on; `hidden` entries do not count as "found" (an entry hidden by confidence, length, the second opinion or a verdict is exactly what is not served). "Latest row has an ad" rather than "any row": the stickiness measured is of the previous video. The 0.5 needs two empty rows so one clean video does not sink a channel; the factor never reaches 0, so a channel with many views comes back and the prior refreshes itself.
- **Human factor 0.3, not skip** (owner, 2026-11-04): the AI row on a human-marked video is still wanted (the judge reads conflicting human markups against it, assessors see the disagreement), only later; the factor is on existence of any live `sponsor` / `self_promotion` markup, whatever its author's rating, since a 400 on a bad author's markup is already in `POST /markup`.
- **Tie order** `first_seen_at, native_id` after the score keeps today's determinism (`queue_test.go` matches the `ORDER BY`).
- **Precision-first / serving**: untouched. The change decides which videos are detected and when, never what is served; a wrong order costs latency on one video, never a wrong segment.
- **Locks and transactions**: the claim transaction is as today (`FOR UPDATE SKIP LOCKED` on `prv_ai_videos` rows, committed after the `fetching` update); the CTE and the `EXISTS` read `prv_ai_video_calculateds`, `markups`, `videos` without locks (a snapshot read; a publish or a markup committing meanwhile changes the next tick's order, nothing else). No `video_calculateds`, AI row or batch row lock is taken.
- **Index**: the `EXISTS` runs once per eligible row (~500). Check `videos (native_id)` on the local dump; without one add `CREATE INDEX IF NOT EXISTS videos_native_id ON videos (native_id)` in `lib/schema.js` next to the other idempotent DDL (the read path's `findVideoForRead` and the dashboard's misses pair hit the same predicate). `prv_ai_video_calculateds` is 2.3k rows, the CTE scans it.
- **Dashboard**: the queue stat (id 24) and the funnel (id 15, stage 2 and the `eligible` CTE) gain `AND first_seen_at > NOW() - INTERVAL '14 days' /* queue.go queueMaxAge */` on the `seen` branch; two new panels in row 2: a bar gauge "В очереди по просмотрам" (`width_bucket(views_max, ARRAY[500000, 1000000, 2000000, 5000000, 10000000])` over the eligible rows, bands labelled, NULL as "по запросам") and a stat "Не дождались (старше 14 дней)" (`seen`, community, past a threshold, older than the cut). The `ai-dashboard-check` skill's `queue_now` reads the stat by title, unchanged.
- **Rollback**: no schema or data change. The previous image runs `ORDER BY first_seen_at` over the same rows, so expired rows become eligible again (oldest first) and the dashboard's two new panels stay on the provisioned JSON of the deployed checkout, which the rollback also replaces. The optional index is harmless to any image.

## Risks / Trade-offs

- **Starvation of the low band** is the point, but its size is unknown until the order runs: the proposal's numbers say ~110–135 videos/day of 500k–1M views arrive against a leftover of ~100/day after the bigger bands, so a share of that band expires. The dashboard's expired count tells how large; if it is most of the band, the owner moves the budget or `AI_MIN_VIEWS` (backlog item, Out of scope).
- **Channel prior feedback**: a channel with 0.5 is checked less, so its prior refreshes slower; the factor is on the score, not the admission, so high views still bring such a channel back, and a channel's first ad on a 500k video may be found late. Accepted (owner, 2026-11-04: yield over coverage).
- **`first_seen_at` ≠ publication**: an old video first opened by an extension user yesterday scores as fresh and may take a slot from a genuinely new one; bounded by the 14-day cut and fixed by the extension date follow-up.
- **Query cost**: a CTE over 2.3k rows plus ~500 `EXISTS` lookups per 5-minute tick; with the index this is milliseconds. Without it a `videos` seq scan per row would make the claim seconds long while holding no lock the read path waits on (the claim locks `prv_ai_videos` rows only after the select completes), so still no user-visible effect.
- **Ties at zero**: a `requests`-only video with `views_max` NULL has `ln(requests / AI_MIN_REQUESTS + 1) > 0`; nothing eligible scores 0, so the tie order rarely decides.
