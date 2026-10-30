---
worth: later
where: ai/pipeline/detect.go:427
added: 2026-10-30
---
# Duration-gate refusals grow faster than detector throughput

`ai detect` sets `timeline_unreliable` when yt-dlp's duration is more than 2 s off every `videos` row of
the native_id. ai-dashboard-check counts ("длительность yt-dlp не совпадает с плеерами"):

| at (UTC)         | refused | through model |
|------------------|---------|---------------|
| 2026-10-28 16:32 | 4       | 824           |
| 2026-10-29 05:24 | 9       | 921           |
| 2026-10-29 17:15 | 16      | 1022          |
| 2026-10-30 16:28 | 31      | 1222          |

So 15 of the last 200 runs were refused, 7.5 %, against 0.5 % before 2026-10-28. That is when the views
trigger started bringing in popular videos. The human path still serves them, but none gets AI segments.

Unknown that decides the worth: are these real re-cuts (the platform serves yt-dlp another cut than the
players saw; the gate is right and nothing is to be done), or wrong player durations (the extension's
`duration` on these videos is off, e.g. counted with a pre-roll, so the gate drops good videos)? Check:
for the refused rows, compare the `videos` rows' durations and their `DurationLog` claims with yt-dlp's
value from the reason text. A constant offset across videos means a client bug, scattered offsets mean
re-cuts.
