# Review page for external assessors

## Overview

Open `/admin/review` to real assessors who know nothing about the project.

- **Self-service reviewers**: the picker gets a "Create reviewer" form (a name only); the new name shows in the list from then on.
- **First come, not assigned**: batches are no longer assigned to a person. Whoever takes a batch first reviews it. A batch that needs a second review goes back to everyone **except** the reviewers who already worked on it.
- **One holder per batch**: clicking a batch opens it read-only with a "Take it" button. Taking it locks the batch on that reviewer until they finish it or give it up, so two people never mark the same batch at once.
- **gkshi batches** (`2026-10-18-overlap-*`): go to anyone except `bayanovea` (they are blind copies of `bayanovea`'s sheets).
- **Onboarding**: a collapsed block on the batch list and the item page that explains the task, verdicts, the track flag, the player window, the −2 s start, hotkeys, the take/finish/give-up flow and "feedback goes to the shared chat".
- **i18n**: Russian by default, English switch; all page text comes from locale files. Assessors are Russian speakers; English keeps the repo readable for an outside reader.

Decided with the owner (2026-10-20): the shared `AUTH_TOKEN` stays (no separate review token); a second reviewer sees earlier verdicts, history and `flagged_by` as today (not blind); the Signals panel stays as is.

## Context (from discovery)

- `prv/routes/admin-review.js` (685 lines): server-rendered HTML + inline JS, `?reviewer=` carried in every link, `POST /admin/review/decide`.
- `prv/repository/review.js`: `IS_DECIDED` = any verdict by anyone; `batchProgress()` filters by `prv_review_batches.assignee`; `createBatch(batch, assignee)`.
- `prv/db/index.js:173-184`: `ReviewReviewer (code)`, `ReviewBatch (batch, assignee, created_at)`.
- `lib/schema.js`: idempotent ALTERs and one-offs run on every boot (no migrations folder); `REVIEWERS` seed.
- `scripts/import-review-sheet.js`: `--assignee CODE`, `--reviewer CODE`.
- `scripts/export-review-verdicts.sql`: latest verdict per item across all reviewers.
- Tests: `test/e2e.js` (review section ~2900–3700, uses `assignee` in progress rows and importer tests), `make test-unit` for DB-free tests. No cookie parser in the app.

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task), as in the earlier review plans
- complete each task fully before moving to the next; small, focused changes
- **every task includes new/updated tests**; all tests pass before the next task
- update this plan when scope changes
- unit: `make test-unit`; e2e: `make test-e2e`

## Testing Strategy

- **unit** (`node:test`, DB-free): i18n lookup and interpolation, ru/en key parity, reviewer-name validation
- **e2e** (`test/e2e.js`): create reviewer, take / give up / finish, lock conflicts (409), availability rules (second review, exclusions), per-reviewer progress and navigation, the schema one-off, importer flags, export reviewer filter, `?lang=` cookie

## Solution Overview

State lives on the batch row; "who has worked on it" is derived from verdicts.

| Column on `prv_review_batches` | Meaning |
|---|---|
| `reviews_needed INT NOT NULL DEFAULT 1` | how many reviewers must finish the batch |
| `excluded TEXT[] NOT NULL DEFAULT '{}'` | reviewers who may never take it (reviewed the same items elsewhere) |
| `locked_by VARCHAR(64) NULL`, `locked_at TIMESTAMP NULL` | current holder |
| ~~`assignee`~~ | dropped by the one-off below |

Derived, per batch: `workers` = distinct reviewers with a verdict on any item; `finished` = reviewers with a verdict on **every** item.

**Batch states for reviewer R:**

- *mine, in work*: `locked_by = R`.
- *available*: `locked_by IS NULL`, R ∉ `excluded`, and either R ∈ `workers` and R ∉ `finished` (R gave it up halfway and comes back), or R ∉ `workers` and `|finished| < reviews_needed`.
- *locked by someone else*: `locked_by` set to another reviewer.
- *done by me*: R ∈ `finished`.
- otherwise not shown in R's list (`show=all` shows everything with its state).

**Take**: `UPDATE … SET locked_by = R, locked_at = now() WHERE batch = :b AND locked_by IS NULL` plus the availability check in the same statement; 0 rows → 409. This is the race guard for "first come".
**Finish**: the decide route clears the lock when R has a verdict on every item.
**Give up**: holder clears the lock; verdicts stay. **Force release** of someone else's lock: same button with a confirm dialog naming the holder (small trusted group, everyone has the admin token anyway; covers an assessor who disappeared).
**Decide** is allowed only for the holder, or for R ∈ `finished` (fixing their own finished batch); otherwise 409 with the reason.

**Per-reviewer progress**: `decided` / `open` and navigation (`first open`, save → next open, default item) count R's verdicts, so a second reviewer starts at C1. The verdict buttons pre-select R's own latest verdict; the "Current verdict" block and history still show everyone's (owner decision, not blind).

