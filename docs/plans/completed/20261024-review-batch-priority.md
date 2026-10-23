# Review batch priority

> **Status 2026-10-24: COMPLETED on `main`, not deployed.** One task. Deploy (push) is the owner's; existing prod batches become `important` on the first boot (column default).

## Overview

Assessors see one list and take the newest batch. With the judge sending items from prod (viewers behind them) next to optional corpus passes, the list needs an order the assessors do not have to think about (owner, 2026-10-24):

- **Срочно / Urgent** — the judge's batches: the video is served or withdrawn on prod right now.
- **Важно / Important** — the default: sheets that gate a decision (held-out, dev, misses).
- **По желанию / Optional** — passes to do when nothing else is open (`docs/backlog/corpus-review-pass-boost.md`).

## Solution

- `prv_review_batches.priority` (`VARCHAR(16) NOT NULL DEFAULT 'important'`, `lib/schema.js` ALTER, model field), values `PRIORITIES = ['urgent', 'important', 'optional']` in `prv/repository/review.js`. A pre-branch image keeps inserting (default), a rolled-back image ignores the column.
- `batchProgress()` selects it and orders by priority rank, then imported-at desc as before; JSON rows carry `priority`. The page keeps its sections (In work / Available / …) and shows a coloured label per row; within a section urgent batches come first.
- Importer: `--priority urgent|important|optional`; the existing-batch rule as for `--reviews` / `--exclude` (a different stored value fails, left out is not checked; a new part of a sheet inherits the first part's). `splitBatch()` copies it to the parts.
- Judge (`ai/judge/review.go`): new batches are inserted with `'urgent'`.

Not done on purpose: no priority on the item page or in the 409 messages (the list is where the choice is made); no re-prioritising on the page (the importer is the only writer besides the judge, `UPDATE` by hand otherwise).

## Tasks

- [x] column, model, repository (`PRIORITIES`, order, `createBatch` check), importer flag, judge insert, locale keys (`list_col_priority`, `priority_*`), list badge
- [x] tests: e2e importer (`--priority` stored, default, mismatch fails, bad value usage; JSON order urgent → important → optional and the Russian labels on the page), split keeps the priority, judge batch is `urgent`; sqlmock expectations in `ai/judge`
- [x] CLAUDE.md: importer, split, list route, `ReviewBatch`, judge items, Ops command
- [x] cleanup pass before commit (residue / transient state / open questions)
