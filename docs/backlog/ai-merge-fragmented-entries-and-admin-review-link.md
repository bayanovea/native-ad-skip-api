---
worth: yes
where: prv/repository/ai.js (applyVerdict, bounds_overlap), prv/routes/admin.js (AI block)
added: 2026-10-29
---
# Merge fragmented AI segments by a keep verdict; send an entry to review from /admin/video

**Priority: high** (owner, 2026-10-29, first evening of `AI_FIRST=on`). Owner's look at three AI-only videos:
all three correct, the one flaw is fragmentation. `-1_456000905` (videos.id 104583) serves four sponsor
pieces 20:37–20:45, 20:58–21:15, 21:26–21:34, 22:24–22:58; the first three are one ad, 20:37–21:37, and the owner
wants to record that as his own markup. Today no clean path:

1. The entry's item is `S39` in `ai-served-2026-10-28-p2`, finished by Gam with `reviews_needed = 1`, so for
   `bayanovea` the batch is `closed` (only `mine` / `done` may decide). Only Gam can touch it.
2. Even her keep with bounds 20:37–21:37 gets 400 `bounds_overlap`: the neighbours are served entries and
   `applyVerdict` refuses to cover another `data` entry (`prv/repository/ai.js`, the `others.data.some(...)` check).

Doing it by SQL outside the admin was rejected: no verdict row (the judge's baseline and the precision export
live there), and `S39`'s effective bounds would point at no entry.

## Changes

1. **Absorb on keep** (`applyVerdict`): a keep with bounds that cover other `data` entries of the *same category*
   entirely (each `to.start ≤ e.start && e.end ≤ to.end`) drops them from `data` instead of a 400; a partial overlap or
   another category stays `bounds_overlap`. The absorbed entries' votes are lost (bounds-keyed, the trade-off of
   `votes-lost-when-segment-boundaries-shift.md`; 0 votes on AI entries at the time of writing) and their items,
   if any, become history (their effective bounds find no entry, so a later verdict on them is a no-op; the judge's
   `entryKeeps` sees nothing). The review page warns before save: "covers N other segments" (needs the row's
   entries in the item JSON or a dry-run endpoint). e2e: three entries → one keep with covering bounds → one
   served entry with `source: review`, rating from the votes on the new bounds, `hidden` untouched.
2. **"Send to review" link per entry on `/admin/video/:video_id`'s AI block** (the operator's way to get an item on
   any entry he saw): creates one `kind = 'ai'` item on that entry in an `urgent` batch `ai-admin-<YYYY-MM-DD>`
   (parts as the judge's: newest part nobody holds or has a verdict in, within 30; same INSERTs as
   `insertItems` / `createBatch`; `flagged_by` `["admin: sent to review", …]`), skipped when the entry already has an
   item without a verdict (the judge's rule). Same auth as the withdraw link (`?verifyBearerToken=`, GET from a
   confirm button, `admin-token-in-url.md` applies). Then the owner takes the batch as `bayanovea` on `/admin/review`
   and sets the bounds there, and the merge is a normal verdict with a trail.

Both together ≈ half a day with e2e. Deferred by the owner past the first day of AI-first (watch the signals first);
until then the video serves three pieces, which is correct, only fragmented.

Side note from the same look: on `-212544792_456239490` the segments read ~1 s wider than the cut on each side,
which the owner finds right (the viewer understands why it skipped). Inward rounding to whole seconds plus the
boundary rule (lead-in is part of the ad) is the cause; no change wanted.
