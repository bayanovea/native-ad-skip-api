# Assessor review page

## Overview

New admin page `/admin/review` where an assessor gives one verdict per AI-flagged segment (sponsor / self_promotion / not_ad / unclear + comment). It replaces the hand-edited markdown review sheets in `~/Web/data/review/`.

- **Problem solved**: verdicts are typed into `.md` files by hand (typos like `not an add`, no user signals, no history, no way to hand the work to other assessors). Grafana's "Асессоры" dashboard is read-only and cannot record a verdict.
- **Hybrid labelling**: ground truth will combine three sources: AI segments (detector runs in `ad-skip-segment-eval`), user signals (markups, votes, undos), and assessor verdicts. This page shows the first two and records the third.
- **Two modes, one page**: now, run locally against the restored prod dump while the owner reviews eval sheets. Later, the same page runs on prod for real assessors.
- **Integration**: sibling of `/admin/moderation` (`prv/routes/admin-moderation.js`). Same auth, same server-rendered HTML + AJAX style, same append-only decision log idea. prv only.

## Context (from discovery)

- **Pattern to copy**: `prv/routes/admin-moderation.js` (server-rendered HTML, `?verifyBearerToken=` query auth, `escapeHtml` / `urlToken` helpers, AJAX decide endpoint, `?format=json` for tests) and its plan `docs/plans/completed/20260516-admin-moderation-page.md`.
- **Wiring**: routes are mounted in `prv/routes/index.js:24-25`; models live in `prv/db/index.js`; Prometheus path normalisation in `server.js:26-29`.
- **Schema bootstrap**: no migrations; new tables come from `sequelize.sync()`.
- **Signals available**: `markups` + `markup_time_intervals` (soft-deleted via `deleted_at`), `prv_calculated_segments` (with `rating`) + `votes`, `prv_events_interval_undo`, `prv_events_interval_click` (keyed by `video_native_id`). One `native_id` can map to several `videos` rows (duration split), so signal queries must join through all of them.
- **Input format** (written by `adskip sheet` in `ad-skip-segment-eval/cmd/adskip/sheet.go`):
  - `<sheet>.md`: one block per item: `### C<n>. <native_id> · <mm:ss> – <mm:ss> (<n> s)`, `Proposed as: <cat>[ / <cat>]`, `Link: <url>`, `> <cues>`, `Verdict: <text>`, optional comment lines after it.
  - `<sheet>.key.tsv`: `item, native_id, start, end, categories, runs_flagging` (exact seconds + which runs flagged it; private, blind).
- **Output format** consumed by `adskip review -file`: TSV `provider, native_id, category, start, end, verdict, item, note`, verdict vocabulary `gold_missing | gold_wrong | definition_unclear | model_wrong | gold_valid` (`internal/score/review.go`). Example: `~/Web/data/review/2026-10-12-blind-v21.tsv`.
- **Existing marks to keep**: `~/Web/data/review/2026-10-14-clean.md` has 39 items; 6 verdicts filled as of 2026-10-15 (C1–C6). C5 = `not an add` + a Russian comment.
- **Export pattern**: `scripts/export-gold.sh` + `export-gold.sql` (psql against the restored dump, `localhost:5433/skipper`, output under `${ADSKIP_DATA:-$HOME/Web/data}`).

## Development Approach

- **testing approach**: Regular (code first, then tests within the same task), same as the moderation plan
- complete each task fully before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- unit tests: `node --test test/<file>.test.js`; e2e: `make test-e2e`
- maintain backward compatibility for existing `/admin/*` routes

## Testing Strategy

- **unit tests** (`node:test`): sheet parser and verdict normalisation, export mapping, player-time formatting
- **e2e tests** (`test/e2e.js`): page JSON (`?format=json`), blind fields hidden before a verdict and shown after, decide endpoint (validation, append-only, latest wins), progress counts, signals query, auth (401)

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- keep plan in sync with actual work done

