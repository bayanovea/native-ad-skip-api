---
worth: watch
where: repository variables AI_DAILY_BUDGET_VIDEOS / AI_MIN_VIEWS / AI_MIN_REQUESTS, grafana/dashboards/ai-pipeline.json, grafana/provisioning/alerting/rules.yml (AiCostDaily)
added: 2026-10-29
---
# The detector queue grows faster than the daily budget drains it

Snapshots of the ai-dashboard-check skill (`queue_now` = eligible `seen` + due retries, community videos only):

| at (UTC)         | queue_now | runs_24h | note |
|------------------|-----------|----------|------|
| 2026-10-28 16:32 | 265       | 270      | first snapshot with the panel; views trigger live since the 2026-10-28 deploy |
| 2026-10-28 16:58 | 281       | 267      | |
| 2026-10-29 04:48 | 332       | 196      | |
| 2026-10-29 05:24 | 313       | 198      | morning MSK: the tick drains faster than videos arrive |
| 2026-10-29 11:49 | 269       | 199      | |
| 2026-10-29 17:15 | 428       | 200      | |
| 2026-10-30 16:28 | 512       | 200      | +84 in 23 h against 200 claims: inflow ~280/day, no sign of the burst ending yet |

`budget_pct` sits at ~100 throughout. Net over the 12.9 h from the first snapshot: +48 in the queue
against ~106 claims, i.e. an eligible inflow of ~290/day, above the 200/day budget.

## Analysis (2026-10-29)

Decision: **do not change the limits yet**; re-check on 2026-10-31 and 2026-11-02.

- The inflow is the views trigger alone: since 2026-10-28 every claim is `queued_by = views` (140 rows,
  "Почему взяли в детектор"), none by `requests`; the below-threshold request histogram tops out at
  18 < `AI_MIN_REQUESTS`, so the requests path is exhausted and adds nothing.
- The views trigger is one day old and its first days are a burst: `views_max` is filled only when a
  client with the new extension release (out since 2026-10-28) opens the video, so every popular video
  the users already had in their history becomes eligible on its first revisit. That backlog is finite;
  the steady state is only *newly* popular videos the users open, which is less than the day-one rate.
  The 05:24 snapshot already shows the queue shrinking when traffic is low.
- The cost of waiting is latency, not loss: the queue is oldest-first, so a new popular video waits
  queue / 200 days (1.5 days at 313) before its segments exist; the human path serves it meanwhile.
- Raising the budget now would spend ~$5/day more on the burst and leave the question open anyway.

Rule for the re-check: if `queue_now` is still above ~300 and growing while `budget_pct` ≈ 100 on
2026-11-02 (four days after the flip), the steady inflow exceeds the budget and a limit has to move:

- Preferred: `AI_DAILY_BUDGET_VIDEOS` 200 → 300 (the code default; ~$0.052/video → ≈ $15.6/day, so
  `AiCostDaily` 15 → 25 in the same commit, plus the `/* AI_DAILY_BUDGET_VIDEOS */` literal in
  `ai-pipeline.json`). A cheaper video (`ai-cost-per-video-2x-eval.md`) makes this free.
- Alternative: `AI_MIN_VIEWS` 500000 → 1000000 (fewer videos, each with more viewers to benefit;
  the `/* AI_MIN_VIEWS */` literal in `ai-pipeline.json` moves with it). `AI_MIN_REQUESTS` is not
  a lever: nothing reaches it.

If the queue has drained (below ~150 and falling), close this item: the burst was the whole story.

**2026-11-01 (owner):** `AI_DAILY_BUDGET_VIDEOS` 200 → 230 together with the second opinion going on (`AiCostDaily` 15 → 20, the dashboard literal moved). Re-check the queue against the 230 drain rate on the next dashboard checks; close this item once `queue_now` falls.

**2026-11-02 check:** `queue_now` 457 (517 on 11-01 04:59 UTC), `runs_24h` 229, `budget_pct` 99.6: above ~300 but falling by ~60/day at the 230 drain, so no limit moves. Close once it is below ~150.

**2026-11-04 check:** `queue_now` 524 (11-02 18:11 UTC) → 477 (11-04 08:20) → 521 (11-04 14:07), runs 230/day
on 11-01…11-03 (ICT days, `prv_ai_runs`). Since the 230 budget the queue has stopped growing but not
fallen: it swings 457–589 with the daily traffic cycle around ~500, so inflow ≈ drain ≈ 230/day and a
new eligible video waits ~2 days. It will not reach ~150 at this budget; the 2026-10-29 rule (a limit
has to move) now applies if waiting ~2 days is not acceptable.

**2026-11-04 (decision):** the 2026-11-04 line is answered by an order change, not a limit:
`openspec/changes/ai-detect-queue-priority` claims the highest score first (views, requests, freshness, channel
history, human markup) instead of oldest first, and a `seen` video first requested more than 14 days ago expires
unprocessed. The ~2-day wait now falls on the low band (500k–1M views, channels without ads) and the big videos get
their segments the same day. This item closes when that change is archived. The new watch is the "Не дождались
(старше 14 дней)" stat on the ai-pipeline dashboard against the 500k–1M inflow (~110–135/day): if most of that band
expires, the owner moves `AI_DAILY_BUDGET_VIDEOS` or `AI_MIN_VIEWS` by the numbers above.

**2026-11-05 check:** `queue_now` 438 (07:52 UTC), lowest reading yet; 477 at the same hour on 11-04, 521 on 11-04 14:07. `runs_24h` 229, "Не дождались" 0. Priority order is live only since the 06:54 UTC deploy, and from 07:09 terra detects at ~$0.010/video (Sonnet ~$0.040), so the budget now costs less than the numbers above.
