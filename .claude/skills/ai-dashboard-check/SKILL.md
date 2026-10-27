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
- **Cost**: `usd_24h` < 15 (AiCostDaily); `runs_24h` ≤ 300 (AI_DAILY_BUDGET_VIDEOS). Real price is ~$0.05/video
  (2026-10-25: 0.0518; plan assumed 0.025–0.033), so a full 300-video day ≈ $15 = the alert threshold.
- **Drop-off**: `dropped_pct` stays low single digits. `retry_table` is mostly `no ru subtitle track` (expected).
  `failed` rows: `only available to followers` / `not available in your country` / `Access restricted` = closed
  videos, fine. yt-dlp `'NoneType' object has no attribute 'split'` / `expected string or bytes-like object` =
  extractor bug on single pages (3 videos on 2026-10-25); many at once or every fetch failing = host ban, see
  `ai detect: every fetch of the tick failed` in docker logs and `AI_DETECT_ENABLED=off`.
- **Quality signals** (only meaningful once users see AI segments, i.e. `ai_first 1`): `votes` `< 0`,
  `against_table`, `withdrawn`, `verdicts not_ad`. `misses` = videos the model called clean but users marked.

Known limitation: 7 panels of the public dashboard fail with `pq: syntax error at or near "$"` (funnel,
"Ждут порога", "В очереди сейчас", "Суточный бюджет", …): public dashboards do not expand the hidden constant
variables `$min_views` / `$fallback_requests` / `$daily_budget`. The script skips them (listed under
"panel errors"); they work on the logged-in dashboard. Fix = constants in `grafana/dashboards/ai-pipeline.json`.

Baseline and history: the jsonl log (one line per run, UTC `at`). Compare runs with
`python3 -c "import json;[print(d['at'],d['through_model'],d['ready_videos'],d['usd_total']) for d in map(json.loads,open('$HOME/Web/data/ai-dashboard/snapshots.jsonl'))]"`.
