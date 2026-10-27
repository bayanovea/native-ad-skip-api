# Assessor-corrected segment bounds on the review page

## Overview

An assessor on `/admin/review` can give an AI segment its real start and end, next to the verdict.
Today a keep verdict (`sponsor` / `self_promotion`) keeps the detector's bounds, which on true ads
lie inside the ad (median start +3.6 s late, end −5.3 s early; p75 15–18 s; 52 % of segments leave
> 10 s of ad at an edge, `docs/research/20261024-assessor-timing.md`). The owner's decision
(2026-10-24): if a human looks at the segment anyway, the markup should come out right.

- **Optional.** The bounds are two extra fields on a verdict; most verdicts will not have them. The
  instructions say: fill them only when you can see the timing is off and a viewer would notice.
  Every code path works with and without them.
- **Two ways in**: select the stretch in the transcript shown with context around the quote
  (bounds = the time of the first and last selected word; whole seconds, rounded outward), or type
  the times from the player (`m:ss`, `h:mm:ss`, or seconds). The source is stored (`cue` / `typed`).
- **Served.** On a keep verdict of a `kind = 'ai'` item the AI row's entry is replaced by one with
  the assessor's bounds and `source: "review"`; the viewer gets those bounds.
- **Word timings** are kept in `prv_ai_runs.transcript` from now on (prv auto tracks time every
  word, `ai/vtt` drops the tags today), so a selection is word-precise on new videos; on rows
  detected before, it snaps to cue bounds (~2 s), and the page says so.
- **Boundary rule** (owner, 2026-10-24) goes into the rules card and the onboarding: the lead-in
  ("а теперь о спонсоре") is part of the ad, the return to the topic is not, "ссылка в описании"
  is part of the ad.
- **Old comments**: 14 prod verdicts already carry a time typed into the comment. They are imported
  as bounds once, from a table the owner checks.

Decided and not up for re-discussion here: bounds only with keep verdicts; the entry is replaced,
votes on the old bounds are not carried over (the rating is recomputed from the votes on the new
bounds, as `docs/backlog/votes-lost-when-segment-boundaries-shift.md` accepts for human segments);
when two assessors give different bounds the latest verdict wins, as for verdicts; no text
selection is stored (the text inside the bounds follows from the transcript).

## Context (from discovery)

- Identity of an AI entry is its `(start, end)`: `prv/repository/ai.js` `applyVerdict` (`:69`) and
  `allKept` (`:13-22`), `ai/judge/signals.go` `entryKeeps` (`:258-279`), votes and events joined
  on exact bounds (`signals.go:151-167`, `prv/routes/votes.js:46`), `ai/judge/review.go:24-47`
  (an entry with an open item of the same bounds gets no new item). Entries are `int` in Go and
  `jsonb_to_recordset(… int)`; a fractional bound breaks the judge.
- Review items: `prv_review_items.start/end` FLOAT (sheet items one decimal, ai items ints),
  `cues` = text of the cues overlapping the entry, no times, no context
  (`ai/judge/review.go:68-72`, `ai/judge/llm.go:258-266`); `link` = player at start − 2 s.
- Verdicts: `prv_review_verdicts` append-only, `recordVerdict()` the single writer
  (`prv/repository/review.js:591`); decide route `prv/routes/admin-review.js:880-943` under the
  batch row lock, then `applyVerdict` (AI row `FOR UPDATE`); client "No change" guard `:714-716`,
  server duplicate guard `:904-910`.
- Transcript: `prv_ai_runs.transcript` = `{meta, cues: [{start, end, text}]}` (`ai/pipeline/detect.go:548`,
  `storedTranscript`), reached from the AI row by `run_id`; Node has no reader of it today. The
  `vtt`, `transcript`, `detector`, `provider`, `ytdlp` packages are synced copies from the eval repo
  (`scripts/sync-detector.sh`; never edited here). `vtt.Collapse` (eval `internal/vtt/vtt.go:76`)
  strips the `<00:00:00.322><c> word</c>` tags.
- Export to the eval: `scripts/export-review-verdicts.sql` writes `i.start` / `i.end`; the eval's
  `gold_missing` adds a gold interval with exactly those bounds (`internal/score/review.go:44`), so
  corrected bounds exported there become corrected gold.
- Times on the page: `formatPlayerTime()` (`lib/review-sheet.js:45`), no parser anywhere; hotkeys
  `LETTER_HOTKEYS` (`admin-review.js:40-45`); strings in `prv/locales/review/{ru,en}.json`
  (parity test `test/i18n.test.js`).
