---
worth: later
added: 2026-11-26
---
# Whether assessors go through the whole queue of user ad segments the AI row does not serve

On 2026-11-25 the AI-served videos held 167 user sponsor / self_promotion segments (`prv_calculated_segments`, best author rating ≥ 0) that the served AI entries cover by less than half, on 113 videos; 146 of them come from markups made before the AI row was published, about 2 new ones arrive a day. The `ai users` pass (change `ai-user-segments`, switch `AI_USER_SEGMENTS_ENABLED`, see ai-first.md → User segments) once switched on, serves or sends to an assessor every ad segment with a markup made or edited since `AI_USER_SEGMENTS_SINCE` (urgent `U<n>` items in `ai-user-<date>`); the segments of older markups, this queue, stay out: none of them is served, and the judge's LLM answers `ok` on a markup that only adds an ad.

Owner, 2026-11-26: not the whole queue. First a blind test on the 30 freshest (sheet `sample-2026-11-26`, kind `sheet`, so a verdict serves nothing; 9 of the 30 touch a served AI entry, 11 lie over a hidden one, 11 start at 0:00, four are 7 to 19 minutes long).

Unknown that settles it: the share of the 30 that assessors keep, and how far their bounds are from the user's. Mostly kept with the user's bounds: let the rest in by moving `AI_USER_SEGMENTS_SINCE` back (the pass then shows, glues or holds each, a `U` item for all but the glued: up to the 167 of the 2026-11-25 count at once), and adopt the sheet's keeps so they serve (a sheet item's verdict serves nothing, and the pass only closes a segment on a `not_ad` / `unclear` of any item, not on a sheet keep). Mostly `not_ad` or re-cut: leave the old queue, handle only new markups. The sheet's keeps are user bounds, not eval gold: do not run the audit's `eval_import` suggestion on it.
