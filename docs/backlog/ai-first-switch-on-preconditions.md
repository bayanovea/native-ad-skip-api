---
worth: yes
where: prv/routes/videos.js:27
added: 2026-10-28
---
# Before `AI_FIRST=on`: extension release, a blind sheet of served segments, the judge in the same deploy

**Priority: high** (owner, 2026-10-28). The switch itself is safe (kill switch, no data touched), but flipped today it
is a half-blind launch:

1. **Extension release** (`~/Web/native-ad-skip-v2`): the released 2.2.0 (`main`) sends no `v` on `GET /video-calculated`,
   so the request takes the legacy branch at `prv/routes/videos.js:27`, which serves `video_calculateds` only: v2 users
   never get an AI row. `feat/views-param` (2026-10-26) adds `v` (and `views_text`) and is not released. The vote
   payload (`shared/api/types.ts` `SegmentVoteDto`) carries no `duration`, so on an AI-first video `prv/routes/votes.js:43`
   looks the segment up in `video_calculateds`: 404 on every vote on an AI segment (189 of the 203 ready videos have no
   human row at all), and the judge never sees `votes_down`, its main signal. Needed in one release: `v` on the GET,
   `duration` in `POST /vote` (the API already accepts it). Related: `ai-views-from-clients.md` (same branch).
2. **Blind sheet of ~50 served segments** (`data` entries of published rows). The 628 served segments have no verdict:
   only the hidden below-threshold ones were reviewed (`ai-below-threshold-verdicts.md`), and the held-out gate ran on
   10–60 min videos while the prod queue has streams. Timing is the open question: the drift audit
   (`~/Web/data/audit/drift.jsonl`) puts a > 2 s track shift on about 1 video in 5, the timeline gate refused 5 of 572,
   and 36 of 44 assessor-flagged videos carry `track_mismatch`. Export the sheet from prod rows (`import-below-threshold.js`
   covers hidden entries only; served entries need a sheet of their own or an `--served` mode).
3. **`AI_FIRST=on` and `AI_JUDGE_ENABLED=on` in one deploy** (repository Variables). With the judge off nothing withdraws
   a row on negative signals except the admin link on `/admin/video`. `AI_JUDGE_AUTO_WITHDRAW` stays at its default (on).

Before the flip, the hidden-entries Post-Completion on prod (`ai regate --backfill`, then
`adopt-review-items.js ai-below-threshold-2026-10-24`; `docs/plans/completed/20261027-ai-hidden-entries.md`), so the judge
and the votes start on complete rows.

Alternative the owner can still take: a soft launch now on the old clients that do send `v`, accepting the 404 on votes
until the release.