- Human markups are whole seconds (`lib/validate-intervals.js` rounds); publish rounds inward and
  drops entries shorter than 5 s (`ai/pipeline/publish.go:24, 41-51`).

## Development Approach

- **testing approach**: Regular (code first, then tests), the project's convention.
- complete each task fully before moving to the next; small focused changes.
- every task with a code change ends with new or updated tests (unit, e2e in `test/e2e.js`, Go
  sqlmock in `ai/judge`); all tests pass before the next task starts.
- run `make test-unit`, `go test -mod=vendor ./ai/...`, `make test-e2e` as the task says; update
  this plan when scope changes.
- backward compatibility: new columns nullable, entries keep the `video_calculateds.data` shape
  plus `source`, a pre-plan image keeps working against the new schema.

## Testing Strategy

- **unit**: `test/review-sheet.test.js` (time parser and `validateVerdictBounds`; no separate
  test file), `test/i18n.test.js` parity, Go `ai/judge` sqlmock
  tests (`entryKeeps` with verdict bounds), eval `internal/vtt` tests (word tags).
- **e2e** (`test/e2e.js`, the `ai…:` group drives the real binaries with fixtures): decide with
  bounds on an ai item changes what `GET /video-calculated` serves, ratings and votes follow the
  new bounds, restore through `allKept`, a second correction moves the entry again, bounds on a
  non-keep verdict → 400, a sheet item stores bounds and applies nothing, the transcript window
  JSON, the judge's keep baseline on a moved entry; `test/review-export.test.js`: the export
  writes corrected bounds; the bounds import script.

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix, blockers with ⚠️ prefix
- keep the plan in sync with the work

## Solution Overview

- A verdict row may carry `start`, `end` (INTEGER, whole seconds) and `bounds_source`
  (`cue` | `typed` | `import`), all three or none. An item's **effective bounds** are the bounds
  of its latest verdict that has them, else the item's own; the AI entry an item refers to is the
  one at its effective bounds. Everything keyed on an entry's bounds (votes, events, judge
  signals) keeps working unchanged, because the entry simply has new bounds; only the places
  that go from an *item* to its entry (`applyVerdict`, `allKept`, `entryKeeps`) use the effective
  bounds instead of the item's.
- `applyVerdict(item, verdict, { from, to })`: `from` = the item's effective bounds before this
  verdict (read in the same transaction), `to` = the new bounds or `from`. Keep: the entry at
  `from` (or a new one) gets the verdict's category, `start`/`end = to`, `source: "review"` when
  `to ≠ from` or when an entry is put back at bounds that are not the item's own (`confidence` kept), its `rating` from the votes on `(category, to)`, the array
  re-sorted by `start`. `not_ad` / `unclear`: the entry at `from` is removed, as today. Bounds
  that overlap another entry of the row are refused (400); the assessor decides that item first.
