---
worth: later
where: calculator/calculate.go (insertVideoCalculated)
added: 2026-10-17
---
# video_calculateds has a duplicate row and a null-data row from 2024

`video_calculateds.video_id` has no unique constraint. On prod (checked 2026-10-17) video 827 (`-1_456000908`) has two rows (ids 5728 and 5734, both written 2024-04-03, before the calculator used one transaction per video), and video 91 (`-1_456000909`) has `data = null`. The Node side reads one row with `findOne`, so for video 827 a vote may rewrite one row while `GET /video-calculated` serves the other; `--recompute-ratings` handles every row (6332 rows, 6331 videos), so both carry the same ratings today. POST /vote answers 404 for video 91 since 2026-10-17 (before: 500).

Both heal on the next recalculation of the video (the calculator deletes every row of the video and inserts one), which happens when a new markup arrives; a manual `calculate <videos.id>` would also do it but may move the segment boundaries computed in 2024 and orphan their votes.

Fix: delete the older duplicate (id 5728) and the null row (or recalc both videos), then add a unique index on `video_calculateds(video_id)` (and rt_/yt_) in `lib/schema.js`.
