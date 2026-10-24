---
worth: yes
where: prv/routes/videos.js (views param)
added: 2026-10-22
---
# no client sends `views`, so every AI queue row is a fallback row

`GET /video-calculated` accepts `views` and keeps the max in `prv_ai_videos.views_max`, but neither the extension (`~/Web/native-ad-skip`) nor older clients send it. Until they do, a video is queued only by the fallback (`requests ≥ AI_FALLBACK_REQUESTS`, then yt-dlp's `view_count` checked against `AI_MIN_VIEWS` at fetch time), which costs one yt-dlp info call per candidate and queues on our own traffic rather than the video's popularity. Old extension versions will never send it, so the fallback stays for them.

**Blocker found 2026-10-24 (first prod tick):** yt-dlp's prv extractor returns `view_count: null` (`like_count`, `comment_count` are filled), so every fallback row is stored with `views_max = 0`, goes back to `seen` and never reaches the model. Owner's choice the same day: without a `view_count` the fallback gate is our own `requests` alone (`AI_FALLBACK_REQUESTS` raised to 5); the rows the first ticks stored as 0 were reset with `UPDATE prv_ai_videos SET views_max = NULL WHERE views_max = 0 AND status = 'seen'`. Views from clients would still pick truly popular videos instead.

To do: the extension reads the view counter from the prv page and sends `views` (needs the prod-host spike "views in the DOM" from the plan's Post-Completion first). Later client signals (seeks, timeline clicks) go the same way: new event types in `POST /events`, new counters in `ai/judge/signals.go`.

From `docs/plans/completed/20261022-ai-first-segments.md` (Trigger and views, Post-Completion → External system updates).
