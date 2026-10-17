---
worth: yes
where: prv/routes/markups.js:89
added: 2026-10-17
---
# PUT /markups accepts end <= start and its transaction does nothing

`PUT /markups` checks `new_start` / `new_end` only as `isInt({ min: 0 })`. Nothing checks `new_start < new_end`, a single `new_start` or `new_end` against the stored other end, or an upper bound, so an edit can store `end <= start` or a huge `end`, which `POST /markup` rejects since `lib/validate-intervals.js` (2026-10-17).

Its `sequelize.transaction(async (transaction) => …)` passes no `{ transaction }` to the two `update` calls (and the project has no CLS), so they run outside it: the interval update and the `is_new = true` markup update are separate commits. Same code in `rt/routes/markups.js:74` and `yt/routes/markups.js:74`.

Fix: check the resulting `(start, end)` after merging the new values with the stored ones, with the same rules as `validateIntervals` (`0 <= start < end <= MAX_SECONDS`, 400 otherwise); pass `{ transaction }` to both updates.

Found while fixing `POST /markup` validation on 2026-10-17; `POST /admin/markups/edit` was not checked.
