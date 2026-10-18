# Duration-split analysis (2026-09-25)

> **Status 2026-10-19: ±2 s shipped.** `lib/duration-tolerance.js` is used by the read helper and the three repositories, with the closest row (then the oldest) chosen when a duration fits two rows. The one-time merge script in the appendix was **not run, by decision**: it is fragile and rewrites live rows, so the five pre-existing 2-s families stay split and only stop growing. Kept for reference; see `docs/backlog/video-rows-race-and-old-split-families.md`.

Production-data review of the duration-based video split behavior shipped on
2026-04-25 (`c5f0655`): when a submitted `duration` is outside the match
tolerance of every existing row for that `native_id`, a new `videos` row is
created ("split"). This research checked whether the change solved the
original inconsistent-duration problem and what causes the remaining splits.

## Method

SQL over the production prv database (2026-09-25): family detection via
`GROUP BY native_id HAVING COUNT(*) > 1`, weekly trend of extra-row creation,
duration-diff distribution, markup/vote activity per split row, per-user
attribution, and finally a segment-timestamp comparison across each pair.

## Findings

- **Scale:** 12 split families out of 6,258 native_ids (~0.2%), never more
  than 2 rows per family; a steady ~1 split per 1–2 weeks, no bursts. The
  global inconsistent-duration problem is gone.
- All 12 extra rows were created by real `POST /markup` submissions (every
  row has markups, none has votes-only or no activity). No orphans from the
  pre-2026-05-11 `GET /video-calculated` row-creation bug, and no
  creation-race artifacts (no 0–1s diffs).
- `duration_logs` has been dead since 2026-04-25 (write is commented out in
  `prv/routes/videos.js`); read-side visibility lives only in Prometheus
  (`video_calculated_lookup_total{outcome="mismatch"}`).
- 39% of `videos` rows (2,419) have `duration = NULL` (legacy clients).

### Classification of the 12 families

| Group | Families | Pattern | Cause | Verdict |
|---|---|---|---|---|
| A | 5 (all owner `-100000007`) | exactly 2s diff, both rows created same day, different users on each side, both active concurrently | duration metadata jitters ±2s for identical content | Harmful — same video, consensus fragmented across two rows |
| B | 4 | 135–312s diff, rows weeks/months apart, old row goes quiet | owner re-cut the video | Split working as intended |
| C | 2 | same user, same day, bogus **49s** duration vs real 205s / 14,918s | client reads duration of the wrong thing (pre-roll ad / pre-metadata player state?) | Client bug, minor impact |
| — | 1 | 56s vs 59s (3s diff), same user, same day | measurement jitter on a ~1min video | Left as is (outside the new ±2 tolerance) |

Group A proof of identical content: markup intervals on both rows of every
pair sit at **identical absolute timestamps** (e.g. `456000910`: `422–481`
exactly on both rows). A real start-trim would shift all timestamps by the
duration diff — it doesn't. Therefore the 2s diff is pure metadata noise and
merging needs no offset correction.

No user triggered more than one split — no single bad actor / broken install.

## Decisions

1. **Tolerance widened from ±1s to ±2s** (2026-09-25) in
   `lib/duration-tolerance.js`, used by `lib/find-video-for-read.js` and
   `{prv,rt,yt}/repository/video.js`. Covers all of Group A; cannot touch
   Group B (min real diff 135s).
2. **One-time merge** of families now within tolerance — script below (not run, see the status line).
3. Open item (low priority): find where the client reads duration — the
   repeated magic value `49` suggests it can capture an ad/preview duration.
4. Step "add logging" from the original plan: **not needed**, DB data was
   sufficient.

## Appendix: one-time merge script

Merges each 2-row family whose durations are both non-NULL and differ by ≤2s
into the row with more live markups. Repoints markups/votes/duration_logs,
flags markups `is_new = true` so the Go calculator rebuilds consensus (runs
within a minute), removes the duplicate row's calculated artifacts and the
row itself. The survivor keeps serving its old calculated data until the
rebuild. Review the `merge_plan` output before `COMMIT`.

```sql
BEGIN;

CREATE TEMP TABLE merge_plan ON COMMIT DROP AS
WITH fam AS (
  SELECT native_id
  FROM videos
  GROUP BY native_id
  HAVING COUNT(*) = 2
     AND COUNT(duration) = 2
     AND MAX(duration) - MIN(duration) <= 2
),
scored AS (
  SELECT v.native_id, v.id,
         (SELECT COUNT(*) FROM markups m
           WHERE m.video_id = v.id AND m.deleted_at IS NULL) AS markup_cnt
  FROM videos v JOIN fam USING (native_id)
)
SELECT native_id,
       (array_agg(id ORDER BY markup_cnt DESC, id))[1] AS survivor_id,
       (array_agg(id ORDER BY markup_cnt DESC, id))[2] AS duplicate_id
FROM scored
GROUP BY native_id;

-- Expected: the 5 Group A families. Abort (ROLLBACK) if anything else shows up.
SELECT * FROM merge_plan;

UPDATE markups m SET video_id = p.survivor_id
FROM merge_plan p WHERE m.video_id = p.duplicate_id;

UPDATE markups m SET is_new = true
FROM merge_plan p WHERE m.video_id = p.survivor_id AND m.deleted_at IS NULL;

UPDATE votes vt SET video_id = p.survivor_id
FROM merge_plan p WHERE vt.video_id = p.duplicate_id;

UPDATE duration_logs dl SET video_id = p.survivor_id
FROM merge_plan p WHERE dl.video_id = p.duplicate_id;

DELETE FROM prv_calculated_segment_markups csm
USING prv_calculated_segments cs, merge_plan p
WHERE csm.segment_id = cs.id AND cs.video_id = p.duplicate_id;

DELETE FROM prv_calculated_segments cs
USING merge_plan p WHERE cs.video_id = p.duplicate_id;

DELETE FROM video_calculateds vc
USING merge_plan p WHERE vc.video_id = p.duplicate_id;

DELETE FROM videos v USING merge_plan p WHERE v.id = p.duplicate_id;

COMMIT;
```
