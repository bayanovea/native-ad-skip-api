---
worth: yes
added: 2026-11-26
---
# A user segment and a served AI entry on the same ad with an edge more than 10 s apart: nobody checks which is right

Of the 460 overlapping pairs (a user sponsor / self_promotion segment × a served AI entry, 2026-11-25) 180 have an edge more than 10 s apart, and about 113 of those still overlap by IoU ≥ 0.5. Such a pair counts as agreement everywhere: the judge's `conflicting_markups` needs IoU < 0.5 (`ai/judge/signals.go` `conflicts`), and the change that sends uncovered user segments to assessors takes only segments the AI covers by less than half. The viewer gets the AI's edges; the user saw the video, the model only the subtitles.

Existing verdicts cannot tell whose edge is right: assessors set bounds on 1 of their 619 keep verdicts on ai items.

Approach (owner, 2026-11-26: a separate test, otherwise this stays a blind spot): a blind sample of such pairs as `S`-style ai items on the served entry, with the assessors asked to set the exact start and end on every item; then compare their bounds with the AI's, the user's and the mean of the two, per edge. The result decides whether the user's edges replace the AI's on such pairs (the owner's rule for adjacent segments: take the user's signal) and whether a dashboard panel should count them.