## Solution Overview

```
ad-skip-segment-eval                     native-ad-skip-api (Postgres)                     ad-skip-segment-eval
adskip sheet → <sheet>.md + key.tsv ──► import-review-sheet.js ──► prv_review_items
                                                                    prv_review_verdicts ◄── /admin/review (assessor)
                                        export-review-verdicts.sh ──► <sheet>.verdicts.tsv ──► adskip review
```

- **Sheet files are the interchange format.** No change to the eval repo is needed now: `adskip sheet` already writes `.md` + `.key.tsv`, and the importer reads both. The `.md` file is read-only input from now on.
- **Items** carry everything the md block shows (times, proposed category, link, cues) plus the blind `flagged_by` runs.
- **Verdicts are append-only.** Changing your mind adds a row; the latest row per item is the verdict. `source` is `import` (from md) or `page`.
- **Blind**: `flagged_by` is not rendered and not in JSON until the item has a verdict. Then it is shown under the verdict ("Flagged by: run A, run B").
- **Signals panel** shows user data around the stretch (±30 s): live markups (category, player times, author rating, link to `/admin/user/:id`), calculated segments with rating and vote counts, undo and click counts. Link to `/admin/video/:video_id` for each matching video row.
- **Times** on the page are player format (`mm:ss`, `h:mm:ss` above an hour, spaces around the dash). Seconds stay in DB and export.
- **Reviewer identity**: the admin token has no identity, so the page has a "Reviewer" field (stored in `localStorage`, sent with each verdict). Enough for one owner + a few trusted assessors; real accounts are out of scope.
- **Scope**: blind sheets (`C<n>` items) only. Category-conflict sheets (`K<n>`, "Detector said / Humans labelled") need a different export mapping; add later if needed.

## Technical Details

### Tables (models in `prv/db/index.js`, created by `sequelize.sync()`)

```
prv_review_items
  id           SERIAL PK
  batch        VARCHAR(64)   -- sheet name, e.g. '2026-10-14-clean'
  item_code    VARCHAR(16)   -- 'C7'
  position     INTEGER       -- 7, for ordering
  native_id    VARCHAR(64)
  start        FLOAT         -- seconds, from key.tsv
  end          FLOAT
  proposed     VARCHAR(64)   -- 'sponsor' or 'sponsor+self_promotion'
  cues         TEXT
  link         TEXT
  flagged_by   JSONB         -- ["run-id", ...]; blind
  created_at   TIMESTAMP
  UNIQUE (batch, item_code)

prv_review_verdicts
  id           SERIAL PK
  item_id      INTEGER FK → prv_review_items.id
  verdict      VARCHAR(16)   -- sponsor | self_promotion | not_ad | unclear
  comment      TEXT NULL
  reviewer     VARCHAR(64)
  source       VARCHAR(16)   -- page | import
  decided_at   TIMESTAMP
  INDEX (item_id, decided_at DESC)
```

### Verdict normalisation (importer only; the page sends canonical values)

| md text (case-insensitive, trimmed) | stored |
|---|---|
| `sponsor` | `sponsor` |
| `self_promotion`, `self promotion`, `self-promotion` | `self_promotion` |
| `not an ad`, `not an add`, `not ad`, `not_ad` | `not_ad` |
| `unclear` | `unclear` |
| empty | no verdict |
| anything else | **import fails**, nothing written, error names the item |

Comment = all non-empty lines after the `Verdict:` line up to the next `###`, joined with `\n`.

### Routes

| Verb | Path | Output |
|---|---|---|
| GET | `/admin/review?verifyBearerToken=…` | batch list: name, items, decided, open |
| GET | `/admin/review/:batch?verifyBearerToken=…&item=C7&format=json` | item page; without `item` → first undecided by `position` (or the last item when all are done) |
| POST | `/admin/review/decide?verifyBearerToken=…` | body `{item_id, verdict, comment, reviewer}` → `201 {flagged_by, next_item}`; `400` on bad verdict or unknown item |

