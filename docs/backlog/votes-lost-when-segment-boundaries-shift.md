---
worth: later
where: calculator/calculate.go voteRatings
added: 2026-10-17
---
# votes stop counting when a recalculation moves a segment's boundaries

A vote matches a segment by exact `(video_id, category_id, start, end)` (`voteRatings` in the calculator, `lib/segment-rating.js`, `POST /vote`, the moderation and review repositories). A new or deleted markup in the same 3-second bucket changes the segment's averaged start or median end, so the next recalculation writes a segment with new bounds and its old votes match nothing: they stay in the votes table but count for no segment. In the 2026-10-15 dump that is 4 votes since 2026-05-11.

Considered and deferred: fuzzy matching (same category, vote start within the segment's 3-s bucket). A vote could then match two segments, and `POST /vote` matches exactly, so the two paths would disagree. Worth it only if boundary shifts start losing a noticeable share of votes.