**Why not a claims table** (`prv_review_claims` with claimed/finished/released rows): a full history of takes, but it needs a backfill from verdicts and a second source of truth for "finished"; nobody asked for take history.

**i18n**: `prv/locales/review/ru.json` and `en.json` (flat `key → string`, `{name}` placeholders), loaded by `lib/i18n.js` (`translator(lang)` → `t(key, params)`; missing key throws in tests, falls back to ru at runtime). Language: `?lang=ru|en` sets cookie `review_lang` (1 year, path `/admin/review`); otherwise the cookie; otherwise `ru`. A switch link in the toolbar. Client-side strings go to the inline script as part of `STATE`. Only keys ending in `_html` may contain markup (repo-owned files; everything else is escaped). Verdict *values* stay English identifiers in the DB and the API; only labels are translated.

## Technical Details

**Reviewer creation** — `POST /admin/review/reviewers?verifyBearerToken=…`, form or JSON body `{name}`. Trimmed, 1–64 chars, letters (any script), digits, space, `.`, `_`, `-`; the name is the code (it already is for `bayanovea`/`gkshi`). Case-insensitive duplicate → 400 "name taken". HTML form: 303 to the batch list for the new reviewer. JSON: `201 {code}`.

**New endpoints** — `POST /admin/review/:batch/take`, `POST /admin/review/:batch/release` (body `{reviewer, force?: boolean}`), JSON `{batch, locked_by, locked_at}`; 409 with a translated reason on conflict; `/admin/review/take|release` paths added to `normalizePath` in `server.js`.

**JSON shapes** — batch rows become `{batch, total, decided, open, reviews_needed, finished: [codes], locked_by, locked_at, state}` (`decided`/`open` for the requesting reviewer; `state` ∈ `mine | available | locked | done | closed`). `assignee` disappears from all JSON.

