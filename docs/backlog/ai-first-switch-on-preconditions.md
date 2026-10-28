---
worth: yes
where: prv/routes/videos.js:27
added: 2026-10-28
---
# Before `AI_FIRST=on`: extension release, a blind sheet of served segments, the judge in the same deploy

**Priority: high** (owner, 2026-10-28). The switch itself is safe (kill switch, no data touched), but flipped today it
is a half-blind launch:

1. **DONE 2026-10-28 — extension release with `duration` in `POST /vote`** (`~/Web/native-ad-skip-v2` v2.2.3, `feat/vote-duration`).
   Without it a vote on an AI segment looked the segment up in `video_calculateds` (404) and the judge never saw
   `votes_down`. Closed by the owner on code and metrics, not on v2.2.3 votes seen: the vote sends the same raw
   `st.playback.duration` that `GET /video-calculated` has sent since 2026-04-17 (`core/segments/segments-loader.ts`),
   both checked by `isInt`, and the GET had no 400 in 24 h, so prv durations are whole seconds; `POST /vote` 11 in 72 h,
   all 204. If 400s on `POST /vote` ever show up, the vote path is the first suspect.
2. **Blind sheet of ~50 served segments** (`data` entries of published rows). The 628 served segments have no verdict:
   only the hidden below-threshold ones were reviewed (`ai-below-threshold-verdicts.md`), and the held-out gate ran on
   10–60 min videos while the prod queue has streams. Timing is the open question: the drift audit
   (`~/Web/data/audit/drift.jsonl`) puts a > 2 s track shift on about 1 video in 5, the timeline gate refused 5 of 572,
   and 36 of 44 assessor-flagged videos carry `track_mismatch`. Tool: `import-below-threshold.js --served 50 --seed 1`
   (2026-10-28: one served entry per video, ai items `S<n>`, urgent, 1 reviewer; verdicts fix the rows before the flip).
   **DONE 2026-10-28**: imported on prod (50 of 287 serving rows) as `ai-served-2026-10-28-p1` / `-p2` (25 each), all
   50 decided by one assessor (Gam): 50 of 50 confirmed with the proposed category (20 sponsor, 30 self_promotion),
   no bounds corrected, no `track_mismatch`, no comments. Precision 50/50 (95 % lower bound ~94 %, rule of three).
   Timing is weaker evidence: a median 24 s per item and not one bounds correction, so read it as "no visibly wrong
   cut" rather than measured. Detail and eval TSV in `~/Web/data/review/ai-served-2026-10-28.{detail,verdicts}.tsv`.
3. **`AI_FIRST=on` and `AI_JUDGE_ENABLED=on` in one deploy** (repository Variables). With the judge off nothing withdraws
   a row on negative signals except the admin link on `/admin/video`. `AI_JUDGE_AUTO_WITHDRAW` stays at its default (on).

Done on prod (checked 2026-10-28): the hidden-entries Post-Completion, `ai regate --backfill` and `adopt-review-items.js
ai-below-threshold-2026-10-24`. All 80 items of that sheet are ai items, and adopt matches only entries in `hidden`, which
the rows published before 2026-10-27 get from the backfill alone (99 of 477 have them now).

Soft launch before the release (old clients that send `v`, votes on AI segments 404 until then): declined by the owner
on 2026-10-28; items 1 and 2 done 2026-10-28; item 3 is the flip.
