---
worth: later
where: calculator/calculate.go:222
added: 2026-10-17
---
# Invalid markup intervals already stored stay in the DB

`POST /markup` validates intervals since 2026-10-17, but rows written before stay. The 2026-10-16 check of the 2026-10-15 dump found 4 markups with no intervals and 1 interval with `end <= start`.

`NaN` intervals: before the validator, an interval with a missing `start`/`end` was not a 500, as the review assumed: `Math.round(undefined)` is `NaN` and the request got 201 (seen in the e2e suite on the old code). The 2026-10-15 dump has none (checked 2026-10-17: 0 `NaN`/infinite values, 0 rows with `start < 0` or `end > 86400`, 1 live interval with `end <= start`), so what is left is that one interval and the 4 interval-less markups, which add nothing to the consensus.

Fix: soft-delete the one `end <= start` interval's markup on prod (and mark the video's other markups `is_new = true`), or drop this item; re-check on a fresh dump first.