**Schema one-off** (in `lib/schema.js`, guarded by "column `assignee` still exists", so it runs once):
1. ADD the new columns.
2. `assignee = 'gkshi'` → `excluded = '{bayanovea}'`, `reviews_needed = 1`; `locked_by = 'gkshi'` only if gkshi already has verdicts there and has not finished.
3. Any other assignee X with unfinished work (X ∉ `finished`) → `locked_by = X` (keeps X's in-progress batches with X). Finished batches need nothing.
4. DROP `assignee`.

**Importer** — `--assignee` removed (fails with a hint). New: `--reviews N` (default 1), `--exclude CODE[,CODE]` (for subset sheets of an already reviewed sheet). `--reviewer CODE` md verdicts work as now; when they leave the batch unfinished for that reviewer, the importer locks it on them. Existing batch + different `--reviews`/`--exclude` → fails (same "never silently re-route" rule as before).

**Export** — `export-review-verdicts.sh <batch> [reviewer]`: with a reviewer, only that reviewer's latest verdict per item and output `<batch>.<reviewer>.verdicts.tsv`; without one, unchanged.

**Onboarding** (`<details>`, closed by default; same text on both pages; `_html` locale keys), sections:
1. What this is: prv video skips ads; a detector found subtitle pieces that may be ads; you check what the *text* is. Your verdicts are the ground truth for measuring the detector.
2. Workflow: pick your name (or create it) → open a batch → "Take it" → go item by item → the batch finishes itself on the last verdict; "Give up" if you stop.
3. Verdicts with one example each, the "who paid" test, `unclear` only when the text does not decide.
4. Track flag: player shows other words or the same words shifted → tick it; it is about the whole video, the verdict still judges the text.
5. Player window: "Open in player" (`o`) opens prv in a new tab; switching items swaps tabs (the next item opens in front, the old tab becomes its player); start from the batch list, otherwise the browser will not let the page close old player tabs.
6. Timing: the player starts 2 s before the piece on purpose; times are `m:ss`.
7. Hotkeys table (works on a Russian layout).
8. Comments: write why when unsure; questions, bugs and ideas → the shared chat.

## Implementation Steps

### Task 1: Locale files and translator

**Files:**
- Create: `lib/i18n.js`, `prv/locales/review/ru.json`, `prv/locales/review/en.json`, `test/i18n.test.js`
- Modify: `Makefile` (add the test to `test-unit`)

- [x] `lib/i18n.js`: load both files once, `translator(lang)` with `{name}` interpolation, `pickLang(req)` (query → cookie header → `ru`)
- [x] seed locale files with the keys the next tasks need (start with toolbar/picker strings)
- [x] unit tests: interpolation, unknown lang → ru, missing key, ru/en key parity, `_html` rule
- [x] `make test-unit` passes

### Task 2: Translate the existing pages

**Files:**
- Modify: `prv/routes/admin-review.js`, locale files, `test/e2e.js`

- [x] every visible string (picker, batch list, item page, rules card, hotkeys line, client-side status texts) through `t()`; `<html lang>` follows the language
- [x] verdict button labels translated, `data-verdict` values unchanged
- [x] `?lang=` sets the cookie; toolbar switch RU / EN
- [x] e2e: default page is Russian, `?lang=en` is English and sticks via the cookie; existing review e2e still pass (update text matches)
- [x] `make test-e2e` passes

### Task 3: Batch lock model and schema one-off

**Files:**
- Modify: `prv/db/index.js`, `lib/schema.js`, `prv/repository/review.js`, `test/e2e.js`

- [x] model columns `reviews_needed`, `excluded`, `locked_by`, `locked_at`; remove `assignee`
- [x] `lib/schema.js`: ADD COLUMN IF NOT EXISTS + the guarded one-off (gkshi → excluded bayanovea; unfinished assignee → lock; DROP `assignee`); drop the 2026-10-18 one-off that inserted `assignee` rows (replace with a plain batch-row insert)
- [x] repository: per-reviewer `batchProgress` with `state`, `takeBatch`, `releaseBatch({force})`, `canDecide`, finish-on-last-verdict helper; `createBatch(batch, {reviews_needed, excluded})`
- [x] e2e (repository level): availability rules (first take, second review excludes workers, excluded list, come-back after give-up), concurrent take → one wins, one-off on a DB seeded with an `assignee` column (gkshi and partial-bayanovea cases), idempotent second boot
- [x] `make test-e2e` passes

### Task 4: Take / give up / decide guard on the page

**Files:**
- Modify: `prv/routes/admin-review.js`, `server.js` (`normalizePath`), locale files, `test/e2e.js`

- [x] `POST …/:batch/take`, `POST …/:batch/release` (holder, or `force` with confirm in the UI)
- [x] batch list: sections "In work", "Available", "Locked by others", "Done", state per row; `show=all` keeps every batch
- [x] item page: banner with "Take it" when available, holder name + force release when locked, "Give up" for the holder; verdict controls disabled unless R may decide
- [x] decide: 409 unless holder or finished; clears the lock when R finishes; per-reviewer next-open / first-open / default item / pre-selected verdict
- [x] e2e: take → decide → finish unlocks; decide without lock 409; force release; second reviewer starts at C1 and sees the first verdict in history
- [x] `make test-e2e` passes

### Task 5: Create reviewer

**Files:**
- Modify: `prv/repository/review.js`, `prv/routes/admin-review.js`, locale files, `test/e2e.js`
- Create: `lib/reviewer-name.js`, `test/reviewer-name.test.js`

- [x] `validReviewerName()` (rules above) + unit tests
- [x] `createReviewer()` with case-insensitive uniqueness; `POST /admin/review/reviewers` (form 303 / JSON 201)
- [x] picker form under the name list
- [x] e2e: create → appears in picker → lands on the batch list; duplicate (other case) 400; bad name 400; 401 without token
- [x] `make test-unit` and `make test-e2e` pass

### Task 6: Onboarding block

**Files:**
- Modify: `prv/routes/admin-review.js`, locale files, `test/e2e.js`

- [ ] `<details>` closed by default on the batch list and item page, sections 1–8 above, ru and en
- [ ] hotkeys table rendered from the same list the key handler uses, so they cannot drift
- [ ] e2e: block present and closed in both languages
- [ ] `make test-e2e` passes

### Task 7: Importer and export

**Files:**
- Modify: `scripts/import-review-sheet.js`, `scripts/export-review-verdicts.sh`, `scripts/export-review-verdicts.sql`, `test/e2e.js`, `test/review-export.test.js`

- [ ] importer: `--reviews`, `--exclude`, `--assignee` → error with hint; lock on `--reviewer` when md verdicts leave the batch unfinished
- [ ] export: optional reviewer argument and file name
- [ ] e2e / export tests for both
- [ ] `make test-unit` and `make test-e2e` pass

### Task 8: Verify acceptance criteria

- [ ] every Overview bullet works on a local server against the restored dump (`docker compose -f docker-compose.dev.yml`), incl. the one-off on the dump copy of `prv_review_batches`
- [ ] `go test ./calculator -run 'TestFindMedian|TestCalculateIntervals|TestApplyRatings'`, `make test-unit`, `make test-e2e`

### Task 9: [Final] Documentation

- [ ] CLAUDE.md: review page section (states, endpoints, JSON shapes, i18n, Ops commands with `--reviews` / `--exclude` / export reviewer)
- [ ] `api/doc/openapi.yaml` if it lists the review endpoints
- [ ] move this plan to `docs/plans/completed/`
- [ ] cleanup pass before commit (residue / transient state / open questions)

## Post-Completion

- **Deploy** = push to GitHub (owner only). The one-off runs on the first prod boot; check the batch list as `bayanovea` (overlap batches absent from "Available") and as a new test reviewer (overlap batches present).
- Give assessors the page link (with the token) and ask them to open the onboarding block first.
- Interview material: decision entry in job-study `job-hunt/portfolio/native-ad-skip-decisions.md` (lock on the batch row vs claims table; first-come + exclusion as the overlap model).

## Open questions

- None blocking. A separate review-only token is the obvious next step if the assessor group grows beyond trusted people (`docs/backlog/admin-token-in-url.md`).
