---
worth: yes
where: prv/repository/markup.js:51
added: 2026-10-16
---
# POST /admin/markups/edit reads video_calculateds.meta, which is always NULL

`getIdsBySegmentData` maps a segment to markup ids through `videoCalculated.meta.segments[i]`. The calculator stopped writing `meta` (commit 6aa6cbf); in the 2026-10-15 dump `meta` is NULL in all 6324 `video_calculateds` rows, so the endpoint (`prv/routes/markups.js:140`) throws → 500 for every video. Nobody has reported it, so it is probably unused. rt/yt repositories have the same copy.

Fix: either delete the endpoint and `getIdsBySegmentData` (likely, since nothing calls it), or rewrite it on `prv_calculated_segments` + `prv_calculated_segment_markups` as the moderation repository does. Either way drop the `meta` model field (`prv/db/index.js:38`, rt, yt) and the column.

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
