---
worth: later
where: prv/repository/video.js:5
added: 2026-10-16
---
# videos rows: find-then-create race, and the old 2-s split families

Two leftovers of the duration split (±2 s tolerance shipped 2026-10-19, `lib/duration-tolerance.js`):

1. **Race.** `findByNativeIdAndDuration` (same in `rt/`, `yt/`) is find-then-create with no unique constraint on `videos.native_id`, so two first `POST /markup` for a new video at the same moment can both create a row. The 2026-09-25 analysis found no such pair (no 0–1 s diffs in prod), so it is theoretical today.
2. **Old families.** The 5 pre-existing 2-s split pairs stay split by decision of 2026-10-19: the merge script rewrites live rows and was judged fragile for the gain. New markups no longer create rows for them (the closest row wins), but their consensus stays divided between the two rows. The script is kept in the appendix of `docs/research/20260925-duration-split-analysis.md`; `prv/repository/moderation.js` keeps its CTE workaround.

Settles it: merge a family when its split visibly hurts consensus; fix the race when a 0–1 s duplicate shows up in a dump.

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16; narrowed 2026-10-19.
