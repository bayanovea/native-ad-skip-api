# AI-first flow audit (2026-11-04)

A walk of the whole AI-first flow (prv) on `main` at 75c57bd: every state an entry or a row can be in against every writer, read from the code, with the test that covers each move. Code problems went to `docs/backlog/`, docs drift was fixed in the same branch. Placeholder ids only.

## States

- **Entry** (an element of `prv_ai_video_calculateds.data` or `.hidden`): `data` with `source` `ai` | `chapter` | `review`; `hidden` with `reason` `confidence` | `short` | `review` | `unconfirmed`; *gone* (absorbed by a merge, or removed before `hidden` existed).
- **Row**: published with entries; published with empty `data` (nothing found, or everything hidden); withdrawn by `judge` | `review` | `admin` (`data` kept).
- **Queue** (`prv_ai_videos.status`): `seen` → `queued` → `fetching` → `detecting` → `published` | `no_track` | `timeline_unreliable` | `failed`; `published` ↔ `withdrawn`.

## Writers

| Writer | Entries | Row / queue | Locks, in order | Covered by |
|---|---|---|---|---|
| publish (`ai/pipeline/detect.go` `finish`: `entries` → second opinion → chapter check) | creates `data` `ai` / `chapter`, `hidden` `confidence` / `short` / `unconfirmed` (confidence, then length, then the veto); never `review`; ratings from the votes on the bounds | new row, published even with empty `data`; `detecting` → `published` (a failed or invalid answer → `failed`) | queue row → `video_calculateds` → AI row (insert) → batch rows (`ai-second`, then `ai-chapter`) | `publish_test.go` `TestEntriesSplitsServedAndHidden`, `TestEntriesUnconfirmedOnlyForWhatWouldBeServed`, `TestPublishRatesTheEntriesFromTheVotesUnderTheVideoCalculatedLock`; `confirm_test.go` `TestConfirmGatesOnlyWhenTheSecondModelAnswered`, `TestPollConfirmsBeforeTheLockAndRecordsInThePublish`; `chapters_test.go` `TestApplyChapters`, `TestFinishAppliesChaptersOnlyWhenSwitchedOn`; e2e `ai detect: queue → fetch → gate → batch → publish…`, `ai second: a segment both models found…`, `ai second: a failing second call…`, `ai chapters:` (3) |
| `applyVerdict` keep (`prv/repository/ai.js`, from decide, adopt, bounds import) | any `data` / `hidden` entry → `data` with the verdict's category (`source: review` when moved) or `hidden` `short`; covered same-category `data` entries absorbed; a `hidden` entry at exactly `to` replaced; a *gone* entry not covered by a served one re-created (no `confidence`) | restores a `judge` / `review` row once every `data` entry is kept after the withdraw; `withdrawn` → `published`; never withdraws | batch row → AI row | e2e `ai review: not_ad hides the entry…; a keep verdict sets the category or serves the entry again…`, `ai review hidden:…`, `ai review bounds:` (3), `ai review merge:…`, `ai review: keep verdicts restore a judge-withdrawn row…`, `ai second: a keep on an unconfirmed entry serves it…`, `ai chapters: the T item page…`; keep on a hidden entry inside a served one: untested (finding 1) |
| `applyVerdict` `not_ad` / `unclear` | any entry but `hidden` `review` → `hidden` `review`; *gone*: nothing | withdraws by `review` when it empties `data`; restores a `judge` / `review` row when every entry left is kept | batch row → AI row | e2e `ai review: not_ad hides the entry (review), the last served one withdraws the row…`, `ai review: not_ad on a judge-withdrawn row removes the entry and keeps it withdrawn…`; restore by a `not_ad`: untested |
| `ai regate` (`ai/pipeline/regate.go` `place`) | `data` ↔ `hidden` `confidence` / `short` by the current rules (a pinned entry skips confidence); `review` never moves, `unconfirmed` only when pinned (unreachable: a keep already took it out); a hidden entry overlapping a served one stays; `source` kept | none (an emptied row is not withdrawn, a withdrawn one not restored); status untouched | `video_calculateds` → AI row | `regate_test.go` `TestPlace*` (7), `TestRegateRowServesAShortEntryWithTheVotesRatingWhenTheThresholdDrops`, `TestRegateCountsAFailedRow`; e2e `ai regate:…`, `ai second: … ai regate with a lower threshold leaves an undecided unconfirmed entry hidden…`; `source: chapter` entries: untested |
| `ai regate --backfill` | an empty `hidden` gets the run's `confidence` / `short` segments that overlap nothing in `data`; never `unconfirmed` (the second opinion is not re-read; an unconfirmed entry is either still in `hidden`, which is then not empty, or was kept into `data`, where the run's segment overlaps it) | none | as regate | `TestRegateRowBackfill*` (4); e2e `ai regate: … --backfill fills an emptied hidden from the run` |
| `ai judge` (`ai/judge/`) | none | withdraws by `judge` (LLM `withdraw`, `AI_JUDGE_AUTO_WITHDRAW`); `published` → `withdrawn`; `judged_at` / `judge_counters`; `A` items | AI row → batch row (`ai-judge`) | `judge_test.go` (22), `review_test.go` `TestAddReviewItems*` (3), `signals_test.go`, `rules_test.go`; e2e `ai judge:` (9), `ai full path:…` |
| `aiRepository.withdraw` (admin link; `review` via applyVerdict) | none | withdraws by `admin` / `review`; `published` → `withdrawn` | AI row | e2e `ai-first: the admin withdraw link unpublishes the AI row…` |
| `sendToReview` (admin link) | none | an `M` item on any entry, any row state | AI row → batch row (`ai-admin`) | e2e `ai-first: the admin send-to-review link…`, `ai-first: the owner's merge…` |
| `import-below-threshold.js` | none | `B` items on `hidden` `confidence` (and `short` below the threshold), never `review` / `unconfirmed`; `S` items on served entries not set by review | no AI row lock (one insert transaction) | e2e `import-below-threshold:…`, `import-below-threshold --served:…` |
| `adopt-review-items.js` | as applyVerdict | sheet item → ai item, then as applyVerdict | batch row → AI row | e2e `adopt-review-items:` (2) |
| `import-verdict-bounds.js` | as applyVerdict keep | as applyVerdict keep | batch rows → AI row | `review-export.test.js` `import-verdict-bounds:…` (sheet items; the ai-item path: untested, one-off) |
| vote handlers (`POST /vote`, vote delete) | the `rating` of the `data` entry at the vote's bounds, in any row state; nothing moves | none | `video_calculateds` → AI row | e2e `ai-first: votes on AI entries rate the AI row…`, `ai-first: one interval, one vote…` |
| `calculate --recompute-ratings` | `data` ratings | none | AI row | e2e `ai-first: --recompute-ratings rewrites the ratings of AI rows…` |

