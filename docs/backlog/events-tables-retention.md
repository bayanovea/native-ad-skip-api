---
worth: later
where: prv/db/index.js
added: 2026-11-20
---
# viewer-signal event tables grow without a bound

Since the extension sends `interval_skip` / `interval_undo` / `interval_overrun` (change `user-signal-events`), the
`prv_events_*` tables only grow: skips are the bulk, one row per served segment per view that reaches it. Estimate
from 2026-11-20 volumes (~22,000 `GET /video-calculated` a day): ~5,000 rows a day ≈ 2 M rows and ~0.4 GB a year with
the two indexes per table. Nothing deletes them; the weekly dump grows with them.

Candidate rule: drop skip rows older than N months once the judge has what it needs; keep undo and overrun rows
longer, they are few. The judge recounts its totals from every row on each judgement (`ai/judge/signals.go`), so a
deletion lowers `skips` and the undo rate per skip it shows the LLM: either delete only rows of native_ids with no
live AI row, or give the judge a stored base count first. Decide N after the first analysis of the signals, from the actual row counts on
prod; a daily `DELETE … WHERE "createdAt" < NOW() - INTERVAL 'N months'` from cron next to the calculators, or
partitioning by month if the tables get large.
