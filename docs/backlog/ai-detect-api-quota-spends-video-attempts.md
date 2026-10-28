---
worth: yes
where: ai/pipeline/detect.go:512
added: 2026-10-28
---
# an Anthropic quota rejection spends every claimed video's attempt

When `Submit` of the detect batch fails, every video of the batch goes through `markAttempt` (one `attempts` spent, back off 6 h / 24 h, `failed` after the third), whatever the error. A 400 `invalid_request_error` "You have reached your specified API usage limits. You will regain access on <date>" is the account's state, not the video's: the same videos would succeed once the limit is raised. With a limit that lasts days, each tick claims `AI_BATCH_MAX` new videos and walks them to `failed` within ~30 h, so a long stretch of quota errors permanently drops the queue's oldest videos (`failed` is never claimed again).

Seen on prod 2026-10-28: rejections 06:13Z–07:38Z (the monthly limit, lifted by the owner the same day), 64 videos left `queued` with `attempts = 1` and `last_error` "batch submit: … usage limits …". None reached `failed`; they retry from 12:13Z.

The tick already counts the rejection in `failed_videos` (`return failed + len(started)`), so `CalculatorFailedVideos` does fire; the gap is only the spent attempts.

Fix shape: treat a submit rejection the way a tick whose every fetch failed is treated when prv refuses the host (`hostFetches`): no attempt spent, the rows back to `queued` with `next_attempt_at` = the next tick (or an hour), the run rows deleted as now, `failed_videos` as now. Either for every submit error (nothing was sent, so no video is at fault) or only for 4xx quota / billing / auth answers and 5xx, keeping the attempt for a request the API rejects as malformed. e2e: `AI_CLIENT=fixture` would need a way to fail the submit.

Repair for rows already hit: `UPDATE prv_ai_videos SET attempts = attempts - 1 WHERE status IN ('queued', 'failed') AND last_error LIKE 'batch submit:%usage limits%'` (a `failed` one also back to `queued`, `next_attempt_at = NOW()`).