## Transitions

- Only publish creates `source: chapter` and `hidden` `unconfirmed`; nothing re-runs either on an existing row (`ai-chapters-backfill-published-rows.md`, `ai-second-opinion-old-rows.md`). An unconfirmed entry kept on review is served at its AI bounds without the chapter check.
- `hidden` `review` leaves only by a keep; `hidden` `unconfirmed` only by a verdict (keep → `data` / `short`, `not_ad` → `review`), never by regate or `--backfill`. A keep on a `D` item serves it, a `not_ad` hides it as `review`, as on any ai item.
- Absorb takes only `data` entries; `hidden` entries inside the merged bounds stay (spec `ai-verdict-application`). A keep on such a covered hidden entry is refused (400), while a keep on an absorbed (gone) one is a no-op: the one transition two paths treat differently (finding 1). The chapter check can make the same shape at publish: it checks chapter bounds against served entries only.
- An emptied `data` withdraws only through a `not_ad` / `unclear` on a served entry; a short keep or a regate leaves a published row serving nothing (funnel stage 9, like "nothing found").
- Restore: only applyVerdict, only `judge` / `review` rows, once every `data` entry has a keep after `withdrawn_at`, whichever verdict completes that (a keep, or a `not_ad` hiding the last undecided entry). `admin` rows: never.

## Review items: producers and dedupe

| Code | Producer, sheet, priority | On | Dedupe |
|---|---|---|---|
| `A` | judge, `ai-judge-<date>`, urgent | `data` entries of a `withdraw` / `review` / `judge_invalid` | no open ai item at the entry's bounds (any category), read under the AI row lock |
| `M` | admin link, `ai-admin-<date>`, urgent | any entry, any row state | `openAiItems` at the bounds, under the AI row lock (409) |
| `B` | `import-below-threshold.js`, `ai-below-threshold-<date>`, optional | `hidden` `confidence` (+ `short`) | `hasItemAt`: any item, decided or not, within ± 0.05 s of the item's own bounds, same category, or an old sheet item holding it; no AI row lock |
| `S` | `import-below-threshold.js --served`, `ai-served-<date>`, urgent | one served entry per video, not `source: review` | as `B` |
| `D` | second opinion at publish, `ai-second-<date>`, important | `hidden` `unconfirmed` | none needed: a new row (a re-detect is refused) |
| `T` | chapter check at publish, `ai-chapter-<date>`, important | served entries with a one-edge ad chapter | none needed; disjoint from `D` (served vs hidden) |

One entry gets at most one open item from `A` / `M` / `D` / `T`: the first two read the open items under the AI row lock, the last two write a fresh row. Two open items need `B` / `S` racing an `A` / `M` on the same entry (a manual script without the lock; accepted). `B` can re-send an entry an assessor already moved (finding 2). An item whose entry was absorbed stays open, and its verdict changes nothing (by design).