### Item page layout

```
[2026-10-14-clean]  7 / 39 decided · 32 open           [◀ C6]  C7  [C8 ▶]  [first open]
C7 · -1_456000903 · 1:02 – 1:18 (16 s)    Proposed as: self_promotion
[Open in player ↗]  (link at start − 2 s)
> cues text …
Signals (±30 s): markups … · segments + votes … · undos N · clicks N   [video page ↗]
Verdict: [1 sponsor] [2 self_promotion] [3 not_ad] [4 unclear]
Comment: [___________________]                     Reviewer: [owner]
[Save ⏎]  → saves and opens the next open item
After save / for decided items: current verdict, history (who, when), Flagged by: …
```

Hotkeys (ignored while typing in the comment box, except Ctrl/Cmd+Enter): `1`–`4` pick verdict, `c` focus comment, `Enter` save, `j` / `k` next / previous, `o` open player link.

### Export mapping (`scripts/export-review-verdicts.sql`, latest verdict per item)

| verdict | `adskip review` verdict | category column |
|---|---|---|
| `sponsor` / `self_promotion` | `gold_missing` | the verdict category |
| `not_ad` | `model_wrong` | first proposed category |
| `unclear` | `definition_unclear` | first proposed category |

`note` = comment with tabs/newlines collapsed to spaces. Rows ordered by `position`. Output `${ADSKIP_DATA:-$HOME/Web/data}/review/<batch>.verdicts.tsv`.

## What Goes Where

- **Implementation Steps**: models, sheet parser, importer (+ real import of the 2026-10-14 sheet into the local DB), repository and signals query, routes and page, export script, tests, docs.
- **Post-Completion**: prod deploy and prod import, `adskip review` run in the eval repo, conflict-sheet support.

## Implementation Steps

### Task 1: Review tables

**Files:**
- Modify: `prv/db/index.js`

- [x] add `ReviewItem` model (`prv_review_items`, fields above, unique index on `(batch, item_code)`)
- [x] add `ReviewVerdict` model (`prv_review_verdicts`, fields above, index on `(item_id, decided_at DESC)`), association `ReviewItem.hasMany(ReviewVerdict)`
- [x] export both models
- [x] no dedicated tests (pure schema); covered by Task 3 and Task 5 tests
- ⚠️ `make test-e2e` has 3 pre-existing failures on this branch, unrelated to the review tables (same result with Task 1 reverted): moderation tests 39, 56 and 57 get `POST /vote` → 404 "Not found". The other 82 tests pass.

### Task 2: Sheet parser

**Files:**
- Create: `lib/review-sheet.js`
- Create: `test/review-sheet.test.js`
- Create: `test/fixtures/review-sheet.md`, `test/fixtures/review-sheet.key.tsv`

- [x] `parseSheet(mdText, keyTsvText)` → `{ items: [{item_code, position, native_id, start, end, proposed, cues, link, flagged_by, verdict|null, comment|null}] }`; start/end/flagged_by from key.tsv, the rest from md
- [x] `normalizeVerdict(text)` per the table above; throws with the item code on unknown text
- [x] fail if an md item has no key row or the native_id differs between md and key
- [x] `formatPlayerTime(seconds)` helper (`mm:ss` / `h:mm:ss`), shared with the page
- [x] fixture: copy of 3 real blocks (one sponsor, one `not an add` with a multi-line comment, one empty) + matching key rows
- [x] write tests: verdicts and comments parsed, empty verdict = null, typo normalised, unknown verdict throws, missing key row throws
- [x] write tests: `formatPlayerTime` (59 → `0:59`, 919.8 → `15:20`, rounded like `adskip sheet`, 3843 → `1:04:03`)
- [x] run `node --test test/review-sheet.test.js`, must pass before Task 3
- ⚠️ the key file keeps one decimal, so a key time ending in `.5` can show 1 s off the md header (`adskip sheet` rounded the unrounded time): 4 of 39 items in `2026-10-14-clean` (e.g. C13 key 541.5 → `9:02`, md `9:01`). Unavoidable from the key alone; seconds in DB/export are unaffected.

