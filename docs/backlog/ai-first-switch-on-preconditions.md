---
worth: yes
where: prv/routes/videos.js:27
added: 2026-10-28
---
# Before `AI_FIRST=on`: extension release, a blind sheet of served segments, the judge in the same deploy

**Priority: high** (owner, 2026-10-28). The switch itself is safe (kill switch, no data touched), but flipped today it
is a half-blind launch:

1. **CONFIRM — extension release with `duration` in `POST /vote`** (`~/Web/native-ad-skip-v2`). `v` and `views_text` on the GET are
   out (`feat/views-param`, released 2026-10-28). Before v2.2.3 the vote payload (`shared/api/types.ts` `SegmentVoteDto`) carried
   no `duration`, so on an AI-first video `prv/routes/votes.js:43` looks the segment up in `video_calculateds`: 404 on
   every vote on an AI segment (189 of the 203 ready videos have no human row at all), and the judge never sees
   `votes_down`, its main signal. Released in extension v2.2.3 (2026-10-28, `feat/vote-duration` merged); the API already accepts it.
   **Confirm** on prod after a few days of votes (~4/day): no 400 on `POST /vote` (`isInt` on `duration`, sent unrounded
   from the player). Nothing stores a vote's `duration`, so the status split is the only server-side trace.
2. **Blind sheet of ~50 served segments** (`data` entries of published rows). The 628 served segments have no verdict:
   only the hidden below-threshold ones were reviewed (`ai-below-threshold-verdicts.md`), and the held-out gate ran on
   10–60 min videos while the prod queue has streams. Timing is the open question: the drift audit
   (`~/Web/data/audit/drift.jsonl`) puts a > 2 s track shift on about 1 video in 5, the timeline gate refused 5 of 572,
   and 36 of 44 assessor-flagged videos carry `track_mismatch`. Tool: `import-below-threshold.js --served 50 --seed 1`
   (2026-10-28: one served entry per video, ai items `S<n>`, urgent, 1 reviewer; verdicts fix the rows before the flip).
   **WAIT — assessors**: imported on prod 2026-10-28 (50 of 287 serving rows) as `ai-served-2026-10-28-p1` / `-p2`
   (25 each). Then read precision and timing off `export-review-verdicts.sh ai-served-2026-10-28`.
3. **`AI_FIRST=on` and `AI_JUDGE_ENABLED=on` in one deploy** (repository Variables). With the judge off nothing withdraws
   a row on negative signals except the admin link on `/admin/video`. `AI_JUDGE_AUTO_WITHDRAW` stays at its default (on).

Done on prod (checked 2026-10-28): the hidden-entries Post-Completion, `ai regate --backfill` and `adopt-review-items.js
ai-below-threshold-2026-10-24`. All 80 items of that sheet are ai items, and adopt matches only entries in `hidden`, which
the rows published before 2026-10-27 get from the backfill alone (99 of 477 have them now).

Soft launch before the release (old clients that send `v`, votes on AI segments 404 until then): declined by the owner
on 2026-10-28; the flip waits for items 1 and 2.
