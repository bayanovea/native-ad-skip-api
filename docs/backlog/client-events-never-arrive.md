---
worth: soon
where: prv/routes/events.js
added: 2026-11-03
---
# no client event ever reached prv_events_*

On prod (checked 2026-11-03) `prv_events_time_saved`, `prv_events_interval_undo` and `prv_events_interval_click` have 0 rows over all time, and only 3 `users` rows have `time_saved > 0` (0 h in total). So time saved by the product cannot be measured, and the AI judge's `undo` / `clicks` signals (`ai/judge/signals.go`) are always 0: of its negative signals only votes and conflicting markups ever work.

Next step: find out whether the extension calls `POST /events` at all (its code / the release notes; nginx access log for `POST /events` on the host), and whether it might send to a path or provider prefix that drops the batch (invalid events are only logged to stdout, `docker logs … | grep -i event`). Close when rows arrive, or when the owner decides the extension will not send them (then drop the undo / click signals from the judge).