### Task 3: Importer, and import the 2026-10-14 sheet

**Files:**
- Create: `scripts/import-review-sheet.js`
- Modify: `test/e2e.js`
- ➕ Modify: `scripts/sync-db.js` (honour `DB_PORT`, needed to reach the local dump on 5433)

- [x] `node scripts/import-review-sheet.js <sheet.md> [--batch NAME]`: key path = `<sheet>.key.tsv`, batch defaults to the file name without `.md`; DB connection like `scripts/sync-db.js`
- [x] before anything else, copy the md to `<sheet>.md.bak-YYYYMMDDHHMMSS`; never write to the md
- [x] in one transaction: insert items (`ON CONFLICT (batch, item_code) DO NOTHING`); insert md verdicts with `source='import'`, `reviewer='owner'` only for items that have no verdict yet (safe to re-run after more md marking)
- [x] print a summary: items inserted / already present, verdicts imported (item code + verdict), verdicts skipped because the item already has one
- [x] write e2e test: import the fixture twice → items not duplicated, verdicts not duplicated; a later page verdict is not overwritten by a re-import
- [x] run `make test-e2e`, must pass
- [x] run against the local restored dump (`localhost:5433/skipper`) for `~/Web/data/review/2026-10-14-clean.md`; verify: 39 items, verdict rows = number of non-empty `Verdict:` lines in the md at import time (6 on 2026-10-15: C1 self_promotion, C2 sponsor, C3 self_promotion, C4 sponsor, C5 not_ad with comment, C6 self_promotion); backup file exists
- ➕ the local dump had no review tables: created them with `DB_HOST=localhost DB_PORT=5433 DB_USER=postgres DB_PASSWORD=local DB_NAME=skipper node scripts/sync-db.js` (sync created only `prv_review_items` and `prv_review_verdicts`). Import result: 39 items, 6 verdicts (C1–C6 as listed), backup `2026-10-14-clean.md.bak-20261015230918`, md and key.tsv checksums unchanged.
- ➕ importer never overwrites a backup: two runs in the same second get a `-1`, `-2` suffix.

### Task 4: Review repository and signals query

**Files:**
- Create: `prv/repository/review.js`
- Modify: `prv/routes/index.js` (construct and pass the repository)
- ➕ Modify: `scripts/import-review-sheet.js` (md verdicts go through `recordVerdict`)

- [x] `listBatches()` → batch, total, decided
- [x] `getItem(batch, itemCode)` / `firstOpenItem(batch)` / neighbours (prev/next by `position`), each with latest verdict + history
- [x] `recordVerdict({item_id, verdict, comment, reviewer, source})` (single write entrypoint, validates verdict)
- [x] `getSignals(native_id, start, end, window=30)`: through all `videos` rows for the native_id: live markups whose intervals overlap the window (`deleted_at IS NULL` on markup and interval), calculated segments overlapping with rating + vote counts, undo and click counts overlapping
- [x] write e2e tests (seeded DB): signals return an overlapping markup and skip a soft-deleted one and one outside the window; latest verdict wins after two writes
- [x] run `make test-e2e`, must pass (87/90; the 3 failures are the known baseline 39, 56, 57)
- ➕ extra read helpers the page needs: `getItemById`, `getBatchProgress`, `defaultItem` (first open, else last item), `nextOpenItem(batch, position)` (next open after the current one, wrapping round). The blind rule lives in the repository: `flagged_by` is omitted from every returned item without a verdict.
- ➕ `recordVerdict` throws `ReviewInputError` with a `code` (`invalid_verdict`, `invalid_source`, `invalid_reviewer`, `invalid_item`, `invalid_comment`, `unknown_item`) so the decide route can map it to 400; reviewer and comment are trimmed, empty comment → null. The importer now writes md verdicts through it (same transaction).
- ➕ `index.js` only constructs `reviewRepository`; Task 5 passes it to `admin-review.js`. Sanity-checked on the local dump: a split native_id returns markups/segments from both `videos` rows (~25 ms); none of the 39 `2026-10-14-clean` items has user data in the dump (no `videos` rows for their native_ids), so their signals panel will be empty locally.

