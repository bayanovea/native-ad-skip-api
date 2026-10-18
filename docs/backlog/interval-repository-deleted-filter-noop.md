---
worth: later
where: prv/repository/markup-time-interval.js:14
added: 2026-10-17
---
# markupTimeIntervalRepository never filters soft-deleted intervals

`_updateOptionsByDeleted` sets `options.deleted_at = null` instead of `options.where.deleted_at = null`, so `findOne` / `findAll` return soft-deleted intervals too (Sequelize ignores the top-level key). Same in rt/yt. No effect today: intervals are only soft-deleted together with their markup (`softDeleteByIds`), and every caller (`updateRatingByVote`, `PUT /markups`, the hard delete of a video's markups) first restricts to live markups. It bites as soon as something soft-deletes a single interval.

The same review found routes whose `sequelize.transaction` callback never passed `transaction` to its writes; `PUT /markups` was fixed and `POST /admin/markups/edit` removed on 2026-10-18.

Fix: set the filter on `options.where` (prv, rt, yt).

Found while threading a transaction through `updateRatingByVote` on 2026-10-17.
