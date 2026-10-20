# Review batches of at most 30 items

## Overview

A batch is now locked on one assessor until they finish it, so a 104-item batch blocks the sheet for days and is hard to hand over. Batches get a size limit: **at most 30 items** (owner, 2026-10-20).

- **New imports**: a sheet with more than 30 items is imported as several batches `<sheet>-p1`, `<sheet>-p2`, …
- **Existing batches on prod** (`2026-10-19-heldout-a` 104, `-b` 74): a script splits a batch the same way. Verdicts stay where they are (they reference items, not batches).
- **The sheet stays the unit for files**: re-importing the md and exporting verdicts work per sheet, so `~/Web/data/review/<sheet>.*` and the eval repo do not change.

## Context (from discovery)

- `prv_review_items.batch` is today both "the sheet the item came from" and "the unit of work"; unique `(batch, item_code)`.
- Sheets are shuffled (blind order): in `heldout-a` 104 items of 53 videos form 101 runs, so cutting at video boundaries means nothing. One video can sit in two parts; the track flag is per video anyway and shows on every item.
- Importer: `scripts/import-review-sheet.js` (`createBatch`, `insertItems`, `itemsInBatch`, identity check, md verdicts, `lockBatchRow` / `lockIfAvailable` / `releaseIfFinished` per batch).
- Export: `scripts/export-review-verdicts.{sh,sql}` filter `i.batch = :'batch'`.

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task)
- every task includes new/updated tests; `make test-unit` and `make test-e2e` pass before the next task

## Solution Overview

- New column `prv_review_items.sheet` (sheet name), unique `(COALESCE(sheet, batch), item_code)`; `batch` = the part the item belongs to. Nullable, no backfill: a pre-branch image inserts items without `sheet`, so reads use `COALESCE(sheet, batch)`; the `(batch, item_code)` index stays for that image's `ON CONFLICT`, and the expression index makes its insert of a split sheet's code fail instead of duplicating it.
- **Part sizes are balanced**: `n` items → `ceil(n / 30)` parts of near-equal size in `position` order (104 → 26/26/26/26, not 30/30/30/14). A sheet of ≤ 30 items keeps the plain name (no `-p1`), so small sheets look as before.
- Every part gets its own `prv_review_batches` row with the sheet's `reviews_needed` / `excluded`.
- **Re-import of a sheet** finds its items by `(sheet, item_code)` wherever they live; new items go to a new part (never into a part someone holds). md verdicts are written per part with the existing per-batch rules (excluded / held by another reviewer → refuse; lock-on-reviewer / release-if-finished per part).
- **Split script** `scripts/split-review-batch.js <batch> [--max-items 30]`: one transaction, moves items to `<batch>-pN`, copies the batch row settings, deletes the old row. Refuses a locked batch (release it on the page first) and a batch already within the limit. Holder's progress survives: a reviewer who had verdicts in the old batch can come back to each part under the come-back rule.
- **Export** takes a sheet name (or a single part name) and writes the same file as before.

Why a `sheet` column and not a name pattern (`<sheet>-pN` parsed back): a sheet name may itself end in `-p2`; the column is explicit and lets the DB enforce code uniqueness per sheet.

## Implementation Steps

### Task 1: Sheet column and import into parts

**Files:**
- Modify: `prv/db/index.js`, `lib/schema.js`, `prv/repository/review.js`, `scripts/import-review-sheet.js`, `test/e2e.js`

- [x] `sheet` column + backfill + unique `(sheet, item_code)` in `lib/schema.js` (idempotent, rollback-safe: an older image ignores the column — check its INSERTs still work, `sheet` must then default to `batch` or be filled by a trigger-free rule; pick the simplest that keeps main's importer working)
- [x] repository: `itemsInSheet(sheet)`, `insertItems` writes `sheet`; part naming and balanced split as a small pure helper (unit-tested)
- [x] importer: `--max-items N` (default 30); sheet > N → parts; re-import matches by `(sheet, item_code)`; new items → a new part; md verdicts and locks per part
- [x] tests: unit for the split helper (sizes, names, ≤ N keeps the name); e2e import of a 70-item fixture → 3 parts of 24/23/23, re-import idempotent, md verdicts land in the right parts with per-part lock/release, refusal rules still per part

### Task 2: Split script and export per sheet

**Files:**
- Create: `scripts/split-review-batch.js`
- Modify: `scripts/export-review-verdicts.sh`, `scripts/export-review-verdicts.sql`, `test/e2e.js`, `test/review-export.test.js`, `Makefile` if needed

- [x] split script with the rules above; prints the parts and their sizes
- [x] export: `<sheet|batch> [reviewer]` → items where `sheet = name OR batch = name`; output file name unchanged
- [x] tests: split a 64-item batch with verdicts from two reviewers → 3 parts, verdicts and per-part states correct, locked batch refused, ≤ 30 refused, idempotent second run refused cleanly; export of a split sheet equals the export before the split

### Task 3: Docs

- [ ] CLAUDE.md: models table (`sheet`), Importer paragraph, Ops block (split command in the full prod form: tunnel, `read -s`, env, `unset`), export usage
- [ ] move this plan to `docs/plans/completed/`; cleanup pass (residue / transient state / open questions)

## Post-Completion

- On prod after deploy: release `2026-10-19-heldout-a` / `-b` on the page if they are locked, then run the split script for each (command in CLAUDE.md, Ops).