## What the judge sees

Due: not withdrawn, non-empty `data`, judged before or published ≥ 24 h ago. It reads `data` only: a row whose entries are all hidden (every one `unconfirmed`, say) is never judged, and its human markups reach no one but the dashboard's misses pair. A human markup over a hidden entry counts as conflicting (the prompt calls "markups that only add ads" `ok`). `(bounds by review)` marks `source: review`; `source: chapter` is unmarked (`ai-chapter-edge-tuning.md`). The entries come from the due query, outside the AI row lock; `record` re-checks only a withdraw and a verdict since the tick's start, so a manual `ai regate` in between can give items on entries that just moved to `hidden` (harmless: ai items act on hidden entries).

## Lock order

Edges: queue row → `video_calculateds` → AI row → batch row (publish with `D` / `T`); `video_calculateds` → AI row (votes, regate); AI row → batch row (judge, `sendToReview`); batch row → AI row (decide, adopt, bounds import); AI row alone (recompute, withdraw). The two directions between the batch row and the AI row never meet on one batch: the producers (`ai/review` `Batch`, `openPart`) lock only a part nobody holds and nobody has a verdict in, and decide reaches the AI row only for a batch the reviewer holds or has finished; a decide refused with 409 holds the batch row but never asks for the AI row. Adopt and the bounds import lock batches with verdicts (or the old below-threshold sheet, which no producer writes). Acyclic, by that invariant rather than by one global order.

## Findings

| # | Severity | Where | Finding | Became |
|---|---|---|---|---|
| 1 | low–medium | `prv/repository/ai.js:101`, `:118`; `ai/pipeline/chapters.go:101` | a keep on a hidden entry that a served one covers (left by a merge, or by chapter bounds at publish) is 400 `bounds_overlap`; the assessor can only save `not_ad`; checked with mocked models | `ai-verdict-keep-on-covered-hidden-entry.md` (auto) |
| 2 | low | `scripts/import-below-threshold.js:86`, `prv/repository/review.js:646` | `hasItemAt` matches the item's own bounds, so a `--min-seconds` run below the threshold re-sends a short entry whose bounds an assessor set | `ai-below-threshold-import-resends-reviewed-entries.md` (auto) |
| 3 | low | `grafana/dashboards/ai-pipeline.json:5131`, `:5198`, `:2756` | the misses pair counts rows the second model vetoed; its "у асессоров" ignores `D` items; outcome 2 of "Результат разметки" omits `unconfirmed` | `ai-prod-misses-growing.md` extended |
| 4 | low | `ai/judge/llm.go:211` | chapter-bounded entries are not marked for the judge | already in `ai-chapter-edge-tuning.md` |
| 5 | docs | `prv/repository/ai.js:140` | a `not_ad` restores a withdrawn row when every entry left is kept; CLAUDE.md said only keeps restore | CLAUDE.md fixed |
| 6 | info | `ai/judge/judge.go:141`, `:283` | entries read outside the AI row lock; a regate in between is not detected | accepted (harmless) |
| 7 | info | `scripts/import-below-threshold.js:99`, `:128` | `B` / `S` without the AI row lock can race an `A` / `M` item | accepted (manual script) |
| 8 | info | `ai/pipeline/regate.go:152` | the "unconfirmed unless pinned" branch is unreachable | accepted (harmless guard) |
| 9 | info | `prv/repository/review.js:605`, `ai/judge/signals.go:61` | code comments name the old `reviewBatch` and omit `source: chapter` | left for the next change in those files |

## Docs brought in line

- CLAUDE.md: the source-of-truth sentence on top of AI-first segments; restore by any verdict that completes the keeps; `source` values on served entries; the conflicting-markup signal reads served entries only; `ai/review` has three Go callers (Key Directories, `ReviewItem`); the below-threshold importer never takes `unconfirmed`; `S` items in `ReviewItem`; `AiVideoCalculated` writers include `--recompute-ratings`; the admin link's placement names `ai/review` `Batch`.
- `docs/ai-first-overview/{ru,en}.html` (updated 2026-11-04): the second opinion and the chapter check were already described (since 2026-11-01 / 11-02); fixed the chapter check's state (on since 2026-11-02), AI-first on since 2026-10-28, the `ai-admin` (`M`) and `ai-served` (`S`) batches, the restore wording. The claude.ai artifacts are not republished in this change.
- Specs: CLAUDE.md is the source of truth for the flow; no specs written.

## Backlog

- New: `ai-verdict-keep-on-covered-hidden-entry.md`, `ai-below-threshold-import-resends-reviewed-entries.md`.
- Edited: `ai-prod-misses-growing.md` (what the pair counts), `ai-second-opinion-rules.md` (the backfill bullet dropped: `--backfill` cannot lose an unconfirmed entry, see Writers).
- Deleted: `ai-flow-audit.md` (this record).
