---
worth: yes
where: prv/routes/videos.js (views param)
added: 2026-10-22
---
# no client sends `views`, so every AI queue row is a fallback row

`GET /video-calculated` accepts `views` and keeps the max in `prv_ai_videos.views_max`, but neither the extension (`~/Web/native-ad-skip`) nor older clients send it. Until they do, a video is queued only by the fallback (`requests ≥ AI_FALLBACK_REQUESTS`, then yt-dlp's `view_count` checked against `AI_MIN_VIEWS` at fetch time), which costs one yt-dlp info call per candidate and queues on our own traffic rather than the video's popularity. Old extension versions will never send it, so the fallback stays for them.

To do: the extension reads the view counter from the prv page and sends `views` (needs the prod-host spike "views in the DOM" from the plan's Post-Completion first). Later client signals (seeks, timeline clicks) go the same way: new event types in `POST /events`, new counters in `ai/judge/signals.go`.

From `docs/plans/completed/20261022-ai-first-segments.md` (Trigger and views, Post-Completion → External system updates).
