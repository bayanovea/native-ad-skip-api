---
worth: later
where: grafana/provisioning/alerting/rules.yml (calculator-failed-videos)
added: 2026-10-22
---
# CalculatorFailedVideos fires on a single failed `ai detect` tick

`CalculatorFailedVideos` is `max by (provider) (calculator_failed_videos) > 0` for 3 min, sized for the calculator that runs every minute (three runs). `ai detect` runs every 5 min and counts a yt-dlp error as a failed video (the video is retried later), so one transient fetch error keeps the gauge above 0 for a whole tick and fires the alert. `ai judge` (hourly) has the same shape.

Options: keep it (a yt-dlp failure from the prod IP is worth knowing about early), or give `provider=~"ai_.*"` a longer `for` (a second rule, or a per-provider division as `CalculatorStale` does). Decide after week 1 shows how often yt-dlp fails from the KZ IP.

From the open questions of `docs/plans/completed/20261022-ai-first-segments.md`.
