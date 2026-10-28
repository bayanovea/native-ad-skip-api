---
worth: later
where: ai/pipeline/detect.go:493 (submit, synchronous client) → finish
added: 2026-10-28
---
# a Messages API error on the synchronous path fails the video at once

With `AI_CLIENT=messages` (cron) and in the manual run `ai detect <native_id>`, `r.client.Detect` returning an error (a 400 "You have reached your specified API usage limits", a 429, a 5xx left after the SDK's retries) goes to `finish` as `callErr`, which sets the video `failed` with that `last_error`: no retry, and the tick's `failed_videos` does not count it (`finish` returns nil). The run row stays with `cost_usd` 0. A `failed` video is never claimed again by the queue, so on the cron a quota outage walks every claimed video straight to `failed`.

The batch path (the prod default, `AI_CLIENT=anthropic`) no longer does this for a rejected submit: the videos go back to `queued` in an hour with no attempt spent. A transport error there comes from `Poll` and keeps the videos `detecting`.

Impact today is small: prod runs the batch client, and a manual run exits 1 with the reason, and the operator can run it again (a `failed` row without an AI row is claimable by hand).

Fix shape: in `submit`'s synchronous branch tell a call error (the request never produced an answer) from an invalid answer, and treat the call error as the rejected batch submit: delete the run row, `requeue` the video in an hour, count it in `failed_videos`. The manual run then ends `queued` and exits 1 as now.
