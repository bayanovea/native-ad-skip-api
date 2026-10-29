# Proposal

From backlog item `docs/backlog/ai-merge-fragmented-entries-and-admin-review-link.md` (owner, 2026-10-29, priority high). Unblocks `docs/backlog/ai-owner-verdict-merge-video-100000005.md`.

## Why

The detector splits one ad into several served pieces (video `-1_456000905`: three sponsor entries 20:37–21:34 that are one ad 20:37–21:37). The segments are correct but fragmented, and there is no clean path to record the merge: a keep verdict with bounds covering the neighbours is refused with `bounds_overlap`, and the entry's only review item sits in a batch finished by another reviewer, so the owner cannot decide it at all. Fixing it by SQL was rejected because the verdict trail (judge baseline, precision export) lives in the verdict rows.

## What Changes

- **Absorb on keep.** A keep verdict whose bounds cover other served entries of the same category entirely replaces them all with one entry at those bounds (`source: review`, rating from the votes on the new bounds). A partial overlap, or a covered entry of another category, stays a `bounds_overlap` error. The review page warns before the save how many served segments the bounds will absorb.
- **"Send to review" per entry on `/admin/video/:video_id`.** A confirm button on every entry of the AI block (served and hidden) creates one ai review item on that entry in today's `urgent` batch `ai-admin-<YYYY-MM-DD>`, placed the way the judge places its items (newest part nobody holds or has started, within 30 items). An entry that already has an open item is refused and the existing item named. Same auth as the withdraw link.
- The AI block marks each entry that has an open review item (batch and code), so the operator sees what is already in review.
- Docs: CLAUDE.md (verdict application, admin routes, ReviewItem codes), the AI-first overview pages (ru/en, assessor section: a verdict can merge segments) and their artifacts.

## Capabilities

### New Capabilities
- `ai-verdict-application`: how an assessor's verdict on an ai review item changes the AI row's served and hidden entries. This change specs the absorb rule; the rest of today's behaviour is in CLAUDE.md and comes into the spec when it next changes.
- `admin-ai-review-request`: the operator's way to put an AI entry in front of an assessor from the admin video page.

### Modified Capabilities
(none; `ai-detect-queue` is untouched)

## Impact

- `prv/repository/ai.js` (`applyVerdict`), `prv/repository/review.js` (batch placement twin of the judge's `reviewBatch`, open-item lookup), `prv/routes/admin.js` (AI block, new GET route), `prv/routes/admin-review.js` + `prv/locales/review/{ru,en}.json` (served entries in the item payload, absorb warning), `lib/` (player link and cue-overlap helpers moved out of `scripts/import-below-threshold.js`), `server.js` (`normalizePath` rule for the new route), `test/e2e.js`, `test/i18n.test.js` (parity, automatic).
- Behaviour: absorbed entries' votes are lost (bounds-keyed, the accepted trade-off of `docs/backlog/votes-lost-when-segment-boundaries-shift.md`; 0 votes on AI entries today) and their review items become history (their effective bounds find no entry).
- No schema change, no new env, no switch: both paths are reached only by an assessor's or the operator's action.

## Out of scope

- Merging by hand on the video the owner looked at (done after this lands, per its backlog item).
- Splitting an entry, or merging entries of different categories.
- A cookie login for the admin pages (`docs/backlog/admin-token-in-url.md` still applies to the new link).
- Showing the absorb warning for a partial overlap (the server's 400 stays the answer).
- The judge creating or reading `ai-admin-*` batches differently from any other batch.
