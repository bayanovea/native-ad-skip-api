---
worth: yes
where: the extension repo (ui/components/modals/views/segments-editor/use-segment-draft.ts, shared/api/video.ts fetchCalculatedSegments)
added: 2026-11-25
---
# The extension loses the user's own markup on a video that serves AI segments

After `POST /markup` the extension adds the new segment to the player locally (`videoService.addSegment`), so the user sees it until the page reloads. On the next `GET /video-calculated` a video with a served AI row answered with the AI entries only (see ai-first.md → Serving), the user's segment was gone, and users report "the markup is not added" and post it again: 2026-11-25, one user sent the same sponsor interval four times in nine minutes; same-user repeats are 5 of 85 interval groups on AI-served videos against 2 of 153 on the others (30 days). 35 of the 105 markups of the last 10 days sit on such videos.

The server side is the `ai users` pass (change `ai-user-segments`, switch `AI_USER_SEGMENTS_ENABLED`, see ai-first.md → User segments): within a minute or two a new ad segment on such a video is shown (`source: "user"`, an urgent `U<n>` item in `ai-user-<date>`), glued to the AI entry (at most `AI_USER_GLUE_SECONDS`) or held for an assessor (`data` unchanged, a `U` item). The author still loses the segment on a reload in the gap before the next tick, while a held segment waits for its verdict (hours to days), after a `not_ad` / `unclear`, for markups older than `AI_USER_SEGMENTS_SINCE`, and when the AI entries cover half of it or more (the AI's edges stay).

Approach: the extension keeps the segments this user created (per video id: category, start, end, created at) in its own storage and merges them into what `fetchCalculatedSegments` returns for that video, for this user only. A stored segment is dropped once the response has a segment of the same category covering it (IoU ≥ 0.5: the server serves it now) or after a retention period. To settle in the client: the storage (extension storage vs. per-profile sync), the retention, how an own segment looks in the list (a "yours, not confirmed yet" mark) and whether the user can delete it there (`DELETE /markup` needs the markup id, which `POST /markup` would have to return).

No API change is needed for the minimum. Do it right after the `ai users` pass is switched on; an extension release.
