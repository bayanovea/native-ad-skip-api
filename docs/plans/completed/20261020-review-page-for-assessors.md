# Review page for external assessors

> **Status 2026-10-20: COMPLETED on branch `review-page-for-assessors`, not deployed.** Tasks 1–9 done; acceptance checked over HTTP on a copy of the restored dump. Deploy (push) is the owner's; the `assignee` one-off runs on the first prod boot. Still open: see Post-Completion and Open questions.

## Overview

Open `/admin/review` to real assessors who know nothing about the project.

- **Self-service reviewers**: the picker has a "Create reviewer" form (a name only); the new name shows in the list from then on.
- **First come, not assigned**: batches are not assigned to a person. Whoever takes a batch first reviews it. A batch that needs a second review goes back to everyone **except** the reviewers who already worked on it.
- **One holder per batch**: a batch opens read-only with a "Take it" button. Taking it locks the batch on that reviewer until they finish it or give it up, so two people never mark the same batch at once.
- **gkshi batches** (`2026-10-18-overlap-*`): go to anyone except `bayanovea` (they are blind copies of `bayanovea`'s sheets).
- **Onboarding**: a collapsed block on the batch list and the item page that explains the task, verdicts, the track flag, the player window, the −2 s start, hotkeys, the take/finish/give-up flow and "feedback goes to the shared chat".
- **i18n**: Russian by default, English switch; all page text comes from locale files. Assessors are Russian speakers; English keeps the repo readable for an outside reader.

Decided with the owner (2026-10-20): the shared `AUTH_TOKEN` stays (no separate review token); a second reviewer sees earlier verdicts, history and `flagged_by` (not blind); the Signals panel stays as is.

## Context (from discovery)

- `prv/routes/admin-review.js`: server-rendered HTML + inline JS, `?reviewer=` carried in every link, `POST /admin/review/decide`.
- `prv/repository/review.js`: `IS_DECIDED` = any verdict by anyone; `batchProgress()` filtered by `prv_review_batches.assignee`; `createBatch(batch, assignee)`.
- `prv/db/index.js`: `ReviewReviewer (code)`, `ReviewBatch (batch, assignee, created_at)`.
- `lib/schema.js`: idempotent ALTERs and one-offs run on every boot (no migrations folder); `REVIEWERS` seed.
- `scripts/import-review-sheet.js`: `--assignee CODE`, `--reviewer CODE`.
- `scripts/export-review-verdicts.sql`: latest verdict per item across all reviewers.
- Tests: `test/e2e.js` (review section used `assignee` in progress rows and importer tests), `make test-unit` for DB-free tests. No cookie parser in the app.

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task), as in the earlier review plans
- unit: `make test-unit`; e2e: `make test-e2e`

## Testing Strategy

- **unit** (`node:test`, DB-free): i18n lookup and interpolation, ru/en key parity, `_html` rule, reviewer-name validation
- **e2e** (`test/e2e.js`): create reviewer, take / give up / finish, lock conflicts (409), availability rules (second review, exclusions), per-reviewer progress and navigation, the schema one-off, importer flags, export reviewer filter, `?lang=` cookie, onboarding block

## Solution Overview

State lives on the batch row; "who has worked on it" is derived from verdicts.

| Column on `prv_review_batches` | Meaning |
|---|---|
| `reviews_needed INT NOT NULL DEFAULT 1` | how many reviewers must finish the batch |
| `excluded TEXT[] NOT NULL DEFAULT '{}'` | reviewers who may never take it (reviewed the same items elsewhere) |
| `locked_by VARCHAR(64) NULL`, `locked_at TIMESTAMPTZ NULL` | current holder |
| ~~`assignee`~~ | dropped by the one-off below |

Derived, per batch: `finished` = reviewers with a verdict on **every** item.

**Batch states for reviewer R** (`STATE` in the repository, first match wins):

