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

**2026-11-02 dashboard reading:** "yt-dlp: 3 неудачных попытки" went 87 → 143 in 24 h (+56, against +225 runs); in the newest 50 rows, 18 of the dropped and 17 of the pending retries are "not available in your country". `dropped_pct` 12.3 → 15.6. The share looks large enough for option 1; the SQL count above confirms it.

**2026-11-04 count (prod SQL above):** 210 rows carry the geo error (160 `failed`, 50 waiting for a retry) of 2972 claimed so far, about 7 %; 160 of the 279 `failed` rows. 19 channels, one of them 124 rows. `dropped_pct` 9.2 (10-29) → 19.3, mostly this. Option 1 saves the retries but recovers nothing; option 2 brings back ~7 % of claimed videos, more than half of it one channel.

**Open (owner, 2026-11-04):** the share is known; what is left is the owner's call whether ~7 %, mostly one channel, is worth a yt-dlp proxy in another country. Declined → option 1. Re-count with the SQL above before deciding: if the big channel stops posting, the share drops.

**2026-11-05 re-count:** 228 rows (195 `failed`, 33 waiting for a retry) of 3283 claimed, 6.9 %; `dropped_pct` 20.2. The share holds, the owner's call stays open.
