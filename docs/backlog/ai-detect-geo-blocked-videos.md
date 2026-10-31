---
worth: later
where: ai/pipeline/detect.go (fetchError, recordFetchError), ai/pipeline/queue.go (markAttempt)
added: 2026-11-01
---
# Geo-blocked videos are retried as ordinary yt-dlp errors

Some videos are not served to the prod host's country: yt-dlp fails with `ERROR: [<platform>] This video is not available in your country` (two of them in the first ticks after the 2026-11-01 deploy). The detector treats it as any yt-dlp error: the video is queued again after 6 h and 24 h and only then fails with `last_error` set, so each one costs three claims, three fetch pauses and a retry slot, and the dashboard counts it under "yt-dlp: 3 неудачных попытки" next to genuinely broken videos. No model call is spent (the budget counts `prv_ai_runs` only).

Options:

1. **Terminal at first sight.** Recognise the message in `fetchError` and move the row to a status of its own (e.g. `geo_blocked`) or straight to `failed` with that reason, no retries; a funnel stage / reason on the dashboard. Cheap; the human path still serves these videos.
2. **Fetch through another country.** A proxy for yt-dlp only (`ytdlp.Runner` already takes args). Brings back the hosting question the move to Timeweb settled; worth it only if the share is large.

Unknown that settles it: how many videos it hits. On prod: `SELECT COUNT(*) FROM prv_ai_videos WHERE last_error LIKE '%not available in your country%'`, against the claims of the same period. The "every fetch of the tick failed" check (`hostFetches`) already treats such errors as the videos', not the host's, as long as the control video still fetches.