### Task 5: Review routes and page

**Files:**
- Create: `prv/routes/admin-review.js`
- Modify: `prv/routes/index.js`
- Modify: `server.js` (normalizePath: `/admin/review/#batch`)
- Modify: `test/e2e.js`

- [ ] `GET /admin/review` batch list, `GET /admin/review/:batch` item page, `POST /admin/review/decide`; token check as in `admin-moderation.js`; reuse its `escapeHtml` / `urlToken` approach
- [ ] page per the layout above: progress counter, item card in player times, signals panel, verdict buttons, comment, reviewer field (`localStorage`, wrapped in try/catch), save → next open item, history and `flagged_by` only for decided items
- [ ] hotkeys per the table above
- [ ] `?format=json` returns the same data as the page (no `flagged_by` for undecided items)
- [ ] write e2e tests: 401 without token; JSON for an undecided item has no `flagged_by`; after decide it has; decide with a bad verdict → 400; progress counts change; default item = first open
- [ ] run `make test-e2e`, must pass

### Task 6: Verdict export for the eval repo

**Files:**
- Create: `scripts/export-review-verdicts.sh`
- Create: `scripts/export-review-verdicts.sql`
- Create: `test/review-export.test.js`

- [ ] `scripts/export-review-verdicts.sh <batch>` (psql, same env defaults as `export-gold.sh`) → `<data>/review/<batch>.verdicts.tsv` with the header `provider native_id category start end verdict item note`
- [ ] mapping per the export table, latest verdict per item, open items skipped, note sanitised
- [ ] write test: seed items + verdicts (including a changed verdict and a comment with a newline and a tab), run the SQL, compare to expected TSV
- [ ] run the export for `2026-10-14-clean` on the local DB; check the 6 rows by eye

### Task 7: Verify acceptance criteria

- [ ] a full review pass works with the keyboard only (1–4, Enter, j/k)
- [ ] blind holds: `flagged_by` is absent from HTML and JSON before a verdict
- [ ] re-running the import after new md marks adds only the new verdicts
- [ ] run all unit tests and `make test-e2e`

### Task 8: [Final] Update documentation

- [ ] `CLAUDE.md`: routes (`admin-review.js`), models (`ReviewItem`, `ReviewVerdict`), scripts (import, export)
- [ ] `api/doc/openapi.yaml` only if admin routes are documented there
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

*Items requiring manual intervention or external systems, no checkboxes*

**Manual verification**
- Review 5 open items of `2026-10-14-clean` in the page next to the prv player; check times, link offset and signals by eye.
- Stop marking in the md once the page works; run the importer once more right before switching so the last md marks are kept.

**Eval repo (`ad-skip-segment-eval`)**
- Load the export: `adskip review -file <data>/review/2026-10-14-clean.verdicts.tsv -run <run> -date <date>`. The blind sheet comes from several runs, while `-run` takes one; decide there how to record the source run (the key file has the list).
- Category-conflict sheets (`K<n>`) need their own mapping (verdicts about the human label, so `gold_wrong` / `gold_valid` come into play).

**Prod (later, when assessors start)**
- Deploy (tables come from `sequelize.sync()` on boot); import sheets into prod over an SSH tunnel; give assessors the page link with the token.
- Real per-assessor accounts and agreement metrics between assessors are a separate plan.
