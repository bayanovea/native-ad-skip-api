---
worth: later
where: ai/pipeline/queue.go (queueRule)
added: 2026-11-05
---
# Feed the detector from the platform's trends page

Today a video reaches `prv_ai_videos` only when a client opens it (`GET /video-calculated` with `v`), so the
detector sees a popular video the first time a user already sits in front of it, and its segments exist
~2 days later at the current queue (`ai-detect-queue-outgrows-budget.md`). Parsing the platform's trends page
on a cron tick would upsert those videos ahead of the first request (a new `queued_by = 'trends'`, same
claim path), so the segments are there when the users arrive.

Unknowns that settle the value call:
- The budget is already fully spent on videos users did ask for; trends videos either take a share of it
  (priority score, `queue.go`) or get their own budget line, and `AiCostDaily` moves with it.
- How much of the trends page our users actually open: the share of trends videos that later show up in
  `prv_ai_videos` by a client request decides whether the detections are ever served.
- Fetching the page: yt-dlp's extractor or plain HTTP, whether it needs a logged-in session, and whether the
  prod host's region shows the same list the users see (`ai-detect-geo-blocked-videos.md`).
