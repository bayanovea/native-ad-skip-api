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