1. *mine*: `locked_by = R`.
2. *done*: R ∈ `finished`.
3. *closed*: R ∈ `excluded`, even while someone else holds it (it can never be R's).
4. *locked*: `locked_by` set to another reviewer.
5. *available*: `locked_by IS NULL`, R ∉ `finished`, `|finished| < reviews_needed`. A reviewer who gave up halfway may come back only until the batch has its reviews; after that it is *closed* to them, so their late verdicts never override a complete review in the default export (latest verdict per item).
6. otherwise *closed*: hidden from R's list (`show=all` shows everything with its state).

**Take**: one `UPDATE … SET locked_by = R, locked_at = now() WHERE batch = :b AND <available to R>`; 0 rows → 409 (or the existing lock when R already holds it; a read that finds the batch free again retries the UPDATE once). This is the race guard for "first come".
**Finish**: after each verdict, the decide route clears R's lock when R has a verdict on every item.
**Give up**: holder clears the lock; verdicts stay. **Force release** of someone else's lock: the same button with a confirm dialog naming the holder (small trusted group, everyone has the admin token anyway; covers an assessor who disappeared).
**Decide** is allowed only in states *mine* and *done* (fixing your own finished batch); otherwise 409 with the reason. The state check, the verdict, the flag and the finish release run in one transaction with the `prv_review_batches` row locked `FOR UPDATE`, so a force release followed by someone else's take cannot land between the check and the write.

**Per-reviewer progress**: `decided` / `open` and navigation (`first open`, save → next open, default item) count R's verdicts, so a second reviewer starts at C1. The verdict buttons pre-select R's own latest verdict; the "Current verdict" block and history still show everyone's (owner decision, not blind).

**Why not a claims table** (`prv_review_claims` with claimed/finished/released rows): it needs a backfill from verdicts and becomes a second source of truth for "finished"; nobody asked for take history.

**i18n**: `prv/locales/review/ru.json` and `en.json` (flat `key → string`, `{name}` placeholders), loaded by `lib/i18n.js`: `translator(lang)` → `t(key, params)` returns HTML, `t.text()` plain text for the inline script's `STATE`. Both files have the same keys (parity test); an unknown key throws. Language: `?lang=ru|en` sets cookie `review_lang` (1 year, path `/admin/review`, httpOnly); otherwise the cookie; otherwise `ru`. A switch link in the toolbar; `<html lang>` follows. Only keys ending in `_html` may contain markup (repo-owned files; everything else is escaped, and params are always escaped). Verdict *values* stay English identifiers in the DB and the API; only labels are translated.

## Technical Details

**Reviewer creation** — `POST /admin/review/reviewers?verifyBearerToken=…`, form or JSON body `{name}`. `lib/reviewer-name.js` `validReviewerName()`: NFC, trimmed, inner space runs collapsed, 1–64 chars, letters (any script), digits, space, `.`, `_`, `-`; the cleaned name is the code (it already is for `bayanovea`/`gkshi`). Duplicate in any letter case → `taken` (compared in JS under a table lock: Postgres `lower()` under a C locale folds ASCII only); bad name → `invalid`. HTML form: 303 to the batch list for the new reviewer, or 400 with the picker, the typed value and the reason. JSON: `201 {code}` or `400 {reason, message}`.

**Lock endpoints** — `POST /admin/review/:batch/take`, `POST /admin/review/:batch/release` (body `{reviewer, force?: boolean}`) → `200 {batch, locked_by, locked_at}`; 400 bad input, 404 unknown batch, `409 {reason, locked_by, message}` (`reason` = R's state, `message` translated). `normalizePath` in `server.js`: `/admin/review/#batch/take|release`, and `reviewers` excluded from `#batch`.

**JSON shapes** — batch rows `{batch, total, decided, open, reviews_needed, finished: [codes], locked_by, locked_at, state}` (`decided`/`open` for the requesting reviewer; `state` ∈ `mine | available | locked | done | closed`). Item page adds `can_decide` and `item.own_verdict`; `batch` is R's progress row. `assignee` is gone from all JSON.

**Schema one-off** (`dropBatchAssignee()` in `lib/schema.js`, runs only while column `assignee` exists, one transaction so a failed boot retries it whole):
1. ADD the new columns (`IF NOT EXISTS`, every boot).
2. `assignee = 'gkshi'` → `excluded = '{bayanovea}'` (`reviews_needed` keeps its column default 1).
3. Any assignee X who has not finished the batch → `locked_by = X` (keeps X's in-progress batches with X); for `gkshi` only once gkshi has verdicts there, so the untouched overlap batches go to anyone else.
4. DROP `assignee`.

The 2026-10-18 one-off that inserted `assignee` rows became a plain default-row insert for every batch of `prv_review_items` (runs after the one-off); the rename of unknown-reviewer verdicts to `bayanovea` runs before it, because the one-off counts verdicts per reviewer.

**Importer** — `--assignee` removed (fails with a hint). New: `--reviews N` (default 1), `--exclude CODE[,CODE]` (registered codes; for subset sheets of an already reviewed sheet). Existing batch + a different `--reviews`/`--exclude` → fails (same "never silently re-route" rule as before); an option left out is not compared. `--reviewer CODE` md verdicts work as before; when newly imported verdicts leave the batch unfinished for that reviewer and they may take it, the importer locks it on them; when they finish it, their lock is released. A re-run that imports nothing touches no lock, so it never re-locks a batch the reviewer gave up. md verdicts of a `--reviewer` in the batch's `excluded` list fail the import (exit 1, nothing written).

**Export** — `export-review-verdicts.sh <batch> [reviewer]`: with a reviewer (registered, else exit 1), only that reviewer's latest verdict per item, output `<batch>.<reviewer>.verdicts.tsv`; without one, unchanged.

**Onboarding** (`<details>`, closed by default, on the batch list and the item page; `onb_<section>_title` / `onb_<section>_html` locale keys), sections:
1. What this is: prv video skips ads; a detector found subtitle pieces that may be ads; you check what the *text* is. Your verdicts are the ground truth for measuring the detector.
2. Workflow: pick your name (or create it) → open a batch → "Take it" → go item by item → the batch finishes itself on the last verdict; "Give up" if you stop.
3. Verdicts with one example each, the "who paid" test, `unclear` only when the text does not decide.
4. Track flag: player shows other words or the same words shifted → tick it; it is about the whole video, the verdict still judges the text.
5. Player window: "Open in player" (`o`) opens prv in a new tab; switching items swaps tabs (the next item opens in front, the old tab becomes its player); start from the batch list, otherwise the browser will not let the page close old player tabs.
6. Timing: the player starts 2 s before the piece on purpose; times are `m:ss`.
7. Hotkeys table (works on a Russian layout), rendered by `hotkeyRows()` from the same `LETTER_HOTKEYS` list the key handler reads, so it cannot drift.
8. Comments: write why when unsure; questions, bugs and ideas → the shared chat.

## Implementation Steps

### Task 1: Locale files and translator

**Files:**
- Create: `lib/i18n.js`, `prv/locales/review/ru.json`, `prv/locales/review/en.json`, `test/i18n.test.js`
- Modify: `Makefile` (add the test to `test-unit`)

- [x] `lib/i18n.js`: load both files once, `translator(lang)` with `{name}` interpolation, `pickLang(req)` (query → cookie header → `ru`)
- [x] seed locale files with the keys the next tasks need (start with toolbar/picker strings)
- [x] unit tests: interpolation, unknown lang → ru, missing key, ru/en key parity, `_html` rule

### Task 2: Translate the existing pages

**Files:**
- Modify: `prv/routes/admin-review.js`, locale files, `test/e2e.js`

- [x] every visible string (picker, batch list, item page, rules card, hotkeys line, client-side status texts) through `t()`; `<html lang>` follows the language
- [x] verdict button labels translated, `data-verdict` values unchanged
- [x] `?lang=` sets the cookie; toolbar switch RU / EN
- [x] e2e: default page is Russian, `?lang=en` is English and sticks via the cookie; existing review e2e text matches moved to the ru locale

### Task 3: Batch lock model and schema one-off

**Files:**
- Modify: `prv/db/index.js`, `lib/schema.js`, `prv/repository/review.js`, `test/e2e.js`

- [x] model columns `reviews_needed`, `excluded`, `locked_by`, `locked_at`; remove `assignee`
- [x] `lib/schema.js`: ADD COLUMN IF NOT EXISTS + the guarded one-off (gkshi → excluded bayanovea; unfinished assignee → lock; DROP `assignee`); the 2026-10-18 `assignee` insert replaced with a plain batch-row insert
- [x] repository: per-reviewer `batchProgress` with `state`, `takeBatch`, `releaseBatch({force})`, `withBatchLock`, `releaseIfFinished`; `createBatch(batch, {reviews_needed, excluded})`
- [x] e2e (repository level): availability rules (first take, second review excludes finishers, excluded list, come-back after give-up only while reviews are short), concurrent take → one wins, one-off on a DB seeded with an `assignee` column (gkshi and partial-bayanovea cases), idempotent second boot

### Task 4: Take / give up / decide guard on the page

**Files:**
- Modify: `prv/routes/admin-review.js`, `server.js` (`normalizePath`), locale files, `test/e2e.js`

- [x] `POST …/:batch/take`, `POST …/:batch/release` (holder, or `force` with confirm in the UI)
- [x] batch list: sections "In work", "Available", "Locked by others", "Done", state per row; `show=all` keeps every batch
- [x] item page: banner with "Take it" when available, holder name + force release when locked, "Give up" for the holder; verdict controls disabled unless R may decide
- [x] decide: 409 unless holder or finished; clears the lock when R finishes; per-reviewer next-open / first-open / default item / pre-selected verdict
- [x] e2e: take → decide → finish unlocks; decide without lock 409; force release; second reviewer starts at C1 and sees the first verdict in history

### Task 5: Create reviewer

**Files:**
- Modify: `prv/repository/review.js`, `prv/routes/admin-review.js`, `server.js`, locale files, `test/e2e.js`
- Create: `lib/reviewer-name.js`, `test/reviewer-name.test.js`

- [x] `validReviewerName()` (rules above) + unit tests
- [x] `createReviewer()` with case-insensitive uniqueness; `POST /admin/review/reviewers` (form 303 / JSON 201)
- [x] picker form under the name list
- [x] e2e: create → appears in picker → lands on the batch list; duplicate (other case) 400; bad name 400; 401 without token

### Task 6: Onboarding block

**Files:**
- Modify: `prv/routes/admin-review.js`, locale files, `test/e2e.js`

- [x] `<details>` closed by default on the batch list and item page, sections 1–8 above, ru and en
- [x] hotkeys table rendered from the same list the key handler uses, so they cannot drift
- [x] e2e: block present and closed in both languages

### Task 7: Importer and export

**Files:**
- Modify: `scripts/import-review-sheet.js`, `scripts/export-review-verdicts.sh`, `scripts/export-review-verdicts.sql`, `prv/repository/review.js` (`lockUnfinished`), `test/e2e.js`, `test/review-export.test.js`

- [x] importer: `--reviews`, `--exclude`, `--assignee` → error with hint; lock on `--reviewer` when md verdicts leave the batch unfinished
- [x] export: optional reviewer argument and file name
- [x] e2e / export tests for both

### Task 8: Verify acceptance criteria

- [x] every Overview bullet works on a local server against a copy of the restored dump (`docker compose -f docker-compose.dev.yml`), incl. the one-off on the dump copy of `prv_review_batches`
  - [x] one-off on a copy with `assignee`: `2026-10-14-clean` (bayanovea 6/39) → locked on bayanovea; both overlap batches → `excluded {bayanovea}`, no lock; second boot changes nothing
  - [x] picker form; create via form (303 to the new list, Cyrillic name) and JSON (201); other-case duplicate 400, bad name 400, no token 401
  - [x] lists: bayanovea sees only her batch (no overlap, take → 409 closed); gkshi and a new reviewer see both overlap batches available
  - [x] take → 409 for a second taker → decide → give up → force release; decide without lock 409; finishing the last item clears the lock (`done`), the finisher can still fix a verdict, a reviewer who never worked on it sees it `closed`
  - [x] second reviewer starts at the first item and sees the earlier verdict in history; read-only banner with the holder's name and force release
  - [x] `?lang=en` (html lang, sections, onboarding) sticks via the `review_lang` cookie; onboarding `<details>` closed with all 8 sections in ru and en

### Task 9: [Final] Documentation

- [x] CLAUDE.md: review page section (states, endpoints, JSON shapes, i18n, onboarding, `LETTER_HOTKEYS`), Ops commands with `--reviews` / `--exclude` / export reviewer, Importer and Export paragraphs, models table (`ReviewReviewer`, `ReviewBatch`), schema-bootstrap one-off, `lib/` table (`i18n.js`, `reviewer-name.js`), `normalizePath` rules
- [x] `api/doc/openapi.yaml`: review endpoints updated (reviewer / show / lang params, JSON shapes, 409), `reviewers`, `take`, `release` added
- [x] move this plan to `docs/plans/completed/`
- [x] cleanup pass before commit (residue / transient state / open questions)

## Post-Completion

- **Test state at completion** (2026-10-20, on the branch): `make test-unit` 66 pass, `make test-e2e` 144 pass, calculator unit subset green.
- **Deploy** = push to GitHub (owner only). The one-off runs on the first prod boot; check the batch list as `bayanovea` (overlap batches absent from "Available") and as a new test reviewer (overlap batches present).
- Give assessors the page link (with the token) and ask them to open the onboarding block first.
- Interview material: decision entry in job-study `job-hunt/portfolio/native-ad-skip-decisions.md` (lock on the batch row vs claims table; first-come + exclusion as the overlap model).

## Open questions

- The importer skips an md verdict when the item has a verdict from anyone, not only from `--reviewer`. Matters only for md imports of second reviews (page reviews are unaffected); fix if second reviews ever come in as md.
- Onboarding is not on the picker page, so a new assessor sees it only after picking or creating a name.
- A separate review-only token is the obvious next step if the assessor group grows beyond trusted people (`docs/backlog/admin-token-in-url.md`).
