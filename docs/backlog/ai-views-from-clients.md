---
worth: yes
where: prv/routes/videos.js (views_text param), lib/parse-views-text.js, grafana/dashboards/ai-pipeline.json
added: 2026-10-22
updated: 2026-10-28
---
# `views_text` from clients: watch the parser and the share of `requests`-only claims

`GET /video-calculated` accepts `views_text` (the page's counter as text; the numeric `views` was dropped on 2026-10-26 because the string's format follows the user's locale and changes more often than the DOM, so the parsing lives here, `lib/parse-views-text.js`) and keeps the max count in `prv_ai_videos.views_max`. The extension release that sends it together with `v` is out since 2026-10-28, so new rows from updated clients carry `views_max`; old extension versions never send it.

History: until 2026-10-28 a row without `views_max` was a "fallback row", queued only by `requests ≥ AI_FALLBACK_REQUESTS` and then re-checked against yt-dlp's `view_count` at fetch time. That gate never worked: yt-dlp's prv extractor returns `view_count: null` (found 2026-10-24, the first prod tick; rows stored as 0 were reset with `UPDATE prv_ai_videos SET views_max = NULL WHERE views_max = 0 AND status = 'seen'`), so the fallback was our own `requests` alone. Both are gone with `openspec/changes/ai-detect-trigger-views-or-requests/`: a `seen` video is taken when `views_max ≥ AI_MIN_VIEWS` (500000) **or** `requests ≥ AI_MIN_REQUESTS` (20, was `AI_FALLBACK_REQUESTS`), independent criteria; `views_max` comes from clients only, and the claim records which criterion let the row in (`prv_ai_videos.queued_by`, the "Почему взяли в детектор" panels on `ai-pipeline.json`).

What is left to watch:
- `prv_ai_videos` rows with a `views_text` and no `views_max`: an unreadable counter format (another locale, a new page layout) → extend the parser.
- The share of rows claimed by `requests` vs `views` on the new dashboard panel; `requests`-only claims from updated clients mean the counter is not read or the views threshold is too high for the traffic.

Close when `requests`-only claims from updated clients are rare. Later client signals (seeks, timeline clicks) go the same way: new event types in `POST /events`, new counters in `ai/judge/signals.go`.

From `docs/plans/completed/20261022-ai-first-segments.md` (Trigger and views, Post-Completion → External system updates).