- The item page gets the transcript around the item (`[start − 60, end + 60]`, widened with a
  "more" control) from `prv_ai_runs.transcript` for ai items; each cue and, when stored, each word
  carries its time. Selecting text fills the two time inputs (start = floor of the first word's
  time, end = ceil of the last word's end, so the ad is never cut short); typing fills them with
  source `typed`. Sheet items have no transcript on prod (it lives in the eval): typed only.
- Rules: bounds only with `sponsor` / `self_promotion` (client disables the inputs for the other
  two, server 400); `validateIntervals` rules (ints, `0 ≤ start < end ≤ 86400`) plus
  `end − start ≥ 5` as publish; the "No change" guards compare the bounds too, so a bounds-only
  change saves. The page header shows the item's bounds and, when the effective bounds differ,
  "→ corrected a–b (by X)".
- Word timings: the eval's `vtt.Cue` gets `Words []Word{T, Text}` (`json:"words,omitempty"`),
  `Parse` reads the tags, `Collapse` keeps the words of the kept tail; after the sync the product
  stores them with no code change (`storedTranscript` holds `vtt.Cue`). Before the sync is
  shipped: confirm nothing marshals cues into the prompt (the prompt must not grow).
- Export: a `gold_missing` row carries the effective bounds (latest verdict with bounds, of the
  given reviewer when one is given), so the eval's gold carries the corrected bounds; `model_wrong` /
  `definition_unclear` rows keep the item's bounds, since they judge the stretch the model proposed. Import of the old comments: `scripts/import-verdict-bounds.js <tsv>` appends, per row,
  a verdict row copying the reviewer's latest verdict and comment on the item plus the bounds
  (`source = 'import'`, `bounds_source = 'import'`); refuses a row whose latest verdict is not a
  keep (a "the ad actually starts at 19:30" on a `not_ad` is not this item's bounds) and one where
  someone else decided the item later (the copy would become the item's latest verdict). Reviewer
  `-` = the author of the item's latest verdict (the local exports do not name reviewers).

## Technical Details

- Schema (`lib/schema.js`, idempotent ALTERs): `prv_review_verdicts ADD COLUMN IF NOT EXISTS start
  INTEGER NULL, "end" INTEGER NULL, bounds_source VARCHAR(8) NULL`. Model fields in
  `prv/db/index.js`. No index: lookups go through `item_id`.
- `recordVerdict({ …, bounds: { start, end, source } | null })`: validates `source ∈
  {cue, typed, import}` (callers set it from user input `cue|typed` on the page; `import` only
  the script), ints, `validateIntervals`-style range, `end − start ≥ 5`, keep verdict only;
  `ReviewInputError` otherwise.
- `reviewRepository.effectiveBounds(item_id, { transaction })` → `{start, end, verdict_id,
  reviewer}` from the latest verdict with bounds, else the item's; `hydrate` exposes
  `item.effective_bounds` and `item.own_bounds` (R's own latest verdict's bounds, to pre-fill).
- `allKept` (`ai.js`) and `entryKeeps` (`signals.go`): per item, the latest verdict (its value and
  time) and, separately, the latest verdict *with* bounds for the entry key
  (`COALESCE(b.start, i.start), COALESCE(b."end", i."end")`). A COALESCE on the latest verdict alone
  would lose a correction as soon as anyone saves a keep without bounds after it (a second reviewer,
  a comment change). Clearing the inputs therefore never resets the bounds; typing the item's own
  bounds does.
- Decide route: inside the batch lock, before `recordVerdict`: `from = effectiveBounds(item)`;
  after: `applyVerdict(item, verdict, { from, to })`; response adds `bounds: {start, end, source}
  | null` and `effective_bounds`. Duplicate guard: same verdict, comment **and bounds** as R's
  latest → skip. OpenAPI updated.
- Transcript JSON (item page `format=json` and the HTML `STATE`): `transcript: {from, to,
  has_words, cues: [{start, end, text, words?: [{t, text}]}]} | null`; `?context=N` seconds
  (default 60, max 600) widens the window on both sides; the repository reads
  `prv_ai_runs.transcript` through `prv_ai_video_calculateds.run_id` for `item.video_id`.
- Page: cues as `<span data-start data-end>`, words as `<span data-t>`; the detector's quote
  (cues within the item's bounds) highlighted, the effective bounds as a second highlight when
  they differ; `selectionchange` → bounds from the anchor / focus spans (a word's end = the next
  word's `t`, or the cue's end) → inputs, `bounds_source = 'cue'`; a keystroke in an input →
  `typed`; a clear button; hotkey `t` focuses the start input (added to `LETTER_HOTKEYS`, so the
  hotkeys line and the onboarding table follow). Parser `parsePlayerTime(text)` in
  `lib/review-sheet.js` (inverse of `formatPlayerTime`: `s`, `m:ss`, `h:mm:ss`, `NaN` on
  anything else), used client-side as inline code and server-side by the import script.
- Strings (ru first, en mirror): inputs' labels, the hint "optional: only when the timing is
  visibly off and a viewer would notice", the snap-to-cue notice for rows without words, the
  header "corrected" text, the "more context" control, the rule lines (lead-in in, return out,
  link-in-description in) in `rules_*_html` and a new `onb_bounds_*` onboarding section.
- Old comments: the owner-checked table `~/Web/data/review/bounds-2026-10.tsv` (private, not in
  the repo): `sheet item_code reviewer start end` with times as the comments wrote them; the
  script resolves the item by `(COALESCE(sheet, batch), item_code)`, runs under the batch lock,
  and prints what it skipped and why.

## What Goes Where

- **Implementation Steps**: code, tests, docs in this repo and the eval repo change for the words.
- **Post-Completion**: the owner's check of the 14-row table, the prod import, telling the assessors.

## Implementation Steps

### Task 1: Word timings in the eval's `vtt` package, then sync

**Files:**
- Modify (eval repo `~/Web/native-ad-skip-eval`): `internal/vtt/vtt.go`, `internal/vtt/vtt_test.go`
- Modify (here, via `scripts/sync-detector.sh`): `ai/vtt/*`, `ai/SOURCE`
- Modify: `test/fixtures/ai/<one native_id>.ru.vtt` (word tags on one fixture)

- [x] eval: `Word{T float64 "t"; Text string "text"}`, `Cue.Words []Word "words,omitempty"`; `Parse` reads `<hh:mm:ss.mmm>` tags before `<c>…</c>` (the first word of a line takes the cue start); `cleanText` unchanged for `Text`
- [x] eval: `Collapse` keeps the words of the kept tail (drop as many leading words as the prefix had); exact repeats still dropped
- [x] eval: confirm nothing marshals `vtt.Cue` into the detector prompt (grep `json.Marshal` in `internal/detector`, `internal/transcript`); if something does, exclude `Words` there
- [x] eval: tests with a rolling-caption sample (word times, tail words after collapse, a cue without tags → no words); `go test ./internal/vtt/...`; commit in the eval
- [x] here: `scripts/sync-detector.sh ~/Web/native-ad-skip-eval`, `go build ./ai/...`, `go test -mod=vendor ./ai/...`; one e2e fixture `.ru.vtt` gets word tags
- [x] e2e: after `ai detect`, `prv_ai_runs.transcript->'cues'->0->'words'` is present for that fixture and absent for one without tags; `make test-e2e` passes

### Task 2: Verdict bounds in the schema, the model and `recordVerdict`

**Files:**
- Modify: `lib/schema.js`, `prv/db/index.js`, `prv/repository/review.js`, `lib/review-sheet.js`
- Create: `test/verdict-bounds.test.js`
- Modify: `test/review-sheet.test.js`, `Makefile` (test-unit list), `CLAUDE.md` (test list)

- [x] `lib/schema.js`: the three `ADD COLUMN IF NOT EXISTS` on `prv_review_verdicts`; model fields `start`, `end`, `bounds_source`
- [x] `lib/review-sheet.js`: `parsePlayerTime()` (`s`, `m:ss`, `h:mm:ss` → seconds, `NaN` otherwise) and `validateVerdictBounds({start, end})` (ints, `0 ≤ start < end ≤ 86400`, `end − start ≥ 5`) exported for the route, the script and the page's inline code
- [x] `recordVerdict`: optional `bounds: {start, end, source}`; all-or-nothing, keep verdicts only, `source ∈ cue|typed|import`; stored on the row
- [x] `effectiveBounds(item_id)` and `hydrate` → `item.effective_bounds` (`{start, end, reviewer}`) and `item.own_bounds`; `ITEM_COLUMNS` untouched
- [x] unit tests: parser table (success, `NaN` cases), bounds rules (range, min length, non-int), `recordVerdict` input errors need no DB → cover through `validateVerdictBounds`; `make test-unit`
- [x] run tests - must pass before next task

### Task 3: `applyVerdict` moves the entry; decide route; `allKept` on effective bounds

**Files:**
- Modify: `prv/repository/ai.js`, `prv/routes/admin-review.js`, `api/doc/openapi.yaml`, `test/e2e.js`

- [x] `applyVerdict(item, verdict, { from, to, transaction })`: entry at `from` (or new), keep → category + `to` + `source: 'review'` when `to ≠ from` + `rating` from `voteRating(category, to)` + re-sort; refuse overlap with another entry (`ReviewInputError` → 400, nothing written); `changed` true on a bounds change
- [x] `allKept`: latest verdict per item, key `(COALESCE(v.start, i.start), COALESCE(v."end", i."end"))`
- [x] decide route: parse `bounds` (`start`, `end` ints or `m:ss` strings via the parser, `bounds_source`), `from = effectiveBounds` inside the batch lock, duplicate guard includes bounds, response `bounds` + `effective_bounds` + `ai_applied`; 400 texts in both languages
- [x] `openapi.yaml`: request and response fields of `POST /admin/review/decide`
- [x] e2e: keep with bounds → `GET /video-calculated` serves the new bounds with `source: 'review'`; a vote on the old bounds 404, on the new 201 and the rating lands; second correction moves again; not_ad with bounds → 400; overlap → 400; sheet item with bounds → stored, `ai_applied: false`; restore of a judge-withdrawn row through `allKept` with a moved entry; `--recompute-ratings` on a moved entry
- [x] run `make test-e2e` - must pass before next task

### Task 4: Judge: keep baseline on effective bounds

**Files:**
- Modify: `ai/judge/signals.go` (`entryKeeps`), `ai/judge/signals_test.go`, `ai/judge/judge_test.go`, `test/e2e.js`

- [x] `entryKeeps`: lateral join on `COALESCE(l.start, i.start) = e.start AND COALESCE(l."end", i."end") = e."end"` (latest verdict per item, as today)
- [x] `review.go`: no change needed (open items have no verdicts); note it in the code comment where the dedupe is
- [x] sqlmock tests: a moved entry's keep verdict sets its baseline; an item whose verdict moved the entry elsewhere does not match the old bounds
- [x] e2e judge test: verdict with bounds, then a tick → "every entry kept" `ok`, `judged_at` moves
- [x] `go test -mod=vendor ./ai/...`, `make test-e2e` - must pass before next task

### Task 5: Transcript window for the item page

**Files:**
- Modify: `prv/repository/review.js` (`getTranscript`), `prv/routes/admin-review.js` (JSON), `api/doc/openapi.yaml`, `test/e2e.js`

- [x] `getTranscript(item, contextSeconds)`: `prv_ai_runs.transcript` via `prv_ai_video_calculateds.run_id` for `item.video_id`; cues overlapping `[start − c, end + c]`, with `words` when stored; `has_words`; `null` for sheet items or a missing row
- [x] item route: `?context=N` (int 0…600, default 60, else 400); JSON `transcript`; `STATE.transcript`
- [x] e2e: JSON shape for an ai item (window, `has_words` true on the word fixture, false on the other), `null` for a sheet item, `context=600`, bad `context` → 400
- [x] run `make test-e2e` - must pass before next task

### Task 6: Page: selection → bounds, inputs, rule texts

**Files:**
- Modify: `prv/routes/admin-review.js` (HTML + inline script), `prv/locales/review/ru.json`, `prv/locales/review/en.json`, `test/i18n.test.js`, `test/e2e.js`

- [x] render the transcript (cue and word spans with times, the quote highlighted, the effective bounds as a second highlight, a "+60 s" control that reloads with a larger `context`), the snap-to-cue notice when `has_words` is false
- [x] two inputs (`m:ss` accepted, pre-filled from `own_bounds`), clear button, `selectionchange` → bounds (floor / ceil to whole seconds) + `bounds_source = 'cue'`, typing → `typed`; disabled and cleared when the verdict is `not_ad` / `unclear`; hotkey `t` in `LETTER_HOTKEYS`; "No change" guard includes bounds; the save payload carries `bounds`
- [x] header: item bounds, then "→ corrected a–b (by X)" when `effective_bounds` differ; the saved flash names the bounds
- [x] strings ru/en: labels, the optional-use hint, the notice, the header text, the control; rules card lines (lead-in in, return out, link-in-description in); onboarding section `onb_bounds_*`; `hotkeyRows()` shows `t`
- [x] `test/i18n.test.js` parity passes; e2e: the item HTML contains the inputs and the transcript for an ai item and no transcript block for a sheet item; the decide call from the page shape (`bounds` with `m:ss` strings) works
- [x] run `make test-unit`, `make test-e2e` - must pass before next task

### Task 7: Export with corrected bounds; import of the old comments

**Files:**
- Modify: `scripts/export-review-verdicts.sql`, `test/review-export.test.js`, `CLAUDE.md` (Ops)
- Create: `scripts/import-verdict-bounds.js`

- [x] export: `start` / `end` = `COALESCE(v.start, i.start)` / `COALESCE(v."end", i."end")` (the DISTINCT ON subquery selects them too)
- [x] `import-verdict-bounds.js <tsv> [--dry-run]`: rows `sheet item_code reviewer start end`, times through `parsePlayerTime`, item by `(COALESCE(sheet, batch), item_code)`, under `withBatchLock`, appends a verdict copying the reviewer's latest verdict + comment with the bounds (`source 'import'`, `bounds_source 'import'`), skips with a reason (no verdict, latest not a keep, bounds invalid, already has these bounds), one transaction, exit 1 on any parse error
- [x] prepare the private table from the 14 comments (`~/Web/data/review/bounds-2026-10.tsv`, outside the repo) for the owner's check; list the comments that cannot become bounds (not_ad with a time) in the Post-Completion note
- [x] tests in `test/review-export.test.js`: a verdict with bounds exports them, one without exports the item's; the import script on a fixture DB (applied row, skipped not_ad, invalid time → exit 1)
- [x] run `make test-e2e` - must pass before next task

### Task 8: Admin page and judge request show review-set bounds

**Files:**
- Modify: `prv/routes/admin.js`, `ai/judge/llm.go`, `ai/judge/llm_test.go`

- [x] `/admin/video/:video_id` AI block: a "review" badge on entries with `source: 'review'`
- [x] `llm.go` request: entries rendered with `(bounds by review)` when `source == "review"` (`Entry` gets `Source string "source"`), so the judge does not treat a human-set edge as a model error
- [x] Go test for the rendering; e2e asserts the badge
- [x] run tests - must pass before next task

### Task 9: Verify acceptance criteria

- [x] every requirement of the Overview is covered: optional bounds, both inputs, served on keep, 400 on non-keep, restore / judge baseline on moved entries, export, import script, word timings stored
- [x] edge cases: bounds equal to the item's (saved, `source` kept, entry unchanged), two assessors with different bounds (latest wins), a withdrawn-by-admin row (bounds stored, row stays withdrawn), pre-plan verdict rows (NULL bounds everywhere)
- [x] `make test-unit`, `go vet ./...`, `go test -mod=vendor ./ai/... ./calculator -run 'TestFindMedian|TestCalculateIntervals|TestApplyRatings'`, `make test-e2e`

### Task 10: [Final] Documentation and cleanup

- [x] `CLAUDE.md`: decide endpoint, `ReviewVerdict` model, "Verdicts" in AI-first segments (entry replaced, `source: review`, effective bounds), `entryKeeps`, Ops (import script, export semantics), the `t` hotkey, the test lists
- [x] `docs/ai-first-overview/{ru,en}.html`: what a verdict does now (bounds), the boundary rule; "updated" date; republish both artifacts (single file each)
- [x] `docs/backlog/ai-redetect.md`: note that review-set entries must survive a re-detect
- [x] move this plan to `docs/plans/completed/`
- [x] cleanup pass before commit (residue / transient state / open questions)

## Post-Completion

**Owner**
- Check `~/Web/data/review/bounds-2026-10.tsv`. Of the 14 comments one is a row
  (`2026-10-22-dev-misses C13`, start 23:01, end = the item's); `dev-misses C9` names no end and
  needs a look in the player; seven name the *player* time of a shifted track (`overlap-clean
  C26`, `heldout-b-p1 C81 C83 C85`, `heldout-b-p3 C171 C173 C177`): the gold is on the track's
  clock, so importing them would put a shifted interval into the gold; they are in the file as
  commented-out proposals. Five cannot be bounds (`2026-10-14-clean C9`, `overlap-clean C8`,
  `heldout-b-p2 C101 C121`, `heldout-b-p3 C146`: no ad, unreadable time, video shorter). Then run on
  prod over the tunnel:
  `DB_… node scripts/import-verdict-bounds.js ~/Web/data/review/bounds-2026-10.tsv` (dry-run
  first), then `export-review-verdicts.sh` for the affected sheets and `adskip review -file` in
  the eval, so the gold carries the corrected bounds.
- The two overview artifacts were republished on 2026-10-24 (ru, en); the en one is private, the ru
  one shared by link.
- Tell the assessors: the bounds are optional, the rule for where an ad starts and ends, the `t`
  hotkey and the selection.

**Eval repo**
- The `vtt` change is eval commit `7fd1a9a` (committed, not pushed); `ai/SOURCE` points at it. The eval can now
  measure assessor-set bounds against the detector's (a boundary report) once exports with bounds
  exist; the design of that report is the eval's.

**Watch after deploy**
- Rows detected before the deploy have no word timings: selections snap to cues there; nothing
  to do, it ages out.
- A pre-plan image rolled back inserts verdicts without bounds (columns nullable) and serves
  review-set entries as they are (`source` is just a field); the only loss is the inputs.

## Open questions

- Do assessors want a "bounds unclear" state (the ad is real but where it ends is not decidable
  from the text)? Today: leave the bounds empty and say so in the comment.
- Should a review-set entry be exempt from the judge's LLM `withdraw` (a human already looked)?
  Not in this plan: the judge still reacts to new negative signals on it; a verdict is still the
  last word through `entryKeeps`.
