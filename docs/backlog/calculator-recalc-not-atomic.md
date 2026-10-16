---
worth: yes
where: calculator/calculate.go:82
added: 2026-10-16
---
# calculator recalculation is not atomic and panics kill the whole run

`calculateVideo` runs `clearOldVideoCalculated` (three DELETEs), then the inserts, then `updateIsNew`, with no transaction. A failure between the delete and the insert (DB restart, deploy, OOM) leaves the video with no segments. Errors are `panic`/`log.Fatalf` (13 sites), so one bad video inside the goroutine pool kills the process and abandons every other video in that run. Cron fires every minute with no lock, so a slow run can overlap the next one. `updateIsNew` (:238) sets `is_new = false` on every live markup of the video, including markups inserted after the read; those are never aggregated until another markup arrives (there is a TODO about this in the code).

Fix: one `db.Begin()` per video around clear + insert + mark; return errors, log them per video and let the pool go on; `flock -n` in `crontab` or a Postgres advisory lock per provider; update `is_new` by the markup ids actually read.

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
