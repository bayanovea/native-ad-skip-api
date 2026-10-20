---
worth: later
added: 2026-10-20
---
# Drop the legacy `prv_review_batches.assignee` column

Since the first-come review locks (2026-10-20), `assignee` is out of the `ReviewBatch` model and `migrateBatchAssignees()` in `lib/schema.js` turns any non-NULL value into exclusions/locks and clears it on every boot. The column stays because a pre-2026-10-20 image inserts `(batch, assignee)` in `syncSchema()` and reads it in `batchProgress()`; without it that image exits in bootstrap and the whole API (extension backend included) is down after a rollback.

Why `later`: only once a rollback to a pre-2026-10-20 image is no longer needed. Then replace the one-off and the `ADD COLUMN IF NOT EXISTS assignee` with `ALTER TABLE prv_review_batches DROP COLUMN IF EXISTS assignee`, after the one-off has run on prod (every `assignee` NULL), and update the Schema bootstrap note and the `ReviewBatch` row in CLAUDE.md.

From the 2026-10-20 code review of branch `review-page-for-assessors`.
