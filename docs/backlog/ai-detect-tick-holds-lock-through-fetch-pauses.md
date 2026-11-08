---
worth: later
where: ai/pipeline/detect.go:386 (detect), crontab (flock -n /tmp/ai-detect.lock)
added: 2026-11-09
---
# A detect tick holds the lock through its fetch pauses

Cron runs the whole `ai detect` under `flock -n /tmp/ai-detect.lock`, and the tick sleeps `jitter(FetchPause)`
before each of its `BatchMax` fetches, so the lock is held for most of the 5 minutes while the process only waits:
prod 10 × 15 s (2026-11-07 to 11-09) and the defaults 5 × 40 s both come to ~3–4 min. The work that needs the lock
is seconds: claim, the error records, submit and poll (prod log 2026-11-08: tick at 17:48:47, batch submitted
17:48:49, the previous batch published 17:48:51, next tick 17:53:44).

What it costs:

- Hand runs wait on it: a manual `ai detect <native_id>` waits up to ~4 min, and `scripts/geo-subs-host.sh`
  (`wait_slot`) gets only 3.5 of every 10 minutes, so 85 geo-blocked videos took ~3–5 h instead of ~1.5 h.
- The slots go mostly to fetches that cannot succeed: in the two ticks above, 3 of 10 claimed videos reached
  the batch; the rest were "no ru subtitle track" (retried up to 3 attempts), "not available in your country"
  (`ai-detect-geo-blocked-videos.md`) and "unavailable because its creator has been blocked", which is as
  permanent as the geo error and retried the same way.

Options:

1. **Lock only the writes.** Take the lock around claim, the error records and submit / poll, not across the
   sleeps and yt-dlp. First check that a claimed row's `fetching` status alone keeps a second process off it.
2. **Shorter pause.** Nobody measured whether the platform needs 40 s between fetches from one host; the pause
   was a guess at politeness, and `hostFetches` already notices a refused host.
3. **Terminal permanent errors.** "creator has been blocked" (and geo, per its own item) fails at first sight,
   freeing the slot.

Unknown that settles it: whether throughput matters once the temporary values go back (a budget of ~250 a day
fills in about one tick in four at `BatchMax` 5), i.e. only if the budget is raised again or hand runs
(geo-blocked videos) become routine.
