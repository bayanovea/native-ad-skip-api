---
worth: later
where: grafana/provisioning/alerting/rules.yml (calculator-failed-videos)
added: 2026-10-22
---
# CalculatorFailedVideos fires on a single failed `ai detect` tick

`CalculatorFailedVideos` is `max by (provider) (calculator_failed_videos) > 0` for 3 min, sized for the calculator that runs every minute (three runs). The `ai` commands count only infrastructure failures there (DB, Batches / Messages API, a yt-dlp that cannot start; a video's own outcome such as "video unavailable" is not counted), but `ai detect` runs every 5 min and `ai judge` hourly, so one transient API error keeps the gauge above 0 for a whole tick and fires the alert.

Options: keep it (an API or host failure is worth knowing about early), or give `provider=~"ai_.*"` a longer `for` (a second rule, or a per-provider division as `CalculatorStale` does). Decide after week 1 shows how often the API fails.

From the open questions of `docs/plans/completed/20261022-ai-first-segments.md`.
