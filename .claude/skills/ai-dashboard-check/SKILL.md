---
name: ai-dashboard-check
description: Health check of the prod AI-first pipeline from the public Grafana dashboard "AI-разметка" (ai-pipeline). Use when the user asks to check the dashboard / graphs after a deploy, a flag flip or a launch ("проверь по графикам", "как дела у разметки", "check the AI dashboard"), or wants the dynamics since the last check.
---

# AI dashboard check

Run (no SSH, no DB, public API; appends a snapshot to `~/Web/data/ai-dashboard/snapshots.jsonl`
and prints deltas against the previous one):

```bash
python3 .claude/skills/ai-dashboard-check/check.py          # --no-save for a dry look, --all for full tables, --days N for the time range
```

The public dashboard token is not in the repo: `AI_DASHBOARD_TOKEN` or `~/Web/data/ai-dashboard/public-token`
(Grafana → the dashboard → Share → Public dashboard).

Read the output top-down and report in the usual Verdict / Why blocks. What "ok" means:

- **Switches** match the intended stage. Week 1 (since 2026-10-24): `detect_on 1`, `judge_on 0`, `ai_first 0`.
  Judge on → expect `judgements` to fill and `review_open` to move. `ai_first 1` → `lookups_per_h` gets an
  `ai` series and `ai_share_24h` a value.
- **Health**: `since_tick_s.ai_detect` < 600 (900 = CalculatorStale), `ai_judge` < 7200 when on; `fetching_stuck 0`;
  `detecting` oldest < 24 h (batch expiry).
- **Cost**: `usd_24h` < 15 (AiCostDaily); `runs_24h` ≤ 200 (prod `AI_DAILY_BUDGET_VIDEOS` since 2026-10-28,
  code default 300). Real price is ~$0.05/video (2026-10-25: 0.0518; plan assumed 0.025–0.033), so a full
  200-video day ≈ $10. `runs_24h` above the budget (e.g. right after a cut) means ticks claim nothing, stale
  `fetching` rows included, until the rolling window drops under it.
- **Capacity**: `queue_now` (eligible `seen` + due retries) growing from run to run while `budget_pct` sits
  at 100 means the eligible inflow exceeds the budget: raise `AI_DAILY_BUDGET_VIDEOS` or the thresholds.
  A queue that drains between checks is fine. `funnel` = the dashboard's stage bar gauge.
- **Drop-off**: `dropped_pct` stays low single digits. `retry_table` is mostly `no ru subtitle track` (expected).
  `failed` rows: `only available to followers` / `not available in your country` / `Access restricted` = closed
  videos, fine. yt-dlp `'NoneType' object has no attribute 'split'` / `expected string or bytes-like object` =
  extractor bug on single pages (3 videos on 2026-10-25); many at once or every fetch failing = host ban, see
  `ai detect: every fetch of the tick failed` in docker logs and `AI_DETECT_ENABLED=off`.
- **Quality signals** (only meaningful once users see AI segments, i.e. `ai_first 1`): `votes` `< 0`,
  `against_table`, `withdrawn`, `verdicts not_ad`. `misses` = videos the model called clean but users marked.

The gate and budget thresholds are inlined in the panels' SQL (`500000 /* AI_MIN_VIEWS */`, …): public
dashboards do not expand dashboard variables, so before 2026-10-28 the funnel, "Ждут порога", "В очереди
сейчас" and the budget gauge failed with `pq: syntax error at or near "$"`. A failing panel shows under
"panel errors".

Baseline and history: the jsonl log (one line per run, UTC `at`). Compare runs with
`python3 -c "import json;[print(d['at'],d['through_model'],d['ready_videos'],d['usd_total']) for d in map(json.loads,open('$HOME/Web/data/ai-dashboard/snapshots.jsonl'))]"`.
