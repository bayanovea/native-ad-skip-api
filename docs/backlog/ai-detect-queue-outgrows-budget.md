---
worth: soon
where: repository variables AI_DAILY_BUDGET_VIDEOS / AI_MIN_VIEWS / AI_MIN_REQUESTS, grafana/dashboards/ai-pipeline.json, grafana/provisioning/alerting/rules.yml (AiCostDaily)
added: 2026-10-29
---
# The detector queue grows faster than the daily budget drains it

Snapshots of the ai-dashboard-check skill: `queue_now` (eligible `seen` + due retries) 265 → 281 (2026-10-28 16:58Z) → 332 (2026-10-29 04:48Z) while `budget_pct` stays at ~100 (`runs_24h` 196 of 200). The eligible inflow exceeds 200 videos/day, so the oldest-first queue keeps lengthening and a new popular video waits longer each day.

Owner's call: raise `AI_DAILY_BUDGET_VIDEOS` (~$0.0525/video, so +100/day ≈ +$5/day; `AiCostDaily` is 15, about 285 videos/day) or raise `AI_MIN_VIEWS` / `AI_MIN_REQUESTS`. Either way the tagged literals in `ai-pipeline.json` (`/* AI_DAILY_BUDGET_VIDEOS */`, `/* AI_MIN_VIEWS */`, `/* AI_MIN_REQUESTS */`) and, for the budget, the `AiCostDaily` threshold change in the same commit. Related: `ai-cost-per-video-2x-eval.md` (a cheaper video makes a bigger budget affordable).
